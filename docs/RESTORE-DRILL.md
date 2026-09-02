# Restore drill report — launch gate 7

**Date:** 2026-08-30 · **Chain:** Base Sepolia (84532) · **Tree:** `132f837e` · **Gate:** [7 — ops runbook exercised](LAUNCH-READINESS.md)

> **Correction added 2026-09-02 — read this before the verdict below.** Everything from here to §9
> is the record of the 2026-08-30 run and its 2026-09-01 corroboration, and is left exactly as it
> was written. **Its "gate 7 stays CONDITIONAL" verdict no longer describes the gate.** The
> condition it named — steps 1 and 6 run literally as `docker compose stop/start` — was met on
> **2026-09-02** in **§10** below (#139, `4619f17a`), the three runbook and Compose defects that
> re-run surfaced were fixed in **#141 (`adafdc7c`)**, and the gate row moved to **GO** in
> **#143 (`16050be0`)**. Where this
> report and [LAUNCH-READINESS.md](LAUNCH-READINESS.md) §1 disagree about gate 7's status, the gate
> row wins; this report is evidence, not the verdict. Note also that §10.1 records **2 of 6 steps
> literal** for that run, for the opposite reason — steps 2–5 name host paths that do not exist
> under the Compose deployment, which is finding 6. That is a statement about that run, not a
> reopening of the gate.

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

---

## 10. Re-drill 2026-09-02 — Docker present, steps 1 and 6 run LITERALLY

**Date:** 2026-09-02 · **Chain:** Base Sepolia (84532) · **Base:** `bab5ee90` (`protocol/main`) ·
**Engine:** Docker Desktop 4.88.1, server 29.7.2, **OSType `linux`**, driver overlayfs, Compose
v5.4.0 · **Gate:** [7 — ops runbook exercised](LAUNCH-READINESS.md)

The condition §9 named is met: a real POSIX kernel is available. This re-drill runs the procedure
in [`RUNTIME.md` §8.3](RUNTIME.md) with **steps 1 and 6 as the literal `docker compose stop/start`
the runbook prints**, and then closes four of the five items §6 listed as untested.

> **Steps 1 and 6 were literal this time.** `docker compose -p gate7drill stop indexer` and
> `docker compose -p gate7drill start indexer`, against the real Compose stack built from this
> repo's `Dockerfile` and `docker-compose.yml`. The `-p` flag scopes the project to a throwaway
> volume so a concurrent session's state could not be touched; it changes the project *name*, not
> stop/start semantics, so the step is literal for the purposes of this row.

**All six steps ran against the shipped Compose stack — `indexer`, `api` and `canary` all three
up.** The API was running as a live reader throughout, which §6 listed as never having been
observed.

| Drill | Verdict | The one-line result |
| --- | --- | --- |
| A — indexer, steps 1/6 literal | **PASS** | live file truncated → restored from the **15-minute-aged `.3`** rung byte-identically → `docker compose start` resumed with `knownVaults:3` **from the restored file**, closed a **452-block** rewind in one 0.68s batch, counts identical |
| B — canary, steps 1/6 literal | **PASS** | restored from its aged `.3` → reloaded **48 tracked signals**, **zero re-pages** for the 6 standing not-OK signals |
| C — atomicity under a kill **during a write** | **PROVEN** | 6 SIGKILLs landed *inside* the write window by construction; live snapshot parsed **OK all 6 times**. See §10.3 |
| D — production-scale restore | **PASS** | **59,855,231 bytes / 7 vaults / 1,050,000 holders** restored byte-identically; daemon reseeded `knownVaults:7` |
| E — off-host volume tar | **PASS on the corrected command; the printed one is broken** | see finding 8 |
| F — graceful shutdown | **FAILS — new blocking defect** | `docker compose stop` never runs the shutdown hooks. See finding 7 |

**Gate 7 assessment: the restore path is now proven far past what the row asked for, but this
drill found a defect that did not exist on the record before, and it is in the runbook's own
promises rather than in the restore.** The row's *stated* condition ("re-run steps 1/6 under
Compose") **is met**. Four of the five §6 gaps are closed. But running literally surfaced three
places where the printed procedure does not do what it says (findings 6, 7, 8), one of which —
graceful shutdown — is contradicted for **all three services**. Recommendation in §10.6.

### 10.1 Step-by-step: literal or substituted

| Step | Runbook text | Literal? | Measured result |
| --- | --- | --- | --- |
| 1 | `docker compose stop indexer` | **LITERAL** | returned in **1.10s** (grace period 45s never approached). **No `shutdown.complete`** — see finding 7 |
| 2 | `node …/index-runner.mjs verify ./data/indexer-state.json` | **SUBSTITUTED — the printed form is broken under Docker** | run inside a one-off container against `/data/…`. See finding 6 |
| 3 | `mv … .bad-$(date +%s)` | **SUBSTITUTED** (same reason — container-side path) | bad file preserved; did **not** consume a ring slot |
| 4 | `cp ./data/indexer-state.json.1 …` | **SUBSTITUTED** (same reason), **and deliberately took `.3`, not `.1`** | restored file **sha256-identical** to the rung: `b1a9f75e9d197b433fe7bfeefc4ef994d880700c1fdcd82596ba9c286b02730d` |
| 5 | `verify` the restored file | **SUBSTITUTED** (same reason) | `OK`, exit 0, cursor `lastBlock=46303007` |
| 6 | `docker compose start indexer` | **LITERAL** | returned in **0.59s**; `resumed at block 46303007 (3 vaults)` |

So: **2 of 6 literal, 4 substituted — but the substitution is the opposite of last time.** In
2026-08-30 steps 1/6 were impossible and 2–5 ran as printed. Here steps 1/6 ran exactly as
printed and **2–5 could not**, because the paths they name do not exist on the host under the
Docker deployment the same document prescribes. That is finding 6, and it is new.

### 10.2 Drill A — the aged rung, at the full documented horizon

Ring left at **production defaults** this time (`SNAPSHOT_BACKUPS=3`,
`SNAPSHOT_BACKUP_INTERVAL_MS=300000`) and allowed to run 20 minutes, so `.3` reached the
documented 15-minute horizon instead of the 2026-08-30 run's 81 seconds:

```
indexer-state.json     18:53:37   lastBlock=46303459
indexer-state.json.1   18:48:52   lastBlock=46303309
indexer-state.json.2   18:43:51   lastBlock=46303160
indexer-state.json.3   18:38:46   lastBlock=46303007   <- restored from THIS
```

`.3` was **14m50s old** when the writer was stopped and **16m17s old** when it was copied into
place. Truncating the live file to 900 bytes gave `UNUSABLE — Unterminated string in JSON at
position 900`, exit **1**, with all three healthy rungs still summarised.

After the literal `docker compose start indexer`:

```
{"event":"indexer.progress","msg":"resumed at block 46303007 (3 vaults)"}
{"event":"starting","knownVaults":3,"resumeBlock":46303008,"backups":3}
{"event":"indexer.progress","msg":"indexed [46303008..46303507] — 0 events, now at 46303507"}
```

`knownVaults:3` seeded **from the restored file** — the load-bearing line. **452 blocks (~15
minutes of chain) rewound and closed in a single 0.68s batch**, well inside one `BATCH_BLOCKS`
window. Counts identical across the whole exercise: `vaults=3 operators=1 proposals=4
shareBooks=3 holders=2 activeProposals=2 adapters=1`. **Stop → caught up: 87.3s**, nearly all of
it the operator running steps 2–5.

**The API was watching, which §6 said had never been tested.** During the outage
`vault_api_snapshot_reload_failures_total` climbed 0 → 2 → 4 → 6 while
`vault_indexer_last_block` **stayed frozen at the last good value** and `/vaults` kept answering
(HTTP 402, i.e. alive and challenging normally). After the restore the counter stopped climbing
and `last_block` advanced to 46303520. **§8.3's stale-serving claim holds under a real reader**,
and the copy-not-rename discipline never left the reader without a file.

### 10.3 Drill C — a kill *during* a write. This is the §6 item that was open.

The 2026-08-30 drill could not answer this: its kill landed 2.4s after a completed write. The
window was **measured** first rather than guessed. With a 59.8MB snapshot being rewritten
back-to-back, a tight sampling loop found `indexer-state.json.tmp` present in **515 of 63,557
samples = 0.81% of wall time** (~6ms per write). That is why randomly-timed kills miss: roughly
1 in 123.

Two design corrections were needed, and both are worth recording because they invalidate the
obvious approach:

1. **`docker kill` does not hit the writer.** PID 1 under `npm run start:indexer` is **npm**;
   node is a grandchild. A signal to PID 1 lets the real writer run on. The probe therefore ran
   node **as PID 1**.
2. **Random timing cannot land a 6ms window.** Instead the container was **frozen**
   (`docker pause`, cgroup freezer) at randomised instants and inspected while frozen. A `.tmp`
   present at the freeze proves the process is between `writeFile()` and `rename()`; SIGKILL
   there is a kill inside the write window *by construction*. A frozen-then-killed process leaves
   exactly the on-disk state a crash at that instant leaves.

```
SUMMARY freezes=601 kills_landed_in_write_window=6 live_OK_after=6 live_CORRUPT_after=0
        zero_length_rung=0 mid_rotation_freezes=26
```

The six landings caught the temp file at **14.2 MB, 18.3 MB, 28.3 MB, 33.0 MB, 57.7 MB and
59.77 MB** of 59,855,231 — the largest **99.86% written, immediately before the rename**, the
smallest less than a quarter in. In every case the
live snapshot afterwards was `OK`, and the partial data was stranded in the `.tmp` where it
belongs. **Atomicity of `atomicWriteFile` is proven under a kill in flight**, which §6 explicitly
left open.

**Still NOT proven: the ring rotation under a crash.** `rotateBackups` is *not* atomic
(`rm .3`, `rename .2→.3`, `rename .1→.2`, `copyFile live→.1`) and its window is much wider — the
probe observed it in **26 of 601 freezes (4.3%)** — but the probe only triggered its kill on the
`.tmp` signature, so **no kill was ever landed inside a rotation**. The window is measured; the
behaviour is not tested. Stated plainly rather than inferred from the `.tmp` result.

### 10.4 Drill D — production scale

§6 asked for materially more than 630 bytes / 1 vault. Built by scaling the **real chain-derived
snapshot** — the vault and operator records are verbatim copies of the ones the live indexer
folded from Base Sepolia; only the addresses and the holder book are synthetic — and
round-tripped through the indexer's **own** `deserializeState`/`serializeState`, so what landed on
disk is what the real writer produces, not hand-authored JSON.

**59,855,231 bytes · 7 vaults · 1,050,000 holders** (the 2026-08-30 drill: 630 bytes, 1 vault):

- `verify` parsed the live file **and all three 59.8MB rungs in 2.67s**, counts exact.
- Truncated to 5,000,000 bytes → `UNUSABLE`; `mv` to `.bad-`; `cp .1` in → **sha256-identical**
  (`d3a9b436ce3299fe150705fea799debd1d644e510f0fab8815416f916e870916`).
- Restarted → `resumed at block 46111530 (7 vaults)`, `knownVaults:7` seeded from the restored
  file, 13 batches indexed.

**Scoped honestly:** this proves parse, fold, seed and restore at scale. The vault addresses are
synthetic, so it does **not** prove anything about chain behaviour at 7 real vaults.

### 10.5 Findings (continuing §5's numbering)

**6. Steps 2–5 name host paths that do not exist under the Docker deployment the same procedure
prescribes — and the failure is dangerously misleading.** Steps 1 and 6 are container commands;
steps 2–5 are host commands against `./data/indexer-state.json`. Under Compose that state lives
in the **named volume**, so there is no `./data` on the host at all. Run exactly as printed while
the stack was healthy, step 2 said:

```
snapshot ./data/indexer-state.json: UNUSABLE — no snapshot at ./data/indexer-state.json — a fresh indexer would start from START_BLOCK
  backups     none on disk (SNAPSHOT_BACKUPS=0, or none taken yet)
EXIT=1
```

Both the live file and a **healthy 3-rung ring** were sitting safely in the volume at that moment.
An operator following the runbook verbatim under incident pressure is told their snapshot is gone
and their ring is empty, and is pointed at the "if every backup is bad, rebuild from
`START_BLOCK`" path — a multi-hour re-index — when nothing was actually wrong. This is the
highest-severity documentation defect the drill found. **Fix: give steps 2–5 their container
forms** (`docker compose exec` / a one-off `docker run` against `/data/…`), as steps 1 and 6
already assume.

**7. `docker compose stop` never runs any shutdown hook, for any of the three services.** This is
a code/config defect, not a documentation one, and it is new. `docker-compose.yml` sets
`command: npm run start:indexer`, so **PID 1 is npm**; npm receives SIGTERM, dies with
`npm error signal SIGTERM`, and **does not forward the signal** to the node child. A/B on the
same image, same volume, same signal, same 45s grace:

| PID 1 | `docker stop -t 45` took | Shutdown lines |
| --- | --- | --- |
| `npm run start:indexer` (**what ships**) | 917 ms | none — only `npm error signal SIGTERM` |
| `node packages/indexer/src/index-runner.mjs` | 427 ms | `shutdown.begin` → `shutdown.step indexer.finish-batch-and-snapshot ok:true` → `shutdown.complete` |

The hooks are **correct code that is never reached**. Consequences, all confirmed on the live
stack:

- The indexer does **not** finish its batch or take a final snapshot on stop. The ring was
  **not** pushed along by one — §5 finding 3's untested note about a clean shutdown is now
  testable and, as shipped, **does not happen**.
- `stop_grace_period` (indexer 45s, api 30s, canary 60s) is **dead configuration**. Every stop
  returned in ~1s.
- The canary's `canary.flush-transitions` hook never runs (`docker compose stop canary`: 1.11s,
  zero `shutdown.complete`). Bounded, though: `flush()` also runs after **every** sweep, so at
  most one 30s sweep of transitions is lost — not the full re-page storm the hook exists to
  prevent.
