# Backlog #9 — churn signal validation (snapshot 6 -> 7/8 drop of 729)

**Verdict: NOT real churn. This is a CDP catalog fetch artifact. Dead-pool dataset NOT built — validation failed the "meaningful fraction still alive" gate, per task instructions to stop there.**

## What was observed (confirmed live, restated honestly)
- `catalog_snapshot` id=6 (2026-07-31 03:07 UTC, source='cdp', is_complete=1): 15,524 `catalog_resource` rows.
- Snapshots 7 and 8 (both 2026-07-31 08:27 UTC, 46s apart): 14,795 rows each.
- `change_event` for from_snapshot=6, to_snapshot=7: 783 `disappeared`, 54 `listed` -> net -729 (matches the row-count delta exactly).
- Direct set diff (`resource_url` in snapshot 6 not in snapshot 7): **783**, exactly matching the `change_event` count. So the 729 net figure is `783 disappeared - 54 listed`, not 729 independent deaths.
- This is **one** churn observation (6->7). The 7->8 gap has only 1 `metadata_change` event — no second churn event exists to corroborate a rate.

## Validation method
- Sampled 30 of the 783 `disappeared` routes, host-diverse (round-robin by host, seed=42) — 30 distinct hosts, no host repeated.
- Ran a fresh unpaid probe against each: reused `probe.py`'s exact request pattern — declared method (GET/POST/etc.), `content=None`, same `USER_AGENT` string, 15s timeout, 3 max redirects, one request per route, 1.5s pacing between requests (all hosts distinct here so pacing was moot but kept for citizenship).
- Script: `C:\Users\Micha\AppData\Local\Temp\claude\...\scratchpad\validate_churn.py`; sample + raw results: `dead_sample.json`, `dead_sample_results.json` (same scratchpad dir).

## Result
```
TOTAL=30  still_402=29  responded_other_status=0  transport_dead=1
```
- **29/30 (96.7%)** of routes CDP's catalog says "disappeared" between snapshot 6 and 7 answered a fresh unpaid probe with a valid 402 challenge (`has_payment_required_header=1`, status 402) just hours later.
- Only 1/30 (`oussapi.duckdns.org`) timed out — a single transport failure, not evidence of a broader die-off, and consistent with ordinary flakiness rather than a host actually gone.
- Full list of the 30 hosts probed and their live status is in `dead_sample_results.json`.

## Conclusion
The "not real churn" verdict is solid on its own terms: 29/30 sampled "disappeared" routes answered a fresh unpaid probe with a valid 402 hours later, which directly rules out real operator die-off for this sample regardless of mechanism.

**Correction added 2026-07-31 (recording review):** this note originally attributed the cause to CDP's documented `offset`/`pagination.total` drift bug. That attribution was checked live and is refuted: `catalog_snapshot` id=7 has `total_reported=14795` and `rows_stored=14795` — exactly equal, no drift, no overshoot. The known pagination bug's fingerprint is MORE stored rows than the real total (re-serving the last page inflates the count); this event is a decrease (15,524→14,795), the wrong direction for that theory. The real mechanism for the swing is NOT established — do not cite the pagination bug as the cause going forward. Filed as Backlog #21 (defensive-pagination re-run needed to actually test candidate causes).

Per the task's explicit stop condition ("if a meaningful fraction still respond with a valid 402 or 200 ... report that finding plainly and stop there"), **no dead-pool dataset, no `notes-dead-pool.md`, and no query-ready churn table were built.** Building one on this signal would launch a false "graveyard" narrative on a fetch artifact.

## What would make this defensible
- A `fetch_catalog.py` run that paginates defensively (recording `pagination.total` at every page, refusing to trust it if it changes mid-fetch) to rule out the pagination bug directly at the source, OR
- Repeated day-over-day snapshots (this org needs >=2 independent real-day observations before any rate claim, per the honesty constraint already in the task) with the SAME 729+ routes staying gone and failing a fresh probe across multiple days.

## What was NOT done (deliberately)
- No `notes-dead-pool.md` / dead-pool table — gate failed, per instructions.
- No claim of a "729/day" or any churn rate — explicitly avoided; this is one observation.
- Did not re-run `fetch_catalog.py` to reproduce the pagination bug directly (out of scope for this validation pass; flagged above as the next real fix).
