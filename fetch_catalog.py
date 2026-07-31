"""
Fetch the full CDP Bazaar resource catalog into a timestamped local snapshot.

WHAT THIS READS
---------------
GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources
    ?limit=<=1000&offset=<n>          -- NO AUTH REQUIRED to read (verified live)

This is Coinbase's own index of x402 resources: what operators DECLARE about
themselves. It is the "claim" half of the dataset. The prober supplies the
"measured" half. They are never merged here.

HEADLESS: pure stdlib + httpx, no subprocess, no console window. Writes progress
to stdout; the caller redirects to logs/.

RUN
    python fetch_catalog.py                # full catalog
    python fetch_catalog.py --max-pages 2  # smoke test

WHAT WE DO NOT DO HERE
----------------------
No payment, no signing, no headers beyond User-Agent. This endpoint is a public
read; we still rate-limit it because hammering Coinbase's discovery API to build
a competing index would be both rude and a fast route to a block.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx

from x402_common import (
    CATALOG_URL,
    MIGRATIONS,
    USER_AGENT,
    atomic_to_usd,
    connect,
    jdump,
    pick_amount,
    pick_pay_to,
    resolve_decimals,
)

# The API clamps `limit` to [20, 1000]. Asking for 1000 is 16 requests for a
# 15.5k catalog instead of 776 — fewer requests IS the polite option here.
PAGE_LIMIT = 1000
# Delay between catalog pages. Small, because 16 sequential requests over ~20s
# is nothing; but not zero, because a tight loop against someone's API is how
# you get rate-limited into a partial snapshot that looks like a real one.
PAGE_DELAY_S = 1.0
REQUEST_TIMEOUT_S = 60.0


# Windows consoles and redirected pipes default to cp1252, which mangles every
# non-ASCII character in this file's output and can raise UnicodeEncodeError
# outright. The logs are the only way anyone sees these runs, so force UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(msg: str) -> None:
    """Line-buffered stdout. flush=True matters: this script is always run with
    output redirected to a log file, and without the flush the log stays empty
    for the whole run and looks hung."""
    print(f"[{utcnow()}] {msg}", flush=True)


def is_templated(path: str) -> bool:
    """True when the URL path contains a ':param' placeholder.

    Measured at 5.3% of a 1,000-record sample (e.g.
    `agents.chain.link/v1/operations/:workflowName`). These cannot be probed
    meaningfully as literals, so every liveness statistic must be reported both
    with and without them. Flagging at ingest is what makes that possible later.
    """
    return any(seg.startswith(":") for seg in path.split("/") if seg)


def summarise_accepts(accepts: list) -> dict:
    """Reduce `accepts[]` to the cheapest option plus violation flags.

    'Cheapest' is the honest headline: a caller pays the minimum they can. But
    comparing prices across different assets is not meaningful, so the minimum
    is taken over USD-convertible options when any exist, and falls back to the
    first option otherwise (recording that its price is unknown rather than
    pretending an unconvertible asset is free).
    """
    out = {
        "accepts_count": len(accepts),
        "min_amount_raw": None,
        "min_amount_field": None,
        "min_amount_network": None,
        "min_amount_asset": None,
        "min_amount_scheme": None,
        "min_amount_pay_to": None,
        "catalog_price_usd": None,
        "decimals_unknown": 0,
        "amount_format_violation": 0,
    }
    if not accepts:
        return out

    best = None  # (usd, accept, raw, field)
    fallback = None
    for a in accepts:
        if not isinstance(a, dict):
            continue
        raw, is_dec, is_num, field = pick_amount(a)
        if is_dec or is_num:
            # Spec violation: atomic-unit fields are string integers. ~137 of
            # 15.5k records ship a decimal string here (prior research; the
            # defect reproduces in our own sample). Flag it, never repair it.
            out["amount_format_violation"] = 1
        net, asset = a.get("network"), a.get("asset")
        usd = atomic_to_usd(raw, net, asset)
        if fallback is None:
            fallback = (a, raw, field)
        if usd is not None and (best is None or usd < best[0]):
            best = (usd, a, raw, field)

    if best is not None:
        usd, a, raw, field = best
        out["catalog_price_usd"] = usd
    elif fallback is not None:
        a, raw, field = fallback
        out["decimals_unknown"] = 1
    else:
        return out

    out["min_amount_raw"] = raw
    out["min_amount_field"] = field or None
    out["min_amount_network"] = a.get("network")
    out["min_amount_asset"] = a.get("asset")
    out["min_amount_scheme"] = a.get("scheme")
    out["min_amount_pay_to"] = pick_pay_to(a)
    if out["catalog_price_usd"] is None:
        out["decimals_unknown"] = 1
    elif resolve_decimals(a.get("network"), a.get("asset")) is None:
        out["decimals_unknown"] = 1
    return out


def _find_skill_url(obj, depth: int = 0):
    """Locate a `skillUrl` anywhere in the record, at any nesting depth.

    It is NOT at a fixed path: observed both at
    `extensions/<ns>/skillUrl` and `accepts[0]/extensions/<ns>/skillUrl`, under
    a vendor-specific namespace. A hard-coded path would find zero of them.
    Depth-capped so a pathological record cannot blow the stack.
    """
    if depth > 8:
        return None
    if isinstance(obj, dict):
        v = obj.get("skillUrl")
        if isinstance(v, str) and v:
            return v
        for sub in obj.values():
            found = _find_skill_url(sub, depth + 1)
            if found:
                return found
    elif isinstance(obj, list):
        for sub in obj:
            found = _find_skill_url(sub, depth + 1)
            if found:
                return found
    return None


def row_from_record(rec: dict, snapshot_id: int) -> tuple:
    resource = rec.get("resource") or ""
    parsed = urlparse(resource)
    accepts = rec.get("accepts") or []
    summ = summarise_accepts(accepts if isinstance(accepts, list) else [])

    quality = rec.get("quality") or {}
    if not isinstance(quality, dict):
        quality = {}
    # These three keys are the COMPLETE set of activity fields CDP exposes,
    # verified by enumerating every `quality` key across a 2,000-record sample.
    # There is no revenue field anywhere in the catalog.
    calls = quality.get("l30DaysTotalCalls")
    payers = quality.get("l30DaysUniquePayers")
    last_called = quality.get("lastCalledAt")

    # GMV is DERIVED, never reported by CDP: cheapest listed price x 30-day
    # calls. Left NULL (not 0) whenever price is unknown, because 0 would sink
    # into any SUM() as a confident statement that the route earned nothing.
    gmv = None
    if summ["catalog_price_usd"] is not None and isinstance(calls, (int, float)):
        gmv = summ["catalog_price_usd"] * calls

    ext = rec.get("extensions") or {}
    ext = ext if isinstance(ext, dict) else {}
    bazaar = ext.get("bazaar") if isinstance(ext, dict) else None
    bazaar = bazaar if isinstance(bazaar, dict) else None
    info = (bazaar or {}).get("info") or {}
    inp = info.get("input") if isinstance(info, dict) else None
    inp = inp if isinstance(inp, dict) else {}

    # Extension namespaces beyond `bazaar`. There are 39 distinct ones live in
    # the catalog (builder-code, discount, deprecated, pricing, offer-receipt,
    # sign-in-with-x, gas-sponsoring, …). Recording the NAME LIST per snapshot
    # makes "which conventions are spreading?" a time series for free, without
    # having to guess today which of them will matter.
    ext_names = sorted(k for k in ext.keys() if isinstance(k, str))

    # builder-code: `{"info": {"a": "bc_xxxx"}}`, described in its own schema as
    # "App builder code", present on ~17% of routes. This is the closest thing
    # to a referral/attribution rail that exists in x402 today, so it gets a
    # first-class column rather than living only inside raw_json.
    builder_code = None
    bc = ext.get("builder-code")
    if isinstance(bc, dict):
        bc_info = bc.get("info")
        if isinstance(bc_info, dict):
            v = bc_info.get("a")
            builder_code = v if isinstance(v, str) else None

    # `deprecated` is a bare boolean extension (observed value: literally true).
    is_deprecated = 1 if ext.get("deprecated") is True else (0 if "deprecated" in ext else None)
    has_discount = 1 if "discount" in ext else 0

    # skillUrl points at a hosted SKILL.md. CDP's own docs warn to treat that
    # content as UNTRUSTED INPUT. We record the URL only and NEVER fetch it —
    # fetching would pull third-party text into an agent's context, which is
    # precisely the prompt-injection path the warning is about. Stored so the
    # convention can be tracked, not so it can be followed.
    skill_url = _find_skill_url(rec)

    return (
        snapshot_id,
        resource,
        parsed.netloc or None,
        parsed.path or None,
        rec.get("serviceName"),
        rec.get("type"),
        rec.get("description"),
        rec.get("iconUrl"),
        1 if rec.get("curated") else (0 if "curated" in rec else None),
        rec.get("x402Version"),
        rec.get("lastUpdated"),
        calls if isinstance(calls, int) else None,
        payers if isinstance(payers, int) else None,
        last_called,
        gmv,
        1 if is_templated(parsed.path or "") else 0,
        summ["accepts_count"],
        summ["min_amount_raw"],
        summ["min_amount_field"],
        summ["min_amount_network"],
        summ["min_amount_asset"],
        summ["min_amount_scheme"],
        summ["min_amount_pay_to"],
        summ["catalog_price_usd"],
        summ["decimals_unknown"],
        summ["amount_format_violation"],
        1 if bazaar else 0,
        1 if (bazaar and bazaar.get("schema")) else 0,
        (inp.get("method") or None),
        (bazaar or {}).get("routeTemplate"),
        jdump(rec.get("tags")) if rec.get("tags") is not None else None,
        # referral_json: full builder-code extension object (a/s/w), not just
        # the 'a' field the builder_code column captures. 's' (service) and
        # 'w' (wallet) codes are unpopulated in every route observed so far
        # (2026-07-31 snapshot) but this future-proofs their capture without a
        # schema change once they start appearing.
        jdump(bc) if isinstance(bc, dict) else None,
        jdump(rec),                 # verbatim record — the thing that makes this compound
        skill_url,
        builder_code,
        jdump(ext_names),
        is_deprecated,
        has_discount,
    )


INSERT_SQL = """
INSERT INTO catalog_resource (
    snapshot_id, resource_url, host, url_path, service_name, resource_type,
    description, icon_url, curated, catalog_x402_version, last_updated,
    l30d_total_calls, l30d_unique_payers, last_called_at, est_gmv_30d_usd,
    is_templated, accepts_count, min_amount_raw, min_amount_field,
    min_amount_network, min_amount_asset, min_amount_scheme, min_amount_pay_to,
    catalog_price_usd, decimals_unknown, amount_format_violation,
    has_bazaar_ext, has_bazaar_schema, bazaar_method, bazaar_route_template,
    tags_json, referral_json, raw_json,
    skill_url, builder_code, extension_names_json, is_deprecated, has_discount_ext
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
"""


def rebuild_resource_dim(conn) -> None:
    """Rebuild the first-seen/last-seen index from scratch.

    Full rebuild rather than incremental update because it is derived data over
    a table that only grows — a rebuild is cheap, always correct, and cannot
    drift. An incremental version would be the kind of thing that quietly
    desynchronises and makes "new listings this week" wrong for months.
    """
    conn.execute("DELETE FROM resource_dim")
    # The aggregate is computed in a subquery and the snapshot timestamps are
    # JOINed in. SQLite rejects an aggregate inside a correlated subquery in the
    # select list ("misuse of aggregate function MIN()"), so the obvious
    # single-pass form does not compile.
    #
    # Explicit column list below (Backlog #18) is load-bearing, not cosmetic:
    # `INSERT INTO resource_dim SELECT ...` with no column list is POSITIONAL
    # and requires the SELECT to produce exactly as many columns as the table
    # has.
    #
    # Sprint 6: resource_dim (now keyed PRIMARY KEY (source, resource_url) --
    # see x402_common._migrate_resource_dim_key) is grouped by
    # (source, resource_url), matching v_latest_catalog's partitioning. Before
    # this fix, GROUP BY resource_url alone meant two different facilitators'
    # rows for the same resource_url string would collapse into ONE
    # resource_dim row, silently merging their first_seen/last_seen/times_seen
    # -- exactly the fabricated-identity bug this task exists to prevent.
    # `source` comes straight off catalog_resource (its own per-row copy, set
    # at fetch time from the owning snapshot), not a join back to
    # catalog_snapshot, so no extra join is introduced.
    conn.execute("""
        INSERT INTO resource_dim
            (source, resource_url, host, first_seen_snapshot, first_seen_at,
             last_seen_snapshot, last_seen_at, times_seen)
        SELECT g.source, g.resource_url, g.host,
               g.first_s, s1.fetched_at,
               g.last_s,  s2.fetched_at,
               g.times_seen
        FROM (
            SELECT source, resource_url,
                   MAX(host)                  AS host,
                   MIN(snapshot_id)           AS first_s,
                   MAX(snapshot_id)           AS last_s,
                   COUNT(DISTINCT snapshot_id) AS times_seen
            FROM catalog_resource
            WHERE resource_url IS NOT NULL AND resource_url <> ''
              -- COMPLETE snapshots only. A partial (--max-pages) snapshot
              -- contains an arbitrary prefix of the catalog, so including it
              -- would stamp first_seen=<partial snapshot> on exactly the routes
              -- that happened to land in the first N pages and a later snapshot
              -- on everyone else. "New listings since first observation" would
              -- then be quietly wrong for thousands of routes, with nothing in
              -- the output hinting at why.
              AND snapshot_id IN (SELECT id FROM catalog_snapshot WHERE is_complete = 1)
            GROUP BY source, resource_url
        ) g
        LEFT JOIN catalog_snapshot s1 ON s1.id = g.first_s
        LEFT JOIN catalog_snapshot s2 ON s2.id = g.last_s
    """)
    conn.commit()


# ---------------------------------------------------------------------------
# Churn: diff this snapshot against the previous COMPLETE one
# ---------------------------------------------------------------------------
# Why this is the most valuable thing in the project, stated plainly so nobody
# optimises it away: CDP recomputes quality metrics every ~6 hours and
# OVERWRITES them, and it REMOVES any resource that has not settled a payment in
# 30 days. Upstream therefore cannot answer "what died?", "what is decaying?",
# or "what did this cost last week?" — that data is destroyed on write.
#
# We diff every fetch and keep the result forever. A disappeared resource is
# never deleted here; it simply stops appearing in new snapshots, and a
# 'disappeared' event records the moment. Their deletion is our data.

# Fields compared for a plain metadata edit. Kept deliberately short: comparing
# every column would drown genuine signal in churn from CDP's own recomputation.
_META_FIELDS = [
    ("service_name", "metadata_change"),
    ("description", "metadata_change"),
    ("bazaar_method", "metadata_change"),
    ("min_amount_network", "metadata_change"),
    ("min_amount_pay_to", "metadata_change"),
    ("builder_code", "metadata_change"),
    ("skill_url", "metadata_change"),
]


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def diff_snapshots(conn, to_snap: int) -> dict:
    """Emit change_event rows for to_snap vs the previous COMPLETE snapshot
    FROM THE SAME SOURCE.

    Only complete snapshots are compared. Diffing a partial (--max-pages)
    snapshot against a full one would report ~14,500 fake 'disappeared' events
    and permanently pollute the churn history with a fiction.

    Sprint 6: the "previous complete snapshot" lookup is scoped to
    to_snap's own `source`. Before this fix it searched globally across ALL
    sources, so a second facilitator's first snapshot would get diffed against
    the most recent CDP snapshot -- two disjoint facilitators' independent
    observations of the same resource_url string -- and manufacture fake
    price_change/calls_change/disappeared events out of nothing. This function
    is now guaranteed to only ever compare two snapshots that share a source;
    `load(sid)`'s dict, keyed by bare `resource_url`, is safe BECAUSE both
    `sid`s it is ever called with (from_snap, to_snap) are already
    source-matched by the query below -- it is never used across a source
    boundary.
    """
    to_source_row = conn.execute(
        "SELECT source FROM catalog_snapshot WHERE id = ?", (to_snap,)).fetchone()
    to_source = to_source_row[0] if to_source_row else "cdp"
    prev = conn.execute("""
        SELECT id FROM catalog_snapshot
        WHERE id < ? AND is_complete = 1 AND source = ?
        ORDER BY id DESC LIMIT 1""", (to_snap, to_source)).fetchone()
    if not prev:
        log(f"no previous complete snapshot for source={to_source!r} — nothing to diff "
            "(this is normal on this source's run 1)")
        return {}
    from_snap = prev[0]

    # Belt-and-suspenders on top of the source-matched query above: if to_snap
    # and from_snap ever disagree on source (a future bug in the query, a bad
    # manual snapshot_id, etc.), fail loudly here rather than let load()'s
    # bare-resource_url dict silently blend two facilitators' rows.
    from_source_row = conn.execute(
        "SELECT source FROM catalog_snapshot WHERE id = ?", (from_snap,)).fetchone()
    from_source = from_source_row[0] if from_source_row else None
    if from_source != to_source:
        raise RuntimeError(
            f"diff_snapshots: source mismatch between snapshot {from_snap} "
            f"(source={from_source!r}) and snapshot {to_snap} (source={to_source!r}) "
            "-- refusing to diff across sources")

    cols = ("resource_url, host, catalog_price_usd, min_amount_raw, l30d_total_calls, "
            "l30d_unique_payers, curated, is_deprecated, service_name, description, "
            "bazaar_method, min_amount_network, min_amount_pay_to, builder_code, skill_url")
    def load(sid):
        # Single-source invariant: one snapshot_id must contain rows from
        # exactly one source. This dict is keyed by bare resource_url with no
        # source qualifier -- safe ONLY as long as that invariant holds. If a
        # second source's rows ever land under this snapshot_id (e.g. a bad
        # ingest write), fail loudly here instead of silently blending two
        # facilitators' catalog rows under the same key.
        sources = [r[0] for r in conn.execute(
            "SELECT DISTINCT source FROM catalog_resource WHERE snapshot_id = ?", (sid,))]
        if len(sources) > 1:
            raise RuntimeError(
                f"diff_snapshots.load: snapshot_id={sid} has rows from multiple "
                f"sources {sources!r} -- single-source-per-snapshot invariant violated")
        return {r["resource_url"]: dict(r) for r in conn.execute(
            f"SELECT {cols} FROM catalog_resource WHERE snapshot_id=? AND resource_url IS NOT NULL",
            (sid,))}

    # A field is comparable only if BOTH snapshots captured it. Comparing a
    # column that did not exist on the older snapshot reads every populated
    # value as a fresh change: the first run of this diff emitted 2,701 bogus
    # metadata_change events purely because builder_code had just been added.
    def captured(sid):
        row = conn.execute(
            "SELECT captured_fields_json FROM catalog_snapshot WHERE id=?", (sid,)).fetchone()
        if not row or not row[0]:
            return set()
        try:
            return set(json.loads(row[0]))
        except (ValueError, TypeError):
            return set()

    comparable = captured(from_snap) & captured(to_snap)
    # Columns that predate the migration system are always comparable.
    comparable |= {"catalog_price_usd", "min_amount_raw", "l30d_total_calls",
                   "l30d_unique_payers", "curated", "service_name", "description",
                   "bazaar_method", "min_amount_network", "min_amount_pay_to"}

    old, new = load(from_snap), load(to_snap)
    now = utcnow()
    events = []
    counts = defaultdict_int()

    def emit(url, host, etype, field=None, ov=None, nv=None):
        a, b = _num(ov), _num(nv)
        delta = (b - a) if (a is not None and b is not None) else None
        ratio = (b / a) if (a not in (None, 0) and b is not None) else None
        events.append((now, from_snap, to_snap, url, host, etype, field,
                       None if ov is None else str(ov),
                       None if nv is None else str(nv), delta, ratio, to_source))
        counts[etype] += 1

    for url, n in new.items():
        o = old.get(url)
        if o is None:
            emit(url, n["host"], "listed")
            continue
        # Price. Compared on the USD-converted value when both sides have one,
        # else on the raw atomic string — so a repricing on an asset we cannot
        # convert still registers as a change instead of vanishing.
        op, np_ = o["catalog_price_usd"], n["catalog_price_usd"]
        if op is not None and np_ is not None:
            if abs(op - np_) > 1e-12:
                emit(url, n["host"], "price_change", "catalog_price_usd", op, np_)
        elif o["min_amount_raw"] != n["min_amount_raw"]:
            emit(url, n["host"], "price_change", "min_amount_raw",
                 o["min_amount_raw"], n["min_amount_raw"])
        # Activity. These are the fields CDP overwrites every ~6h.
        for f, et in (("l30d_total_calls", "calls_change"),
                      ("l30d_unique_payers", "payers_change")):
            if o[f] != n[f]:
                emit(url, n["host"], et, f, o[f], n[f])
        if o["curated"] != n["curated"]:
            emit(url, n["host"], "curation_change", "curated", o["curated"], n["curated"])
        if "is_deprecated" in comparable and o["is_deprecated"] != n["is_deprecated"]:
            emit(url, n["host"], "deprecated_change", "is_deprecated",
                 o["is_deprecated"], n["is_deprecated"])
        for f, et in _META_FIELDS:
            if f in comparable and o.get(f) != n.get(f):
                emit(url, n["host"], et, f, o.get(f), n.get(f))

    for url, o in old.items():
        if url not in new:
            # The 30-day-no-settlement cliff. This row is the single most
            # perishable fact in the whole ecosystem: it exists nowhere upstream
            # one second after CDP drops the listing.
            emit(url, o["host"], "disappeared")

    conn.executemany("""
        INSERT INTO change_event (detected_at, from_snapshot, to_snapshot, resource_url,
            host, event_type, field, old_value, new_value, delta_num, ratio_num, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", events)
    conn.commit()
    # Precedence trap: `"a: " + ", ".join(...) or "no changes"` binds `or` to the
    # WHOLE concatenation, which is always truthy, so the fallback never fired
    # and a no-change diff logged as a bare "churn vs snapshot 5: ".
    summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "no changes"
    log(f"churn vs snapshot {from_snap}: {summary}")
    return counts


def defaultdict_int():
    from collections import defaultdict
    return defaultdict(int)


def main() -> int:
    ap = argparse.ArgumentParser(description="Snapshot the CDP Bazaar catalog into SQLite.")
    ap.add_argument("--max-pages", type=int, default=0,
                    help="stop after N pages (0 = all). Use 1-2 for a smoke test.")
    ap.add_argument("--limit", type=int, default=PAGE_LIMIT, help="page size, API caps at 1000")
    args = ap.parse_args()

    conn = connect()
    started = time.monotonic()
    # Stamp the snapshot with the optional columns this build actually fills.
    # The churn diff compares a field ONLY when both snapshots captured it.
    captured = sorted({c for t, c, _ in MIGRATIONS if t == "catalog_resource"})
    cur = conn.execute(
        "INSERT INTO catalog_snapshot (fetched_at, source_url, notes, captured_fields_json) "
        "VALUES (?,?,?,?)",
        (utcnow(), CATALOG_URL, "unauthenticated read; declared metadata only",
         jdump(captured)),
    )
    snapshot_id = cur.lastrowid
    conn.commit()
    log(f"snapshot {snapshot_id} started")

    stored = pages = 0
    total_reported = None
    # Set only when the loop terminates because it reached the catalog's end
    # (server clamped the offset, or served a short/empty page). Any other exit
    # — HTTP error, transport failure — leaves it False and the snapshot is
    # never diffed.
    reached_end = False
    offset = 0
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}

    with httpx.Client(timeout=REQUEST_TIMEOUT_S, headers=headers, follow_redirects=True) as client:
        while True:
            try:
                r = client.get(CATALOG_URL, params={"limit": args.limit, "offset": offset})
            except httpx.HTTPError as exc:
                # Partial snapshots are worse than none if they look complete,
                # so the failure is recorded in the snapshot notes rather than
                # left for a reader to infer from a short row count.
                log(f"ERROR page offset={offset}: {type(exc).__name__}: {exc}")
                conn.execute("UPDATE catalog_snapshot SET notes = notes || ? WHERE id = ?",
                             (f" | ABORTED at offset {offset}: {type(exc).__name__}", snapshot_id))
                conn.commit()
                break

            if r.status_code == 429:
                # Honour the throttle rather than retrying immediately.
                wait = float(r.headers.get("Retry-After") or 30)
                log(f"429 at offset={offset}, sleeping {wait}s")
                time.sleep(min(wait, 120))
                continue
            if r.status_code != 200:
                log(f"ERROR HTTP {r.status_code} at offset={offset}: {r.text[:300]}")
                break

            payload = r.json()
            items = payload.get("items") or []
            pag = payload.get("pagination") or {}
            if total_reported is None:
                total_reported = pag.get("total")
                log(f"catalog reports total={total_reported}")

            # UPSTREAM TRAP, measured directly: an out-of-range `offset` is NOT
            # an error and NOT an empty page. The API CLAMPS it and silently
            # re-serves the last page, echoing the clamped value back in
            # `pagination.offset`. Requesting offset=15522 against total=15522
            # returns the same 522 rows as offset=15000.
            #
            # Two consequences, both bad and both silent: duplicate rows in the
            # snapshot, and — because `total` drifts UPWARD while a fetch is in
            # flight (15520 -> 15524 across two runs minutes apart) — a loop that
            # keeps chasing a moving target. The first run of this fetcher stored
            # 16,044 rows for a 15,522-row catalog before this guard existed.
            #
            # The echoed offset is the authoritative signal that we have run off
            # the end. Trust it over our own arithmetic and over `total`.
            echoed = pag.get("offset")
            if isinstance(echoed, int) and echoed != offset:
                log(f"server clamped offset {offset} -> {echoed}; end of catalog, discarding page")
                reached_end = True
                break

            rows = [row_from_record(rec, snapshot_id) for rec in items if isinstance(rec, dict)]
            conn.executemany(INSERT_SQL, rows)
            conn.commit()
            stored += len(rows)
            pages += 1
            log(f"page {pages} offset={offset} items={len(items)} stored_total={stored}")

            # A short page (fewer than the clamped page size) or an empty one is
            # the other legitimate end-of-catalog signal.
            if not items:
                reached_end = True
                break
            if len(items) < args.limit:
                reached_end = True
                if not args.max_pages:
                    break
            if args.max_pages and pages >= args.max_pages:
                break
            # The API returns the clamped page size, not the one we asked for;
            # advancing by len(items) rather than by our requested limit is what
            # prevents silently skipping records when the clamp kicks in.
            offset += len(items)
            time.sleep(PAGE_DELAY_S)

    dur = time.monotonic() - started
    is_complete = 1 if (reached_end and not args.max_pages) else 0
    conn.execute(
        "UPDATE catalog_snapshot SET total_reported=?, rows_stored=?, pages_fetched=?, "
        "duration_s=?, is_complete=? WHERE id=?",
        (total_reported, stored, pages, round(dur, 2), is_complete, snapshot_id),
    )
    conn.commit()
    rebuild_resource_dim(conn)
    # Diff only a snapshot we actually finished. A snapshot aborted mid-fetch
    # would otherwise emit thousands of false 'disappeared' events that are
    # indistinguishable from real ones once written.
    if is_complete:
        diff_snapshots(conn, snapshot_id)
    else:
        log(f"snapshot incomplete ({stored} rows, reached_end={reached_end}) — churn diff SKIPPED")
    log(f"snapshot {snapshot_id} done: {stored} rows, {pages} pages, {dur:.1f}s")

    hosts = conn.execute(
        "SELECT COUNT(DISTINCT host) FROM catalog_resource WHERE snapshot_id=?", (snapshot_id,)
    ).fetchone()[0]
    log(f"distinct hosts in snapshot: {hosts}")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
