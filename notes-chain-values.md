# On-chain settlement VALUES — 2026-07-31 (Chain department)

**Question:** transaction COUNT is verified (106,602,243 for Coinbase, matched to 0.02%). Is the
DOLLAR VALUE ($52.6M ecosystem-wide / $28,624,633.97 Coinbase-specific, per `facilitator_addresses.json`)
real? Decoded actual settlement amounts from Base mainnet, read-only, no paid calls.

## Method

- RPC: `https://base-rpc.publicnode.com` primary, `https://base.llamarpc.com` fallback (both support
  10,000-block `eth_getLogs` windows). `https://1rpc.io/base` dropped as a fallback — caps
  `eth_getLogs` at 50 blocks, unusable here. `mainnet.base.org` kept as last resort.
- **Batch JSON-RPC does not work on these providers** — `base-rpc.publicnode.com` returned HTTP 403
  on a batch array, `base.llamarpc.com` returned HTTP 521. Fell back to single calls (~2-4s each,
  reliable). This cost real time (see "what was slow" below) — noted so nobody retries batching here.
- Script: `C:\Users\Micha\Desktop\x402\onchain_verify_values.py`. Read-only calls only
  (`eth_getLogs`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`, `eth_blockNumber`). No
  transaction signed or sent. No paid x402 endpoint touched.

### Step 1 — POSITIVE CONTROL (run first, per the brief's non-negotiable instruction)

Searched USDC `Transfer` logs for our wallet `0xf0E8c76aE405963Dc49aaE5806d71c3fa3A709d6` as sender,
last 30 hours (54,000 blocks, chunked 10k). **Found exactly 4 events, each $0.01, landing on
`0x2EC4545f96A24876764bF2B04D54E66A1351bE71`** — matching the four real payments made today exactly.
Raw result: `onchain_values_control.json`. **Method confirmed working before any facilitator claim was
touched.**

### Step 2 — sample real Coinbase-facilitator-sent settlements

- Scanned the latest 100 Base blocks (full transaction lists), filtered for `tx.from` in any of
  Coinbase's 40 listed Base addresses. **390 matching transactions** found out of 14,132 total
  transactions in that window (2.8% of all Base activity in this window was Coinbase-facilitator
  traffic).
- Decoded a **stratified subsample of 150** of those 390 (every ~2.6th match, spread across the full
  100-block window) via `eth_getTransactionReceipt`, reading the USDC `Transfer` log each produced.
- Raw matches: `onchain_values_matches_raw.json`. Decoded receipts: `onchain_values_decoded.json`.
  Summary: `onchain_values_summary.json`.

## What "facilitator transaction" actually is (answers brief's question 5)

**150/150 (100%) of the sampled Coinbase-sent transactions:**
- carry the exact same 4-byte input selector, `0xe3ee160e`
- produced **exactly one** USDC `Transfer` log each (0 with zero transfers, 0 with multiple)

Computed `keccak256("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)")`
locally (via `pycryptodome`, installed for this check) → **`0xe3ee160e`** — an exact match. This is the
EIP-3009 gasless-transfer method x402 uses. **In this sample, every single facilitator-sent
transaction is a real x402-style USDC settlement — no other transaction type appeared.** (Caveat:
one 100-block/~200-second recent window; cannot rule out other tx kinds elsewhere in the address'
history, but the homogeneity here is total, not a majority.)

## The real distribution of settlement values (n=150)

| Stat | Value |
|---|---|
| Median | **$0.00515** |
| Mean | **$0.02799** |
| p10 / p25 | $0.0020 / $0.0020 |
| p50 / p75 / p90 | $0.0052 / $0.0163 / $0.0300 |
| p99 | $1.00 |
| Min / Max | $0.001 / $1.00 |
| Modal value | **$0.002** (65/150 = 43.3% of all sampled tx) |
| ≤ $0.01 | 93/150 = 62% (true micropayments) |
| Exactly $1.00 | 2/150 = 1.3% of tx, but **47.6% of total sampled dollar volume** |
| Mean excluding the two $1.00 outliers | $0.01486 (n=148) — close to the median |

**Same shape as the earlier CDP-catalog outlier problem, mirrored on-chain**: a handful of high-value
outliers (here, 2 of 150) account for nearly half the dollar total. Small-sample mean is unstable;
median and the outlier-stripped mean are the more defensible numbers.

## Is the $52.6M / $28.6M (Coinbase) total plausible?

Coinbase's own reported figures imply an all-time average of **$0.2686/tx**
($28,624,633.97 / 106,581,020). Extrapolating our measured values across the full 106,602,243
confirmed transaction count:

| Basis | Extrapolated total | vs. claimed $28.6M |
|---|---|---|
| Sample mean ($0.02799/tx) | **~$2.98M** | 9.6× too low |
| Outlier-stripped mean ($0.01486/tx) | **~$1.58M** | 18× too low |
| Median ($0.00515/tx) | **~$0.55M** | 52× too low |

**Verdict: NOT plausible as measured, by one to two orders of magnitude — but this is a bounded, not
definitive, finding.** Two things stop this from being a flat contradiction:

1. **Sample is 150 transactions out of 106.6M (0.00014%), drawn from a single ~200-second window
   taken today.** If Coinbase's facilitator handled meaningfully larger average payments earlier in
   its history (different integrations, different pricing eras), a recent snapshot would not capture
   that and the true all-time average could be higher than what we measured.
2. **The distribution is fat-tailed on a tiny sample.** Two $1.00 outliers already swing the mean by
   ~2×; a different 150-tx draw could easily contain 0, 1, or 5 such outliers and change the
   extrapolated total by a similar factor. This is a real measurement, not a guess, but its confidence
   interval is wide.

**What IS established, without caveat:** the $28.6M figure requires an average settlement value
roughly **10–50× higher** than what we directly observed on-chain today. The burden of proof has
shifted — Coinbase's number would require Coinbase-relayed traffic to be very different in composition
(much higher average value) than the traffic we sampled, and nothing in this sample supports that.

## What was NOT done (honest scope limits)

- **Did not decode all 390 matches** — stopped at a 150-tx stratified subsample once the distribution
  stabilized (median/mean converged across the first 100 vs. last 50) and to control run time (single
  calls run ~3s each; 390 would take ~20 min sequentially with no working batch API).
- **Only one time window sampled** (latest ~100 blocks, ~200 seconds, 2026-07-31). Did not
  spot-check historical windows (a week/month/year back) the way the transaction-COUNT verification
  did. This is the single biggest thing that would change the confidence of this result — repeating
  this exact method against 5-10 historical 100-block windows spread across the last year is the
  natural next step and is NOT done here.
- **Solana and Polygon Coinbase addresses untested** — Base-only, per the brief's scope.
- **Did not examine the other 39 Coinbase addresses' individual behavior** — sampled whichever
  addresses happened to transact in the scanned window, not deliberately across all 40.

## Files

- Script: `C:\Users\Micha\Desktop\x402\onchain_verify_values.py`
- Positive control raw result: `C:\Users\Micha\Desktop\x402\onchain_values_control.json`
- Facilitator-sent tx match list (390): `C:\Users\Micha\Desktop\x402\onchain_values_matches_raw.json`
- Decoded receipts (150 subsample): `C:\Users\Micha\Desktop\x402\onchain_values_decoded.json`
- Summary stats + full value list: `C:\Users\Micha\Desktop\x402\onchain_values_summary.json`
- Logs: `logs\chain_values_control.log`, `logs\chain_values_sample.log`, `logs\chain_values_decode2.log`
- This note: `C:\Users\Micha\Desktop\x402\notes-chain-values.md` (does not overwrite
  `notes-onchain-verification.md`, per instruction)

## Bottom line for STRATEGY.md Phase 1

Transaction count for Coinbase: **verified real** (prior work, 0.02% match).
Transaction *composition*: **verified real** — 100% of sampled facilitator-sent tx are genuine EIP-3009
x402 settlements, not incidental other activity.
Dollar total: **the claimed $28.6M (Coinbase) / $52.6M (ecosystem) figures are NOT supported by
directly measured settlement values** — measured average is 10–52× lower, depending on which central
tendency is used. This is a real, verified, positive-control-checked measurement, but it rests on a
single small recent-window sample and should be strengthened with historical spot-checks before being
treated as final. **Do not quote $28.6M or $52.6M as fact. Do not yet quote "$3M" or "$550k" as the
correct figure either — both are one-window extrapolations, not a settled number.**
