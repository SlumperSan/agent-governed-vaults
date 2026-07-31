"""
Unpaid x402 probe: knock on every listed route and record what actually answers.

THE CORE IDEA
-------------
An UNPAID HTTP request to an x402 endpoint returns its 402 challenge — the real
price, the real asset and network, the spec version, the bazaar extension, and
proof the host is alive. It costs nothing and moves no money. The CDP Bazaar
publishes what operators DECLARE. This measures what they actually DO. That gap
is the entire product.

MONEY: NONE MOVES HERE. This module never constructs an X-PAYMENT or
PAYMENT-SIGNATURE header, never signs anything, never touches a key, never sends
a request body. It reads the challenge and hangs up. If you are extending this
file and find yourself importing a signer, you are in the wrong file.

WHY A NO-BODY POST IS SAFE (and why we never send the declared example body)
---------------------------------------------------------------------------
58% of listed routes declare GET, 42% POST. Probing a POST route with GET makes
it look dead (405), so we use the declared method. But we send NO body, ever.
In every x402 implementation the paywall is MIDDLEWARE: it returns 402 before
the route handler is reached, so an unpaid request cannot trigger a side effect
on a correctly built route. On an INCORRECTLY built one — no paywall — a no-body
POST gets rejected as malformed rather than executing anything, and that
non-402 answer is exactly the measurement we want. Sending the catalog's example
body would invert this: it would make an unpaywalled route actually run.

POLITENESS
----------
Serialisation is PER HOST, not a flat semaphore. 15.5k routes live on ~1,576
hosts and the distribution is brutally skewed — one host in our sample owns 70
routes. A global Semaphore(10) over a flat list puts 10 concurrent requests on
that one host. Instead: one in-flight request per host, a delay between
consecutive requests to the same host, and N hosts worked in parallel. A 429
from a host backs that host off without stalling the others.

HEADLESS: asyncio + httpx in-process. No subprocess, no console window. All
output to stdout for the caller to redirect.

RUN
    python probe.py --sample 20              # host-diverse sample (default)
    python probe.py --all                    # every resource in the snapshot
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import json
import ssl
import sys
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx

try:
    from jsonschema import Draft202012Validator
except ImportError:  # schema validity becomes "unknown", not a crash
    Draft202012Validator = None

from x402_common import (
    USER_AGENT,
    atomic_to_usd,
    connect,
    jdump,
    pick_amount,
    pick_pay_to,
    resolve_decimals,
)

# 15s total, not 30. Dead hosts are the long pole in any sweep of this size, and
# a doubled timeout doubles the runtime of the sweep without changing a single
# verdict — anything that has not answered in 15s is not a live paid API.
TIMEOUT_S = 15.0
# Max redirects to follow. An unfollowed 301 http->https reads as a false dead,
# which would be a large systematic error. Three is enough for scheme and
# trailing-slash normalisation without chasing a redirect loop.
MAX_REDIRECTS = 3
DEFAULT_HOST_CONCURRENCY = 8      # distinct hosts worked at once
DEFAULT_PER_HOST_DELAY = 1.5      # seconds between requests to the SAME host
BODY_SNIPPET_CHARS = 2000

EVM_ADDR_LEN = 42


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
    print(f"[{utcnow()}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Transport failure classification
# ---------------------------------------------------------------------------
def classify_error(exc: BaseException) -> str:
    """DNS / connect / TLS / timeout / redirects are FIVE different findings.

    Collapsing them into one "dead" column throws away the most useful signal in
    the dataset: a TLS failure is an operator with an expired cert (fixable, and
    they probably do not know), NXDOMAIN is an abandoned domain, and a connection
    refused is a host that exists but stopped serving. Those are different
    stories about the health of the ecosystem.
    """
    chain = []
    e: BaseException | None = exc
    while e is not None and len(chain) < 8:
        chain.append(e)
        e = e.__cause__ or e.__context__
    names = " ".join(type(x).__name__ for x in chain)
    text = " ".join(str(x) for x in chain).lower()

    if any(isinstance(x, ssl.SSLError) for x in chain) or "ssl" in names.lower() \
            or "certificate" in text or "tlsv1" in text:
        return "tls"
    if isinstance(exc, httpx.TooManyRedirects):
        return "redirects"
    if isinstance(exc, (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout,
                        httpx.PoolTimeout, asyncio.TimeoutError, TimeoutError)):
        return "timeout"
    if "getaddrinfo" in text or "name or service not known" in text \
            or "nodename nor servname" in text or "temporary failure in name resolution" in text \
            or "no address associated" in text or "11001" in text or "11004" in text:
        return "dns"
    if isinstance(exc, httpx.ConnectError):
        return "connect"
    if isinstance(exc, (httpx.RemoteProtocolError, httpx.LocalProtocolError,
                        httpx.UnsupportedProtocol, httpx.InvalidURL)):
        return "protocol"
    if isinstance(exc, httpx.ReadError):
        return "connect"
    return "other"


# ---------------------------------------------------------------------------
# Challenge parsing — v1 and v2 both exist in the wild
# ---------------------------------------------------------------------------
def decode_payment_required_header(raw: str) -> tuple[dict | None, str | None]:
    """Decode the v2 PAYMENT-REQUIRED header: STANDARD base64 of UTF-8 JSON.

    Standard, not URL-safe, and not a JWT — verified in the v2 spec notes by
    round-tripping the spec's own literal example. Padding is present. We accept
    a missing-padding variant too, because an operator who strips '=' is
    non-compliant but still evidently trying, and recording them as "no
    challenge at all" would overstate how dead the ecosystem is.

    Returns (parsed_or_None, violation_code_or_None).
    """
    s = (raw or "").strip()
    if not s:
        return None, None
    for candidate, pad_fixed in ((s, False), (s + "=" * (-len(s) % 4), True)):
        try:
            blob = base64.b64decode(candidate, validate=False)
        except (binascii.Error, ValueError):
            continue
        try:
            obj = json.loads(blob.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(obj, dict):
            return obj, ("v2_header_base64_unpadded" if pad_fixed else None)
    return None, "v2_header_undecodable"


def extract_accepts(challenge: dict) -> list:
    a = challenge.get("accepts")
    return a if isinstance(a, list) else []


def check_schema_valid(schema) -> bool | None:
    """Is the declared bazaar schema a legal JSON Schema (Draft 2020-12)?

    check_schema validates the SCHEMA ITSELF, not any instance against it. That
    is the right test: CDP rejects a listing whose schema is malformed, so a
    schema that will not compile is a concrete, actionable defect for the
    operator. Returns None when we could not check (jsonschema missing), so
    "unchecked" never masquerades as "valid".
    """
    if schema is None:
        return None
    if Draft202012Validator is None:
        return None
    try:
        Draft202012Validator.check_schema(schema)
        return True
    except Exception:
        return False


def analyse_challenge(challenge: dict, version: int, status: int) -> dict:
    """Turn a decoded challenge into derived fields + a violation code list.

    Every code here names a concrete, checkable deviation from the x402 spec.
    Nothing is inferred about intent and nothing is repaired.
    """
    v: list[str] = []
    out = {
        "probed_scheme": None, "probed_network": None, "probed_asset": None,
        "probed_pay_to": None, "probed_amount_raw": None, "probed_price_usd": None,
        "probed_decimals_unknown": 0, "probed_accepts_count": 0,
        "bazaar_ext_present": 0, "bazaar_schema_present": 0, "bazaar_schema_valid": None,
        "is_valid_402": 0,
    }

    if status != 402:
        # A challenge served on a non-402 status. Clients key off the status
        # code, so this route is undiscoverable to a conforming client even
        # though the operator clearly built one.
        v.append("challenge_on_non_402_status")

    declared = challenge.get("x402Version")
    if declared is None:
        v.append("missing_x402Version")
    elif declared != version:
        v.append("version_field_disagrees_with_transport")

    accepts = extract_accepts(challenge)
    out["probed_accepts_count"] = len(accepts)
    if not accepts:
        v.append("accepts_missing_or_empty")

    best = None
    fallback = None
    for a in accepts:
        if not isinstance(a, dict):
            v.append("accepts_entry_not_object")
            continue
        raw, is_dec, is_num, field = pick_amount(a)
        if not field:
            v.append("amount_field_absent")
        if is_num:
            v.append("amount_is_json_number_not_string")
        if is_dec:
            # The atomic-unit field holding a decimal. ~137 of 15.5k catalog
            # records do this; we check whether the live wire repeats it.
            v.append("amount_is_decimal_not_atomic_units")
        if version == 1 and "maxAmountRequired" not in a and "amount" in a:
            v.append("v1_uses_v2_amount_field")
        if version == 2 and "amount" not in a and "maxAmountRequired" in a:
            v.append("v2_uses_v1_maxAmountRequired_field")
        if not a.get("asset"):
            v.append("missing_asset")
        pay_to = pick_pay_to(a)
        if not pay_to:
            v.append("missing_payTo")
        elif isinstance(pay_to, str) and pay_to.startswith("0x") and len(pay_to) != EVM_ADDR_LEN:
            v.append("payTo_malformed_evm_address")
        net = a.get("network")
        if not net:
            v.append("missing_network")
        elif version == 2 and isinstance(net, str) and ":" not in net:
            # v2 networks are CAIP-2 ("eip155:8453"). A bare v1 slug ("base") on
            # a v2 challenge is what makes a conforming v2 client fail to select
            # a payment scheme — a silent unpayability, not a cosmetic issue.
            v.append("v2_network_not_caip2")
        if "outputSchema" in a and a["outputSchema"] is None:
            # The v1 spec's own example does this, but the official client's zod
            # parser rejects null and throws. Documented trap, worth counting.
            v.append("outputSchema_null")

        usd = atomic_to_usd(raw, net, a.get("asset"))
        if fallback is None:
            fallback = (a, raw, usd)
        if usd is not None and (best is None or usd < best[2]):
            best = (a, raw, usd)

    chosen = best or fallback
    if chosen:
        a, raw, usd = chosen
        out["probed_scheme"] = a.get("scheme")
        out["probed_network"] = a.get("network")
        out["probed_asset"] = a.get("asset")
        out["probed_pay_to"] = pick_pay_to(a)
        out["probed_amount_raw"] = raw
        out["probed_price_usd"] = usd
        out["probed_decimals_unknown"] = 0 if usd is not None else 1
        if not a.get("scheme"):
            v.append("missing_scheme")

    exts = challenge.get("extensions")
    bazaar = exts.get("bazaar") if isinstance(exts, dict) else None
    if isinstance(bazaar, dict):
        out["bazaar_ext_present"] = 1
        schema = bazaar.get("schema")
        out["bazaar_schema_present"] = 1 if schema is not None else 0
        if schema is None:
            # No schema means CDP cannot index the listing at all, per its own
            # docs. The route is live and paid but invisible to discovery.
            v.append("bazaar_schema_missing")
        else:
            ok = check_schema_valid(schema)
            out["bazaar_schema_valid"] = None if ok is None else (1 if ok else 0)
            if ok is False:
                v.append("bazaar_schema_invalid")
        if not (bazaar.get("info") or {}):
            v.append("bazaar_info_missing")
    else:
        # Not a protocol violation — the extension is optional in x402 — but it
        # IS the sole mechanism by which a route gets into the CDP catalog, so
        # its absence on a *listed* route is a genuine inconsistency worth
        # counting separately from a spec break.
        v.append("bazaar_extension_absent_on_wire")

    out["is_valid_402"] = 1 if (status == 402 and accepts and chosen) else 0
    return out, v


# ---------------------------------------------------------------------------
# The probe itself
# ---------------------------------------------------------------------------
async def probe_one(client: httpx.AsyncClient, rec: dict) -> dict:
    """One unpaid request. Returns a fully-populated probe row dict."""
    url = rec["resource_url"]
    # Use the DECLARED method. Probing a POST route with GET yields 405 and
    # would count 42% of the catalog as broken.
    method = (rec.get("bazaar_method") or "GET").upper()
    if method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
        method = "GET"

    row = {
        "resource_url": url, "host": rec["host"], "request_method": method,
        "request_url": url, "final_url": None, "redirect_count": 0,
        "is_templated": rec.get("is_templated") or 0,
        "http_status": None, "latency_ms": None,
        "transport_error_class": None, "transport_error": None,
        "payment_required_header_b64": None, "has_payment_required_header": 0,
        "body_x402_version": None, "challenge_json": None,
        "response_headers_json": None, "body_snippet": None,
        "is_valid_402": 0, "detected_version": None, "version_source": None,
        "probed_scheme": None, "probed_network": None, "probed_asset": None,
        "probed_pay_to": None, "probed_amount_raw": None, "probed_price_usd": None,
        "probed_decimals_unknown": 0, "probed_accepts_count": 0,
        "bazaar_ext_present": 0, "bazaar_schema_present": 0, "bazaar_schema_valid": None,
        "spec_violations": None, "violation_count": 0,
    }

    t0 = time.perf_counter()
    try:
        # NO body, NO payment headers. `content=None` is explicit, not a default
        # we are relying on: this is the line that guarantees an unpaywalled POST
        # route cannot be made to execute by our probe.
        resp = await client.request(method, url, content=None)
    except Exception as exc:  # noqa: BLE001 - every failure is data, none is fatal
        row["latency_ms"] = int((time.perf_counter() - t0) * 1000)
        row["transport_error_class"] = classify_error(exc)
        row["transport_error"] = f"{type(exc).__name__}: {exc}"[:500]
        return row

    row["latency_ms"] = int((time.perf_counter() - t0) * 1000)
    row["http_status"] = resp.status_code
    row["final_url"] = str(resp.url)
    row["redirect_count"] = len(resp.history)
    row["response_headers_json"] = jdump(dict(resp.headers))

    try:
        text = resp.text
    except Exception:
        text = ""
    row["body_snippet"] = text[:BODY_SNIPPET_CHARS] if text else None

    # ---- version detection, header first ----------------------------------
    # Precedence matches every reference client we could read (Python, TS, and
    # pay.sh's Rust): PAYMENT-REQUIRED header => v2; else body x402Version => v1.
    # Getting this order wrong would misreport dual-emitting servers (v2 header
    # + v1 body for legacy reach) as v1-only.
    hdr = resp.headers.get("PAYMENT-REQUIRED") or resp.headers.get("payment-required")
    challenge = None
    violations: list[str] = []
    if hdr:
        row["has_payment_required_header"] = 1
        row["payment_required_header_b64"] = hdr[:8000]
        challenge, vcode = decode_payment_required_header(hdr)
        if vcode:
            violations.append(vcode)
        if challenge is not None:
            row["detected_version"] = 2
            row["version_source"] = "header"

    body_obj = None
    if text:
        try:
            body_obj = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            body_obj = None
    if isinstance(body_obj, dict):
        bv = body_obj.get("x402Version")
        if isinstance(bv, int):
            row["body_x402_version"] = bv
        if challenge is None and isinstance(body_obj.get("accepts"), list):
            challenge = body_obj
            row["detected_version"] = bv if isinstance(bv, int) else 1
            row["version_source"] = "body"

    if challenge is not None:
        row["challenge_json"] = jdump(challenge)[:20000]
        derived, vs = analyse_challenge(challenge, row["detected_version"] or 2, resp.status_code)
        row.update(derived)
        violations.extend(vs)
    elif resp.status_code == 402:
        # 402 with nothing parseable behind it: the status says "pay me" and
        # gives a client no way to do so.
        violations.append("status_402_without_parseable_challenge")

    if violations:
        row["spec_violations"] = jdump(sorted(set(violations)))
        row["violation_count"] = len(set(violations))
    return row


async def host_worker(host: str, items: list[dict], client: httpx.AsyncClient,
                      out: list, delay: float, counter: dict) -> None:
    """Drain ONE host's queue strictly sequentially.

    This function existing at all is the politeness guarantee: parallelism is
    across hosts, never within one. A host with 70 listed routes gets 70
    requests spaced `delay` apart, not 70 at once.
    """
    for rec in items:
        row = await probe_one(client, rec)
        row["_catalog_resource_id"] = rec["id"]
        out.append(row)
        counter["done"] += 1
        if counter["done"] % 10 == 0:
            log(f"  probed {counter['done']}/{counter['total']}")

        if row["http_status"] == 429:
            # A host telling us to slow down gets obeyed, and only that host
            # pauses — the sweep keeps moving elsewhere.
            wait = 30.0
            try:
                wait = float(row and json.loads(row["response_headers_json"] or "{}")
                             .get("retry-after", 30))
            except (ValueError, TypeError, json.JSONDecodeError):
                pass
            log(f"  429 from {host}; backing off {min(wait, 120):.0f}s")
            await asyncio.sleep(min(wait, 120.0))
        if rec is not items[-1]:
            await asyncio.sleep(delay)


def select_sample(conn, snapshot_id: int, n: int, mode: str, host_filter: str | None):
    """Pick which resources to probe.

    HOST-DIVERSE BY DEFAULT, and that is not cosmetic. The catalog is ordered by
    registration, so `LIMIT 20` returns roughly two hosts' worth of routes — a
    sample that measures two operators and tells you nothing about the
    ecosystem, while also concentrating all the traffic on those two. Round-robin
    over hosts is simultaneously the politer and the more informative choice.
    """
    rows = conn.execute("""
        SELECT id, resource_url, host, bazaar_method, is_templated
        FROM catalog_resource
        WHERE snapshot_id = ? AND resource_url LIKE 'http%'
        ORDER BY id
    """, (snapshot_id,)).fetchall()
    recs = [dict(r) for r in rows]
    if host_filter:
        # Comma-separated so a targeted run can cover a set of operators (e.g.
        # every host that declares x402Version 1) in ONE probe_run. Without
        # this, verifying a cross-host hypothesis means N separate runs and the
        # report's per-run aggregates stop being comparable.
        wanted = {h.strip() for h in host_filter.split(",") if h.strip()}
        recs = [r for r in recs if r["host"] in wanted]
        return recs
    if mode == "all":
        return recs

    by_host: dict[str, deque] = defaultdict(deque)
    for r in recs:
        by_host[r["host"]].append(r)
    picked, hosts = [], deque(by_host.keys())
    while hosts and len(picked) < n:
        h = hosts.popleft()
        q = by_host[h]
        if q:
            picked.append(q.popleft())
        if q:
            hosts.append(h)
    return picked


PROBE_INSERT = """
INSERT INTO probe (
    run_id, snapshot_id, catalog_resource_id, probed_at, resource_url, host,
    request_method, request_url, final_url, redirect_count, is_templated,
    http_status, latency_ms, transport_error_class, transport_error,
    payment_required_header_b64, has_payment_required_header, body_x402_version,
    challenge_json, response_headers_json, body_snippet,
    is_valid_402, detected_version, version_source, probed_scheme, probed_network,
    probed_asset, probed_pay_to, probed_amount_raw, probed_price_usd,
    probed_decimals_unknown, probed_accepts_count, bazaar_ext_present,
    bazaar_schema_present, bazaar_schema_valid, spec_violations, violation_count,
    referral_json
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
"""


async def run(args) -> int:
    conn = connect()
    snap = conn.execute(
        "SELECT id FROM catalog_snapshot ORDER BY id DESC LIMIT 1").fetchone()
    if not snap:
        log("no catalog snapshot found — run fetch_catalog.py first")
        return 2
    snapshot_id = snap[0]

    mode = "all" if args.all else f"host-diverse:{args.sample}"
    if args.host:
        mode = f"host:{args.host}"
    recs = select_sample(conn, snapshot_id, args.sample, "all" if args.all else "diverse", args.host)
    if not recs:
        log("nothing to probe")
        return 2

    cur = conn.execute("""
        INSERT INTO probe_run (snapshot_id, started_at, planned_count, host_concurrency,
                               per_host_delay_s, timeout_s, user_agent, sample_mode, notes)
        VALUES (?,?,?,?,?,?,?,?,?)""",
        (snapshot_id, utcnow(), len(recs), args.host_concurrency, args.delay,
         TIMEOUT_S, USER_AGENT, mode, "unpaid probe only; no payment header ever sent"))
    run_id = cur.lastrowid
    conn.commit()

    by_host: dict[str, list] = defaultdict(list)
    for r in recs:
        by_host[r["host"]].append(r)
    log(f"run {run_id}: probing {len(recs)} resources across {len(by_host)} hosts "
        f"(host_concurrency={args.host_concurrency}, per_host_delay={args.delay}s)")

    out: list[dict] = []
    counter = {"done": 0, "total": len(recs)}
    sem = asyncio.Semaphore(args.host_concurrency)
    timeout = httpx.Timeout(TIMEOUT_S, connect=min(8.0, TIMEOUT_S))
    limits = httpx.Limits(max_connections=args.host_concurrency * 2,
                          max_keepalive_connections=args.host_concurrency)
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}

    async with httpx.AsyncClient(timeout=timeout, headers=headers, limits=limits,
                                 follow_redirects=True, max_redirects=MAX_REDIRECTS,
                                 verify=True) as client:
        async def guarded(host, items):
            async with sem:
                await host_worker(host, items, client, out, args.delay, counter)

        await asyncio.gather(*(guarded(h, items) for h, items in by_host.items()),
                             return_exceptions=True)

    now = utcnow()
    conn.executemany(PROBE_INSERT, [(
        run_id, snapshot_id, r.get("_catalog_resource_id"), now, r["resource_url"], r["host"],
        r["request_method"], r["request_url"], r["final_url"], r["redirect_count"],
        r["is_templated"], r["http_status"], r["latency_ms"], r["transport_error_class"],
        r["transport_error"], r["payment_required_header_b64"], r["has_payment_required_header"],
        r["body_x402_version"], r["challenge_json"], r["response_headers_json"], r["body_snippet"],
        r["is_valid_402"], r["detected_version"], r["version_source"], r["probed_scheme"],
        r["probed_network"], r["probed_asset"], r["probed_pay_to"], r["probed_amount_raw"],
        r["probed_price_usd"], r["probed_decimals_unknown"], r["probed_accepts_count"],
        r["bazaar_ext_present"], r["bazaar_schema_present"], r["bazaar_schema_valid"],
        r["spec_violations"], r["violation_count"], None,
    ) for r in out])
    conn.execute("UPDATE probe_run SET finished_at=?, completed_count=? WHERE id=?",
                 (utcnow(), len(out), run_id))
    conn.commit()
    log(f"run {run_id} complete: {len(out)} probes stored")
    conn.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Unpaid x402 402-challenge prober.")
    ap.add_argument("--sample", type=int, default=20, help="host-diverse sample size")
    ap.add_argument("--all", action="store_true", help="probe EVERY resource in the snapshot")
    ap.add_argument("--host", help="probe only this host (debugging a single operator)")
    ap.add_argument("--host-concurrency", type=int, default=DEFAULT_HOST_CONCURRENCY)
    ap.add_argument("--delay", type=float, default=DEFAULT_PER_HOST_DELAY,
                    help="seconds between requests to the SAME host")
    args = ap.parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
