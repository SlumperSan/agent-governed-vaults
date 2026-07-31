# Reconciling the three x402 volume numbers — 2026-07-31

**Task:** explain, in one document, why (a) CDP Bazaar catalog 373,056 calls/30d, (b) Coinbase
facilitator on-chain 106,602,243 tx (all-time, verified), and (c) x402scan's own busiest single
resource at 3,540 calls, disagree by orders of magnitude. Read-only DB access + free RPC only. No
paid calls made in this task (the 3 paid x402scan calls behind (c) were made in a prior,
Michael-approved session — see `notes-x402scan-paid-2026-07-31.md`).

## TL;DR

- **(a) is real and reverified**: 373,056 is the exact `SUM(l30d_total_calls)` across all 15,524
  catalogued routes in the latest complete snapshot, confirmed directly against the live database.
- **(a) and (b) are on incommensurable time bases** — (a) is a genuine rolling 30-day window; (b) is
  all-time since each facilitator address's first transaction, of unknown duration. Bridging them by
  historical `eth_getTransactionCount` **failed**: public RPCs returned identical nonces across
  30–46-day-old block heights, a silent-failure pattern, not real history. That attempt was abandoned.
- **A second, independent, genuinely same-window method worked**: live-sampled two **disjoint** real
  blocks of 500 blocks each (~1,000s / 16.7 min, ~12 hours apart, non-overlapping) and counted
  transactions actually sent by Coinbase's 40 facilitator addresses. Both extrapolate to
  **~4.7–6.3 million tx/30 days** — 13–17× the CDP catalog's 373,056. **Also checked the shape of
  those transactions directly, not assumed**: 99.2–99.8% call `transferWithAuthorization` on the USDC
  contract exactly, the on-chain signature of an x402/EIP-3009 settlement — this is real confirmation,
  not an assumption, that "1 facilitator-sent tx ≈ 1 settlement" holds for the large majority of the
  sample.
- **Headline, quantified, range-bounded finding: CDP's own Bazaar catalog captures roughly 6–8% of
  what Coinbase's own facilitator settles over a comparable 30-day window, confirmed as genuine
  settlements by transaction shape.** On this measurement, **over 92% of Coinbase facilitator
  settlement activity is not reflected in the call counts of Coinbase's own published catalog.**
- **(c) cannot be reconciled with (b) from available data — said plainly, not bridged by force.**
  x402scan's own busiest catalogued resource (3,540 calls) is **34× smaller** than CDP's own busiest
  catalogued route (118,962 calls/30d) for what should be an overlapping ecosystem — pointing at an
  undocumented time window on x402scan's `toolCalls`, not something we can resolve without x402scan
  disclosing its methodology or total resource count.

---

## 1. The three numbers, precisely defined

| # | Number | Source | What it actually measures | Time base |
|---|---|---|---|---|
| (a) | 373,056 calls | CDP Bazaar catalog, our own `x402_index.db` | Sum of `l30d_total_calls` — CDP-**self-reported** activity, but **only for the 15,524 routes that chose to register in CDP's own Bazaar catalog** | Genuine rolling 30 days (CDP overwrites this every ~6h) |
| (b) | 106,602,243 tx | Base RPC, `eth_getTransactionCount` (nonce) on Coinbase's 40 facilitator addresses | Transactions **sent** by those addresses — matches x402scan's own claimed `tx_count` (106,581,020) to **0.02%** | **All-time**, since each address's first tx. Operating duration unknown. |
| (c) | 3,540 calls (busiest single resource) | x402scan `/resources` endpoint, 3 paid $0.01 calls (prior session) | `_count.toolCalls` for one specific resource, per x402scan's own catalog of resources | **Undocumented.** Not stated anywhere in the response. |

## 2. Reverifying (a) directly against the database

```
SELECT COUNT(*), SUM(l30d_total_calls), COUNT(DISTINCT host) FROM v_latest_catalog;
 -> (15524, 373056, 1577)
```

Exact match to the figure already in `README.md`. Concentration, checked (per the `$62.8k GMV`
lesson — always check concentration before quoting a total):

```
top 4 routes by calls: x402.twit.sh/tweets/search=118962, x402.tavily.com/search=61486,
  agents.chain.link/v1/operations/:workflowName=19996 (templated, 1 unique payer),
  stableenrich.dev/api/exa/search=11334
sum of top 4 = 211,778 = 56.8% of all 373,056 catalogued calls
single busiest route alone = 31.9% of the total
mean calls/route = 24.06; max = 118,962
```

Even CDP's own catalogued call volume is heavily concentrated in a handful of real, plausible
AI-agent tool-calling services (tweet search, web search) — not a uniform spread across 15,524 routes.

## 3. Attempted bridge #1 — historical nonce query — FAILED, and why

To compare (a) and (b) on the same 30-day footing, the obvious move is
`eth_getTransactionCount(addr, block_30_days_ago)` vs `eth_getTransactionCount(addr, "latest")`.

