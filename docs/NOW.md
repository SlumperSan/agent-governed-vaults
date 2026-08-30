# NOW — start here

**The cold-start file.** Read this first, then run `npm run cc`. Together they should make a fresh
session productive without re-reading the history.

Keep it SHORT and keep it CURRENT. If a section here grows past a screen, the detail belongs in the
document it points at. A stale NOW.md is worse than none, so update it in the same commit as the
work it describes.

- **Live facts** (branch, gate result, deployed addresses, launch gate board, open PRs) are computed
  by `npm run cc` — never duplicate them here, they will drift.
- **Reasoning** lives in `docs/LAUNCH-READINESS.md` (go/no-go, argued) and the Obsidian vault
  (`Agent-Governed Vaults/`) — narrative, decisions, session handoffs.
- **This file** holds only what neither of those gives you: what is being worked on right now, what
  is blocked on a human, and the traps that are not visible in the code.

---

## Right now

- **Launch is NO-GO, but no longer for security reasons.** Every security gate is cleared. What
  remains is operational (testnet re-runs, a restore drill), legal, and calendar-bound.
- **Smoke test is parked mid-lifecycle on Base Sepolia**, at the `activate` step. It is idempotent
  and resumable; the last attempt failed only on a mistyped keystore password. Remaining phases sit
  behind ~2h of protocol timelocks.
- **CI is unavailable** — GitHub Actions minutes exhausted 2026-08-29, back around 2026-09-01.
  `npm run gate` is the substitute and mirrors `ci.yml` step for step. Do not trust a red CI in this
  window without reproducing it locally: PR #71's "backend fail" was minutes exhaustion, not code.
- **Batch related changes into one PR.** A CI round trip is 6–7 minutes, so three PRs for three
  related fixes costs 20 minutes of waiting for nothing.

## Blocked on a human

These need a funded key or a decision, and no amount of agent work advances them:

1. **Resume the smoke lifecycle** (needs the `deployer` keystore password) — unblocks launch gate 2.
2. **Soak + canary re-run** on the pivoted tree — unblocks gates 3 and 6. Wired and ready:
   `scripts/soak/run-soak.ps1`.
3. **Recorded restore drill** — gate 7. ~30 minutes, read-only, no keys needed.
4. **Launch parameter: `proposalThresholdBps = 500`.** Keep it or lower it — immutable per vault
   once shipped. See the trap below.

## Traps that are not visible in the code

- **The operator needs ≥5% of eligible stake permanently, or loses the right to propose anything —
  including the change that would lower the threshold.** Dilution is passive: other members deposit,
  `totalShares` grows, nothing re-checks. This is a deliberate design choice, not a bug (a floor was
  implemented, measured, and reverted — `test/audit/AuditProposalThresholdFloor.t.sol` — because a
  constructor cannot observe live stake distribution). Consequence: the operator seed is *derived,
  not chosen*, and "zero capital cost to the operator" is false — say *low*, and state the number.
- **This is a shared worktree.** Never `git add -A`; it has swept another session's work into a PR
  **twice** — the second time (PR #76) carried five half-finished oracle file renames whose import
  sites were never updated, and left `protocol/main` unbuildable until they were reverted. Commit
  named paths only.
- **`OperatorRegistry` attestation has no rebind**, so the operator payout address is permanent.
  It should be a Safe, not an EOA.
- **The oracle is single-provider Chainlink.** Heartbeat + sane-price band + sequencer gate are the
  only defences against a bad answer. Assets are limited to WETH + cbBTC — Base has no cbETH/USD
  feed. A feed deprecation fails that asset *closed*, which is safe but has no fallback.
- **The sequencer guard has never run against a real uptime feed.** Testnet leaves it `address(0)`
  by design, so its first real execution would be on mainnet.

## The loop

```bash
npm run gate
```

Mirrors CI locally in about 30 seconds. `--quick` drops the gas snapshot; `--only <step>` re-runs one
step; `--list` explains every step and the deliberate divergences from CI.

```bash
npm run cc
```

The command center: tree state, whether the gate result actually certifies *this* commit, the launch
gate board, deployed addresses, and open PRs. `--md` emits the same content as markdown for a handoff
note.

Reusable multi-agent patterns are saved workflows, not re-authored scripts — see
`.claude/workflows/` (`adversarial-review`, `department-buildout`) and `docs/WORKFLOWS.md`.
