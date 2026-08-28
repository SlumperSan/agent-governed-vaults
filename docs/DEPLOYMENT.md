# Deployment Runbook

Sprint 9. Covers testnet bring-up (Base Sepolia), the mandatory wiring order, post-deploy
verification, and canary monitoring. Contracts are immutable — there is no upgrade path, so
**getting the constructor args and wiring right is the whole game** (a bad `maxStaleness` or an
unwired registry cannot be fixed after the fact).

> **Testnet fast path:** [TESTNET-CHECKLIST.md](TESTNET-CHECKLIST.md) packages §§1–4 into one
> deploy command (`script/DeployTestnet.s.sol`, config-driven, includes the oracle stack and
> execution adapter) plus one lifecycle smoke-test command (`scripts/smoke-test.mjs`).
>
> **After the contracts are live:** [RUNTIME.md](RUNTIME.md) is the operator runbook for the three
> off-chain processes (indexer → API → web) that turn the deployed addresses into a live product.

> ✅ **Unblocked (Sprint 7).** `VaultFactory` was 27,241 bytes of runtime code against the
> EIP-170 24,576-byte cap, so §1 reverted on-chain and nothing in this runbook could be executed
> ([issue #10](https://github.com/SlumperSan/agent-governed-vaults/issues/10)). VaultCore's
> creation code is larger than the runtime cap all by itself, so it now lives in `VaultDeployer`
> — deployed first, then pinned immutably by the factory. The factory is 2,718 B and
> `forge build --sizes` passes. **§1 gained a sixth singleton**; the wiring order is otherwise
> unchanged.

## 0. Preconditions

- Foundry v1.7.1 (`foundryup -v v1.7.1`).
- A funded deployer key on the target chain. **Never commit it.** Use an env var or a hardware
  wallet via `--ledger`. This repo's scripts read `--account`/`--private-key` from the CLI, never
  from a file.
- The canonical USDC address for the chain (Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`).
- Per-asset oracle **source** addresses (≥3 independent, mechanism-diverse — SF-1) for every
  basket asset a vault will list. On mainnet that means **three mechanism classes**, not three
  addresses — see §2.
- For a mainnet oracle stack, also: the Chainlink feed proxies, the Uniswap V3 pools you will
  TWAP (**and their current `observationCardinality`** — see §2), and the Pyth contract plus
  price ids. [`contracts/config/base-mainnet.json`](../contracts/config/base-mainnet.json)
  drafts all of these for Base. It is marked **UNVERIFIED-ON-CHAIN**: run the `verification`
  checklist inside it against a Base RPC before using any address from it.

## 1. Deploy the singletons

The six protocol singletons + their one-shot wiring deploy in one transaction via
[`contracts/script/Deploy.s.sol`](../contracts/script/Deploy.s.sol):

```bash
cd contracts
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_SEPOLIA_RPC" \
  --account deployer \
  --broadcast --verify
```

This deploys `OperatorRegistry`, `SubVaultRegistry`, `FeeEngine`, `Governance`, `VaultDeployer`,
`VaultFactory` and performs the **irreversible** wiring:
`registry.wire(factory, feeEngine)` → `subReg.wire(factory)` → `gov.wireSubVaultRegistry(subReg)`.
`test/Deploy.t.sol` asserts each wire locks; re-running any wire reverts `AlreadyWired`.

Ordering note (#10): `VaultDeployer` **must** be deployed before `VaultFactory`, which pins it
immutably in its constructor. It takes no constructor arguments and needs no wiring — it holds
no authority (see [audit/walkthroughs/VaultDeployer.md](audit/walkthroughs/VaultDeployer.md)).

Record the six addresses printed by the script.

## 2. Deploy per-vault infrastructure (not singletons)

Oracles and execution adapters are **per-vault choices**, not protocol singletons (C-2/SF-1):

1. **The oracle stack — three mechanism classes, quorum 2-of-3.** Deploy the source adapters
   first, then the aggregator over them.

   `OracleAggregator`'s constructor counts *addresses*; SF-1's listing criterion counts
   *mechanisms*. Three `ChainlinkSourceAdapter`s over three Chainlink feeds satisfy the former
   and defeat the latter — a single upstream wearing three hats. That is exactly the
   `testnetCompromise` recorded in
   [`base-sepolia.json`](../contracts/config/base-sepolia.json), acceptable only because Base
   Sepolia has one feed per pair and no real capital. **A mainnet stack is:**

   | Class | Adapter | Fails when | `updatedAt` |
   | --- | --- | --- | --- |
   | push | `ChainlinkSourceAdapter` | the aggregator pauses or hits a circuit limit | feed's `updatedAt` |
   | spot TWAP | `UniswapV3TwapSource` | the pool goes quiet or thin | `block.timestamp` (see below) |
   | pull | `PythSource` | no keeper pays to post an update | Pyth `publishTime` |

   with **quorum 2** — the strict-majority floor for a 3-source set, and the only value that
   both satisfies the constructor and leaves one source of failure headroom (quorum 3 lets any
   single dark source freeze the asset). Order per asset:

   ```solidity
   // a. push
   new ChainlinkSourceAdapter(IAggregatorV3(feedProxy));
   // b. spot TWAP — poolB is address(0) when poolA already quotes USDC
   new UniswapV3TwapSource(asset, usdc, poolA, poolB, 1800, 900, 3600);
   // c. pull
   new PythSource(IPyth(pythContract), priceId, 100 /* max 1% confidence band */);
   // d. the aggregator over all three, quorum 2
   new OracleAggregator(assets, sources, maxStaleness, quorum);
   ```

   Three things will bite, in decreasing order of how quietly:

   - **`maxStaleness` is no longer a pure volatility knob.** The old advice here — "pick it
     tight (minutes)" — is correct for a push-only stack and wrong the moment a pull oracle is
     in the set. Pyth's on-chain price only advances when a keeper *pays* to post, so a
     60-second bound drops that leg on most reads and silently demotes 2-of-3 into 2-of-2 with
     no headroom. Choose it against the **observed on-chain publish cadence** of the pinned
     price ids (base-mainnet.json pins 1 hour), or fund a keeper at a known cadence. It still
     bounds the EE-5 latency-arb window, so do not simply max it out — this is now a real
     tradeoff rather than "as tight as you can stand".
   - **Grow the V3 pools' `observationCardinality` before deploying.** A pool writes at most
     one observation per block, only on a swap; covering a 1800-second window on 2-second
     blocks needs ~900 slots. `increaseObservationCardinalityNext` is permissionless but paid
     per slot. `UniswapV3TwapSource`'s constructor **rejects a pool that cannot already serve
     its window** — that failure is the feature: without it the source would return a
     one-block-manipulable spot price wearing a TWAP's name, permanently fresh.
   - **`UniswapV3TwapSource` pins USDC to $1.00** rather than measuring it. A sustained depeg
     mis-prices that leg by exactly the depeg; the cross-class median is the only mitigation.
     Monitor USDC/USD off-chain (the reference feeds are listed in base-mainnet.json).

   The three classes are integration-tested together in
   `contracts/test/MixedOracleSources.t.sol`: mixed classes reach quorum and median correctly,
   any one class going dark leaves the breaker un-tripped, and every *pair* going dark trips it
   (K-4, deliberately — the freeze includes exits and there is no hatch).

2. **AggregationRouterAdapter**: `new AggregationRouterAdapter(router, allowedSelectors[])` pinned
   to the chain's 0x/1inch router with only the swap selectors allow-listed (EX-1..3).

## 3. Create a vault

```solidity
factory.createVault(VaultFactory.VaultParams({
  usdc: USDC, basketAssets: [...], oracle: aggregator,
  capacityCapUsdc: ..., minDepositUsdc: ..., exitFeeMaxBps: <=100,
  exitFeeDecayPeriod: ..., allowedAdapters: [adapter]
}));
```

Then the creator registers governance config in a second tx:
`governance.registerVault(vault, GovConfig{...})` (quorum ≥ 25% floor; a child's quorum must be
≥ its parent's — SV-6). Until this second tx lands, no proposals exist and exits settle Mode I.

Child vaults use `createChildVault(params, parent)` — basket must be a subset of the parent's
(same USDC), depth ≤ 3, stacked exit-fee ≤ 2.5%.

> **Sub-vaults are DISABLED at launch (Critical C-1 remediation, "root vaults only").** The former
> manual warning here is now an enforced contract invariant: `VaultFactory` is deployed with
> `allowSubVaults = false`, so `createChildVault` reverts `SubVaultsDisabled` and every deployed
> vault is wired `subVaultRegistry = address(0)` — intrinsically root-only. This closes C-1
> ([#33](https://github.com/SlumperSan/agent-governed-vaults/issues/33)) and the sub-vault-only
> Highs (H-5/H-6/H-7/H-9) as a class. **Why disabled rather than patched:** a child funded only by
> its parent has an empty electorate (the parent is excluded by GA-1), and there is no
> purely-internal fix — the correct mechanism (parent casts the child's vote) is a post-launch,
> post-audit feature. To enable sub-vaults you must deploy a factory with `allowSubVaults = true`,
> which is only appropriate once that mechanism has shipped and been audited. See
> [LAUNCH-READINESS.md](LAUNCH-READINESS.md) §2 and [INCIDENTS.md](INCIDENTS.md) §8. The protocol is
> **NO-GO for mainnet** until the full remediation + external audit completes, in any case.
>
> **This is not a ban on testnet sub-vault drills** — the Base Sepolia drills already run
> ([SOAK-REPORT.md](SOAK-REPORT.md) drill 2) stand as evidence, and re-running them against the
> corrected contracts is step 3 of LAUNCH-READINESS §6's path to GO. Throwaway funds on a testnet
> are exactly where this should be exercised. The constraint is on mainnet and on any deployment
> holding members' money.

## 4. Post-deploy verification (before any real capital)

Run each check against the live addresses:

- [ ] `registry.factory()`, `registry.feeEngine()`, `subReg.factory()`, `gov.subVaultRegistry()`
      all resolve; re-wiring reverts.
- [ ] `factory.createVault` from a fresh EOA attests it: `registry.operatorOf(vault) != 0`.
- [ ] A test deposit → 4h window → `activate` mints shares; `navWad()` excludes the pending amount.
- [ ] `oracle.priceWad(asset)` returns a sane median; disabling one source keeps quorum;
      disabling to below quorum reverts `StaleOracle` (breaker works).
- [ ] Each source class **individually** returns a sane price and a plausible `updatedAt`:
      `chainlinkSource.latestPrice()`, `twapSource.latestPrice()`, `pythSource.latestPrice()`.
      All three should agree within single-digit bps in a calm market — a large gap means a
      wrong pool, feed or price id, not a market inefficiency.
- [ ] No source returns `(0, 0)` on a healthy chain. A permanently-silent source is invisible
      inside a 2-of-3 quorum until the day one of the other two fails. For the TWAP source,
      `computePriceWad()` reverts with the specific reason where `latestPrice()` merely
      withholds — use it to diagnose.
- [ ] A full governance dry-run on testnet: propose → commit → reveal → finalize → execute a
      no-op rebalance; confirm a Mode-F exit during reveal settles at post-execution NAV.
- [ ] Exit path: instant Mode-I exit pays pro-rata; exit fee accrues to remainers, never the operator.

## 5. Indexer + API

- Point `packages/indexer/src/chain.mjs` at the RPC and the deployed factory/registry addresses;
  run the poller from block = deploy block.
- Deploy `apps/api` behind the x402 facilitator for the chain (Coinbase x402 facilitator on Base).
  Set the price spec (asset = USDC, payTo = your treasury, network).

## 6. Canary monitoring (post-launch)

Watch continuously; page on any breach. Every row below is implemented in `packages/canary` and runs
as a service — see **[CANARY.md](CANARY.md)** for thresholds, tuning, and the response to each:

```bash
RPC_URL=… OPERATOR_REGISTRY_ADDRESS=… STATE_PATH=./data/indexer-state.json npm run start:canary
```

It is silent while healthy, emits one line per signal transition, and is read-only against the chain
(no key, never sends). `docker compose up` starts it alongside the indexer and API.

| Signal | Alert condition |
| --- | --- |
| Oracle freshness | any basket asset within 1 breaker-trip of `StaleOracle` |
| NAV vs. token balances | `navWad` diverges from independently-computed holdings > 0.5% |
| Share conservation | `Σ sharesOf != totalShares` (indexer vs. chain read) |
| Exit liveness | any `requestExit` reverting for a non-gate reason (H-1 regression sentinel) |
| Fee routing | any USDC leaving a vault to an operator address outside the FeeEngine claim flow |
| Module-call failures | `ModuleCallFailed` and `SliceEscrowed` events (a creator-chosen module or a basket token misbehaving) |

## 7. Mainnet gate

Do **not** deploy to mainnet before: (a) an external audit consuming
[AUDIT-HANDOFF.md](AUDIT-HANDOFF.md), (b) audit findings remediated + re-reviewed, (c) a
staged-value guardrail period on testnet, (d) `capacityCapUsdc` set conservatively for the
initial vaults.