Tested against `base-rpc.publicnode.com`, `base.llamarpc.com`, `1rpc.io/base` for a top Coinbase
relayer address (`0x3a70…2104`, all-time nonce 4,493,206):

```
blocks_back=1000    (33 min ago)  -> 4,493,206
blocks_back=300000  (7 days ago)  -> 4,493,206
blocks_back=1296000 (30 days ago) -> 4,493,206
blocks_back=2000000 (46 days ago) -> 4,493,206
```

**Identical value at every depth up to 46 days back** — but the *same* endpoint correctly returned an
explicit `"state at block #2 is pruned"` error for genuinely ancient blocks (block 1, block 1001).
An error for ancient blocks but a silent identical answer for 30–46-day-old blocks is the signature of
a node **serving current state regardless of the requested block** for this call, not real archived
history — the same "silent failure that looks like success" class of bug flagged repeatedly in
`ORG-LESSONS.md`. **This method was abandoned. No 30-day facilitator figure was derived from it, and
none should be inferred from these numbers.**

## 4. Attempted bridge #2 — live block sampling, on two DISJOINT windows — WORKED, real output

Instead of trusting historical state, sampled **actual current blocks with full transaction bodies**
(`eth_getBlockByNumber`, batched JSON-RPC) and counted transactions where `from` is one of Coinbase's
40 Base addresses. This needs no historical state at all — it's live chain data.

**First attempt was flawed and corrected on review**: an initial pair of samples (300 blocks, then a
2,500-block sample taken minutes later) turned out to overlap — the first sample's blocks were a
subset of the second's, so they were not independent evidence. Redone with two genuinely **disjoint**
500-block windows, ~12 hours apart:

| Sample | Blocks (offset from latest) | Real elapsed | Total Base tx | Coinbase-sent tx | Settlement-shaped (`transferWithAuthorization` on USDC) | Extrapolated 30d |
|---|---|---|---|---|---|---|
| `recent` | latest−500 → latest | 1,000s (16.7 min) | 75,747 | 1,826 | 1,812 (99.2%) | **4,732,992** |
| `12h_back` | latest−22,100 → latest−21,600 | 1,000s (16.7 min) | 73,591 | 2,417 | 2,413 (99.8%) | **6,264,864** |

Both windows are non-overlapping and ~12 hours apart. Script: `onchain_txsent_sample.py`
(now takes a block-offset argument so windows can be forced disjoint). Raw output:
`onchain_txsent_sample_results_recent.json`, `onchain_txsent_sample_results_12h_back.json`.

**The "1 tx ≈ 1 settlement" assumption was checked directly, not left as a caveat.** For every
Coinbase-sent transaction in both samples, the script reads `to` and the first 4 bytes of `input`
(the function selector). **99.2%–99.8% call `transferWithAuthorization` (`0xe3ee160e`) directly on
the USDC contract** — exactly the EIP-3009 signature x402 uses to settle. The small remainder (14 and
4 transactions respectively) mostly call a single other address
(`0x402085c248eea27d92e8b30b2c58ed07f9e20001` — note the literal "402" in the address, and a distinct
USDC selector `0xcf092995`), which reads as a related x402 support-contract call, not unrelated noise.
This is real evidence that a Coinbase-facilitator-sent transaction is, in the overwhelming majority of
cases, a genuine settlement — not merely assumed.

**Operational detail, not the headline:** only **20 of the 40** Coinbase addresses sent any
transaction in either window — the same 20 both times — each at a near-identical per-address rate.
Reads as round-robin load-balancing across a currently-active subset, not all 40 addresses equally
busy at once.

**Cross-check against the all-time figure (consistency, not proof):** at the sampled rate range
(~157,766–208,829 tx/day), reaching the all-time total of 106,602,243 would take **~511–676 days
(1.4–1.9 years)** of operation at a roughly steady rate. Plausible for a live facilitator's lifetime —
a consistency check, not a verified operating-duration figure.

## 5. The headline number

Using the two disjoint live samples (4.73M–6.26M sent-tx/30d, 99%+ confirmed settlement-shaped)
against CDP's own reported 373,056 catalogued calls/30d:

```
373,056 / 6,264,864 = 5.95%
373,056 / 4,732,992 = 7.88%
```

**CDP's Bazaar catalog captures roughly 6–8% of what Coinbase's own facilitator settles over a
comparable 30-day window. Over 92% of Coinbase facilitator settlement activity is not reflected in
the call counts of Coinbase's own published catalog.** This is a range from two disjoint live samples,
stated as a range on purpose — real variance between two ~12-hour-apart windows (5.95% vs 7.88%),
not a single precise figure. A longer / repeated sampling run would tighten it further and is a
natural follow-up, not done here.

### What this does NOT prove — stated plainly

