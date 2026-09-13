# x402 v2 wire conformance

`apps/api/src/x402.mjs` implements this API's side of the x402 protocol. This document records
what was checked against the spec, field by field, and what changed. The spec files were
downloaded directly rather than paraphrased from a prior brief:

```
gh api repos/coinbase/x402/contents/specs/x402-specification-v2.md --jq .content | base64 -d
gh api repos/coinbase/x402/contents/specs/schemes/exact/scheme_exact_evm.md --jq .content | base64 -d
gh api repos/coinbase/x402/contents/specs/schemes/exact/scheme_exact.md --jq .content | base64 -d
```

`docs/RESEARCH-SPRINT1.md:27-32` had flagged the field-level schema as "Unverified" and told
implementers to pull it directly rather than rely on that brief; that step had never actually been
done, which is why the repo's wire format diverged from the spec undetected.

## Fixes from review

Two independent reviewers found real gaps in the first version of this change. Both are fixed
(MAJOR 1) or disclosed with a stated reason it is not fixed here (MAJOR 2):

- **MAJOR 1 (fixed): a spec-nested v2 envelope passed `gate()` and then died at settlement.**
  `checkEnvelopeAgainstPrice` (this change) compared networks via `networksEqual`, but
  `facilitator-server.mjs`'s `checkChallengePrice` — the relay guard a real `FACILITATOR=http`
  deployment runs on every `POST /settle` — still compared them by exact lowercase string
  equality. `gate()` hoists a spec-nested envelope's network from `accepted.network`, which is
  CAIP-2; `price.network` is the repo's shorthand. Reproduced directly before the fix: a
  correctly-signed spec envelope got `checkEnvelopeAgainstPrice: {ok:true}` and then
  `checkChallengePrice: {ok:false, reason:'network-mismatch'}`, so `gate()` returned 402
  "settlement failed" for a valid payment. Fixed by importing the same `networksEqual` (now
  exported from `x402.mjs`) into `checkChallengePrice`, so the two checks cannot drift apart on
  this again. The test that was supposed to catch this instead asserted it settled "end to end"
  while stubbing the exact leg that broke; it now runs a facilitator spy that genuinely calls
  `checkChallengePrice`, plus a dedicated unit-level test on `checkChallengePrice` itself.
- **MAJOR 2 (disclosed then, fixed since): outbound headers were not base64-encoded and not
  `SettlementResponse`-shaped.** The finding is recorded under "Header names AND encoding" below,
  followed by "Header encoding: closed 2026-09-13", which records the coordinated change that
  closed it.
