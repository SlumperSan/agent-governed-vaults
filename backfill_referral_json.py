"""Backfill catalog_resource.referral_json from raw_json for existing snapshots.

Why this exists: fetch_catalog.py wrote referral_json = NULL for every row
before 2026-07-31 (it was a reserved-but-unused column). The extraction logic
was fixed going forward (row_from_record now captures the full
extensions['builder-code'] object), but that only affects snapshots written
AFTER the fix. This script backfills the column on rows already stored, by
re-deriving referral_json from each row's own raw_json — no re-fetch needed,
because raw_json already holds the verbatim catalog record.

SAFETY: the production db (x402_index.db) is being written by a live probe
sweep. This script REFUSES to open it directly. Point it at a copy:

    python backfill_referral_json.py --db path\\to\\copy.db --apply

Without --apply it runs a dry run: reports how many rows WOULD change and
prints a sample, but writes nothing.
"""
import argparse
import json
import shutil
import sqlite3
import sys


def extract_referral_json(raw_json: str):
    try:
        rec = json.loads(raw_json)
    except (json.JSONDecodeError, TypeError):
        return None
    ext = rec.get("extensions")
    if not isinstance(ext, dict):
        return None
    bc = ext.get("builder-code")
    if not isinstance(bc, dict):
        return None
    return json.dumps(bc, separators=(",", ":"), sort_keys=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="path to a COPY of the db, never the live one")
    ap.add_argument("--apply", action="store_true", help="actually write; default is dry-run")
    args = ap.parse_args()

    if args.db.replace("/", "\\").endswith("\\x402_index.db"):
        print("REFUSING: this looks like the live production db. Copy it first.", file=sys.stderr)
        return 2

    con = sqlite3.connect(args.db)
    cur = con.cursor()

    cur.execute("SELECT COUNT(*) FROM catalog_resource WHERE referral_json IS NOT NULL")
    already = cur.fetchone()[0]
    print(f"rows with referral_json already set: {already}")

    cur.execute(
        "SELECT id, raw_json FROM catalog_resource "
        "WHERE referral_json IS NULL AND raw_json IS NOT NULL"
    )
    rows = cur.fetchall()
    print(f"candidate rows (referral_json NULL): {len(rows)}")

    updates = []
    for rid, raw in rows:
        rj = extract_referral_json(raw)
        if rj is not None:
            updates.append((rj, rid))

    print(f"rows that WOULD gain a referral_json value: {len(updates)}")
    if updates:
        print("sample:", updates[0])

    if not args.apply:
        print("DRY RUN — nothing written. Re-run with --apply to commit.")
        con.close()
        return 0

    cur.executemany("UPDATE catalog_resource SET referral_json = ? WHERE id = ?", updates)
    con.commit()

    cur.execute("SELECT COUNT(*) FROM catalog_resource WHERE referral_json IS NOT NULL")
    after = cur.fetchone()[0]
    print(f"rows with referral_json set after commit: {after}")
    con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
