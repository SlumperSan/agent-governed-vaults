# Integrating with the x402-metered endpoint

**Scope of this document.** How to pay for and consume `GET /api/vaults` on `rwally.com`, exactly as
this repository's code implements it today — not as the published x402 protocol specifies it. §5
records where the two disagree and why that gap matters more than it looks. Every claim below is
checked against the source cited next to it, not against another document that summarizes the
source.

**What is being sold and for how much** is `docs/REVENUE.md` §§1–2's subject, not this file's — read
that first if you haven't. This file starts after discovery, at "I have a URL and a wallet."

---

## 1. The handshake, as this endpoint actually runs it

1. `GET https://rwally.com/api/vaults` with no payment header.
2. The route answers `402` with a `PAYMENT-REQUIRED` header: **plain JSON** (not base64 — see §5),
   `{scheme, x402Version, asset, amount, payTo, network, nonce, expiresAt}`
   (`apps/api/src/x402.mjs:60-86`, `buildChallenge`; served by
   `apps/site-next/functions/api/vaults.js`, which imports `gate` from that module rather than
   reimplementing it).
3. **Check the challenge against what you expected before signing anything** — the amount, `asset`,
   `payTo`, `network` and `expiresAt` are all server-controlled and a server can put anything in
   them. §2 lists what each field means; §6 (the security property) is why this step exists.
4. Sign an EIP-3009 `transferWithAuthorization` authorization over the challenge's `asset`, `amount`
   and `payTo` (`packages/agent-sdk/src/eip3009.mjs:92-113`, `authorizeFromChallenge`).
5. Base64 the envelope — **plain JSON**, `{x402Version, scheme, network, signature, authorization}`
   (`packages/agent-sdk/src/eip3009.mjs:67-75`, `buildEnvelope`) — into a `PAYMENT-SIGNATURE` header
   and repeat the GET.
6. A `200` carries the data plus a `PAYMENT-RESPONSE` header, **plain JSON**,
   `{receiptId, nonce}` (`apps/api/src/x402.mjs:254-256`, inside `gate`). The body itself also
   repeats `receiptId` (`apps/site-next/functions/api/vaults.js:82`).

## 2. Challenge fields

| Field | Meaning |
|---|---|
| `scheme` | Payment scheme. This route only ever issues `"exact"` (EIP-3009 on EVM) — never `"exact-svm"`, since `apps/site-next/functions/api/vaults.js` never sets `price.svm` (`apps/api/src/x402.mjs:145` gates the SVM branch on that field, server-side config only, never on anything a client sends). |
| `asset` | The USDC contract address you're being asked to pay with. On this deployment it should be Circle-native USDC on Base mainnet, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (`apps/site-next/functions/api/_price.js:28`, `BASE_MAINNET_USDC`) — **check it against that constant yourself**; a challenge naming anything else is not this deployment behaving correctly. |
| `amount` | Integer string, USDC base units (6dp). `docs/REVENUE.md` §2 prices this route at $0.10 = `"100000"`, but the price is operator-configured (`PRICE_AMOUNT`) and can change — treat the challenge's `amount` as authoritative for what you'll actually be charged, and your own maximum as the thing that must never be exceeded. |
| `payTo` | The recipient address. This is an operator-controlled value with no repo-side default — `resolvePrice` (`apps/site-next/functions/api/_price.js:57-68`) reads it with `requireAddr(env, 'PRICE_PAYTO')` at `:64`, refused rather than defaulted, so a misconfigured deployment answers 500, never silently pays the wrong address. You must know in advance who you expect to be paying. |
| `network` | A bare string, e.g. `"base"` (`docs/REVENUE.md:108`) — **not** the CAIP-2 identifier (`eip155:8453`) the published spec uses. See §5. |
| `nonce` | 32-byte hex, fresh per challenge, reused verbatim as the EIP-3009 authorization's on-chain nonce — the doc comment directly above `buildChallenge` in `apps/api/src/x402.mjs` explains why it must be unpredictable, not a counter. |
| `expiresAt` | Unix milliseconds. This repo's own `authorizeFromChallenge` does **not** read it to set the authorization's `validBefore` — it uses a fixed 300s TTL from your signing time regardless (`packages/agent-sdk/src/eip3009.mjs:92-113`). Check it anyway: a stale or implausibly long-lived challenge is a signal something is wrong upstream of you (a caching proxy, or a server not generating fresh challenges). |