- The doc also had a wrong section citation and a false claim ("the spec is silent on header
  naming") — both corrected below rather than quietly dropped.

## Why this mattered

A third-party, off-the-shelf x402 client builds requests against the spec's documented shapes. A
server that emits a different 402 body, or that only accepts a differently-nested payment payload,
cannot be paid by such a client — which blocks any revenue path that depends on external agents
paying this API rather than this repo's own agent SDK.

## Approach: emit conformant, accept both

1. There is a real, recorded settlement on the old flat shape (`docs/X402-LIVE-REPORT.md`, a live
   Base Sepolia settlement on 2026-08-24). That record describes what the code did *then*; nothing
   here edits it.
2. Existing consumers of the flat shape must keep working: `packages/agent-sdk/src/eip3009.mjs`
   and `packages/agent-sdk/src/index.mjs` (the agent SDK — `authorizeFromChallenge` reads
   `challenge.payTo`/`.amount`/`.nonce`/`.asset`/`.network` directly off the 402 header's JSON),
   `scripts/live-x402-run.mjs` (reads `t.challenge.header.nonce`), and `scripts/soak/api-client.mjs`
   (falls back to `(await first.json()).challenge` and checks `challenge.scheme`).

So the 402 body and the `PAYMENT-REQUIRED` header value became a **superset**: every existing flat
field is unchanged, and the spec's `resource`/`accepts`/`extensions` fields were added alongside.
`decodeSignatureHeader` accepts either the legacy flat `PAYMENT-SIGNATURE` envelope or the spec's
nested one, and normalizes the nested shape onto the same flat fields
(`signature`/`authorization`/`network`) before anything downstream — `checkEnvelopeAgainstPrice`,
`gate()`, and the facilitator modules `gate()` hands the decoded envelope to — ever sees it.

`apps/api/src/facilitator.mjs` was not in this change's file grant and was not edited; normalizing
inside the decoder means it receives the same flat shape it always has, regardless of which shape
the client sent. `apps/api/src/facilitator-server.mjs` **was not in the original file grant
either, but was edited** — granted mid-review, after review found that its own network re-check
(`checkChallengePrice`) compared the normalized envelope's CAIP-2 network against `price.network`
by exact string equality with no `networksEqual`, so a spec-nested v2 payment that passed `gate()`
was then refused at the facilitator relay with `network-mismatch`. See "Fixes from review" below —
this was the change's one real end-to-end gap, now closed and covered by a test that exercises the
real `checkChallengePrice`, not a stub that always says yes.

This repo's own SVM path (`price.svm`, `scheme: 'exact-svm'`, the `facilitator-svm.mjs` module) is
untouched. It is a separate, repo-specific extension to the "exact" scheme that the downloaded v2
spec does not describe (the spec's own SVM scheme doc, `scheme_exact_svm.md`, was not pulled as
part of this change), so no conformance claim is made about it either way.

## Field-by-field: what changed

### 402 body / `PAYMENT-REQUIRED` header (spec §5.1.1, `PaymentRequired`)

| Spec field (§5.1.1/§5.1.2)   | Emitted before                                    | Emitted now                                                                  |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `x402Version`                 | `2` (top level)                                    | Unchanged — `2`, top level                                                    |
| `error`                       | Present in the response **body** only, not the header | Unchanged in the body; still absent from the header value (the header carries only the challenge/PaymentRequirements, as before) |
| `resource` (object, Required) | Absent                                             | Present: `{url, description?, mimeType?}`. `url` comes from the caller (`gate()`'s `resource` param, threaded from `server.mjs`'s request path); an unsupplied one is `''` |
| `accepts` (array, Required)   | Absent                                             | Present: one-element array, see the `PaymentRequirements` row below           |
| `extensions` (object, Optional) | Absent                                           | Present: `{}` (none implemented)                                              |
| *(repo-only)* `scheme`, `asset`, `amount`, `payTo`, `network`, `nonce`, `expiresAt` | Present, flat, top level | **Unchanged** — kept for the existing flat-shape consumers listed above |

### `accepts[]` — `PaymentRequirements` (spec §5.1.2)

| Spec field           | Emitted before   | Emitted now                                                                          |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `scheme`              | n/a (only the flat top-level `scheme` existed) | `"exact"` (or `"exact-svm"` under the repo's own SVM price, unchanged behavior)         |
| `network` (CAIP-2, §11.1) | n/a          | `eip155:8453` (Base mainnet) / `eip155:84532` (Base Sepolia) — mapped from the repo's `price.network` ("base" / "base-sepolia"); the flat top-level `network` field keeps the repo shorthand |
| `amount`              | n/a              | `price.amount`, unchanged value                                                        |
| `asset`               | n/a              | `price.asset`, unchanged value                                                         |
| `payTo`               | n/a              | `price.payTo`, unchanged value                                                         |
| `maxTimeoutSeconds`   | n/a              | The challenge's TTL in seconds (`Math.round(ttlMs/1000)`; 300 by default)               |
| `extra` (Optional)    | n/a              | Present only when the caller supplies `price.extra` (e.g. the USDC EIP-712 domain read from the token by `facilitator.mjs`'s `readUsdcDomain`); omitted otherwise, never a hardcoded guess — `facilitator.mjs`'s own comments document that this domain's `name` varies ("USDC" on Base Sepolia, "USD Coin" on mainnet), so a hardcoded value would be wrong on one of the two chains this repo configures |

### `PAYMENT-SIGNATURE` envelope — `PaymentPayload` (spec §5.2.1/§5.2.2)

| Spec field                                   | Accepted before                          | Accepted now                                                                 |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| `x402Version`                                 | Required `=== 2`                          | Unchanged                                                                       |
| `payload.signature` (nested, §5.2.1)          | Rejected — signature had to be top-level | Accepted, alongside the still-accepted top-level `signature`                    |
| `payload.authorization` (nested, §5.2.1)      | Rejected — authorization had to be top-level | Accepted, alongside the still-accepted top-level `authorization`            |
| `authorization.{from,to,value,validAfter,validBefore,nonce}` (§5.2.2, no `asset`) | Repo's flat authorization always additionally carried `asset` | Unchanged for the flat shape; for a spec-shaped authorization lacking `asset`, it is backfilled from `accepted.asset` during decode, since `checkEnvelopeAgainstPrice` needs it |
| `accepted` (chosen `PaymentRequirements`)     | Not read                                  | Read for its `.asset`/`.network`, to normalize a spec-shaped envelope           |
| `resource`, `extensions` (Optional)           | Not read                                  | Passed through untouched (present on the decoded object if the client sent them), not otherwise inspected |

### Network identifiers (spec §11.1)

The spec requires CAIP-2 (`namespace:reference`). This repo's `PriceSpec.network` has only ever
been configured as `"base"` or `"base-sepolia"` (`apps/api/src/serve.mjs`'s `PRICE_NETWORK`
default is `"base"`; `scripts/live-x402-run.mjs`'s default is `"base-sepolia"`; no other value is
set anywhere in this repo). `checkEnvelopeAgainstPrice` and `buildChallenge` now go through a
`toCaip2`/`networksEqual` pair that maps exactly those two names to `eip155:8453`/`eip155:84532`
and passes through anything else (an already-CAIP-2 value, or an SVM network string) unchanged —
so a spec client's `eip155:84532` and this repo's own `base-sepolia` are recognized as the same
chain in either position. `facilitator-server.mjs`'s `checkChallengePrice` imports the same
`networksEqual` rather than re-implementing the comparison — see "Fixes from review" above for why
that specific line was the change's one real end-to-end gap.

### Header names AND encoding — the finding as it stood (corrected; see "Corrections from review")

> **SUPERSEDED 2026-09-13.** This section is the record of the divergence as it was found, in the
> tense it was written in. It is kept because the next section only makes sense against it. What
> the code does today is "Header encoding: closed 2026-09-13" below.


The core spec (`x402-specification-v2.md`, unnumbered "Document Scope" front matter at line 5,
**not** a numbered section; numbered `**1. Overview**` starts at line 30) puts transport mechanics
under "Representation" (`3.` in the Architecture list) and says transport-specific
implementations are covered elsewhere — it does **not** say header naming is out of scope for the
protocol as a whole; it delegates that question to the transport spec.

`gh api repos/coinbase/x402/contents/specs/transports-v2/http.md` (downloaded and read after
review; not part of the original three files pulled for this change) answers it directly. It
names all three headers explicitly and, critically, specifies their **encoding**:

| Header | Direction | Data format (`transports-v2/http.md:161-167`) |
|---|---|---|
| `PAYMENT-REQUIRED` | Server → Client | Base64-encoded `PaymentRequired` object |
| `PAYMENT-SIGNATURE` | Client → Server | Base64-encoded `PaymentPayload` object |
| `PAYMENT-RESPONSE` | Server → Client | Base64-encoded `SettlementResponse` object |

So this repo's header **names** happened to match the spec's transport convention exactly. The
**encoding** did not, on two of the three:

- `PAYMENT-SIGNATURE` (inbound): `decodeSignatureHeader` already base64-decoded — conformant.
- `PAYMENT-REQUIRED` (outbound, `x402.mjs`'s `gate()`): emitted `JSON.stringify(challenge)` — raw
  JSON, not base64.
- `PAYMENT-RESPONSE` (outbound, `gate()`): emitted `JSON.stringify({receiptId, nonce})` — raw JSON,
  and not a §5.3 `SettlementResponse` (`{success, transaction, network, payer, errorReason?}`)
  either.

**That was a real, second reason a spec-conformant client could not use this API**, independent of
the payload-shape fix the change this section was written for made. It was not fixed there; it is
fixed now — see the next section. At the time of writing, `grep -rn "payment-required"
--include=*.mjs packages/ scripts/ apps/`, excluding tests, found **five** non-test readers that
all parsed the header as raw JSON with no base64 decode:

> **SUPERSEDED 2026-09-13** — all five readers below were re-pointed by the change recorded in the
> next section, so the line numbers are the ones that were true when this was written and no
> longer resolve. The list is left standing because it is the evidence for the "six files" count
> that decided the work had to be one coordinated change.
>
> - `packages/agent-sdk/src/index.mjs:80` — `JSON.parse(res.headers.get('payment-required') ?? 'null')`
> - `scripts/live-x402-run.mjs:294` — reads the header, then `JSON.parse(challengeHeader)`
> - `scripts/live-x402-svm-run.mjs:137` — `JSON.parse(r.headers.get('payment-required'))`
> - `scripts/soak/api-client.mjs:53` — same pattern, with a body fallback
> - `apps/web/src/api-client.mjs:27-28`, inside `get`: `res.headers.get('payment-required')` then
>   `JSON.parse(challengeHeader)` — same pattern; `get`'s line 34 passes
>   `res.headers.get('payment-response')` to `finish`, whose line 40 does `JSON.parse(receipt)` the
>   same raw way (this is the browser client `apps/api/src/server.mjs`'s CORS comment calls "the
>   browser live mode")

An earlier version of this section said "three files" and "all four files" — undercounting by
missing the two above. Base64-encoding the header without updating all five simultaneously would
break every one of them, including the live-settlement flow `docs/X402-LIVE-REPORT.md` records.
Making both true at once needs a single coordinated change across **six files total** (this one
plus the five above), not a change inside `apps/api/src/x402.mjs` alone, and was recommended as its
own follow-up rather than attempted there.

### Header encoding: closed 2026-09-13 (issue #279)

That follow-up landed. The six files named above changed together, and the transport spec was
re-downloaded first rather than read out of this document:

```
gh api repos/coinbase/x402/contents/specs/transports-v2/http.md --jq .content | base64 -d
```

**What the server emits.** `gate()` base64-encodes `PAYMENT-REQUIRED` on all four of its 402
branches — no signature, locally-invalid envelope, replayed nonce, and refused settlement — through
one `require402` helper, so the four copies of the header line that made this easy to get wrong are
now one. `PAYMENT-RESPONSE` is base64 too, and is a §5.3.2 `SettlementResponse`:

| field | §5.3.2 | value |
|---|---|---|
| `success` | Required | `true` (this header is emitted only on a settled 200) |
| `transaction` | Required | the facilitator's settlement — a tx hash on both settling facilitators |
| `network` | Required | CAIP-2, via the same `toCaip2` the `accepts[]` entry uses |
| `payer` | Optional | the address that signed the authorization; omitted when there is none |
| `receiptId`, `nonce` | — | this repo's own names, kept (see below) |

**Why it is a superset and not a rename.** `scripts/live-x402-run.mjs` and
`scripts/live-x402-svm-run.mjs` both fail closed on `receipt.receiptId`, and neither can run inside
`npm run gate` — one needs a funded testnet account, the other a devnet. Dropping the key to make
the object a minimal `SettlementResponse` would have broken both silently. §5.3.2 lists Optional
fields and an `extensions` map and nowhere forbids additional ones, so the spec fields were added
and the two legacy keys left exactly where they were — the same "emit conformant, accept both"
move this document describes for the 402 body.

**What the readers do.** Each tries base64 and falls back to raw JSON, so a client of either
vintage works against a server of either vintage. The discriminator is total rather than a guess:
`{` is not in the base64 alphabet, so a value whose first non-space character is `{` is the legacy
raw JSON and everything else is base64. Sniffing the other way round would not work — Node's base64
decoder silently drops characters outside the alphabet instead of throwing, so a "try base64, catch,
fall back" reader never reaches its fallback. The four Node-side readers share one copy of that
decoder, `packages/agent-sdk/src/header-codec.mjs`; `apps/api/src/x402.mjs` and
`apps/web/src/api-client.mjs` carry their own, the first because the server must not depend on the
client SDK and the second because everything under `apps/web/src/` is loaded straight into a
browser, imports nothing outside that directory, and has no `Buffer`.

**Two things this did not do**, named rather than implied:

- A **failed** settlement still returns a 402 with no `PAYMENT-RESPONSE` header. The transport
  spec shows a `{success:false, errorReason, transaction:""}` body on that leg
  (`transports-v2/http.md:139-159`); this API does not emit it. A client learns the reason from
  the 402 body's `error` instead.
- `network` is CAIP-2 through `toCaip2`, which maps this repo's two Base short names and passes
  anything else through unchanged — so on the repo-specific SVM scheme the field is not CAIP-2.
  No `solana:` mapping was invented for it.

### Corrections from review

An earlier version of this section claimed "the spec is silent on header naming" and cited
"§1, Document Scope". Both were wrong, caught in review: Document Scope is unnumbered front
matter, not §1 (§1 is Overview); and the spec is not silent — the transport spec (above) defines
the header names and their encoding explicitly. The claim has been replaced with the verified
finding above.

## What this change does not do

- **No facilitator-client change.** `apps/api/src/facilitator.mjs`'s `createHttpFacilitator` still
  speaks this repo's own bespoke `{x402Version, challenge, envelope}` / `{ok, receiptId, reason}`
  wire format to a configured facilitator URL, not the spec's two-endpoint `POST /verify` /
  `POST /settle` API (§7.1/§7.2). That file was not in this change's file grant
  (`apps/api/src/x402.mjs`, `apps/api/test/`, and this document), and extending it is a separable
  piece of work on a different wire (outbound, facilitator-to-server) from the one this change
  covers (inbound, client-to-server).
- **No claim about any third-party facilitator.** This change was not tested against any live
  facilitator service. Nothing in this document should be read as a claim about what shape or
  version any specific third-party facilitator accepts — that was not verified here, and an
  unverified secondhand figure is exactly the failure mode this whole piece of work exists to
  correct (`docs/RESEARCH-SPRINT1.md:27-32`).
- **The SVM path is out of scope**, as noted above — it is a repo-specific scheme extension, not
  part of the downloaded v2 spec's exact/EVM scheme.

## Regression coverage

`apps/api/test/x402-v2-conformance.test.mjs` pins the shapes above field by field: the emitted 402
body and header (spec fields present, values correct, CAIP-2 network, `extra` populated only when
supplied), the spec-nested `PaymentPayload` decoding into the normalized flat shape end to end
through `gate()` **against a facilitator spy that genuinely calls `checkChallengePrice`** (not an
always-`ok` stub — see "Fixes from review"), a dedicated unit test on `checkChallengePrice` itself,
the legacy flat envelope still decoding byte-for-byte unchanged, and the CAIP-2/legacy network
equivalence in both directions. Every JSON literal in that file's spec-shape tests is transcribed
from the downloaded spec's own example JSON, not paraphrased.

The 2026-09-13 header-encoding change added three tests to that same file: `PAYMENT-REQUIRED` is
base64 on all four 402 branches (with the four distinct `error` strings asserted, so the test
cannot pass by reaching one branch four times), `PAYMENT-RESPONSE` decodes to the §5.3.2 fields
above, and `decodeHeaderJson` reads both encodings and rejects everything else. **Those assertions
deliberately do not go through `decodeHeaderJson`** — it accepts raw JSON by design, so a test
written through it would pass against the very defect it exists to catch. They decode base64
explicitly and assert the value is not raw JSON. `packages/agent-sdk/test/header-codec.test.mjs`
covers the shared reader directly, and `packages/agent-sdk/test/sdk.test.mjs` and
`apps/web/test/api-client.test.mjs` each pay once against base64 headers and once against the
legacy raw-JSON ones, which is what pins the backward compatibility.

18 tests in `x402-v2-conformance.test.mjs`, measured at this document's final head:

```
node --test --test-reporter=tap apps/api/test/x402-v2-conformance.test.mjs
# tests 18
# pass 18
# fail 0
```
