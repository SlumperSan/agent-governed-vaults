# Restore drill report — launch gate 7

**Date:** 2026-08-30 · **Chain:** Base Sepolia (84532) · **Tree:** `132f837e` · **Gate:** [7 — ops runbook exercised](LAUNCH-READINESS.md)

Sprint 13 shipped the backup ring and the `verify` subcommands with tests, and the Sprint-12 soak
restarted services freely. Neither is a restore. This drill takes the procedure in
[`RUNTIME.md` §8.3](RUNTIME.md) and executes it as written against **real artifacts produced by
the real daemons running against the live Base Sepolia deployment** — no fixtures, no test
doubles, and nothing asserted from the test suite.

Both state files were drilled: the indexer snapshot and the canary's transition state (the runbook
claims the canary's procedure is "identical with its own paths" — that claim is now tested, not
assumed).

| Drill | Verdict | The one-line result |
| --- | --- | --- |
| A — indexer snapshot | **PASS** | corrupted live file → restored from `.1` → daemon resumed at `lastBlock+1`, re-indexed the 13-block loss, counts identical |
| B — canary state | **PASS** | restored state reloaded **8 tracked signals**; **zero duplicate pages** for the 3 signals already firing — the property the ring exists for |
| C — atomicity under a hard kill | **NOT PROVEN** | the kill landed ~2.4s *after* a completed write, in the poll sleep — no write was in flight, so the run says nothing about atomicity. See §6. |

**Gate 7 verdict: the restore genuinely works, and gate 7 stays CONDITIONAL.** The procedure
recovered real state twice, but two of its six steps (`docker compose stop/start`) had no Docker
available in this environment and were executed by their bare-metal equivalent. That substitution
is a runbook gap, not a code defect — but a gate that says "the runbook was exercised" should not
go green on a procedure that was 4/6 followed literally. §5 states exactly what was substituted.

---

## 0. Environment and discipline

- **Chain:** live Base Sepolia via `https://base-sepolia-rpc.publicnode.com`. Read-only — the
  drill holds **no key**, funds **no account**, and sends **no transaction**.
- **Deployment:** the C-6 pivot address book, `contracts/config/deployments/base-sepolia.json`
  (factory `0x72767FAD…FD0A`, deploy block 46,111,530).
- **State dir:** a dedicated `./data-drill/`, never the repo's `./data/`. This is a shared
  worktree; the drill deliberately could not touch another session's state.
- **Deviation from production defaults, stated up front:** `SNAPSHOT_BACKUP_INTERVAL_MS=20000`
  (indexer) and `10000` (canary) instead of the default `300000`, so the 3-rung ring filled in
  ~75s instead of 15 minutes. `SNAPSHOT_BACKUPS=3` is the default and was left alone. The
  interval affects **how old** a rung is, not whether restore works — but it means this drill did
  not exercise a 5-minute-old backup. See §6.
- **Nothing in the repo was modified to make the drill pass.** The only tracked-file changes in
  this PR are this report and the gate 7 row.

## 1. What each `verify` subcommand actually asserts

Both are `argv[0] === 'verify'` branches that run **before** config resolution, so they need no
env at all — correct, because whoever is verifying a snapshot after a crash has none of the six
indexer variables set. Neither starts a poller or touches an RPC.

| | `index-runner.mjs verify [path]` | `canary-runner.mjs verify [path]` |
| --- | --- | --- |
| Asserts | file exists; `JSON.parse` succeeds; `deserializeState` succeeds | file exists; `JSON.parse` succeeds |
| Reports | `lastBlock`/`lastLogIndex`, the resume cursor, and `countState` tallies (vaults, operators, proposals, shareBooks, holders, activeProposals) | `lastScannedBlock`, tracked-signal count by status, and every signal **not** OK |
| Backups | parses each rung `.1..N` **independently**, printing its own `lastBlock` + vault count | same, printing each rung's own `lastScannedBlock` + tracked count |
| Exit | `0` usable, `1` unusable | `0` usable, `1` unusable |

**What they do not assert** — worth stating, because "verify says OK" is easy to over-read: neither
checks the state against the **chain**. `OK` means *structurally parseable and internally
coherent*, not *correct*. A snapshot that was folded wrong but still deserializes verifies clean.
That is the failure mode the ring exists for, and `verify` cannot detect it — only an operator
comparing the printed cursor and counts across rungs can. The runbook's step 2 ("pick a rung by
its printed cursor, not by its number") is doing that work, and it is load-bearing.

