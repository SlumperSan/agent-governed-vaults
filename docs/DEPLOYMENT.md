# Deployment Runbook

Sprint 9. Covers testnet bring-up (Base Sepolia) and the mandatory wiring order, post-deploy
verification, and canary monitoring, written for the Arc (chain 5042) mainnet deploy that landed
2026-09-24 — see [`contracts/config/deployments/arc-mainnet.json`](../contracts/config/deployments/arc-mainnet.json)
for what actually shipped. Contracts are immutable — there is no upgrade path, so
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
> ([issue #10](https://github.com/SlumperSan/agent-governed-vaults/issues/10)). Any contract that
> writes `new VaultCore(...)` embeds VaultCore's whole creation code in its own runtime, and the sum
> does not fit: 22,391 B of initcode (2026-09-02) leaves 2,185 B under the cap, against a factory
> whose own logic measures 3,572 B. So the creation code lives in `VaultDeployer`
> — deployed first, then pinned immutably by the factory. The factory measures **3,572 B**
> (2026-09-02; recorded here as 2,718 B until then — re-measure, do not copy) and
> `forge build --sizes` passes. **§1 gained a sixth singleton**; the wiring order is otherwise
> unchanged.

## 0. Preconditions

- Foundry v1.7.1 (`foundryup -v v1.7.1`).
- A funded deployer key on the target chain. **Never commit it.** Use an env var or a hardware
  wallet via `--ledger`. This repo's scripts read `--account`/`--private-key` from the CLI, never
  from a file.
- The canonical USDC address for the chain (Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`).
- **Launch oracle (C-6): one genuine Chainlink Data Feed per basket asset**, plus the Base L2
  sequencer uptime feed **on the chains that have one**. These go in `base-mainnet.json`'s
  `chainlinkOracle` block — the Base reference configuration — and are deployed
  as a curated `ChainlinkOracle` in **§1** (the launch model — not the per-vault multi-source
  aggregator, which C-6 retired). Verify every address on-chain (`verify-chainlink-oracle.mjs`)
  before deploying — the oracle is immutable.
- *(Deferred / non-launch only)* the pre-C-6 multi-source stack (Chainlink feed proxies + Uniswap V3
  pools with their `observationCardinality` + Pyth contract & price ids) is drafted in
  [`base-mainnet.json`](../contracts/config/base-mainnet.json) and described in §3; **UNVERIFIED-ON-CHAIN**
  and not for a mainnet launch.

### Arc is deployed (2026-09-24)

**The protocol is deployed on Arc mainnet (chain 5042)**, so the address book for it is
[`contracts/config/deployments/arc-mainnet.json`](../contracts/config/deployments/arc-mainnet.json)
in `contracts/config/deployments/`, alongside Base Sepolia's record. Every address in it was
re-read independently from the chain and cross-checked on two RPC endpoints. Re-verify any address
you act on directly against the chain before transacting; this file is not authorization on its
own.

[`docs/evidence/arc-mainnet-survey.json`](evidence/arc-mainnet-survey.json) records the raw chain
reads — the chain binding (5042), the USDC predeploy at `0x3600…0000` with 6 decimals, and the
Chainlink feeds — that the deploy configuration was built from, and is superseded by
[`contracts/config/arc-mainnet.json`](../contracts/config/arc-mainnet.json) and the deployment
record above where the two disagree. The steps that were followed to get from survey to deploy are
[`docs/evidence/arc-deploy-runbook.md`](evidence/arc-deploy-runbook.md).

**On Arc, USDC is also the native gas asset** — an 18-decimal native view and the 6-decimal ERC-20
view are one pool of funds, not two assets. Nothing in `contracts/` reads a native balance, so vault
accounting is unaffected, but any surface that displays a balance must use the ERC-20 view alone.

## 1. Deploy and verify the curated oracle FIRST (C-6)

**Read this before §2's oracle subsection — it supersedes it for launch.** Audit finding **C-6**
showed the bespoke multi-source median (`OracleAggregator`) is not Byzantine-safe: two adversarial
sources seize an asset's price once one honest source withholds, and a permissionless creator can
supply exactly that (or a `ChainlinkOracle` over a fake feed). The launch resolution is a **curated
Chainlink-direct oracle** — one genuine Chainlink Data Feed per asset — blessed by the factory
allowlist. So the oracle is deployed **before** the factory:

1. **Populate the oracle config** — fill the placeholders in
   [`base-mainnet.json`](../contracts/config/base-mainnet.json)'s `chainlinkOracle` block with
   **real, on-chain-verified** Base feed addresses (do NOT invent them), the Base L2 sequencer
   uptime feed, per-asset heartbeats and sane-price bounds.
2. **Deploy the ChainlinkOracle** via
   [`DeployChainlinkOracle.s.sol`](../contracts/script/DeployChainlinkOracle.s.sol) with the
   `ORACLE_*` env vars from that config. The band values are copied by hand and nothing
   machine-checks that the env matches the JSON (residual register row 14's `BAND-BINDING` gap) —
   compare them yourself before broadcasting. **The band width is an owner decision (SWARM §10),
   not a deployer default:** an aggregator-swap drift of ±2 decimals is caught only while
   `hi/100 < spot < 100·lo`, a window `10,000 / (hi ÷ lo)` wide, so the shipped ratio-1000 bands
   give the *least* coverage the constructor allows (10x: WETH $1,000..$10,000, cbBTC
   $10,000..$100,000) and a tighter band gives more. Row 14 carries the boundaries and the owner
   memo `Owner Decisions 2026-09-01` §1 the options; do not retune without that decision recorded.
3. **Verify it on-chain** (read-only, no key): `node scripts/verify-chainlink-oracle.mjs` — must
   exit 0 (every feed: code, `decimals ≤ 18`, `answer > 0`, fresh within heartbeat; sequencer feed
   present and answering; and the band bounds a 2-decimal drift **at the live price**, which the
   constructor does not check — it accepts a spot inside the band but outside the covered window).
4. **Export `BLESSED_ORACLES`** = the deployed oracle address (comma-separated for several). §2 below
   (deploy the factory) reads it into the factory's oracle allowlist.

> A Base-mainnet `Deploy.s.sol` run **reverts** if `BLESSED_ORACLES` is empty (`test_baseMainnetDeployRefusesEmptyOracleAllowlist`) — an empty allowlist would ship the C-6 gate disabled. Testnet/local may run empty (permissive). The named test pins Base mainnet specifically, so it says nothing about Arc (chain 5042); once a factory is deployed there, `factory.oracleAllowlistEnforced()` and `factory.isAllowedOracle(...)` must be read back on-chain from the actual deployed factory address — no Arc deployments file exists yet to look it up in.

### Arc — the sequencer-uptime-feed exemption is NOT yet granted

**This weakens a security gate, so it is an owner decision and it has not been made.** Chainlink
publishes no L2 Sequencer Uptime Feed for Arc, and would not be expected to: Arc is an L1, not a
rollup, so there is no sequencer whose liveness the feed would report. `ChainlinkOracle`'s
`_requireSequencerUp` returns early on a zero address, so the gate is skipped at price time rather
than reverting — which means deploying on Arc runs with two of the three oracle defences, not three.

`requiresSequencerUptimeFeed` in
[`DeployChainlinkOracle.s.sol`](../contracts/script/DeployChainlinkOracle.s.sol) refuses a chain it
has no sequencer policy for. **Arc is not on its exempt allowlist and must be added deliberately
before any deploy** — that edit is the moment the decision gets made, and it should be recorded here
with a date and the owner's words, the way the previous one was.

**One habit worth keeping from the previous chain.** `verify-chainlink-oracle.mjs` computes
`SEQUENCER_REQUIRED` from the *config's* `chainId` and never from the RPC, while the RPC is resolved
from environment variables — so a stale `BASE_MAINNET_RPC` exported from an earlier session decides
which endpoint a run queries. On an exempt chain the sequencer row then **passes**, so on its own
an exemption would let a wrong-chain verification come back green. What stops it is the chain
binding: the script reads `eth_chainId` from whichever RPC it resolved and refuses the whole run —
before any feed is read — when that id differs from the config's. Clear the RPC environment
variables by hand anyway; the binding governs whether a verdict means anything, not which endpoint
gets queried.

## 2. Deploy the singletons + factory (with the oracle allowlist)

The six protocol singletons + their one-shot wiring deploy in one transaction via
[`contracts/script/Deploy.s.sol`](../contracts/script/Deploy.s.sol). Set `BLESSED_ORACLES` from §1:

```bash
cd contracts
BLESSED_ORACLES="$CHAINLINK_ORACLE_ADDR" \
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

## 3. Execution adapters (per-vault) — and the DEFERRED custom oracle

Execution adapters are per-vault choices. The custom multi-source oracle below is **SUPERSEDED for
launch by §1** (the curated Chainlink-direct oracle) — audit finding **C-6**. Keep the custom
`OracleAggregator` path only for a post-audit release that re-enables permissionless oracle choice
with the `quorum ≥ 2a+1` Byzantine floor; do NOT use it for a mainnet launch (and the factory
allowlist makes it non-selectable there anyway).

> **⚠ These contracts are no longer in `contracts/src/`.** `OracleAggregator.sol`,
> `PythSource.sol`, `UniswapV3TwapSource.sol` and their vendored `FullMath`/`TickMath` were moved
> to **`contracts/test/retired/`**, where they are kept only as the C-4/C-6 exploit evidence. They
> are not part of the deployable set, and the constructor calls below will not resolve against a
> current checkout without moving them back. Read this subsection as the record of a retired
> design, not as a runbook you can execute.

**DEFERRED — the custom multi-source oracle (pre-C-6), do not use for launch:**

1. **The oracle stack — three mechanism classes.** ⚠ **Quorum 2-of-3 is UNSAFE (H-1/C-6):** it lets
   the lower median degenerate to `min()`, and two adversarial sources seize the price. If this path
   is ever revived, it needs ≥5 independent sources and `quorum ≥ 2a+1` — see AI-AUDIT-REPORT.md C-6.
   Deploy the source adapters first, then the aggregator over them.

   `OracleAggregator`'s constructor counts *addresses*; SF-1's listing criterion counts
   *mechanisms*. Three `ChainlinkSourceAdapter`s over three Chainlink feeds satisfy the former
   and defeat the latter — a single upstream wearing three hats. That is exactly the
   `testnetCompromise` recorded in
   [`base-sepolia.json`](../contracts/config/base-sepolia.json), acceptable only because Base
   Sepolia has one feed per pair and no real capital. **A BASE mainnet stack is:** (Base-shaped, and
   not the universal mainnet shape — Arc, an L1, has no sequencer leg at all and its feeds run at
   the 86,400 s `MAX_HEARTBEAT` ceiling)

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

   > ✅ **Resolved 2026-09-03 by redeploy.** The live Base Sepolia adapter is
   > `0x68be942cab962ac8f9064b45489f35fbd6f617d5`, deployed at `sourceCommit 8a0e1155`, and it
   > carries **both** fixes. Checked by ancestry rather than asserted — both of these succeed:
   > `git merge-base --is-ancestor 8a2afc3e 8a0e1155` (#101's mutex) and
   > `git merge-base --is-ancestor 29996eaf 8a0e1155` (#108's scoped refund). Neither the donation
   > DoS nor the cross-order theft is reachable on it. The soak has **not** been re-run yet (gate 3
   > is still STALE and needs the owner's key); when it is, it will run against this fixed shape
   > rather than the old one.
   >
   > **The constraint that forced the redeploy has not gone away.** `VaultCore.isAllowedAdapter`
   > is populated in the constructor and never written again, so vaults are permanently bound to
   > the adapter they were created against. That is why fixing this on Sepolia required a fresh
   > adapter *and* fresh vaults rather than a repoint, and it is why the finding was a deploy gate
   > in the first place. Mainnet must deploy the fixed bytecode; there is no repair after the fact.
   >
   > *What was here before, retained because the consequence list is the record:* the previous
   > adapter `0xf3e08c8b00281750d531a48473d053009038a9b1` (`sourceCommit 5934ef22`) contained no
   > `_lock` / `nonReentrant` at all, and so carried **two** exploits of one root cause — (1) the
   > **donation DoS**, a revert: anyone could `transfer` USDC to that address and the next
   > `executeRebalance` leg through it reverted `Panic(0x11)`; and (2) **#101's cross-order
   > theft**, a LOSS OF FUNDS: with no mutex, a counterparty reached through the route re-entered
   > with a 1-unit order and the nested whole-balance sweep handed it the outer order's in-flight
   > `tokenIn`, which `test/AdapterReentrancy.t.sol::test_nestedSwapCannotSweepTheOuterOrdersInput`
   > proves. Reachability was low (governance chooses `routeData`), but low reachability is a
   > different statement from the consequence list. The smoke vault of that era,
   > `0x4d60e49d451117b9ab8f9fb9be56454ab7f01a0f`, was bound to it and was superseded with it.
   > Both are described in [the walkthrough](audit/walkthroughs/AggregationRouterAdapter.md).

## 4. Create a vault

```solidity
factory.createVault(VaultFactory.VaultParams({
  usdc: USDC, basketAssets: [...], oracle: aggregator,
  capacityCapUsdc: ..., minDepositUsdc: ..., exitFeeMaxBps: <=100,
  exitFeeDecayPeriod: ..., allowedAdapters: [adapter]
}));
```

> **`minDepositUsdc` is a governance-security parameter, not just dust control (H-8).** The
> `<5`-member signer quorum regime counts any address with shares > 0, so a cheap minimum deposit
> lets an attacker buy the regime flip (`minDepositUsdc` to reach 5 members and pass a plurality
> alone) or park dust seats to grief a small vault into ungovernability. There is no safe
> contract-level floor (a fraction-of-stake floor repeats M-6's liveness cliff). **Set
> `minDepositUsdc` to an economically meaningful value relative to `capacityCapUsdc`** so that
> manufacturing ~4 dust members costs a materially non-trivial sum. 1 USDC (the testnet smoke value)
> is NOT acceptable for a real vault; the mainnet reference template uses 100 USDC. See
> AI-AUDIT-REPORT.md H-8 and THREAT-MODEL.md CM-7.

Then the creator registers governance config in a second tx:
`governance.registerVault(vault, GovConfig{...})` (quorum ≥ 25% floor; a child's quorum must be
≥ its parent's — SV-6). Until this second tx lands, no proposals exist and exits settle Mode I.

Child vaults use `createChildVault(params, parent)` — basket must be a subset of the parent's
(same USDC), depth ≤ 3, stacked exit-fee ≤ 2.5%.

> **Sub-vaults are DISABLED at launch (Critical C-1 remediation, "root vaults only").** The former
> manual warning here is now an enforced contract invariant: `Deploy.s.sol` constructs
> `VaultFactory` with `allowSubVaults = false` — a constructor immutable, so it binds that factory
> rather than the protocol. On it `createChildVault` reverts `SubVaultsDisabled` and every vault it
> deploys is wired `subVaultRegistry = address(0)` — intrinsically root-only. This closes C-1
> ([#33](https://github.com/SlumperSan/agent-governed-vaults/issues/33)) and the sub-vault-only
> Highs (H-5/H-6/H-7/H-9) as a class. **Why disabled rather than patched:** a child funded only by
> its parent has an empty electorate (the parent is excluded by GA-1), and there is no
> purely-internal fix — the correct mechanism (parent casts the child's vote) is a post-launch,
> post-audit feature. To enable sub-vaults you must deploy a factory with `allowSubVaults = true`,
> which is only appropriate once that mechanism has shipped and been audited. See
> [LAUNCH-READINESS.md](LAUNCH-READINESS.md) §2 and [INCIDENTS.md](INCIDENTS.md) §8. The protocol is
> **NO-GO for mainnet on the OPERATIONAL gates** (soak + canary, which need a funded testnet key).
> The protocol has never been deployed to any mainnet, so this gate has not yet been exercised
> outside testnet; the security gates are cleared and the external audit is complete on owner
> attestation. Enabling sub-vaults is additionally gated on the post-launch look-through mechanism
> shipping and being audited.
>
> **This is not a ban on testnet sub-vault drills** — the Base Sepolia drills already run
> ([SOAK-REPORT.md](SOAK-REPORT.md) drill 2) stand as evidence, and re-running them against the
> corrected contracts is step 3 of LAUNCH-READINESS §6's path to GO. Throwaway funds on a testnet
> are exactly where this should be exercised. The constraint is on mainnet and on any deployment
> holding members' money. There is no mainnet deployment today and no vault anywhere holds member
> funds, so the constraint is a design requirement to carry into whenever an Arc (chain 5042)
> deployment happens, not a live position to check now. Once a factory is deployed there, confirm
> `VaultFactory.allowSubVaults()` by reading it back on-chain rather than assuming a value carried
> over from a prior deployment.

## 5. Post-deploy verification (before any real capital)

Run each check against the live addresses:

- [ ] `registry.factory()`, `registry.feeEngine()`, `subReg.factory()`, `gov.subVaultRegistry()`
      all resolve; re-wiring reverts.
- [ ] `factory.createVault` from a fresh EOA attests it: `registry.operatorOf(vault) != 0`.
- [ ] A test deposit → 4h window → `activate` mints shares; `navWad()` excludes the pending amount.
- [ ] `oracle.priceWad(asset)` returns a sane price for **every** basket asset, and reverts
      `StaleOracle(asset)` for an asset the oracle does not list (the breaker's own verdict).
- [ ] Re-run `node scripts/verify-chainlink-oracle.mjs` against the **deployed** oracle
      (read-only, no key): every feed carries code, `decimals() <= 18`, `answer > 0`, is fresh
      within its configured heartbeat, and its `description()` is an ASSET/**USD** pair — not
      ASSET/ETH. Base publishes a `CBETH / ETH` feed and no cbETH/USD one; wiring it would read an
      ETH-denominated number as USD, permanently.
- [ ] `oracle.feedOf(asset)` matches the config for each asset: right feed address, right
      heartbeat, and a sane-price band that brackets the current price with room for a real move
      but not for a deprecated min/maxAnswer clamp value.
- [ ] `oracle.sequencerUptimeFeed()` — **on a chain that has one.** On Base it must be the Base L2
      sequencer uptime feed and not `address(0)`; confirm `latestRoundData()` answers `0` (up) and
      that `block.timestamp - startedAt > 3600` (outside the grace period), or `priceWad` will
      revert for every asset. A deploy without it has no sequencer guard at all. On **Arc (chain
      5042)**, an L1 with no L2 Sequencer Uptime Feed published or expected, `address(0)` is the
      configuration this checklist item resolves to — but per §1's Arc section, that exemption is
      an owner decision that has **not yet been made**: `requiresSequencerUptimeFeed` in
      `DeployChainlinkOracle.s.sol` must be widened to admit chain 5042 deliberately before this
      item can be satisfied by confirming the zero rather than by finding a feed.
- [ ] `factory.isAllowedOracle(<oracle>)` is true and `factory.oracleAllowlistEnforced()` is true
      — the C-6 curation gate. An unenforced allowlist on mainnet ships the finding.
- [ ] **Know what has no check:** there is exactly one feed per asset, so there is nothing to
      cross-check the price against. The heartbeat, the band and the sequencer gate are the only
      defences, and a feed deprecation fails that asset closed with no fallback and no rotation
      lever. That is gate 5's named residual, accepted deliberately.
- [ ] A full governance dry-run on testnet: propose → commit → reveal → finalize → execute a
      no-op rebalance; confirm a Mode-F exit during reveal settles at post-execution NAV.
- [ ] Exit path: instant Mode-I exit pays pro-rata; exit fee accrues to remainers, never the operator.

## 6. Indexer + API

- Point `packages/indexer/src/chain.mjs` at the RPC and the deployed factory/registry addresses;
  run the poller from block = deploy block.
- Set `CHAIN_ID` for `apps/api`. It resolves whether that chain meters reads over x402 from
  `contracts/config/<chain>.json`, and the rest of this bullet depends on the answer:
  - **Chains that meter** (Base Sepolia; anything with no `x402` block, which is the default):
    deploy `apps/api` behind the x402 facilitator for the chain (Coinbase x402 facilitator on
    Base). Set the price spec (asset = USDC, payTo = your treasury, network).
  - **Arc mainnet (chain 5042)**: whether this chain's config will declare `x402.enabled: true` is
    an owner decision not yet made — `contracts/config/arc-mainnet.json` does not exist yet (see
    [arc-deploy-runbook.md](evidence/arc-deploy-runbook.md) §5). If it takes the metering branch
    above, one thing is simpler here than it used to be: **the settlement token genuinely is
    Circle USDC.** It is a native predeploy at `0x3600000000000000000000000000000000000000`, read
    on-chain as `decimals() 6`, `symbol() "USDC"`, `name() "USDC"`
    ([arc-mainnet-survey.json](evidence/arc-mainnet-survey.json)). The key named `usdc` and the
    asset it holds now agree — there is no mismatched token hiding behind that key here, and
    nothing to warn about on that front. Set `PRICE_ASSET` to that address. Note that on Arc this
    same address is also the native gas asset, exposed as an 18-decimal native view over the same
    pool of funds as this 6-decimal ERC-20 view — never sum or convert between them.

    **You must still set the EIP-712 domain by hand, and it must be recovered from the token, not
    assumed.** Under `FACILITATOR=standard`, `createStandardHttpFacilitator` takes the domain from
    `FACILITATOR_USDC_NAME` / `FACILITATOR_USDC_VERSION` and defaults them to `USD Coin` / `2`,
    which is Circle USDC on Base — not necessarily this predeploy's domain on chain 5042. Leaving
    Base's defaults in place signs against a domain the token may not have, and every payment
    fails. Before configuring these values, recover `name()`, `version()` and `DOMAIN_SEPARATOR()`
    directly from the token on chain 5042 via `readUsdcDomain` in
    `apps/api/src/facilitator.mjs` — or, if it exposes no `version()` getter, by reproducing
    `DOMAIN_SEPARATOR()` from its preimage the way the previous chain's domain had to be recovered.
    Nobody has resolved this value yet; do not guess it.
    `RATE_LIMIT_PER_SEC`/`RATE_LIMIT_BURST` apply to the free routes only here, as on any metering
    chain: x402 is the limiter on the paid ones.
    **No facilitator is deployed for chain 5042, and `apps/api` is not deployed anywhere** — the
    protocol itself IS deployed on Arc (see `contracts/config/deployments/arc-mainnet.json`), but
    that has no bearing on this bullet, which describes a facilitator/API configuration to
    complete before either of those exists, not a running service.

## 7. Canary monitoring (post-launch)

Watch continuously; page on any breach. Every row below is implemented in `packages/canary` and runs
as a service — see **[CANARY.md](CANARY.md)** for thresholds, tuning, and the response to each:

```bash
RPC_URL=… OPERATOR_REGISTRY_ADDRESS=… STATE_PATH=./data/indexer-state.json npm run start:canary
```

It is silent while healthy, emits one line per signal transition, and is read-only against the chain
(no key, never sends). `docker compose up` starts it alongside the indexer and API.

> **The canary watches the launch oracle on two axes: freshness since #89, and feed IDENTITY since
> #103.** The `oracle-freshness` signal probes the deployed oracle and measures `ChainlinkOracle`
> directly: `priceWad(asset)` is ground truth and a revert *is* the incident, attributed to the
> sequencer, the heartbeat, the sane-price band, an unlisted asset or a dead feed. A detector that
> cannot run is reported `DETECTOR BROKEN` and re-asserted on a backoff rather than going quiet.
> The `feed-identity` signal (G2's on-chain half, [CANARY.md](CANARY.md) §3(g)) compares each
> feed's live `decimals()` against the **cached `scale` the deployed oracle actually multiplies
> by**, read from `feedOf(asset)`, re-runs the constructor's USD-denomination predicate against the
> live `description()`, and reads which `aggregator()` / `phaseId()` is behind the proxy. The two
> **harm** legs (decimals, denomination) compare chain against chain, so they have nothing to pin
> and nothing that can go stale; only the **identity** leg (aggregator, phaseId) keeps a remembered
> value, pinned on first sight into the canary's own state. Note the routing, because it decides
> who sees it: `feed-identity` is the one signal whose ALERTs are not all one severity, so since
> #121 it routes on a predicate (`CONDITIONAL_PAGE` in `packages/canary/src/sinks.mjs`) — it
> **PAGES** when `detail.harm` is `'decimals'` or `'denomination'`, the two latching cases where
> every price is silently wrong, and **LOGS** when `harm` is `null`, the benign aggregator swap
> that self-clears next sweep. That is a stronger check than the
> recurring script below, which tests Chainlink's 8-decimal *convention* rather than the number
> this oracle uses — **the canary now continuously re-runs the two construction-time proofs an
> immutable contract can never re-run itself.**
>
> What the recurring check below still adds, and why it is not redundant: a **git-tracked** pin
> (the canary pins on first sight, so a benign swap during canary downtime is adopted silently on
> restart), and the deprecation **announcement**, which is off-chain by nature and remains a weekly
> human item — up to 7 days of exposure, by choice, per the gap analysis's own build-vs-buy call.

### 7a. Recurring feed check — run this on a cadence, not only before deploying

```bash
node scripts/verify-chainlink-oracle.mjs
```

Read-only and keyless, so it is safe to run against a live deployment as often as you like. Run it
**weekly, and after any Chainlink feed announcement** — with
`--strict`, so an aggregator swap exits non-zero instead of scrolling past as a notice nobody
reads. Two things it catches that nothing on-chain
can:

- **Aggregator-swap drift** (residual register row 14). Chainlink swaps the aggregator behind a
  configured `EACAggregatorProxy` as routine operation, and `ChainlinkOracle` cached
  `scale = 10**(18 - decimals)` once, at construction, from a value that lives on the *aggregator*.
  The script's `decimals() == 8` check is a complete test of that residual **at the sampling
  instant**: if a feed reports 8 when you run it, the cached scale was correct however many swaps
  had happened by then. It says nothing about the interval between runs — a swap that drifts and
  reverts between two weekly runs is invisible — so the exposure window is the run interval, and
  the cadence is the control. Each
  feed's `aggregatorPin` in the config makes the swap itself **visible** — reported as a `DRIFT`
  notice, never a failure, because a swap is legitimate. A `DRIFT` line alongside a passing decimals
  check is the reassuring outcome: it moved, and it re-checked clean. Update the pin and move on.
- **A `FAIL` on decimals is the alarming outcome** and needs the [INCIDENTS.md §1a](INCIDENTS.md)
  response (residual register **row 14**), not a config edit:
  every vault priced by that oracle is now mis-scaled by a power of ten, no on-chain lever can fix
  it (the vault's oracle is `immutable` — row 12), and members should be told to exit. **On a vault with
  no sub-vaults, drift does not change the pre-fee pro-rata slice an exit is sized from** — `_settleExit` sizes the in-kind
  slice pro-rata from `assetBalance`, which is what `test_harmModel_driftDoesNotRobAnExitingMember`
  demonstrates — but the oracle still *values* that slice to set the performance fee, and the fee
  IS withheld from the member's actual tokens: drift costs a bounded, one-directional haircut of up
  to the 10% fee clamp, not nothing. That is the shape the proof
  covers, and it is the launch shape (`Deploy.s.sol` sets `allowSubVaults = false`). **With
  children present it is unproven**: `childValTotalWad` is oracle-derived and enters the *sizing*
  of the cash leg, not only its valuation. Do not tell a member with a sub-vault parent that
  their exit is unaffected.

| Signal | Alert condition |
| --- | --- |
| Oracle health | any basket asset whose `priceWad` reverts `StaleOracle` — aged past its heartbeat, outside its sane-price band, feed dead or unlisted — or the L2 sequencer down / inside its grace period ([CANARY.md §3(a)](CANARY.md)) |
| NAV vs. token balances | `navWad` diverges from independently-computed holdings > 0.5% |
| Share conservation | `Σ sharesOf != totalShares` (indexer vs. chain read) |
| Exit liveness | any `requestExit` reverting for a non-gate reason (H-1 regression sentinel) |
| Fee routing | any USDC leaving a vault to an operator address outside the FeeEngine claim flow |
| Module-call failures | `ModuleCallFailed` and `SliceEscrowed` events (a creator-chosen module or a basket token misbehaving) |
| Governance watch | a proposal entering any phase — commit, reveal, awaiting finalize, timelock, executable, lapsed — with the reveal deadline and earliest `execute` in `detail` ([CANARY.md §3(h)](CANARY.md)) |

## 8. Mainnet gate

Do **not** deploy to mainnet before: (a) an external audit consuming
[AUDIT-HANDOFF.md](AUDIT-HANDOFF.md), (b) audit findings remediated + re-reviewed, (c) a
staged-value guardrail period on testnet, (d) `capacityCapUsdc` set conservatively for the
initial vaults.

**A deployment now exists, and it does not by itself satisfy gates (a)–(d) above.** The protocol is
deployed on Arc (chain 5042) since 2026-09-24 — a live factory and one live vault, see
`contracts/config/deployments/arc-mainnet.json` — and `capacityCapUsdc` was set to 0 (uncapped) by
owner decision, not "conservatively" in the sense (d) above means. A prior mainnet deployment on
the chain this project has since moved away from was fully exited on 2026-09-18 and holds nothing.
Gates (a)–(d) above were not run fresh against this Arc deployment before it shipped — none of them
carry over from the abandoned chain, and gates 3 and 6 in particular have no current evidence on
any chain: the five drills and the canary alongside them ran on Base Sepolia on 2026-08-24/25 and
passed 5/5
([SOAK-REPORT.md](SOAK-REPORT.md)), but against bytecode that has since changed, and they have not
been re-run.

## 9. Source-verifying a LIVE deployment (read this before running `forge verify-contract`)

**`HEAD` is not guaranteed to reproduce a historical deployment's bytecode — only the exact
commit it was built from is.** `contracts/foundry.toml` sets no `bytecode_hash`, so solc's
default `ipfs` metadata mode applies: every compiled contract's runtime bytecode ends with a CBOR
trailer whose IPFS hash is a digest of the compiler's `sources` map, keyed by **source path**.
Moving, renaming, or re-pathing *any* file in a contract's compiled dependency graph — including
one it only imports indirectly, and including a file that has nothing to do with the contract's
own logic — changes that trailer, even though not one opcode changed. Deployed bytecode is fixed
forever; `HEAD` keeps moving. The two drift apart the first time a relevant path changes.

**This already happened once, silently.** The 2026-08-29 retired-oracle prune
(`chore/prune-retired-oracle-stack`) moved five files out of `contracts/src/` into
`contracts/test/retired/` and rewrote `ChainlinkOracle.sol`'s import of one of them.
`ChainlinkOracle.sol` itself did not move and its logic did not change, but its compiled metadata
trailer did — found only because a reviewer went looking after the fact. Measured on 2026-09-01
against what was then the live Base Sepolia deployment
(`ChainlinkOracle` at `0x6371E14C0682882e75E8382caf0216545B1f43C6`, at `sourceCommit 5934ef22`).
**That deployment has since been replaced** — the current record pins `sourceCommit 8a0e1155` with
the oracle at `0x3a8bd8a6599c3fdd0b3a269e0142e6b468ddd935` — so the addresses and commits in the
two bullets below are the worked example, not the current instance. The mechanism they demonstrate
is unchanged and is exactly why the procedure that follows exists:

- Building `ChainlinkOracle` at `protocol/main` and masking its two immutable slots (`usdc`,
  `sequencerUptimeFeed` — the only non-deterministic bytes a fresh build can never match, since
  they are baked in at construction, not compile time) still leaves a **32-byte divergence in the
  trailing CBOR metadata** (the IPFS hash) against the deployed runtime code. Everything else —
  every opcode, all 1,532 bytes of runtime length — is identical.
- Building at the commit that deployment record pinned as **`sourceCommit`** (`5934ef22`)
  reproduces the deployed runtime bytecode **byte-for-byte, including the trailer**. Zero bytes
  differ, not even under masking. The same rule applies to the current record: build at
  `8a0e1155`, read from
  [`config/deployments/base-sepolia.json`](../contracts/config/deployments/base-sepolia.json),
  never at `HEAD`. On the current deployment the divergence has a second cause worth naming,
  because it is the least obvious one: the only `contracts/src/` change between `8a0e1155` and
  `protocol/main` is a **comment-only** edit to `VaultDeployer.sol` (#151), and since the trailer
  hashes source text, that alone moves `VaultDeployer`'s trailer while leaving every opcode and
  its 938 B length untouched. A metadata divergence does not imply a code difference.

So the finding is a **documentation gap, not a code defect**: nothing on-chain is wrong, the
deployed contract behaves exactly as its source says, and it can still be source-verified — the
missing piece was ever writing down that verification must build at the pinned commit, not at
whatever `main` happens to be when you get around to it.

### The procedure

1. **Read `sourceCommit` from the deployment record** for the chain you're verifying against
   (`contracts/config/deployments/<chain>.json`). If the field is missing, stop — there is
   nothing to pin to, and verifying against `HEAD` is a coin flip that happens to work until the
   next file move.
2. **Check out that commit into its own worktree**, so you never disturb whatever branch you're
   actually working on (this is a shared worktree — see `docs/SWARM.md` §8):
   ```bash
   git worktree add ../verify-<chain>-<sourceCommit> <sourceCommit>
   cd ../verify-<chain>-<sourceCommit>/contracts
   forge build --skip test --skip script
   ```
3. **Recover the constructor arguments** the same way the deploy script did — from that SAME
   commit's config file, not today's. For `ChainlinkOracle` on Base Sepolia,
   `script/DeployTestnet.s.sol` builds them from `config/base-sepolia.json`'s `chainlinkOracle`
   block (`assets[].asset` / `.feed` / `.heartbeatSeconds` / `.minPriceWad` / `.maxPriceWad`,
   `usdcPin`, `sequencerUptimeFeed`), in that array order — read that script's `_deployOracle`
   helper at the pinned commit if the shape has since changed. (As of this writing the
   `chainlinkOracle` block's *values* are unchanged since `5934ef22`, and the whole file is
   blob-identical between the currently pinned `8a0e1155` and `protocol/main` at
   `b91cb18f9725` — so today's committed config still reconstructs the right arguments; that was
   checked, not assumed, and may not stay true forever.) Alternatively, skip
   manual reconstruction and pass `--guess-constructor-args` (see `forge verify-contract --help`)
   to have `forge` extract them from the on-chain creation transaction directly.
4. **Verify from the pinned-commit worktree**, not your working tree, so the compiler sees that
   commit's file layout:
   ```bash
   forge verify-contract --chain 84532 <address> \
     src/oracle/ChainlinkOracle.sol:ChainlinkOracle \
     --constructor-args <abi-encoded-args-or---guess-constructor-args> \
     --etherscan-api-key "$ETHERSCAN_API_KEY" --watch
   ```
5. **Remove the scratch worktree** when done (`git worktree remove ../verify-<chain>-<sourceCommit>`).

### What to expect from each verifier

This repo has not run a real verification submission against either explorer as part of this
finding (no API key was available; only the pinned-commit rebuild above was measured). What
follows is documented, standard verifier behavior, not a repo-specific measurement — treat it as
guidance, and expect the pinned-commit build to be the reliable path either way:

- **A pinned-commit build should verify cleanly everywhere**, since the bytecode — trailer
  included — matches exactly what step 2 above proved.
- **Basescan/Etherscan-family explorers** generally require the submitted source to compile to
  bytecode that matches the deployed contract; a metadata-only mismatch (built at `HEAD` instead
  of the pinned commit) is the most common reason a "the source is definitely right" submission
  still comes back unverified. If a `HEAD`-built submission is ever rejected only on the trailer,
  that is this exact issue — rebuild at `sourceCommit` and resubmit.
- **Sourcify** distinguishes a "full match" (bytecode identical including metadata) from a
  "partial match" (identical except metadata) and accepts both as verified, labeling which one you
  got — by protocol design, precisely to handle non-reproducible metadata hashes like this one. A
  `HEAD`-built submission there may succeed as a partial match even without pinning; a
  pinned-commit build should come back a full match. This was not tested against a live endpoint
  for this finding — confirm before relying on it.

### Keeping this reproducible: `node scripts/verify-deployment-reproducibility.mjs` (standalone, not wired into `npm run gate`)

This checks, offline and without touching an RPC,
that every `contracts/config/deployments/*.json`'s `sourceCommit` still resolves in local git
history **and** is still reachable from `origin/protocol/main` — the one part of this procedure
that can rot silently (a rebase or a pruned branch can make a previously-valid `sourceCommit`
unreachable long after the deployment it describes is still live). It does **not** and cannot
detect metadata drift itself — drift is expected any time `contracts/` changes under `ipfs` mode
and is not, on its own, a defect. It is deliberately **not** one of `scripts/gate.mjs`'s 9 CI-mirroring
steps (that file's own header states it must mirror `.github/workflows/ci.yml`, not add to it —
wiring this in would mean editing both, and the check has nothing to do with whether the current
diff is mergeable). Run it by hand before cutting a new deployment record, or whenever
`contracts/src/` moves files around and a live deployment references the old layout.
