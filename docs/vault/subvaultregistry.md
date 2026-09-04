# SubVaultRegistry

The registry of parent/child vault edges: depth cap, exit-fee stacking, and quorum-floor
inheritance. `contracts/src/SubVaultRegistry.sol`. **DORMANT-AT-LAUNCH** — sub-vaults are disabled.

## Why it matters

Sub-vaults let a vault allocate capital into child vaults (vault-of-vaults), with look-through NAV
pricing and stacked fees. This registry is the source of truth for who is whose child, and its
structural rules are what make the composition safe *when enabled*. At launch it is deliberately
inert: the C-1 empty-electorate capture ([[root-vaults-only]]) has no purely-internal fix, so
[[vaultfactory]] ships with `allowSubVaults = false` and wires every vault with `subVaultRegistry =
address(0)`. On such a factory no parent/child edge can be created, so nothing in this contract
runs. The code is **retained, not deleted**, so a future audited factory can enable it.
**This is a per-deployment property, not a universal:** `DeployTestnet.s.sol` passes
`allowSubVaults = true`, and the live Base Sepolia factory reads `allowSubVaults() == true`
(`contracts/config/deployments/base-sepolia.json`), because the SV-7 look-through soak drill needs
a real child vault to exercise.

## Structural properties (SV-1..SV-7)

- **Edges are creation-time only.** A vault becomes a child ONLY at factory deployment, never
  retroactively — so cycles are impossible by construction (a pre-existing vault can never be
  re-registered as a child), and vault-to-vault deposits are permitted solely along registered
  parent→child edges (SV-3, checked by `VaultCore.allocateToChild`).
- **Depth hard-capped at 3** (`MAX_DEPTH`): root = depth 0, deepest child = depth 2 ⇒ 3 levels.
- **Exit-fee stacking capped** (SV-4): cumulative exit-fee ceiling across the ancestor chain must
  stay under `STACKED_EXIT_FEE_CAP_BPS` = 250 (2.5%). Checked in `registerChild` by walking
  `parentOf` up the chain.
- **Quorum floors inherit** (SV-6): [[governance]] consults `parentOf` at registration (and on
  RuleChange update, Sprint-6 F2) and requires child quorum >= parent quorum.

## Key state

- `parentOf[child]`, `depthOf[child]` (root = 0).
- `factory` (one-shot `wire`, deployer-only), `deployer`.
- `PERF_FEE_BPS` = 1000 (mirrors [[feeengine]], per level).
- Views: `stackedPerfFeeBps(vault)` = `1 - (1 - f)^levels` in bps (SV-4 display);
  `stackedExitFeeCapBps(vault)` = summed exit-fee ceilings up the chain.

## Entry points

- `wire(factory)` — one-shot, deployer-only, locked after first call.
- `registerChild(parent, child, childExitFeeMaxBps)` — **factory-only**, creation-time only; runs
  the depth and fee-stack checks.

## Findings

The sub-vault criticals/highs (C-1, H-5, H-6, H-7, H-9) are all closed **as a class** by disabling
sub-vaults at the factory — see [[root-vaults-only]] and [[vaultfactory]]. This registry carries no
open finding of its own; its risk surface is simply switched off. The related VaultCore look-through
machinery (recursive `_fullNavWad`, child-shortfall unwind, `pullChildEscrow`) is likewise dead at
launch — documented in [[vaultcore]].

## Links

- [[contracts-index]] · [[vaultfactory]] · [[vaultcore]] · [[governance]] · [[feeengine]]
- Architecture: [[sub-vaults]]
- Findings: [[c1-empty-electorate]] · [[highs]]
- Decision: [[root-vaults-only]] · [[current-state]]
