"""
Read-only SQLite access layer for the 402cap API/MCP server.

Hard rule: this process NEVER writes to x402_index.db. Every connection is opened
`mode=ro` via a SQLite URI, so even a bug here cannot take a write lock — the OS/SQLite
will refuse. The daily catalog fetch can run at any time; we must never contend with it.

BUG FIX (ORG-BACKLOG #11): v_latest_catalog and v_builder_codes (defined inside the .db
file itself) do NOT filter on catalog_snapshot.is_complete, so a partial/aborted snapshot
would silently become "current state" for every route this API serves. Rather than ALTER
the stored views (which would need a write connection we've ruled out), every query in
this module that needs "current state" uses the LATEST_CATALOG_CTE below, which replicates
v_latest_catalog's logic but adds `WHERE cs.is_complete = 1` to the max-snapshot subquery.
Verified against the live DB: 4 snapshots exist, only 3 are is_complete=1 (see README notes
in this dir for the exact numbers). v_price_history, v_recent_changes, and
v_resource_history are NOT rebuilt here — they are legitimately per-snapshot / per-event
history, not "current state", and change_event is only ever written after complete fetches
(verified: every change_event's to_snapshot has is_complete=1 in the current DB).
"""
import sqlite3
from pathlib import Path
from contextlib import contextmanager

DB_PATH = Path(r"C:/Users/Micha/Desktop/x402/x402_index.db")

# The corrected "current state" source. Every "list/search/one resource/mismatch/
# builder-code" query below starts from this CTE instead of the buggy stored views.
LATEST_CATALOG_CTE = """
WITH latest_catalog AS (
    SELECT c.*
    FROM catalog_resource c
    JOIN (
        SELECT cr.resource_url, MAX(cr.snapshot_id) AS max_snapshot_id
        FROM catalog_resource cr
        JOIN catalog_snapshot cs ON cs.id = cr.snapshot_id
        WHERE cs.is_complete = 1
        GROUP BY cr.resource_url
    ) m ON c.resource_url = m.resource_url AND c.snapshot_id = m.max_snapshot_id
)
"""

# latest_catalog joined to each resource's most recent probe (mirrors v_claim_vs_reality,
# but built on the corrected latest_catalog above instead of the buggy v_latest_catalog).
LATEST_CATALOG_WITH_PROBE_CTE = LATEST_CATALOG_CTE.rstrip() + """,
latest_probe AS (
    SELECT pr.*
    FROM probe pr
    JOIN (SELECT resource_url, MAX(id) AS mid FROM probe GROUP BY resource_url) mm
      ON pr.id = mm.mid
)
"""


def get_conn() -> sqlite3.Connection:
    """Open a fresh read-only connection. Callers must close it (use `with conn_scope()`)."""
    uri = f"file:{DB_PATH.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def conn_scope():
    conn = get_conn()
    try:
        yield conn
    finally:
        conn.close()


def rows_to_dicts(rows) -> list[dict]:
    return [dict(r) for r in rows]
