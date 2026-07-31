# 402cap — Company Strategy

**Authored 2026-07-31, after the on-chain correction that changed the entire thesis.**
Read with `ORG-CHARTER.md` (how the org operates) and `ORG-BACKLOG.md` (the live queue).

---

## 0. The correction that this strategy rests on

On 2026-07-30 I told Michael the x402 economy was **~$62.5k/month** and advised against building it
as an income line. That figure came solely from Coinbase's Bazaar catalog.

On 2026-07-31, measured directly on Base: Coinbase's 40 facilitator addresses have relayed
**106,602,243 settlements** — matching x402scan's independent claim to **0.02%**. All 40 active.

**The catalog was never the market.** It counts calls to *catalogued routes* — a small subset of what
Coinbase's own facilitator settles. The real activity is two-to-three orders of magnitude larger and
sits **on-chain, where anyone can measure it and almost nobody is.**

That is the whole opportunity, and it is why this document exists.

**Still unverified, and it must not be quoted as fact:** the $52.6M dollar figure. Nonce proves
transaction *count*, not value. Verifying it is Phase 1's first job.

---

## 0.1 Phase 1 execution cycle result (2026-07-31) — the dollar figure

**REFUTED, not confirmed — and our own replacement number is not yet fully verified either.**

Decoded real USDC settlement values from 150 sampled Coinbase-facilitator transactions (single
~200-second window, positive-control passed first). Extrapolated across the confirmed 106,602,243
lifetime transactions: **~$0.55M–$2.98M**, against the claimed **$28.6M / $52.6M — 10 to 52× too low.**

This is a genuine result, not a guess, but it rests on **one method over one time window** (n=150,
~200 seconds). A cheap second method (decode the value from `transferWithAuthorization` calldata
directly, or re-run on a temporally disjoint window) was not done this cycle — see Backlog #15.
**Do not quote $28.6M, $52.6M, $0.55M, or $2.98M as final anywhere public.** What IS solid: the
$28.6M/$52.6M figures are wrong by an order of magnitude at minimum; the true figure is much smaller.

Separately, Intel confirmed (independent angle): the CDP catalog's self-reported 373,056 calls/30d
captures only **~6–8% of Coinbase's own real settlement volume** — over 92% of what its own
facilitator settles happens outside anything it catalogues. This is the strongest, best-verified
finding of the cycle (two disjoint 500-block windows ~12h apart, 99.2–99.8% confirmed as genuine
`transferWithAuthorization` calls, not assumed).

---

## 0.2 Phase 1 execution cycle 3 result (2026-07-31) — the dollar figure now has a second method

**The single most important edit in this document.** Chain department ran a genuine second,
independent method against the Backlog #15 gap (`notes-chain-values-method2.md`,
`onchain_verify_values2.py`): a disjoint 100-block window, 12 hours before method 1's, full-population
decode (n=573, not a subsample), cross-checked calldata-vs-log (150/150 exact match — validates the
decoder, not the magnitude, so this leg alone does not fully satisfy "independent second method" on
its own). Median settlement value in the new window: **$0.017149** vs. method 1's $0.00515 — explained
by a shift in mixture share between the mega-merchant and the tail, not a pricing change.

