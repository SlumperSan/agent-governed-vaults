#!/usr/bin/env python
"""
build_site.py — generates the 402cap public site as static HTML from x402_index.db.

Read-only. Never writes to the database. Run:  python build_site.py
Output: C:/Users/Micha/Desktop/x402/site/

Pages:
  site/index.html            — searchable/sortable table of all routes
  site/mismatch.html         — price-mismatch safety page (the wedge product)
  site/methodology.html      — honest "what we know / don't know" page
  site/r/<host>/<slug>.html  — one detail page per resource (crawlable)

Design choices, stated up front so a reviewer doesn't have to reverse-engineer them:
  - No CDN, no build toolchain. Plain HTML/CSS/JS strings, f-string templated.
  - One file per resource, sharded by host directory, so no single directory holds
    15k+ files and URLs read as /r/<host>/<slug>.html.
  - Every filename is <slug>-<hash8>.html where hash8 = sha1(resource_url)[:8].
    This makes filename collisions structurally impossible (uniqueness is asserted
    on resource_url, which is the DB's own primary identity) rather than merely
    checked after the fact.
  - catalog_price_usd / probed_price_usd are rendered as "unknown (decimals not
    established)" when NULL — never coerced to $0, matching the DB's own withhold
    convention (see README.md "Reading the important columns").
  - est_gmv_30d_usd is never shown without its derivation caveat inline, per
    ORG-LESSONS.md's "$62.8k/month" lesson.
  - "Alive" has three states, not two: alive / no-valid-402 / templated (untested).
    A 404 on a templated path (e.g. /v1/operations/:workflowName probed literally)
    is not evidence of death — README.md is explicit about this — so it is never
    shown as "dead".
"""
import hashlib
import html
import json
import os
import re
import sqlite3
import sys
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "x402_index.db")
SITE_DIR = os.path.join(BASE_DIR, "site")
MISMATCH_JSON = os.path.join(BASE_DIR, "mismatch.json")

DB_URI = f"file:{DB_PATH}?mode=ro"


def esc(s):
    if s is None:
        return ""
    return html.escape(str(s), quote=True)


def slugify(path):
    """Turn a URL path into a filesystem-safe, readable slug fragment."""
    p = (path or "").strip("/")
    if not p:
        p = "root"
    # templated segments like :workflowName -> param-workflowName
    p = p.replace(":", "param-")
    # replace path separators and anything illegal on Windows filenames
    p = re.sub(r"[\\/]+", "__", p)
    p = re.sub(r'[<>:"|?*]', "_", p)
    p = re.sub(r"\s+", "_", p)
    if len(p) > 120:
        p = p[:120]
    return p or "root"


def host_slug(host):
    h = re.sub(r'[<>:"|?*]', "_", host)
    h = re.sub(r"\s+", "_", h)
    return h


def money(v, decimals_unknown=False):
    if decimals_unknown or v is None:
        return "unknown (decimals not established)"
    if v == 0:
        return "$0.00"
    if v < 0.01:
        return f"${v:.6f}"
    return f"${v:,.4f}"


def fmt_num(v):
    if v is None:
        return "\u2014"
    return f"{v:,}"


PAGE_HEAD = """<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{description}">
<style>
{css}
</style>
</head>
<body>
<header class="site-header">
  <a class="brand" href="{root}index.html">402cap</a>
  <nav>
    <a href="{root}index.html">Routes</a>
    <a href="{root}mismatch.html">Price Mismatches</a>
    <a href="{root}methodology.html">Methodology</a>
  </nav>
</header>
<main>
"""

PAGE_FOOT = """
</main>
<footer class="site-footer">
  <p>402cap measures the x402 agent-payment economy directly on-chain and via unpaid
  402-challenge probes. It is independent of any facilitator's self-reported catalog.
  See <a href="{root}methodology.html">methodology</a> for what these numbers do and do not establish.</p>
  <p class="gen">Generated {generated_at} from catalog snapshot {snapshot_id}, probe run {run_id}.</p>
</footer>
</body>
</html>
"""

