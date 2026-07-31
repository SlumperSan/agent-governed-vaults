"""
Shared read-only query functions — the single source of truth for both the FastAPI
routes (main.py) and the MCP server (mcp_server.py). Neither wrapper duplicates SQL;
both call into this module so the is_complete bug fix (see db.py) is fixed in one place.
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Optional

from db import conn_scope, rows_to_dicts, LATEST_CATALOG_CTE, LATEST_CATALOG_WITH_PROBE_CTE, DB_PATH


def _paginate(limit: int, offset: int, max_limit: int) -> tuple[int, int]:
    return max(1, min(limit, max_limit)), max(0, offset)


def health() -> dict:
    with conn_scope() as conn:
        snap = conn.execute(
            "SELECT id, fetched_at, is_complete, total_reported, rows_stored "
            "FROM catalog_snapshot ORDER BY id DESC LIMIT 1"
        ).fetchone()
        complete_snap = conn.execute(
            "SELECT id, fetched_at FROM catalog_snapshot WHERE is_complete = 1 "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return {
        "status": "ok",
        "latest_snapshot": dict(snap) if snap else None,
        "latest_complete_snapshot": dict(complete_snap) if complete_snap else None,
    }


def list_resources(
    q: Optional[str] = None,
    host: Optional[str] = None,
    curated: Optional[bool] = None,
    is_templated: Optional[bool] = None,
    is_deprecated: Optional[bool] = None,
    has_builder_code: Optional[bool] = None,
    min_price_usd: Optional[float] = None,
    max_price_usd: Optional[float] = None,
    sort: str = "l30d_total_calls_desc",
    limit: int = 50,
    offset: int = 0,
) -> dict:
    limit, offset = _paginate(limit, offset, 500)
    where = []
    params: dict = {}
    if q:
        where.append("(service_name LIKE :q OR host LIKE :q OR resource_url LIKE :q)")
        params["q"] = f"%{q}%"
    if host:
        where.append("host = :host")
        params["host"] = host
    if curated is not None:
        where.append("curated = :curated")
        params["curated"] = int(curated)
    if is_templated is not None:
        where.append("is_templated = :is_templated")
        params["is_templated"] = int(is_templated)
    if is_deprecated is not None:
        where.append("is_deprecated = :is_deprecated")
        params["is_deprecated"] = int(is_deprecated)
    if has_builder_code is not None:
        where.append("builder_code IS NOT NULL" if has_builder_code else "builder_code IS NULL")
    if min_price_usd is not None:
        where.append("catalog_price_usd >= :min_price")
        params["min_price"] = min_price_usd
    if max_price_usd is not None:
        where.append("catalog_price_usd <= :max_price")
        params["max_price"] = max_price_usd

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    order_map = {
        "l30d_total_calls_desc": "l30d_total_calls DESC NULLS LAST",
        "price_asc": "catalog_price_usd ASC NULLS LAST",
        "price_desc": "catalog_price_usd DESC NULLS LAST",
        "host": "host ASC",
    }
    order_sql = order_map.get(sort, order_map["l30d_total_calls_desc"])

    sql = (
        LATEST_CATALOG_CTE
        + f"SELECT resource_url, host, service_name, resource_type, description, "
        f"curated, is_templated, is_deprecated, l30d_total_calls, l30d_unique_payers, "
        f"last_called_at, est_gmv_30d_usd, min_amount_raw, min_amount_network, "
        f"min_amount_asset, catalog_price_usd, builder_code, skill_url, snapshot_id "
        f"FROM latest_catalog {where_sql} ORDER BY {order_sql} LIMIT :limit OFFSET :offset"
    )
    count_sql = LATEST_CATALOG_CTE + f"SELECT COUNT(*) AS n FROM latest_catalog {where_sql}"

    with conn_scope() as conn:
        total = conn.execute(count_sql, params).fetchone()["n"]
        rows = conn.execute(sql, dict(params, limit=limit, offset=offset)).fetchall()

    return {"total": total, "limit": limit, "offset": offset, "results": rows_to_dicts(rows)}


def get_resource(resource_url: str) -> Optional[dict]:
    sql = (
        LATEST_CATALOG_WITH_PROBE_CTE
        + """
        SELECT lc.resource_url, lc.host, lc.service_name, lc.resource_type, lc.description,
               lc.curated, lc.is_templated, lc.is_deprecated, lc.tags_json,
               lc.min_amount_raw AS catalog_amount_raw, lc.catalog_price_usd,
               lc.min_amount_network AS catalog_network, lc.min_amount_asset AS catalog_asset,
               lc.l30d_total_calls, lc.l30d_unique_payers, lc.last_called_at, lc.est_gmv_30d_usd,
               lc.builder_code, lc.skill_url, lc.snapshot_id AS latest_catalog_snapshot_id,
               lp.probed_at, lp.http_status, lp.latency_ms, lp.transport_error_class,
               lp.is_valid_402, lp.detected_version,
               lp.probed_amount_raw, lp.probed_price_usd, lp.probed_network,
               lp.bazaar_ext_present, lp.bazaar_schema_valid,
               lp.spec_violations, lp.violation_count,
               CASE
                 WHEN lp.probed_price_usd IS NULL OR lc.catalog_price_usd IS NULL THEN NULL
                 WHEN ABS(lp.probed_price_usd - lc.catalog_price_usd) < 1e-9 THEN 0
                 ELSE 1
               END AS price_mismatch
        FROM latest_catalog lc
        LEFT JOIN latest_probe lp ON lp.resource_url = lc.resource_url
        WHERE lc.resource_url = :resource_url
        """
    )
    with conn_scope() as conn:
        row = conn.execute(sql, {"resource_url": resource_url}).fetchone()
    return dict(row) if row else None


def resource_history(resource_url: str, limit: int = 500, offset: int = 0) -> Optional[dict]:
    limit, offset = _paginate(limit, offset, 5000)
    with conn_scope() as conn:
        exists = conn.execute(
            "SELECT 1 FROM catalog_resource WHERE resource_url = :u "
            "UNION SELECT 1 FROM probe WHERE resource_url = :u LIMIT 1",
            {"u": resource_url},
        ).fetchone()
        if not exists:
            return None
        rows = conn.execute(
            "SELECT * FROM v_resource_history WHERE resource_url = :u "
            "ORDER BY observed_at ASC LIMIT :limit OFFSET :offset",
            {"u": resource_url, "limit": limit, "offset": offset},
        ).fetchall()
    return {"resource_url": resource_url, "count": len(rows), "limit": limit, "offset": offset,
            "history": rows_to_dicts(rows)}


def changes(
    since: Optional[str] = None,
    event_type: Optional[str] = None,
    host: Optional[str] = None,
    resource_url: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    limit, offset = _paginate(limit, offset, 2000)
    where = []
    params: dict = {}
    if since:
        where.append("detected_at >= :since")
        params["since"] = since
    if event_type:
        where.append("event_type = :event_type")
        params["event_type"] = event_type
    if host:
        where.append("host = :host")
        params["host"] = host
    if resource_url:
        where.append("resource_url = :resource_url")
        params["resource_url"] = resource_url
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    with conn_scope() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS n FROM v_recent_changes {where_sql}", params).fetchone()["n"]
        rows = conn.execute(
            f"SELECT * FROM v_recent_changes {where_sql} ORDER BY detected_at DESC LIMIT :limit OFFSET :offset",
            dict(params, limit=limit, offset=offset),
        ).fetchall()
    return {"total": total, "limit": limit, "offset": offset, "results": rows_to_dicts(rows)}


# The productized severity-tiered feed (mismatch_report.py's output) is the SINGLE
# source of truth for mismatch severity. This endpoint used to run its own independent
# ratio-only SQL severity calc (critical/high/medium/low purely by max(ratio,1/ratio)),
# which is exactly the "two divergent numbers for the same concept" bug class that
# ORG-BACKLOG #16 already burned this org on (index.html vs mismatch.html disagreeing
# on a mismatch COUNT). We are not doing that again for severity: one calculation
# (classify()/build_leaderboard() in mismatch_report.py, at the repo root), every
# consumer -- this API, the MCP server, the static site -- reads the same file.
# Consequence worth stating plainly: severity values changed shape (was lowercase
# critical/high/medium/low ranked by ratio; now CRITICAL/HIGH/LOW ranked by danger --
# dollar exposure, direction-aware, matching mismatch_report.py's classify()). This is
# an intentional breaking change to a pre-1.0 (version 0.1.0) API, not an oversight.
MISMATCH_JSON_PATH = DB_PATH.parent / "mismatch.json"
_mismatch_feed_cache: dict = {"mtime": None, "data": None}


def _load_mismatch_feed() -> dict:
    """Load mismatch.json, re-reading only when its mtime changes (a new snapshot's
    mismatch_report.py run regenerates the file in place). Cheap on a cache hit;
    avoids re-parsing a several-hundred-KB JSON file on every request. Missing file
    degrades to an empty feed rather than a 500 -- e.g. right after a fresh checkout
    before the first report has ever run."""
    try:
        mtime = MISMATCH_JSON_PATH.stat().st_mtime
    except FileNotFoundError:
        return {"meta": {}, "leaderboard": [], "concentration": {}}
    if _mismatch_feed_cache["mtime"] != mtime:
        with open(MISMATCH_JSON_PATH, encoding="utf-8") as f:
            _mismatch_feed_cache["data"] = json.load(f)
        _mismatch_feed_cache["mtime"] = mtime
    return _mismatch_feed_cache["data"]


def mismatches(
    min_ratio: Optional[float] = None,
    host: Optional[str] = None,
    severity: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    """The safety signal, served directly from the severity-tiered feed on disk
    (mismatch.json) -- not recomputed here. `severity` filters to CRITICAL|HIGH|LOW
    (case-insensitive). Rows arrive from build_leaderboard() already ordered by
    (severity tier, then absolute dollar exposure descending); filtering with a list
    comprehension preserves that order, so no re-sort is needed here."""
    limit, offset = _paginate(limit, offset, 2000)
    feed = _load_mismatch_feed()
    rows = feed.get("leaderboard", [])

    if host:
        rows = [r for r in rows if r["host"] == host]
    if severity:
        sev = severity.upper()
        rows = [r for r in rows if r["severity"] == sev]
    if min_ratio is not None:
        # ratio can be None (catalog claimed the route free -- undefined ratio) or exactly
        # 0.0 (live price probed as free while catalog charged something -- an undercharge
        # to $0, distinct from "catalog free"). Both must be excluded before 1/ratio, or a
        # 0.0 ratio raises ZeroDivisionError -- caught in verification, not hypothetical.
        rows = [r for r in rows if r["ratio"] is not None and r["ratio"] > 0 and
                max(r["ratio"], 1 / r["ratio"]) >= min_ratio]

    total = len(rows)
    page = rows[offset:offset + limit]
    meta = feed.get("meta") or {}
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "feed_generated_at": meta.get("generated_at"),
        "snapshot_id": meta.get("snapshot_id"),
        "run_id": meta.get("run_id"),
        "severity_counts": {
            "critical": meta.get("critical_count"),
            "high": meta.get("high_count"),
            "low": meta.get("low_count"),
        },
        "severity_definition": meta.get("severity_definition"),
        "results": page,
    }


def builder_codes(limit: int = 100, offset: int = 0) -> dict:
    limit, offset = _paginate(limit, offset, 2000)
    sql = (
        LATEST_CATALOG_CTE
        + """
        SELECT builder_code, COUNT(*) AS routes, COUNT(DISTINCT host) AS hosts,
               SUM(l30d_total_calls) AS l30d_calls, SUM(est_gmv_30d_usd) AS est_gmv
        FROM latest_catalog
        WHERE builder_code IS NOT NULL
        GROUP BY builder_code
        ORDER BY l30d_calls DESC
        LIMIT :limit OFFSET :offset
        """
    )
    with conn_scope() as conn:
        rows = conn.execute(sql, {"limit": limit, "offset": offset}).fetchall()
    return {"limit": limit, "offset": offset, "results": rows_to_dicts(rows)}
