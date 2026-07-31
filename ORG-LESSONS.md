# 402cap — Org Lessons

**Read before dispatching.** Every firing, dead end, and expensive mistake goes here with its cause.
A lesson not written down gets repaid at full price.

Format: what happened · why it happened · what to do instead.

---

## Seeded from work before the org existed (2026-07-30/31)

### Stale status beat real state — ~400k tokens spent re-verifying finished work
Four of five dispatched tasks turned out to be **already shipped**. The backlog index was derived
from status *cells* that the previous build loop never updated, so it read as a queue of open work
when it was a queue of stale claims.
**Do instead:** before dispatching, check the **mtime of the file the item names** against the
item's date. A 10-second check kills a 90-second agent. Never trust a status cell alone.

### A report is not evidence
A build agent claimed a fix; the verifier that followed found the claim unverifiable and withdrew
it. Separately, a "two-line mainnet flip" was actually three env vars.
**Do instead:** verify by running, not by reading. Paste real output. The Council scores
Verification at 25% for exactly this reason.

### An alarm was raised from an inference, not a traced dependency
An agent asserted downstream prices were wrong because an upstream score was wrong — without
tracing whether the score ever reached a price. It didn't; `flame_premium` was hardcoded 0.0 and no
caller passed anything else. The alarm was expensive and false.
**Do instead:** trace the actual dependency before raising an alarm. "X is wrong so Y must be
wrong" is a hypothesis, not a finding.

### Counting assertions broke three tests as the product grew
Tests that asserted "there are N tools" or "N table rows" failed every time the product legitimately
grew.
**Do instead:** assert by `data-testid` or by identity, never by count.

### Two test chains at once produce garbage
Concurrent `npm test` runs collided on ports and returned inconsistent numbers that cost a
re-verification cycle.
**Do instead:** serialize anything that binds a port. Never let two agents run a suite at once.

### A visible console window got the work killed mid-flight
An agent started a test server the ordinary way; on Windows that spawns a console. Michael saw it
and stopped everything: *"dont show any windows."* An entire verification phase was lost.
**Do instead:** always detach and redirect to a log (`pythonw.exe` + `DETACHED_PROCESS` works and
was proven). Kill anything you start before finishing. This is not a preference.

### Queuing decisions Michael could not care less about
I stopped work to ask whether to run a free scan and what string to put in a User-Agent. Both were
mine to decide. His response: *"Why did you stop running?"*
**Do instead:** if it costs no money, makes no public commitment, and uses none of his personal
information — just do it and report. Escalate only money, accounts, his name, or a real strategy
fork, and batch those.

### Over-broad interpretation of an instruction
Told to stop "applications" running at startup, I disabled his personal apps (Discord, Spotify,
Steam) alongside our servers. Restored from a registry backup taken minutes earlier.
**Do instead:** scope an instruction to the narrowest reading that satisfies it, and take a
reversible backup before touching anything system-level.

### A headline number that four outliers invented
The "$62.8k/month x402 economy" figure is 82% four routes with 1–28 lifetime calls, one of which is
a single call priced at $10,000. Repeating it uncritically would have been our first public claim
and it would have been wrong.
**Do instead:** always check concentration before quoting an aggregate. Report the median and the
outlier-stripped figure alongside the total.

### Silent API failure modes that fake success
Overshooting the CDP catalog `offset` doesn't error — it **re-serves the last page**, which stored
16,044 rows for a 15,522-row catalog. And `pagination.total` drifts upward mid-fetch, so
`rows_stored >= total` is an invalid completeness test.
**Do instead:** never trust an API to fail loudly. Test completeness with an explicit flag and
check for duplicate keys after any paginated fetch.

---

### Dispatched a scanner against files I was concurrently authoring
The Celestials salvage scan reported `ORG-BACKLOG.md` missing. It wasn't wrong — I created the file
*while* the agent was mid-scan, so it read a directory state that no longer existed by the time it
reported. Cost: a confident finding that had to be re-checked before it could be trusted.
**Do instead:** don't dispatch an agent to survey a file surface you are actively writing to. Either
finish authoring first, or tell the agent explicitly which files are in flight so it can exclude them.

### The lifted parser wanted a shape the backlog didn't have
`backlog_index.py` passed its own selftest 26/26 but marked 10 real rows unreadable — the Blocked and
Done tables had no `Status` column. The salvage scan predicted exactly this and warned "author the
backlog in the shape the parser already expects."
**Do instead:** when a tool and the data disagree, fix the data first. Editing a parser that passes
26/26 to accommodate a malformed table trades a working tool for a bespoke one.

