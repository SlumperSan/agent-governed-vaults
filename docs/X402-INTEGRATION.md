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
   built by `buildChallenge` (`apps/api/src/x402.mjs:130-181`; served by
   `apps/site-next/functions/api/vaults.js`, which imports `gate` from that module rather than
   reimplementing it). As of `docs/X402-V2-CONFORMANCE.md` the challenge is a **superset**: every
   field this doc uses — `{scheme, x402Version, asset, amount, payTo, network, nonce, expiresAt}` —
   stays exactly where it was, and the spec's own `resource`/`accepts[]`/`extensions` fields (§5.1.1)
   are now present alongside them. This doc's buyer reads only the flat fields; see §5 for what the
   added fields do and do not fix.
3. **Check the challenge against what you expected before signing anything** — the amount, `asset`,
   `payTo`, `network` and `expiresAt` are all server-controlled and a server can put anything in
   them. §2 lists what each field means; §6 (the security property) is why this step exists.
4. Sign an EIP-3009 `transferWithAuthorization` authorization over the challenge's `asset`, `amount`
   and `payTo` (`packages/agent-sdk/src/eip3009.mjs:92-113`, `authorizeFromChallenge`).
5. Base64 the envelope — **plain JSON**, `{x402Version, scheme, network, signature, authorization}`
   (`packages/agent-sdk/src/eip3009.mjs:67-75`, `buildEnvelope`) — into a `PAYMENT-SIGNATURE` header
   and repeat the GET. (The server now also accepts the spec's nested payload shape from other
   clients — §5.2 — but this repo's own buyer sends, and the server has always accepted, the flat
   one above.)
6. A `200` carries the data plus a `PAYMENT-RESPONSE` header, **plain JSON**,
   `{receiptId, nonce}` (`apps/api/src/x402.mjs:388`, inside `gate`). The body itself also
   repeats `receiptId` (`apps/site-next/functions/api/vaults.js:93`).

## 2. Challenge fields

