"""
Summary report: catalog CLAIM versus probed REALITY.

Answers the questions this index exists to answer, and refuses to answer the
ones the data cannot support:

  1. What share of listed routes are actually alive?
  2. What is the REAL price distribution versus the catalog's claimed one?
  3. How many routes are spec-non-compliant, and how?
  4. Which hosts run many dead routes?
  5. Where is the money and the attention (calls, payers, derived GMV)?

METHODOLOGY RULES ENFORCED IN CODE, not just in prose:
  * Every percentage prints its denominator. A bare "94% alive" is unreadable
    without knowing whether that is 94% of 20 or of 15,520.
  * Templated routes (`/:param` in the path) are reported SEPARATELY. They
    cannot be probed as literals, so folding them into a headline alive-rate
    understates liveness by an unknown amount.
  * Prices are only compared where BOTH sides are USD-convertible. A NULL is
    printed as unknown, never coerced to zero.
  * Anything the data cannot establish is printed under "NOT ESTABLISHED"
    rather than estimated.

HEADLESS: prints to stdout. Redirect to a log or a file.

RUN
    python report.py                 # latest probe run vs latest catalog snapshot
    python report.py --run 3
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter

from x402_common import connect


# Windows consoles and redirected pipes default to cp1252, which mangles every
# non-ASCII character in this file's output and can raise UnicodeEncodeError
# outright. The logs are the only way anyone sees these runs, so force UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass


def pct(n: int, d: int) -> str:
    """Percentage that always shows its denominator. A percentage without one is
    how a 20-resource sample gets quoted as an ecosystem-wide fact."""
    if not d:
        return "n/a (0 observations)"
    return f"{100.0 * n / d:.1f}% ({n}/{d})"


def quantiles(vals: list[float]) -> dict:
    if not vals:
        return {}
    s = sorted(vals)

    def q(p):
        if len(s) == 1:
            return s[0]
        i = p * (len(s) - 1)
        lo, hi = int(i), min(int(i) + 1, len(s) - 1)
        return s[lo] + (s[hi] - s[lo]) * (i - lo)

    return {"min": s[0], "p10": q(.10), "p25": q(.25), "median": q(.50),
            "p75": q(.75), "p90": q(.90), "max": s[-1]}


def fmt_q(qs: dict) -> str:
    if not qs:
        return "no convertible prices"
    return "  ".join(f"{k}=${v:,.4f}".rstrip("0").rstrip(".") if v < 1 else f"{k}=${v:,.2f}"
                     for k, v in qs.items())


def section(title: str) -> None:
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", type=int, help="probe_run id (default: latest)")
    args = ap.parse_args()

    conn = connect()
    run = conn.execute(
        "SELECT * FROM probe_run WHERE id = COALESCE(?, (SELECT MAX(id) FROM probe_run))",
        (args.run,)).fetchone()
    if not run:
        print("no probe runs yet — run fetch_catalog.py then probe.py")
        return 2
    run_id, snap_id = run["id"], run["snapshot_id"]
    snap = conn.execute("SELECT * FROM catalog_snapshot WHERE id=?", (snap_id,)).fetchone()

    print("x402 INDEX — measured reality vs catalog claim")
    print(f"catalog snapshot {snap_id}  fetched {snap['fetched_at']}  "
          f"rows={snap['rows_stored']} of total_reported={snap['total_reported']}")
    print(f"probe run {run_id}  started {run['started_at']}  mode={run['sample_mode']}  "
          f"probed={run['completed_count']}")
    print(f"user-agent: {run['user_agent']}")

    # ---------------------------------------------------------------- catalog
    section("1. THE CATALOG AS PUBLISHED (self-declared; this is CDP's data, not ours)")
    c = conn.execute("""
        SELECT COUNT(*) n, COUNT(DISTINCT host) hosts,
               SUM(is_templated) tmpl, SUM(amount_format_violation) amtviol,
               SUM(CASE WHEN catalog_price_usd IS NULL THEN 1 ELSE 0 END) noprice,
               SUM(l30d_total_calls) calls, SUM(est_gmv_30d_usd) gmv,
               SUM(CASE WHEN curated=1 THEN 1 ELSE 0 END) curated,
               SUM(CASE WHEN has_bazaar_schema=0 THEN 1 ELSE 0 END) noschema,
               SUM(CASE WHEN catalog_price_usd = 0 THEN 1 ELSE 0 END) freeroutes,
               SUM(CASE WHEN builder_code IS NOT NULL THEN 1 ELSE 0 END) bcode,
               SUM(CASE WHEN is_deprecated=1 THEN 1 ELSE 0 END) deprecated,
               SUM(CASE WHEN skill_url IS NOT NULL THEN 1 ELSE 0 END) skillurl
        FROM catalog_resource WHERE snapshot_id=?""", (snap_id,)).fetchone()
    n = c["n"]
    print(f"routes stored            : {n}")
    print(f"distinct hosts           : {c['hosts']}   <- the honest 'number of services'")
    print(f"templated (/:param) paths: {pct(c['tmpl'] or 0, n)}  (cannot be probed literally)")
    print(f"price not USD-convertible: {pct(c['noprice'] or 0, n)}  (unknown-decimals asset)")
    print(f"atomic-unit field defects: {pct(c['amtviol'] or 0, n)}  (decimal string / JSON number)")
    print(f"no bazaar schema declared: {pct(c['noschema'] or 0, n)}")
    print(f"flagged 'curated'        : {pct(c['curated'] or 0, n)}  (undocumented field; meaning UNVERIFIED)")
    # A $0 accept is a real, listed, free route. Left in the percentiles it
    # silently drags the low end down, so it is counted explicitly.
    print(f"priced at exactly $0.00  : {pct(c['freeroutes'] or 0, n)}  (genuinely free listings)")
    print(f"carries a builder-code   : {pct(c['bcode'] or 0, n)}  <- live attribution/referral rail")
    print(f"self-marked deprecated   : {pct(c['deprecated'] or 0, n)}")
    print(f"declares a skillUrl      : {pct(c['skillurl'] or 0, n)}  (URL recorded, content NEVER fetched)")
    print(f"30-day calls (CDP-reported, summed): {c['calls']:,}")
    print(f"30-day GMV, DERIVED = cheapest listed price x calls: ${(c['gmv'] or 0):,.2f}")
    print("  ^ derived by us, NOT reported by CDP. The catalog exposes no revenue field.")

    # THE HEADLINE GMV IS NOT AN ECOSYSTEM-SIZE NUMBER, and the reason is
    # arithmetic, not opinion: a handful of high-nominal-price routes with 1-2
    # lifetime calls dominate the sum. A $10,000 "price" on a route called once
    # is an invoice ceiling, not revenue. Printing the trimmed figure next to it
    # is the only way the headline stops being quotable out of context.
    trim = conn.execute("""
        SELECT SUM(est_gmv_30d_usd) g, COUNT(*) n FROM catalog_resource
        WHERE snapshot_id=? AND est_gmv_30d_usd IS NOT NULL AND l30d_total_calls > 2""",
        (snap_id,)).fetchone()
    top4 = conn.execute("""
        SELECT SUM(g) FROM (SELECT est_gmv_30d_usd g FROM catalog_resource
        WHERE snapshot_id=? AND est_gmv_30d_usd IS NOT NULL
        ORDER BY est_gmv_30d_usd DESC LIMIT 4)""", (snap_id,)).fetchone()[0] or 0
    gmv_all = c["gmv"] or 0
    print(f"  top 4 routes alone       : ${top4:,.2f} = "
          f"{(100*top4/gmv_all if gmv_all else 0):.0f}% of that total, from a handful of calls")
    print(f"  GMV excluding routes with <=2 calls/30d: ${(trim['g'] or 0):,.2f} "
          f"across {trim['n']:,} routes")
    # The call-count trim alone does NOT fix this: Bitrefill's invoice endpoint
    # survives it (28 calls) and is still ~$28k of the total on a "$1,000 price"
    # that is a payment ceiling, not a fee. A second, explicitly-stated price cap
    # is needed. $10/call is an ARBITRARY threshold chosen to exclude
    # invoice/checkout routes; it is stated rather than hidden so the reader can
    # disagree with it.
    trim2 = conn.execute("""
        SELECT SUM(est_gmv_30d_usd) g, COUNT(*) n FROM catalog_resource
        WHERE snapshot_id=? AND est_gmv_30d_usd IS NOT NULL
          AND l30d_total_calls > 2 AND catalog_price_usd <= 10.0""", (snap_id,)).fetchone()
    print(f"  ...and also excluding routes priced >$10/call: ${(trim2['g'] or 0):,.2f} "
          f"across {trim2['n']:,} routes")
    print("  ^ THIS is the closest thing to recurring per-call economic activity.")
    print("    ($10 cap is an arbitrary, stated threshold to drop invoice/checkout routes.)")

    prices = [r[0] for r in conn.execute(
        "SELECT catalog_price_usd FROM catalog_resource WHERE snapshot_id=? AND catalog_price_usd IS NOT NULL",
        (snap_id,)).fetchall()]
    print(f"CLAIMED price distribution (n={len(prices)}):\n  {fmt_q(quantiles(prices))}")

    # ------------------------------------------------------------- liveness
    section("2. LIVENESS — what actually answered (this is OUR measurement)")
    p = conn.execute("""
        SELECT COUNT(*) n,
               SUM(CASE WHEN http_status IS NOT NULL THEN 1 ELSE 0 END) responded,
               SUM(is_valid_402) valid402,
               SUM(CASE WHEN http_status=402 THEN 1 ELSE 0 END) st402,
               SUM(CASE WHEN redirect_count>0 THEN 1 ELSE 0 END) redirected,
               SUM(is_templated) tmpl
        FROM probe WHERE run_id=?""", (run_id,)).fetchone()
    tot = p["n"]
    print(f"probed                        : {tot}")
    print(f"got any HTTP response         : {pct(p['responded'] or 0, tot)}")
    print(f"returned HTTP 402             : {pct(p['st402'] or 0, tot)}")
    print(f"VALID x402 challenge (alive)  : {pct(p['valid402'] or 0, tot)}   <- headline alive-rate")
    print(f"followed >=1 redirect         : {pct(p['redirected'] or 0, tot)}")

    nt = conn.execute("""SELECT COUNT(*) n, SUM(is_valid_402) v FROM probe
                         WHERE run_id=? AND is_templated=0""", (run_id,)).fetchone()
    tm = conn.execute("""SELECT COUNT(*) n, SUM(is_valid_402) v FROM probe
                         WHERE run_id=? AND is_templated=1""", (run_id,)).fetchone()
    print(f"  excluding templated routes  : {pct(nt['v'] or 0, nt['n'])}")
    print(f"  templated routes only       : {pct(tm['v'] or 0, tm['n'])}"
          + ("   (probed as literals; low rate here is expected, not proof of death)"
             if tm["n"] else ""))

    print("\nfailure modes (five distinct findings, deliberately not merged into 'dead'):")
    for r in conn.execute("""SELECT COALESCE(transport_error_class,'(http responded)') k, COUNT(*) c
                             FROM probe WHERE run_id=? GROUP BY k ORDER BY c DESC""", (run_id,)):
        print(f"  {r[0]:22} {r[1]}")
    print("\nHTTP status codes seen:")
    for r in conn.execute("""SELECT http_status, COUNT(*) c FROM probe WHERE run_id=?
                             AND http_status IS NOT NULL GROUP BY http_status ORDER BY c DESC""",
                          (run_id,)):
        print(f"  {r[0]:22} {r[1]}")

    lat = [r[0] for r in conn.execute(
        "SELECT latency_ms FROM probe WHERE run_id=? AND http_status IS NOT NULL", (run_id,))]
    if lat:
        ls = sorted(lat)
        print(f"\nlatency ms: min={ls[0]} median={ls[len(ls)//2]} p90={ls[int(len(ls)*.9)]} max={ls[-1]}")

    # --------------------------------------------------------- versions/wire
    section("3. PROTOCOL VERSION ON THE WIRE (v1 and v2 both exist in the wild)")
    for r in conn.execute("""SELECT COALESCE(detected_version,-1) v, COALESCE(version_source,'none') s,
                             COUNT(*) c FROM probe WHERE run_id=? GROUP BY v,s ORDER BY c DESC""",
                          (run_id,)):
        label = "no challenge" if r[0] == -1 else f"v{r[0]} via {r[1]}"
        print(f"  {label:26} {r[2]}")
    mism = conn.execute("""SELECT COUNT(*) FROM probe p JOIN catalog_resource c
                           ON c.id=p.catalog_resource_id
                           WHERE p.run_id=? AND p.detected_version IS NOT NULL
                             AND c.catalog_x402_version IS NOT NULL
                             AND p.detected_version <> c.catalog_x402_version""",
                        (run_id,)).fetchone()[0]
    print(f"  catalog version disagrees with wire: {mism}")

    # ------------------------------------------------------------ price diff
    section("4. CLAIMED PRICE vs MEASURED PRICE (the differentiation)")
    rows = conn.execute("""
        SELECT c.resource_url, c.catalog_price_usd cp, p.probed_price_usd pp,
               c.min_amount_raw craw, p.probed_amount_raw praw
        FROM probe p JOIN catalog_resource c ON c.id = p.catalog_resource_id
        WHERE p.run_id=?""", (run_id,)).fetchall()
    both = [r for r in rows if r["cp"] is not None and r["pp"] is not None]
    diff = [r for r in both if abs(r["cp"] - r["pp"]) > 1e-9]
    print(f"comparable (both sides USD-convertible): {pct(len(both), len(rows))}")
    print(f"PRICE MISMATCH catalog vs live         : {pct(len(diff), len(both))}")
    for r in sorted(diff, key=lambda x: -abs(x["cp"] - x["pp"]))[:15]:
        ratio = (r["pp"] / r["cp"]) if r["cp"] else float("inf")
        print(f"  catalog ${r['cp']:>12,.6f} -> live ${r['pp']:>12,.6f}  (x{ratio:,.4g})  {r['resource_url'][:70]}")
    # PAIRED comparison: both distributions are computed over the SAME rows —
    # the ones where both a catalog price and a probed price exist. Printing an
    # n=39 measured median beside an n=40 claimed median invites reading a
    # denominator artefact as a market-wide price shift.
    live_prices = [r["pp"] for r in both]
    claimed_same = [r["cp"] for r in both]
    print(f"\nboth lines below cover the SAME {len(both)} routes (paired):")
    print(f"  MEASURED: {fmt_q(quantiles(live_prices))}")
    print(f"  CLAIMED : {fmt_q(quantiles(claimed_same))}")

    # ------------------------------------------------------------ compliance
    section("5. SPEC COMPLIANCE (measured on the live 402, not self-reported)")
    viol = Counter()
    with_any = 0
    for r in conn.execute("SELECT spec_violations FROM probe WHERE run_id=?", (run_id,)):
        if r[0]:
            codes = json.loads(r[0])
            if codes:
                with_any += 1
            viol.update(codes)
    print(f"routes with >=1 violation: {pct(with_any, tot)}")
    for code, cnt in viol.most_common():
        print(f"  {code:44} {cnt}")
    if not viol:
        print("  (none observed in this sample)")

    b = conn.execute("""SELECT SUM(bazaar_ext_present) e, SUM(bazaar_schema_present) s,
                        SUM(CASE WHEN bazaar_schema_valid=1 THEN 1 ELSE 0 END) v,
                        SUM(CASE WHEN bazaar_schema_valid=0 THEN 1 ELSE 0 END) iv,
                        SUM(CASE WHEN is_valid_402=1 THEN 1 ELSE 0 END) live
                        FROM probe WHERE run_id=?""", (run_id,)).fetchone()
    live = b["live"] or 0
    print(f"\nof {live} live challenges:")
    print(f"  bazaar extension present : {pct(b['e'] or 0, live)}")
    print(f"  bazaar schema present    : {pct(b['s'] or 0, live)}")
    print(f"  schema compiles (2020-12): {pct(b['v'] or 0, live)}   invalid: {b['iv'] or 0}")

    # ------------------------------------------------------------ dead hosts
    section("6. HOSTS RUNNING DEAD ROUTES (probed subset only)")
    dead = conn.execute("""
        SELECT host, COUNT(*) probed, SUM(CASE WHEN is_valid_402=0 THEN 1 ELSE 0 END) dead,
               GROUP_CONCAT(DISTINCT COALESCE(transport_error_class, 'http_' || http_status))
        FROM probe WHERE run_id=? GROUP BY host
        HAVING dead > 0 ORDER BY dead DESC, probed DESC LIMIT 25""", (run_id,)).fetchall()
    if dead:
        print(f"{'host':44} {'dead':>5}/{'probed':<6} reasons")
        for r in dead:
            print(f"  {r[0][:42]:42} {r[2]:>5}/{r[1]:<6} {r[3]}")
        # Catalog-wide exposure of those hosts, so a dead host that lists 70
        # routes is visible as 70 routes at risk, not as the 1 we sampled.
        print("\ncatalog-wide route count for the hosts above (exposure, NOT measured dead):")
        for r in dead[:10]:
            tot_routes = conn.execute(
                "SELECT COUNT(*) FROM catalog_resource WHERE snapshot_id=? AND host=?",
                (snap_id, r[0])).fetchone()[0]
            print(f"  {r[0][:42]:42} lists {tot_routes} route(s) in the catalog")
    else:
        print("  every probed route returned a valid challenge")

    # ------------------------------------------------------------- popularity
    section("7. POPULARITY & DERIVED REVENUE (CDP-reported activity, our arithmetic)")
    print("top 10 by CDP 30-day calls:")
    for r in conn.execute("""SELECT resource_url, l30d_total_calls, l30d_unique_payers,
                             catalog_price_usd, est_gmv_30d_usd FROM catalog_resource
                             WHERE snapshot_id=? ORDER BY l30d_total_calls DESC LIMIT 10""",
                          (snap_id,)):
        price = f"${r[3]:.4f}" if r[3] is not None else "unknown"
        gmv = f"${r[4]:,.2f}" if r[4] is not None else "n/a"
        print(f"  {r[1]:>9,} calls  {r[2]:>5} payers  {price:>10}/call  gmv~{gmv:>12}  {r[0][:56]}")
    print("\ntop 10 by DERIVED 30-day GMV:")
    for r in conn.execute("""SELECT resource_url, l30d_total_calls, l30d_unique_payers,
                             catalog_price_usd, est_gmv_30d_usd FROM catalog_resource
                             WHERE snapshot_id=? AND est_gmv_30d_usd IS NOT NULL
                             ORDER BY est_gmv_30d_usd DESC LIMIT 10""", (snap_id,)):
        print(f"  ~${r[4]:>12,.2f}  = {r[1]:>9,} calls x ${r[3]:.4f}  {r[2]:>5} payers  {r[0][:52]}")

    d = conn.execute("""SELECT
        SUM(CASE WHEN l30d_total_calls=0 THEN 1 ELSE 0 END) z,
        SUM(CASE WHEN l30d_total_calls BETWEEN 1 AND 2 THEN 1 ELSE 0 END) a,
        SUM(CASE WHEN l30d_total_calls BETWEEN 3 AND 10 THEN 1 ELSE 0 END) b,
        SUM(CASE WHEN l30d_total_calls BETWEEN 11 AND 100 THEN 1 ELSE 0 END) c,
        SUM(CASE WHEN l30d_total_calls > 100 THEN 1 ELSE 0 END) d
        FROM catalog_resource WHERE snapshot_id=?""", (snap_id,)).fetchone()
    print(f"\ncall-volume buckets: 0={d['z']}  1-2={d['a']}  3-10={d['b']}  11-100={d['c']}  100+={d['d']}")

    # ------------------------------------------------------------------ churn
    section("8. CHURN — the data Coinbase structurally cannot have")
    print("""CDP recomputes quality metrics every ~6h and OVERWRITES them, and drops any
