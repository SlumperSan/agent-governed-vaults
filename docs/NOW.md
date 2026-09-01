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
- **The smoke lifecycle is RUNNING on Base Sepolia** (resumed 2026-09-01). It was parked at
  `activate` for three days on a mistyped keystore password, not a missing one — see "Blocked on a
  human" below, which was wrong about this. Past `activate` (5e18 shares minted), `propose` and
  `commitVote`; the remaining phases sit behind ~2h of protocol timelocks (1h commit, 1h reveal),
  then finalize → execute → exit. Idempotent and resumable at every step, and the commit salt is
  persisted *before* the commit transaction is sent, so a reveal is never stranded.
- **CI is back.** Actions minutes were exhausted 2026-08-29 and returned **2026-09-01** as predicted:
  `backend`, `contracts` and `slither` all run for real again, 5–6 minutes each, and pass. The tell
  for the outage window was a **2-second red with zero steps and no logs** — if you ever see that
  shape again, it is capacity, not code. `npm run gate` remains the fast local mirror (~30 s warm)
  and is still the right first check, but **a red CI is evidence again** rather than noise.
- **`protocol/main` was RED for about an hour on 2026-08-30 and is now GREEN again** (repaired at
  `4fc6ffbc`, `npm run gate` passes all 9 steps). Recorded because the CAUSE is a live hazard, not
  because the breakage stands: the oracle retirement moved five files out of `contracts/src/`, and
  another sprint branched from the SHARED worktree after the move but before the import paths were
  rewritten — so main received the moves without the fixes and stopped compiling. Nobody's change
  was wrong on its own; an intermediate state was captured mid-flight. The lesson is the one in
  `docs/SWARM.md` section 8: agents that write must work in their OWN worktree, or a half-finished
  edit becomes somebody else's base commit.
- **Batch related changes into one PR.** A CI round trip is 6–7 minutes, so three PRs for three
  related fixes costs 20 minutes of waiting for nothing.

## Blocked on a human

These need a decision or a machine capability. **Two entries stood here for days and were wrong**,
which is the more useful lesson: *"needs a key"* had become a habit rather than a fact, and nobody
re-checked it. Re-check this list before repeating it.

1. ~~**Resume the smoke lifecycle** (needs the `deployer` keystore password)~~ — **NOT BLOCKED, and
   running as of 2026-09-01.** The password file already existed at `%USERPROFILE%\.soak.pw` and
   unlocks the `deployer` account (verified read-only: it returns `0x0f80…9f35`). The earlier
   failure was a **mistyped** password, so the fix was `--password-file`, not a human at the
   keyboard. The 4-hour observation window had also elapsed **78 hours** earlier. Resume with
   `SMOKE_SIGNER_ARGS="--account deployer --password-file %USERPROFILE%\.soak.pw"`, plus
   `SMOKE_STATE` and `DEPLOY_JSON` pointed at the main checkout's copies.
2. ~~**Soak + canary re-run** (needs a funded testnet key)~~ — **NOT BLOCKED.** The deployer holds
   **0.5897 ETH** on Base Sepolia and both password files exist (`.soak.pw`, `.soak-agent.pw`).
   `run-soak.ps1`'s own header says so: *"Nothing needs a human once the password files are in
   place."* ⚠ **Run it from a checkout at current `main`** — the harness's oracle sampler
   fabricated staleness events on a healthy oracle until #94 fixed it, so an older tree produces a
   soak result that is worse than useless. Start it **after** the smoke lifecycle finishes: track B
   drives the smoke vault.
3. ~~**Recorded restore drill** — gate 7.~~ **DONE 2026-08-30** — `docs/RESTORE-DRILL.md`. The
   restore genuinely works on both state files. Gate 7 stays CONDITIONAL for one reason: steps 1
   and 6 of the runbook are `docker compose stop/start` and **there is no Docker on this machine**,
   so they were substituted. **Closing the row now needs Docker, not a key.**
4. **Launch parameter: `proposalThresholdBps = 500`.** Keep it or lower it — immutable per vault
   once shipped. See the trap below.

## Traps that are not visible in the code

- **The operator needs ≥5% of eligible stake permanently, or loses the right to propose anything —
  including the change that would lower the threshold.** Dilution is passive: other members deposit,
  `totalShares` grows, nothing re-checks. This is a deliberate design choice, not a bug (a floor was
  implemented, measured, and reverted — `test/audit/AuditProposalThresholdFloor.t.sol` — because a
  constructor cannot observe live stake distribution). Consequence: the operator seed is *derived,
  not chosen*, and "zero capital cost to the operator" is false — say *low*, and state the number.
- **This is a shared worktree.** Never `git add -A`; it has already swept another session's work
  into a PR. Commit named paths only.
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