| Field | Meaning |
|---|---|
| `scheme` | Payment scheme. This route only ever issues `"exact"` (EIP-3009 on EVM) — never `"exact-svm"`, since `apps/site-next/functions/api/vaults.js` never sets `price.svm` (`buildChallenge`'s own `scheme: price.svm ? 'exact-svm' : 'exact'`, `apps/api/src/x402.mjs:134` — server-side config only, never on anything a client sends). |
| `asset` | The USDC contract address you're being asked to pay with. On this deployment it should be Circle-native USDC on Base mainnet, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (`apps/site-next/functions/api/_price.js:28`, `BASE_MAINNET_USDC`) — **check it against that constant yourself**; a challenge naming anything else is not this deployment behaving correctly. |
| `amount` | Integer string, USDC base units (6dp). `docs/REVENUE.md` §2 prices this route at $0.10 = `"100000"`, but the price is operator-configured (`PRICE_AMOUNT`) and can change — treat the challenge's `amount` as authoritative for what you'll actually be charged, and your own maximum as the thing that must never be exceeded. |
| `payTo` | The recipient address. This is an operator-controlled value with no repo-side default — `resolvePrice` (`apps/site-next/functions/api/_price.js:57-68`) reads it with `requireAddr(env, 'PRICE_PAYTO')` at `:64`, refused rather than defaulted, so a misconfigured deployment answers 500, never silently pays the wrong address. You must know in advance who you expect to be paying. |
| `network` | A bare string, e.g. `"base"` (`docs/REVENUE.md:130`, the `PRICE_NETWORK` setting) — this flat field is **not** CAIP-2. The challenge's `accepts[0].network` field, added since, carries the CAIP-2 form (`eip155:8453`) of the same chain (`apps/api/src/x402.mjs:157`, `toCaip2(price.network)`) — see §5.5. |
| `nonce` | 32-byte hex, fresh per challenge, reused verbatim as the EIP-3009 authorization's on-chain nonce — the doc comment directly above `buildChallenge` in `apps/api/src/x402.mjs` explains why it must be unpredictable, not a counter. |
| `expiresAt` | Unix milliseconds. This repo's own `authorizeFromChallenge` does **not** read it to set the authorization's `validBefore` — it uses a fixed 300s TTL from your signing time regardless (`packages/agent-sdk/src/eip3009.mjs:92-113`). Check it anyway: a stale or implausibly long-lived challenge is a signal something is wrong upstream of you (a caching proxy, or a server not generating fresh challenges). |

The raw JSON also carries `resource`, `accepts` (an array, containing the CAIP-2 network form and,
sometimes, an `extra` domain hint) and `extensions` — added by the v2-conformance work referenced in
§5. This buyer does not read them; `docs/X402-V2-CONFORMANCE.md`'s "Field-by-field" section has the
complete shape.

## 3. A copy-pasteable snippet

Using this repository's own buyer (`scripts/lib/x402-buyer.mjs`), which performs the validate-before-sign
sequence in §6 for you:

```js
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readUsdcDomain } from './apps/api/src/facilitator.mjs';
import { buyResource, signerFromAccount } from './scripts/lib/x402-buyer.mjs';

// A throwaway example key — never a real one in a committed file or a shell history. The CLI
// (scripts/x402-buy.mjs) reads a real key from a keystore, never from argv or a bare env var; see
// its own header for why.
const account = privateKeyToAccount('0x…');
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Circle-native USDC on Base — verify yourself
const CHAIN_ID = 8453;

// Read the EIP-712 domain from the chain rather than hardcoding it — see the note below this
// snippet for why a hardcoded value here is exactly the mistake this step exists to prevent.
const publicClient = createPublicClient({ transport: http('https://mainnet.base.org') });
const domain = await readUsdcDomain({ publicClient, usdcAddress: ASSET, chainId: CHAIN_ID });
if (!domain.matches) throw new Error('USDC domain does not reproduce DOMAIN_SEPARATOR — refusing to sign');

const result = await buyResource({
  url: 'https://rwally.com/api/vaults',
  expected: {
    asset: ASSET,
    payTo: '0x…',        // the address YOU expect to be paying
    network: 'base',
    maxAmount: '150000', // 6 cents of headroom over the documented $0.10 price — never "whatever it asks"
  },
  walletAddress: account.address,
  domain: { name: domain.name, version: domain.version, chainId: CHAIN_ID, verifyingContract: ASSET },
  sign: signerFromAccount(account),
});

console.log(result.paid, result.receipt, result.data);
```

`domain.name`/`domain.version` are the USDC contract's own EIP-712 domain, and it **varies by
chain** — this matters more than it looks, because signing under the wrong name/version does not
fail loudly: it produces a structurally valid signature over a *different* struct hash, which
recovers to an unrelated address, and the failure surfaces downstream as a mysterious rejection
rather than at signing time. That is also why the snippet above reads it from the chain instead of
naming a literal: a copy-pasteable example is exactly where a hardcoded, unverified value would be
copied and pasted.

What this repository has actually verified, and only this: `docs/X402-LIVE-REPORT.md` §6
(`:119-142`) read the domain from Base **Sepolia**'s deployment on-chain and reproduced its
`DOMAIN_SEPARATOR()` with `name()="USDC"`, `version()="2"` — and, in the same table, explicitly
**ruled out** `"USD Coin"`/`"2"` (computed separator `0x2f5ab5ee…068b`, does not match). **There is
no recorded mainnet domain check in this repository.** `apps/api/src/facilitator.mjs:360-361`'s
comment asserts mainnet USDC reports `"USD Coin"`, but that is a comment claim, not something this
repo's own evidence has checked on mainnet the way §6 checked Sepolia — do not treat it as
equivalent proof. Read the domain from the chain rather than hardcoding either value —
`readUsdcDomain` in `apps/api/src/facilitator.mjs:374-391` does this and is what
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
(`apps/api/src/x402.mjs:254-298`) — since this route's EVM-only price never sets `price.svm`, only
the non-SVM branch of that function is reachable:

| Reason | Meaning |
|---|---|
| `asset-mismatch` | Your envelope's `authorization.asset` isn't the challenge's `asset` |
| `recipient-mismatch` | Your envelope's `authorization.to` isn't the challenge's `payTo` |
| `network-mismatch` | Your envelope's `network` isn't the challenge's `network` |
| `bad-value` | `authorization.value` isn't parseable as an integer |
| `underpaid` | `authorization.value` is less than the price |
| `authorization-expired` | `authorization.validBefore` is already in the past |
| `scheme-mismatch` | Your envelope declared `scheme: "exact-svm"` (`apps/api/src/x402.mjs:280`) against this EVM-only route — send `scheme: "exact"` |

A settlement attempt that the facilitator refuses also comes back as `402`, body
`{error: "settlement failed: <reason>", challenge}` — that shape is `gate`'s own
(`apps/api/src/x402.mjs:321-392`; the settlement-failed branch specifically is `:374-382`). This
route's facilitator client is `createStandardHttpFacilitator` (`apps/api/src/facilitator.mjs:262-327`),
which speaks the real two-endpoint `POST /verify` then `POST /settle` protocol (spec §7.1/§7.2) to
whatever URL `FACILITATOR_URL` names — **not** the bespoke single-POST client
(`createHttpFacilitator`) the original 2026-08-24 Sepolia run used, which `docs/REVENUE.md` §3/§4
records was swapped out because no public facilitator spoke that shape. So `<reason>` here comes
from one of: a local shape check before any network call (`no-challenge-price`,
`apps/api/src/facilitator.mjs:277-278`; or `verifyEnvelopeShape`'s own reasons —
`no-envelope`/`bad-version`/`no-authorization`/`bad-from`/`bad-to`/`bad-signature-format`/`bad-value`/
`nonpositive-value`/`bad-nonce`/`authorization-expired`, `apps/api/src/facilitator.mjs:101-116`); a
transport failure naming its step (`verify-unreachable: …` / `settle-unreachable: …`,
`apps/api/src/facilitator.mjs:219`, or `verify-malformed-response` / `settle-malformed-response`);
or the remote facilitator's own verdict (`invalidReason` from `/verify`, or `errorReason` from
`/settle` — spec §9 lists standard values such as `insufficient_funds` — or
`settle-failed-no-transaction` if `/settle` answers `success` with no transaction hash). This
repository does not control that remote vocabulary. The one value this repo has actually observed —
`authorization-used`, from a real replay against a real facilitator on Base Sepolia
(`docs/X402-LIVE-REPORT.md` §2, step 8) — came from the OLD bespoke-client path and is kept here as
a real example of "the chain's own replay guard surfacing through this error field," not as a
reason string this route's current facilitator client is guaranteed to reproduce verbatim.

