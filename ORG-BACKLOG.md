# 402cap — Org Backlog

**Work top-down.** Skip anything marked BLOCKED. Update status in place; append new items at the
bottom of their section. Read `ORG-LESSONS.md` before dispatching so a known dead end isn't retried.

Status: `open` · `building` · `shipped` · `parked` · `blocked`

---

## P0 — the moat depends on these

| # | Item | Why it matters | Status |
|---|---|---|---|
| 1 | **Daily automated snapshot** | The entire moat is time-series. Every day we don't snapshot is a day of history that can never be recovered — Coinbase overwrites quality metrics every 6h and drops resources after 30 days. This is the single highest-value item on the board and it is pure plumbing. Headless scheduled task, no console. **First attempt fired 0/10 (2026-07-30): no scheduled task, no artifact, no report — nothing was actually built despite claim of completion. Verified via `Get-ScheduledTask` (223 tasks, zero match) and file mtimes (nothing postdates the original setup session).** Re-dispatch to a fresh agent with an explicit brief: name the exact tool (`mcp__scheduled-tasks__create_scheduled_task` or Windows Task Scheduler via the MCP, not a bare cron string), the exact command line (headless, no console per charter), and require a `Get-ScheduledTask` paste as proof before claiming done. | **highest-priority open item — still not started** |
| 2 | **Run `prune.py` after the full sweep completes** | Measured: 67.4% of `raw_json` is byte-identical duplication; 79MB reclaimable now, ~26GB/year at daily cadence. Written and documented, NOT yet run — it takes a whole-db write lock, so it must not run during a fetch/sweep. Verify on a copy first. | open |
| 3 | **Cross-facilitator coverage** | Coinbase indexes only its OWN settlements, so anything settling via x402.org / xpay.sh / payai.network is invisible to it — and it can never fix that, because it is a facilitator. This is the part of the moat Coinbase structurally cannot copy. Enumerate other facilitators' catalogs and merge into our index with a `source` column. | researched — see `notes-cross-facilitator.md`. 4/19 facilitators have live keyless discovery (CDP, PayAI, UVDAO, Thirdweb); measured 808 hosts (86.2%) invisible to CDP across the 3 non-CDP ones. Schema designed, NOT migrated — ingestion code is the next open item. |

## P1 — the product

| # | Item | Why it matters | Status |
|---|---|---|---|
| 4 | **`builder-code` referral tracking** | Backfill APPLIED to production 2026-07-31: schema had drifted (`raw_json` deduped into `raw_blob` by `prune.py`, script fixed to read `catalog_resource_full.raw_json_full`) — re-verified against a copy first, backed up prod (`x402_index.db.bak-2026-07-31-preref`), applied, independently re-verified. **Real counts: `referral_json` set on 8,107 rows, `referral_event` seeded with 2,670 (program='builder-code'), 0 duplicate pairs, `PRAGMA integrity_check`=ok.** Concentration analysis re-run with real queries: top code `bc_gxy6qn5p` still 59.4%/1,587 routes (2 registrable domains), top-2 = 79.1%, identical across all 3 complete snapshots (no real trend yet — same-day fetches). Builder-code presence correlates with a small median traffic bump (2 vs 1 calls) but NOT a mean bump once the single dominant host (`x402.twit.sh`) is stripped. Curated correlation: still 0/122 overlap. Revenue-share: NOT ESTABLISHED (Base frames it as protocol-discretionary). See `notes-builder-code.md` §7-8. | **shipped — see Done** |
| 5 | **Public site — MVP** | The CMC-style front end: searchable listing table, per-resource detail with price history chart, "what changed today" feed. Check `SALVAGE-FROM-CELESTIALS.md` for liftable frontend scaffolding before building from scratch. | **shipped — see Done** |
| 6 | **Read API + MCP server** | Michael's stated endgame: "the api for agent workers to use our api to scan for price changes." MCP is how agents consume tools today. Two endpoints carry the product: *what changed since T* and *history for resource X*. | **shipped — see Done** |
| 7 | **Price-mismatch monitor** | Measured 3.4–7.7% of catalog prices are WRONG vs. live — one off by 400× with a `lastUpdated` an hour old. This is the single most demonstrable proof that measured beats declared. Make it a standing metric with a leaderboard of worst offenders. | open — mismatch data + page shipped as part of #5 (`mismatch.html`, 721 validated); a standing/updating leaderboard beyond the static site page is still open |
| 11 | **Fix `v_builder_codes`/`v_latest_catalog` to filter `is_complete`** | Surfaced by P1#4 rework: neither view filters incomplete snapshots, which would silently corrupt any read API (#6) or referral dashboard built on top. Small fix, must land before #6 touches these views. | **shipped — see Done** |
| 15 | **Second independent method for the on-chain dollar-value figure** | Chain dept's $0.55M–$2.98M extrapolation rests on one method (Transfer-log decoding) over one ~200s window, n=150. Council-flagged gap. Do either: decode `transferWithAuthorization` calldata's value argument directly (distinct from reading the emitted log), or re-run the same scan on a temporally disjoint window and check convergence. Must land before this number is quoted anywhere, including internally as settled. | open — highest-value open item |
| 16 | **Fix index.html headline mismatch count (726) vs mismatch.html's validated count (721)** | Council-flagged self-contradiction: index.html counts raw `price_mismatch=1` rows including 5 templated routes; mismatch.html correctly excludes them per its own stated methodology. Same snapshot, two different numbers, one click apart, on a measured-truth product. Fix: exclude `is_templated` rows from the index.html stat too, or label it "includes templated, see mismatch.html for validated count." | open — small, in `build_site.py` |

