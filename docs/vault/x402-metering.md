# x402 Metering

**Definition.** The paid read layer (`apps/api`): metered HTTP access to indexer-derived vault
data (analytics, operator leaderboard, signals) settled in USDC on Base via the x402 (V2)
facilitator flow. **The contracts have no x402 dependency whatsoever.**

**Why it matters.** The load-bearing architectural claim is **zero contract coupling**: x402 lives
entirely off-chain, so no x402 failure (replay, facilitator compromise) can touch vault funds.
Deposits are plain on-chain USDC transfers; the vault never special-cases a paid request.

## The boundary (§9, PX-2)

x402 lives only in `apps/api`. Contracts have no HTTP-payment coupling. If x402-initiated deposits
were ever wanted, they compose *externally* (an agent pays itself into a wallet, then deposits)
and the vault treats that like any other deposit. PX-2 is **DEFERRED(S7)** / **ACCEPTED**: any
x402 failure is contained to the API; agents apply their own spend limits.

## x402 V2 flow (server holds no keys, moves no funds — in the launch modes)

> The parenthetical is true of `FACILITATOR=stub` and `FACILITATOR=http`, and false of the opt-in
> `FACILITATOR=svm`, which holds a Solana fee-payer keypair and pays lamports. See
> [[off-chain-stack]] and `apps/api/src/facilitator-svm.mjs`.

`src/x402.mjs` implements the payment gate:

- **402 challenge** via a `PAYMENT-REQUIRED` header.
- Client authorizes with `PAYMENT-SIGNATURE`, a base64 EIP-3009 `transferWithAuthorization`
  envelope. Settlement is executed by an **injected facilitator**, never this server.
- `PAYMENT-RESPONSE` echoes the receipt.

All three headers are base64-encoded JSON, per `specs/transports-v2/http.md:161-167`, and
`PAYMENT-RESPONSE` carries the spec's §5.3.2 `SettlementResponse` fields alongside this repo's own
`receiptId`/`nonce`. The two outbound headers were raw JSON until 2026-09-13; every reader in this
repository accepts either encoding, so nothing in flight broke. See
[`docs/X402-V2-CONFORMANCE.md`](../X402-V2-CONFORMANCE.md).

Settlement is USDC on Base via EIP-3009, executed by the facilitator per the x402 V2 scheme
(dedicated `PAYMENT-*` headers, no contract-layer coupling; confirmed in research).

## Route split: x402 IS the rate limiter

`src/server.mjs` (Node-http):

- **Free:** `/health`, `/.well-known/x402`, `/metrics`. Protected by a per-IP token bucket
  (`src/ratelimit.mjs`) on the free routes only.
- **Paid:** `/vaults`, `/vaults/:addr`, `/vaults/:addr/members/:m`, `/operators/leaderboard`. These
  are **self-limiting**; every metered read costs the caller USDC, so **x402 itself is the rate
  limiter**. No token bucket is applied.

Request caps (method, URL length, body size) are applied before any handler work.

## Per-chain capability (2026-09-05)

The split above holds wherever x402 is present, which is everywhere by default. It is now read per
chain from `contracts/config/<chain>.json` (`x402.enabled`, resolved by
`packages/chain-config/src/x402.mjs` off the API's `CHAIN_ID`); an absent block means enabled, so
`base-mainnet.json` and every caller that passes no chain id are unaffected.

**No chain configured in this repository sets it false today.** Chain 4663 (Robinhood Chain) did,
on the owner's decision of 2026-09-05, until the owner reversed that on 2026-09-15 and
`robinhood-mainnet.json` went back to `enabled: true`. Nothing was deleted to switch it off and
nothing was restored to switch it back on: the gate, the facilitator, the SDK loop and the agent
budget were untouched throughout, and the reversal was one config value.

The off branch is still reachable and still worth knowing. On a chain that declares `false` the
"Paid" routes above are served with no 402, no challenge and no payment headers, and the token
bucket is applied to *every* route instead: the paid routes were exempted only because payment was
the limiter, so removing the payment without extending the bucket would leave them unbounded.

The boundary claim above is unaffected either way: this is an off-chain switch, no contract reads
it, and zero contract coupling is exactly why it can be one.

## Observability

`src/metrics.mjs` exposes plain-text counters, including
`vault_indexer_snapshot_age_seconds`, the indexer-lag signal. The API holds **no client for the
indexed chain** by design, so it reports snapshot age rather than a blocks-behind figure it cannot
know. (`FACILITATOR=svm` constructs a Solana `Connection`; that is a node on a different chain and
answers nothing about this one.) It reads the
[[off-chain-stack]] indexer's projections directly.

## Links

- [[architecture-overview]] · [[off-chain-stack]] (indexer feeding the reads) · [[fees-and-carry]]
  (leaderboard data source)
- Security: [[threat-model-commitments]] (PX-2)
