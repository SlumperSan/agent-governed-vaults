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
- **Member self-service** — the copy-paste `cast` reads (NAV, price, shares, freeze state, exit
  mode) and the direct-to-contract deposit / exit / `cancelPending` recipes a member uses when the
  website is down or untrusted — is `docs/MEMBER-VERIFY.md`. Incident messages point there for
  "verify it yourself".

---

## Right now

- **Launch is NO-GO, but no longer for security reasons.** Every security gate is cleared. What
  remains is operational (the soak and canary re-runs — the restore drill is done and gate 7 is
  **GO** as of 2026-09-02), legal, and calendar-bound.
- **The smoke lifecycle is DONE on Base Sepolia and its evidence is committed** (2026-09-03).
  The stack was redeployed 2026-09-02 at `sourceCommit 8a0e1155` and the full ten-phase lifecycle
  ran against it and passed — vault `0xb940d71b…3c98`, exact 5,000,000-unit USDC round trip,
  `totalShares() == 0`. The record no longer lives only in the gitignored `scripts/.smoke-state.json`:
  the address book is [`contracts/config/deployments/base-sepolia.json`](../contracts/config/deployments/base-sepolia.json)
  and the per-phase transaction table is
  [`docs/evidence/testnet-lifecycle-run.json`](evidence/testnet-lifecycle-run.json), every row
  re-read from chain with `cast receipt` after the run. Gate 2 is GO on the current tree.
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

1. ~~**Resume the smoke lifecycle**~~ — **DONE, re-run on the CURRENT tree 2026-09-03, and it
   PASSED. Launch gate 2 is EARNED and now CITABLE.** All ten phases green against a fresh
   deployment (`sourceCommit 8a0e1155`, factory `0xc1cb7824…9743`): createVault → registerGov →
   deposit → activate → propose → commit → reveal → finalize → execute → exit, blocks
   46,307,218 → 46,318,032, every one `status: true` re-read from chain after the run.
   **The exit settled Mode I for exactly 5,000,000 USDC units — an exact round trip — and left
   `totalShares() == 0`**, both decoded from the receipts' own USDC `Transfer` logs. Vault
   `0xb940d71b…3c98`, proposal 1. The run record was previously kept only at the gitignored
   `scripts/.smoke-state.json`, which the runner overwrites; it is now transcribed into the tracked
   [`docs/evidence/testnet-lifecycle-run.json`](evidence/testnet-lifecycle-run.json).
   *(The 2026-09-01 run against the retired deployment, vault `0x4d60…1a0f`, is superseded.)*

   **It was never blocked.** The password file was already at `%USERPROFILE%\.soak.pw`, the deployer
   already held 0.5897 ETH, and the observation window had elapsed **78 hours** earlier — the
   original failure was a *mistyped* password and the fix was `--password-file`. Re-run any time
   with `SMOKE_SIGNER_ARGS="--account deployer --password-file %USERPROFILE%\.soak.pw"`.

   **What it does NOT prove**, stated so the row is not over-read: the sequencer guard still has
   never executed — Base Sepolia leaves `sequencerUptimeFeed` at `address(0)` by design, so its
   first real run is still mainnet — and this was one vault, one member, one no-op rebalance. No
   Mode-F queue, no sub-vaults, no adversarial adapter. Those are the soak's job, below.
2. ~~**Soak + canary re-run** (needs a funded testnet key)~~ — **NOT BLOCKED.** The deployer holds
   **0.5897 ETH** on Base Sepolia and both password files exist (`.soak.pw`, `.soak-agent.pw`).
   `run-soak.ps1`'s own header says so: *"Nothing needs a human once the password files are in
   place."* ⚠ **Run it from a checkout at current `main`** — the harness's oracle sampler
   fabricated staleness events on a healthy oracle until #94 fixed it, so an older tree produces a
   soak result that is worse than useless. Start it **after** the smoke lifecycle finishes: track B
   drives the smoke vault.
3. ~~**Recorded restore drill** — gate 7.~~ **DONE. Gate 7 is GO as of 2026-09-02 and nothing here
   is blocked on a human any more.** The drill was recorded Docker-free on 2026-08-30 and
   re-confirmed 2026-09-01 (`docs/RESTORE-DRILL.md` §5–6 and its §9 addendum), then **re-run under
   Docker on a real Linux engine** — Docker Desktop 4.88.1, server 29.7.2, OSType `linux` — with
   **steps 1 and 6 literal** (`docker compose stop/start`), which was the one condition the row was
   CONDITIONAL on: #139 (`4619f17a`), recorded in `docs/RESTORE-DRILL.md` §10. That run also closed
   four of the five gaps §6 had listed as untested (aged rung, off-host tar, atomicity under a kill
   in flight, production scale) and surfaced three defects in the printed procedure, all fixed in
   #141 (`adafdc7c`) — RUNTIME.md §8.3 now carries both a Docker and a bare-metal column, every
   Compose `command:` runs `node` at PID 1 so SIGTERM actually reaches the shutdown hooks, and the
   off-host tar resolves the Compose-namespaced volume instead of silently creating an empty one.
   **The Docker/WSL2 install instructions that stood here are obsolete and have been removed.** The
   residuals that remain are named in the gate 7 row of `docs/LAUNCH-READINESS.md` and belong to
   other gates, not to this one.
4. **Launch parameter: `proposalThresholdBps = 500`.** Keep it or lower it — immutable per vault
   once shipped. See the trap below.

## Traps that are not visible in the code

- **The operator needs ≥5% of eligible stake permanently, or loses the right to propose anything —
  including the change that would lower the threshold.** Dilution is passive: other members deposit,
  `totalShares` grows, nothing re-checks. This is a deliberate design choice, not a bug (a floor was
  implemented, measured, and reverted — `test/audit/AuditProposalThresholdFloor.t.sol` — because a
  constructor cannot observe live stake distribution). Consequence: the operator seed is *derived,
  not chosen*, and "zero capital cost to the operator" is false — say *low*, and state the number.
- **Below 5%, the operator cannot withdraw *anything* while a non-creator member remains.**
  `_checkCreatorGate` requires `(s − b) · 10_000 ≥ 500 · (T − b)`; `(s − b)/(T − b)` falls as the
  burn grows for ANY `s < T`, so a creator who starts below 5% fails at every burn amount — one
  share included. The same passive
  dilution that removes proposal rights also freezes the remaining capital. By design, not a bug
  (the gate binds creator *action*, CM-2), and recoverable: a top-up, a member exit, or the last
  member leaving. Pinned in `test/audit/AuditCreatorGateTraps.t.sol`; the arithmetic is Finance's
  (`Operator Capital Requirement.md`, "Dilution is passive, and the gate math is one-directional").
- **Past 95% external fill, the top-up can never reach 5% again.** The capacity cap binds the
  operator's deposit too, so once outsiders hold more than 95% of cap, even filling the vault to
  cap leaves the operator short (`K = C − E < 0.05 · C`; at a 50k cap, once outsiders hold >
  $47,500, $2,500 is unreachable). Recovery is a member exit or an NAV drawdown reopening
  headroom — nothing the operator controls. By design, not a bug: the cap is a cap. The top-up
  must *lead* the fill, not chase it, which is why the seed is 5%-of-cap on day one. Same test
  file; same Finance note, "The cap race".
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
