# x402scan paid API — results and the reconciliation problem (2026-07-31)

Three paid calls, $0.01 each, approved by Michael via Paybox. First real money this project has
spent. Source: `www.x402scan.com/api/x402/*`, $0.01 USDC on Base to `0x2EC4545f96A24876764bF2B04D54E66A1351bE71`.

---

## 1. THE ACTUAL PRIZE — facilitator settlement addresses

The `/facilitators` response includes **every facilitator's on-chain settlement addresses**. This is
the unlock: with these we can compute x402 volume **directly from Base/Solana RPC ourselves**, with
no catalog, no API key, no facilitator cooperation, and nobody able to gate or revoke it. Ground
truth we own.

| Facilitator | Base addrs | Solana addrs | Other |
|---|---|---|---|
| Coinbase | 40 | 7 | — |
| PayAI | 15 | 3 | — |
| Dexter | 2 | 2 | — |
| Daydreams | 2 | 1 | — |
| Heurist | 9 | — | — |
| FluxA | 6 | — | — |
| Virtuals | 1 | — | — |
| OpenX402 | 2 | 1 | — |
| X402rs | 6 | — | polygon 1 |
| AnySpend | 1 | 1 | — |

Full address lists are in the raw JSON (see `x402scan_raw/`). **`has_next_page: true`** — this is
only page 0 of 10 per page, so more facilitators exist beyond these ten.

## 2. Headline numbers as reported

`/facilitators/stats` (whole ecosystem):

- **198,301,108 transactions**
- **total_amount 52,589,653,796,995** → **$52,589,653.80** if USDC 6-decimals
- **847,004 unique buyers · 258,064 unique sellers**
- `latest_block_timestamp` came back as an empty object `{}` — no time window is stated anywhere

Per facilitator (page 0, descending by tx_count):

| Facilitator | tx_count | total_amount (÷1e6) | buyers | sellers | avg/tx |
|---|---:|---:|---:|---:|---:|
| Coinbase | 106,581,020 | $28,624,634 | 560,300 | 126,607 | $0.269 |
| PayAI | 35,895,999 | $6,464,777 | 78,451 | 25,565 | $0.180 |
| Dexter | 27,845,123 | $4,793,225 | 17,745 | 9,248 | $0.172 |
| Daydreams | 11,832,154 | $2,762,171 | 18,838 | 9,250 | $0.233 |
| Heurist | 7,967,085 | $30,158 | 4,823 | 1,077 | **$0.0038** |
| FluxA | 1,997,993 | $195,349 | 47,475 | 59,070 | $0.098 |
| Virtuals | 1,989,347 | $4,339,527 | 25,178 | **2** | $2.18 |
| OpenX402 | 707,602 | $245,442 | 9,175 | 496 | $0.347 |
| X402rs | 703,430 | $468,934 | 25,023 | 450 | $0.667 |
| AnySpend | 518,699 | $136,700 | 316 | 71 | $0.264 |

## 3. THE RECONCILIATION PROBLEM — do not publish any of the above yet

These numbers **do not reconcile** with two other measurements we already hold, and the gap is about
three orders of magnitude. Something is being counted differently and we do not yet know what.

**Conflict A — against CDP's own catalog.** CDP's Bazaar reports **373,056 calls in 30 days** across
15,524 routes. x402scan attributes **106,581,020 transactions** to Coinbase. At CDP's own stated
rate, 106M transactions would take ~285 months (~23 years). x402 did not exist 23 years ago.

**Conflict B — against x402scan's own resource data.** The same paid API's `/resources` endpoint
returns per-resource `_count.toolCalls`, and the busiest resources on page 0 sit at **3,540 / 2,991 /
2,925 / 2,450 / 2,208** calls. Resource-level counts in the thousands cannot sum to facilitator-level
counts in the hundreds of millions. **x402scan's own two endpoints disagree with each other.**

**Leading hypothesis (UNVERIFIED):** `tx_count` counts *all* on-chain transfer events touching a
facilitator's address set, not x402 API settlements specifically. Coinbase's 40 Base addresses may
carry substantial non-x402 traffic. The per-facilitator averages support something odd being mixed
in — Heurist averages $0.0038/tx (sub-cent, implausible as a real API price) while Virtuals averages
$2.18 across **two** sellers.

**Also unknown:** whether any figure is all-time or windowed. No timestamp field is populated.

**Verification path, and it needs no permission from anyone:** we now hold the facilitator addresses.
Query Base RPC directly for USDC `Transfer` events to those addresses, bucket by time, and compare.
That settles it independently — and building that capability *is* the moat, not a detour from it.

## 4. What this changes about the strategy

My earlier read — *"the entire x402 economy is ~$62.5k/month, do not build this for income"* — was
derived **solely from CDP's catalog**, which we already knew was CDP-facilitator-observed only. If
even a fraction of x402scan's figures survive verification, that read was wrong by orders of
magnitude, and the cross-facilitator gap is not a nice-to-have differentiator but the entire market.

**I am not revising the strategy on one vendor's unverified numbers**, and neither should anyone
reading this. But the size of the possible error is itself the highest-priority thing on the board:
resolve it on-chain before any public claim, and before Michael makes any decision that assumes the
market is small.

## 5. Secondary find — Heurist publishes per-resource telemetry

`/resources` shows Heurist endpoints carrying rich `metadata`: confidence sub-scores, avg/min/max
latency, `apiSuccessRate`, `successfulSettlements`, abandoned-flow and error counts, plus
`paymentAnalytics` (transactions 24h/week/month, unique users). Most other providers publish none of
this. Worth mirroring as a quality signal — and worth noting that resource-level truth is available
from providers directly, independent of any catalog.
