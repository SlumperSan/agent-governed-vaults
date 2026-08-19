# Deployment Runbook

Sprint 9. Covers testnet bring-up (Base Sepolia), the mandatory wiring order, post-deploy
verification, and canary monitoring. Contracts are immutable — there is no upgrade path, so
**getting the constructor args and wiring right is the whole game** (a bad `maxStaleness` or an
unwired registry cannot be fixed after the fact).

> **Testnet fast path:** [TESTNET-CHECKLIST.md](TESTNET-CHECKLIST.md) packages §§1–4 into one
> deploy command (`script/DeployTestnet.s.sol`, config-driven, includes the oracle stack and
> execution adapter) plus one lifecycle smoke-test command (`scripts/smoke-test.mjs`).

## 0. Preconditions

- Foundry v1.7.1 (`foundryup -v v1.7.1`).
- A funded deployer key on the target chain. **Never commit it.** Use an env var or a hardware
  wallet via `--ledger`. This repo's scripts read `--account`/`--private-key` from the CLI, never
  from a file.
- The canonical USDC address for the chain (Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`).
- Per-asset oracle **source** addresses (≥3 independent, mechanism-diverse — SF-1) for every
  basket asset a vault will list.

## 1. Deploy the singletons

The five protocol singletons + their one-shot wiring deploy in one transaction via
[`contracts/script/Deploy.s.sol`](../contracts/script/Deploy.s.sol):

```bash
cd contracts
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_SEPOLIA_RPC" \
  --account deployer \
  --broadcast --verify
```

This deploys `OperatorRegistry`, `SubVaultRegistry`, `FeeEngine`, `Governance`, `VaultFactory`
and performs the **irreversible** wiring:
`registry.wire(factory, feeEngine)` → `subReg.wire(factory)` → `gov.wireSubVaultRegistry(subReg)`.
`test/Deploy.t.sol` asserts each wire locks; re-running any wire reverts `AlreadyWired`.

Record the five addresses printed by the script.

## 2. Deploy per-vault infrastructure (not singletons)

Oracles and execution adapters are **per-vault choices**, not protocol singletons (C-2/SF-1):

1. **OracleAggregator** per source-set: `new OracleAggregator(assets, sources[][], maxStaleness[], quorum[])`.
   Constructor now enforces (post-S6): `≥3` sources, `quorum > m/2` (strict majority),
   `0 < maxStaleness ≤ 1 day`. Pick `maxStaleness` tight (minutes) for volatile baskets — it
   bounds the EE-5 latency-arb window.
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

## 4. Post-deploy verification (before any real capital)

Run each check against the live addresses:

- [ ] `registry.factory()`, `registry.feeEngine()`, `subReg.factory()`, `gov.subVaultRegistry()`
      all resolve; re-wiring reverts.
- [ ] `factory.createVault` from a fresh EOA attests it: `registry.operatorOf(vault) != 0`.
- [ ] A test deposit → 4h window → `activate` mints shares; `navWad()` excludes the pending amount.
- [ ] `oracle.priceWad(asset)` returns a sane median; disabling one source keeps quorum;
      disabling to below quorum reverts `StaleOracle` (breaker works).
- [ ] A full governance dry-run on testnet: propose → commit → reveal → finalize → execute a
      no-op rebalance; confirm a Mode-F exit during reveal settles at post-execution NAV.
- [ ] Exit path: instant Mode-I exit pays pro-rata; exit fee accrues to remainers, never the operator.

## 5. Indexer + API

- Point `packages/indexer/src/chain.mjs` at the RPC and the deployed factory/registry addresses;
  run the poller from block = deploy block.
- Deploy `apps/api` behind the x402 facilitator for the chain (Coinbase x402 facilitator on Base).
  Set the price spec (asset = USDC, payTo = your treasury, network).

## 6. Canary monitoring (post-launch)

Watch continuously; page on any breach:

| Signal | Alert condition |
| --- | --- |
| Oracle freshness | any basket asset within 1 breaker-trip of `StaleOracle` |
| NAV vs. token balances | `navWad` diverges from independently-computed holdings > 0.5% |
| Share conservation | `Σ sharesOf != totalShares` (indexer vs. chain read) |
| Exit liveness | any `requestExit` reverting for a non-gate reason (H-1 regression sentinel) |
| Fee routing | any USDC leaving a vault to an operator address outside the FeeEngine claim flow |
| Module-call failures | `ModuleCallFailed` events (a creator-chosen module misbehaving) |

## 7. Mainnet gate

Do **not** deploy to mainnet before: (a) an external audit consuming
[AUDIT-HANDOFF.md](AUDIT-HANDOFF.md), (b) audit findings remediated + re-reviewed, (c) a
staged-value guardrail period on testnet, (d) `capacityCapUsdc` set conservatively for the
initial vaults.
