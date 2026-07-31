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

### A headline verdict that only cleared one bar of two
Chain's dollar-value extrapolation ($0.55M–$2.98M) was built the right way — positive control first,
100% selector-confirmed as genuine settlements — but sampled only one ~200-second window with n=150.
The charter's "every headline number needs an independent second method" rule was satisfied for the
*tx-count* claim (nonce vs x402scan, 0.02% match) and for Intel's *coverage* claim (two disjoint
windows) but not for this one. Nobody caught it before scoring because the report itself explicitly
withheld the number from being called final — so the gap cost 1.7 points, not a false claim.
**Do instead:** treat "single window, single method" as a checklist item on every dollar-figure
report, the same way "ran a positive control" already is. A department that discloses its own gap
should still be told the gap up front in the brief, not discovered at review.

### An orphaned process flagged by one department, gone by the next check
Intel's report flagged Chain's `onchain_verify_values.py` still running at audit time as a live/
possibly-orphaned process, worth escalating but not counted against Intel's own score. By the next
cycle's process check, it was gone — Chain's own cleanup step caught it before the Secretary needed
to intervene. **Do instead:** a flagged live process from a peer department is real signal but has a
short shelf life; re-check before acting on it rather than assuming it's still true.

### COUNCIL AUDIT #1 (sprint 3) — Council PASSED; the harvest did not
Per the new charter rule, I audited the Council rather than taking its verdicts on trust.
**Council: passed all five checks.** It did not grade the Product report's confidence — it re-ran
`h.count('badge badge-warn')` itself and found 726 spans against a 721 headline. I independently
reproduced that exact count before approving the firing. Scores were defensible from the defects
listed, and `blocked_or_errored` was set correctly. This is what the gate is supposed to do.
**The harvest step failed instead:** it reported Backlog #1 (daily snapshot) as "still not started,
needs Michael's go-ahead" when Michael had already approved it (*"Yes make it a routine/scheduled"*)
and the task was registered and enabled — confirmed live via `list_scheduled_tasks`
(`x402-daily-snapshot`, cron `0 3 * * *`, nextRunAt 2026-07-31T08:07:57Z). It read a stale backlog cell
instead of checking the live system.
**Why it matters:** this is the SAME failure already logged at the top of this file — "stale status beat
real state" — and it would have wasted a whole sprint re-doing shipped work, plus put a fake decision
in front of Michael.
**Do instead:** the harvest must verify status against the LIVE SYSTEM, not the backlog cell. For a
scheduled task, call `list_scheduled_tasks`. For a file, stat it. For a DB change, query it. A backlog
cell is a claim about the world, never the world.

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

---

## Cycle 3 additions (2026-07-31)

### Median × count is not a valid total for a skewed distribution — it looks like a conservative lower bound and isn't
Chain's second-method extrapolation table (Backlog #15) presented 6 basis rows for a 30-day dollar
estimate, 3 of them computed as `median(per-tx value) × transaction count`. In a right-skewed
distribution (this one: max $8.00 vs. median $0.017149, n=573) that computation isn't a lower bound
on total volume, it's simply wrong — it discards exactly the tail mass that the true total is made
of, and does so silently, with no flag distinguishing it from the mean-based rows next to it. The
manager's stated headline range ($24K–$394K) inherited this invalid low end untagged.
**Do instead:** for any `statistic × count` extrapolation, name which statistic and check the skew
first. Only `mean × count` recovers total volume in expectation; `median × count` recovers something
else (a typical-transaction floor) that must never be relabeled as a total. If both are shown, the
median-based row needs its own caption saying what it actually estimates.

### A prior lesson was in the file and still wasn't applied
The same report also ran a concentration-undisclosed mean (top 2 of 573 txs = 47.7% of window
dollar value) as a plain aggregate, the exact failure `ORG-LESSONS.md` already documents above
("always check concentration before quoting an aggregate... report the outlier-stripped figure
alongside the total") from an earlier firing. It was the single most relevant existing lesson to
this task and was not checked before shipping.
**Do instead:** before any report touching an aggregate/extrapolated dollar figure ships, the
manager greps this file for "concentration" and "aggregate" and confirms the check was actually
run — not just that the department is generally aware the lesson exists.

### A stat can be fixed and the same bug can still be on the page — check the render path, not just the number that changed
Product's Backlog #16 fix patched the headline count (`n_mismatch`, 726→721) but the per-row badge
render (`mismatch_badge(r['price_mismatch'])`, `build_site.py:370`) had no `is_templated` guard —
unlike `alive_badge` on the very next line, which did. The regenerated table still emitted 726
badge-warn spans under a headline that said 721: the exact contradiction the item existed to kill,
now one scroll down instead of gone. The report's own proof only grepped for the headline string and
the new disclosure text; it never grepped the thing the bug was about (badge count in the table body).
**Do instead:** when a fix statement is "count X now excludes Y", grep for the *artifact that renders
X* end-to-end (every place it's produced, not just the one place that was edited) before claiming
done. A one-line `.count()` on the actual rendered output would have caught this in seconds — it did,
this cycle, on review.

### PRODUCT — Backlog #16, price-mismatch contradiction — 4/10 (2026-07-31, sprint 3)
**Firing APPROVED by the orchestrator.** Failure channel checked first: the agent was not blocked and
did not error — it ran, and shipped a fix that does not fix the thing.
**Defect:** it patched the headline stat to 721 but left the per-row render unguarded, so the table
beneath still emits 726 `badge badge-warn` spans. The contradiction Backlog #16 existed to eliminate
was **relocated, not removed** — now living on the same page, one scroll apart. Independently
reproduced by both the Council and me.
**Root cause:** it verified the number it changed instead of the artefact it was changing. Its proof
grepped for `<span class="n">721</span>` and stopped. One `count('badge badge-warn')` would have caught
it — the Council ran exactly that.
**What the replacement is told differently:** `mismatch_badge()` must take `is_templated` and return ""
for templated rows, mirroring `alive_badge`'s existing signature at the very next line; same fix for the
detail-page description text; and no completion claim is acceptable without pasting a
`count('badge badge-warn')` equal to 721.
**Generalised into a rule:** when fixing a COUNT, grep the render path and count the rendered artefacts.
Never trust that changing the number that gets printed changed everything that gets printed.
