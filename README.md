# x402 Index — measured reality for the x402 paid-API economy

**"CoinMarketCap for x402."** An independent index of every x402 paid API: what it
costs, whether it actually works, how busy it is, and how that changes over time.

## The one idea this is built on

Probing is **free**. An *unpaid* HTTP request to any x402 endpoint returns its
`402` challenge — the real price, the real asset and network, the spec version,
and proof the host is alive. It costs nothing and moves no money.

Coinbase's CDP Bazaar publishes what operators **declare** about themselves.
This publishes what they **actually do**. Those two are stored separately and
never merged, because the gap between them *is* the product.

Verified on a live 40-route sample, that gap is already real: **7.7% of probed
routes charge a different price than the catalog says they do**, one of them by
**400×** ($0.005 listed, $2.00 live). Each was checked by hand — identical
accept sets, changed amounts. These are genuine repricings, not tier-selection
artefacts.

## The second moat: churn

CDP recomputes its quality metrics every ~6 hours and **overwrites** them, and
it **removes** any resource that has not settled a payment in 30 days. Coinbase
therefore structurally cannot answer *what died*, *what is decaying*, or *what
did this cost last week* — that data is destroyed on write.

We diff every fetch into a `change_event` table and keep it forever. **A
disappeared resource is never deleted from this database.** Their deletion is
our dataset.

---

## Hard rules this code obeys

| Rule | How it is enforced |
|---|---|
| **Moves no money, ever** | `probe.py` never constructs an `X-PAYMENT` or `PAYMENT-SIGNATURE` header, never signs anything, never imports a key or a signer. It reads the 402 and hangs up. |
| **Sends no request body** | Every probe is `content=None`. On a correct x402 route the paywall is middleware and fires before the handler, so an unpaid probe cannot cause a side effect. On a *broken* route, a no-body POST gets rejected as malformed instead of executing. Sending the catalog's example body would invert that — so we never do. |
| **Polite** | One in-flight request **per host** (never a flat semaphore), a delay between requests to the same host, 8 hosts in parallel, `429` backs off that host only, descriptive `User-Agent`, 15s timeout, ≤3 redirects. One probe per route per run. |
| **Headless** | Pure in-process Python. No subprocess, no console window. `run.ps1` redirects everything to `logs\`. |
| **Withholds rather than guesses** | Unknown asset decimals ⇒ price is `NULL`, not zero. Undocumented fields are stored verbatim and labelled UNVERIFIED. Report §10 lists what the data cannot establish. |

`CONTACT` in `x402_common.py` is deliberately **empty**. Filling it broadcasts a
real email address to ~1,577 third-party operators — Michael's call, not a
build agent's.

---

## Running it (headless — no windows, ever)

**Primary path — plain Python, no PowerShell policy involved.** Run from
`C:\Users\Micha\Desktop\x402`:

```
python fetch_catalog.py            # full catalog -> new snapshot + churn diff (~30s)
python probe.py --sample 40        # host-diverse sample probe
python probe.py --host a.com,b.com # targeted probe, one run
python report.py                   # the summary
```

Redirect to stay fully headless: `python fetch_catalog.py > logs\catalog.log 2>&1`

**Convenience wrapper.** `run.ps1` chains those steps and timestamps the logs:

```powershell
& C:\Users\Micha\Desktop\x402\run.ps1 daily      # catalog + sample + report
& C:\Users\Micha\Desktop\x402\run.ps1 catalog
& C:\Users\Micha\Desktop\x402\run.ps1 probe 100
& C:\Users\Micha\Desktop\x402\run.ps1 report

