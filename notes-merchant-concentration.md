# Merchant concentration: 0xe9030014f5dae217d0a152f02a043567b16c1abf

**Author:** Intel dept. **Date:** 2026-07-31. **Method:** free Base RPC (`eth_getLogs`/`eth_call`/
`eth_getBlockByNumber` on `base.gateway.tenderly.co`, `base-rpc.publicnode.com`) + read-only query
against `x402_index.db`. No paid endpoint touched. All figures below are pasted real output, not
inference. Reproducible script: `C:/Users/Micha/Desktop/x402/onchain_merchant_concentration.py`
(`python onchain_merchant_concentration.py [basics|windows|balance]`).

---

## 1. What the address actually is

**BlockRun.AI** (`blockrun.ai`, `blockrun-web-vbsbhh7lea-uc.a.run.app`) — an agent-tool aggregator that
resells other APIs behind x402 micropayments: Exa web search, DeFiLlama, Polymarket, stock/FX prices,
Twilio-style phone numbers, Modal sandbox compute. Confirmed via our own catalog descriptions:
`"Neural and keyword web search..."`, `"Query Polymarket markets..."`, `"Extract full text content
from specific URLs. Priced at $0.002/URL..."`.

**On-chain identity, verified directly:**
- EOA, not a contract (`eth_getCode` → `0x`).
- Sent only **4 transactions ever** as a sender (`eth_getTransactionCount` nonce = 4) — consistent
  with a payout wallet that receives EIP-3009 transfers and rarely acts itself.
- Current USDC balance: **$146,242.98** (`balanceOf` via `eth_call`, live; re-checked, drifts up
  minute to minute as expected).
- **First went from zero to nonzero balance at block 39,961,213**, timestamp
  **2025-12-26 01:16:13 UTC** — found by binary search of `balanceOf` at historical block heights
  (archival state queries confirmed working on the free RPCs used here). Confirmed zero at five
  earlier checkpoints spanning genesis to block 37,500,001. **This merchant is ~217 days old
  (~7.1 months)** as of 2026-07-31 — it did not exist for anything close to the 74 months implied
  by the ecosystem-wide all-time/30-day-rate math in §5.
- **Zero outgoing USDC transfers in the last 50,000 blocks (~27.8h)** — no cash-out in the last day.
  This does **not** establish the address never withdrew earlier in its 217-day life (checking the
  full history would mean ~1,880 chunked `eth_getLogs` calls at the 10,000-block cap — not done this
  cycle), so the current balance should be read as "funds on hand now," not as "cumulative lifetime
  revenue." See §2 for why that distinction matters.
- Its single dominant counterparty across every sampled window is one buyer EOA,
  `0x2b4ee3387008e5ff1a9996fc8b48d2fd61389037` — itself an EOA, nonce 0 (never submitted its own
  tx — a pure EIP-3009 signer, exactly the x402 shape: buyer signs, facilitator submits and pays gas).

## 2. Volume pattern: bursty, not steady — confirmed on 10 windows, not 1

Sampled 500-block (~1,000s) windows of incoming USDC `Transfer` logs to the address, at ten points
across ~72 hours (real pasted output; `python onchain_merchant_concentration.py windows`):

| Window | Logs | Implied rate/day | Implied 30d |
|---|---:|---:|---:|
| Recent (now) | 1,197 | 103,405 | 3,102,161 |
| 6h back | 1,123 | 97,027 | 2,910,816 |
| 9h back | **15,374** | 1,328,314 | 39,849,408 |
| 12h back | **18,972** | 1,639,613 | 49,188,384 |
| 18h back | 1,415 | 122,256 | 3,667,680 |
| 24h back | 1,168 | 100,915 | 3,027,456 |
| 36h back | 1,628 | 140,659 | 4,219,776 |
| 48h back | 1,193 | 103,075 | 3,092,256 |
| 60h back | 3,846 | 332,294 | 9,968,832 |
| 72h back | 1,493 | 129,024 | 3,870,720 |