## 3. A copy-pasteable snippet

Using this repository's own buyer (`scripts/lib/x402-buyer.mjs`), which performs the validate-before-sign
sequence in §6 for you:

```js
import { buyResource, signerFromAccount } from './scripts/lib/x402-buyer.mjs';
import { privateKeyToAccount } from 'viem/accounts';

// A throwaway example key — never a real one in a committed file or a shell history. The CLI
// (scripts/x402-buy.mjs) reads a real key from a keystore, never from argv or a bare env var; see
// its own header for why.
const account = privateKeyToAccount('0x…');

const result = await buyResource({
  url: 'https://rwally.com/api/vaults',
  expected: {
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Circle-native USDC on Base — verify yourself
    payTo: '0x…',        // the address YOU expect to be paying
    network: 'base',
    maxAmount: '150000', // 6 cents of headroom over the documented $0.10 price — never "whatever it asks"
  },
  walletAddress: account.address,
  // Illustrative only — see the note below the snippet. Read `name`/`version` from the chain
  // (readUsdcDomain) rather than hardcoding either of these.
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  sign: signerFromAccount(account),
});

console.log(result.paid, result.receipt, result.data);
```

`domain.name`/`domain.version` are the USDC contract's own EIP-712 domain, and it **varies by
chain** — this matters more than it looks, because signing under the wrong name/version does not
fail loudly: it produces a structurally valid signature over a *different* struct hash, which
recovers to an unrelated address, and the failure surfaces downstream as a mysterious rejection
rather than at signing time.

What this repository has actually verified, and only this: `docs/X402-LIVE-REPORT.md` §6
(`:119-142`) read the domain from Base **Sepolia**'s deployment on-chain and reproduced its
`DOMAIN_SEPARATOR()` with `name()="USDC"`, `version()="2"` — and, in the same table, explicitly
**ruled out** `"USD Coin"`/`"2"` (computed separator `0x2f5ab5ee…068b`, does not match). **There is
no recorded mainnet domain check in this repository.** `apps/api/src/facilitator.mjs:202-204`'s
comment asserts mainnet USDC reports `"USD Coin"`, but that is a comment claim, not something this
repo's own evidence has checked on mainnet the way §6 checked Sepolia — do not treat it as
equivalent proof. Read the domain from the chain rather than hardcoding either value —
`readUsdcDomain` in `apps/api/src/facilitator.mjs:216-233` does this and is what
`scripts/x402-buy.mjs` calls before signing anything.

For a one-shot real purchase from a terminal — the CLI wrapping the same library, reading its key
from an encrypted keystore rather than any argument or bare environment variable:

```
BUYER_KEYSTORE=~/.foundry/keystores/buyer \
BUYER_KEYSTORE_PASSWORD=… \
node scripts/x402-buy.mjs \
  --url=https://rwally.com/api/vaults \
  --network=base \
  --asset=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --pay-to=<the address you expect to be paying> \
  --max=0.10 \
  --rpc-url=https://mainnet.base.org
```

`scripts/x402-buy.mjs`'s own header comment has the full flag list and explains the key-handling
rule in detail.

## 4. Failure modes

**`402` — payment invalid.** The route re-issues a fresh challenge alongside one of these reasons in
the body's `error` field, all returned by `checkEnvelopeAgainstPrice`
(`apps/api/src/x402.mjs:129-173`) — since this route's EVM-only price never sets `price.svm`, only
the non-SVM branch of that function is reachable:

