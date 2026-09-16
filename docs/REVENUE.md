# Revenue — HISTORICAL / SUPERSEDED

> **This document is historical and the code it describes is gone from this repository — but the
> rail it documents is still answering in production.** As of 2026-09-16,
> `GET https://rwally.com/api/vaults` returns **402** with a `PAYMENT-REQUIRED` challenge and
> `GET https://rwally.com/.well-known/x402` returns **200**, because the Cloudflare Pages project
> has not been redeployed since the removal. The next deploy of `apps/site-next` removes both. The
> Base-mainnet-settlement paid-snapshot rail it documents (`apps/site-next/functions/api/vaults.js`,
> `apps/site-next/functions/.well-known/x402.js`, and their supporting `_price.js`/`_snapshot.json`)
> was **removed on 2026-09-15** because it duplicated and conflicted with `apps/api`'s own x402 rail:
> it settled payment in USDC on Base mainnet (chain 8453) while the data it sold described
> Robinhood Chain (4663), and the current direction is Robinhood Chain as the only externally
> marketed live chain, with `apps/api` as the one canonical paid API
> (see [PR #294](https://github.com/SlumperSan/agent-governed-vaults/pull/294), which re-enables
> x402 metering on chain 4663 for `apps/api`, and [PR #295](https://github.com/SlumperSan/agent-governed-vaults/pull/295),
> which first flagged this conflict in the README's Production Map).
>
> Revenue plans and the metered-read runbook now live solely in `apps/api`'s own docs
> (`docs/DEPLOYMENT.md` §6, `docs/RUNTIME.md`) — this file is kept only so the rationale for the
> earlier Base-settlement design, and why it was retired, is not lost.
>
> Everything below this line is the runbook for the removed rail, and it describes code that no
> longer exists in this repository. **Read it as history, not as instructions.** It is no longer
> unedited: sentences that made a present-tense claim about the removed code, or that asserted
> nothing had been deployed, have been corrected where a reader could have acted on them. The
> design reasoning is otherwise untouched, which is the whole reason the file is kept.

---

# Revenue — the metered read, and the path to the first dollar

**What this file is.** The runbook for the one revenue mechanism this repository has actually built:
paid HTTP reads settled in USDC over x402. It records what is done, what is not, and the exact steps
only the owner can run. It is not a business plan and it does not forecast anything.

**Status: the rail described below is deployed and earning nothing.** Every step up to "What the
owner runs" is landed and tested, and the endpoint is answering in production — see the banner at the
top of this file. Its source was removed from this repository by PR #298. **No mainnet payment has
ever been taken and revenue to date is $0.00**: a 402 is the gate refusing, and says nothing about
settlement.

> **The owner resolved this by removing the endpoint (PR #298).** The plan below settles payment in
> USDC on Base mainnet (8453) while the data it sells describes Robinhood Chain (4663). `apps/api`
> is the one paid API going forward, and it meters on chain 4663. See the Production Map in
> `README.md`.

---

## 1. What is being sold

`GET /api/vaults` on `rwally.com` returns creation-time facts for every Agent-Governed Vault on
Robinhood Chain mainnet (4663): address, creator, creation block and time, minimum deposit,
capacity cap, runtime codesize. Two vaults today.

**The data chain and the payment chain are different, deliberately.** The data describes chain 4663.
Payment settles in USDC on **Base mainnet** (8453). x402 metering is an API concern that touches no
contract on either chain — `contracts/config/base-mainnet.json`'s `x402.unaffectedNote` records that
no Solidity in this repository reads the switch.

**It is a pinned snapshot, not a live chain read**, and every response says so in `live: false` and
`asOf`. Balances, NAV, share supply and member positions are deliberately absent: they move block to
block, and a pinned file carrying them would be wrong within minutes while still looking
authoritative. Both properties were enforced by `apps/site-next/test/x402-edge.test.mjs` — it failed
if a balance-shaped field ever appeared in the snapshot, and failed if any vault field drifted from
`contracts/config/deployments/robinhood-mainnet.json`. PR #298 deleted that file along with the
route, so nothing in this repository enforces either property any more.

Serving live balances means a chain read per request at the edge. That is the honest next step and
it is **not** what ships today.

## 2. Price

**$0.10 per read** — `PRICE_AMOUNT=100000`, USDC being 6-decimal.

Ten calls to the first dollar. High enough that a handful of real requests is meaningful revenue,
low enough not to deter a trial. The Sepolia proving run used $0.01; $1.00 per read would reach a
dollar in one call but sits far above a plausible metered-analytics price and would deter the
external traffic that is the point of phase 2.

The price is set in **one place** — the Pages project's environment — and both the paid route and the
free discovery document resolve it from there. A test asserts the discovery document cannot quote a
price the gate will not charge, because `apps/api/src/server.mjs` requires that discovery be "told
the truth rather than quoted a price it will never be charged".

## 3. How it is served, and why `FACILITATOR=standard` holds no key

Of the four selectable modes, `FACILITATOR=stub`, `FACILITATOR=http` and `FACILITATOR=standard`
hold no key; `FACILITATOR=svm` DOES, because Solana's flow makes that process the fee payer and
it loads `SVM_KEYPAIR`. This route is EVM-only and uses `standard`.

`apps/site-next/functions/api/vaults.js` was a Cloudflare Pages Function. It **imported** `gate` from
`apps/api/src/x402.mjs` and `createStandardHttpFacilitator` from `apps/api/src/facilitator.mjs` rather than
reimplementing the 402 handshake. Two implementations of one payment protocol drift, and the half
that drifts at the edge is the half deciding whether a caller's USDC bought anything. The build
inlines the real module: a `wrangler@4 pages functions build` on 2026-09-13 emitted a 31 KB bundle
containing `gate`, `verifyAndSettle` and the Base USDC constant.

**This deployment cannot hold a private key.** `apps/api` has **four** selectable facilitator modes --
`facilitatorFromConfig` builds `stub`, `http`, `standard` and `svm` -- and exactly one of those holds
a key: `svm`, where Solana's flow makes the server the fee payer and there is nothing to delegate.
This route uses **`createStandardHttpFacilitator`**, the `standard` client: it POSTs spec-shaped
bodies to `{FACILITATOR_URL}/verify` and then `/settle` and reads back a receipt, using nothing but
`fetch`.

It deliberately does **not** use `createHttpFacilitator`, and that distinction is the difference
between taking money and not. That client speaks this repository's own bespoke single-POST shape,
which only `apps/api/src/facilitator-server.mjs` implements -- **no public facilitator speaks it**.
This route was wired to it until review round 6, which means following §5 with a real facilitator URL
would have 402'd every payment on a transport error. No key material appears in any of these files.

**It fails closed.** Each of the six settings is refused rather than defaulted; a deployment missing
any one answers 500, never the paid body for free. There is a test per setting, because a default
`PRICE_PAYTO` would silently send a caller's USDC to whatever address the default named.

**Replay protection on this route is the chain's, not the edge's.** `gate` accepts a `seenNonces`
set, and this route deliberately does not pass one: an edge Worker has no shared memory between
isolates or colos, so an in-memory set would cover only the isolate that served the first request
while reading like protection. EIP-3009 authorizations are single-use by nonce and the token
contract rejects a reused one — the property the Sepolia run verified when a resubmitted envelope
came back `authorization-used` (`docs/X402-LIVE-REPORT.md`). A replayed envelope therefore fails at
settlement and never reaches the body — conditional, like every other settlement outcome here, on
the configured facilitator behaving. This route trusts the facilitator's verdict and performs no
local corroboration of it; `docs/REVENUE.md` names that dependency in §4 deliberately.

## 4. What is proven, and what is not

| | |
|---|---|
| The 402 handshake settles real USDC | **Proven** — Base **Sepolia**, 2026-08-24, $0.01, 14/14 independent on-chain checks (`docs/X402-LIVE-REPORT.md`) |
| Replay is refused by the chain | **Proven** on that run — `authorization-used` |
| The edge route refuses to serve unpaid | **Was proven** — 23 tests in `apps/site-next/test/x402-edge.test.mjs`, which PR #298 deleted along with the route. The deployed route still refuses: it answers 402 in production. Nothing in this repository tests it any more. |
| The Worker bundle builds | **Proven** — `wrangler@4 pages functions build`, 2026-09-13 |
| A mainnet payment has settled | **No.** The route is deployed and answering 402; settlement has never been exercised on mainnet, and a 402 is the gate refusing |
| Anyone has paid anything | **No.** Revenue is $0.00 |

**The one dependency outside this repository is the facilitator.** Settling `transferWithAuthorization`
on Base mainnet costs gas, so somebody's funded key must broadcast it. This route delegates that over
HTTPS to `FACILITATOR_URL`. Which facilitator to point at is an owner decision and is **not** made
here. There are **two** real arrangements, and this paragraph has now been wrong three times: an
early version invented a `FACILITATOR=svm`-style EVM mode that did not exist; its replacement said
flatly that **no** `FACILITATOR` value settles on an EVM chain, which #272 falsified by adding one;
and its replacement counted **three** options by listing one arrangement twice.

**1. A third-party facilitator that speaks the standard wire contract**, reached over HTTPS. This is
what `FACILITATOR_URL` takes, and the only arrangement usable today. `createStandardHttpFacilitator`
POSTs `{FACILITATOR_URL}/verify` and then `/settle`. (`FACILITATOR=standard` is the `apps/api` server
mode built on the same client; it is not itself a second option, and this edge route has no
`FACILITATOR` setting at all — `vaults.js` constructs the standard client directly.)

**2. Run your own settler** — `createSettlingFacilitator`, which its own definition in
`apps/api/src/facilitator.mjs` records as not wired into the API server and intended to run as a
separate process, which is how the Sepolia run did it.

**Arrangement 2 does not work today and §3 above already says why.** Its only HTTP wrapper in this
repository is `apps/api/src/facilitator-server.mjs`, which speaks the BESPOKE single-POST shape:
`facilitator-server.mjs:195-196` routes `/` and `/settle` and returns
`404 {ok:false, reason:'not-found'}` for anything else. The standard client asks for `/verify`
first, so pointing `FACILITATOR_URL` at it yields, measured:

```
402  settlement failed: verify-http-404: not-found
```

Every payment, forever. Choosing it needs a spec-shaped `/verify` + `/settle` wrapper that this
repository does not have yet. Listing it as an available option was the same harm review round 6
rejected — the runbook naming a facilitator the route cannot talk to — with the direction reversed.

Until a working `FACILITATOR_URL` exists, the route answers 500 by design rather than serving reads
for free.

## 5. What the owner runs

Everything above is landed. These are the steps an agent cannot take — they need the Cloudflare
account, the payee address, and real funds. `docs/SWARM.md` §10 puts all three out of bounds.

**5.1 — Choose the payee and the facilitator.** An address you control on Base mainnet to receive
USDC, and the HTTPS URL of an x402 facilitator that settles on Base mainnet.

**5.2 — Set the six variables** on the Pages project (Settings → Environment variables →
Production), then redeploy so they take effect:

```
PRICE_ASSET      0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
PRICE_PAYTO      <your Base mainnet address>
PRICE_AMOUNT     100000
PRICE_NETWORK    base
FACILITATOR_URL  <https base URL of a facilitator that settles on Base mainnet>
FACILITATOR_NETWORK  eip155:8453
```

`PRICE_ASSET` is Circle-native USDC on Base. It is **not** USDbC (`0xd9aAEc86…10b6CA`, read back as `symbol() == "USDbC"` on Base mainnet), the bridged legacy
token; getting that wrong prices the route against the wrong dollar.

**5.3 — Publish the site with Functions.** Run from **`apps/site-next`**, and deploy its build
output, because Pages bundles Functions from `./functions` relative to the working directory rather
than from inside the uploaded folder:

```bash
npx wrangler@4 pages deploy dist --project-name rwally --branch protocol/main
```

Build `dist/` first by this directory's own build step.

**An earlier version of this runbook said to run `wrangler pages deploy .` from `apps/site`, and
that would have taken the live site down.** `apps/site` is the RETIRED nine-page static site;
`rwally.com` serves `apps/site-next` (`apps/site-next/README.md:4`, and the live origin returns
`<script type="module" crossorigin src="/assets/index-*.js">` while `apps/site/index.html` carries
zero `<script>` tags). Deploying `apps/site` to the `rwally` project would have replaced the live
build with the retired one. Caught in review before any deploy; nothing was published.

Wrangler **4 or newer**: wrangler 3's esbuild cannot parse the JSON import attribute that Node
requires, and fails the build.

**5.4 — Confirm the gate is live before paying anything.** Discovery is free, so this costs nothing:

```bash
curl -s https://rwally.com/.well-known/x402
```

Then confirm the paid route refuses to serve unpaid — this must be `402`, and must **not** contain
vault data:

```bash
curl -s -i https://rwally.com/api/vaults
```

If either returns 500, a variable from 5.2 is missing; the body names which one.

**5.5 — Make the first purchase.** Ten reads at $0.10 is the first dollar.

This is the step that moves real funds, and it is yours alone. Nothing in this repository will do it,
and no agent here should be asked to.

## 6. Phase 2 — demand

Phase 1 proves the rail with a controlled purchase. It does not prove demand, and it must not be
described as though it did: a payment you make to yourself is a working payment rail, not a customer.

The distribution hook already exists and is free to call: `/.well-known/x402` is the discovery
document an agent reads to learn what this endpoint sells and what it costs, without paying to find
out. Phase 2 is listing it where x402 clients look, publishing an integration snippet, and making the
payload worth more than its price — which most likely means the live chain read described in §1.

### 6.1 — How a seller gets listed in a Bazaar, measured 2026-09-13

**A registration mechanism exists, and it is not a form.** A resource is cataloged as a side effect
of a payment that settles through a facilitator implementing the `bazaar` extension. There is no
submission endpoint, no account, no API key and no terms to accept. There is also no way to be
listed before somebody has paid, which reverses the ordering §6 above implies: listing is not a
prerequisite for the first sale, it is a consequence of it.

Every figure in this section was taken by direct request on 2026-09-13. Nothing here was settled,
signed, or paid for.

| Probe | Result |
|---|---|
| `OPTIONS https://facilitator.payai.network/discovery/resources` | `200`, `Allow: GET, HEAD` |
| `POST` that same path | `404` `application/problem+json` — `"No resource is served at POST /discovery/resources."` |
| `OPTIONS` and `POST https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` | `405` for both; `Allow: GET` |
| `GET https://facilitator.payai.network/openapi.json` | `PayAI x402 Facilitator API 2.0.0`, 8 paths; every discovery path is `GET` only |
| `GET https://facilitator.payai.network/supported` → `extensions` | `["bazaar","eip2612GasSponsoring","erc20ApprovalGasSponsoring"]` |
| Full pagination of the PayAI catalog | `pagination.total` **28603**, **1892** distinct resource host segments, **zero** `rwally.com` entries |

`GET /discovery/stats` separately reported `resources: 28593` alongside `catalogEntries: 28603` the
same day. Those are two different counts of two different things; quoting either as "the size of the
bazaar" conflates them. The 1892 is a count of host segments taken from each `resource` string, and
some catalog entries carry a bare address rather than a URL, which counts whole — so read it as the
shape of the catalog, not as a census of domains. The zero is exact: it is a substring scan for
`rwally` across every `resource` value in all 28603 entries. All three numbers are a reading of a
live index taken at one moment, and the totals move within hours — re-run the pagination rather than
quoting these back later. The zero is the figure worth re-checking, and the only one that would mean
something had changed.

**Neither bazaar exposes a write verb.** The v2 specification does not document one either:
`specs/x402-specification-v2.md` §8 covers the read side only — `GET /discovery/resources`, the
discovered-resource field table, the Bazaar concept, and two example queries — and is silent on how
a resource arrives in the list. The seller side is documented in the x402 repository instead, at
`docs/extensions/bazaar.mdx`. Asked how to get a service listed, its FAQ answers that you add the
bazaar extension to your route configuration, and records that listing itself is free.

**The mechanism, in the order it happens.**

1. The resource server puts a `bazaar` entry in the `extensions` map of its 402 `PaymentRequired`
   body: an `info` object carrying the discovery data, plus a JSON Schema that validates it. The
   SDKs build it — `declareDiscoveryExtension` in TypeScript, `DeclareDiscoveryExtension` in Go.
2. The client copies `extensions` out of the challenge into its `PaymentPayload`.
3. The facilitator, processing that payment, reads `PaymentPayload.extensions[bazaar]` together with
   `PaymentPayload.resource`, and catalogs the resource. `go/extensions/bazaar/doc.go` describes
   this path; the extraction entry point is
   `ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, requirementsBytes, validate)`.
4. The facilitator may report the outcome in an `EXTENSION-RESPONSES` response header — base64 JSON
   whose `bazaar.status` is `success`, `processing` or `rejected`.

That entries really arrive this way, rather than by submission, has a tell in the live data: the
`/discovery/stats` top-merchant list includes `http://localhost:4021/api/pay-service`. Port 4021 is
what `examples/go/servers/bazaar` binds. No indexer can fetch a `localhost` URL, so that entry can
only have come from payment traffic — and nothing checked the resource was publicly reachable.

Which catalog a listing lands in is decided by `FACILITATOR_URL` (§5.2): it is the catalog of
whichever facilitator processes the payment. PayAI advertises `bazaar` in `/supported`, so a payment
settled there is a candidate for its catalog; Coinbase's bazaar would matter only if the owner
pointed `FACILITATOR_URL` elsewhere.

**How far a third-party client gets today.** Four `POST /verify` probes against
`https://facilitator.payai.network`, all carrying deliberately invalid payment material — an all-`f`
signature and the zero address as payer — so that nothing could settle:

| Request | HTTP | `invalidReason` |
|---|---|---|
| `network` flat `"base"` | 400 | `unsupported_x402_version` — `"x402Version 2 requires CAIP-2 network format, got 'base'"` |
| `network` `"eip155:1"` | 400 | `invalid_network` — `"Unsupported network: eip155:1"` |
| This route's terms on `eip155:8453`, with `extra` supplied | **200** | `invalid_exact_evm_signature` |
| The same, with `extra` omitted as the live route omits it | 200 | `invalid_exact_evm_missing_eip712_domain` |

Read the third row narrowly. It establishes that this route's price terms — asset
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `amount` `100000`, `payTo`, `maxTimeoutSeconds` 300,
`network` `eip155:8453` — parse and are accepted by PayAI's verifier, leaving it nothing to object
to but the signature that was invalid on purpose. It does **not** establish that a client can reach
that state from the challenge this route emits, because the request body that reached it was
assembled by hand. Two intermediate failures are worth recording, since each cost a round trip:
`paymentPayload.resource` must be an object and a sibling `accepted` is required, or the answer is
`invalid_payload`; and v2 requirements must carry `amount` **without** `maxAmountRequired`, or the
answer is `invalid_payment_requirements`. All of this is evidence about parsing. None of it is
evidence about settlement, which needs real funds and was not attempted.

**The transport defect that used to head this list is fixed.** When this section was first written
it opened on a fourth gap: `PAYMENT-REQUIRED` was emitted as raw JSON where
`specs/transports-v2/http.md` requires base64, so a strictly conformant client decoded garbage and
could not form a payment at all — and since cataloging fires on a payment, that kept the route out
of every bazaar. #287 landed the base64 encoding and closed issue #279 two hours later the same day.
Verify it rather than trusting this paragraph; the header decodes, and the decode is the check:

```bash
curl -s -D - -o /dev/null https://rwally.com/api/vaults | sed -n 's/^payment-required: //p' | tr -d '\r' | base64 -d
```

That leaves **three** gaps between a paid request and a listing, all of them recorded in #290. They
are no longer queued behind a transport fix: they are now the only thing standing between a settled
payment and a catalog entry.

1. **The challenge carries no bazaar extension.** `apps/api/src/x402.mjs:234` emits `extensions: {}`,
   with a comment recording that none are implemented. A payment could settle in full and catalog
   nothing, because step 1 of the mechanism above never happened.
2. **The catalog key would be empty.** The decoded challenge carries `"resource":{"url":""}`;
   `apps/api/src/x402.mjs:215-216` defaults `resource.url` to the empty string when the call site
   supplies no resource, and the edge route supplies none. `PaymentPayload.resource` is what the
   facilitator catalogs the entry under.
3. **The `accepts[]` entry carries no `extra`.** `apps/api/src/x402.mjs:231` includes `extra` only
   when the caller supplies `price.extra`, and the decoded challenge shows none. Measured above:
   with `extra` omitted, PayAI answers `invalid_exact_evm_missing_eip712_domain`. A client that does
   not independently read the USDC EIP-712 domain off the token has nothing to sign against, and
   that domain differs between chains, so guessing it is not safe —
   `apps/api/src/facilitator.mjs:374`'s `readUsdcDomain` already documents reading it rather than
   assuming it.

All three live in `apps/api/src/x402.mjs`. None were edited here, and #290 records them so they are
not rediscovered.

**A note for whoever edits this section next.** The paragraph above went stale in hours, and no
guard here could have caught it. `doc-claims` resolves the `file:line` citations in this list and
checks claims that a numbered **pull request** is still open, reading merge state from `(#N)` in
squash subjects on `protocol/main`. #279 is an **issue**, closed by PR #287, so
`git log --format=%s origin/protocol/main | grep -c '(#279)'` returns 0 and the guard has nothing to
match. Issue-state claims are invisible to it in a way PR-state claims are not. Re-check them by
hand, or state them so a command in the text settles the question — which is why the `curl` above is
there rather than a sentence asserting the same thing.

**What the owner would have to do.** Registration asks nothing of the owner directly — no signup, no
credentials, no agreement to accept. What it needs is §5.2's variables set, the three gaps above
closed, and §5.5's first purchase settled through a facilitator that advertises `bazaar`. The
listing follows from that payment. Until then the honest position is that `rwally.com` appears in no
bazaar — which the catalog scan above confirms directly, rather than by inference.
