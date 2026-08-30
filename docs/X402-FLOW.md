# The x402 flow, properly explained

x402 is the most novel thing in this protocol and it was the least documented. This page is the
mechanism in full: what the 402 challenge contains, what an EIP-3009 `transferWithAuthorization`
actually authorizes, what the facilitator does with it, what "nonce burn" means for your retry
logic, and the one caveat nobody puts on the marketing page — **a paid read is served on broadcast,
not on finality.**

Everything numbered below was executed against Base Sepolia on 2026-08-24 and re-verified with
`cast` by a script sharing no code with the runner: 14 checks, 14 passed. The transcript is
[docs/X402-LIVE-REPORT.md](X402-LIVE-REPORT.md); the machine record is
[docs/evidence/x402-live-run.json](evidence/x402-live-run.json).

---

## 1. Why a payment protocol at all

The metered API serves indexed protocol state. Serving it costs money, and the callers are agents —
software that can issue ten thousand requests while a human is still reading the first response.
The usual answers are API keys (an account, a signup, a credential to leak) or rate limits (which
punish the honest caller and merely inconvenience the abusive one).

x402 replaces both with a price. Each metered read costs $0.01 in USDC, paid by the agent's own
wallet, settled on-chain, with no account and no key exchange. That has a property worth stating
plainly, because it explains a design decision you will notice in the code:

> **x402 *is* the rate limiter for metered routes.** Flooding a priced endpoint is a purchase, not
> a denial-of-service. Only the *free* routes (`/health`, `/.well-known/x402`, `/metrics`) carry a
> per-IP token bucket — see [apps/api/src/server.mjs](../apps/api/src/server.mjs).

## 2. The loop in four messages

```text
  agent                             API server                      facilitator            USDC
    │                                    │                               │                   │
    │ 1. GET /vaults                     │                               │                   │
    │───────────────────────────────────>│                               │                   │
    │ 402 + PAYMENT-REQUIRED: {challenge}│                               │                   │
    │<───────────────────────────────────│                               │                   │
    │                                    │                               │                   │
    │ 2. sign EIP-3009 authorization     │                               │                   │
    │    (locally — nothing sent)        │                               │                   │
    │                                    │                               │                   │
    │ 3. GET /vaults                     │                               │                   │
    │    PAYMENT-SIGNATURE: {envelope}   │                               │                   │
    │───────────────────────────────────>│ POST /settle {challenge,env}  │                   │
    │                                    │──────────────────────────────>│ transferWith-     │
    │                                    │                               │ Authorization()   │
    │                                    │                               │──────────────────>│
    │                                    │       {ok, receiptId: 0x…}    │  broadcast, NOT   │
    │                                    │<──────────────────────────────│  yet mined ⚠      │
    │ 4. 200 + data + PAYMENT-RESPONSE   │                               │                   │
    │<───────────────────────────────────│                               │                   │
```

**The API server holds no key and moves no funds.** It validates the envelope's shape against its
own price, then delegates verification and settlement to a facilitator. That is what keeps the read
API non-custodial: compromising it lets an attacker serve wrong data, never spend anyone's USDC.

## 3. Step 1 — the 402 challenge

An unpaid request to a metered route returns `402` with a `PAYMENT-REQUIRED` header carrying JSON:

```json
{
  "scheme": "exact",
  "x402Version": 2,
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "amount": "10000",
  "payTo": "0x0f80606a2283fd9c67ce2eec79b90e95907f9f35",
  "network": "base",
  "nonce": "0x7eb1f621…58ff",
  "expiresAt": 1787610266000
}
```

| Field | Meaning |
| --- | --- |
| `scheme` | `"exact"` — an exact-amount EIP-3009 authorization. The only scheme this API implements. |
| `asset` | The USDC contract. **Base-unit denominated, 6 decimals.** |
| `amount` | Integer string in base units. `"10000"` is $0.01, not $10,000. |
| `payTo` | Where the USDC goes. Compare it against `/.well-known/x402` before paying. |
| `nonce` | 32 random bytes. **You reuse this verbatim as the EIP-3009 authorization nonce** — see §6. |
| `expiresAt` | Milliseconds. The challenge, not the authorization, expires here. |

The same figures are available for free, before any payment, from
`GET /.well-known/x402`. An agent should bootstrap from that document rather than
hard-coding a price.

## 4. Step 2 — the EIP-3009 authorization

This is the part worth understanding properly, because it is where the money is.

USDC implements [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009), "Transfer With Authorization".
It lets a holder sign an off-chain message that authorizes a *specific* transfer, which **anyone**
can then submit on-chain. The submitter pays the gas; the signer pays the USDC.

