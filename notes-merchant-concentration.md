# Merchant concentration: 0xe9030014f5dae217d0a152f02a043567b16c1abf

**Author:** Intel dept. **Date:** 2026-07-31. **Method:** free Base RPC (`eth_getLogs`/`eth_call`/
`eth_getBlockByNumber` on `base.gateway.tenderly.co`, `base-rpc.publicnode.com`) + read-only query
against `x402_index.db`. No paid endpoint touched. All figures below are pasted real output, not
inference — commands are reproducible from this file.

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
- Current USDC balance: **$146,204.67** (`balanceOf` via `eth_call`, live).
- **Zero outgoing USDC transfers in the last 50,000 blocks (~27.8h)** — it is not cashing out; funds
  sit and accumulate. (27.8h window only; does not prove it never withdraws.)
- Its single dominant counterparty across every sampled window is one buyer EOA,
  `0x2b4ee3387008e5ff1a9996fc8b48d2fd61389037` — itself an EOA, nonce 0 (never submitted its own
  tx — a pure EIP-3009 signer, exactly the x402 shape: buyer signs, facilitator submits and pays gas).

## 2. Volume pattern: bursty, not steady

Sampled 500-block (~1,000s) windows of incoming USDC `Transfer` logs to the address, at five points
across ~48 hours (real pasted output):

| Window | Logs | Unique buyers seen | Implied rate/day | Implied 30d |
|---|---:|---:|---:|---:|
| Recent (now) | 1,197 | 2 | 103,405 | 3,102,161 |
| 6h back | 1,123 | 4 | 97,027 | 2,910,816 |
| 12h back | **18,972** | 2 | 1,639,613 | **49,188,384** |
| 24h back | 1,168 | 2 | 100,915 | 3,027,456 |
| 48h back | 1,193 | 2 | 103,075 | 3,092,256 |

Four of five windows cluster tightly around **~100k tx/day (~3M/30d)**. One window (12h back) spiked
to **~15–19x** that rate. **The activity is genuinely bursty**, not a smooth 300k/day average — this
one merchant alternates between a steady baseline and short intense bursts, most likely automated
agent-loop calling patterns rather than organic human traffic.

**Cross-check against the headline 9,401,793/30d:** summing all five disjoint samples (5,000s total
elapsed, 23,653 logs) and extrapolating: **23,653 / 5,000s × 86,400 × 30 ≈ 12,257,000/30d.** That is
the same order of magnitude as x402scan's 9,401,793 and within ~30% on n=5 short windows dominated by
one outlier — a genuine independent corroboration, not a contradiction, of the headline count. A
proper reconciliation would need many more windows; this is a spot-check, not a full remeasurement.

**Per-tx value, live-sampled:** $0.002–$1.48 range, window averages $0.035–$0.049 (steady windows) vs
$0.0083 (burst window) — bracketing x402scan's stated $0.0169 average. Consistent.

**Balance sanity check:** 9,401,793 × $0.0169 ≈ **$158,910** implied 30-day revenue. Current on-chain
balance is **$146,205** with zero withdrawals in the last day — 92% of implied revenue sitting
unspent on-chain. This is a strong, cheap, independent corroboration of the transaction-count ×
average-price figure for this specific merchant (not a claim about the whole ecosystem total).

**NOT ESTABLISHED:** exact start date of this merchant's activity (would need a binary search over
historical blocks for first nonzero incoming-transfer block — feasible free but not done this cycle;
see §4 for a related, cheaper binary search that WAS done).

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
Either way, the headline holds: **the single largest x402 consumer measured is, at minimum, 99.97%
invisible to Coinbase's own catalog of itself.**

## 4. Market shape: transactions vs. dollars tell different stories

| Metric | This merchant | Full ecosystem (30d) | Share |
|---|---:|---:|---:|
| Transactions | 9,401,793 | 12,421,896 | **75.7%** |
| Dollars (@ $0.0169 avg) | ~$158,910 | $711,166 | **22.3%** |
| Unique buyers | 1,137 | (not directly comparable — no ecosystem-wide unique-buyer figure at this granularity) | — |

**"The x402 economy" means two different things depending on the unit.** By transaction count, this
one merchant *is* the x402 economy — three in four x402 settlements anywhere, on any facilitator, are
someone calling this one address, likely an automated agent hammering a cheap search/data endpoint in
bursts. By dollar volume, it is one strong contributor among several — the other 24.3% of transactions
carry 77.7% of the dollars, meaning every other merchant's average ticket is roughly **11x higher**
than this one's ($0.0169 vs. an implied ~$0.19 average for the rest of the ecosystem).

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

- Did not determine this merchant's actual start date on-chain (§2, §5 — feasible, not run).
- Did not resolve (a) vs (b) in §3 — would need probing the actual traffic source, which likely
  requires either paid x402scan resource-level lookups (blocked without Michael's sign-off) or
  guessing at undocumented routes (not attempted, would be speculation).
- Did not sample more than 5 disjoint on-chain windows for §2 — enough to show burstiness and
  order-of-magnitude corroboration, not enough for a tight confidence interval.
- Did not touch any paid endpoint. No money moved.

## 7. Bottom line for the headline writer

- One merchant, BlockRun.AI, is 75.7% of all x402 transactions but only ~22% of the dollars — cheap,
  high-frequency, bursty automated calls, not broad-based adoption.
- It is in our catalog, but the catalog sees 0.03% of its real volume — a sharper version of the
  "catalog isn't the market" finding, on the single biggest account in the whole dataset.
- The 74-month all-time/30-day-rate implied duration is mathematically impossible (Base itself is
  only 37.5 months old) — the all-time $52.6M figure is corrupted by *something* beyond "value units
  are wrong" (already refuted); ramp-up bias is the most likely honest explanation, not proven.
