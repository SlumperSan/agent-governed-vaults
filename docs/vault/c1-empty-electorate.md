# C-1 — Empty electorate: a funded sub-vault is captured for one minimum deposit

A funded child vault whose only capital is its parent's allocation has an **empty electorate**, so
any outsider can deposit one `minDepositUsdc`, become the sole eligible voter, and pass a proposal
that drains it.

## Why it matters

Critical. Capture equals drain: it costs one minimum deposit (as low as 1 unit) plus gas, and the
loss is borne by the parent's members via collapsed look-through NAV. There is no proxy, pause, or
admin path to undo it after deployment.

## Mechanism

The GA-1 fix excluded the parent from the child's voting-eligible stake **and** from its holder
count (`_snapshot`, `VaultCore.sol:514-518`), to keep full-consensus `RuleChange` reachable. The unanticipated
consequence: in a child whose only capital is the parent's allocation,
`pastTotalVotingEligibleShares == 0` and `pastHolderCount == 0` — the vault holds real money with no
electorate. `deposit` is permissionless, so one deposit makes the attacker the sole eligible voter,
and every gate (proposal threshold, `<5`-member signer regime, `1*2 > 1` quorum, outcome) passes
trivially. `execute` is permissionless too. Because `executeRebalance` bounds output only by the
proposer-supplied `minAmountOut` (1 wei suffices) and the router path is attacker-chosen (H-4), the
attacker routes the vault's assets through a pool they seeded and books ~nothing.

## Status

**FIXED at launch** by [[root-vaults-only]] (2026-08-28, Phase 2). The report's own suggested
in-contract fix (`pHeld = 0`, count the parent as a member) was evaluated and **rejected**: it
breaks the legitimate parent+1-member child (the signer regime needs `1*2 > 2`, false), and the
tension is structural — any voting denominator that excludes the parent lets a dust depositor govern
the parent's allocation, while including it makes the child ungovernable (the parent is a contract
with no vote path). There is **no purely-internal fix**; the correct mechanism (parent casts the
child's vote) is a product decision deferred to a post-launch, post-audit release. `VaultFactory`
ships with immutable `allowSubVaults = false`: `createChildVault` reverts `SubVaultsDisabled` and
every vault is wired `subVaultRegistry = address(0)`, so no vault can ever be funded as a child and
the empty-electorate precondition is **unreachable**. VaultCore bytes are unchanged. This closes C-1
and the sub-vault-only Highs H-5/H-6/H-7/H-9 as a class. **Re-enabling sub-vaults reopens C-1.**

## Regression test

`contracts/test/audit/AuditRootVaultsOnly.t.sol` (2 tests: one reproduces the live capture with
sub-vaults enabled, one proves it unreachable under the launch gate).

## Links

- [[root-vaults-only]] · [[vaultcore]] · [[vaultfactory]] · [[governance]] · [[sub-vaults]] ·
  [[execution-adapters]]
- [[highs]] (H-5/H-6/H-7/H-9 closed with it) · [[security-index]] · [[launch-readiness-gates]] ·
  [[threat-model-commitments]] (SV-1/SV-7 governance not upheld)