**Strongest cross-corroboration of the cycle:** the single mega-merchant identified by Intel
(`0xe9030014f5dae217d0a152f02a043567b16c1abf`, 75.7% of x402scan's stated 30-day transaction count) was
independently measured at **$0.0157–$0.0182 per call** across both our on-chain windows — matching
x402scan's own stated **$0.0169/call** for that merchant to within ~10–20%. Three convergent readings
(two independent on-chain windows + the vendor's own number) on the number that drives most of the
market. This is now our best-verified dollar-level fact.

**Ecosystem-wide 30-day figures, now adopted as the working baseline (x402scan, paid 2026-07-31, all
facilitators):** **12,421,896 transactions / $711,166** over 30 days. The CDP catalog's own 30-day sweep
(373,056 calls / $62,801 derived GMV) against this baseline gives **CDP capturing 3.0% of real
transactions and 8.8% of real dollar volume** — two independent methods (on-chain positive control
matching x402scan's lifetime count to 0.02%; and this matched 30-day vendor-timeframe comparison)
converge on the catalog seeing roughly a twelfth to a thirtieth of the real market. This is the
headline "catalog isn't the market" number going forward — replaces the looser ~6–8% Coinbase-only
figure above as the primary cited coverage stat (the two are not contradictory: different
denominators, all-facilitator vs. Coinbase-only — but this one is fresher and matched-window).

**Honest gaps still open, do not round these away:** the non-mega-merchant tail measured roughly 6×
below what x402scan's own aggregate implies for it if the mega-merchant's share is held fixed — flagged,
unresolved, not folded into any headline. Extrapolating the on-chain per-tx figures across
Intel's bridged 30-day Coinbase transaction-count range gives **$132,393–$394,355 on the mean basis
(valid, quotable)**. The median basis of the same table (**$24,360–$32,239**, sometimes rounded to
"$24K") is **INVALID — median × count discards the tail mass of a right-skewed distribution and does
not recover total volume; it must never be cited, rounded or not.** Both are still nowhere near the
refuted $28.6M/$52.6M. (Corrected 2026-07-31, sprint 6 recording: this section previously still
carried the flat "$24K–$394K" range with the invalid low end unflagged, contradicting the correction
already made in `notes-chain-values-method2.md` the same cycle — see `ORG-LESSONS.md`.)

**Do not quote $28.6M, $52.6M, $0.55M, $2.98M, $24K, or "$24K–$394K" as a single settled number
anywhere public.** What's solid: two independent methods now agree the dollar figure is an order of
magnitude (or more) below the original claim, the CDP catalog captures roughly 3–9% of the real
market by transaction/dollar volume respectively, and the only quotable 30-day Coinbase-specific
mean-basis range is $132,393–$394,355.

---

## 1. What the company is

**402cap — the measurement layer for the agent payment economy.**

Not a directory. Not a catalog. A **measurement company**: we establish what is actually true about
machine-to-machine payments, on-chain, independent of any platform's self-reporting.

**Positioning:** CoinMarketCap was not the first list of coins. It won because it aggregated across
venues that each showed only their own book, and because it **kept history**. Same shape here.

### The three structural moats

1. **Coinbase can never be neutral.** It is a facilitator. It will not index competitors' settlement
   volume, ever. A cross-facilitator index is permanently outside what it can offer.
2. **Coinbase deliberately discards history.** Its quality metrics recompute every 6 hours and
   overwrite; resources are deleted after 30 days without settlement. It *cannot* answer "what
   changed" or "what died." We can, and every day of accumulation widens that gap irreversibly.
3. **On-chain truth needs nobody's permission.** We hold 20 facilitators' settlement addresses. Base
   RPC is free and keyless. No API key, no account, no terms of service, nothing revocable. Nobody
   can cut off our data supply.

### What we sell, eventually

- **Data API + MCP server** — Michael's stated endgame: *"the api for agent workers to use our api to
  scan for price changes."* Agents are the customer, and they pay per call via x402 itself.
- **Safety signal** — the price-mismatch feed. 721 mismatches measured; an agent auto-paying off
  catalog price can be drained 100–500×. This is the wedge product.
- **Historical/analytical access** — the compounding asset nobody else will have.

---

## 2. Departments

Eight standing departments. Staff only those with queued work; a manager owns exactly one department
and no two managers touch the same files.

| # | Department | Owns | Success measure |
|---|---|---|---|
| 1 | **Chain** | On-chain measurement: facilitator settlements, decoded values, buyer/seller graphs. The ground truth. | Can we state real settlement volume/value, verified, without any vendor? |
| 2 | **Data** | Catalog ingestion, probing, schema, storage, snapshot cadence, DB health | Unbroken daily history; zero gaps |
| 3 | **Intel** | Analysis: mismatch, churn, concentration, rankings, dead pool | Findings nobody else can produce |
| 4 | **Product** | Public site — search, detail pages, charts, "what changed today" | A stranger understands the value in 10 seconds |
| 5 | **API/MCP** | The read API and MCP server agents consume | An agent can answer "did this price change?" in one call |
| 6 | **Ecosystem** | Cross-facilitator coverage, protocol tracking, competitor watch | Every facilitator indexed, not just Coinbase's |
| 7 | **Growth** | Distribution, launch content, authority (drafts only — publishing is Michael's) | Cited by someone who isn't us |
| 8 | **Infra** | Scheduling, deploys, logging, backups, version control | Nothing lost; nothing manual |

**Not a department: Finance.** Michael owns every account, every dollar, every public commitment.
The org raises Paybox requests; he approves. That never changes.

---

## 3. PHASE 1 — IDEATION *(now → the numbers are trustworthy)*

**Goal: know what is true.** Everything downstream is worthless if the foundation is a vendor's
unverified claim. We already made that mistake once and nearly built a strategy on it.

| Owner | Work | Done when | Status (2026-07-31) |
|---|---|---|---|
| Chain | **Verify the dollar figure.** Decode real USDC transfer values from facilitator-relayed transactions. Is it $52.6M, or is the count real but the value inflated? | A defensible number with a stated method | **DONE — second method delivered (Backlog #15, closed 2026-07-31).** $28.6M/$52.6M refuted (10–52× too high). Two independent on-chain windows now agree on order of magnitude; mega-merchant per-call price ($0.0157–$0.0182) corroborated 3 ways against x402scan's own $0.0169. Ecosystem-wide dollar figure adopted: $711,166/30d, with CDP catalog at 8.8% of it. See §0.2. Still open: non-mega tail's true rate, and 3 of 6 extrapolation-table rows used an invalid median×count basis — do not cite those three. |
| Chain | Establish what a facilitator transaction actually *is* — are all 106.6M x402 settlements, or does the nonce include other operations? | The "facilitator tx vs x402 payment" gap is closed or honestly bounded | **DONE.** 100% of 150 Chain-sampled tx + 99.2–99.8% of Intel's two 500-block samples carry the `transferWithAuthorization` (EIP-3009) selector — the nonce count is genuine x402 settlement activity, not noise. |
| Chain | Extend to Solana and Polygon (untested; Base-only so far) | Multi-chain totals | still open |
| Ecosystem | Page 3+ of the facilitator list (`has_next_page` was still true at 20) | Complete facilitator census | still open |
| Intel | Reconcile the three-way contradiction in writing: catalog 373k/30d vs facilitator 106.6M vs x402scan's own resource counts (3,540 max) | One document that explains all three numbers | **DONE.** `notes-reconciliation.md`. Catalog captures ~6–8% of real settlement volume; (c) vs (b) left honestly NOT ESTABLISHED (no data bridges them). |
| Data | Daily snapshot proven running unattended | Three consecutive clean automated runs | **Registered, NOT yet proven completing** — corrected twice in one sprint (2026-07-31): first pass wrongly called this "still open/blocked" (stale — task was already registered and enabled); second pass then wrongly called it "fired for real" on `lastRunAt` alone. Checked against the actual output: `SELECT MAX(id) FROM catalog_snapshot` = 6, fetched 03:07 UTC, **no snapshot 7 exists** despite `lastRunAt` claiming an 08:08 UTC (03:08 local) fire, and no log in `logs/` postdates 03:01 local. `lastRunAt` is a dispatch record, not a completion record. This is now Sprint 5's top item — see Backlog #1. |

**Exit criteria:** we can state the size and shape of the x402 economy with a method we would defend
publicly, and we know precisely which parts remain unknown.

**Kill condition:** if the 106.6M turns out to be non-payment activity and real settlement volume is
genuinely tiny, say so loudly and revisit whether this is worth building. Cutting losses fast is the
instruction.

---

## 4. PHASE 2 — PLANNING *(the numbers are known → before public launch)*

**Goal: turn measurement into a product with a defensible shape.**

| Owner | Work | Why |
|---|---|---|
| Product | Site architecture and information design. Crawlable multi-page (NOT the single-file pattern salvaged from Celestials — wrong shape for 15,500 indexed routes). | SEO is distribution for a data product |
| API/MCP | Design the two endpoints that carry the product: *what changed since T*, and *history for resource X*. Decide the pricing model — plausibly x402 itself, which makes us a dogfooding proof. | This is the actual business |
| Intel | Productise the price-mismatch feed into a live safety signal with severity tiers | **DONE 2026-07-31** — severity-tiered (CRITICAL/HIGH/LOW) `/mismatches` API + MCP filter, wired into the daily cron as step 6b so it regenerates automatically (see Backlog #7). |
| Data | Schema migration for multi-source (`source` column) so non-CDP catalogs coexist without breaking existing queries | **DONE 2026-07-31** — additive `source` column on both catalog tables, `v_latest_catalog` genuinely fixed at schema level (see Backlog #17). `change_event`/`resource_dim` NOT yet partitioned — new Backlog #18, blocks Ecosystem's #12 ingestion. |
| Ecosystem | Ingestion for the confirmed non-CDP catalogs (PayAI, UltravioletaDAO, Thirdweb) | 808 hosts (86.2%) are invisible to CDP |
| Growth | Draft the launch analysis. Best candidate: *"Coinbase's catalog shows 0.3% of the payments its own facilitator settles"* — verified, surprising, and nobody else can write it. | Authority before traffic |
| Infra | Deploy target, domain, private repo | Michael's call on spend (§6) |

**Exit criteria:** a build plan where every component has a named owner, a verified data source, and a
reason to exist. No public commitment yet.

---

## 5. PHASE 3 — EXECUTION *(build, ship, iterate)*

**Goal: a live product agents actually call.**

| Owner | Work |
|---|---|
| Product | Ship the public site. Search, detail pages, price history charts, daily-change feed. |
| API/MCP | Ship the read API and MCP server. Register in the Bazaar so agents discover us — which requires our own first settled payment (Michael, §6). |
| Chain | Continuous on-chain indexing as a live feed, not a one-off study |
| Intel | Standing reports: mismatch leaderboard, dead pool, real-earner rankings, churn |
| Growth | Publish (Michael approves every public word). Seed with agent-builder communities. |
| Data | Cadence hardening: alerting on failed snapshots, retention policy, off-machine backup |

**Success measures, in order of honesty:**
1. Our numbers get cited by someone who isn't us.
2. An agent calls our API without us asking it to.
3. First inbound payment.

**The compounding bet:** every day the daily snapshot runs, our history lengthens and Coinbase's
30-day deletion window keeps discarding. In twelve months we hold a year nobody can reconstruct.
That asset cannot be bought or rushed — only accumulated, starting now.

---

## 6. What only Michael can decide

Batched deliberately. Nothing below is blocked on engineering.

| # | Decision | Cost | When needed |
|---|---|---|---|
| 1 | ~~Domain~~ — **DEFERRED by Michael 2026-07-31**: *"No hosting or domain as of now. Until the product is semi ready, we'll explore those options."* `402cap.com` was verified available; re-check before buying. | $0 for now | Deferred |
| 2 | **CDP account** — mainnet facilitator + Bazaar listing | Signup + ~$0.001/tx after 1k free | Phase 3 |
| 3 | **Bootstrap payment** — Bazaar only catalogues a service after its first settled payment | Cents | Phase 3 |
| 4 | **Publishing** — every public word under his name | — | Phase 2 onward |
| 5 | ~~Hosting~~ — **DEFERRED 2026-07-31**, same instruction. Build and run locally until the product is semi-ready. The site is deliberately static-generated so hosting stays trivial and cheap whenever we do move. | $0 for now | Deferred |
| 6 | Further paid x402 research calls | $0.01 each, Paybox-approved | Ongoing |

**Standing:** the org never moves money, creates accounts, signs, or publishes. It raises Paybox
requests and drafts. Michael fires.

---

## 7. The honest risk register

- **The dollar figure may not survive verification.** Transaction count is confirmed; value is not.
  If the average settlement is a fraction of a cent, the economy is large in volume and small in
  revenue — which changes what is worth building on top of it.
- **Coinbase could add history and charts at any time.** Our defence is neutrality and
  cross-facilitator coverage, which they structurally cannot match. Lean there, not on prettier
  listings.
- **We are one measurement error from confident nonsense.** This document exists because two separate
  confident conclusions were wrong within 24 hours — first the catalog-derived market size, then the
  "zero on-chain activity" verdict. **Every headline number gets an independent second method before
  it leaves this machine.**
- **Nobody may pay for this.** Measurement is valuable and hard to monetise. The API-for-agents route
  is the plausible one; a public dashboard alone is authority, not revenue.
- **Session and token limits are a real constraint.** Managers and workers run on haiku; briefs must
  be explicit rather than relying on inference.
