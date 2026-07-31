"""Backfill referral_json + seed referral_event for the builder-code rail.

Two independent, additive fixes for existing data — neither touches
catalog_resource.builder_code (already correct) or requires a re-fetch,
because everything needed already lives in raw_json.

1. referral_json backfill
   fetch_catalog.py wrote referral_json = NULL for every row before the
   2026-07-31 fix (it was a reserved-but-unused column). row_from_record()
   now captures the full extensions['builder-code'] object (a/s/w, not just
   'a') for NEW snapshots. This backfills the column on rows already stored
   by re-deriving it from each row's own raw_json.

2. referral_event seed
   referral_event is shaped for OBSERVED PAYMENTS (direction, amount_raw,
   asset, network) — we cannot populate those columns honestly, because
   unpaid probing never sees a settlement and the CDP catalog exposes no
   revenue field (verified: quality == {l30DaysTotalCalls,
   l30DaysUniquePayers, lastCalledAt}, nothing else, across a 2,000-record
   sample per README). What we CAN honestly record is attribution-metadata
   presence: "this route carried builder code X as of snapshot Y." One row
   per (resource_url, referral_code) pair the first time it is observed
   (skipped if that pair already has a referral_event row), with
   direction/amount_raw/asset/network left NULL and raw_json holding the
   verbatim extension object. That is a legitimate time-series seed without
   fabricating a payment that was never observed.

SAFETY: the production db is a live probe-sweep target. This script REFUSES
to write to a path ending in x402_index.db unless --sweep-is-finished is
ALSO passed, so the documented post-sweep command is real but requires an
explicit, named acknowledgement that the sweep has ended:

    python backfill_referral_json.py --db C:\\...\\x402_index.db --apply \\
        --seed-referral-events --sweep-is-finished

Against any other path (a copy), --sweep-is-finished is not required.
Without --apply it is always a dry run: reports what WOULD change, writes
nothing.
"""
import argparse
import json
import os
import sqlite3
import sys


