# C-5 — Voting weight survives a full exit

A member can hold stake across one block boundary, propose, withdraw all capital instantly, and then
vote the proposal through with snapshot weight they no longer own — bearing none of the price
exposure the design's alignment rests on.

## Why it matters

Critical (base High × immutable). It reduces the skin-in-the-game requirement the entire timelock
mechanism exists to create — from days to seconds. Composed with H-4 (unbounded `minAmountOut`) it is
a complete drain primitive against **any** vault, not only sub-vaults; composed with M-8 (opaque
`actionHash`) voters cannot even see what they approve.

## Mechanism

Every weight read in `Governance` is `pastVotingEligibleShares(voter, p.createdAt - 1)`, and
`Checkpoints.getAt` returns the last checkpoint at or before that timestamp. The checkpoint written
when a member **exits** is stamped at the current block — strictly after `createdAt - 1` — so it is
invisible to a proposal already in flight. There is no current-balance check at `commitVote`,
`revealVote`, `revealDelegated`, `applyStandingDefault`, or `finalize`. Critically the exit settles
instantly: `hasPendingExecution` is false for the whole commit phase, so `requestExit` takes the
Mode-I branch and pays out immediately at pre-rebalance NAV. Confirmed end-to-end: deposit (mints
immediately after `skipWindow`), propose one block later, `requestExit(all)` settles instantly, then
commit/reveal FOR with full snapshot weight — `revealVote` does not revert on a zero balance —
`finalize` → Passed. The VO-9 control passes: stake acquired *after* creation carries zero weight;
the defect is that VO-9 is silent on the **withdrawal** direction. This also subsumes EE-10's Mode-F
mitigation (the lock removes eligibility only from *future* proposals).

## Status

**FIXED** (earlier remediation). Every weight read now takes the **minimum** of the snapshot weight
and the current eligible weight (`weight = min(pastVotingEligibleShares(...), votingEligibleShares(voter))`)
at all four read sites — so exiting forfeits voice on the in-flight proposal. The fix replaced four
inline weight reads with one helper, which net *shrank* `Governance`. Requires redeploy + re-review.

## Regression test

`contracts/test/audit/AuditVoteAfterExit.t.sol` (2 tests, including the passing VO-9 control).

## Links

- [[governance]] · [[governance-commit-reveal]] · [[two-mode-exits]] · [[vaultcore]]
- [[c2-unbounded-governance]] · [[highs]] (H-4) · [[mediums-and-lows]] (M-8) ·
  [[threat-model-commitments]] (VO-9, EE-10) · [[security-index]]