- The API never drains in-flight responses.

This also revises §5 finding 2 / §9 item 1. Their conclusion — the hooks are fine and merely
unreachable **on Windows** — was half right. They are unreachable **under Docker on Linux too**,
for an unrelated reason. **Fix: run the process directly** (`command: ["node", "packages/…"]`) or
add an init that forwards signals.

**8. The off-host volume backup command backs up nothing, and exits 0.** RUNTIME.md §8.3 prints a
`docker run --rm -v vault-state:/data … alpine tar czf …` one-liner. Compose namespaces volumes as
`<project>_<volume>`, and the project name defaults to the directory name — here
`x402-gate7_vault-state`, never the bare `vault-state`. Docker happily **creates a new empty
volume** with that name and tars it. Run verbatim, it produced an **87-byte archive containing one
entry, `./`**, and **exit 0**. A backup that silently succeeds and contains nothing is worse than
one that fails.

Corrected to the real volume name, the command works and — tested beyond what the runbook asks —
**is genuinely restorable**: the archive captured the live file, all three indexer rungs, both
canary rungs and the heartbeats; extracted into a **fresh volume**, `verify` reported the indexer
snapshot `OK` (exit 0, ring intact) and the canary state `OK` (exit 0, 48 signals). Taken while
all three services were running, it was consistent — no `.tmp` was captured. **Fix: print the
`<project>_vault-state` name, or `docker volume ls` to find it.**