| Reason | Meaning |
|---|---|
| `asset-mismatch` | Your envelope's `authorization.asset` isn't the challenge's `asset` |
| `recipient-mismatch` | Your envelope's `authorization.to` isn't the challenge's `payTo` |
| `network-mismatch` | Your envelope's `network` isn't the challenge's `network` |
| `bad-value` | `authorization.value` isn't parseable as an integer |
| `underpaid` | `authorization.value` is less than the price |
| `authorization-expired` | `authorization.validBefore` is already in the past |
| `scheme-mismatch` | Your envelope declared `scheme: "exact-svm"` (`apps/api/src/x402.mjs:155`) against this EVM-only route — send `scheme: "exact"` |

A settlement attempt that the facilitator refuses also comes back as `402`, body
`{error: "settlement failed: <reason>", challenge}` — that shape is `gate`'s own
(`apps/api/src/x402.mjs:129-173` is `checkEnvelopeAgainstPrice`; `gate` itself, which builds this
particular body, is `apps/api/src/x402.mjs:192-259`). That `<reason>` string is whatever the
facilitator your deployment's `FACILITATOR_URL` names returns — this repository does not control its
vocabulary. One observed value, from a real replay against a real facilitator on Base Sepolia:
`authorization-used` (`docs/X402-LIVE-REPORT.md` §2, step 8) — the on-chain EIP-3009 nonce guard
doing its job, not something this route's own code decides.

**`500` — route misconfigured.** Body `{error: "route misconfigured", detail: "<VAR> is not set on
this deployment"}` (`apps/site-next/functions/api/_price.js:98-107`, `configErrorResponse`). Fires when any
of `PRICE_ASSET`, `PRICE_PAYTO`, `PRICE_AMOUNT`, `PRICE_NETWORK` or `FACILITATOR_URL` is missing or
malformed on the Cloudflare Pages project — deliberately refused rather than defaulted
(`docs/REVENUE.md` §3, "It fails closed"). This is an operator-configuration state, not something a
caller triggers by sending a bad payment.

**`503`.** Grepped rather than assumed: neither `apps/api/src/x402.mjs`, `apps/api/src/facilitator.mjs`
nor anything under `apps/site-next/functions/` returns a 503 for this route — a facilitator that is
unreachable or times out surfaces as the `402 settlement failed: facilitator-unreachable: …` case
above, not a 503 (`apps/api/src/facilitator.mjs:147-169`, `createHttpFacilitator`, catches the fetch
error itself). If you observe a `503` in production it is the Cloudflare Pages platform (a cold
start or a runtime limit), not this payment gate — treat it as retryable, and do not read it as a
rejected payment.

## 5. Known gap: this endpoint diverges from the published x402 v2 spec

**An off-the-shelf x402 v2 client cannot pay this endpoint today.** This is the honest and
commercially relevant fact this section exists to state plainly, not a deliberate design choice —
`docs/RESEARCH-SPRINT1.md:28-33` flagged the V2 field-level schema as **"Unverified"** and told
whoever implemented this to pull the raw spec files "before implementation rather than relying on
this brief for field names." That never happened, and every divergence below is the direct result.
Verified by fetching the spec's own text (`coinbase/x402` repository,
`specs/x402-specification-v2.md` and `specs/transports-v2/http.md`, both at their `main` branch as
of 2026-09-13) rather than by relaying a summary of it:

**5.1 — The `402` challenge body is flat here, nested in the spec.** Spec §5.1.1
(`x402-specification-v2.md:74-99`) defines `PaymentRequired` as
`{x402Version, error?, resource:{url,description?,mimeType?}, accepts:[{scheme,network,amount,asset,payTo,maxTimeoutSeconds,extra?}], extensions?}`
— an **array** of acceptable payment methods, each carrying its own `maxTimeoutSeconds` and an
optional `extra` bag. This repo's `buildChallenge` (`apps/api/src/x402.mjs:60-86`) returns a single
flat object with no `accepts` array, no `resource`, no `maxTimeoutSeconds`, no `extra` — and adds
`nonce` and `expiresAt`, which the spec's schema does not have at all.

