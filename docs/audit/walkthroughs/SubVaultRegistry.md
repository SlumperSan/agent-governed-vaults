# Walkthrough — SubVaultRegistry.sol

**Risk: Medium.** ~95 LoC. `contracts/src/SubVaultRegistry.sol`.

## Purpose

The structural truth about parent/child vault relationships (SV-1..SV-7): who is whose child,
how deep the tree goes, and whether the cumulative fee stack stays under the protocol
ceiling. Consumed by three parties: VaultCore (`parentOf` for edge-checked allocation and the
parent-voting exclusion), Governance (`parentOf` for SV-6 quorum-floor inheritance), and the
factory (the only writer).

## The one structural guarantee everything else leans on

**Edges are creation-time only.** A vault becomes a child exactly once, at factory deployment
(`createChildVault` → `registerChild`), and `registerChild` requires the child to be
previously unknown (`parentOf == 0 && depthOf == 0`). A pre-existing vault can never be
re-registered as someone's child. Consequences:

- **Cycles are impossible by construction** (SV-3): a cycle would require an existing vault
  to acquire a parent, which no code path allows. There is no cycle-detection walk because
  none is needed.
- Vault-to-vault deposits flow only along registered parent→child edges — VaultCore's
  `allocateToChild` checks `parentOf(child) == address(this)`.
- `depthOf[child] = depthOf[parent] + 1`, required `< MAX_DEPTH = 3` — so depths 0/1/2, three
  levels including root (SV-2: depth derives from the recorded chain, not operator identity).

## State & entry points

| Item | Notes |
| --- | --- |
| `wire(factory)` | One-shot deployer wiring; zero-guarded; locked after (`AlreadyWired`) |
| `registerChild(parent, child, childExitFeeMaxBps)` | **Factory-only.** Depth check + SV-4 stack check: Σ exit-fee ceilings over the whole ancestor chain (child included) ≤ `STACKED_EXIT_FEE_CAP_BPS = 250` (2.5%) |
| `parentOf` / `depthOf` | The edge data |
| `stackedPerfFeeBps(vault)` | Display view (SV-4): `1 − (1−10%)^levels` in bps — bounded by the depth cap |
| `stackedExitFeeCapBps(vault)` | Display view: Σ ancestor exit-fee ceilings |

## Review focus

1. **Depth/stack arithmetic at the boundaries:** parent at depth 2 must be rejected
   (`parentDepth + 1 < 3`); the ancestor-chain walk in the stack check terminates because
   depth ≤ 2 (`test_depthCapAtThreeLevels`, `test_exitFeeStackCapEnforced`).
2. **The stack cap uses exit-fee *ceilings*** (`exitFeeMaxBps`), which are immutable per
   vault — so the cap cannot be evaded by post-registration fee changes (there are none).
   The SV-4 threat-model row's "child changes fees after allocation" concern is structurally
   moot in v1 for exit fees; perf fee is protocol-fixed at 10% per level.
3. **`registerChild` calls `IVaultFees(parent).exitFeeMaxBps()`** on an arbitrary `parent`
   address supplied by the factory — the factory only passes real vaults, and only the
   factory may call. Confirm no other caller can reach it post-wiring.

## Accepted risks here (do not re-report)

- **SV-1:** mandate enforcement between parent and child is governance, not code — the parent
  is a (non-voting) member of the child; code cannot read mandates.
- The registry records structure only; economic consequences of the structure (E4/E5 exit
  residuals, look-through pricing) live in VaultCore and are documented there.