CSS = """
:root {
  --bg: #ffffff; --fg: #14171a; --muted: #5b6472; --border: #e2e5e9;
  --accent: #1a56db; --danger: #b3261e; --danger-bg: #fdecea;
  --warn: #92610a; --warn-bg: #fff6e0; --ok: #146c2e; --ok-bg: #e8f6ec;
  --card-bg: #f7f8fa; --code-bg: #f0f1f3;
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1216; --fg:#e7e9ec; --muted:#9aa4b2; --border:#2a2f37;
    --accent:#7aa2f7; --danger:#ff8a80; --danger-bg:#3a1210; --warn:#e8c15e; --warn-bg:#3a2f0e;
    --ok:#7ee2a8; --ok-bg:#0f2a1a; --card-bg:#171b21; --code-bg:#1b1f26; }
}
:root[data-theme="dark"] { --bg:#0f1216; --fg:#e7e9ec; --muted:#9aa4b2; --border:#2a2f37;
  --accent:#7aa2f7; --danger:#ff8a80; --danger-bg:#3a1210; --warn:#e8c15e; --warn-bg:#3a2f0e;
  --ok:#7ee2a8; --ok-bg:#0f2a1a; --card-bg:#171b21; --code-bg:#1b1f26; }
:root[data-theme="light"] { --bg:#ffffff; --fg:#14171a; --muted:#5b6472; --border:#e2e5e9;
  --accent:#1a56db; --danger:#b3261e; --danger-bg:#fdecea; --warn:#92610a; --warn-bg:#fff6e0;
  --ok:#146c2e; --ok-bg:#e8f6ec; --card-bg:#f7f8fa; --code-bg:#f0f1f3; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height:1.5; }
.site-header { display:flex; align-items:center; justify-content:space-between; gap:1rem;
  padding: 0.9rem 1.25rem; border-bottom:1px solid var(--border); flex-wrap:wrap; }
.brand { font-weight:700; font-size:1.15rem; color:var(--fg); text-decoration:none; }
.site-header nav a { margin-left:1.1rem; color:var(--muted); text-decoration:none; font-size:0.95rem; }
.site-header nav a:hover { color:var(--accent); }
main { max-width:1100px; margin:0 auto; padding:1.5rem 1.25rem 3rem; }
.site-footer { max-width:1100px; margin:2rem auto 2rem; padding:1rem 1.25rem; color:var(--muted);
  font-size:0.82rem; border-top:1px solid var(--border); }
.site-footer .gen { opacity:0.7; }
h1 { font-size:1.6rem; margin: 0.2rem 0 0.6rem; }
h2 { font-size:1.2rem; margin-top:2rem; }
a { color:var(--accent); }
table { border-collapse:collapse; width:100%; font-size:0.88rem; }
th, td { border-bottom:1px solid var(--border); padding:0.45rem 0.6rem; text-align:left;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:260px; }
th { cursor:pointer; user-select:none; position:sticky; top:0; background:var(--bg); }
th:hover { color:var(--accent); }
tbody tr:hover { background:var(--card-bg); }
.badge { display:inline-block; padding:0.1rem 0.5rem; border-radius:999px; font-size:0.76rem; font-weight:600; }
.badge-ok { background:var(--ok-bg); color:var(--ok); }
.badge-danger { background:var(--danger-bg); color:var(--danger); }
.badge-warn { background:var(--warn-bg); color:var(--warn); }
.badge-muted { background:var(--code-bg); color:var(--muted); }
.controls { display:flex; gap:0.6rem; flex-wrap:wrap; margin-bottom:0.9rem; align-items:center; }
.controls input[type=search] { flex:1; min-width:220px; padding:0.5rem 0.7rem; border:1px solid var(--border);
  border-radius:8px; background:var(--bg); color:var(--fg); font-size:0.95rem; }
.controls select { padding:0.5rem; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:var(--fg); }
.stat-row { display:flex; gap:1rem; flex-wrap:wrap; margin:1rem 0 1.5rem; }
.stat { background:var(--card-bg); border:1px solid var(--border); border-radius:10px;
  padding:0.7rem 1rem; min-width:130px; }
.stat .n { font-size:1.35rem; font-weight:700; display:block; }
.stat .l { color:var(--muted); font-size:0.78rem; }
.callout { background:var(--card-bg); border:1px solid var(--border); border-left:4px solid var(--accent);
  border-radius:6px; padding:0.9rem 1.1rem; margin:1rem 0; font-size:0.92rem; }
.callout.warn { border-left-color:var(--warn); }
.callout.danger { border-left-color:var(--danger); }
.kv { display:grid; grid-template-columns: 220px 1fr; gap:0.5rem 1rem; margin:1rem 0; font-size:0.94rem; }
.kv dt { color:var(--muted); }
.kv dd { margin:0; }
code { background:var(--code-bg); padding:0.1rem 0.35rem; border-radius:4px; font-size:0.86rem; }
.small { font-size:0.82rem; color:var(--muted); }
.severity-CRITICAL { color:var(--danger); font-weight:700; }
.severity-HIGH { color:var(--warn); font-weight:600; }
.severity-LOW { color:var(--muted); }
.mono { font-family: ui-monospace, Consolas, monospace; }
"""


