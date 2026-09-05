# C-2 — Unbounded governance durations freeze every exit permanently

Three of four governance duration parameters had no upper bound, so a single `propose()` call could
pin a proposal in `Active` for ~136 years and freeze every exit in a vault forever — no vote, no
quorum, no collusion.

## Why it matters

Critical (base High × immutable). Triggerable by one transaction; with `proposalThresholdBps = 0`
(the value shipped in `base-mainnet.json`, M-6) it costs one `minDepositUsdc`. There is no cancel
path, and the frozen vault **cannot legislate its way out**: a stuck proposal blocks every future
proposal, including the `RuleChange` that would repair the config.

## Mechanism

`_validateConfig` capped only `timelockDuration` (the one parameter that does not gate exits);
`commitDuration`, `revealDuration`, `executionWindow` had floors but no ceilings, and
`proposalCooldown` was not validated at all. `hasPendingExecution`'s `Active` branch
(`hasPendingExecution`, `Governance.sol:647-649`) returns true for any proposal past its `commitDeadline` — **passage is
irrelevant** — while `finalize` requires `block.timestamp >= revealDeadline`. So an unbounded
`revealDuration` pins the proposal in `Active` for ~136 years. In `VaultCore` that flag is the Mode-F
switch: `requestExit` queues (`:445`) and `settleQueuedExit` reverts `ExecutionStillPending` (`:477`),
with no cancel path. `_isSettled` counts only `Defeated | Executed | Expired`, so `propose`'s guard
rejects any new proposal. This falsifies **EE-10** ("no indefinite lock") and **MO-1** (the Mode-I
fallback covers a *broken* module, not a correct governance answering `true` forever).

## Status

**FIXED** (earlier remediation). A phase hard-cap now bounds `commitDuration`, `revealDuration`,
`executionWindow`, and `proposalCooldown` above — the last was previously unvalidated (the same C-2
shape, found while fixing M-6). Mode F is also decoupled from proposals that have not passed. Requires
redeploy + re-review; landed in the corrected tree.

**Later narrowed by T-1, and no longer 30 days.** `COMMIT_HARD_CAP` is now `DEFAULT_TTL - 1`, set by
the standing-default TTL rather than by this finding — see [[mediums-and-lows]]. That is strictly
stronger for C-2 (a shorter maximum freeze), and the two exploit tests named below use 1h and 6h
commit phases, so neither is affected. `REVEAL_HARD_CAP` and `EXECUTION_WINDOW_HARD_CAP` are
unchanged, and the reveal phase is the one C-2's exploits actually pinned.

## Regression test

`Governance.t.sol::test_phaseDurationHardCapsEnforced` pins the fix. The original exploit lived in
`contracts/test/audit/AuditExecutionWindowFreeze.t.sol` (4 tests) and `AuditDosExitLiveness.t.sol`;
the C-2 cases were removed when the hard caps landed (they asserted the unfixed behaviour) and
survive in git history.

## Links

- [[governance]] · [[vaultcore]] · [[two-mode-exits]] · [[governance-commit-reveal]]
- Related liveness: [[mediums-and-lows]] (M-7 serial-proposal exit freeze, M-8 opaque hash) ·
  [[c5-vote-after-exit]] · [[threat-model-commitments]] (EE-10, MO-1 falsified) · [[security-index]] ·
  [[remediation-history]]