**`500` — route misconfigured.** Body `{error: "route misconfigured", detail: "<VAR> is not set on
this deployment"}` (`apps/site-next/functions/api/_price.js:146-155`, `configErrorResponse`). Fires when
any of `PRICE_ASSET`, `PRICE_PAYTO`, `PRICE_AMOUNT`, `PRICE_NETWORK`, `FACILITATOR_URL` or
`FACILITATOR_NETWORK` (six settings total, `docs/REVENUE.md` §5.2) is missing or malformed on the
Cloudflare Pages project — deliberately refused rather than defaulted (`docs/REVENUE.md` §3, "It
fails closed"). This is an operator-configuration state, not something a caller triggers by sending
a bad payment. Whether the 500 body's `detail` echoes the bad value differs setting by setting —
`apps/site-next/functions/api/_price.js:93-125`'s comment enumerates each branch; the short version
is that `FACILITATOR_URL` never echoes (both its malformed branches withhold the value, since a
facilitator URL may carry a credential in its path or query, `:70-91`), while the others echo a
malformed value because it is already public on the free discovery document.

**`503`.** Grepped rather than assumed: neither `apps/api/src/x402.mjs`, `apps/api/src/facilitator.mjs`
nor anything under `apps/site-next/functions/` returns a 503 for this route — a facilitator that is
unreachable or times out surfaces as one of the `402 settlement failed: verify-unreachable: …` /
`settle-unreachable: …` cases above, not a 503
(`apps/api/src/facilitator.mjs:203-222`, `postStandardFacilitatorRequest`, catches the fetch
error itself for both legs). If you observe a `503` in production it is the Cloudflare Pages platform
(a cold start or a runtime limit), not this payment gate — treat it as retryable, and do not read it
as a rejected payment.

## 5. Known gap: this endpoint diverges from the published x402 v2 spec

**Status, updated:** a separate change in this repository (`docs/X402-V2-CONFORMANCE.md`, landed
after this doc's first draft) fixed the two shape divergences 5.1 and 5.2 originally described here.
**An off-the-shelf x402 v2 client still cannot pay this endpoint end to end today** — that document
says so itself — but for a narrower reason now: header **encoding** (5.3) and the `PAYMENT-RESPONSE`
**field shape** (5.4), not body/payload shape. Everything below is re-verified against the merged
tree rather than left as it read before that change landed.

`docs/RESEARCH-SPRINT1.md:28-33` originally flagged the V2 field-level schema as **"Unverified"**
and told whoever implemented this to pull the raw spec files "before implementation rather than
relying on this brief for field names" — that step was skipped the first time and is what produced
5.1/5.2 below; `docs/X402-V2-CONFORMANCE.md` records that it was then actually done, field by field,
against `specs/x402-specification-v2.md` and `specs/transports-v2/http.md` fetched directly from
`coinbase/x402`.

**5.1 — FIXED: the `402` challenge body is now a superset, not merely flat.** Spec §5.1.1
(`x402-specification-v2.md:74-99`) defines `PaymentRequired` as
`{x402Version, error?, resource:{url,description?,mimeType?}, accepts:[{scheme,network,amount,asset,payTo,maxTimeoutSeconds,extra?}], extensions?}`.
`buildChallenge` (`apps/api/src/x402.mjs:130-181`) now emits every legacy flat field this doc's buyer
reads (`scheme,asset,amount,payTo,network,nonce,expiresAt`, unchanged) **and** the spec's
`resource`/`accepts[]`/`extensions` fields alongside them — `accepts[0].network` in CAIP-2, and
`accepts[0].extra` when the caller supplies `price.extra` (§5.6 below is about whether *this* route's
price object does). `docs/X402-V2-CONFORMANCE.md`'s "Field-by-field" table has the complete mapping.

**5.2 — FIXED: `decodeSignatureHeader` now accepts the spec's nested payload too.** Spec §5.2.1
(`x402-specification-v2.md:144-181`) defines `PaymentPayload` as
`{x402Version, resource?, accepted:{...PaymentRequirements}, payload:{signature,authorization}, extensions?}`.
`decodeSignatureHeader` (`apps/api/src/x402.mjs:187-242`) now reads `payload.signature`/
`payload.authorization` when present (`:210-212`) and normalizes them onto the same flat shape
`checkEnvelopeAgainstPrice` and `gate()` have always read (`:233-238`) — a spec-nested envelope is
accepted, not rejected as malformed. This repo's own buyer (`scripts/lib/x402-buyer.mjs`) still
builds and sends the flat legacy shape via `buildEnvelope`
(`packages/agent-sdk/src/eip3009.mjs:67-75`) — unchanged, and still accepted, since decoding never
stopped reading the flat top level.

**5.3 — STILL OPEN: two of the three headers are the wrong encoding.** The spec's HTTP transport
(`specs/transports-v2/http.md`, "Header Summary") requires **all three** protocol headers —
`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` — to carry base64-encoded JSON. Inside
`gate` (`apps/api/src/x402.mjs:321-392`), every 402 branch emits `PAYMENT-REQUIRED` as plain
`JSON.stringify` (e.g. `:329`) and the success branch emits `PAYMENT-RESPONSE` the same way (`:388`)
— neither is base64. Only `PAYMENT-SIGNATURE`, built by the client
(`packages/agent-sdk/src/index.mjs`'s `b64` helper, and this doc's own `scripts/lib/x402-buyer.mjs`),
is base64, matching the spec on that one header only. `docs/X402-V2-CONFORMANCE.md`'s "Header names
AND encoding" section names this **MAJOR 2, disclosed but deliberately not fixed there**: fixing it
would require a coordinated change across the five other non-test files that still read
`PAYMENT-REQUIRED`/`PAYMENT-RESPONSE` as raw JSON (that document names all five, including this
repo's own agent SDK and live-run scripts), not a change inside `apps/api/src/x402.mjs` alone.

**5.4 — STILL OPEN: `PAYMENT-RESPONSE`'s field names are this repo's own, not the spec's.** Spec
§5.3.1 (`x402-specification-v2.md:217-228`) defines `SettlementResponse` as
`{success, transaction, network, payer, errorReason?, amount?}`. This repo's `PAYMENT-RESPONSE`
payload is still `{receiptId, nonce}` (`apps/api/src/x402.mjs:388`) — no `success`, `transaction`,
`network` or `payer` field exists. `receiptId` is this repo's own name for what the spec calls
`transaction` — and, since the facilitator rewire, it is genuinely SOURCED from a spec-shaped
`/settle` response's own `transaction` field (`apps/api/src/facilitator.mjs:322-323`,
`createStandardHttpFacilitator`), even though the header that carries it back to the client is not
spec-shaped. In the one real settlement this repo has recorded (via the OLD facilitator client,
before the rewire), its value was the settlement transaction hash (`docs/X402-LIVE-REPORT.md` §1,
"Receipt id | the settlement tx hash") — see §8 below and §4 above for how that client differs from
what this route uses today.

**5.5 — PARTIALLY FIXED: network identifiers are CAIP-2 in the new `accepts[]` array, still bare
strings in the flat field.** Spec §11.1 (`x402-specification-v2.md:617-633`) specifies
`namespace:reference` — `eip155:8453` for Base mainnet, `eip155:84532` for Base Sepolia.
`buildChallenge`'s `accepts[0].network` now carries exactly that (`apps/api/src/x402.mjs:157`,
`toCaip2(price.network)`) — but the challenge's top-level flat `network` field, which this doc's
buyer reads (§2), is still the repo's bare shorthand, `"base"` / `"base-sepolia"`
(`docs/REVENUE.md:130`, `PRICE_NETWORK base`), because the legacy consumers listed in 5.2 read that
field directly and removing it would break them.

**5.6 — PARTIALLY FIXED, and not for this route: the `extra` domain hint is now supportable, but
this route's own price object doesn't supply it.** Spec §5.1.2 (`x402-specification-v2.md:123`)
documents `extra` as an optional bag on each `accepts[]` entry, and the spec's own worked example
fills it with `{name:"USDC", version:"2"}` — precisely the asset's EIP-712 domain name and version.
`buildChallenge` can now populate `accepts[0].extra` (`apps/api/src/x402.mjs:162`,
`...(price.extra ? { extra: price.extra } : {})`) — **when the caller supplies `price.extra`**.
`resolvePrice` (`apps/site-next/functions/api/_price.js:57-68`) does not: it returns
`{asset, payTo, amount, network}`, with no `.extra` field at all, so this specific route's challenge
still omits `extra` in practice, even though the capability now exists in the module it imports.
Independently of that, this repo's own evidence (`docs/X402-LIVE-REPORT.md` §6, `:119-142`) is that
the domain genuinely varies by deployment: it verified `"USDC"`/`"2"` on Base Sepolia and explicitly
ruled out `"USD Coin"`/`"2"` there. `apps/api/src/facilitator.mjs:360-361`'s comment additionally
claims mainnet reports `"USD Coin"`, but — as §3 above says — this repository has no recorded
on-chain check of that; do not treat the comment as equivalent evidence. Until this route's price
object supplies `extra`, a client against it must read the domain off-chain itself — which is what
`readUsdcDomain` (`apps/api/src/facilitator.mjs:374-391`) and this doc's `scripts/x402-buy.mjs` CLI
both do, and what §3's snippet now does directly rather than hardcoding a value.

**Not a divergence, checked and ruled out:** `/.well-known/x402` (`apps/site-next/functions/.well-known/x402.js`,
this route's free discovery document) does not appear anywhere in the fetched spec text — it is this
repository's own convention, not a standard path, and should not be described as one. See §7 for
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

`receiptId` (§1 step 6, §5.4) is this route's own name for the settlement's identifier. This route's
facilitator client, `createStandardHttpFacilitator`
(`apps/api/src/facilitator.mjs:262-327`), sets it to the `transaction` field of the remote
facilitator's spec-shaped `POST /settle` response, and only when that response says
`success === true` and names a non-empty transaction hash (`apps/api/src/facilitator.mjs:319-323`)
— never a placeholder for "the facilitator said yes with nothing to point at". `docs/X402-LIVE-REPORT.md`
§1 records that in this repo's one real settlement (via the OLDER, now-replaced facilitator client —
see §4), its value was the settlement transaction hash. Once you have it, and assuming it is a
transaction hash on the chain your facilitator settles on, `cast tx <receiptId> --rpc-url <that
chain's RPC>` (the same tool `scripts/verify-x402-run.sh` uses) looks up the actual on-chain
transfer — the independent check that proves a specific paid API response corresponds to a specific
USDC movement, rather than trusting the API's own say-so.