**The 12h-back outlier was re-run and replicates exactly**: 18,972 logs both times, all
`(txHash, logIndex)` pairs unique (no duplicate fan-out from the RPC), every returned block number
inside the requested range (provider did not silently widen the window). It is a real event, not a
query artifact. **And it is not unique** — the 9h-back and 60h-back windows show the same pattern at
smaller scale (15,374 and 3,846 respectively, both several multiples of the ~1,100–1,600/window
baseline). **Bursts recur; this merchant genuinely alternates between a steady baseline (~100–140k
tx/day) and short intense spikes**, consistent with automated agent-loop calling rather than steady
organic traffic.

**Cross-check against the headline 9,401,793/30d:** summing all ten disjoint samples (10,000s total
elapsed, 47,409 logs): **47,409 / 10,000s × 86,400 × 30 ≈ 12,288,000/30d.** Consistent with the
5-window spot-check done earlier (12,257,000/30d) — the aggregate rate is stable under replication
even though individual windows swing 16x. This is the same order of magnitude as x402scan's
9,401,793 and a genuine independent corroboration of the headline transaction count, not a
contradiction — though n=10 short windows is still a spot-check, not a full remeasurement.

**Per-tx value, live-sampled:** $0.002–$1.48 range, baseline-window averages $0.035–$0.049 vs
$0.0083–$0.0083 in the two large-burst windows — bracketing x402scan's stated $0.0169 ecosystem
average for this merchant, but running noticeably higher in baseline periods. See §4 for why this
matters to the dollar-share number.

**On the balance vs. implied-revenue cross-check:** now that the merchant's start date is known
(§1 — first funded 2025-12-26, ~217 days ago), a naive "current balance ≈ 30 days of revenue" check
does not hold up: $146,243 held over 217 days averages **$674/day (~$20,230/30d)** — far below the
**$158,910/30d** implied by 9,401,793 tx × $0.0169. Two explanations, neither confirmed: (a) this
merchant's volume has ramped up sharply since December and the current rate is much higher than its
own historical average (consistent with the burst pattern above and with §5's ramp-up hypothesis), or
(b) the address has withdrawn funds at some point in its 217-day history that we did not check for
(only the last 27.8h is confirmed withdrawal-free). We **do not** treat the balance as confirming the
30-day revenue figure — that framing was wrong in an earlier draft of this note and is corrected here.

## 3. Is it in our CDP catalog? Yes — and that is itself the story

Cross-referenced `min_amount_pay_to` (read-only, `x402_index.db`) against the address:

- **134 distinct catalogued routes** in the latest snapshot carry this exact payTo address, all under
  `blockrun.ai` / `blockrun-web-vbsbhh7lea-uc.a.run.app`.
- Summed across all 134 routes: **`l30d_total_calls` = 2,715**, **`est_gmv_30d_usd` = $37.79**.

**2,715 catalogued calls vs. 9,401,793 real on-chain transactions.** The catalog captures **0.029%**
of this merchant's real activity — an order of magnitude worse than the already-bad ~3.0%/8.8%
capture rate we measured for the CDP catalog overall. Either:

(a) the *catalogued* routes (search, DeFiLlama proxy, stock prices, phone numbers) really are a
    minor sideline and the bulk of this merchant's 9.4M tx/mo flows through an endpoint / host that
    is not catalogued at all under this payTo address — genuinely invisible to Coinbase's own Bazaar,
    or
(b) the catalog's own `l30d_total_calls` counter (already shown elsewhere in this project to
    under-report, e.g. Backlog reconciliation notes) is simply wrong by ~2–3 orders of magnitude for
    this merchant specifically.