resource that has not settled in 30 days. Upstream keeps no history, so "what
died", "what is decaying" and "what did this cost last week" exist only here.
A disappeared resource is never deleted from this DB.""")
    tot_ev = conn.execute("SELECT COUNT(*) FROM change_event").fetchone()[0]
    print(f"\nchange events recorded, all time: {tot_ev}")
    for r in conn.execute("""SELECT event_type, COUNT(*) c, MIN(detected_at) f, MAX(detected_at) l
                             FROM change_event GROUP BY event_type ORDER BY c DESC"""):
        print(f"  {r[0]:20} {r[1]:>7}   first={r[2][:19]}  latest={r[3][:19]}")
    if not tot_ev:
        print("  none yet — churn accrues from the SECOND complete catalog fetch onward.")
    else:
        print("\nmost recent price moves (old -> new, USD):")
        got = False
        for r in conn.execute("""SELECT resource_url, old_value, new_value, ratio_num
                                 FROM change_event WHERE event_type='price_change'
                                 ORDER BY id DESC LIMIT 10"""):
            got = True
            rt = f"x{r[3]:,.3g}" if r[3] else ""
            print(f"  {str(r[1]):>12} -> {str(r[2]):<12} {rt:>10}  {r[0][:52]}")
        if not got:
            print("  none observed yet")
        print("\nmost recent disappearances (the 30-day-no-settlement cliff):")
        got = False
        for r in conn.execute("""SELECT resource_url, host, detected_at FROM change_event
                                 WHERE event_type='disappeared' ORDER BY id DESC LIMIT 10"""):
            got = True
            print(f"  {r[2][:19]}  {r[0][:66]}")
        if not got:
            print("  none observed yet")

    print("\nbuilder-code concentration (live attribution rail):")
    for r in conn.execute("""SELECT builder_code, routes, hosts, l30d_calls FROM v_builder_codes
                             ORDER BY routes DESC LIMIT 8"""):
        print(f"  {r[0]:16} routes={r[1]:>5}  hosts={r[2]:>4}  30d_calls={r[3] or 0:>9,}")

    # ------------------------------------------------------------ time series
    section("9. TIME SERIES (needs >=2 COMPLETE snapshots; the compounding asset)")
    nsnap = conn.execute("SELECT COUNT(*) FROM catalog_snapshot").fetchone()[0]
    # Only COMPLETE snapshots may be diffed. A smoke-test run with --max-pages
    # stores 1,000 of 15,520 rows; diffing it against a full snapshot would
    # report ~14,500 "new listings" and ~0 "disappeared" — a spectacular,
    # confident, entirely fictional result. Completeness is defined as
    # rows_stored >= total_reported, both of which the fetcher records.
    complete = [r[0] for r in conn.execute("""
        SELECT id FROM catalog_snapshot WHERE is_complete = 1
        ORDER BY id DESC LIMIT 2""")]
    print(f"snapshots stored: {nsnap}  (complete: "
          f"{conn.execute('SELECT COUNT(*) FROM catalog_snapshot WHERE is_complete=1').fetchone()[0]})")
    if len(complete) < 2:
        print("  fewer than two COMPLETE snapshots — change detection starts once a second")
        print("  full fetch lands. Partial (--max-pages) snapshots are deliberately excluded")
        print("  from diffing; comparing one would invent thousands of fake 'new listings'.")
        print("  Once >=2 exist: v_price_history answers 'price history for resource X',")
        print("  and resource_dim.first_seen/last_seen answers 'new / disappeared listings'.")
    else:
        cur_s, prev_s = complete
        new = conn.execute("""SELECT COUNT(*) FROM catalog_resource a WHERE a.snapshot_id=?
              AND NOT EXISTS (SELECT 1 FROM catalog_resource b
              WHERE b.snapshot_id=? AND b.resource_url=a.resource_url)""",
                           (cur_s, prev_s)).fetchone()[0]
        gone = conn.execute("""SELECT COUNT(*) FROM catalog_resource b WHERE b.snapshot_id=?
              AND NOT EXISTS (SELECT 1 FROM catalog_resource a
              WHERE a.snapshot_id=? AND a.resource_url=b.resource_url)""",
                            (prev_s, cur_s)).fetchone()[0]
        moved = conn.execute("""SELECT COUNT(*) FROM catalog_resource a
              JOIN catalog_resource b ON a.resource_url=b.resource_url
              WHERE a.snapshot_id=? AND b.snapshot_id=?
                AND a.catalog_price_usd IS NOT NULL AND b.catalog_price_usd IS NOT NULL
                AND ABS(a.catalog_price_usd - b.catalog_price_usd) > 1e-9""",
                             (cur_s, prev_s)).fetchone()[0]
        print(f"  vs snapshot {prev_s}: new listings={new}  disappeared={gone}  price changes={moved}")

    # -------------------------------------------------------- not established
    section("10. NOT ESTABLISHED BY THIS DATA (stated so nobody quotes it as fact)")
    print("""  * Revenue. CDP publishes calls and unique payers, NOT revenue. Every GMV
    figure above is cheapest-listed-price x calls — an UPPER bound that breaks
    badly for variable-amount routes. Measured on the full catalog, the TOP FOUR
    derived-GMV rows are all high-nominal-price routes with 1-28 lifetime calls
    (an invoice endpoint at $1,000, a route at $10,000 called once, ...) and
    together they are ~82% of headline derived GMV. Roughly six calls produce
    four fifths of the number. Headline GMV is therefore NOT an ecosystem-size
    figure; use the >2-calls trimmed line in section 1 for that.
  * Whether a unique payer is a real customer or the operator self-registering.
    The catalog exposes no payer identity, so this is unknowable here.
  * The meaning of the 'curated' flag. It is a real field on the wire and is
    recorded verbatim; its selection criteria are undocumented.
  * Whether a route is genuinely dead or merely blocking our User-Agent / IP.
    A 403 is recorded as a 403, never reinterpreted.
  * Non-USD-pegged asset prices (e.g. EURC). Recorded raw, deliberately left
    unconverted rather than priced off an invented FX rate.
  * Templated /:param routes probed as literals. A 404 there is expected and is
    NOT evidence of a dead service.""")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
