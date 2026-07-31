"""
402cap MCP server — exposes the same read-only queries (queries.py) as MCP tools, so
agents can discover and call them the way they actually do today (MCP tool-call, not
"go read an OpenAPI spec"). Read-only against x402_index.db; no payment gating.

Run headless (stdio transport, no window):
  pythonw.exe mcp_server.py > mcp_server.log 2>&1

Or run over HTTP for remote agents:
  pythonw.exe mcp_server.py --http --port 8421 > mcp_server.log 2>&1
"""
from __future__ import annotations
import sys
from typing import Optional

from mcp.server.fastmcp import FastMCP
import queries as q

mcp = FastMCP("402cap")


@mcp.tool()
def health() -> dict:
    """Report the latest catalog snapshot and the latest COMPLETE snapshot (the one the API's
    current-state endpoints actually use)."""
    return q.health()


@mcp.tool()
def list_resources(
    query: Optional[str] = None,
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
    """Search/list x402 resources in the latest COMPLETE catalog snapshot. `sort` is one of
    l30d_total_calls_desc, price_asc, price_desc, host."""
    return q.list_resources(
        q=query, host=host, curated=curated, is_templated=is_templated, is_deprecated=is_deprecated,
        has_builder_code=has_builder_code, min_price_usd=min_price_usd, max_price_usd=max_price_usd,
        sort=sort, limit=limit, offset=offset,
    )


@mcp.tool()
def get_resource(resource_url: str) -> dict:
    """Get one resource's current catalog listing joined to its most recent unpaid probe,
    including price_mismatch (1 = live price differs from catalog price)."""
    result = q.get_resource(resource_url)
    if result is None:
        return {"error": "not_found", "detail": "resource not in latest complete catalog", "resource_url": resource_url}
    return result


@mcp.tool()
def resource_history(resource_url: str, limit: int = 500, offset: int = 0) -> dict:
    """Full observed time series (catalog + probe rows) for one resource_url, oldest first."""
    result = q.resource_history(resource_url, limit=limit, offset=offset)
    if result is None:
        return {"error": "not_found", "detail": "resource never observed", "resource_url": resource_url}
    return result


@mcp.tool()
def changes(
    since: Optional[str] = None,
    event_type: Optional[str] = None,
    host: Optional[str] = None,
    resource_url: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    """What changed since a timestamp: new listings, disappeared listings, price/calls/payers
    changes, curation/deprecation/metadata changes. `since` is an ISO8601 timestamp string.
    event_type filters to one of: listed, disappeared, price_change, calls_change,
    payers_change, curation_change, deprecated_change, metadata_change."""
    return q.changes(since=since, event_type=event_type, host=host, resource_url=resource_url,
                      limit=limit, offset=offset)


@mcp.tool()
def mismatches(min_ratio: Optional[float] = None, host: Optional[str] = None,
               severity: Optional[str] = None, limit: int = 100, offset: int = 0) -> dict:
    """The safety signal: resources where the live probed price differs from the catalog's
    declared price. Each row has severity CRITICAL/HIGH/LOW -- a DANGER ranking (absolute
    dollar exposure + direction), not a ratio ranking: a 20,000,000x overcharge on a $0.05
    route and a 100x overcharge on a $50 route can both be CRITICAL, while any undercharge
    is LOW regardless of ratio (never dangerous to a paying agent). `severity` filters to
    CRITICAL|HIGH|LOW. An agent that auto-pays off the catalog price alone can be drained
    by these -- this feed regenerates on every daily snapshot."""
    return q.mismatches(min_ratio=min_ratio, host=host, severity=severity, limit=limit, offset=offset)


@mcp.tool()
def builder_codes(limit: int = 100, offset: int = 0) -> dict:
    """Aggregate stats per builder-code (the attribution rail already in the wild): routes,
    hosts, 30-day calls, estimated GMV."""
    return q.builder_codes(limit=limit, offset=offset)


if __name__ == "__main__":
    if "--http" in sys.argv:
        port = 8421
        if "--port" in sys.argv:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        mcp.settings.port = port
        mcp.run(transport="streamable-http")
    else:
        mcp.run(transport="stdio")