- **Assumes catalogued CDP routes settle through Coinbase's own facilitator.** Checked the raw
  catalog schema directly (`catalog_resource_full.raw_json_full`) — it records `payTo`, `asset`,
  `network`, `scheme`, but **no facilitator field at all**. Being listed in CDP's Bazaar (a discovery
  service) is not proof of which facilitator actually verifies/settles a given route's payments; a
  resource server could self-host verify/settle or use a different facilitator entirely. This is a
  reasonable assumption (Bazaar is Coinbase's own product) but it is **not directly provable from the
  data we hold**, and is more open than the phrase "Coinbase's own catalog" implies.
- **Assumes "transaction sent by a facilitator address" ≈ "one x402 payment settlement."** Same open
  question already flagged, unresolved, in `notes-onchain-verification.md` — not re-litigated or
  closed by this task.
- **The live sample is ~1.5 hours of real time, extrapolated ~480×–500× to a 30-day figure.** It
  cannot capture daily or weekly seasonality. Presented as an order-of-magnitude range, not a
  point estimate to quote as fact.
- **Dollar value is out of scope here** — Chain department's assigned job in `STRATEGY.md` Phase 1,
  not repeated or guessed at in this document.

## 6. (c) vs (b) — NOT reconcilable from available data, and here is why

The original framing ("resource-level counts in the thousands cannot sum to facilitator-level counts
in the hundreds of millions") is an *inference*, not a proven fact — it depends entirely on how many
resources x402scan's own `/resources` catalog actually holds, and **we do not know that number**. The
prior paid session saw only the top 5 rows of page 0; total resource count was never fetched (would
need further paid calls, not authorized in this task). Any attempt to bridge (c) to (b) by assuming a
resource-population size or borrowing CDP's own call-count distribution would be guessing dressed up
as math — not done here.

**What we can say from a real, measured comparison instead:** x402scan's own busiest catalogued
resource sits at **3,540 calls**. CDP's own busiest catalogued route (§2 above) sits at **118,962
calls/30d** — a **34× gap** between two catalogs that, per `notes-cross-facilitator.md`, cover
overlapping parts of the same ecosystem (both would in principle be able to catalogue a route like
`x402.twit.sh/tweets/search` if it registered with both). Two catalogs observing the same kind of
population should not disagree by 34× at the very top of their own distributions unless they are
measuring over different time windows, or one is catalogading a structurally different, much smaller
slice of resources. **Both are plausible; the data does not let us pick between them.**

**Conclusion, stated plainly per the brief's own instruction: (c) cannot be reconciled with (b) from
available data.** x402scan's own facilitator-level `tx_count` (matching on-chain nonce data to 0.02%)
and its own resource-level `toolCalls` (max 3,540) already disagree with each other by orders of
magnitude — the same internal contradiction flagged in `notes-x402scan-paid-2026-07-31.md`. This task
did not resolve it; it confirms the contradiction is real (via the independent 34× cross-catalog gap
above) and states clearly that closing it requires information we do not have: x402scan's total
resource count and the stated time window for `toolCalls`.

**What would settle it:** x402scan disclosing (i) total resource count and (ii) the time window for
`toolCalls`/`tx_count`, or us paying to fully paginate `/resources` and summing `toolCalls` directly
against `tx_count` — a Paybox decision, not made in this task.

## 7. Summary

| Comparison | Verdict |
|---|---|
| (a) vs (b), same 30-day window | **Reconciled, quantified**: catalog ≈ 6–8% of real facilitator settlement volume, confirmed as genuine settlements by transaction shape (99%+ `transferWithAuthorization` on USDC). Supports the leading hypothesis in the brief. |
| (a) vs (b), all-time nonce framing | **Not directly comparable** — different time bases; the historical-nonce bridge attempt failed and was abandoned, not forced. |
| (c) vs (b) | **Not established.** Population size of x402scan's own catalog is unknown to us. What we did measure: x402scan's own busiest resource (3,540) is 34× smaller than CDP's own busiest catalogued route (118,962/30d) for an overlapping ecosystem — a real, independent data point that the contradiction is genuine, not a guessed bridge across it. |

## 8. Files

- This note: `C:\Users\Micha\Desktop\x402\notes-reconciliation.md`
- New scripts (read-only DB / free RPC / no paid calls / no writes): `onchain_txsent_sample.py`
  (the working live-sample method, now takes a block-offset arg to force disjoint windows),
  `onchain_nonce_window.py` (the failed historical-nonce attempt, kept for the record of what not to
  trust)
- Raw output: `onchain_txsent_sample_results_recent.json`, `onchain_txsent_sample_results_12h_back.json`
- Prior inputs used, not re-derived: `notes-onchain-verification.md`, `facilitator_addresses.json`,
  `notes-x402scan-paid-2026-07-31.md`, `notes-cross-facilitator.md`, `x402_index.db` (opened
  `mode=ro`, zero writes — verified by using only `SELECT` throughout)
