# Root Vaults Only

At launch the protocol ships with sub-vaults disabled: `VaultFactory.allowSubVaults = false`, so `createChildVault` reverts and every vault is wired root-only. This is the C-1 fix. **DECIDED / FIXED (2026-08-28, Phase 2).**

## Why it matters

C-1 ([[c1-empty-electorate]], issue #33) let a funded sub-vault be captured outright for **one minimum deposit**, because the parent is excluded from its child's electorate entirely — leaving a vault that holds real money with an empty electorate, where capture equals drain. There is **no purely-internal fix**, so the launch surface was re-scoped rather than patched.

## The decision and rationale

The report's own suggested fix (`pHeld = 0`, counting the parent as a member) was implemented and analysed, and **it does not work**: at parent + 1 member the signer regime needs `1 * 2 > 2` (false), so a legitimate child could no longer pass a Rebalance, while an attacker just brings a second sybil (`2 * 2 > 3`). Real liveness cost, marginal security gain.

The underlying tension is structural: **any denominator that excludes the parent lets whoever dominates the smallest pool of capital govern the largest; including it makes the child ungovernable.** The parent needs a new mechanism to cast the child's vote through its own governance — deferred to a post-launch, post-audit release.

The owner's decision was to **disable sub-vaults at launch** rather than build that mechanism now. `allowSubVaults = false` means the empty-electorate capture has no target. This closes C-1 **and** the sub-vault-only Highs H-5, H-6, H-7, H-9 as a class — which is also why the broken `redeemFromChild` escape hatch (H-6) no longer matters at launch. Several Mediums/Lows (M-5, L-6) go **DORMANT-AT-LAUNCH** for the same reason.

Regression: `AuditRootVaultsOnly.t.sol`. It is a launch **parameter**, costs nothing to honour, and does not wait on a redeploy. **Re-enabling sub-vaults reopens C-1** until the parent-casts-child-vote mechanism is built and audited.

## Links

- Resolves: [[c1-empty-electorate]] · closes as a class: [[highs]] (H-5/H-6/H-7/H-9)
- Contracts: [[vaultfactory]] · [[sub-vaults]] · [[subvaultregistry]] · [[vaultcore]]
- Related decisions: [[delegatecall-split-rejected]] · [[decisions-index]]
- State: [[current-state]] · [[open-items]] · [[remediation-history]] · [[launch-readiness-gates]]
