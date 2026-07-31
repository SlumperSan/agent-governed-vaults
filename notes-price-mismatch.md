# Price-mismatch monitor — catalog claim vs measured 402 reality

Catalog snapshot 6 (fetched 2026-07-31T03:07:00.197238+00:00), probe run 6 (started 2026-07-31T03:13:58.245272+00:00).

- Comparable routes (both prices known): **14,988**
- Mismatches: **721** (4.8% of comparable)
  - Overcharges (dangerous direction — live > catalog): **496**
  - Undercharges (live < catalog): **225**
  - CRITICAL severity: **13**

Severity tiers: CRITICAL = overcharge where live price > $100, or ratio >= 100x, or catalog claimed the route free. HIGH = any other overcharge. LOW = undercharge (never dangerous to a paying agent, so never ranked above an overcharge). Ranked within a tier by absolute dollar exposure, not by ratio — a modest multiplier on an expensive route can cost more per call than an extreme multiplier on a cheap one.

## Top 10 by severity (all CRITICAL here; see mismatch.json for the full list)

| host | route | catalog $ | live $ | ratio | exposure $/call | catalog age (days) | age percentile |
|---|---|---:|---:|---:|---:|---:|---:|
| claudelines.com | claudelines.com/api/download | 0.0500 | 1,000,000.00 | 20,000,000.0x | 999,999.95 | 1.19 | 11th |
| citysquatters.com | citysquatters.com/api/blocks/squat | 0.0100 | 10,000.00 | 1,000,000.0x | 9,999.99 | 0.23 | 3rd |
| api.govparse.io | api.govparse.io/v1/feeds/carrier-analytics | 0.0500 | 25.00 | 500.0x | 24.95 | 7.25 | 39th |
| api.govparse.io | api.govparse.io/v1/feeds/distress-signals | 0.1000 | 25.00 | 250.0x | 24.90 | 7.25 | 39th |
| stablepeopledata.dev | stablepeopledata.dev/api/pdl/company/search | 0.1000 | 10.00 | 100.0x | 9.90 | 26.21 | 89th |
| stable-people-data-git-shafu-pdl-api-settl-95fdf9-merit-systems.vercel.app | stable-people-data-git-shafu-pdl-api-settl-95fdf9-merit-systems.vercel.app/api/pdl/company/search | 0.1000 | 10.00 | 100.0x | 9.90 | 22.31 | 77th |
| stable-people-data-git-shafu-merchant-heal-bd8263-merit-systems.vercel.app | stable-people-data-git-shafu-merchant-heal-bd8263-merit-systems.vercel.app/api/pdl/company/search | 0.1000 | 10.00 | 100.0x | 9.90 | 28.30 | 92nd |
| stableupload.dev | stableupload.dev/api/upload | 0.0050 | 2.00 | 400.0x | 2.00 | 0.11 | 1st |
| stableupload.dev | stableupload.dev/api/site | 0.0050 | 2.00 | 400.0x | 2.00 | 4.38 | 28th |
| stable-upload-git-mason-1140-merit-systems.vercel.app | stable-upload-git-mason-1140-merit-systems.vercel.app/api/upload | 0.0050 | 2.00 | 400.0x | 2.00 | 24.29 | 87th |

## Host concentration

- Distinct hosts carrying at least one mismatch: **194**
- Top-10 hosts hold **62.1%** of all mismatches
- Hosts with exactly one mismatching route: **149**
- **Verdict: CONCENTRATED — a small number of hosts account for most mismatches.** (measured from the data above, not assumed)

| host | mismatches | overcharges | undercharges | CRITICAL | net exposure $ |
|---|---:|---:|---:|---:|---:|
| blockrun.ai | 120 | 64 | 56 | 0 | -0.00 |
| x402-services-production.up.railway.app | 96 | 85 | 11 | 0 | 1.05 |
| eltociear-tokenguard.hf.space | 95 | 95 | 0 | 0 | 1.28 |
| gateway.apiosk.com | 35 | 35 | 0 | 0 | 1.12 |
| blockrun-web-vbsbhh7lea-uc.a.run.app | 27 | 6 | 21 | 0 | -0.02 |
| x402-agent-store.rileycraig14.workers.dev | 18 | 18 | 0 | 0 | 0.19 |
| vibesprings.net | 16 | 16 | 0 | 0 | 1.96 |
| api.x-402.online | 16 | 0 | 16 | 0 | -1.12 |
| api.govparse.io | 14 | 14 | 0 | 2 | 64.57 |
| x402.agentutility.ai | 11 | 1 | 10 | 0 | -0.06 |
| store.agentexchange.work | 10 | 8 | 2 | 0 | 0.12 |
| api.invoket.com | 8 | 0 | 8 | 0 | -0.04 |
| toolsmith-api.dassad10.workers.dev | 8 | 0 | 8 | 0 | -0.10 |
| toolcall.click | 8 | 0 | 8 | 0 | -0.10 |
| eltociear-skill-audit.hf.space | 6 | 0 | 6 | 0 | -0.06 |

## Alternative explanations — what we can and cannot rule out

**We cannot see price-change history upstream (CDP overwrites, does not version) — only catalog age at probe time.** Per-route read on the top offenders:

- `claudelines.com` (https://claudelines.com/api/download): catalog entry was 1.19 days old at probe time (~11th percentile of catalog age) — younger than most of the catalog — a recent price change is plausible, cannot rule out deception either.
- `citysquatters.com` (https://citysquatters.com/api/blocks/squat): catalog entry was 0.23 days old at probe time (~3rd percentile of catalog age) — younger than most of the catalog — a recent price change is plausible, cannot rule out deception either.
- `api.govparse.io` (https://api.govparse.io/v1/feeds/carrier-analytics): catalog entry was 7.25 days old at probe time (~39th percentile of catalog age) — about as old as a typical catalog entry — staleness alone does not explain this mismatch.
- `api.govparse.io` (https://api.govparse.io/v1/feeds/distress-signals): catalog entry was 7.25 days old at probe time (~39th percentile of catalog age) — about as old as a typical catalog entry — staleness alone does not explain this mismatch.
- `stablepeopledata.dev` (https://stablepeopledata.dev/api/pdl/company/search): catalog entry was 26.21 days old at probe time (~89th percentile of catalog age) — older than most of the catalog — the mismatch has persisted through at least one normal refresh window, which argues against 'we just changed the price and haven't republished yet'.

For every route above we recorded `catalog_last_updated` age at probe time and its percentile against the whole catalog's age distribution. A young catalog age (low percentile) is CONSISTENT with a legitimate recent price change and is reported as such, not asserted as innocent — we have no changelog, so a fresh `lastUpdated` timestamp is equally consistent with a deliberate bait-and-switch that just relisted. Templated routes (`/:param`) probed as a literal path are excluded from the leaderboard entirely reasoning is unreliable there (a probe result sits at whatever literal example was templated, not a representative call). Dynamic/variable-priced routes cannot be distinguished from a static misconfiguration with a single probe; only a second probe run at a different time would show whether the live price moves.