## P2 — distribution and authority

| # | Item | Why it matters | Status |
|---|---|---|---|
| 8 | **"The x402 economy is 9× smaller than reported" analysis** | Derived GMV is $62.8k/30d, but the top 4 routes are 82% of it — invoice/checkout endpoints with 1–28 lifetime calls, one a single call priced at $10,000. Real recurring activity is ~$7k/mo across 5,016 routes. Nobody else can show this. It is the launch story that earns authority. **Publishing anything public is Michael's call** — produce it as a draft. | open |
| 9 | **Dead-pool / graveyard dataset** | Coinbase deletes resources after 30 days without settlement. We keep them. "What died" is real market intelligence that literally cannot be bought anywhere else. Needs #1 running to accumulate. | open |
| 10 | **Rank the real earners** | Strip self-payers and outliers, publish an honest top-100 by recurring revenue. Requires a real-payer heuristic — `l30DaysUniquePayers` may count the operator self-registering (UNVERIFIED, see README §10). | open |
| 12 | **Ingest the 3 confirmed non-CDP facilitator catalogs (PayAI, UltravioletaDAO, Thirdweb)** | Coverage is measured (808/937 hosts, 86.2%, invisible to CDP) but no ingestion code exists yet and the `source` column is designed, not migrated. This is what actually captures the cross-facilitator moat rather than just proving it exists. See `notes-cross-facilitator.md` for the schema plan. | open |
| 13 | **x402scan.com discovery API** | Real resource/facilitator data behind a genuine unpaid 402 ($0.01/call) — could add another facilitator's view but paying, even $0.01, needs Michael's sign-off first (hard line: no purchases without him). Parked until he says spend it. | parked — needs Michael |
| 14 | **xpay.sh 1,089-tool catalog** | Real data but MCP-wrapped with zero per-tool URL/host fields — doesn't fit the per-resource schema as-is. Would need a distinct ingestion path (tool-identity keyed, not URL-keyed) if ever pursued. Not started. | open, low priority |

## Blocked on Michael — do not attempt

| # | Item | What it needs | Status |
|---|---|---|---|
| B1 | Buy a domain (`402cap.com` recommended, verified available) | ~$11/yr on his card. Raise as a Paybox request. | blocked |
| B2 | CDP account for mainnet facilitator + Bazaar listing | His signup, his API keys. | blocked |
| B3 | Self-pay once to bootstrap our own Bazaar listing | Real USDC + gas. Paybox request; he approves. | blocked |
| B4 | Publishing anything public under his name | Drafts only until he says go. | blocked |