We cannot distinguish (a) from (b) without more data — **honestly flagged as open**, not resolved.
Either way, the ratio holds under both readings: **the catalog's own counters account for roughly
1 in 3,400 of this merchant's real on-chain transactions** — whether because the real traffic runs
through an uncatalogued route (a genuine coverage gap) or because the catalog's own call-counter is
wrong by that factor for this merchant (a measurement-quality gap). Both are bad for "the catalog is
the market"; we are not asserting which one it is.

## 4. Market shape: transactions vs. dollars tell different stories

| Metric | This merchant | Full ecosystem (30d) | Share |
|---|---:|---:|---:|
| Transactions | 9,401,793 | 12,421,896 | **75.7%** |
| Dollars (@ x402scan's stated $0.0169 avg) | ~$158,910 | $711,166 | **22.3%** |
| Unique buyers | 1,137 | (not directly comparable — no ecosystem-wide unique-buyer figure at this granularity) | — |

**The dollar row is vendor-derived, not independently confirmed by us.** x402scan states the
$0.0169 average; our own live-sampled windows (§2) ran higher in baseline periods — $0.035–$0.049 —
and lower in the two large bursts (~$0.0083). At our baseline-sampled ~$0.04 average, this merchant's
implied 30-day revenue would be ~$376,000 — more than half of the *entire* ecosystem's stated
$711,166, which cannot be right if the ecosystem total is itself correct. This tells us the true
average almost certainly sits closer to x402scan's $0.0169 than to our short-window samples (which
are not volume-weighted across the full 30 days and are skewed by whichever burst/baseline mix each
window happened to catch), but **we did not independently verify the $0.0169 figure** — treat the
22.3% dollar-share number as bracketed, not confirmed, by our sampling.

