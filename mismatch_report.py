"""
Price-mismatch monitor: catalog CLAIM vs measured 402 REALITY.

WHY THIS EXISTS — this is the single most demonstrable claim the product can
make, and it is a SAFETY story, not a data-quality one. An AI agent that reads
Coinbase's catalog price and auto-pays the amount a live 402 challenge actually
demands can be drained far beyond what it believed it was spending. Nobody else
is publishing measured-vs-declared at this scale; that gap is the point.

METHOD
  * Reads the latest COMPLETE catalog snapshot (catalog_snapshot.is_complete=1)
    joined to the probe run that measured it, via probe.catalog_resource_id —
    a direct foreign key, not a resource_url string match, so templated-path
    duplicates and cross-snapshot collisions can't silently merge two routes.
  * "Comparable" means both catalog_price_usd and probed_price_usd are
    non-NULL. Unknown-decimals routes on either side are excluded rather than
    guessed at — see x402_common's NULL-means-unknown convention.
  * Severity is a DANGER ranking, not a ratio ranking. A 20,000,000x route and
    a route that is merely "$2 instead of $1.90" are not the same kind of
    event even though both are "mismatches" — see build_leaderboard() for the
    exact tiering and why ratio alone under-ranks high-absolute-dollar routes
    with a modest multiplier (e.g. a $50 catalog price actually costing $500 is
    only 10x but is a real $450 loss per call).

READ-ONLY. Opens the DB with mode=ro so a bug here cannot corrupt the index
that fetch_catalog.py / probe.py / prune.py maintain. Never call connect() from
x402_common in this script — that helper runs CREATE TABLE / ALTER TABLE
migrations on open, which fail (or would silently need write access) against a
read-only handle. This script has no business altering schema anyway.

DOES NOT PROBE ANYTHING. Every number below comes from rows already stored.
No network call is made by this file, ever.

RUN
    python mismatch_report.py                # writes notes-price-mismatch.md
                                              # and mismatch.json, prints a
                                              # short summary to stdout
    python mismatch_report.py --run 6        # pin a specific probe_run id

HEADLESS: no window, no server. Safe to run from a scheduled task or by hand.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# Windows consoles / redirected pipes default to cp1252; force UTF-8 so the
# arrow characters and dollar signs below don't raise or mangle in a log file.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

HERE = Path(__file__).resolve().parent
DB_PATH = HERE / "x402_index.db"

# Absolute danger threshold (point 3 of the brief): a route that demands more
# than this many USD in a single call is flagged regardless of its ratio to
# the catalog. A 3x mismatch on a $1000 route is still a $2000 surprise bill;
# ratio-only ranking would bury that under a 1000x mismatch on a $0.001 route.
DANGER_ABS_USD = 100.0

# Ratio past which we call an overcharge CRITICAL even if the absolute dollar
# amount is small (protects the "$0.0001 -> $1" case, which is a real 10,000x
# multiplier an agent budgeting per-call could still get burned by at volume).
DANGER_RATIO = 100.0

EPS = 1e-9  # equality tolerance; matches v_claim_vs_reality's own epsilon


def connect_ro(path: Path) -> sqlite3.Connection:
    """Read-only handle. uri=True + mode=ro means SQLite refuses any write at
    the OS/file level, not just by convention — a stray INSERT in this file
    would raise, not silently succeed and corrupt history."""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def latest_complete_run(conn: sqlite3.Connection, forced_run: int | None):
    """Pick the probe run to report on.

    Deliberately does NOT just take MAX(probe_run.id): a probe run against an
    INCOMPLETE catalog snapshot (a partial/sample sweep) would understate
    "comparable routes" and make the mismatch rate look smaller than it is.
    We want the run whose snapshot is_complete=1, preferring the most recent
    such pair. --run overrides this and is trusted as-is (an operator asking
    for a specific run presumably knows what they're pinning to).
    """
    if forced_run is not None:
        run = conn.execute("SELECT * FROM probe_run WHERE id=?", (forced_run,)).fetchone()
        if not run:
            raise SystemExit(f"no probe_run with id={forced_run}")
        return run
    run = conn.execute("""
        SELECT pr.* FROM probe_run pr
        JOIN catalog_snapshot cs ON cs.id = pr.snapshot_id
        WHERE cs.is_complete = 1
        ORDER BY pr.id DESC LIMIT 1
    """).fetchone()
    if not run:
        raise SystemExit("no probe run exists against a complete catalog snapshot yet")
    return run


def parse_iso(s: str | None):
    """Best-effort ISO8601 parse. Both 'Z'-suffixed catalog timestamps and our
    own '+00:00' probe timestamps show up in this DB; normalize both. Returns
    None rather than raising on anything unparseable — a bad timestamp should
    degrade the staleness column to 'unknown', not crash the report."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def fetch_rows(conn: sqlite3.Connection, run_id: int, snap_id: int) -> list[sqlite3.Row]:
    """All comparable (catalog, probe) pairs for this run. Joined on
    probe.catalog_resource_id -> catalog_resource.id, the direct FK, not on
    resource_url — the same host+path can legitimately appear as multiple
    catalog_resource rows (mirrors, vercel preview deployments, etc.) and a
    string join would cross-wire them."""
    return conn.execute("""
        SELECT c.id AS catalog_resource_id, c.resource_url, c.host, c.service_name,
               c.catalog_price_usd, c.last_updated, c.is_templated,
               c.l30d_total_calls, c.l30d_unique_payers,
               p.probed_price_usd, p.probed_at, p.http_status, p.is_valid_402,
               p.transport_error_class
        FROM catalog_resource c
        JOIN probe p ON p.catalog_resource_id = c.id
        WHERE p.run_id = ? AND c.snapshot_id = ?
          AND c.catalog_price_usd IS NOT NULL
          AND p.probed_price_usd IS NOT NULL
    """, (run_id, snap_id)).fetchall()


def classify(row: sqlite3.Row) -> dict | None:
    """Turn one comparable row into a mismatch record, or None if prices agree.

    Severity tiering, in priority order (most dangerous first):
      CRITICAL — overcharge AND (live price > $DANGER_ABS_USD absolute
                 OR ratio >= DANGER_RATIO). Either condition alone is enough:
                 a $1,000,000 demand is critical even if the catalog also said
                 something large; a 100,000x multiplier is critical even on a
                 cheap route, because ratio compounds at volume.
      HIGH     — overcharge that doesn't hit CRITICAL but still costs the
                 caller real money beyond the catalog price.
      LOW      — undercharge (live is CHEAPER than catalog). Not dangerous to
                 a paying agent — the agent budgets for at most the catalog
                 price and pays less — so undercharges are never ranked above
                 any overcharge regardless of their ratio.
    Within CRITICAL/HIGH, the caller sorts by dollar exposure, not by this
    function — see build_leaderboard().
    """
    cat = row["catalog_price_usd"]
    live = row["probed_price_usd"]
    if abs(live - cat) <= EPS:
        return None

    direction = "OVERCHARGE" if live > cat else "UNDERCHARGE"
    exposure_usd = live - cat  # signed; positive for overcharge
    ratio = (live / cat) if cat > EPS else None  # None = "catalog claims free"

    if direction == "OVERCHARGE":
        danger_absolute = live > DANGER_ABS_USD
        danger_ratio = ratio is not None and ratio >= DANGER_RATIO
        # catalog claims the route is free (cat ~ 0) but it demands money live:
        # infinite ratio, can't compare multiplicatively, but the absolute
        # price alone already tells the danger story.
        catalog_claimed_free = cat <= EPS
        if danger_absolute or danger_ratio or catalog_claimed_free:
            severity = "CRITICAL"
        else:
            severity = "HIGH"
    else:
        severity = "LOW"

    return {
        "resource_url": row["resource_url"],
        "host": row["host"],
        "service_name": row["service_name"],
        "catalog_price_usd": cat,
        "probed_price_usd": live,
        "direction": direction,
        "severity": severity,
        "exposure_usd": exposure_usd,
        "ratio": ratio,  # None means catalog claimed $0
        "catalog_last_updated": row["last_updated"],
        "probed_at": row["probed_at"],
        "is_templated": bool(row["is_templated"]),
        "l30d_total_calls": row["l30d_total_calls"],
        "l30d_unique_payers": row["l30d_unique_payers"],
    }


def staleness_context(mismatches: list[dict], all_last_updated: list[str]) -> None:
    """Attach an age_days + age_percentile field to every mismatch so a
    top-offender's catalog age can be judged AGAINST the catalog's own
    distribution, not in a vacuum. A route whose catalog entry is 2 days old
    is unremarkable if the median catalog entry is also ~2 days old, and
    suspicious if the median is 30 days old. This is exactly the check the
    brief asks for on claudelines.com et al.
    """
    now_candidates = [parse_iso(m["probed_at"]) for m in mismatches if m["probed_at"]]
    now = max(now_candidates) if now_candidates else datetime.now(timezone.utc)

    all_ages = []
    for s in all_last_updated:
        dt = parse_iso(s)
        if dt:
            all_ages.append((now - dt).total_seconds() / 86400.0)
    all_ages.sort()

    def percentile_of(age_days: float) -> float | None:
        if not all_ages:
            return None
        import bisect
        i = bisect.bisect_left(all_ages, age_days)
        return 100.0 * i / len(all_ages)

    for m in mismatches:
        dt = parse_iso(m["catalog_last_updated"])
        probed_dt = parse_iso(m["probed_at"])
        if dt and probed_dt:
            age_days = (probed_dt - dt).total_seconds() / 86400.0
            m["catalog_age_days"] = round(age_days, 2)
            m["catalog_age_percentile"] = (
                round(percentile_of(age_days), 1) if percentile_of(age_days) is not None else None
            )
        else:
            m["catalog_age_days"] = None
            m["catalog_age_percentile"] = None


def _ordinal(pct: float) -> str:
    n = int(round(pct))
    suffix = "th" if 11 <= (n % 100) <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


SEVERITY_RANK = {"CRITICAL": 0, "HIGH": 1, "LOW": 2}


def build_leaderboard(mismatches: list[dict]) -> list[dict]:
    """Rank by (severity tier, then dollar exposure) — never by ratio alone.
    This is what makes the $1M claudelines.com case outrank a route that is
    merely 50x on a fraction of a cent, and what keeps every UNDERCHARGE
    (harmless to the payer) below every OVERCHARGE regardless of size.
    """
    return sorted(
        mismatches,
        key=lambda m: (SEVERITY_RANK[m["severity"]], -abs(m["exposure_usd"])),
    )


def host_concentration(mismatches: list[dict]) -> dict:
    """Is this a few bad actors or spread across the ecosystem? Measured, not
    asserted — per the brief's explicit instruction not to assume either
    shape. Reports both the raw distribution and a concentration ratio
    (share of ALL mismatches held by the top 10 hosts)."""
    by_host = defaultdict(lambda: {"count": 0, "overcharge": 0, "undercharge": 0,
                                    "critical": 0, "exposure_usd": 0.0})
    for m in mismatches:
        h = by_host[m["host"]]
        h["count"] += 1
        h["exposure_usd"] += m["exposure_usd"]
        if m["direction"] == "OVERCHARGE":
            h["overcharge"] += 1
        else:
            h["undercharge"] += 1
        if m["severity"] == "CRITICAL":
            h["critical"] += 1

    ranked = sorted(by_host.items(), key=lambda kv: kv[1]["count"], reverse=True)
    total = len(mismatches)
    top10_count = sum(v["count"] for _, v in ranked[:10])
    return {
        "distinct_hosts_with_mismatches": len(by_host),
        "top_hosts": [{"host": h, **v} for h, v in ranked[:20]],
        "top10_share_of_mismatches": (
            round(100.0 * top10_count / total, 1) if total else None
        ),
        "single_route_hosts": sum(1 for _, v in by_host.items() if v["count"] == 1),
    }


def render_markdown(meta: dict, leaderboard: list[dict], concentration: dict,
                     staleness_note: str) -> str:
    lines = []
    a = lines.append
    a("# Price-mismatch monitor — catalog claim vs measured 402 reality")
    a("")
    a(f"Catalog snapshot {meta['snapshot_id']} (fetched {meta['snapshot_fetched_at']}), "
      f"probe run {meta['run_id']} (started {meta['run_started_at']}).")
    a("")
    a(f"- Comparable routes (both prices known): **{meta['comparable']:,}**")
    a(f"- Mismatches: **{meta['mismatch_count']:,}** "
      f"({meta['mismatch_pct']}% of comparable)")
    a(f"  - Overcharges (dangerous direction — live > catalog): "
      f"**{meta['overcharge_count']:,}**")
    a(f"  - Undercharges (live < catalog): **{meta['undercharge_count']:,}**")
    a(f"  - CRITICAL severity: **{meta['critical_count']:,}**")
    a("")
    a("Severity tiers: CRITICAL = overcharge where live price > "
      f"${DANGER_ABS_USD:.0f}, or ratio >= {DANGER_RATIO:.0f}x, or catalog "
      "claimed the route free. HIGH = any other overcharge. LOW = undercharge "
      "(never dangerous to a paying agent, so never ranked above an "
      "overcharge). Ranked within a tier by absolute dollar exposure, not by "
      "ratio — a modest multiplier on an expensive route can cost more per "
      "call than an extreme multiplier on a cheap one.")
    a("")
    a("## Top 10 by severity (all CRITICAL here; see mismatch.json for the full list)")
    a("")
    a("| host | route | catalog $ | live $ | ratio | exposure $/call | catalog age (days) | age percentile |")
    a("|---|---|---:|---:|---:|---:|---:|---:|")
    for m in leaderboard[:10]:
        ratio_s = f"{m['ratio']:,.1f}x" if m["ratio"] is not None else "catalog claimed free"
        age_s = f"{m['catalog_age_days']:.2f}" if m["catalog_age_days"] is not None else "unknown"
        pct_s = _ordinal(m["catalog_age_percentile"]) if m["catalog_age_percentile"] is not None else "n/a"
        route = m["resource_url"].split("://", 1)[-1]
        a(f"| {m['host']} | {route} | {m['catalog_price_usd']:,.4f} | "
          f"{m['probed_price_usd']:,.2f} | {ratio_s} | {m['exposure_usd']:,.2f} | "
          f"{age_s} | {pct_s} |")
    a("")
    a("## Host concentration")
    a("")
    a(f"- Distinct hosts carrying at least one mismatch: "
      f"**{concentration['distinct_hosts_with_mismatches']:,}**")
    a(f"- Top-10 hosts hold **{concentration['top10_share_of_mismatches']}%** of all mismatches")
    a(f"- Hosts with exactly one mismatching route: "
      f"**{concentration['single_route_hosts']:,}**")
    verdict = (
        "CONCENTRATED — a small number of hosts account for most mismatches"
        if concentration["top10_share_of_mismatches"] is not None
        and concentration["top10_share_of_mismatches"] >= 50
        else "SPREAD — mismatches are distributed across many hosts, not a "
             "handful of bad actors"
    )
    a(f"- **Verdict: {verdict}.** (measured from the data above, not assumed)")
    a("")
    a("| host | mismatches | overcharges | undercharges | CRITICAL | net exposure $ |")
    a("|---|---:|---:|---:|---:|---:|")
    for h in concentration["top_hosts"][:15]:
        a(f"| {h['host']} | {h['count']} | {h['overcharge']} | {h['undercharge']} | "
          f"{h['critical']} | {h['exposure_usd']:,.2f} |")
    a("")
    a("## Alternative explanations — what we can and cannot rule out")
    a("")
    a(staleness_note)
    a("")
    a("For every route above we recorded `catalog_last_updated` age at probe "
      "time and its percentile against the whole catalog's age distribution. "
      "A young catalog age (low percentile) is CONSISTENT with a legitimate "
      "recent price change and is reported as such, not asserted as innocent — "
      "we have no changelog, so a fresh `lastUpdated` timestamp is equally "
      "consistent with a deliberate bait-and-switch that just relisted. "
      "Templated routes (`/:param`) probed as a literal path are excluded from "
      "the leaderboard entirely reasoning is unreliable there (a probe result "
      "sits at whatever literal example was templated, not a representative "
      "call). Dynamic/variable-priced routes cannot be distinguished from a "
      "static misconfiguration with a single probe; only a second probe run at "
      "a different time would show whether the live price moves.")
    a("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", type=int, help="probe_run id (default: latest against a complete snapshot)")
    args = ap.parse_args()

    conn = connect_ro(DB_PATH)
    run = latest_complete_run(conn, args.run)
    run_id, snap_id = run["id"], run["snapshot_id"]
    snap = conn.execute("SELECT * FROM catalog_snapshot WHERE id=?", (snap_id,)).fetchone()

    rows = fetch_rows(conn, run_id, snap_id)
    comparable = len(rows)

    # Templated paths are excluded from the leaderboard (see docstring/report
    # note) but kept in the raw comparable count for the headline rate, matching
    # report.py's convention of always stating what a percentage is measured over.
    mismatches = []
    templated_excluded = 0
    for row in rows:
        rec = classify(row)
        if rec is None:
            continue
        if rec["is_templated"]:
            templated_excluded += 1
            continue
        mismatches.append(rec)

    all_last_updated = [r["last_updated"] for r in rows]
    staleness_context(mismatches, all_last_updated)

    leaderboard = build_leaderboard(mismatches)
    concentration = host_concentration(mismatches)

    overcharge_count = sum(1 for m in mismatches if m["direction"] == "OVERCHARGE")
    undercharge_count = sum(1 for m in mismatches if m["direction"] == "UNDERCHARGE")
    critical_count = sum(1 for m in mismatches if m["severity"] == "CRITICAL")

    # Staleness attribution for the top offenders named in the brief, computed
    # (not asserted) so the report can say plainly which ones we CAN and
    # CANNOT distinguish from a legitimate recent price change.
    stale_lines = []
    for m in leaderboard[:5]:
        if m["catalog_age_days"] is None:
            stale_lines.append(f"- `{m['host']}`: catalog age unknown (unparseable timestamp) — cannot assess staleness.")
            continue
        pct = m["catalog_age_percentile"]
        verdict = (
            "younger than most of the catalog — a recent price change is plausible, "
            "cannot rule out deception either"
            if pct is not None and pct <= 25
            else "about as old as a typical catalog entry — staleness alone does not "
                 "explain this mismatch"
            if pct is not None and 25 < pct < 75
            else "older than most of the catalog — the mismatch has persisted through "
                 "at least one normal refresh window, which argues against 'we just "
                 "changed the price and haven't republished yet'"
        )
        stale_lines.append(
            f"- `{m['host']}` ({m['resource_url']}): catalog entry was "
            f"{m['catalog_age_days']:.2f} days old at probe time "
            f"(~{_ordinal(pct)} percentile of catalog age) — {verdict}."
        )
    staleness_note = (
        "**We cannot see price-change history upstream (CDP overwrites, does "
        "not version) — only catalog age at probe time.** Per-route read on "
        "the top offenders:\n\n" + "\n".join(stale_lines)
    )

    meta = {
        "snapshot_id": snap_id,
        "snapshot_fetched_at": snap["fetched_at"],
        "run_id": run_id,
        "run_started_at": run["started_at"],
        "comparable": comparable,
        "templated_excluded_from_leaderboard": templated_excluded,
        "mismatch_count": len(mismatches),
        "mismatch_pct": round(100.0 * len(mismatches) / comparable, 1) if comparable else None,
        "overcharge_count": overcharge_count,
        "undercharge_count": undercharge_count,
        "critical_count": critical_count,
        "danger_abs_usd_threshold": DANGER_ABS_USD,
        "danger_ratio_threshold": DANGER_RATIO,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    (HERE / "mismatch.json").write_text(
        json.dumps({"meta": meta, "leaderboard": leaderboard,
                    "concentration": concentration}, indent=2, sort_keys=False),
        encoding="utf-8",
    )
    (HERE / "notes-price-mismatch.md").write_text(
        render_markdown(meta, leaderboard, concentration, staleness_note),
        encoding="utf-8",
    )

    # Short stdout summary; the files carry the detail.
    print(f"comparable={comparable} mismatches={len(mismatches)} "
          f"({meta['mismatch_pct']}%) overcharge={overcharge_count} "
          f"undercharge={undercharge_count} critical={critical_count}")
    print(f"host concentration: top10 share = {concentration['top10_share_of_mismatches']}% "
          f"of mismatches across {concentration['distinct_hosts_with_mismatches']} hosts")
    print("wrote notes-price-mismatch.md and mismatch.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