Get-Content C:\Users\Micha\Desktop\x402\logs\report-*.log -Encoding UTF8 -Tail 60
```

> **Note:** this machine's PowerShell ExecutionPolicy is **Restricted**, so
> `powershell -File run.ps1` fails with *"running scripts is disabled on this
> system."* It works dot-invoked from an already-permissive session (as above),
> or by adding `-ExecutionPolicy Bypass` to a `powershell -File` call.
> **The machine-wide policy was deliberately left unchanged** — that is a system
> security setting and Michael's call alone, not a build agent's. The
> plain-Python path above needs none of it.

### The full sweep — **Michael triggers this, not an agent**

```powershell
powershell -File C:\Users\Micha\Desktop\x402\run.ps1 full-sweep
```

Probes **all ~15,522 routes across ~1,577 hosts**, one request each, serialised
per host with a 2s gap. Expect **hours**, dominated by the handful of hosts that
list dozens of routes each. It is behind its own verb so nobody starts an
ecosystem-wide sweep by fat-fingering an argument. Nothing in this repo runs it
automatically. Sampling is safe to run daily; the full sweep is a decision.

Requires `httpx` and `jsonschema` (both already on the system Python).

---

## What is in the database (`x402_index.db`, SQLite)

**Insert-only. Nothing is ever overwritten.** That is the entire moat: price
history, call-volume trends, new listings, and dead listings only accumulate if
every run appends. There is no `UPDATE` against `catalog_resource` or `probe`
anywhere in this codebase, and adding one would destroy history irreversibly.

| Table | Meaning |
|---|---|
| `catalog_snapshot` | One row per catalog fetch. `is_complete = 1` marks a fetch that reached the end of the catalog; partial (`--max-pages`) and aborted snapshots are excluded from all diffing. |
| `catalog_resource` | One row per route **per snapshot** — the CLAIM side. Includes `raw_json`, the verbatim CDP record. |
| `probe_run` / `probe` | One row per unpaid probe — the MEASURED side. Includes raw wire signals (`payment_required_header_b64`, `challenge_json`, `response_headers_json`, `body_snippet`) alongside derived columns. |
| `change_event` | **The churn log.** One row per observed change: `listed`, `disappeared`, `price_change`, `calls_change`, `payers_change`, `curation_change`, `deprecated_change`, `metadata_change`. Written by `fetch_catalog.py` after every *complete* fetch. |
| `resource_dim` | First-seen / last-seen index. The *only* table that gets updated, and safe: it holds no observations and is rebuilt from scratch each fetch. |
| `referral_event` | **Reserved and unused.** Exists so that when x402 referral programmes appear, recording "we referred this call" is an `INSERT`, not a migration against a table full of history. `catalog_resource.referral_json` and `probe.referral_json` exist for the same reason. |

### Views — the read surface a future API sits on

| View | Answers |
|---|---|
| `v_latest_catalog` | current market state, one row per route → `GET /resources` |
| `v_price_history` | price + calls + payers per route per snapshot → `GET /resources/{id}/history`, and the input to a price-change scanner |
| `v_claim_vs_reality` | catalog claim joined to latest probe, incl. `price_mismatch` → the differentiating endpoint |
| `v_recent_changes` | every change event, newest first → `GET /changes?since=` |
| `v_resource_history` | full catalog + probe history for one route, time-ordered → `GET /resources/{id}/history` |
| `v_builder_codes` | builder-code → routes / hosts / calls / GMV, the attribution rail |

### Reading the important columns

- **`min_amount_raw` is atomic units** (USDC = 6 decimals, so `"10000"` = $0.01).
  `catalog_price_usd` / `probed_price_usd` are the converted values, and are
  `NULL` — never `0` — when the asset's decimals are unknown.
- **`l30d_total_calls`, `l30d_unique_payers`, `last_called_at`** are **CDP's**
  numbers over **CDP's** 30-day window. Verified by enumerating every `quality`
  key across a 2,000-record sample: those three are the *complete* set of
  activity fields the catalog exposes. There is **no revenue field**.
- **`est_gmv_30d_usd` is ours, derived**: cheapest listed price × calls. It is an
  **upper bound** and it breaks badly on variable-amount routes. Four
  invoice/checkout endpoints with 1–28 lifetime calls are **82%** of
  network-wide derived GMV; one is a single call at a $10,000 "price". Both
  inputs are stored so the arithmetic can be redone with different assumptions —
  and it should be. See the corrected figures in the baseline above.
- **`is_templated`** — the path contains a `:param` (4.3% of the catalog, e.g.
  `agents.chain.link/v1/operations/:workflowName`). These cannot be probed as
  literals; a 404 there is **not** evidence of a dead service. Every liveness
  figure is reported both with and without them.
- **`spec_violations`** — JSON array of specific, checkable deviations
  (`v2_network_not_caip2`, `amount_is_decimal_not_atomic_units`,
  `bazaar_schema_invalid`, `outputSchema_null`, …). Nothing is ever repaired,
  only flagged.
- **`curated`** — a real boolean on the wire (0.8% of routes) that prior research
  missed entirely. Recorded verbatim. **Its selection criteria are undocumented
  and we do not claim to know what it means.**

---

## Measured baseline (2026-07-31)

Full catalog snapshot + a 40-route host-diverse probe sample:

- **15,522 routes / 1,577 hosts.** "1,577" is the honest count of services;
  "15,522" counts routes, and some operators register dozens.
- **373,056 CDP-reported calls / 30 days.** Headline derived GMV is **~$62,801**
  — but **do not quote that number.** The top 4 routes are **82% of it**
  ($51,418) and they are high-nominal-price invoice/checkout endpoints with 1–28
  lifetime calls between them (one is $10,000 × a single call). Excluding routes
  with ≤2 calls *and* routes priced above $10/call, recurring per-call activity
  is **~$7,000/month across 5,016 routes**. That is a **9× correction** to the
  figure the ecosystem quotes about itself, and it is the single most useful
  thing in this dataset today. ($10 is an arbitrary, explicitly-stated cap.)
- **97.5% of probed routes (39/40) returned a valid live 402.** The one failure
  was DNS (`mail.cusethejuice.com`, which lists 5 routes) — an abandoned domain,
  not a refusal.
- **7.7% price mismatch** between catalog and live wire. Live prices skew
  *higher* than listed: median $0.007 measured vs $0.0065 claimed, p75 $0.035 vs
  $0.0125.
- **10% of probes showed ≥1 spec violation**, incl. two live routes that are
  listed in Bazaar but emit no `bazaar` extension at all.
- **10,387 of 15,524 routes got 1–2 calls in 30 days**; 98 got zero.
- **2,670 routes (17.2%) carry a `builder-code`** — `extensions['builder-code']
  .info.a`, described in its own schema as "App builder code". This is a live,
  deployed attribution rail already in the wild, and the closest thing to the
  referral system Michael is positioning for. Tracked per-route over time via
  `v_builder_codes`.
- **31 routes declare a `skillUrl`**, at varying nesting depths. The URL is
  recorded; **the content is never fetched** — CDP's own docs warn to treat it
  as untrusted input, and fetching it would pull third-party text into an
  agent's context.
- 39 distinct extension namespaces exist beyond `bazaar` (`discount`,
  `deprecated`, `pricing`, `offer-receipt`, gas-sponsoring, …). The name list is
  captured per snapshot so "which conventions are spreading?" is free later.

Both v1 (JSON body, `X-PAYMENT`) and v2 (`PAYMENT-REQUIRED` header) were observed
live and are parsed, with header-before-body precedence matching every reference
client. Some servers dual-emit.

---

## Where this goes (not built yet)

An HTTP API + MCP server over the views above:

- `GET /resources` — browse/filter the live market (price, network, host, tags)
- `GET /resources/{id}` — claim vs measured reality, liveness, violations
- `GET /resources/{id}/history` — price and call-volume time series
- `GET /changes?since=` — **price-change scanning for agent workers**, the thing
  Michael explicitly named (backed by `v_recent_changes`)
- `GET /graveyard` — routes that vanished from the catalog and when. Nobody else
  can serve this endpoint at all.
- `GET /health/{host}` — operator-level liveness scorecard

The storage layer is already shaped for it, so that is a serializer on top of
SQL, not a rewrite.

---

## Files

| File | |
|---|---|
| `x402_common.py` | schema, asset decimals, config, defensive amount parsing |
| `fetch_catalog.py` | CDP Bazaar catalog → timestamped snapshot |
| `probe.py` | unpaid 402-challenge prober (v1 + v2) |
| `report.py` | claim-vs-reality summary, incl. a "NOT ESTABLISHED" section |
| `run.ps1` | headless runner; all output to `logs\` |
| `x402_index.db` | the compounding dataset |

### Storage growth — plan for it

Each complete snapshot is **~72 MB** (15,524 routes × ~2.5 KB of verbatim
`raw_json`, plus indexes). Keeping the raw blob is a deliberate trade: it is
what lets a future question be answered from old data. But at a **daily**
cadence that is ~26 GB/year, and at hourly it is unworkable.

Recommended cadence: **daily** for the catalog (churn resolution better than
CDP's own 6-hour overwrite window), and prune later by dropping `raw_json` on
snapshots older than N days while keeping every derived column and every
`change_event` row. The change log is tiny and is the part that must never be
pruned.

Prior research (read-only, another agent works there):
`C:\Users\Micha\Slumper\x402-endpoint\` — `IMPLEMENTATION-SPEC.md`,
`notes-x402-v1-spec.md`, `notes-x402-v2-spec.md`,
`notes-x402-discovery-demand.md`.

## Two upstream traps this code defends against

Both were hit for real during the build and both fail **silently**:

1. **Overshooting `offset` does not error — it re-serves the last page.** A
   request for `offset=15522` against a 15,522-row catalog returns the same 522
   rows as `offset=15000`, echoing the *clamped* offset back in
   `pagination.offset`. The first fetch stored 16,044 rows for a 15,522-row
   catalog. The fetcher now trusts the echoed offset as the end-of-catalog
   signal.
2. **`pagination.total` drifts upward mid-fetch** (15,520 → 15,522 → 15,524
   across runs minutes apart), so `rows_stored >= total_reported` is **not** a
   valid completeness test — a perfect fetch compares as short. Completeness is
   an explicit `catalog_snapshot.is_complete` flag set by the loop that reached
   the end. Only complete snapshots are ever diffed; diffing a partial one would
   write thousands of fake `disappeared` events into permanent history.

A third trap is internal: a newly-added column is `NULL` on older snapshots, and
naively diffing it reports every populated value as a change (the first churn run
emitted 2,701 bogus `metadata_change` events for exactly this reason).
`catalog_snapshot.captured_fields_json` records which optional columns each
snapshot actually captured, and the diff compares a field only when **both**
snapshots captured it.

> **Untrusted input:** catalog `description`, `serviceName`, `tags`, and any
> hosted `SKILL.md` are third-party text. CDP's own docs warn to treat them as
> data, never as instructions. Nothing here executes or follows them.