A third command, `ops-check.mjs`, is heartbeat liveness only and asserts nothing about state.

## 2. Producing real artifacts

The real indexer, against the live chain, cold-start:

```
{"event":"indexer.progress","msg":"resumed at block 0 (0 vaults)"}
{"event":"indexer.progress","msg":"⚠ indexer: START_BLOCK=46111530 on a fresh snapshot — vaults created before block 46111530 will NOT be discovered. Use the factory deploy block."}
{"event":"starting","chainId":84532,"knownVaults":0,"resumeBlock":46111530,"backups":3}
{"event":"indexer.progress","msg":"indexed [46111530..46113529] — 4 events, now at 46113529"}
…
{"event":"indexer.progress","msg":"indexed [46139530..46140871] — 0 events, now at 46140871"}
```

**29,341 blocks in 15 batches in 6.0s** (00:33:57.473 → 00:34:03.455), then steady-state polling.
The `START_BLOCK` warning fired exactly as §8.3 promises it does on a fresh snapshot.

The ring filled on the 20s spacing, four distinct cursors, all 630 bytes:

```
indexer-state.json     2026-08-30T00:35:56.341Z   lastBlock=46140929
indexer-state.json.1   2026-08-30T00:35:31.341Z   lastBlock=46140916
indexer-state.json.2   2026-08-30T00:35:06.300Z   lastBlock=46140903
indexer-state.json.3   2026-08-30T00:34:41.065Z   lastBlock=46140891
```

The projection is small but **not empty** — 1 vault (`0x4d60e49d…1a0f`), 1 operator — so the
restore had real folded state to lose and recover, not an empty object.

## 3. Drill A — indexer snapshot

### Step 1 — stop the writer (substituted; see §5)

`docker compose stop indexer` was unavailable. Used the documented SIGTERM path (§8.6). The process
exited in **~0.15s** and wrote **no `shutdown.complete` line**, which §8.6 says means the stop was
not clean. **It was not clean — and that is an artifact of this environment, not a defect.** An
isolated probe (a five-line script whose only job is a `SIGTERM` handler) confirmed the handler
never runs either: Git Bash `kill` terminates a native Windows Node process without delivering the
signal. So this became a **hard-crash** test rather than a graceful-shutdown test.

### Step 2 — verify the candidates (post-crash)

```
snapshot ./data-drill/indexer-state.json: OK
  cursor      lastBlock=46140929 lastLogIndex=-1 → resumes from block 46140930
  counts      vaults=1 operators=1 proposals=0 shareBooks=0 holders=0 activeProposals=0
  file        630 bytes, written 2026-08-30T00:35:56.341Z (38s ago)
  backups     3 (newest first)
    .1  lastBlock=46140916 vaults=1 630 bytes  2026-08-30T00:35:31.341Z
    .2  lastBlock=46140903 vaults=1 630 bytes  2026-08-30T00:35:06.300Z
    .3  lastBlock=46140891 vaults=1 630 bytes  2026-08-30T00:34:41.065Z
```

The snapshot came through the hard kill fully parseable. **That is not evidence of atomicity, and
this report will not claim it is.** The last write completed at `00:35:56.341` and the kill landed
at `00:35:58.703` — **~2.4s later, in the middle of the 12s poll sleep.** The file was already at
rest; no write was in flight. Atomic temp-then-rename was never put under load here. Recorded in
§6 as not proven.

One `verify` invocation covered the live file *and* every rung with its own cursor, so step 2's
plural "candidates" is satisfied by the single command the step prints.

### Destroying the live state

The realistic failure the ring exists for is *a write that succeeded and was wrong*, so the live
file was truncated mid-object rather than deleted:

```bash
head -c 300 data-drill/indexer-state.json > tmp && mv tmp data-drill/indexer-state.json
node packages/indexer/src/index-runner.mjs verify ./data-drill/indexer-state.json
```

```
snapshot ./data-drill/indexer-state.json: UNUSABLE — Unterminated string in JSON at position 300 (line 1 column 301)
  backups     3 (newest first)
    .1  lastBlock=46140916 vaults=1 630 bytes  2026-08-30T00:35:31.341Z
    .2  lastBlock=46140903 vaults=1 630 bytes  2026-08-30T00:35:06.300Z
    .3  lastBlock=46140891 vaults=1 630 bytes  2026-08-30T00:34:41.065Z
EXIT=1
```