def extract_bc(raw_json: str):
    try:
        rec = json.loads(raw_json)
    except (json.JSONDecodeError, TypeError):
        return None
    ext = rec.get("extensions")
    if not isinstance(ext, dict):
        return None
    bc = ext.get("builder-code")
    return bc if isinstance(bc, dict) else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="path to the db to write (a COPY, unless --sweep-is-finished)")
    ap.add_argument("--apply", action="store_true", help="actually write; default is dry-run")
    ap.add_argument("--seed-referral-events", action="store_true",
                     help="also insert first-observation rows into referral_event")
    ap.add_argument("--sweep-is-finished", action="store_true",
                     help="required in addition to --apply to write directly to x402_index.db")
    args = ap.parse_args()

    # Compare resolved basenames, not a string suffix — a bare relative path
    # like "x402_index.db" (exactly how every other script in this repo is
    # documented to be invoked, e.g. `python fetch_catalog.py` from the x402
    # dir) does not end in "\x402_index.db" as a string, so a suffix check
    # would silently miss it and write to production unguarded.
    is_prod_path = os.path.basename(os.path.abspath(args.db)).lower() == "x402_index.db"
    if is_prod_path and args.apply and not args.sweep_is_finished:
        print("REFUSING: this is the live production db and --sweep-is-finished was not passed. "
              "Copy the db first, or pass --sweep-is-finished once the sweep has actually ended.",
              file=sys.stderr)
        return 2

    con = sqlite3.connect(args.db)
    cur = con.cursor()

    # --- 1. referral_json backfill ---
    cur.execute("SELECT COUNT(*) FROM catalog_resource WHERE referral_json IS NOT NULL")
    print(f"[referral_json] already set: {cur.fetchone()[0]}")

    # SCHEMA DRIFT (caught 2026-07-31, post-prune re-verification): raw_json was
    # deduped into raw_blob by prune.py. catalog_resource.raw_json is now ''
    # (empty string, NOT NULL) for every row in production — confirmed via
    # `SELECT COUNT(*) WHERE raw_json = ''` = all 47,570 rows. Reading raw_json
    # directly here would silently find ZERO backfillable rows (json.loads('')
    # raises, extract_bc catches it and returns None) with no error at all —
    # exactly the "silent failure that fakes success" pattern in ORG-LESSONS.
    # catalog_resource_full re-joins raw_blob via raw_sha; read raw_json_full
    # from there instead.
    cur.execute("""
        SELECT id, raw_json_full FROM catalog_resource_full
        WHERE referral_json IS NULL AND raw_json_full IS NOT NULL AND raw_json_full != ''
    """)
    rows = cur.fetchall()
    updates = []
    for rid, raw in rows:
        bc = extract_bc(raw)
        if bc is not None:
            updates.append((json.dumps(bc, separators=(",", ":"), sort_keys=True), rid))
    print(f"[referral_json] rows that WOULD gain a value: {len(updates)}")
    if updates:
        print("[referral_json] sample:", updates[0][:1], "id=", updates[0][1])

    # --- 2. referral_event seed ---
    event_rows = []
    if args.seed_referral_events:
        cur.execute("SELECT resource_url, referral_code FROM referral_event WHERE program='builder-code'")
        existing = set(cur.fetchall())
        # Derive presence from raw_json (extract_bc), NOT the builder_code
        # column: the column is NULL on snapshot 2 even though snapshot 2's
        # raw_json contains the same extension for the same 2,670 routes,
        # because column-extraction only started at snapshot 5
        # (catalog_snapshot.captured_fields_json confirms this — the exact
        # "field added mid-history" trap the fetch_catalog.py diff logic
        # already guards against for metadata_change). Using raw_json instead
        # of the column means the seed anchors observed_at to the true first
        # snapshot that had the data, not the first one whose extraction code
        # happened to capture it.
        # Only complete snapshots: README's own rule ("only complete snapshots
        # are ever diffed") applies here too — snapshot 1 stored 1,000/15,520
        # rows (is_complete=0, an aborted partial fetch) and using it as a
        # "first observed" source would anchor observed_at to an unreliable
        # fetch instead of the earliest trustworthy one.
        cur.execute("""
            SELECT crf.resource_url, crf.host, crf.raw_json_full, cs.fetched_at
            FROM catalog_resource_full crf JOIN catalog_snapshot cs ON crf.snapshot_id = cs.id
            WHERE crf.raw_json_full IS NOT NULL AND crf.raw_json_full != '' AND cs.is_complete = 1
            ORDER BY cs.id ASC
        """)
        seen_this_run = set()
        for resource_url, host, raw, fetched_at in cur.fetchall():
            bc = extract_bc(raw)
            if bc is None:
                continue
            info = bc.get("info") if isinstance(bc, dict) else None
            code = info.get("a") if isinstance(info, dict) else None
            if not isinstance(code, str):
                continue
            key = (resource_url, code)
            if key in existing or key in seen_this_run:
                continue
            seen_this_run.add(key)
            event_rows.append((
                fetched_at, resource_url, host, "builder-code", code,
                None, None, None, None,
                json.dumps(bc, separators=(",", ":"), sort_keys=True),
            ))
        print(f"[referral_event] first-observation rows that WOULD be inserted: {len(event_rows)}")
        if event_rows:
            print("[referral_event] sample:", event_rows[0])

    if not args.apply:
        print("DRY RUN — nothing written. Re-run with --apply to commit.")
        con.close()
        return 0

    if updates:
        cur.executemany("UPDATE catalog_resource SET referral_json = ? WHERE id = ?", updates)
    if event_rows:
        cur.executemany("""
            INSERT INTO referral_event
                (observed_at, resource_url, host, program, referral_code,
                 direction, amount_raw, asset, network, raw_json)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, event_rows)
    con.commit()

    cur.execute("SELECT COUNT(*) FROM catalog_resource WHERE referral_json IS NOT NULL")
    print(f"[referral_json] set after commit: {cur.fetchone()[0]}")
    cur.execute("SELECT COUNT(*) FROM referral_event WHERE program='builder-code'")
    print(f"[referral_event] builder-code rows after commit: {cur.fetchone()[0]}")
    con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
