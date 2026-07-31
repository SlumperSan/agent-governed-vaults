# Multi-source schema migration (Phase 2, blocks Ecosystem) — 2026-07-31

**Design followed:** `notes-cross-facilitator.md` §4 (not re-derived). One correction made to
that design and stated here: §4.1 puts `source` on `catalog_snapshot` only, but §4.3 specifies
`CREATE INDEX ... ON catalog_resource(source, host)`, which needs the column on that table too.
Resolved by denormalizing `source` onto **both** tables (`catalog_snapshot.source` = which catalog
a fetch run hit; `catalog_resource.source` = fast copy of its own snapshot's source, avoiding a
join for the per-resource index and for `v_latest_catalog`'s partition key). A future non-CDP
ingester (Ecosystem's job, not done here) sets both explicitly per fetch run.

## What shipped

- `catalog_snapshot.source TEXT NOT NULL DEFAULT 'cdp'`, `catalog_resource.source TEXT NOT NULL
  DEFAULT 'cdp'` — added via the existing `MIGRATIONS` list in `x402_common.py` (additive
  `ALTER TABLE ADD COLUMN`, same idiom already used for `is_complete` etc). `DEFAULT 'cdp'` is not
  a guess: every row in this DB today came from exactly one catalog, so it is the true value, not
  a backfill approximation.
- `idx_catalog_resource_source_host` on `(source, host)`.
- **Fixed `v_latest_catalog`** (Backlog #11, was NOT actually fixed at the schema level — see
  below): now filters `catalog_snapshot.is_complete = 1` and partitions `MAX(snapshot_id)` by
  `(source, resource_url)` instead of `resource_url` alone.
- `v_builder_codes` was **not edited** — it is a non-materialized view that `SELECT ... FROM
  v_latest_catalog` by name, so SQLite re-resolves that reference on every query. Fixing
  `v_latest_catalog` fixes what `v_builder_codes` returns automatically. Verified, not assumed
  (see positive control below).
- New `_apply_view_fixes()` in `x402_common.py`, called at the end of every `connect()`: `DROP VIEW
  IF EXISTS` + `CREATE VIEW` for `v_latest_catalog`, unconditionally, every run. This is the
  mechanism that makes the fix idempotent/re-runnable — `CREATE VIEW IF NOT EXISTS` (the pattern
  used everywhere else in this file) cannot change a view that already exists with an older
  definition, which is exactly why the Backlog #11 "fix" never reached the actual stored view (see
  next section).

## What Backlog #11 actually was before this — verified against the LIVE schema, not the backlog cell

Per the standing rule ("verify status against the live system, never a backlog cell"): `ORG-BACKLOG.md`
#11 read `shipped`. The live DB schema before this migration said otherwise —
`sqlite_master.sql` for `v_latest_catalog` had **no** `is_complete` filter at all. What actually
happened: `api/db.py` added a **Python-side workaround** (`LATEST_CATALOG_CTE`, its own `WHERE
cs.is_complete = 1` reimplementation of the view's logic) for the API/MCP server specifically. The
stored view itself, and every OTHER consumer of it — `build_site.py:249`, `report.py:368`, and
`x402_common.py`'s own `LATE_VIEWS` (`v_builder_codes`) — were reading the **unfixed** view the
entire time. This migration is the first time the bug is closed at its actual source rather than
worked around in one caller.

## Verification

1. **Baseline**: copied prod DB to a scratch working copy, ran the *actual* SQL from the codebase
   (`build_site.py`'s main join, `report.py`'s builder-code and price-change queries, every raw
   view, `api/db.py`'s CTE) via `snapshot_queries.py`, recorded row counts + a SHA-256 content hash
   per query.
2. **Migrated the copy**, ran `x402_common.connect()` **twice** (idempotency: both runs succeeded,
   no error, schema converges to identical text both times).
3. **Diffed**: every query using an explicit column list (`build_site_main`, `report_builder_codes`,
   `report_price_changes`, `raw_v_builder_codes`, `raw_v_claim_vs_reality`, `raw_v_price_history`,
   `raw_v_resource_history`, `raw_v_recent_changes`) — **byte-identical hash, before and after.**
   `raw_v_latest_catalog` (`SELECT *`) and `api_latest_catalog_cte` changed hash — expected: `*`
   now includes the new `source` column. Proved this is the *only* difference by column-aware
   row comparison: 15,524 rows, **0 mismatches** on every pre-existing column; the only addition is
   `source='cdp'` on every row.
4. **Positive control for the `is_complete` fix** (mandatory per `ORG-LESSONS.md` — an absence/fix
   claim needs one): inserted a synthetic `is_complete=0` snapshot with a higher `snapshot_id` than
   any real one, plus one poisoned row (`catalog_price_usd=999999.99`) for a real resource_url that
   would win under old `MAX(snapshot_id)` logic. **Old (pre-fix) view logic**: returned the
   poisoned `999999.99` from the fake snapshot. **New (fixed) `v_latest_catalog`**: correctly
   returned the real `0.001` from the last complete snapshot. Confirms the fix actually closes the
   hole rather than merely adding an unused column.
5. **Applied to prod**: backed up `x402_index.db` first (`x402_index.db.bak-2026-07-31-presourcemig`,
   300,949,504 bytes, same size as the working file — full copy, not truncated). Migration itself
   took **0.06s** (`ALTER TABLE ADD COLUMN` with a constant `DEFAULT` is metadata-only in SQLite,
   confirmed empirically, not just asserted from docs). Re-ran the full before/after diff directly
   against prod vs. the prod backup: identical results, same pattern as the scratch-copy test.
   `PRAGMA integrity_check` = `ok`. Ran `connect()` a second time directly on prod with no error
   (idempotency reconfirmed on the real file, not just the copy).

## What I deliberately did not do

- **No ingestion code for non-CDP facilitators** (PayAI/UVDAO/Thirdweb) — that is Ecosystem's item
  (`ORG-BACKLOG.md` #12), out of scope for a schema migration.
- **`fetch_catalog.py`'s diff/churn logic is untouched.** `notes-cross-facilitator.md` §4.2 specifies
  that `change_event` diffing must eventually partition by `source` (comparing a CDP snapshot to a
  CDP snapshot only, never CDP-vs-PayAI) and that `resource_dim`'s key should become
  `(source, resource_url)`. **Neither was done here.** Today there is exactly one source, so no
  incorrect cross-source diff can currently occur — but the moment a second source's rows land,
  `change_event`/`resource_dim` will silently treat two different facilitators' observations of the
  same URL as one continuous history unless that partitioning is added first. This is a real,
  named gap for whoever builds ingestion next, not a "your problem" wave-off.
- **`v_builder_codes` was not repartitioned by source** in its `GROUP BY`. Today this is
  unobservable (one source), and is deliberately minimal — adding speculative grouping the design
  notes didn't ask for risked exactly the "invented a second design" failure mode. Flagging it as a
  decision for whoever ingests a second source's builder-codes: aggregate cross-source (current
  behavior, once a second source exists) or partition per-source (needs an explicit view edit).
- **Did not touch `v_price_history` or `v_resource_history`** — per-snapshot/per-event history is
  legitimately source-agnostic at the row level already (each row already carries `snapshot_id`,
  which is now itself taggable via `catalog_snapshot.source` through a join if ever needed); no
  change was required or made.

## A naming trap for whoever writes ingestion next

`v_resource_history` already emits a column **literally named `source`** meaning
`{'catalog', 'probe'}` (which table an observation came from) — a completely different concept
from this migration's `source` (which facilitator/catalog a row came from, e.g. `'cdp'`/`'payai'`).
No structural collision exists today (`v_resource_history` lists explicit columns, not `c.*`, so it
never picked up the new column), but the two meanings share one name in the same codebase family.
Whoever writes the Ecosystem ingestion code should not assume "the `source` column" means the same
thing in every view.

## Files

- `x402_common.py` — the migration itself (`MIGRATIONS` list, `_apply_view_fixes()`, index).
- Scratch verification harness (not part of the repo):
  `snapshot_queries.py`, `baseline_before.json`, `baseline_after.json`, `prod_before.json`,
  `prod_after.json`, under
  `C:\Users\Micha\AppData\Local\Temp\claude\C--Users-Micha-Slumper\8bc3b4e9-2af4-4e6a-9533-37054aa2b996\scratchpad\`.
- Prod backup: `C:\Users\Micha\Desktop\x402\x402_index.db.bak-2026-07-31-presourcemig`.
