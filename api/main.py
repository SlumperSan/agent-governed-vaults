"""
402cap read API — FastAPI over the read-only x402_index.db.

Two endpoints carry the product (Michael's framing):
  1. GET /changes                 — what changed since T
  2. GET /resources/{id}/history  — full time series for one resource

Plus: GET /resources (search/list), GET /resources/{id} (one resource + latest probe),
GET /mismatches (the safety signal), GET /builder-codes (attribution rail), GET /health.

All query logic lives in queries.py, shared with mcp_server.py, so the fix for the
is_complete bug (see db.py) exists in exactly one place.

No x402 payment gating yet (Michael's decision, pending). Every route is a side-effect-free
GET, so a paywall can be layered on later (e.g. x402 middleware in front of these same
handlers) without touching the query logic.

Run headless:
  pythonw.exe -m uvicorn main:app --host 127.0.0.1 --port 8420 > api.log 2>&1  (detached)
"""
from __future__ import annotations

from typing import Optional
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

import queries as q

app = FastAPI(
    title="402cap API",
    description="Measurement layer for the x402 agent-payment economy. Read-only, free, no payment gating yet.",
    version="0.1.0",
)


@app.get("/health")
def health():
    return q.health()


@app.get("/resources")
def list_resources(
    q_: Optional[str] = Query(None, alias="q", description="Substring search over service_name, host, resource_url"),
    host: Optional[str] = Query(None),
    curated: Optional[bool] = Query(None),
    is_templated: Optional[bool] = Query(None),
    is_deprecated: Optional[bool] = Query(None),
    has_builder_code: Optional[bool] = Query(None),
    min_price_usd: Optional[float] = Query(None),
    max_price_usd: Optional[float] = Query(None),
    sort: str = Query("l30d_total_calls_desc", description="l30d_total_calls_desc|price_asc|price_desc|host"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    return q.list_resources(
        q=q_, host=host, curated=curated, is_templated=is_templated, is_deprecated=is_deprecated,
        has_builder_code=has_builder_code, min_price_usd=min_price_usd, max_price_usd=max_price_usd,
        sort=sort, limit=limit, offset=offset,
    )


# NOTE: route order matters — Starlette's `:path` converter is greedy, so the more
# specific "/history" route MUST be registered before the bare "{resource_url:path}"
# route, or "/resources/<url>/history" gets swallowed whole as resource_url by the
# generic route and 404s. (Caught by curl-testing this exact URL — see verification notes.)
@app.get("/resources/{resource_url:path}/history")
def resource_history(resource_url: str, limit: int = Query(500, ge=1, le=5000), offset: int = Query(0, ge=0)):
    result = q.resource_history(resource_url, limit=limit, offset=offset)
    if result is None:
        raise HTTPException(status_code=404, detail="resource never observed (catalog or probe)")
    return result


@app.get("/resources/{resource_url:path}")
def get_resource(resource_url: str):
    result = q.get_resource(resource_url)
    if result is None:
        raise HTTPException(status_code=404, detail="resource not found in latest complete catalog")
    return result


@app.get("/changes")
def changes(
    since: Optional[str] = Query(None, description="ISO8601 timestamp; only events detected at/after this"),
    event_type: Optional[str] = Query(None, description="listed|disappeared|price_change|calls_change|payers_change|curation_change|deprecated_change|metadata_change"),
    host: Optional[str] = Query(None),
    resource_url: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=2000),
    offset: int = Query(0, ge=0),
):
    return q.changes(since=since, event_type=event_type, host=host, resource_url=resource_url,
                      limit=limit, offset=offset)


@app.get("/mismatches")
def mismatches(
    min_ratio: Optional[float] = Query(None, description="Only mismatches with max(ratio,1/ratio) >= this"),
    host: Optional[str] = Query(None),
    severity: Optional[str] = Query(None, description="CRITICAL|HIGH|LOW (case-insensitive) -- danger tier, not ratio tier"),
    limit: int = Query(100, ge=1, le=2000),
    offset: int = Query(0, ge=0),
):
    """The wedge safety signal. Served directly from mismatch_report.py's severity-tiered
    feed (regenerated on every snapshot), not recomputed here -- see queries.py."""
    return q.mismatches(min_ratio=min_ratio, host=host, severity=severity, limit=limit, offset=offset)


@app.get("/builder-codes")
def builder_codes(limit: int = Query(100, ge=1, le=2000), offset: int = Query(0, ge=0)):
    return q.builder_codes(limit=limit, offset=offset)


@app.exception_handler(Exception)
async def unhandled(request, exc):
    return JSONResponse(status_code=500, content={"detail": f"internal error: {type(exc).__name__}: {exc}"})