Exit **1**, and the three healthy rungs are still summarised — a corrupt live file does not poison
the report that tells you what to restore from.

### Steps 3–5 — keep the bad file, copy the backup in, re-verify

```bash
mv ./data-drill/indexer-state.json ./data-drill/indexer-state.json.bad-1788050212
cp ./data-drill/indexer-state.json.1 ./data-drill/indexer-state.json
node packages/indexer/src/index-runner.mjs verify ./data-drill/indexer-state.json
```

```
snapshot ./data-drill/indexer-state.json: OK
  cursor      lastBlock=46140916 lastLogIndex=-1 → resumes from block 46140917
  counts      vaults=1 operators=1 proposals=0 shareBooks=0 holders=0 activeProposals=0
  file        630 bytes, written 2026-08-30T00:36:52.406Z (0s ago)
  backups     3 (newest first)
    .1  lastBlock=46140916 vaults=1 630 bytes  2026-08-30T00:35:31.341Z
    .2  lastBlock=46140903 vaults=1 630 bytes  2026-08-30T00:35:06.300Z
    .3  lastBlock=46140891 vaults=1 630 bytes  2026-08-30T00:34:41.065Z
EXIT=0
```

Restored file **byte-identical** to the rung it came from — `sha256 2cbf0e30c4a972d9…33032` on
both. Step 4's "copy, do not move" held: the ring still shows **3** rungs, so a failure at step 5
would have left `.1` available to try again. The `.bad-<epoch>` file did **not** pollute the ring
(`listBackups` walks `.1..N` only), so keeping evidence costs no backup depth.

### Step 6 — start the writer

```
{"ts":"2026-08-30T00:37:02.458Z","event":"indexer.progress","msg":"resumed at block 46140916 (1 vaults)"}
{"ts":"2026-08-30T00:37:02.459Z","event":"starting","knownVaults":1,"resumeBlock":46140917,"backups":3}
{"ts":"2026-08-30T00:37:03.209Z","event":"indexer.progress","msg":"indexed [46140917..46140962] — 0 events, now at 46140962"}
```

**This is the load-bearing line of the whole drill.** `knownVaults:1` means the vault set was
seeded from the *restored* snapshot — the thing that silently breaks if a restore only appears to
work. Resumed from `lastBlock+1` exactly as documented, and closed the 13-block rewind
(46,140,917 → 46,140,929) plus the elapsed gap in **one 0.75s batch**.

State one minute later, against the destroyed cursor `lastBlock=46140929 vaults=1 operators=1`:

```
snapshot ./data-drill/indexer-state.json: OK
  cursor      lastBlock=46140993 lastLogIndex=-1 → resumes from block 46140994
  counts      vaults=1 operators=1 proposals=0 shareBooks=0 holders=0 activeProposals=0
  backups     3 (newest first)
    .1  lastBlock=46140981 vaults=1 630 bytes  2026-08-30T00:37:40.878Z
    .2  lastBlock=46140968 vaults=1 630 bytes  2026-08-30T00:37:15.753Z
    .3  lastBlock=46140916 vaults=1 630 bytes  2026-08-30T00:36:52.406Z
```

Cursor past the destroyed one, **counts identical**, ring rotating again. `ops-check` agrees:

```
ops-check: 1/1 healthy (heartbeats in ./data-drill)
ok   indexer  fresh      age=8s  pid=40016 lastBlock=46140993 vaults=1
```

**Timings.** Stop → head regained: **64.5s** (00:35:58.7 → 00:37:03.2), nearly all of it the
operator running steps 2–5; the daemon itself needed 0.86s from launch to caught-up. Data rewound:
**13 blocks (~26s of chain)**. Backup age at restore: **81s** — a function of the drill's 20s
interval, not the 300s default.

## 4. Drill B — canary state (the "identical with its own paths" claim)

Same six steps, `canary-runner.mjs`, `./data-drill/canary-state.json`. The canary ran live against
the deployment and accumulated **8 tracked signals, 3 of them firing**, before being stopped.

Live state at step 2 — `lastScannedBlock=46141025`, ring at `.1 46141020 / .2 46141015 /
.3 46141009`. Truncating it to 400 bytes produced `UNUSABLE — Unterminated string in JSON at
position 400`, exit **1**, three healthy rungs still listed. `mv` to `.bad-1788050368`, `cp` from
`.1`, re-verify:

