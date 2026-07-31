# 402cap — Org Backlog

**Work top-down.** Skip anything marked BLOCKED. Update status in place; append new items at the
bottom of their section. Read `ORG-LESSONS.md` before dispatching so a known dead end isn't retried.

Status: `open` · `building` · `shipped` · `parked` · `blocked`

---

## P0 — the moat depends on these

| # | Item | Why it matters | Status |
|---|---|---|---|
| 1 | **Daily automated snapshot** | The entire moat is time-series. Every day we don't snapshot is a day of history that can never be recovered — Coinbase overwrites quality metrics every 6h and drops resources after 30 days. This is the single highest-value item on the board and it is pure plumbing. Headless scheduled task, no console. | open |
| 2 | **Run `prune.py` after the full sweep completes** | Measured: 67.4% of `raw_json` is byte-identical duplication; 79MB reclaimable now, ~26GB/year at daily cadence. Written and documented, NOT yet run — it takes a whole-db write lock, so it must not run during a fetch/sweep. Verify on a copy first. | open |
| 3 | **Cross-facilitator coverage** | Coinbase indexes only its OWN settlements, so anything settling via x402.org / xpay.sh / payai.network is invisible to it — and it can never fix that, because it is a facilitator. This is the part of the moat Coinbase structurally cannot copy. Enumerate other facilitators' catalogs and merge into our index with a `source` column. | open |

## P1 — the product

| # | Item | Why it matters | Status |
|---|---|---|---|
| 4 | **`builder-code` referral tracking** | 2,670 routes (17.2%) already carry `extensions['builder-code'].info.a` — a live attribution rail nobody is tracking. Michael predicted referral systems would arrive; they already shipped. Capture it as time-series now: who uses it, how it spreads, whose codes appear where. This is the monetization hook. | open |
| 5 | **Public site — MVP** | The CMC-style front end: searchable listing table, per-resource detail with price history chart, "what changed today" feed. Check `SALVAGE-FROM-CELESTIALS.md` for liftable frontend scaffolding before building from scratch. | open |
| 6 | **Read API + MCP server** | Michael's stated endgame: "the api for agent workers to use our api to scan for price changes." MCP is how agents consume tools today. Two endpoints carry the product: *what changed since T* and *history for resource X*. | open |
| 7 | **Price-mismatch monitor** | Measured 3.4–7.7% of catalog prices are WRONG vs. live — one off by 400× with a `lastUpdated` an hour old. This is the single most demonstrable proof that measured beats declared. Make it a standing metric with a leaderboard of worst offenders. | open |

## P2 — distribution and authority

| # | Item | Why it matters | Status |
|---|---|---|---|
| 8 | **"The x402 economy is 9× smaller than reported" analysis** | Derived GMV is $62.8k/30d, but the top 4 routes are 82% of it — invoice/checkout endpoints with 1–28 lifetime calls, one a single call priced at $10,000. Real recurring activity is ~$7k/mo across 5,016 routes. Nobody else can show this. It is the launch story that earns authority. **Publishing anything public is Michael's call** — produce it as a draft. | open |
| 9 | **Dead-pool / graveyard dataset** | Coinbase deletes resources after 30 days without settlement. We keep them. "What died" is real market intelligence that literally cannot be bought anywhere else. Needs #1 running to accumulate. | open |
| 10 | **Rank the real earners** | Strip self-payers and outliers, publish an honest top-100 by recurring revenue. Requires a real-payer heuristic — `l30DaysUniquePayers` may count the operator self-registering (UNVERIFIED, see README §10). | open |

## Blocked on Michael — do not attempt

| # | Item | What it needs |
|---|---|---|
| B1 | Buy a domain (`402cap.com` recommended, verified available) | ~$11/yr on his card. Raise as a Paybox request. |
| B2 | CDP account for mainnet facilitator + Bazaar listing | His signup, his API keys. |
| B3 | Self-pay once to bootstrap our own Bazaar listing | Real USDC + gas. Paybox request; he approves. |
| B4 | Publishing anything public under his name | Drafts only until he says go. |

---

## Done

| Item | Outcome |
|---|---|
| Rebuild `x402-endpoint` into a spec-compliant v2 seller | Shipped, verified. Was unpayable (invented `?x402_receipt=` flow); now emits a real 402. Two security bugs (free SSRF oracle, DNS-rebinding TOCTOU) closed by test. |
| Catalog fetcher + unpaid prober + churn diffing | Shipped. 15,524 routes / 1,577 hosts. 96.7% alive, 320ms median. |
| Protocol research + `IMPLEMENTATION-SPEC.md` | Shipped. 9 agents, adversarially verified. Read it before any x402 work. |
| Version control | Both repos under local git. GitHub deferred until deploy; private repo when it happens. |
