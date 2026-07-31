"""
Shared read-only query functions — the single source of truth for both the FastAPI
routes (main.py) and the MCP server (mcp_server.py). Neither wrapper duplicates SQL;
both call into this module so the is_complete bug fix (see db.py) is fixed in one place.
"""
from __future__ import annotations
from typing import Optional

from db import conn_scope, rows_to_dicts, LATEST_CATALOG_CTE, LATEST_CATALOG_WITH_PROBE_CTE


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


def mismatches(
    min_ratio: Optional[float] = None,
    host: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    limit, offset = _paginate(limit, offset, 2000)
    where = ["lc.catalog_price_usd IS NOT NULL", "lp.probed_price_usd IS NOT NULL",
             "ABS(lp.probed_price_usd - lc.catalog_price_usd) >= 1e-9"]
    params: dict = {}
    if host:
        where.append("lc.host = :host")
        params["host"] = host
    where_sql = "WHERE " + " AND ".join(where)

    sql = (
        LATEST_CATALOG_WITH_PROBE_CTE
        + f"""
        SELECT lc.resource_url, lc.host, lc.service_name,
               lc.catalog_price_usd, lp.probed_price_usd,
               (lp.probed_price_usd / lc.catalog_price_usd) AS price_ratio,
               CASE
                 WHEN lp.probed_price_usd / lc.catalog_price_usd >= 100
                   OR lc.catalog_price_usd / NULLIF(lp.probed_price_usd, 0) >= 100 THEN 'critical'
                 WHEN lp.probed_price_usd / lc.catalog_price_usd >= 10
                   OR lc.catalog_price_usd / NULLIF(lp.probed_price_usd, 0) >= 10 THEN 'high'
                 WHEN lp.probed_price_usd / lc.catalog_price_usd >= 2
                   OR lc.catalog_price_usd / NULLIF(lp.probed_price_usd, 0) >= 2 THEN 'medium'
                 ELSE 'low'
               END AS severity,
               lp.probed_at, lc.l30d_total_calls, lc.est_gmv_30d_usd
        FROM latest_catalog lc
        JOIN latest_probe lp ON lp.resource_url = lc.resource_url
        {where_sql}
        """
    )
    count_sql = LATEST_CATALOG_WITH_PROBE_CTE + (
        "SELECT COUNT(*) AS n FROM latest_catalog lc JOIN latest_probe lp "
        f"ON lp.resource_url = lc.resource_url {where_sql}"
    )
    with conn_scope() as conn:
        total = conn.execute(count_sql, params).fetchone()["n"]
        rows = conn.execute(
            sql + " ORDER BY ABS(LOG(price_ratio)) DESC LIMIT :limit OFFSET :offset",
            dict(params, limit=limit, offset=offset),
        ).fetchall()

    filtered = rows_to_dicts(rows)
    if min_ratio is not None:
        filtered = [r for r in filtered if r["price_ratio"] is not None and
                    max(r["price_ratio"], 1 / r["price_ratio"]) >= min_ratio]
    return {"total": total, "limit": limit, "offset": offset, "results": filtered}


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