```
canary state ./data-drill/canary-state.json: OK
  cursor      lastScannedBlock=46141020
  signals     8 tracked — skipped=3 ok=5
    NOT OK    oracle-freshness|0x4d60e49d…1a0f|0x4200…0006 (skipped since poll 1)
    NOT OK    oracle-freshness|0x4d60e49d…1a0f|0xE4aB…2410 (skipped since poll 1)
    NOT OK    exit-liveness|0x4d60e49d…1a0f (skipped since poll 1)
  file        1155 bytes
  backups     3 (newest first)
    .1  lastScannedBlock=46141020 tracked=8 1155 bytes  2026-08-30T00:39:01.258Z
    .2  lastScannedBlock=46141015 tracked=8 1155 bytes  2026-08-30T00:38:50.738Z
    .3  lastScannedBlock=46141009 tracked=8 1155 bytes  2026-08-30T00:38:40.175Z
EXIT=0
```

Restart:

```
{"ts":"2026-08-30T00:39:35.932Z","event":"starting","chainId":84532,"tracked":8,"readOnly":true}
{"ts":"2026-08-30T00:39:35.934Z","event":"canary.transition","msg":"canary up: chain 84532, read-only, polling every 8000ms. Silence means healthy."}
```

`tracked:8` — the restored transition state was loaded — and **exactly one** transition line, the
"canary up" banner. **Zero duplicate pages** for the three signals that were already firing. That
is precisely the property §8.3 says restoring the canary's state buys you, and it is the only part
of the canary restore a file copy alone would not have proven. **The runbook's claim holds.**

## 5. Discrepancies between the runbook and reality

Five findings. None of them stopped the restore; two are real documentation gaps.

**1. Steps 1 and 6 are Docker-only, and §2 teaches a bare-metal path.** The restore procedure
prints `docker compose stop indexer` / `docker compose start indexer` with no alternative. But
§2 of the same document teaches `npm run start:indexer` in a shell as the *first* way to run the
stack, and §8.6 documents SIGTERM handling for all three services. An operator who followed §2 has
no documented stop/start for the procedure they are told to follow verbatim under incident
pressure. **Fix: add the bare-metal equivalent inline in steps 1 and 6.** This is the finding that
keeps gate 7 CONDITIONAL — 4 of 6 steps were followed literally, 2 were substituted.

**2. §8.6's `shutdown.complete` check carries no information on Windows.** "Look for
`shutdown.complete`… `shutdown.timeout` or `shutdown.forced` means the stop was **not** clean"
is sound under Docker/Linux. Under Git Bash on Windows the line is *unconditionally* absent
because the signal is never delivered (verified with an isolated probe, §3). An operator there
would conclude every stop was dirty. **Not a code defect** — the shutdown hooks are almost
certainly fine, they simply cannot be reached. RUNTIME.md never states a target platform;
**it should say the runtime is Linux/Docker and that bare-metal Windows cannot exercise the
graceful-shutdown path.**

**3. The step-2 note about a clean shutdown "pushing the ring along by one" could not be
exercised** — same root cause. The note is plausible and unrefuted; it is simply untested by this
drill.

**4. Step 3's command is POSIX-only.** `mv … .bad-$(date +%s)` does not run in PowerShell, which
is this project's owner's shell. Defensible under the Docker/Linux assumption, but it compounds
finding 2: nothing tells the reader that assumption exists. One line resolves both.

**5. Two suspicions checked and cleared, recorded so they are not re-investigated.** Step 2 says
"verify the candidates" (plural) but prints one command — that command *does* cover the live file
and every rung, so it is correct as written. And `.bad-<epoch>` does not consume a ring slot.

### Finding beyond gate 7 — the canary's oracle-freshness signal is blind on the pivoted deployment

> **RESOLVED 2026-08-30 — the signal now measures the deployed oracle.** Kept as the record of
> how the blind spot was found. `oracle-freshness` probes the oracle and dispatches to
> `signals/oracle-health.mjs` for `ChainlinkOracle`; an oracle it recognises as neither flavor is
> reported `DETECTOR BROKEN` and re-asserted on a backoff rather than going quiet. Gate 6 is
> re-earnable by the soak re-run, not re-earned by this fix.

Not a restore finding; surfaced because the drill ran the canary against the live deployment, and
too important to leave in a log file. The canary reported, for **both** assets on the deployed
vault:

