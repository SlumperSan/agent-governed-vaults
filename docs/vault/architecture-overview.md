# Architecture Overview

**Definition.** The map of the agent-governed-vaults system: permissionless USDC index vaults
in which members pool capital and ratify every rebalance by on-chain commit-reveal vote — proposal
rights follow stake, not operatorship, and nothing rebalances until a proposal passes — and pay
for off-chain analytics via x402 — every subsystem and how the boxes connect.

**Why it matters.** This is the entry point for the ARCHITECTURE cluster. Read it first, then
drill into the atomic notes it links. Source of truth: `docs/ARCHITECTURE.md` (Sprint 1 artifact
1.1) and `docs/THREAT-MODEL.md`.

## The shape of the system

```
   VaultFactory → VaultDeployer          permissionless deploy; deployer holds NO authority (PX-4)
        │ creates
   Governance ⇄ VaultCore ⇄ ChainlinkOracle
   commit-reveal   shares/NAV/deposits    one Chainlink feed per asset, fail-closed
        │          redemptions/capacity
        ▼               │        │
   SubVaultRegistry  IExecutionAdapter  OperatorRegistry
   (DORMANT-AT-LAUNCH)  venue-agnostic   (member,operator) HWM, leaderboard
```

Each module is its own contract; **interfaces cross module boundaries, storage never does**.
[[vaultcore]] holds immutable references to every peer, set at construction. Sprint 1 made
VaultCore concrete; the other boxes were interfaces-with-stubs that filled in across Sprints 2–5.

## Naming convention — TWO `C-n` namespaces (do not conflate)

The repo overloads `C-n`. Always qualify which:

- **commitment C-n** — architecture design commitments from `docs/ARCHITECTURE.md`:
  commitment C-1 = *not ERC-4626* ([[nav-and-shares]]), commitment C-2 = *chain/venue-agnostic*,
  commitment C-3 = *OperatorRegistry immutable reference* ([[fees-and-carry]]), commitment C-4 =
  *two-mode settlement* ([[two-mode-exits]]).
- **audit C-n** — critical findings from the AI pre-audit: audit C-1 = *empty electorate*
  ([[c1-empty-electorate]], the reason [[sub-vaults]] are disabled), … audit C-6 = *oracle
  Byzantine bound* ([[c6-oracle-byzantine]], the reason for the [[chainlink-direct-pivot]]).

`K-n` is a third, separate series: brief-contradictions that were resolved or **ACCEPTED**
(e.g. K-2 near-immutability, K-4 no-escape-breaker). Do not read K-n as a critical.

## Cross-cutting invariants

- **Only `block.timestamp`** as a clock; no `block.number` arithmetic (commitment C-2).
- No hardcoded token/router/oracle addresses — all injected at construction or via timelocked
  config. USDC referenced as `IERC20 immutable`, 6 decimals read once at construction; internal
  math is WAD (1e18). See [[nav-and-shares]].
- **No upgrades.** No proxies, no delegatecall, no upgradeable contracts. Iteration happens by
  deploying new versions through the factory; migration is voluntary per vault. See
  [[delegatecall-split-rejected]].
- **Oracle staleness freezes everything including exits** (K-4, **ACCEPTED**) — see
  [[oracle-layer]] and [[two-mode-exits]].
- **x402 never appears in the contract layer** — see [[x402-metering]].

## The ARCHITECTURE cluster

- [[nav-and-shares]] — share/NAV accounting, deposit, observation window, not-4626
- [[governance-commit-reveal]] — proposals, commit-reveal, quorum, delegation, timelock
- [[two-mode-exits]] — instant vs forward-priced redemption, in-kind payout, exit fee
- [[sub-vaults]] — parent/child mandate (DORMANT-AT-LAUNCH)
- [[oracle-layer]] — one Chainlink feed per asset, the fail-closed breaker, and the retired median
- [[fees-and-carry]] — 10% perf fee, cross-vault HWM carryforward, operator registry
- [[x402-metering]] — off-chain metered read API, zero contract coupling
- [[off-chain-stack]] — indexer, agent SDK, API, canary, web

## Links

- Contracts: [[vaultcore]] · [[governance]] · [[oracleaggregator]] · [[chainlinkoracle]] ·
  [[vaultfactory]] · [[vaultdeployer]] · [[subvaultregistry]] · [[feeengine]] ·
  [[operatorregistry]] · [[execution-adapters]] · [[oracle-sources]]
- Security: [[security-index]] · [[threat-model-commitments]] · [[launch-readiness-gates]]
- Decisions: [[root-vaults-only]] · [[chainlink-direct-pivot]] · [[current-state]]
