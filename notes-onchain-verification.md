# On-chain verification of x402scan facilitator stats — 2026-07-31

**Question:** is the x402 economy ~$63k/month (our own CDP Bazaar sweep) or ~$52.6M (x402scan
`/facilitators/stats`)? Settled directly against Base mainnet, read-only, no paid calls.

## Method

- RPC: `https://mainnet.base.org` (public, no key). Required a browser-like `User-Agent` header —
  default Python UA got HTTP 403 from Cloudflare in front of it.
- USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, confirmed 6 decimals (sample transfer
  values decode to sane dollar amounts, not $0.00003 or $33M — wrong decimals would show immediately).
- **Block time measured, not assumed:** latest block 49,344,414 vs. block 10,000 earlier —
  delta = exactly 20,000s → **2.000s/block**, confirming Base's current fixed block time
  (~43,200 blocks/day).
- **eth_getLogs range cap measured, not assumed:** hit real limit at 43,200-block request —
  server returned `{"code":-32614,"message":"eth_getLogs is limited to a 10,000 range"}` (HTTP 413).
  All scans chunk in 10,000-block windows.
- For each facilitator, queried USDC `Transfer` events with the facilitator's Base settlement
  addresses in **either** topic position (sender OR receiver), deduped by `(txHash, logIndex)`.
- Script: `C:\Users\Micha\Desktop\x402\onchain_verify2.py`. Read-only calls only
  (`eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`, `eth_call` for `balanceOf`). No
  transaction ever signed or sent. No paid x402 endpoint touched.

## What was measured

### Recent-window scan (all four target facilitators), block 49,244,539–49,344,539 (**2.315 real days**, 2026-07-28 22:40 UTC → 2026-07-31 06:14 UTC)

| Facilitator | Base addrs scanned | Transfer logs found | Unique tx | Real $ moved | Reported all-time tx_count | Reported all-time $ |
|---|---|---|---|---|---|---|
| **coinbase** | 40 (all) | **0** | 0 | $0 | 106,581,020 | $28,624,634 |
| **heurist** | 9 (all) | **0** | 0 | $0 | 7,967,085 | $30,158 |
| **thirdweb** | 10 (all) | **0** | 0 | $0 | 222,266 | $119,882 |
| **mrdn** | 2 (all) | 304 (152 unique tx) | 152 | **$10,206.31** | 129,547 | $3,328,887 |

### Historical spot-checks — coinbase (5-address sample) and heurist (all 9 addresses), 10,000-block windows at 7d / 30d / 90d / 180d / 365d back from latest

All five spot-checks, both facilitators: **0 logs**. (Blocks: 49,042,172–49,052,171 /
48,048,572–48,058,571 / 45,456,572–45,466,571 / 41,568,572–41,578,571 / 33,576,572–33,586,571.)
That's six independent windows (2.315-day recent + five historical) spanning a full year, all zero,
for the two largest tx_count claims.

### Address sanity check (`eth_call` → `balanceOf`, current state)

- `coinbase` addr 1 (`0xdbdf...90ba6`): holds **$23.43 USDC** right now — a live, non-dead address.
- `coinbase` addr 2: $0.
- `heurist` addr 1 & 2: $0.
- `mrdn` addr 1 (`0x8e77...36e2d6`): holds **$155.55 USDC** right now.

So these are real, currently-controlled addresses — not typos or abandoned wallets. They simply
show no Transfer activity in any sampled window.

### mrdn detail (the one facilitator the chain corroborates)

Sample of 8 of the 152 unique transactions in the 11.11-hour window: individual transfers of
$18.86–$41.03, from 11 distinct counterparty addresses, all landing on the same settlement
address. Average **$67.15/unique-tx** in this window (vs. x402scan's claimed all-time average of
$25.70/tx) — same order of magnitude, real dollar-scale payments, not sub-cent micropayments and
not one-off DeFi/treasury-sized transfers. Extrapolating this window's rate to reach the claimed
129,547 lifetime tx (≈328 tx/day → ~395 days of operation) and $3.33M lifetime total
(≈$22k/day → ~151 days) land in the same ballpark (months to ~1 year of a live low-volume service).
**mrdn's numbers are internally consistent with real on-chain activity — just not typical x402
micropayment activity.**

## Answers to the specific questions

- **Actual transfer counts:** 0 for coinbase, heurist, thirdweb across 2.3 recent days + 1 year of
  spot-checks (6 windows each). 152 unique tx / 40,000s for mrdn.
- **Does the chain support 106M for coinbase?** No. Zero measured activity, in any tested window,
  for the address set x402scan itself supplied as coinbase's settlement addresses.
- **Does it support ~373k/30d (our own CDP sweep number)?** Not directly tested (that figure is
  CDP-catalog-derived, not tied to these specific addresses), but it is far closer to what the chain
  shows (near-zero to modest real activity) than the $52.6M claim is.
- **Decimals:** confirmed correct — 6 decimals. mrdn's decoded values ($18–41/tx) are sane API/
  service payment sizes; wrong decimals would have produced obviously-broken numbers instead.
- **All-time or windowed?** x402scan's own `latest_block_timestamp` field was empty (per handoff),
  so its claim's time base is unstated. We derived real timestamps from Base block headers directly
  (see block/timestamp pairs above) — every number in this note is tied to a real block and a real
  UTC time, not an assumption.
- **mrdn transfers — micropayments or treasury moves?** Neither extreme. Real, modest
  ($20–40/transfer) payments to one address from a small, rotating set of counterparties. Consistent
  with a low-traffic paid service, not DeFi/treasury activity and not a mis-scaled sub-cent API.

