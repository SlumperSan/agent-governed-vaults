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

1. ~~**Resume the smoke lifecycle**~~ — **DONE 2026-09-01, and it PASSED. Launch gate 2 is EARNED.**
   All ten phases green on the pivoted tree against the live C-6 deployment: createVault →
   registerGov → deposit → activate → propose → commit → reveal → finalize → execute → exit.
   **The exit settled Mode I for exactly 5,000,000 USDC units — an exact round trip — and left
   `totalShares() == 0`**, confirmed by an independent `cast call` after the run. Vault
   `0x4d60…1a0f`, proposal 1; run record kept at `scripts/.smoke-state.json`. 2h 0m wall clock,
   almost all of it the 1h commit + 1h reveal timelocks.

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
3. ~~**Recorded restore drill** — gate 7.~~ **DONE 2026-08-30, re-confirmed 2026-09-01** —
   `docs/RESTORE-DRILL.md` (+ its 2026-09-01 §9 addendum). The restore genuinely works on both
   state files, re-proven Docker-free and independently 2 days apart. Gate 7 stays CONDITIONAL for
   one reason: steps 1 and 6 of the runbook (`docker compose stop/start`) need a real POSIX kernel
   to deliver a real `SIGTERM`/`SIGINT`. **Checked 2026-09-01, three more scripted methods (none via
   Docker or Git Bash): Node-native `child_process.kill('SIGINT')`, the same with a detached process
   group, and `taskkill /PID` without `/F` — all three fail identically to the original Git-Bash
   `kill` (Windows itself refuses the last one: "can only be terminated forcefully"). This is a
   genuine, unscriptable Windows platform limit, not a tooling quirk — no further agent effort can
   close this without a real POSIX kernel.** RUNTIME.md §8.3/§8.6 now document the Linux/macOS
   bare-metal commands and this limitation explicitly.

   **This is closer to done than "needs Docker" sounds — checked directly, not assumed, 2026-09-01
   ~22:17Z: Docker Desktop 4.88.1 is already installed on this machine** (`docker.exe` at
   `C:\Program Files\Docker\Docker\resources\bin\` runs, reports version 29.7.2, `docker compose`
   v5.4.0 present; `Docker Desktop.exe`/`com.docker.backend.exe` are running). **The engine just
   can't start yet** ("Docker Desktop is unable to start") because a coordinator ran
   `wsl --install --no-distribution` elevated and it **needs a reboot to finish** — see [[Owner
   Decisions 2026-09-01]] §7 for the full context. Two ways to finish this, Option A is faster if
   the reboot already happened or happens anyway for other reasons; Option B needs nothing but the
   reboot since the install itself is done:

   **Option A — finish the Docker Desktop install already in progress (recommended, nothing left to download):**
   1. **Reboot** Windows (finishes the pending WSL2 kernel install).
   2. Start menu → **Docker Desktop** → open it. Accept the **Docker Subscription Service
      Agreement** if prompted (free for personal/small-business use —
      [terms](https://www.docker.com/legal/docker-subscription-service-agreement/)). Skip sign-in.
      Wait for the whale icon to say "Engine running".
   3. Open a **new** PowerShell window (existing ones won't have `docker` on PATH) and confirm:
      ```powershell
      docker --version
      docker compose version
      docker info | Select-String -Pattern "Server Version|OSType|WSL"
      ```
      If `docker` isn't found: `$env:Path += ";C:\Program Files\Docker\Docker\resources\bin"`, then
      add it permanently via *Settings → System → About → Advanced system settings → Environment
      Variables → Path*.
   4. If `docker info` still errors on WSL: `wsl --status`, then `wsl --update`, and in Docker
      Desktop *Settings → General* confirm "Use the WSL 2 based engine" is ticked.
   5. From the repo root: `docker compose up --build` (RUNTIME.md §4), then run the restore
      procedure exactly as `RUNTIME.md` §8.3 prints it — `docker compose stop indexer` /
      `docker compose start indexer` — no substitution needed.
   6. Update `docs/RESTORE-DRILL.md` and the gate 7 row in `docs/LAUNCH-READINESS.md` with the
      result (PASS → GO, or whatever it actually shows).

   **Option B — WSL2 alone, no Docker (cheaper if you'd rather not wait on Docker Desktop's engine):**
   1. Open **PowerShell as Administrator** and run:
      ```powershell
      wsl --install
      ```
      (Installs WSL2 + the default Ubuntu distro. [Microsoft's WSL install docs](https://learn.microsoft.com/en-us/windows/wsl/install) if anything prompts unexpectedly.)
   2. Reboot if prompted.
   3. Launch **Ubuntu** from the Start menu once, and complete the first-run UNIX username/password
      setup it asks for.
   4. Inside that Ubuntu shell, install Node 24+:
      ```bash
      curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
      sudo apt-get install -y nodejs
      node --version   # confirm >= 24
      ```
   5. From that same shell, `cd` to the repo via its Windows path (e.g.
      `cd /mnt/c/Users/Micha/desktop/x402`) and run `npm ci`.
   6. Re-run `docs/RESTORE-DRILL.md` §7's reproduction steps verbatim — `kill -TERM $(pgrep -f
      index-runner.mjs)` for step 1 and `node packages/indexer/src/index-runner.mjs` for step 6 are
      now real signals, not substitutes. Confirm `shutdown.complete` appears in the logs (§8.6).
   7. Update `docs/RESTORE-DRILL.md` and the gate 7 row in `docs/LAUNCH-READINESS.md` with the
      result.
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