**5.2 — The `PAYMENT-SIGNATURE` payload is flat here, nested in the spec.** Spec §5.2.1
(`x402-specification-v2.md:144-181`) defines `PaymentPayload` as
`{x402Version, resource?, accepted:{...PaymentRequirements}, payload:{signature,authorization}, extensions?}`
— the signature and authorization live under `payload`, not at the top level. This repo's
`buildEnvelope` (`packages/agent-sdk/src/eip3009.mjs:67-75`) puts `signature` and `authorization`
directly on the envelope, alongside `scheme` and `network` which the spec instead nests inside
`accepted`. `decodeSignatureHeader` (`apps/api/src/x402.mjs:92-117`) accepts exactly two flat
shapes — EVM, `typeof env.signature === 'string' && typeof env.authorization === 'object'` at the
top level, or SVM, `{scheme:'exact-svm', transaction}` (`apps/api/src/x402.mjs:110-111`) — and
this route's price never selects the SVM one. Neither shape is the spec's nested
`payload.signature`/`payload.authorization`, so a spec-conformant nested payload would decode as
malformed here, not as an accepted payment.

**5.3 — Two of the three headers are the wrong encoding.** The spec's HTTP transport
(`specs/transports-v2/http.md`, "Header Summary") requires **all three** protocol headers —
`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` — to carry base64-encoded JSON. Inside
`gate` (`apps/api/src/x402.mjs:192-259`), the 402 branch emits `PAYMENT-REQUIRED` as plain
`JSON.stringify` (`apps/api/src/x402.mjs:200`, still inside `gate`) and the success branch emits
`PAYMENT-RESPONSE` the same way (`apps/api/src/x402.mjs:255`, still inside `gate`) — neither is
base64. Only `PAYMENT-SIGNATURE`, built by the
client (`packages/agent-sdk/src/index.mjs`'s `b64` helper, and this doc's own `scripts/lib/x402-buyer.mjs`),
is base64, matching the spec on that one header only. `docs/RESEARCH-SPRINT1.md:19` correctly
recorded that `PAYMENT-REQUIRED` should be base64-encoded before this was built; the implementation
did not carry that forward.

**5.4 — `PAYMENT-RESPONSE`'s field names are this repo's own, not the spec's.** Spec §5.3.1
(`x402-specification-v2.md:217-228`) defines `SettlementResponse` as
`{success, transaction, network, payer, errorReason?, amount?}`. This repo's `PAYMENT-RESPONSE`
payload is `{receiptId, nonce}` (`apps/api/src/x402.mjs:255`) — no `success`, `transaction`,
`network` or `payer` field exists. `receiptId` is this repo's own name for what the spec calls
`transaction`; in the one real settlement this repo has recorded, its value was the settlement
transaction hash (`docs/X402-LIVE-REPORT.md` §1, "Receipt id | the settlement tx hash").

**5.5 — Network identifiers are bare strings here, CAIP-2 in the spec.** Spec §11.1
(`x402-specification-v2.md:617-633`) specifies `namespace:reference` — `eip155:8453` for Base
mainnet, `eip155:84532` for Base Sepolia. This repo uses bare strings, `"base"` / `"base-sepolia"`
(`docs/REVENUE.md:108`, `PRICE_NETWORK base`).