## VERDICT

**The chain does not support the $52.6M figure. It flatly contradicts it for the address sets
provided.** Coinbase (the facilitator responsible for ~$28.6M of the ~$52.6M claim, and 106.5M of
the ~198.3M claimed tx) shows **zero** USDC Transfer events touching any of its 40 listed Base
addresses across a recent 2.3-day window and five spot-checks spanning a full year back. The same is
true for heurist (the sub-cent-average facilitator) and thirdweb (a mid-sized one) — three of the
four facilitators tested. Only mrdn shows real, chain-verified transfer activity, and that activity
is small-dollar and low-volume, nowhere near the scale x402scan's aggregate stat implies for the
whole facilitator population.

**x402scan's `/facilitators/stats` `tx_count` is not counting real x402 settlements to these
addresses.** What it actually counts could not be established from this data (candidates: a
different/unlisted address set, a different chain not covered by the "base" array, an internal
ledger metric unrelated to on-chain transfers, or a straightforwardly wrong/inflated number) — that
distinction is **NOT ESTABLISHED** and should not be guessed at further without x402scan disclosing
its methodology.

**What IS established:** the ~$52.6M / 198M-tx headline is unsupported by on-chain evidence for 3 of
4 tested facilitators covering the large majority of the claimed volume. Our own CDP Bazaar
measurement (~$62.8k/30d) is not contradicted by anything found here — if anything, the near-total
absence of on-chain activity for the biggest claimed facilitators makes the small number **more**
credible, not less. Michael's strategy should proceed on the assumption that the x402 economy is
small (tens of thousands of dollars per month, not tens of millions) until someone produces
address-level, on-chain-verifiable evidence to the contrary.

**NOT ESTABLISHED / not tested:** Solana-side facilitator addresses (7 for coinbase alone) — this
verification is Base-only, per the task's RPC and time budget. Polygon addresses for x402rs/
thirdweb/corbits — untested. Whether x402scan's `/resources` 3,540-call figure ties to any specific
on-chain address — untested (that endpoint isn't address-keyed). Full historical scan of all 40
coinbase addresses back to Base genesis — infeasible on a public RPC in this time budget; the
year-spanning 5-point spot-check is the rigorous substitute, explicitly labeled as a sample.

## Files

- Script: `C:\Users\Micha\Desktop\x402\onchain_verify2.py`
- Raw JSON results (recent-window run): `C:\Users\Micha\Desktop\x402\onchain_verify_results.json`
- This note: `C:\Users\Micha\Desktop\x402\notes-onchain-verification.md`

---

# ⚠️ VERDICT OVERTURNED — 2026-07-31, by the orchestrator

**The "zero activity" finding above is a MEASUREMENT ARTIFACT, not a fact about the chain. The
verdict it produced is wrong and must not be acted on.**

## The method error

x402 settles via EIP-3009 `transferWithAuthorization`. The facilitator **submits the transaction and
pays the gas**; the resulting USDC `Transfer` event is **buyer → seller**. The facilitator's address
never appears in the event's `from`/`to` topics.

So filtering USDC `Transfer` logs by facilitator address returns **zero by construction**, at any
volume. Six independent windows all returned zero because all six asked a question whose answer is
structurally always zero — not because nothing happened.

## The correct measurement: transaction count sent (nonce)

`eth_getTransactionCount(address)` returns how many transactions an address has **sent** — i.e. how
many settlements a facilitator relayed. Measured live on Base (`base-rpc.publicnode.com`, head block
49,344,669):

| Facilitator | x402scan claim | Measured TX SENT | Match |
|---|---:|---:|---|
| **coinbase** (40 addrs, all active) | 106,581,020 | **106,602,243** | **99.98%** |
| heurist (9 addrs, all active) | 7,967,085 | 8,327,208 | same order (+4.5%) |
| thirdweb (10 addrs, all active) | 222,266 | 151,994 | same order |
| mrdn (2 addrs, both active) | 129,547 | 68,140 | same order |

Coinbase matches to **0.02%**. That is not coincidence — x402scan is counting exactly this, and its
transaction counts are **real and independently verifiable on-chain**.

Top single Coinbase relayer addresses: `0x3a70…2104` (4,493,206 tx), `0x708e…eca1` (4,485,293),
`0x9c09…8738` (4,481,546). Forty addresses, every one active.

## What this changes

**The x402 economy is not ~$63k/month.** Coinbase's facilitator alone has relayed **106.6 million
settlements** on Base. CDP's Bazaar catalog (373,056 calls/30d across 15,524 catalogued routes)
captures a *tiny fraction* of actual settlement activity — it only counts calls to resources that are
**in its catalog**, which is a small subset of what its own facilitator settles.

The earlier advice — *"the entire x402 economy is ~$62.5k/month, do not build this for income"* — was
derived solely from the catalog and is **wrong by orders of magnitude**.

## Still NOT established — do not overcorrect

- **The dollar figure.** Nonce proves transaction COUNT, not value. The $52.6M total still needs
  independent verification by decoding real transfer values. Do not quote it as verified.
- **Whether every relayed transaction is an x402 settlement.** A nonce counts all transactions an
  address sends. The 99.98% match makes it very likely x402scan counts precisely this, but "facilitator
  transaction" and "x402 API payment" are not proven identical.
- Solana and Polygon addresses untested (Base-only scope).

## Process lesson

The original agent flagged honestly that it could not establish what `tx_count` counts — but still led
with a flat verdict contradicting it. **A confident headline that outruns your own stated uncertainty
is the failure mode.** A zero result across six independent windows should have prompted "is my query
capable of returning non-zero?" before "the claim is false."