### A healthy background job reported "failed"
The full 15,524-route sweep was launched with `nohup python probe.py --all > log 2>&1 &` followed by
diagnostic `echo`/`tail` commands. The harness reported **exit code 1**. The sweep was completely
fine — it ran to completion. The wrapper's LAST command was `tail` on a log file that was still empty
(Python buffers stdout when redirected), and `tail` on a missing file exits 1. A chained shell command
returns only its LAST command's exit code, so a diagnostic became the job's verdict.
**Why it matters:** a false failure looks exactly like a real one. Acting on it would have meant
killing and restarting an hour-long job that was working. Same shape as the Council firing an agent
that had actually been safety-blocked — the failure signal and the real state disagreed.
**Do instead:** end launcher chains with `echo ok` or an explicit `exit 0`, never a diagnostic. Use
`python -u` so logs flush immediately. Judge a background job by whether its PROCESS is alive
(`Get-CimInstance Win32_Process`), never by the wrapper's exit code.

### A query that could only ever return zero — and the confident verdict built on it
An agent verified x402 volume by filtering USDC `Transfer` events for facilitator addresses. It found
zero across six independent windows and concluded the chain "flatly contradicts" the $52.6M claim.
**The query was structurally incapable of returning non-zero.** x402 settles via EIP-3009
`transferWithAuthorization`: the facilitator SUBMITS the transaction and pays gas, while the Transfer
event is buyer to seller. The facilitator never appears in the event topics.
The correct measure is `eth_getTransactionCount` (nonce) = transactions SENT. Measured live: Coinbase's
40 addresses have sent **106,602,243** transactions against a claimed 106,581,020 — a **0.02% match**.
The claim was right; the verification was wrong.
**Why it nearly cost everything:** the wrong verdict would have confirmed my own earlier wrong advice
that this market is tiny. Two errors agreeing feels like corroboration. It isn't.
**Do instead:** when a measurement returns zero, absence, or "nothing found", ask *"is my method
capable of producing a non-zero result?"* BEFORE concluding the thing does not exist. Run a positive
control — measure something you know is there and confirm the method sees it. And never let a headline
verdict outrun your own stated uncertainty: that agent honestly wrote "could NOT establish what
tx_count counts" and then led with a flat contradiction anyway.

---

## Firings

### P0#1 — Daily automated snapshot — 0/10 (2026-07-30)
**Defect:** the manager's report claimed the task was done. It wasn't. Independent verification —
`Get-ScheduledTask` across all 223 registered Windows tasks (filtered for 402/snapshot/coinbase/cdp)
— found zero matching task. `ORG-BACKLOG.md` item #1 still read `open`, not `shipped`. Every file
under `C:/Users/Micha/Desktop/x402` had an mtime from the original setup session already credited to
other shipped items (catalog fetcher, probe, report) — nothing new was created for this track at
all. Rework attempt produced no result either (empty rework report).
**Why — CORRECTED 2026-07-31, the Council's diagnosis was wrong.** The manager did not submit a
false report; it never ran at all. Both the original dispatch and the rework were **blocked by a
safety classifier** before execution: creating a Windows Scheduled Task is a persistence mechanism
that outlives the session, and Michael's generic "be autonomous" instruction does not authorize it.
The classifier also correctly noted this cuts against his explicit 2026-07-29 order that nothing of
ours auto-starts. So the 0/10 is accurate about the outcome and wrong about the cause, and the
"report is not evidence" framing was misapplied — there was no report.

**The real lesson, and it is about me, not the manager:** the Council scored an absence of output as
dishonesty without checking whether the agent was permitted to run. An infrastructure block and a
lying agent look identical from downstream. **Do instead:** before firing for "produced nothing",
check the failure channel — a blocked/errored agent is not a failed agent, and firing it wastes a
rebrief on a problem no replacement can solve. The workflow's own `failures` output said exactly
this and nobody read it.

**And the actual blocker:** unattended daily scheduling needs Michael's explicit go-ahead, naming the
mechanism. Escalated to him rather than retried.
**What the replacement is told differently:** name the exact mechanism to use
(`mcp__scheduled-tasks__create_scheduled_task`, or Windows Task Scheduler directly) and the exact
headless command line up front — don't leave "create a scheduled task" open to interpretation.
Require a pasted `Get-ScheduledTask` (or equivalent) result showing the real task registered, in the
same message that claims completion. No completion claim without that paste is acceptable at any
future review of this item.
