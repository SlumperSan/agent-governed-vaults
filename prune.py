"""Content-addressed dedup of catalog_resource.raw_json. Run after every fetch.

WHY THIS EXISTS — it is a storage-growth fix, and without it daily cadence is
not survivable.

`catalog_resource` stores one row per (snapshot, resource) with the verbatim
catalog record in `raw_json`. That verbatim copy is the whole point — it is what
lets a future read re-derive conclusions we did not think to draw today. But the
overwhelming majority of listings do not change between snapshots, so every
fetch re-stores ~15,500 byte-identical JSON blobs.

Measured on the first four snapshots: 117.8 MB of raw_json, of which only
38.4 MB was distinct. 67.4% pure duplication. At ~72 MB per snapshot, a daily
run reaches ~26 GB/year, essentially all of it the same records copied over.

The fix keeps 100% fidelity: each distinct JSON body is stored ONCE in
`raw_blob`, keyed by its SHA-256, and `catalog_resource.raw_sha` points at it.
Nothing is summarized, sampled, or thrown away — the bytes are identical on the
way back out, which `--verify` proves row by row before anything is deleted.

    python prune.py --dry-run    # measure, touch nothing
    python prune.py              # dedup + verify + VACUUM
    python prune.py --no-vacuum  # dedup without the (slow, 2x-disk) rebuild

NOTE ON raw_json AFTER PRUNING: the column is declared NOT NULL, so a pruned row
carries '' rather than NULL. Empty string means "moved to raw_blob, resolve via
raw_sha" and is unambiguous — a real catalog record is always a JSON object, so
it is never legitimately ''. Read through the `catalog_resource_full` view and
this detail stays invisible.

SAFE TO RE-RUN. Rows already pruned are skipped, so this is idempotent and can
be wired into the end of a nightly fetch.

DO NOT RUN DURING A FETCH OR SWEEP. It takes a write lock on the whole database;
a concurrent writer will block or fail. Run it between jobs.
"""

from __future__ import annotations

import argparse
import hashlib
import sqlite3
import sys
from pathlib import Path

DB = Path(__file__).resolve().parent / "x402_index.db"