**9. `verify` OOMs on a very large snapshot under a small memory cap.** At 59.8MB, the shipped
command works on an unconstrained host but dies under `-m 512m` with
`FATAL ERROR: Ineffective mark-compacts near heap limit`. It parses the live file **plus all
three rungs**, so peak heap is roughly four copies. **Bounded honestly:** at §8.3's own documented
scale (7 vaults / 64 holders, and the 30.7KB equivalent here) it is fine under the same 512MB
cap. This is a headroom note for a far-future deployment size, not a launch issue.

**10. The indexer puts every known vault into one `eth_getLogs` filter, and it does not scale.**
Surfaced by the scale work: with 200 known vaults the public RPC rejected every poll with
`Invalid parameters were provided to the RPC method`, and the indexer **never advanced and never
wrote a snapshot** — a permanent `poll.failed` loop, not a degraded mode. At 7 vaults it is fine.
Not a restore finding and out of scope here, but it is a hard ceiling on vault count that should
be its own issue. **Checked against current `protocol/main` (`0c196581`, after #120):** that PR
adds `MAX_TRACKED_ADAPTERS` to bound the discovered *adapter* set, but the *vault* set feeding the
same filter (`rpc.mjs`, `const vaults = new Set([...knownVaults]…)`) is still unbounded, so this
finding stands on the current tree.

**11. A crash leaves an orphaned `.tmp` that nothing ever cleans up.** Each of the six landed
kills left a `<state>.tmp` of up to 59.77MB behind. Nothing removes it on the next start. It does
**not** corrupt anything or consume a ring slot (`listBackups` walks `.1..N` only), so this is
hygiene, not correctness — but on a real snapshot size it is a silent disk leak after every crash.

**12. `docker compose up` partially succeeded on a port collision.** With something already bound
to `:8402`, `up -d` started `indexer` and `canary`, then failed on `api` — leaving a half-up stack
and a non-zero exit. Worth an operator note; not a restore defect.

### 10.6 What is proven, what is not, and what was not attempted

**Proven by this drill (new):**
- Steps 1 and 6 run **literally** under Compose on a real Linux engine — the row's stated condition.
- Restore from a **15-minute-aged rung** at the documented production horizon (`.3`, 14m50s at stop).
- Restore at **production scale** — 59.8MB, 7 vaults, 1,050,000 holders, byte-identical, reseeded.
- **Atomicity under a kill in flight** — 6 SIGKILLs inside the write window, 6/6 live files `OK`.
- The **off-host tar is restorable** into a fresh volume (with the corrected volume name).
- The **API's behaviour during the outage** — stale-serving, failure counter climbing, still serving.
- The canary restore at **48 signals** with zero re-pages (2026-08-30 proved it at 8).

**NOT proven:**
- **Graceful shutdown — and now known to be broken as shipped** (finding 7). This is the one §6
  item that got *worse*, not better: it is no longer "untested", it is **tested and failing**.
- **Ring rotation under a crash.** Window measured (4.3% of wall time); no kill was landed in it.
- **Correctness of the projection.** `verify` is still only a parseability check; a wrongly-folded
  state verifies clean. Unchanged from §6.
- Anything adversarial. Unchanged.

**Not attempted:**
- The "every backup is bad" rebuild-from-`START_BLOCK` path (beyond incidental cold starts).
- `docker compose down`/`restart` as distinct from `stop`/`start`.
- Any mainnet or non-Sepolia behaviour.

### 10.7 Discipline

Read-only against Base Sepolia via `https://base-sepolia-rpc.publicnode.com`: **no key, no funded
account, no `--broadcast`, no transaction**. All state lived in throwaway Compose volumes under
`-p gate7drill` / `-p gate7kill`, never the repo's `./data/`, and every volume and container was
destroyed afterwards. `.env` and `drill-scratch/` are untracked scratch. **No tracked file was
modified to make this drill pass** — `git status` after the drill showed only untracked
`drill-scratch/`. The only tracked change in this PR is this section.

**On the gate 7 row itself: this report does not change it.** Changing a gate verdict is the
owner's call. What this drill hands over is: the row's stated condition is met, four of five §6
gaps are closed, and three defects in the runbook and Compose config (findings 6, 7, 8) are open
and are the honest reason not to turn the row green on this evidence alone. Fixing those three is
documentation and one `command:` line; the restore mechanics underneath them are now proven more
thoroughly than the row ever asked for, so a re-drill should not be needed to close it afterwards.
