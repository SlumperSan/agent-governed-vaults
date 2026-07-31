# Source-partition change_event and resource_dim (Backlog #18) — 2026-07-31

Continuation of `notes-source-migration.md` (Phase 2, which added `source` to
`catalog_snapshot`/`catalog_resource`). Backlog #18 was surfaced by that work:
`change_event` and `resource_dim` were left out and needed the same column
before Backlog #12 (non-CDP ingestion) can land safely.

## Before / after schema

Verified live via `PRAGMA table_info`, not assumed from a backlog cell.

**Before** (confirmed on prod before this migration ran):
```
change_event: id, detected_at, from_snapshot, to_snapshot, resource_url, host,
               event_type, field, old_value, new_value, delta_num, ratio_num
resource_dim: resource_url, host, first_seen_snapshot, first_seen_at,
              last_seen_snapshot, last_seen_at, times_seen
```

**After** (confirmed on prod after this migration ran):
```
change_event: ... same 12 columns ..., source TEXT NOT NULL DEFAULT 'cdp'
resource_dim: ... same 7 columns ...,  source TEXT NOT NULL DEFAULT 'cdp'
```

## What shipped

- Two new entries in `x402_common.py`'s `MIGRATIONS` list, mirroring the exact
  idiom already used for `catalog_snapshot.source` / `catalog_resource.source`:
  `("change_event", "source", "TEXT NOT NULL DEFAULT 'cdp'")` and
  `("resource_dim", "source", "TEXT NOT NULL DEFAULT 'cdp'")`. Additive
  `ALTER TABLE ADD COLUMN`, applied automatically on the next `connect()`.
  `DEFAULT 'cdp'` is not a backfill guess — every row in both tables today came
  from exactly one facilitator, so it is the true value.
- **Found and fixed a real break this migration would otherwise have caused**:
  `fetch_catalog.py::rebuild_resource_dim()` did
  `INSERT INTO resource_dim SELECT <7 values>` with **no column list** — a
  positional insert that requires the SELECT to produce exactly as many
  columns as the table has. Reproduced the failure on a scratch copy BEFORE
  fixing it: `sqlite3.OperationalError: table resource_dim has 8 columns but 7
  values were supplied`. Fixed by adding the explicit column list
  `(resource_url, host, first_seen_snapshot, first_seen_at, last_seen_snapshot,
  last_seen_at, times_seen)` to the INSERT, so `source` takes its DEFAULT and
  every other statement is untouched. Re-ran against the scratch copy after
  the fix: 15,524 rows before rebuild, 15,524 after, `source='cdp'` on all of
  them, no error.
- `change_event`'s INSERT in `diff_snapshots()` already used an explicit named
  column list (`INSERT INTO change_event (detected_at, from_snapshot, ...)`),
  so it needed no code change — the new `source` column is simply not in that
  list and takes its DEFAULT. Verified by re-running `diff_snapshots()` on the
  scratch copy against real snapshot data: ran clean, same event counts as
  before migration, `source='cdp'` on the resulting rows.
- Grepped the full codebase (`x402_common.py`, `fetch_catalog.py`, `report.py`,
  `build_site.py`, `api/*.py`) for every reference to `change_event` /
  `resource_dim`. Only `fetch_catalog.py` (writer) and `report.py` (reader)
  touch these tables at all. Every `report.py` query uses an explicit column
  list or `COUNT(*)` — none does `SELECT *` against either table, so none is
  affected by the new column.

## Verification

1. **Baseline**: confirmed live (pre-migration) schema on prod via
   `PRAGMA table_info` — no `source` column on either table (see "Before"
   above). Captured `report.py`'s full stdout on prod pre-migration
   (`report_before.txt`, 243 lines) using `git stash` to run the OLD
   `x402_common.py`/`fetch_catalog.py` against the real prod DB, so the
   "before" state is genuinely unmigrated code against genuinely unmigrated
   schema, not a copy.
2. **Applied migration to prod**: `git stash pop` to restore the new code,
   then called `x402_common.connect()` against the real prod DB path. Took
   **0.0114s** (ALTER TABLE ADD COLUMN with a constant DEFAULT is
   metadata-only in SQLite — timed, not asserted). `PRAGMA integrity_check` =
   `ok` immediately after.
3. **Idempotency**: called `connect()` a second time directly on prod — no
   error, **0.0055s**, `PRAGMA integrity_check` = `ok` again.
