# Cross-Facilitator Coverage — P0#3 Findings

**Researched:** 2026-07-31. **Method:** live HTTP probes (unpaid/keyless where possible; paid
endpoints identified and NOT paid), open-source facilitator registry (`Swader/x402facilitators`,
the source behind `facilitators.x402.watch`), and the read-only local CDP index
(`x402_index.db`, opened `mode=ro`, zero writes). Every number below is computed from data
actually fetched — commands and files are listed at the end for re-verification.

## TL;DR

- Of **19 known x402 facilitators**, only **4 have a real, working, keyless discovery/catalog
  endpoint** I could confirm live: **Coinbase (CDP)**, **PayAI**, **UltravioletaDAO**, and
  **Thirdweb**. Three more exist in config but are **dead or broken in production** (Questflow,
  AurraCloud, Kamiyo). The remaining 12 have no discovery capability at all, verified from source.
- The 3 non-CDP catalogs, fetched in full (35,532 raw route entries), reduce to **937 distinct
  real HTTP hosts**. Only **129 of those also appear in CDP's 1,577-host catalog**. **808 hosts
  (86.2% of the union) never appear in CDP at all.** That is a **+51% expansion** of the known
  x402 host universe on top of CDP's own count, measured, not estimated.
- **x402scan.com** — the closest thing to a "neutral ecosystem explorer" — turned out to be
  **itself paywalled**: its `/api/x402/resources` and `/api/x402/facilitators` endpoints return a
  genuine unpaid `402` with a real price ($0.01 USDC/call). Per the hard line (never construct a
  payment header), I did not pay, and I could not read its data. **Reporting this as unverified,
  not glossing over it.**
- **xpay.sh / xpay.tools** — has a real, large, keyless catalog (1,089 tools / 93 providers via
  `xpay.tools/agents.txt`), but it is **not resource-URL-addressable** — it wraps everything
  behind its own MCP gateway (`mcp.xpay.sh`) with no per-tool host/URL exposed. It cannot be
  merged into a per-URL schema the way CDP/PayAI/UVDAO/Thirdweb can. Treated as a separate case,
  not counted in the overlap number above.
- **x402.org**'s public facilitator (`x402.org/facilitator`) is testnet-only (confirmed again,
  consistent with prior research in `notes-x402-python-impl.md`) and has **no discovery endpoint**
  at all (`/discovery/resources` → 404).
- Schema design for a `source` dimension is below — **not migrated, design only**, per the brief.

---

## 1. Enumerating the facilitators