**"The x402 economy" means two different things depending on the unit.** By transaction count, this
one merchant *is* the x402 economy — three in four x402 settlements anywhere, on any facilitator, are
someone calling this one address, likely an automated agent hammering a cheap search/data endpoint in
bursts. By dollar volume (on x402scan's own figures), it is one strong contributor among several —
the other 24.3% of transactions would carry 77.7% of the dollars, implying every other merchant's
average ticket is roughly **11x higher** than this one's. That multiple is only as solid as the
underlying $0.0169 average, which we have not verified ourselves.

This is exactly the same distinction that made the original $62.8k/month catalog headline misleading
(a few outlier high-ticket routes dominating a dollar figure) — here it runs the other direction: one
high-*volume*, low-*ticket* merchant dominates the transaction count while barely registering in
dollars. **Any headline that says "x402 did 12.4M transactions" without naming this concentration is
misleading; any headline that says "x402 moved $711k" without naming it is comparatively honest**,
because dollar concentration here is much milder (22.3% vs. 75.7%).

## 5. The 74-month anomaly — resolved to "impossible as stated," cause still open

**The clean, freely-verified fact:** Base mainnet genesis block (`eth_getBlockByNumber(0)`) timestamp
is **2023-06-15 00:35:47 UTC**. Latest block sampled: **2026-07-31 07:09:09 UTC**. That is
**1,142.3 days = 37.5 months** of chain history, full stop — verified directly, not assumed.

**$52,589,653.80 (all-time) ÷ $711,166 (30-day rate) implies 73.97 ≈ 74 months of history.**

**74 months is essentially exactly 2× the entire lifetime of the Base chain (37.5 months).** Even if
Coinbase's facilitator had processed x402 payments from the literal first block of Base's existence
at its *current* 30-day rate, the all-time total would be at most ~$26.7M ($711,166/30d × 37.5mo),
roughly half of the stated $52.6M. **The all-time figure cannot be "current rate sustained since
Base's genesis" — that scenario is mathematically ruled out by chain age alone, independent of any
x402-specific reasoning.**

(Caveat: the $52.6M/$711,166 figures are *all-facilitator, all-chain* — they are not Coinbase/Base-only.
Solana mainnet (beta launched March 2020) is old enough to predate 74 months, and some facilitators in
our address list settle there. So Base's 37.5-month age bounds only the Coinbase/Base portion of the
total, not the whole figure in principle. In practice this does not rescue the 74-month reading: the
x402 *protocol itself* is known to be far younger than even Base — our own biggest measured merchant
in this very note, responsible for 75.7% of transactions, is only ~7.1 months old (§1) — so a
Solana-predates-Base argument would require the protocol to have meaningful volume on a chain before
the protocol existed, which is not a serious alternative, just a technical gap worth naming.)

Hypotheses, explicitly unproven:
1. **Ramp-up bias.** If x402 volume has grown over time (very plausible — it's a young protocol),
   dividing the all-time total by the *current* (highest-ever) rate systematically overstates
   implied duration. This alone could fully explain a 2x gap without any data error.
2. **The ~2x factor is suspiciously clean** and could indicate literal double-counting somewhere in
   x402scan's all-time aggregation (e.g., both legs of a relayed settlement, or a join that fans out) —
   this section's own §2 found real burstiness (up to 19x rate swings across a single merchant), so
   sampling artifacts in how "30-day rate" itself is computed cannot be ruled out either.
3. **Scope mismatch** — same failure mode already found in Chain dept's work (tx_count possibly
   counting non-x402 traffic touching facilitator addresses): the all-time total may include
   non-x402-settlement transfers that the 30-day/resource-level breakdowns exclude.

**What would settle it (free, not done this cycle):** binary-search each Coinbase facilitator
address's `eth_getTransactionCount` history block-by-block to find the actual first-nonzero-nonce
block, giving a true "facilitator went live" date to compare against the implied 74 months. We
confirmed this is technically possible — archival `eth_getTransactionCount` queries at historical
block heights work on our free RPCs (tested: nonce at a block ~180 days old returned successfully) —
but did not run the full search this cycle. Flagged for Chain dept or a follow-up Intel cycle.

## 6. What we did not do

- Did not check this merchant's full 217-day withdrawal history — only confirmed no outgoing
  transfers in the last ~27.8h. A full check would need ~1,880 chunked `eth_getLogs` calls at the
  free-tier 10,000-block cap; not run this cycle. This is why §2 does not treat the current balance
  as proof of cumulative revenue.
- Did not resolve (a) vs (b) in §3 — would need probing the actual traffic source, which likely
  requires either paid x402scan resource-level lookups (blocked without Michael's sign-off) or
  guessing at undocumented routes (not attempted, would be speculation).
- Did not independently verify x402scan's $0.0169 average price for this merchant, or its $711,166
  ecosystem 30-day dollar total — both are vendor-stated figures we bracket but do not confirm (§4).
- Sampled 10 disjoint on-chain windows for §2 (widened from 5 after review) — enough to show
  burstiness is real and recurring and to corroborate the transaction-count order of magnitude, not
  enough for a tight confidence interval on the exact rate.
- Did not touch any paid endpoint. No money moved.

## 7. Bottom line for the headline writer

- One merchant, BlockRun.AI, is 75.7% of all x402 transactions — cheap, high-frequency, genuinely
  bursty automated calls (confirmed on 10 independent windows), not broad-based adoption. Its dollar
  share (~22%, implying an ~11x lower average ticket than the rest of the ecosystem) rests on
  x402scan's own stated average price, which we bracket but did not independently verify.
- It is in our catalog, but the catalog's own counters capture roughly 1 in 3,400 of its real
  transactions — a sharper version of the "catalog isn't the market" finding, on the single biggest
  account in the whole dataset. We cannot yet say whether that's a coverage gap or a counting bug.
- It is a young merchant — first funded 2025-12-26, ~7.1 months old — not a long-running one.
- The 74-month all-time/30-day-rate implied duration is mathematically impossible for the
  Coinbase/Base portion (Base itself is only 37.5 months old, verified via genesis block timestamp)
  — the all-time $52.6M figure is corrupted by *something* beyond "value units are wrong" (already
  refuted elsewhere); ramp-up bias is the most likely honest explanation, not proven.