**5.6 — The `extra` domain hint is absent, and its absence has a real cost.** Spec §5.1.2
(`x402-specification-v2.md:123`) documents `extra` as an optional bag on each `accepts[]` entry, and
the spec's own worked example fills it with `{name:"USDC", version:"2"}` — precisely the asset's
EIP-712 domain name and version. This repo's challenge carries no `extra` at all, and —
independently of the spec gap — this repo's own evidence (`docs/X402-LIVE-REPORT.md` §6,
`:119-142`) is that the domain genuinely varies by deployment: it verified `"USDC"`/`"2"` on Base
Sepolia and explicitly ruled out `"USD Coin"`/`"2"` there. `apps/api/src/facilitator.mjs:202-204`'s
comment additionally claims mainnet reports `"USD Coin"`, but — as §3 above says — this repository
has no recorded on-chain check of that; do not treat the comment as equivalent evidence. A client
that only spoke the spec's `accepts[].extra` field would have the answer handed to it; a client
against this endpoint has none and must read the domain off-chain itself — which is what
`readUsdcDomain` (`apps/api/src/facilitator.mjs:216-233`) and this doc's `scripts/x402-buy.mjs` CLI
both do.

**Not a divergence, checked and ruled out:** `/.well-known/x402` (`apps/site-next/functions/.well-known/x402.js`,
this route's free discovery document) does not appear anywhere in the fetched spec text — it is this
repository's own convention, not a standard path, and should not be described as one. See §6 for
what the spec does define for discovery.

## 6. The security property this client enforces

A challenge names its own `asset`, `amount`, `payTo`, `network` and `expiresAt` — every field a
misconfigured or malicious server controls. `scripts/lib/x402-buyer.mjs`'s `validateChallenge`
checks the challenge against values the *caller* supplies up front, before `sign` is ever invoked,
and aborts with `ChallengeMismatchError` on any mismatch — `amount` above your stated maximum,
a different `asset`, a different `payTo`, a different `network`, or an already-expired (or
implausibly long-lived) `expiresAt`. `scripts/test/x402-buyer.test.mjs` asserts this by spying on the
`sign` callback and checking it was never called, for exactly this reason: a test that only checks
the call rejected would still pass a buyer that signed first and only failed afterwards.

## 7. Discovery: what is real, what is unconfirmed

**The read side is a real, specified thing.** x402 v2 §8 (`x402-specification-v2.md:493-548`)
defines `GET /discovery/resources` against a "Bazaar" — a marketplace that lists discoverable
resources, each carrying `resource`, `type`, `x402Version`, `accepts`, `lastUpdated` and optional
`metadata`. That much is directly verifiable in the spec text.

**How a seller registers a resource with a Bazaar is not something this document states, because it
is not something the fetched spec text defines.** §8 and the HTTP transport doc both cover the
*read* side only; neither describes a registration or write API for adding a resource to a Bazaar,
nor names which Bazaar instance (if any) is the one to use. Treat this as **unverified and
pending**, not as a gap in this endpoint's own code — publishing this endpoint to a Bazaar is a
distribution decision `docs/REVENUE.md` §6 already flags as phase-2 work, and doing so needs
registration mechanics nobody has yet confirmed from a primary source.

**Secondary, unconfirmed:** `docs/RESEARCH-SPRINT1.md:59-61` records that Coinbase operates a
CDP-hosted facilitator at `https://x402.org/facilitator` with API-key auth, covering Base, Base
Sepolia, Solana and Solana Devnet. That claim comes from that research brief, not from independent verification in this
session, and is not confirmed here.

## 8. What the receipt id is good for

`receiptId` (§1 step 6, §5.4) is this route's own name for the settlement's identifier — in this
repo's one real run it was the settlement transaction hash
(`docs/X402-LIVE-REPORT.md` §1). Its exact contents on any given call are whatever the facilitator
named by `FACILITATOR_URL` returns as its own `receiptId` field
(`apps/api/src/facilitator.mjs:147-169`, `createHttpFacilitator` relays it verbatim) — this repo does
not itself mint or format it. Once you have it, and assuming it is a transaction hash on the chain
your facilitator settles on, `cast tx <receiptId> --rpc-url <that chain's RPC>` (the same tool
`scripts/verify-x402-run.sh` uses) looks up the actual on-chain transfer — the independent check that
proves a specific paid API response corresponds to a specific USDC movement, rather than trusting
the API's own say-so.