Note what that is **not**. It is not `approve`/`transferFrom` — there is no allowance left standing
afterwards. It is not `permit` (EIP-2612) — that grants an allowance; this moves an exact amount,
once. The signature authorizes exactly one transfer of exactly one value to exactly one recipient
inside one time window, and nothing else.

The struct you sign:

| Field | Set from |
| --- | --- |
| `from` | your agent wallet |
| `to` | `challenge.payTo` |
| `value` | `challenge.amount` (the SDK sends it exactly; paying more is allowed and not refunded) |
| `validAfter` | `now − 60s` — backdated, see below |
| `validBefore` | `now + 300s` |
| `nonce` | `challenge.nonce`, verbatim |

**Why `validAfter` is backdated.** EIP-3009 compares `validAfter` to the timestamp of the block that
*mines* the settlement, not to your clock, and the token reverts outright when
`validAfter >= block.timestamp`. A payer whose clock runs even slightly fast signs an authorization
that is not yet valid when it lands. The SDK's default backdate is 60 seconds
(`skewSec`); the original 5 seconds was too tight, and the observed margin in the live run was 64 s.

### The domain trap — read it from the token, do not guess

The EIP-712 domain that the signature is computed over is **not** the same on every chain:

| Chain | `name()` | `version()` |
| --- | --- | --- |
| Base mainnet (8453) | `"USD Coin"` | `"2"` |
| Base Sepolia (84532) | `"USDC"` | `"2"` |

Signing under the wrong name **does not fail loudly.** It produces a structurally valid signature
over a different struct hash, which recovers to an unrelated address, and surfaces as an opaque
`signer-mismatch` from the facilitator — a message that points at your signature when the fault is
in your config. This has bitten this codebase twice
([X402-LIVE-REPORT §7.1 and §7.6](X402-LIVE-REPORT.md)) and it is the single most likely reason a
first integration fails.

The fix is to read the domain from the token rather than hard-code it. See
[Agent quickstart §3](AGENT-QUICKSTART.md#3-read-the-usdc-domain-from-the-token-do-not-hard-code-it)
for a zero-dependency snippet, executed against live Base Sepolia.

## 5. Step 3 — the envelope and the settlement

The signature plus the authorization is base64-encoded into the `PAYMENT-SIGNATURE` header:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "base",
  "signature": "0x…130 hex chars…",
  "authorization": { "from": "0x…", "to": "0x…", "value": "10000",
                     "validAfter": "…", "validBefore": "…",
                     "nonce": "0x…", "asset": "0x…" }
}
```

The API then runs a cheap local check *before* spending a facilitator call — asset, recipient,
network, `value >= price`, not expired, nonce not already seen in this process
([`checkEnvelopeAgainstPrice`](../apps/api/src/x402.mjs)) — and only then calls the facilitator,
which does the expensive part:

1. **Structural validation** — 65-byte signature, positive value, 32-byte nonce, unexpired.
2. **Payer recovery** — reconstruct the typed data and `recoverTypedDataAddress`; refuse unless the
   recovered signer equals `authorization.from`. This is why the domain must match: recovery is
   silent about *why* it produced a different address.
3. **Pre-flight** — `authorizationState(from, nonce)` on the token. `true` means already spent.
4. **Simulate, then broadcast** — `simulateContract` then `writeContract`, using the facilitator
   operator's funded key. **This is where the gas is paid, and it is not paid by you.**
5. **Return the tx hash** as `receiptId`, on broadcast.

A successful settlement emits two events. Both matter, but only one proves the scheme worked:

```text
Transfer(from, to, value)                       ← proves money moved
AuthorizationUsed(authorizer, nonce)            ← proves it moved because a third party
                                                  executed a signed authorization