---

## Done

| Item | Outcome | Status |
|---|---|---|
| Rebuild `x402-endpoint` into a spec-compliant v2 seller | Was unpayable (invented `?x402_receipt=` flow); now emits a real 402. Two security bugs (free SSRF oracle, DNS-rebinding TOCTOU) closed by test. | shipped |
| Catalog fetcher + unpaid prober + churn diffing | 15,524 routes / 1,577 hosts. 96.7% alive, 320ms median. | shipped |
| Protocol research + `IMPLEMENTATION-SPEC.md` | 9 agents, adversarially verified. Read it before any x402 work. | shipped |
| Version control | Both repos under local git. GitHub deferred until deploy; private repo when it happens. | shipped |
| Lift backlog tooling from Celestials | `backlog_index.py` + `backlog_merge.py` repointed at this repo. Selftest 26/26. Gives the org the file-based handoff the charter assumes. | shipped |
| **Chain — verify the dollar figure (Phase 1 #1)** | `notes-chain-values.md` + `onchain_verify_values.py`. 150/150 sampled Coinbase facilitator tx confirmed genuine `transferWithAuthorization` calls (positive control passed first). Extrapolated real settlement value: **$0.55M–$2.98M, not the claimed $28.6M/$52.6M (10–52× too low)**. 8.3/10 ACCEPT — single method/single ~200s window, second method not yet done (→ Backlog #15). Do not quote either figure as final. | shipped, partially verified |
| **Intel — reconcile the three-way contradiction (Phase 1 #5)** | `notes-reconciliation.md`. DB total (373,056/30d) reverified exact. Bridged to on-chain via two disjoint 500-block windows ~12h apart: 4.73M–6.26M facilitator-sent tx/30d, 99.2–99.8% confirmed genuine settlements. **Headline: CDP catalog captures ~6–8% of Coinbase's real settlement volume; >92% uncatalogued.** (c) vs (b) (x402scan resource counts) left honestly NOT ESTABLISHED. 9.2/10 ACCEPT. Flagged an orphaned Chain-dept process still running at audit time — confirmed gone as of this cycle's process check. | shipped |
| **Product — public site MVP (Phase 2/3)** | `build_site.py` → `site/` (134MB, 15,527 static HTML files, no CDN/build tool, 6.2s build, 0 filename collisions). Index (search/sort/filter) + per-resource detail pages + `mismatch.html` leaderboard (top: claudelines.com, 20,000,000×). Honesty features: 3-state "alive", no-decimals-assumed price rendering, $52.6M explicitly excluded from headlines. 8.5/10 ACCEPT — index.html's headline count (726) vs mismatch.html's validated count (721) disagree by the 5 templated rows → Backlog #16. | shipped, minor fix pending |
| **Referral — apply builder-code backfill to production** | Caught a schema-drift bug before it caused a silent zero-row no-op (`raw_json` deduped into `raw_blob` post-prune, script fixed to use `catalog_resource_full`). Tested against a copy, backed up prod, applied, independently re-verified: `referral_json` set on 8,107 rows, `referral_event` seeded 2,670/2,670 no-dupe. Concentration/traffic/curated correlation re-tested with real queries, not asserted. See `notes-builder-code.md` §7-8. | shipped |
| **API/MCP — the read API agents consume (Phase 2/3)** | `api/{db.py,queries.py,main.py,mcp_server.py,requirements.txt,README.md}`. FastAPI + MCP server (`mcp==1.29.0`) over read-only SQLite. Fixed Backlog #11 (`is_complete` filter bug) with a positive-control proof (fake incomplete snapshot correctly excluded). Endpoints verified against live 15,524-route DB headless (`pythonw.exe`, port confirmed closed after). MCP verified only via in-process `list_tools`/`call_tool`, not a real transport — disclosed, not glossed over. 9/10 ACCEPT. | shipped |