```
DEGRADED [oracle-freshness] oracle config unreadable for asset 0x4200…0006 on vault 0x4d60…1a0f:
  The contract function "assetConfig" reverted.
```

`packages/canary/src/signals/oracle-freshness.mjs:49` reads `assetConfig(address)`. That function
exists **only on `OracleAggregator.sol`** — the contract the C-6 pivot retired.
`contracts/src/oracle/ChainlinkOracle.sol`, which the pivot deployed and allowlisted, exposes
`priceWad` and nothing else (`grep -c assetConfig` → **0**). The signal therefore reverts on every
poll, for every asset, on every vault, and parks permanently in `skipped`.

**Consequence: gate 6 (canary) has a signal that can never go green on the launch tree**, and
"silence means healthy" is not true for oracle freshness — it is silent because it is blind. This
should be an issue in its own right; it is out of scope for this PR, which changes no code.

## 6. Limits of this drill — what it did NOT prove

Stated without softening.

- **It did not exercise the runbook's own step 1 and 6 commands.** No Docker was available. The
  Compose stop/start path, `stop_grace_period`, and the healthcheck-driven restart are untested
  here. This alone is why gate 7 stays CONDITIONAL.
- **It did not prove graceful shutdown.** Every stop in this drill was a hard kill. The
  finish-the-batch-then-snapshot hook, `shutdown.complete`, and the final-snapshot ring push were
  never reached.
- **It did not prove atomicity under a hard kill**, despite the snapshot surviving one. Both kills
  landed in a poll sleep, seconds after a completed write (§3). Catching a write *in flight* would
  need a kill timed into the temp-then-rename window, which this drill did not attempt. The
  atomicity claim in §8.3 remains supported only by its tests.