```

The served response carries `PAYMENT-RESPONSE: {"receiptId":"0x…","nonce":"0x…"}`. Measured cost of
the settlement on Base Sepolia: **85,768 gas ≈ 0.00000053 ETH**, of which the volatile part is the
L1 data fee, because Base is an OP-stack L2 that charges for calldata posted to L1 on top of L2
execution. A 65-byte signature is calldata. Budget for L1 fees, not L2 gas.

## 6. Nonce burn — the part that breaks retries

EIP-3009 nonces are **burned permanently on-chain, per `(authorizer, nonce)` pair.** There is no
expiry, no reset, and no way to un-burn one. This has three consequences an integrator must build
around:

**Replay is impossible, by construction.** Resubmitting a used envelope fails at the token
(`authorization-used`) and, in this API, at a process-local seen-nonce set before that
(`replayed-nonce`). Both were exercised live. You do not need to implement replay protection.

**A challenge nonce is single-use, so a retry needs a fresh 402.** If a paid request fails after the
authorization was signed, you cannot re-sign the same nonce — it is either burned or in flight.
Start the loop again from an unpaid request and take the new challenge. The SDK does this naturally
because it re-enters at the 402.

**A predictable nonce is a self-inflicted outage.** The challenge nonce must be 32 unpredictable
random bytes. An earlier version of this API used a process-local counter starting at 1; because the
agent reuses `challenge.nonce` as the *authorization* nonce, the first paid read after any API
restart presented a nonce a previous run had already burned. The route becomes unpayable — reverting
`authorization-used` forever — until the counter walks past the burned range. Found and fixed before
the live run ([X402-LIVE-REPORT §7.2](X402-LIVE-REPORT.md)); the reasoning is pinned in a comment
above `buildChallenge` so it cannot be "optimised" back.

**Signing is spending.** Under EIP-3009, a signature is a bearer instrument for that exact amount.
Anyone who obtains it can submit it. There is no step after signing at which you can decline. That
is why the SDK's budget guard has to sit *inside* the signer — the reference agent wraps the signer
and throws on `typedData.message.value` before a signature exists, because the 402 → sign → retry
round trip happens inside a single SDK call and a check afterwards is too late.

## 7. The finality caveat — read this before you trust a paid read

**The facilitator returns on broadcast, not on inclusion.** The API answers your request while the
settlement transaction is still in the mempool.

Measured on Base Sepolia:

| Segment | Time |
| --- | --- |
| Full paid-read loop (402 → sign → settle broadcast → data served) | **289 ms** |
| …plus waiting for the settlement to actually be mined | 4,598 ms |

So there is a window — roughly 4 seconds on a 2-second-block testnet, and longer if you also want
confirmations against a reorg — in which **you have been served data for a payment that is not yet
final.** A reorg in that window can un-settle a read that was already delivered. In the normal
direction this favours the payer: you got the data, the payment might vanish. In the operator's
direction it is revenue risk, and in both directions it means a `receiptId` returned to you is a
*broadcast* hash, not proof of settlement.

This is a deliberate latency-for-finality trade, and it is configurable:

- **If you need the data fast** (the default, and right for almost every agent read), accept it. The
  amounts are cents, the exposure is seconds, and 289 ms is the number that makes agent metering
  viable at all.
- **If you need finality** — you are reconciling payments, or a read materially changes what you do
  with real money — have the facilitator wait for the receipt (and for N confirmations) before
  returning. You pay for it in latency: the same loop becomes ~4.9 s on Base Sepolia before you add
  any confirmation depth. Verify the `receiptId` yourself with
  `eth_getTransactionReceipt` and check for the `AuthorizationUsed` event.

Do not read the receipt as a settlement guarantee just because it is a transaction hash. It becomes
one only after inclusion, and it is your side of the loop that has to check.

## 8. Local development, and the honest caveat about it

Running the API with `FACILITATOR=stub` — which is what
[the quickstart](AGENT-QUICKSTART.md) does, and what its startup banner warns about — means
**payments are accepted without any on-chain settlement whatsoever.** No USDC moves. No nonce is
burned. No signature is verified.

That is exactly what you want for local development: the whole 402 → authorize → retry loop runs, on
real code paths, with no funded key and no testnet faucet. But it also means the stub will happily
accept a signature made under the **wrong EIP-712 domain**, which is the one bug most likely to be
waiting for you when you switch to a real facilitator. A green local run does not prove your domain
config is right.

The two production wirings:

| `FACILITATOR` | Behaviour |
| --- | --- |
| `stub` | Accepts everything. Local dev only. Logs a warning at startup. |
| `http` + `FACILITATOR_URL` | Delegates to a remote facilitator. The API server stays keyless. |

There is also `createSettlingFacilitator` in
[apps/api/src/facilitator.mjs](../apps/api/src/facilitator.mjs) for running your own settler: it
recovers the payer and submits `transferWithAuthorization` with an **operator-supplied** account.
That account holds the gas, and the module never embeds, reads, or logs a key. Its boot check
(`assertUsdcDomain`) reads `name()` and `version()` from the token, recomputes the domain separator,
compares it against the token's own `DOMAIN_SEPARATOR()`, and refuses to start on a mismatch — which
is the chain-agnostic version of the §4 trap, and the pattern your client should copy.

## 9. Where to go next

- [Agent quickstart](AGENT-QUICKSTART.md) — run the whole loop locally in about ten minutes.
- [Agent SDK reference](SDK-REFERENCE.md) — every method that implements this, with examples the
  gate executes.
- [docs/api/openapi.yaml](api/openapi.yaml) — the machine contract; generate a client from it.
- [docs/X402-LIVE-REPORT.md](X402-LIVE-REPORT.md) — the full evidence record for everything above.
- [Limits and honest risks](LIMITS.md) — what is beta and what is not audited.
