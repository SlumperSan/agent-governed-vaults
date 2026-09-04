# Sub-Vaults

**Definition.** The parent/child composition layer ([[subvaultregistry]]): a parent vault
allocates capital to a child that governs its own mandate, with a depth cap and recursion block.
**Status: DORMANT-AT-LAUNCH** — disabled at the contract level.

**Why it matters.** A funded child has an *empty electorate* — the one governance shape with no
purely-internal fix. Rather than ship a capturable mechanism, the owner disabled sub-vaults for
launch and deferred the correct design to a post-audit release.

## DORMANT-AT-LAUNCH — the double disable (audit C-1)

`Deploy.s.sol` constructs [[vaultfactory]] with `allowSubVaults = false`. It is a constructor
immutable, so it is a property of **that factory**, not of the protocol. On such a factory
sub-vaults are disabled in **two** independent ways:

1. `createChildVault` **reverts** `SubVaultsDisabled` — no child can be created on it.
2. Every vault it deploys is wired with `subVaultRegistry = address(0)`, so each of those vaults is
   **intrinsically root-only**: `parentVault()` is `address(0)`, `allocateToChild` reverts, and
   the look-through pricing paths are dead code.

**Neither bullet holds on a factory built with `true`.** `DeployTestnet.s.sol` passes `true`, and
the live Base Sepolia factory reads `allowSubVaults() == true`, because the SV-7 look-through soak
drill needs a real child vault to exercise. Read `VaultFactory.allowSubVaults()` on the factory you
integrate against rather than trusting this page.

This closes audit findings **C-1, H-5, H-6, H-7, and H-9 as a class** on the launch factory. See
[[c1-empty-electorate]] and the decision note [[root-vaults-only]].

## Why there is no internal fix

A funded child's only capital is the parent's allocation, but the GA-1 rule excludes a registered
parent from voting-eligible stake and holder count (otherwise the child is ungovernable, since the
parent has no vote path). That leaves the child's *voting* electorate at zero — so one
`minDepositUsdc` dust deposit buys sole governance control, and the proposer-supplied
`minAmountOut` turns capture into a drain. Any denominator that excludes the parent lets a dust
depositor govern the parent's allocation; any denominator that includes it makes the child
ungovernable. The correct mechanism — **parent casts the child's vote** — is deferred, not hacked
in. The sub-vault code is **retained, not deleted**, so a future factory can enable it once that
mechanism ships.

## The mechanism, for the future release (constraints recorded now)

These constants live in [[subvaultregistry]] and describe the deferred design:

- **Depth hard-capped at 3** (`MAX_DEPTH = 3`; root = depth 0, deepest child = depth 2, i.e. 3
  levels). Depth = registry-recorded parent-chain length; a new vault inherits parent depth + 1
  regardless of operator identity (SV-2).
- **Recursive deposits blocked at contract level:** a registry walk of the full ancestor chain at
  deposit time (O(3) by the depth cap); vault-to-vault deposits permitted *only* along registered
  parent→child edges, closing side-channel cycles like A→B→A (SV-3).
- **Cumulative effective fee capped** — `STACKED_EXIT_FEE_CAP_BPS = 250` (2.5% ceiling);
  `PERF_FEE_BPS = 1_000` per level mirrors [[feeengine]]. Re-checked at allocation *and* at child
  fee-crystallization (SV-4 / G2).
- **Parent redemptions draw idle stables before touching child positions** (SV-5, liquidity
  preference not a price guarantee).
- **Child quorum floor inherits `max(childFloor, parentFloor)`** at allocation, parent floor
  capped for inheritance (SV-6 / GA-1 fix — a parent could otherwise set floor 100% and brick the
  child).
- **Look-through NAV:** a parent prices its child position through the same oracle asset-level
  path, never through child self-reported NAVps (SV-7 / E1 — recurses depth-bounded so grandchild
  value reaches root NAV). See [[oracle-layer]].

All SV-* threat rows are **DEFERRED(S5)** and unreachable in the launch config.

## Links

- [[architecture-overview]] · [[governance-commit-reveal]] (electorate, GA-1) · [[fees-and-carry]]
  (fee stacking) · [[oracle-layer]] (look-through pricing) · [[two-mode-exits]]
- Contracts: [[subvaultregistry]] · [[vaultfactory]] · [[vaultcore]]
- Security & decisions: [[c1-empty-electorate]] · [[root-vaults-only]] · [[launch-readiness-gates]]