- **It did not prove restore at production scale.** The snapshot was 630 bytes with 1 vault and 1
  operator. A 184KB snapshot with 7 vaults and 64 holders (§8.3's own example) may expose
  parse-time or fold-time behaviour this did not touch. Nothing observed suggests it would; the
  drill simply cannot speak to it.
- **It did not prove a production-aged backup.** The ring ran at a 20s/10s interval, not 300s. The
  oldest rung restored from was 81s old. The 15-minute default horizon is untested.
- **It did not prove the off-host backup.** §8.3's `docker run … tar czf` volume backup — the one
  that protects against a dead disk rather than a bad write — was not run. The ring is not a
  backup strategy on its own, and only the ring was drilled.
- **It did not prove the "every backup is bad" path.** Deleting the snapshot and rebuilding from
  `START_BLOCK` at the factory deploy block was not exercised beyond the cold start in §2 (which
  did, incidentally, rebuild 29,341 blocks correctly from nothing).
- **It did not prove the API's behaviour during the outage.** The API was not running. §8.3 claims
  the live file never blinks out of existence under the API's reload timer; the copy-not-rename
  discipline was verified structurally, but no reader was observing.
- **It proved nothing about correctness of the projection.** `verify` is a parseability check.
  A restore that recovers a *wrongly folded* state verifies clean and this drill would not notice.
- **It is not evidence of security.** Nothing here was adversarial.

## 7. Reproducing this

```bash
npm ci
mkdir -p data-drill
```

Write `data-drill/drill.env` with all five required indexer variables, taken from
`contracts/config/deployments/base-sepolia.json` (`singletons.VaultFactory`,
`.OperatorRegistry`, `.SubVaultRegistry`, `.Governance`, and `startBlock`):

```
RPC_URL=https://base-sepolia-rpc.publicnode.com
CHAIN_ID=84532
CHAIN_NAME=base-sepolia
FACTORY_ADDRESS=0x72767FAD4C8254D20Fc06e4a47DFd16683AAFD0A
OPERATOR_REGISTRY_ADDRESS=0xd702E688110CB2B2503bEBc2087D984C4Ab18307
SUBVAULT_REGISTRY_ADDRESS=0x075Cd3455A5CE0f828f4D3B6B3A124313930eeE0
GOVERNANCE_ADDRESS=0xcd9B2E37D14c57362f005355757bfa6Db450C206
START_BLOCK=46111530
STATE_PATH=./data-drill/indexer-state.json
SNAPSHOT_BACKUPS=3
SNAPSHOT_BACKUP_INTERVAL_MS=20000
LOG_FORMAT=json
```

```bash
node --env-file=data-drill/drill.env packages/indexer/src/index-runner.mjs   # wait ~75s for the ring
# then RUNTIME.md 8.3 steps 1-6 against ./data-drill/
```

`data-drill/` is deliberately **not committed** — it is a scratch state directory, and the
artifacts are machine- and block-specific. Every command and every line of output it produced is
quoted verbatim above.

## 8. Gate status for this PR — and a blocker found on `protocol/main`

This PR changes **two documentation files and no code**. `npm run gate` nonetheless **fails**, for a
reason that predates it:

```
  pass             fmt        0.1s
  pass             syntax     0.3s
  FAIL             build      1.1s
  pass             opscheck   0.1s
  pass             backend    2.5s
  FAIL             test       1.1s
  FAIL             snapshot   1.1s
  FAIL             sizes      1.1s
  warn             slither    1.9s
GATE FAILED on build (9.5s)
```

**Every step that does not depend on `forge build` passes.** The four failures are the same failure:

```
Error (6275): Source "test/OracleAggregator.sol" not found
 --> test/retired/PythSource.sol:4:1
```

`contracts/test/retired/` carries three unresolvable imports after the oracle retirement moved these
files: `PythSource.sol` and `UniswapV3TwapSource.sol` import `../OracleAggregator.sol` when
`OracleAggregator.sol` is now their *sibling*, and `OracleAggregator.sol` imports
`./interfaces/IOracleAggregator.sol` when that interface stayed in `src/interfaces/`.

**This is not caused by this PR**, and the proof is mechanical — the branch's contracts tree is
byte-identical to `protocol/main`:

```bash
$ git diff --stat protocol/main..HEAD -- contracts/     # empty
$ git diff --name-only protocol/main..HEAD
docs/LAUNCH-READINESS.md
docs/NOW.md
docs/RESTORE-DRILL.md
```

Left unfixed **deliberately**, per SWARM.md §4 ("if you spot something worth fixing that is outside
your task, report it — do not fix it") and §9 (one PR per coherent change). Correcting three import
paths inside a documentation PR is exactly the merge-surface expansion those rules exist to prevent.
It is reported here, recorded in `docs/NOW.md`, and queued as its own task. **No agent can meet the
definition of done until it lands**, and CI could not have caught it — Actions minutes are exhausted
until ~2026-09-01.

## 9. Addendum 2026-09-01 — why the substitution can't be scripted away, and a Docker-free corroboration

Re-investigated with `docker` still absent from PATH in this shell at the start of the session
(`where docker.exe` → not found; `wsl --status` → WSL launcher present but no distro installed).
**State changed mid-session and is recorded precisely, because it matters for what the owner does
next:** a coordinator session was installing Docker Desktop in parallel (see [[Owner Decisions
2026-09-01]] §7 in the ops vault). By 22:17Z, `C:\Program Files\Docker\Docker\resources\bin\docker.exe`
exists and runs (**Docker Desktop 29.7.2/4.88.1, `docker compose` v5.4.0 present**), `Docker
Desktop.exe` and `com.docker.backend.exe` are running as processes — but `docker info`/`docker ps`
fail with **"Docker Desktop is unable to start"**, and `wsl --status` now reports the kernel present
but no usable distro: `wsl --install --no-distribution` was run elevated and **needs a reboot to
finish** before the engine can come up. Docker is still **not usable** as of this writing, for a
different reason than "not installed" — it is installed and one reboot away. Three follow-ups.

**1. The hard-kill substitution is a Windows platform limit, not a Git-Bash quirk — confirmed with
three more methods, none of which went through Git Bash at all.** §5 finding 1 left open whether a
different signal-delivery method would succeed where `kill` in Git Bash failed. It does not:

| Method | Result |
| --- | --- |
| Node-native `child_process.spawn` + `child.kill('SIGINT')` | Process exits; the shutdown hook's log line is never written. Silent hard kill. |
| Same, child spawned `{ detached: true }` (own process group) | Identical. |
| `taskkill /PID <pid>` **without** `/F` | Windows itself refuses: *"This process can only be terminated forcefully (with /F option)."* There is no graceful path to a bare `node.exe` for Windows to offer, even from its own tooling. |

All three isolated in a throwaway probe (not committed), same shutdown-hook shape as
`packages/oplog/src/shutdown.mjs`. Conclusion: `libuv`'s Windows signal emulation only delivers a
real signal via `GenerateConsoleCtrlEvent`, and only for a genuine interactive Ctrl-C/Ctrl-Break
keystroke landing in the *same console* as the target — never from a background/scripted sender,
which is what every automated drill (and every agent) is. `SIGTERM` is unconditionally a hard
`TerminateProcess` on Windows regardless of how it's sent. **This closes off "maybe a different
script would work": nothing scripted on native Windows can exercise steps 1/6 or §8.6's restart
path.** RUNTIME.md §8.3/§8.6 now say so and give the Linux/macOS bare-metal commands plus a
Windows note.

Two ways to get a real POSIX kernel to run this drill on, priced for the owner:
- **WSL2 alone, no Docker.** Run the indexer/canary as native Linux processes inside a WSL2 distro;
  `kill -TERM $pid` there is a real signal. Cheaper than Docker Desktop and satisfies this row's own
  "amend the runbook and re-drill with a bare-metal-equivalent stop/start" alternative
  (`docs/LAUNCH-READINESS.md` gate 7 row) without installing Docker at all.
- **Docker Desktop for Windows** (itself WSL2-backed) — runs the runbook's literal
  `docker compose stop/start`, closing the row exactly as written.

**2. Docker Desktop is already installed on this machine and is one reboot away from working —
this is closer to done than "needs Docker" suggests.** Checked directly (not inferred): `docker.exe`
at `C:\Program Files\Docker\Docker\resources\bin\docker.exe` runs and reports **version 29.7.2**
(Docker Desktop 4.88.1) with `docker compose` v5.4.0 available; `Docker Desktop.exe` and
`com.docker.backend.exe` are running processes. The engine itself refuses with **"Docker Desktop is
unable to start"** because WSL2 isn't finished installing — `wsl --install --no-distribution` was
run elevated by a coordinator session and needs a **Windows reboot** to complete, per [[Owner
Decisions 2026-09-01]] §7. Nothing here needs a fresh Docker Desktop download; the remaining steps
are: reboot → open Docker Desktop → accept its agreement → open a **new** PowerShell (existing
shells won't have `docker` on PATH) → verify → re-run steps 1/6 for real. Exact steps in
`docs/NOW.md` item 3.

**3. Drill A (indexer snapshot) re-run independently, 2 days later, Docker-free, on the current
tree** (post oracle-stack-prune; same deployment addresses — factory `0x72767FAD…FD0A`, deploy
block 46,111,530). Throwaway `./data-drill-team8/`, read-only against
`https://sepolia.base.org`, no key, no transaction.

- Cold start **46,111,530 → 46,265,978 (154,448 blocks) in ~27.0s**, then steady-state polling.
  (The chain had advanced ~125k more blocks than the 2026-08-30 run's 29,341 — consistent with the
  elapsed time.)
- Truncated the live 991-byte file to 400 bytes → `verify` reported `UNUSABLE`, exit 1, three
  healthy rungs still summarised — same behavior as §3.
- `mv` to `.bad-<epoch>`, `cp .1` in, re-`verify` → `OK`, exit 0. **Restored file SHA-256
  byte-identical to `.1`**: `03b15707aa4e9106bc5637f5a586e1bb7fb0f1e16c01c5e2092dec1163e9e75f`.
- Restarted the writer: `knownVaults:1` seeded from the restored file, resumed at
  `lastBlock+1` (46,266,024), closed the ~34-block gap in one 0.68s batch, counts identical
  before/after (vaults=1 operators=1 proposals=1 shareBooks=1 activeProposals=1 — one more
  proposal/shareBook than the original drill, reflecting gate 2's Sepolia lifecycle run that
  happened on-chain in between).

This corroborates §3 (Drill A) exactly on an independent run; it does not touch the
graceful-shutdown or atomicity questions, which item 1 above covers and which remain the actual
open condition. Drill B (canary) was not re-run — same `createShutdown`/ring/`verify` code path,
no reason to expect a different result, and it would not add evidence toward the open condition
either.

**Net: gate 7's verdict is unchanged (drill performed and PASSED; CONDITIONAL on steps 1/6).** What
changed is confidence in *why*, and how close the fix is: this is now confirmed to be a genuine,
unscriptable Windows platform limit rather than an artifact of one tool's `kill`; the Docker-free
half of the drill (everything except steps 1/6) is now independently reproduced twice; and Docker
Desktop is not a from-scratch install for the owner — it is already on this machine, one reboot
from usable.