# Sentinel written into the NOT NULL raw_json column once content has moved to
# raw_blob. See the module docstring.
PRUNED = ""


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the blob table, the pointer column, and the transparent view.

    Idempotent: every statement is guarded, so this is safe on an already
    migrated database.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_blob (
            sha  TEXT PRIMARY KEY,   -- sha256 of json, lowercase hex
            json TEXT NOT NULL,      -- verbatim catalog record, stored exactly once
            refs INTEGER NOT NULL DEFAULT 0  -- advisory count; never used to delete
        )
        """
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(catalog_resource)")}
    if "raw_sha" not in cols:
        conn.execute("ALTER TABLE catalog_resource ADD COLUMN raw_sha TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cr_raw_sha ON catalog_resource(raw_sha)")

    # Read through this and pruning is invisible: raw_json_full always resolves,
    # whether the bytes live inline (not yet pruned) or in raw_blob.
    conn.execute("DROP VIEW IF EXISTS catalog_resource_full")
    conn.execute(
        """
        CREATE VIEW catalog_resource_full AS
        SELECT cr.*,
               COALESCE(NULLIF(cr.raw_json, ''), rb.json) AS raw_json_full
          FROM catalog_resource cr
          LEFT JOIN raw_blob rb ON rb.sha = cr.raw_sha
        """
    )
    conn.commit()


def measure(conn: sqlite3.Connection) -> tuple[int, int, int, int]:
    """-> (inline_rows, inline_bytes, distinct_bodies, distinct_bytes)."""
    rows = bytes_ = 0
    distinct: dict[str, int] = {}
    for (rj,) in conn.execute(
        "SELECT raw_json FROM catalog_resource WHERE raw_json IS NOT NULL AND raw_json != ''"
    ):
        rows += 1
        bytes_ += len(rj)
        distinct.setdefault(hashlib.sha256(rj.encode("utf-8")).hexdigest(), len(rj))
    return rows, bytes_, len(distinct), sum(distinct.values())


def prune(conn: sqlite3.Connection, dry: bool) -> int:
    """Move every inline raw_json into raw_blob. Returns rows moved."""
    todo = conn.execute(
        "SELECT id, raw_json FROM catalog_resource "
        "WHERE raw_json IS NOT NULL AND raw_json != ''"
    ).fetchall()
    if not todo:
        print("  nothing inline — already pruned")
        return 0
    if dry:
        return len(todo)

    moved = 0
    for i, (rid, rj) in enumerate(todo, 1):
        sha = hashlib.sha256(rj.encode("utf-8")).hexdigest()
        # INSERT OR IGNORE: the second and later rows carrying identical bytes
        # cost nothing but a 64-char pointer.
        conn.execute("INSERT OR IGNORE INTO raw_blob(sha, json) VALUES (?, ?)", (sha, rj))
        conn.execute(
            "UPDATE catalog_resource SET raw_sha = ?, raw_json = ? WHERE id = ?",
            (sha, PRUNED, rid),
        )
        moved += 1
        if i % 5000 == 0:
            conn.commit()
            print(f"  moved {i:,}/{len(todo):,}")
    conn.execute(
        "UPDATE raw_blob SET refs = ("
        "  SELECT count(*) FROM catalog_resource WHERE catalog_resource.raw_sha = raw_blob.sha)"
    )
    conn.commit()
    return moved


def verify(conn: sqlite3.Connection) -> bool:
    """Every pruned row must resolve to bytes whose hash matches its pointer.

    This is the check that makes deletion safe: it proves the content is
    recoverable BEFORE the VACUUM reclaims the space.
    """
    bad = 0
    checked = 0
    for rid, sha, js in conn.execute(
        "SELECT cr.id, cr.raw_sha, rb.json FROM catalog_resource cr "
        "LEFT JOIN raw_blob rb ON rb.sha = cr.raw_sha "
        "WHERE cr.raw_json = ''"
    ):
        checked += 1
        if js is None:
            print(f"  FAIL row {rid}: raw_sha {sha} has no blob")
            bad += 1
        elif hashlib.sha256(js.encode("utf-8")).hexdigest() != sha:
            print(f"  FAIL row {rid}: blob content does not match its sha")
            bad += 1
        if bad > 5:
            print("  ...stopping after 6 failures")
            break

    orphans = conn.execute(
        "SELECT count(*) FROM catalog_resource WHERE raw_json = '' AND raw_sha IS NULL"
    ).fetchone()[0]
    if orphans:
        print(f"  FAIL: {orphans} pruned rows have no raw_sha — content unrecoverable")
        bad += orphans

    print(f"  verified {checked:,} pruned rows, {bad} failures")
    return bad == 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Dedup catalog raw_json into content-addressed blobs.")
    ap.add_argument("--db", default=str(DB), help="database path (default: x402_index.db)")
    ap.add_argument("--dry-run", action="store_true", help="measure only, write nothing")
    ap.add_argument("--no-vacuum", action="store_true", help="skip VACUUM (faster, reclaims nothing)")
    args = ap.parse_args()

    path = Path(args.db)
    if not path.exists():
        print(f"no such database: {path}", file=sys.stderr)
        return 2

    size_before = path.stat().st_size
    conn = connect(path)

    rows, inline_bytes, distinct, distinct_bytes = measure(conn)
    print(f"db {path.name}: {size_before/1e6:.1f} MB")
    print(f"  inline raw_json : {rows:,} rows, {inline_bytes/1e6:.1f} MB")
    print(f"  distinct bodies : {distinct:,}, {distinct_bytes/1e6:.1f} MB")
    if inline_bytes:
        print(f"  reclaimable     : {(inline_bytes-distinct_bytes)/1e6:.1f} MB "
              f"({(inline_bytes-distinct_bytes)/inline_bytes*100:.1f}%)")

    if args.dry_run:
        print("DRY RUN — nothing written")
        return 0

    ensure_schema(conn)
    moved = prune(conn, dry=False)
    print(f"  moved {moved:,} rows into raw_blob")

    if not verify(conn):
        # Deliberately do NOT vacuum: leaving the space unreclaimed keeps the
        # freed pages recoverable and makes the failure loud rather than final.
        print("VERIFY FAILED — refusing to VACUUM. Database is unchanged in content.",
              file=sys.stderr)
        return 1

    if not args.no_vacuum:
        print("  vacuuming (needs ~2x db size in free disk, may take a minute)...")
        conn.isolation_level = None
        conn.execute("VACUUM")

    conn.close()
    size_after = path.stat().st_size
    print(f"done: {size_before/1e6:.1f} MB -> {size_after/1e6:.1f} MB "
          f"({(size_before-size_after)/1e6:.1f} MB reclaimed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