def page(title, description, body, root="", generated_at="", snapshot_id="", run_id=""):
    out = PAGE_HEAD.format(title=esc(title), description=esc(description), css=CSS, root=root)
    out += body
    out += PAGE_FOOT.format(root=root, generated_at=esc(generated_at), snapshot_id=esc(snapshot_id), run_id=esc(run_id))
    return out


def alive_badge(is_valid_402, is_templated, http_status, transport_error_class):
    if is_templated:
        return '<span class="badge badge-muted" title="Path contains a :param segment; probing the literal example is not a valid liveness test">not tested (templated)</span>'
    if is_valid_402:
        return '<span class="badge badge-ok">alive</span>'
    detail = f"status {http_status}" if http_status else (transport_error_class or "no response")
    return f'<span class="badge badge-danger" title="{esc(detail)}">no valid 402 ({esc(detail)})</span>'


def mismatch_badge(price_mismatch):
    if price_mismatch:
        return '<span class="badge badge-warn">price mismatch</span>'
    return ""


def main():
    t0 = time.time()
    con = sqlite3.connect(DB_URI, uri=True)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    cur.execute("select max(id) as sid, fetched_at from catalog_snapshot where is_complete=1")
    snap_row = cur.fetchone()
    snapshot_id = snap_row["sid"]
    cur.execute("select max(id) as rid from probe_run")
    run_id = cur.fetchone()["rid"]
    generated_at = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())

    cur.execute("""
        select l.resource_url, l.host, l.url_path, l.service_name, l.resource_type,
               l.description, l.curated, l.catalog_x402_version, l.last_updated,
               l.l30d_total_calls, l.l30d_unique_payers, l.last_called_at,
               l.est_gmv_30d_usd, l.is_templated, l.accepts_count,
               l.min_amount_raw, l.min_amount_network, l.min_amount_asset,
               l.catalog_price_usd, l.decimals_unknown, l.amount_format_violation,
               l.has_bazaar_ext, l.has_bazaar_schema, l.tags_json, l.skill_url,
               l.builder_code, l.extension_names_json, l.is_deprecated, l.has_discount_ext,
               v.probed_at, v.http_status, v.latency_ms, v.transport_error_class,
               v.is_valid_402, v.detected_version, v.probed_amount_raw, v.probed_price_usd,
               v.probed_network, v.bazaar_ext_present, v.bazaar_schema_valid,
               v.spec_violations, v.violation_count, v.price_mismatch
        from v_latest_catalog l
        join v_claim_vs_reality v on v.resource_url = l.resource_url
    """)
    rows = [dict(r) for r in cur.fetchall()]
    con.close()

    print(f"[build_site] fetched {len(rows)} resource rows from DB "
          f"(snapshot {snapshot_id}, probe run {run_id})", file=sys.stderr)

    # ---- assign filenames: slug + sha1(resource_url)[:8], collision-checked ----
    for r in rows:
        h8 = hashlib.sha1(r["resource_url"].encode("utf-8")).hexdigest()[:8]
        r["_host_slug"] = host_slug(r["host"])
        r["_file_slug"] = f"{slugify(r['url_path'])}-{h8}"
        r["_rel_path"] = f"r/{r['_host_slug']}/{r['_file_slug']}.html"

    seen_paths = {}
    collisions = 0
    for r in rows:
        prev = seen_paths.get(r["_rel_path"])
        if prev is not None and prev != r["resource_url"]:
            collisions += 1
        seen_paths[r["_rel_path"]] = r["resource_url"]
    print(f"[build_site] filename collision count: {collisions}", file=sys.stderr)
    if collisions:
        print("[build_site] ABORTING: filename collisions detected", file=sys.stderr)
        sys.exit(1)

    os.makedirs(SITE_DIR, exist_ok=True)

    # ================= detail pages =================
    n_detail = 0
    for r in rows:
        n_detail += 1
        out_path = os.path.join(SITE_DIR, r["_rel_path"].replace("/", os.sep))
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        root = "../../"

        catalog_price = money(r["catalog_price_usd"], r["decimals_unknown"])
        probed_price = money(r["probed_price_usd"])
        alive = alive_badge(r["is_valid_402"], r["is_templated"], r["http_status"], r["transport_error_class"])
        mismatch = mismatch_badge(r["price_mismatch"])

        violations = []
        if r["spec_violations"]:
            try:
                violations = json.loads(r["spec_violations"])
            except Exception:
                violations = []
        ext_names = []
        if r["extension_names_json"]:
            try:
                ext_names = json.loads(r["extension_names_json"])
            except Exception:
                ext_names = []

        gmv_html = ""
        if r["est_gmv_30d_usd"] is not None:
            gmv_html = (f'{money(r["est_gmv_30d_usd"])} '
                        f'<span class="small">(derived by us: cheapest listed price &times; CDP-reported calls. '
                        f'An upper bound, not revenue &mdash; breaks badly on variable-amount routes. '
                        f'See methodology.)</span>')
        else:
            gmv_html = '<span class="small">not computable</span>'

        body = f"""
<p class="small"><a href="{root}index.html">&larr; all routes</a> &middot; <a href="{root}mismatch.html">price mismatches</a></p>
<h1>{esc(r['service_name'] or r['host'])}</h1>
<p class="mono small">{esc(r['resource_url'])}</p>
<p>{alive} {mismatch} {'<span class="badge badge-muted">curated</span>' if r['curated'] else ''} {'<span class="badge badge-warn">deprecated</span>' if r['is_deprecated'] else ''}</p>

<dl class="kv">
  <dt>Host</dt><dd><a href="{root}index.html?host={esc(r['host'])}">{esc(r['host'])}</a></dd>
  <dt>Path</dt><dd class="mono">{esc(r['url_path'])}{' <span class="small">(templated &mdash; contains a :param segment)</span>' if r['is_templated'] else ''}</dd>
  <dt>Resource type</dt><dd>{esc(r['resource_type'])}</dd>
  <dt>Description</dt><dd>{esc(r['description']) or '<span class="small">none provided</span>'}</dd>
  <dt>Catalog price (claimed)</dt><dd>{esc(catalog_price)} <span class="small">({esc(r['min_amount_network'])} / {esc(r['min_amount_asset'])})</span></dd>
  <dt>Probed price (measured)</dt><dd>{esc(probed_price)} {mismatch}</dd>
  <dt>Catalog last updated</dt><dd>{esc(r['last_updated'])}</dd>
  <dt>Probed at</dt><dd>{esc(r['probed_at'])}</dd>
  <dt>HTTP status of probe</dt><dd>{esc(r['http_status']) or esc(r['transport_error_class']) or '&mdash;'}</dd>
  <dt>Latency</dt><dd>{fmt_num(r['latency_ms'])} ms</dd>
  <dt>x402 version detected (live)</dt><dd>{esc(r['detected_version']) or '&mdash;'}</dd>
  <dt>Calls, last 30 days <span class="small">(CDP-reported)</span></dt><dd>{fmt_num(r['l30d_total_calls'])}</dd>
  <dt>Unique payers, last 30 days <span class="small">(CDP-reported)</span></dt><dd>{fmt_num(r['l30d_unique_payers'])}</dd>
  <dt>Last called</dt><dd>{esc(r['last_called_at']) or '&mdash;'}</dd>
  <dt>Estimated 30d GMV</dt><dd>{gmv_html}</dd>
  <dt>Builder code</dt><dd>{esc(r['builder_code']) or '&mdash;'}</dd>
  <dt>Bazaar extension present</dt><dd>{'yes' if r['has_bazaar_ext'] else 'no'} {'<span class="small">(schema valid)</span>' if r['bazaar_schema_valid'] else ('<span class="small">(schema present but not validated)</span>' if r['has_bazaar_ext'] else '')}</dd>
  <dt>Other extensions</dt><dd>{esc(', '.join(ext_names)) if ext_names else '&mdash;'}</dd>
  <dt>Spec violations</dt><dd>{esc(', '.join(violations)) if violations else 'none observed'}</dd>
  <dt>Skill URL declared</dt><dd>{f'<code>{esc(r["skill_url"])}</code> <span class="small">(untrusted third-party text, not fetched by us)</span>' if r['skill_url'] else '&mdash;'}</dd>
</dl>

<div class="callout">
This page mixes a <strong>catalog claim</strong> (what the operator declared to Coinbase's Bazaar)
with a <strong>measured reality</strong> (what an unpaid HTTP probe actually observed on the wire).
They are stored separately and never merged. See <a href="{root}methodology.html">methodology</a>.
</div>
"""
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(page(
                title=f"{r['service_name'] or r['host']} \u2014 {r['url_path']} | 402cap",
                description=f"x402 route {r['host']}{r['url_path']}: catalog price {catalog_price}, "
                            f"probed price {probed_price}, {'price mismatch detected' if r['price_mismatch'] else 'no mismatch detected'}.",
                body=body, root=root, generated_at=generated_at, snapshot_id=snapshot_id, run_id=run_id,
            ))

    print(f"[build_site] wrote {n_detail} detail pages", file=sys.stderr)

    # ================= index.html =================
    thead = ["Host", "Path", "Catalog price", "Probed price", "Mismatch", "Alive", "Latency (ms)", "30d calls (CDP)"]
    tr_rows = []
    for r in rows:
        catalog_price = r["catalog_price_usd"]
        probed_price = r["probed_price_usd"]
        alive_state = "templated" if r["is_templated"] else ("alive" if r["is_valid_402"] else "dead")
        tr_rows.append(
            "<tr>"
            f'<td>{esc(r["host"])}</td>'
            f'<td><a href="{esc(r["_rel_path"])}">{esc(r["url_path"])}</a></td>'
            f'<td data-sort="{catalog_price if catalog_price is not None else -1}">{esc(money(catalog_price, r["decimals_unknown"])) if catalog_price is not None or r["decimals_unknown"] else "&mdash;"}</td>'
            f'<td data-sort="{probed_price if probed_price is not None else -1}">{esc(money(probed_price)) if probed_price is not None else "&mdash;"}</td>'
            f'<td>{mismatch_badge(r["price_mismatch"])}</td>'
            f'<td data-alive="{alive_state}">{alive_badge(r["is_valid_402"], r["is_templated"], r["http_status"], r["transport_error_class"])}</td>'
            f'<td data-sort="{r["latency_ms"] if r["latency_ms"] is not None else -1}">{fmt_num(r["latency_ms"])}</td>'
            f'<td data-sort="{r["l30d_total_calls"] if r["l30d_total_calls"] is not None else -1}">{fmt_num(r["l30d_total_calls"])}</td>'
            "</tr>"
        )

    n_alive = sum(1 for r in rows if r["is_valid_402"] and not r["is_templated"])
    n_templated = sum(1 for r in rows if r["is_templated"])
    n_dead = sum(1 for r in rows if not r["is_valid_402"] and not r["is_templated"])
    n_mismatch = sum(1 for r in rows if r["price_mismatch"])
    n_hosts = len(set(r["host"] for r in rows))

    index_body = f"""
<h1>All x402 routes</h1>
<p>Every route Coinbase's CDP Bazaar catalog lists, cross-checked against a live unpaid probe.
Catalog claim and measured reality are shown side by side &mdash; they disagree more often than you'd expect.</p>

<div class="stat-row">
  <div class="stat"><span class="n">{len(rows):,}</span><span class="l">routes</span></div>
  <div class="stat"><span class="n">{n_hosts:,}</span><span class="l">distinct hosts</span></div>
  <div class="stat"><span class="n">{n_alive:,}</span><span class="l">confirmed alive</span></div>
  <div class="stat"><span class="n">{n_dead:,}</span><span class="l">no valid 402 on probe</span></div>
  <div class="stat"><span class="n">{n_templated:,}</span><span class="l">templated (not tested)</span></div>
  <div class="stat"><span class="n">{n_mismatch:,}</span><span class="l"><a href="mismatch.html">price mismatches</a></span></div>
</div>

<div class="callout warn">
<strong>"Alive" has three states, not two.</strong> {n_templated:,} routes contain a <code>:param</code>
path segment; probing the literal example text is not a valid liveness test (a 404 there proves nothing),
so they are marked <em>not tested</em> rather than dead. Only {n_dead:,} routes actually failed a real probe.
</div>

<div class="controls">
  <input type="search" id="q" placeholder="Search host or path&hellip;">
  <select id="aliveFilter">
    <option value="">All statuses</option>
    <option value="alive">Alive only</option>
    <option value="dead">No valid 402 only</option>
    <option value="templated">Templated (untested) only</option>
  </select>
  <span class="small" id="count"></span>
</div>

<table id="routes">
<thead><tr>{''.join(f'<th data-i="{i}">{h}</th>' for i, h in enumerate(thead))}</tr></thead>
<tbody>
{''.join(tr_rows)}
</tbody>
</table>

<script>
(function(){{
  var table = document.getElementById('routes');
  var tbody = table.tBodies[0];
  var rows = Array.prototype.slice.call(tbody.rows);
  var q = document.getElementById('q');
  var aliveFilter = document.getElementById('aliveFilter');
  var countEl = document.getElementById('count');

  function applyFilter(){{
    var term = q.value.toLowerCase();
    var af = aliveFilter.value;
    var shown = 0;
    rows.forEach(function(r){{
      var text = r.cells[0].textContent.toLowerCase() + ' ' + r.cells[1].textContent.toLowerCase();
      var matchesText = !term || text.indexOf(term) !== -1;
      var matchesAlive = !af || r.cells[5].getAttribute('data-alive') === af;
      var show = matchesText && matchesAlive;
      r.style.display = show ? '' : 'none';
      if (show) shown++;
    }});
    countEl.textContent = shown.toLocaleString() + ' of ' + rows.length.toLocaleString() + ' shown';
  }}
  q.addEventListener('input', applyFilter);
  aliveFilter.addEventListener('change', applyFilter);
  applyFilter();

  var sortState = {{}};
  Array.prototype.forEach.call(table.tHead.rows[0].cells, function(th){{
    th.addEventListener('click', function(){{
      var i = parseInt(th.getAttribute('data-i'), 10);
      var asc = !sortState[i];
      Object.keys(sortState).forEach(function(k){{ sortState[k] = false; }});
      sortState[i] = asc;
      var withSort = rows.map(function(r){{
        var cell = r.cells[i];
        var v = cell.hasAttribute('data-sort') ? parseFloat(cell.getAttribute('data-sort')) : cell.textContent.toLowerCase();
        return [v, r];
      }});
      withSort.sort(function(a, b){{
        if (a[0] < b[0]) return asc ? -1 : 1;
        if (a[0] > b[0]) return asc ? 1 : -1;
        return 0;
      }});
      withSort.forEach(function(pair){{ tbody.appendChild(pair[1]); }});
      rows = withSort.map(function(p){{ return p[1]; }});
    }});
  }});
}})();
</script>
"""
    with open(os.path.join(SITE_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(page(
            title="402cap \u2014 the measurement layer for the x402 agent-payment economy",
            description="Every x402 paid API route: catalog-claimed price vs measured live price, "
                         "liveness, and latency. Independent of any facilitator's self-reporting.",
            body=index_body, root="", generated_at=generated_at, snapshot_id=snapshot_id, run_id=run_id,
        ))
    print(f"[build_site] wrote index.html ({os.path.getsize(os.path.join(SITE_DIR, 'index.html')):,} bytes)", file=sys.stderr)

    # ================= mismatch.html =================
    with open(MISMATCH_JSON, encoding="utf-8") as f:
        mm = json.load(f)
    meta = mm["meta"]
    leaderboard = mm["leaderboard"]
    concentration = mm["concentration"]

    path_by_url = {r["resource_url"]: r["_rel_path"] for r in rows}

    def sev_rank(s):
        return {"CRITICAL": 0, "HIGH": 1, "LOW": 2}.get(s, 3)

    leaderboard_sorted = sorted(leaderboard, key=lambda r: (sev_rank(r["severity"]), -abs(r["exposure_usd"])))

    lb_rows = []
    for r in leaderboard_sorted[:100]:
        link = path_by_url.get(r["resource_url"])
        host_cell = f'<a href="{esc(link)}">{esc(r["host"])}</a>' if link else esc(r["host"])
        lb_rows.append(
            "<tr>"
            f'<td class="severity-{esc(r["severity"])}">{esc(r["severity"])}</td>'
            f'<td>{host_cell}</td>'
            f'<td class="mono small">{esc(r["resource_url"].split(r["host"],1)[-1])}</td>'
            f'<td>{esc(r["direction"])}</td>'
            f'<td>{money(r["catalog_price_usd"])}</td>'
            f'<td>{money(r["probed_price_usd"])}</td>'
            f'<td>{r["ratio"]:,.1f}x</td>'
            f'<td>${r["exposure_usd"]:,.2f}</td>'
            f'<td>{r["catalog_age_days"]:.2f}d ({r["catalog_age_percentile"]:.0f}th pct)</td>'
            "</tr>"
        )

    conc_rows = []
    for h in concentration["top_hosts"][:15]:
        conc_rows.append(
            "<tr>"
            f'<td>{esc(h["host"])}</td><td>{h["count"]}</td><td>{h["overcharge"]}</td>'
            f'<td>{h["undercharge"]}</td><td>{h["critical"]}</td><td>${h["exposure_usd"]:,.2f}</td>'
            "</tr>"
        )

    mismatch_body = f"""
<h1>Price mismatches: catalog claim vs. live reality</h1>
<p>An agent that auto-pays off a cached catalog price can be charged more than the catalog says &mdash;
sometimes by orders of magnitude. This page is built directly from a live probe run, not from the catalog.</p>

<div class="stat-row">
  <div class="stat"><span class="n">{meta['comparable']:,}</span><span class="l">comparable routes</span></div>
  <div class="stat"><span class="n">{meta['mismatch_count']:,}</span><span class="l">mismatches ({meta['mismatch_pct']}%)</span></div>
  <div class="stat"><span class="n">{meta['overcharge_count']:,}</span><span class="l">overcharges (dangerous direction)</span></div>
  <div class="stat"><span class="n">{meta['undercharge_count']:,}</span><span class="l">undercharges</span></div>
  <div class="stat"><span class="n">{meta['critical_count']:,}</span><span class="l">CRITICAL severity</span></div>
</div>

<div class="callout danger">
<strong>Severity definitions.</strong> CRITICAL = overcharge where live price &gt; $100, or ratio &ge; 100x,
or the catalog claimed the route was free. HIGH = any other overcharge. LOW = undercharge (never dangerous
to a paying agent, so never ranked above an overcharge). Ranked within a tier by absolute dollar exposure
per call, not by ratio &mdash; a modest multiplier on an expensive route can cost more per call than an
extreme multiplier on a cheap one.
</div>

<h2>Top offenders</h2>
<table>
<thead><tr><th>Severity</th><th>Host</th><th>Route</th><th>Direction</th><th>Catalog $</th><th>Live $</th><th>Ratio</th><th>Exposure $/call</th><th>Catalog age</th></tr></thead>
<tbody>{''.join(lb_rows)}</tbody>
</table>
<p class="small">Showing top {min(100, len(leaderboard_sorted))} of {len(leaderboard_sorted)} mismatches, most severe first. Full list: <code>mismatch.json</code> in the project repo.</p>

<h2>Host concentration</h2>
<p>{concentration['distinct_hosts_with_mismatches']} distinct hosts carry at least one mismatch.</p>
<table>
<thead><tr><th>Host</th><th>Mismatches</th><th>Overcharges</th><th>Undercharges</th><th>Critical</th><th>Net exposure $</th></tr></thead>
<tbody>{''.join(conc_rows)}</tbody>
</table>

<h2>What this can and cannot rule out</h2>
<div class="callout warn">
<p>We cannot see upstream price-change history &mdash; Coinbase's catalog overwrites its quality metrics
every ~6 hours rather than versioning them, so we only know catalog age at probe time, not whether a
price changed once or repeatedly.</p>
<p>A young catalog age is <em>consistent with</em> a legitimate recent reprice and is reported as such,
not asserted as innocent. An old catalog age with a persisting mismatch argues against "we just changed
the price and haven't republished" &mdash; but a single probe still cannot distinguish deliberate
variable/dynamic pricing from static misconfiguration. Only a second probe run at a different time would
show whether the live price moves. Templated routes (<code>/:param</code>) are excluded from this
leaderboard entirely: a probe against a literal example path is not representative of a real call.</p>
</div>
"""
    with open(os.path.join(SITE_DIR, "mismatch.html"), "w", encoding="utf-8") as f:
        f.write(page(
            title="Price Mismatches \u2014 402cap",
            description=f"{meta['mismatch_count']} x402 routes charge a different live price than their "
                         f"catalog listing claims, {meta['critical_count']} of them CRITICAL severity.",
            body=mismatch_body, root="", generated_at=generated_at, snapshot_id=snapshot_id, run_id=run_id,
        ))
    print(f"[build_site] wrote mismatch.html ({len(leaderboard_sorted)} mismatches, top = {leaderboard_sorted[0]['host']} {leaderboard_sorted[0]['ratio']}x)", file=sys.stderr)

    # ================= methodology.html =================
    methodology_body = f"""
<h1>Methodology</h1>
<p>What 402cap measures, how, and &mdash; just as importantly &mdash; what it does not yet know.
Every number on this site traces back to one of the two sources below.</p>

<h2>What we measure</h2>
<dl class="kv">
  <dt>Catalog claim</dt><dd>A full fetch of Coinbase CDP's Bazaar catalog (currently
  {fmt_num(len(rows))} routes / {n_hosts:,} hosts). This is what operators <em>declare</em> about
  themselves: price, network, asset, 30-day call/payer counts as CDP reports them.</dd>
  <dt>Measured reality</dt><dd>A single <strong>unpaid</strong> HTTP request to each route. Every
  x402 endpoint returns a 402 challenge with its real price, asset, network, and spec version before
  any payment is required &mdash; probing costs nothing and moves no money. We never construct or send
  an <code>X-PAYMENT</code> / <code>PAYMENT-REQUIRED</code> payment header.</dd>
</dl>
<p>These two are stored separately and never merged, because the gap between them is the product.</p>

<h2>What we do NOT know (stated plainly, not smoothed over)</h2>
<div class="callout warn">
<ul>
<li><strong>The dollar size of the x402 economy is not established on this site.</strong> On-chain
transaction <em>count</em> for Coinbase's facilitator addresses has been independently verified
(matching a third party's claim to 0.02%). The dollar <em>value</em> those transactions move has not
been independently verified and is deliberately not quoted here.</li>
<li><strong>Estimated 30-day GMV (<code>est_gmv_30d_usd</code>) is ours, derived, and an upper bound</strong>
&mdash; cheapest listed price &times; CDP-reported call count. It breaks badly on variable-amount routes
and is dominated by a handful of high-nominal-price outliers. Never treat it as revenue.</li>
<li><strong>"30-day calls" and "unique payers" are CDP's own numbers, over CDP's own window.</strong>
We do not independently verify call counts; we only compare the price CDP claims against the price we
measure.</li>
<li><strong>A single probe cannot distinguish a legitimate dynamic price from static misconfiguration</strong>,
and cannot tell a deliberate recent reprice from a bait-and-switch. See the mismatch page's caveats.</li>
<li><strong>Templated routes are not tested for liveness.</strong> A path containing a <code>:param</code>
segment (4.3% of the catalog) is probed as a literal string; a failure there is not evidence the service
is dead, and we do not report it as dead.</li>
<li><strong>The <code>curated</code> flag's selection criteria are undocumented by Coinbase.</strong> We
record it verbatim and make no claim about what it means.</li>
<li><strong>Every route is probed once per run.</strong> Latency and status reflect one HTTP round trip
at one point in time, not an uptime history.</li>
</ul>
</div>

<h2>Withhold-rather-than-guess conventions</h2>
<ul>
<li>A price is shown as <code>unknown (decimals not established)</code>, never as <code>$0.00</code>,
when the asset's decimal precision is not in our reference table.</li>
<li>Spec violations are flagged, never silently repaired.</li>
<li>Any hosted <code>SKILL.md</code> a route declares is recorded as an untrusted third-party URL and is
never fetched or executed by us.</li>
</ul>

<p class="small">Full technical detail, including the two upstream API traps this pipeline defends
against (a clamped-offset pagination bug and a drifting <code>total</code> count), is in this project's
<code>README.md</code>.</p>
"""
    with open(os.path.join(SITE_DIR, "methodology.html"), "w", encoding="utf-8") as f:
        f.write(page(
            title="Methodology \u2014 402cap",
            description="What 402cap measures, how, and what it explicitly does not yet know.",
            body=methodology_body, root="", generated_at=generated_at, snapshot_id=snapshot_id, run_id=run_id,
        ))
    print("[build_site] wrote methodology.html", file=sys.stderr)

    dt = time.time() - t0
    print(f"[build_site] DONE in {dt:.1f}s. Total pages: {n_detail + 3}", file=sys.stderr)


if __name__ == "__main__":
    main()
