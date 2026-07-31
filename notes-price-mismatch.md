# Price-mismatch monitor — catalog claim vs measured 402 reality

Catalog snapshot 8 (fetched 2026-07-31T08:27:47.035116+00:00), probe run 7 (started 2026-07-31T08:28:54.880937+00:00).

- Comparable routes (both prices known): **376**
- Mismatches: **16** (4.3% of comparable)
  - Overcharges (dangerous direction — live > catalog): **14**
  - Undercharges (live < catalog): **2**
  - CRITICAL severity: **3**

Severity tiers: CRITICAL = overcharge where live price > $100, or ratio >= 100x, or catalog claimed the route free. HIGH = any other overcharge. LOW = undercharge (never dangerous to a paying agent, so never ranked above an overcharge). Ranked within a tier by absolute dollar exposure, not by ratio — a modest multiplier on an expensive route can cost more per call than an extreme multiplier on a cheap one.

## Top 10 by severity (all CRITICAL here; see mismatch.json for the full list)

| host | route | catalog $ | live $ | ratio | exposure $/call | catalog age (days) | age percentile |
|---|---|---:|---:|---:|---:|---:|---:|
| claudelines.com | claudelines.com/api/download | 0.0500 | 1,000,000.00 | 20,000,000.0x | 999,999.95 | 1.36 | 40th |
| citysquatters.com | citysquatters.com/api/blocks/squat | 0.0100 | 10,000.00 | 1,000,000.0x | 9,999.99 | 0.40 | 26th |
| stableupload.dev | stableupload.dev/api/upload | 0.0050 | 2.00 | 400.0x | 2.00 | 0.28 | 22nd |
| gateway.gedx402.com | gateway.gedx402.com/v1/unified/run | 0.0780 | 1.85 | 23.7x | 1.77 | 27.94 | 98th |
| dripstack.xyz | dripstack.xyz/api/v1/stock-picks | 0.1000 | 0.50 | 5.0x | 0.40 | 1.77 | 44th |
| stabletube.dev | stabletube.dev/api/download | 0.1000 | 0.20 | 2.0x | 0.10 | 2.15 | 54th |
| api.melvea.com | api.melvea.com/v1/catalog | 0.0200 | 0.05 | 2.5x | 0.03 | 5.02 | 76th |
| deepseek.x402.press | deepseek.x402.press/v1/chat/completions | 0.0025 | 0.01 | 2.5x | 0.00 | 7.02 | 81st |
| aviation.x402.press | aviation.x402.press/aviation/ask | 0.0500 | 0.05 | 1.1x | 0.00 | 12.91 | 90th |
| weather.x402.press | weather.x402.press/weather/ask | 0.0500 | 0.05 | 1.1x | 0.00 | 7.06 | 81st |

## Host concentration

- Distinct hosts carrying at least one mismatch: **16**
- Top-10 hosts hold **62.5%** of all mismatches
- Hosts with exactly one mismatching route: **16**
- **Verdict: CONCENTRATED — a small number of hosts account for most mismatches.** (measured from the data above, not assumed)

| host | mismatches | overcharges | undercharges | CRITICAL | net exposure $ |
|---|---:|---:|---:|---:|---:|
| stableupload.dev | 1 | 1 | 0 | 1 | 2.00 |
| dripstack.xyz | 1 | 1 | 0 | 0 | 0.40 |
| deepseek.x402.press | 1 | 1 | 0 | 0 | 0.00 |
| entertainment.x402.press | 1 | 1 | 0 | 0 | 0.00 |
| store.agentexchange.work | 1 | 0 | 1 | 0 | -0.03 |
| earth.x402.press | 1 | 1 | 0 | 0 | 0.00 |
| aviation.x402.press | 1 | 1 | 0 | 0 | 0.00 |
| api.babyblueviper.com | 1 | 0 | 1 | 0 | -0.00 |
| space.x402.press | 1 | 1 | 0 | 0 | 0.00 |
| weather.x402.press | 1 | 1 | 0 | 0 | 0.00 |
| marine.x402.press | 1 | 1 | 0 | 0 | 0.00 |
| api.melvea.com | 1 | 1 | 0 | 0 | 0.03 |
| gateway.gedx402.com | 1 | 1 | 0 | 0 | 1.77 |
| citysquatters.com | 1 | 1 | 0 | 1 | 9,999.99 |
| claudelines.com | 1 | 1 | 0 | 1 | 999,999.95 |

## Alternative explanations — what we can and cannot rule out

**We cannot see price-change history upstream (CDP overwrites, does not version) — only catalog age at probe time.** Per-route read on the top offenders:

- `claudelines.com` (https://claudelines.com/api/download): catalog entry was 1.36 days old at probe time (~40th percentile of catalog age) — about as old as a typical catalog entry — staleness alone does not explain this mismatch.
- `citysquatters.com` (https://citysquatters.com/api/blocks/squat): catalog entry was 0.40 days old at probe time (~26th percentile of catalog age) — about as old as a typical catalog entry — staleness alone does not explain this mismatch.
- `stableupload.dev` (https://stableupload.dev/api/upload): catalog entry was 0.28 days old at probe time (~22nd percentile of catalog age) — younger than most of the catalog — a recent price change is plausible, cannot rule out deception either.
- `gateway.gedx402.com` (https://gateway.gedx402.com/v1/unified/run): catalog entry was 27.94 days old at probe time (~98th percentile of catalog age) — older than most of the catalog — the mismatch has persisted through at least one normal refresh window, which argues against 'we just changed the price and haven't republished yet'.
- `dripstack.xyz` (https://dripstack.xyz/api/v1/stock-picks): catalog entry was 1.77 days old at probe time (~44th percentile of catalog age) — about as old as a typical catalog entry — staleness alone does not explain this mismatch.

For every route above we recorded `catalog_last_updated` age at probe time and its percentile against the whole catalog's age distribution. A young catalog age (low percentile) is CONSISTENT with a legitimate recent price change and is reported as such, not asserted as innocent — we have no changelog, so a fresh `lastUpdated` timestamp is equally consistent with a deliberate bait-and-switch that just relisted. Templated routes (`/:param`) probed as a literal path are excluded from the leaderboard entirely reasoning is unreliable there (a probe result sits at whatever literal example was templated, not a representative call). Dynamic/variable-priced routes cannot be distinguished from a static misconfiguration with a single probe; only a second probe run at a different time would show whether the live price moves.
