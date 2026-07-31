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

---

## Firings

*(none yet — append one row per fired agent: tier, task, score, the specific defect, and what the
replacement was told differently)*