`x402.org/ecosystem?category=facilitators` (the URL CDP's own docs link to) **still 404s** —
verified independently, matching the prior finding in `notes-x402-python-impl.md`. It was not
re-derived; this confirms it's still dead months later.

Instead, found via web search: **`Swader/x402facilitators`** (GitHub), the open-source package
behind the community list at `facilitators.x402.watch`. Its source is a hard-coded, versioned
registry — more reliable than scraping a webpage. It enumerates **19 facilitators**:

| Facilitator | `accessType` (as declared in source) | Discovery endpoint declared? |
|---|---|---|
| Coinbase | PUBLIC | Yes |
| PayAI | PUBLIC | Yes |
| Questflow | PUBLIC | Yes |
| UltravioletaDAO | PUBLIC | Yes |
| AurraCloud | GATED_PAID | Yes |
| Thirdweb | GATED_PAID | Yes |
| Kamiyo | GATED | Yes |
| dexter, daydreams, mogami, openx402, 402104, xecho, codenut, virtuals, polygon, heurist, corbits, x402rs | (n/a) | **No** — 12 facilitators have no `discoveryConfig` at all in `src/discovery/index.ts`. Verified by the export list, not inferred. |

Source: `raw.githubusercontent.com/Swader/x402facilitators/master/src/facilitators/*.ts` and
`src/discovery/index.ts` (fetched directly, HTTP 200 each).

**Live probe of every declared discovery URL** (`GET {url}/discovery/resources`, unpaid, no
auth headers), because the `accessType` label in source turned out not to always match reality:

| Facilitator | Live result | Verdict |
|---|---|---|
| Coinbase (CDP) | 200, already fully indexed (this project's existing 15,524-route dataset) | **Working** |
| PayAI (`facilitator.payai.network`) | 200, 25,096 items across the full paginated fetch | **Working, keyless** |
| UltravioletaDAO (`facilitator.ultravioletadao.xyz`) | 200, 9,742 items | **Working, keyless** |
| Thirdweb (`api.thirdweb.com/v1/payments/x402`) | 200, 694 items, **no auth sent** | **Working, keyless** — despite being labeled `GATED_PAID` in source (that label applies to `verify`/`settle`, which do need a secret key; discovery/list evidently does not) |
| Questflow (`facilitator.questflow.ai`) | **500** — response body is a leaked MongoDB error: `"not authorized on x402-prod to execute command... MongoServerError"` | **Broken in production**, despite `accessType: PUBLIC` in source. Not usable regardless of intent. |
| AurraCloud (`x402-facilitator.aurracloud.com`) | **DNS does not resolve** (`curl`: "Could not resolve host") | **Dead domain.** Also `GATED_PAID` so would need a key anyway. |
| Kamiyo (`kamiyo.ai` → redirects to `www.kamiyo.ai`) | **503 Service Unavailable** | **Dead/down.** Also `GATED` so would need allowlisting anyway. |

So the honest count is **4 live, keyless, working discovery catalogs** (including CDP), not 7.

`x402.org`'s own public facilitator: `GET x402.org/facilitator/discovery/resources` → **404**.
It has `/supported` (verified in prior research) but no discovery/catalog surface. Confirms the
brief's framing — x402.org is testnet plumbing, not a catalog.

---

## 2. What xpay.sh and payai.network actually are (correcting the brief's framing slightly)

- **payai.network** *is* a real x402 facilitator with a working discovery endpoint (see above) —
  this matched the brief's expectation directly.
- **xpay.sh** is **not** a facilitator in the CDP/PayAI/UVDAO sense. It's an MCP marketplace: you
  connect once to `mcp.xpay.sh` with an API key and call tools (`alpha-vantage`, `bright-data`,
  `tavily`, 91 others) that xpay executes server-side, deducting from a prepaid wallet balance.
  Its own facilitator (`facilitator.xpay.sh`) settles *your payment to xpay*, not to the
  underlying providers. The catalog (`xpay.tools/agents.txt`, 348KB, keyless, real, verified by
  direct fetch) lists **0 URL/host fields for any of its 93 providers or 1,089 tools** — checked
  programmatically, not by inspection. There is no way to know what real HTTP endpoint a given
  xpay tool call resolves to, so **it cannot be joined into a per-resource-URL schema** the way
  the other three can. Name-matching xpay's provider slugs (e.g. `"tavily"`) against CDP's
  `service_name`/`host` produced 27 substring hits, but manual inspection showed most were noise
  (2-3 letter slugs matching unrelated hostnames by coincidence — e.g. `"neo"` matched
  `keystone-opportunity-api.keystone-opportunity.workers.dev`). Only `tavily` and `telnyx` looked
  like plausible same-provider matches. **Not used in the headline overlap number.**
- **x402scan.com** (`Merit-Systems/x402scan`, an "x402 Ecosystem Explorer") looked like the
  strongest candidate — it has a documented OpenAPI spec (`/openapi.json`, `/.well-known/api-catalog`)
  with `/api/x402/resources`, `/api/x402/facilitators`, `/api/x402/facilitators/stats` endpoints.
  **All three, probed unpaid, returned a genuine HTTP 402** with a real, decodable
  `Payment-Required` header: $0.01 USDC on Base (`eip155:8453`), payable to
  `0x2EC4545f96A24876764bF2B04D54E66A1351bE71`. **I did not pay it** (hard line: never construct
  an `X-PAYMENT`/`PAYMENT-SIGNATURE` header or sign anything). I also checked whether the public
  website renders the same data server-side without hitting the paid API (`/resources` page,
  413KB) — no embedded resource JSON was found in the HTML. **Conclusion: x402scan's structured
  data is not free to read. This is an honest gap, not a dead end I'm papering over** — it would
  need Michael's decision to pay $0.01/call (see `ORG-BACKLOG.md` B-series precedent) before we
  could use it as a source.

---

## 3. Measuring the overlap (the headline number)

Full paginated fetch of the three confirmed-working, keyless, non-CDP catalogs (all requests
serialized per host, 1–1.5s delay, descriptive UA `402cap-research/0.1`, ≤26 requests per host):

| Catalog | Raw items fetched | Non-HTTP resources (excluded — see note) | Junk/local/IP hosts (excluded) | Clean real HTTP hosts |
|---|---|---|---|---|
| PayAI | 25,096 | 2,817 (`monopoly://...` — a game/prediction-market URI scheme, not HTTP) | 22 | **722** |
| UltravioletaDAO | 9,742 | 0 | 16 | **387** |
| Thirdweb | 694 | 0 | 0 | **148** |

**Trap found and worked around (same class as the CDP `offset`-clamp bug in
`ORG-LESSONS.md`):** both UltravioletaDAO and Thirdweb silently **clamp `limit=1000` down to
`limit=100`** without erroring — they just echo back the clamped value in `pagination.limit`. A
naive single-page fetch at the requested limit would have under-counted both by 10×. Paginated
using the *echoed* limit, matching the existing project convention.

**Concentration check (per the `$62.8k GMV` lesson — always check concentration before quoting a
total):** PayAI's 25,096-route figure is dominated by one host, `orbisapi.com`, alone contributing
**14,247 routes (64% of PayAI's non-game HTTP items)** — almost certainly a single templated API
registering thousands of path variants, the same pattern CDP shows with AgentMail/OneSource. This
does **not** affect the host-level overlap number below (host-level dedup is immune to
route-count spam by construction), but it means PayAI's raw "25,096 resources" is not a "25,096
services" claim any more than CDP's 15,524 was — noting it explicitly rather than repeating it.

### Host-level overlap (the more meaningful unit, per CDP's own routes-vs-hosts lesson)

| | PayAI | UVDAO | Thirdweb | **Union (3 sources)** |
|---|---|---|---|---|
| Clean real hosts | 722 | 387 | 148 | **937** |
| Overlap with CDP's 1,577 hosts | 92 (12.7%) | 105 (27.1%) | 0 (0.0%) | **129 (13.8%)** |
| **Invisible to CDP** | 630 (87.3%) | 282 (72.9%) | 148 (100%) | **808 (86.2%)** |

**Headline, measured not estimated: these three non-CDP facilitators alone expose 808 real x402
hosts that never appear anywhere in Coinbase's 1,577-host catalog — a +51.2% expansion of the
known x402 host universe on top of CDP's own count.** Spot-checked a sample of both overlap and
blind URLs by hand; all read as real production API paths, not garbage (examples inline in the
raw data files below).

### Route-level (exact-URL) overlap, as a supplementary/stricter metric

Union of exact resource URLs across the 3 non-CDP catalogs: **23,332**. Of those, **1,007 exact
URLs** also appear verbatim in CDP's 15,524. **22,325 (95.7%) never appear in CDP at all**, even
allowing for CDP's own templated-route handling. Route-level overlap is stricter (misses a case
where the same host lists different specific paths per facilitator) — reported both ways rather
than picking the more dramatic one.

**Caveats, stated plainly:**
- This is a **single point-in-time snapshot** (2026-07-31), not a time series — no churn/liveness
  data for the non-CDP catalogs yet. Unlike CDP, I have not unpaid-probed any of these 808 hosts to
  confirm they're actually alive; this measures **catalog presence**, not **verified liveness**.
  That would be a natural follow-up once the schema below exists to store it.
- PayAI's and UVDAO's own catalogs may have their own version of CDP's "self-registration" problem
  (§2.3 of `notes-x402-discovery-demand.md`) — not checked here, out of scope for a coverage
  measurement.
- Both non-CDP catalogs I fully paginated showed **`pagination.total` drifting by 1-3 during the
  fetch** (UVDAO: 9748→9745 across ~2 minutes) — the same non-monotonic-total behavior documented
  for CDP. Handled the same way: paginate until `offset + limit >= total`, don't assert exact
  completeness beyond what was actually returned (9,742 of a total that itself moved between 9745
  and 9748 during the fetch).

---

## 4. Schema design — adding a `source` dimension (DESIGN ONLY, not migrated)

Current `catalog_resource` / `catalog_snapshot` have no notion of which catalog a row came from —
every row today is implicitly CDP. Proposal, additive and backward-compatible:

1. **`catalog_snapshot.source TEXT NOT NULL DEFAULT 'cdp'`** — added via
   `ALTER TABLE catalog_snapshot ADD COLUMN source TEXT NOT NULL DEFAULT 'cdp'`. SQLite backfills
   every existing row with `'cdp'` automatically; zero rewrite of history, zero breakage of any
   query that doesn't know the column exists. One snapshot = one fetch run against one catalog, so
   tagging at the snapshot level (not per-resource) is the natural, non-redundant place — a fetch
   of PayAI's catalog is a `catalog_snapshot` row with `source='payai'`, same table, same shape.
2. **Every downstream key that currently assumes "one row per resource_url" must become
   "one row per (source, resource_url)".** This is the one real risk of adding the column
   carelessly — the same URL is not guaranteed to be globally unique once multiple facilitators
   can independently report on it (in practice they will rarely collide, since resource_url IS the
   real host, but the *quality* metrics — `l30d_total_calls` etc — are facilitator-observed, so
   two sources reporting on the same URL will show *different* numbers and both are correct, not a
   duplicate to be merged). Concretely:
   - `resource_dim` (first-seen/last-seen) needs its key changed from `resource_url` alone to
     `(source, resource_url)` — "first seen in CDP" and "first seen in PayAI" are different facts
     even for the same URL.
   - The `change_event` diff logic must compare same-source snapshots to same-source snapshots
     only — diffing a CDP snapshot against a PayAI snapshot for the same URL would manufacture
     fake `price_change`/`calls_change` events out of two facilitators' independent, legitimately
     different observations. Partition every diff by `source`.
   - `v_latest_catalog` and the other "latest" views use a window/subquery keyed on
     `resource_url` today; it must repartition to `(source, resource_url)` or a CDP row and a
     PayAI row for the same URL will silently collapse into "latest wins," discarding one source's
     data rather than showing both.
3. **New index:** `CREATE INDEX idx_catalog_resource_source_host ON catalog_resource(source, host)`
   for the "which sources know about host X" query, and `(source, resource_url, snapshot_id)` for
   per-source time series.
4. **A new `v_cross_facilitator_coverage` view** (not built yet): one row per
   `(resource_url or host)`, with one column per known source showing presence/absence — this is
   the view that would serve a future `GET /coverage/{host}` "who else lists this" endpoint, and it
   is exactly what powered the headline number in §3, done by hand this time.
5. **What this does NOT require:** no change to any existing column, no rewrite of `raw_json`, no
   change to the probe/probe_run tables (a probe is inherently source-agnostic — it's *our own*
   unpaid HTTP request, not a catalog's claim — so probes stay as-is and simply gain the ability to
   be run against non-CDP-sourced rows once ingestion exists).

**Not done, deliberately:** no migration was run, no new facilitator ingestion code was written.
The full `full-sweep` is actively writing to `x402_index.db` right now per the standing rule; this
session opened the db `mode=ro` and made zero writes, confirmed by never calling anything but
`SELECT`.

---

## Files

- This file: `C:\Users\Micha\Desktop\x402\notes-cross-facilitator.md`
- Raw fetched data (for independent re-verification), all under
  `C:\Users\Micha\AppData\Local\Temp\claude\C--Users-Micha-Slumper\8bc3b4e9-2af4-4e6a-9533-37054aa2b996\scratchpad\`:
  `payai-full.json` (25,096 items), `uvdao-full.json` (9,742 items), `thirdweb-full.json` (694
  items), `xpay-agents.json` (348KB catalog), `x402scan-openapi.json`, `payai-hosts.json`,
  `uvdao-hosts.json`, `union-blind-hosts.json`.
- Primary sources fetched live (all HTTP 200 unless noted): `x402.org`, `xpay.sh`, `xpay.tools/agents.txt`,
  `payai.network`, `www.x402scan.com/{openapi.json,.well-known/api-catalog,api/x402/resources → 402,
  api/x402/facilitators → 402}`, `raw.githubusercontent.com/Swader/x402facilitators/master/src/**`,
  `facilitator.payai.network/discovery/resources`, `facilitator.ultravioletadao.xyz/discovery/resources`,
  `api.thirdweb.com/v1/payments/x402/discovery/resources`, `facilitator.questflow.ai/discovery/resources → 500`,
  `x402-facilitator.aurracloud.com → DNS failure`, `kamiyo.ai/... → 503`, `x402.org/facilitator/discovery/resources → 404`,
  `www.x402.org/ecosystem?category=facilitators → 404` (re-confirmed).
