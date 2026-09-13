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
`gate()`, and the facilitator modules `gate()` hands the decoded envelope to — ever sees it. Those
downstream files (`apps/api/src/facilitator.mjs`, `apps/api/src/facilitator-server.mjs`) were not
in this change's file grant and were not edited; normalizing inside the decoder means they receive
the same flat shape they always have, regardless of which shape the client sent.

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
chain in either position.

### `PAYMENT-REQUIRED` as a response header

This repo's `PAYMENT-REQUIRED` response header, and the `PAYMENT-SIGNATURE` request header, are
this repo's own transport-layer convention. The downloaded v2 specification (§7, Facilitator
Interface, and its Implementation Notes) does not define HTTP request/response headers for the
resource-server-to-client leg at all — it defines JSON body shapes and leaves the transport
mapping to "transport-specific implementations" (§1, Document Scope: "Transport-specific
implementations" are explicitly out of this spec's scope). So no claim is made that headers named
`PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE` are itself a spec deviation or
compliance; the spec is silent on header naming, and this repo's choice is not addressed by it
either way.

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
through `gate()`, the legacy flat envelope still decoding byte-for-byte unchanged, and the
CAIP-2/legacy network equivalence in both directions. Every JSON literal in that file's spec-shape
tests is transcribed from the downloaded spec's own example JSON, not paraphrased.