4. **report.py before/after diff**: ran `report.py` against prod again
   (post-migration) and `diff`'d byte-for-byte against the pre-migration
   capture from step 1. **Identical, zero-line diff.** Confirms no crash and
   no behavior change for existing single-source ('cdp') data.
5. **Positive control for the positional-insert fix**: reproduced the break
   on a scratch copy of prod BEFORE fixing `rebuild_resource_dim()` (see
   above — real `OperationalError`, not a hypothetical), then re-ran the
   fixed version on the same scratch copy and confirmed it now succeeds with
   identical row counts.
6. **`diff_snapshots()` sanity run**: re-ran on the scratch copy against the
   two most recent complete snapshots (2 and 6) — `no changes` (correct, no
   real catalog change between them), no crash, `source` column present and
   `'cdp'` on all `change_event` rows.

## What was and wasn't touched — read this before ingesting a second source

**Done:**
- `change_event.source` and `resource_dim.source` columns exist, default
  `'cdp'`, additive, zero behavior change for existing data.
- The one place that would have silently broken on the next run
  (`rebuild_resource_dim`'s positional INSERT) is fixed.

**Deliberately NOT done** (same discipline as `notes-source-migration.md`'s
"what I deliberately did not do" section — stated plainly, not hidden):

- **`resource_dim.resource_url` is still the sole PRIMARY KEY.** It is NOT
  `(source, resource_url)`. `rebuild_resource_dim()`'s `GROUP BY resource_url`
  is also unchanged. Today this is unobservable (one source). The moment a
  second source's rows land in `catalog_resource`, `rebuild_resource_dim()`
  will silently `MAX(host)`-collapse and single-row two different
  facilitators' observations of the same `resource_url` string into one
  `resource_dim` row, and `first_seen`/`last_seen` will reflect whichever
  source's snapshot IDs happen to sort first/last — not "first seen per
  source." **This is the exact failure mode Backlog #18 named, and it is not
  closed by this ticket.** It requires: (a) changing the PRIMARY KEY to
  `(source, resource_url)`, (b) adding `cr.source` to the `GROUP BY` and to
  the `SELECT`/`INSERT` column list in `rebuild_resource_dim()`.
- **`diff_snapshots()` still does not partition by source.** `load(sid)`
  loads every row for a `snapshot_id` keyed by `resource_url` only. If a
  future snapshot ever mixed sources within one `snapshot_id` (it doesn't
  today — one source per fetch run), or if the "previous complete snapshot"
  query (`WHERE id < ? AND is_complete = 1 ORDER BY id DESC LIMIT 1`) is ever
  asked to diff across sources, it would compare CDP's version of a URL
  against a different facilitator's version of the same URL string and emit
  fabricated `price_change`/`listed`/`disappeared` events. Today this cannot
  happen because every snapshot is single-source by construction (one
  `catalog_snapshot.source` value per fetch run) — but nothing in
  `diff_snapshots()` itself enforces or checks that invariant.
- **No non-CDP ingestion code was written.** That is Backlog #12, out of
  scope for a schema migration.
- **No new index was added** on `change_event.source` or `resource_dim.source`
  — the task scope (and the live backlog cell) asked only for the column, and
  neither table has an existing access pattern that filters by source yet
  (unlike `catalog_resource(source, host)`, which backs a real query pattern
  documented in `notes-source-migration.md`). Left for whoever adds the
  source-partitioned queries.

**Bottom line for whoever builds #12 next**: adding a second source's rows to
`catalog_resource` today is schema-safe (columns exist, no crash) but is
**not yet diff-safe or dimension-safe**. `resource_dim` and `change_event`'s
*data model* still assumes one source. Do the PRIMARY KEY / GROUP BY /
`load()`-keying work above before the first non-CDP fetch run, or accept that
`rebuild_resource_dim()` and `diff_snapshots()` will produce cross-source
noise exactly as ORG-BACKLOG #18 predicted.

## Files

- `x402_common.py` — two new `MIGRATIONS` entries.
- `fetch_catalog.py` — `rebuild_resource_dim()`'s INSERT given an explicit
  column list (bug fix, not a design change).
- Prod backup: `C:\Users\Micha\Desktop\x402\x402_index.db.bak-2026-07-31-sourcepart2`
  (302,563,328 bytes, verified `git check-ignore` passes).
- Scratch verification: `scratch_test.db`, `report_before.txt`,
  `report_after.txt` under
  `C:\Users\Micha\AppData\Local\Temp\claude\C--Users-Micha-Slumper\8bc3b4e9-2af4-4e6a-9533-37054aa2b996\scratchpad\`.
