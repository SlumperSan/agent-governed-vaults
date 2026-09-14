# Revenue — the metered read, and the path to the first dollar

**What this file is.** The runbook for the one revenue mechanism this repository has actually built:
paid HTTP reads settled in USDC over x402. It records what is done, what is not, and the exact steps
only the owner can run. It is not a business plan and it does not forecast anything.

**Status: the rail is built and LIVE, and nobody has paid yet.** The route was deployed to the
`rwally` Cloudflare Pages project on 2026-09-13 and answers `402 Payment Required`; §5.6 records the
measurement. No mainnet payment has been taken and revenue to date is **$0.00**. Those two facts sit
together deliberately: a rail that answers 402 is plumbing, not a customer.

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
authoritative. `apps/site-next/test/x402-edge.test.mjs` fails if a balance-shaped field ever appears in
the snapshot, and fails if any vault field drifts from
`contracts/config/deployments/robinhood-mainnet.json`.

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

`apps/site-next/functions/api/vaults.js` is a Cloudflare Pages Function. It **imports** `gate` from
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
| The edge route refuses to serve unpaid | **Proven** — 23 tests in `apps/site-next/test/x402-edge.test.mjs` |
| The Worker bundle builds | **Proven** — `wrangler@4 pages functions build`, 2026-09-13 |
| The route is deployed and refuses unpaid requests in production | **Proven** — `rwally.com/api/vaults` answers 402, 2026-09-13 (§5.6) |
| A mainnet payment has settled | **No.** Settlement has never been exercised on mainnet. A 402 is the gate refusing; it says nothing about settlement |
| The headers are the encoding the transport spec requires | **Proven** — `PAYMENT-REQUIRED` is base64 live since #287, read back and decoded from the production host |
| A conformant third-party client can pay | **Not yet.** The encoding is fixed; `accepts[]` still carries no `extra`, so a client has no EIP-712 domain to sign against (#290) |
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

`FACILITATOR_URL` is now set to a facilitator that does speak the standard contract (§5.1), so the
route answers 402 rather than 500 — 500 is what a MISSING setting produces, not a non-working one.
The distinction matters for debugging: a `FACILITATOR_URL` that is present but points somewhere that
cannot answer `/verify` yields the `402 settlement failed: verify-http-404` above, at settlement
time, on a request that got all the way through the gate.

## 5. Deploying it, and the one step that is still the owner's

**5.1 through 5.4 are DONE.** They are kept because they are the procedure for the next deploy, and
because two of them carry traps that cost real time the first time. §5.6 records what was measured
afterwards. **5.5 — the first purchase — moves real funds and remains the owner's alone**, under
`docs/SWARM.md` §10.

**5.1 — Choose the payee and the facilitator.** An address you control on Base mainnet to receive
USDC, and the HTTPS URL of an x402 facilitator that settles on Base mainnet. Settled on 2026-09-13:
the payee is the address the owner supplied, and the facilitator is `https://facilitator.payai.network`,
which settles on Base mainnet and needs no API key.

**5.2 — Set the six settings, and set them as SECRETS, not as environment variables.** This is the
trap, and what follows is what was observed rather than a general account of how wrangler behaves.

**Measured on 2026-09-13.** All six environment variables read back from the Cloudflare API with
correct values at 16:41. `npx wrangler@4 pages deploy` was run. At 17:02 the same API read returned
`env_vars: []` for **both** production and preview. The deploy output never mentioned variables and
reported success. The live route then answered:

```
500 {"error":"route misconfigured","detail":"PRICE_AMOUNT is not set on this deployment"}
```

Fail-closed, so no vault data was served for free — but the route was down, and nothing in the deploy
said why.

The likely mechanism, stated as the inference it is: `apps/site-next/wrangler.toml` declares
`pages_build_output_dir`, which makes wrangler treat it as the project's configuration, and the file
has no `[vars]` section. That was not verified against wrangler's source or its documentation. What
IS verified is the before/after above, and that is enough to act on.

Upload them as secrets instead. The six were re-uploaded this way and survived the redeploy that
followed:

```bash
npx wrangler@4 pages secret bulk <path-to-json> --project-name rwally
```

The JSON is a flat `{"KEY": "value"}` object with these six keys. Write it outside the repository.
Secrets are expected to survive later deploys, because the configuration file carries no secrets for
wrangler to sync over them — but only one redeploy has been observed, so treat that as the working
assumption and re-read the settings after any deploy that changes `wrangler.toml`.
A Pages Function reads a secret through the same `env[KEY]` binding, so no code changes.

**Secrets bind at deployment time, not at read time.** Uploading them changes nothing until you
redeploy; the route kept answering the same 500 for four minutes until it was redeployed. Always:
upload, then redeploy, then probe.

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

**A preview deploy cannot be used to test the route.** `functions/_middleware.js` redirects every
hostname that is not literally `rwally.com`, so `https://<hash>.rwally.pages.dev/api/vaults` answers
`301` and never reaches the route; preview secrets are empty anyway. The 301 is still worth having as
a smoke test, because it proves the Functions bundle compiled and is executing — a deploy with no
Functions serves the SPA HTML instead. Real verification has to happen on the production host.

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

**5.5 — Make the first purchase.** Ten reads at $0.10 is the first dollar. **Not done.**

This is the step that moves real funds, and it is yours alone. Nothing in this repository will do it,
and no agent here should be asked to.

## 5.6 — What the deploy measured

Deployed 2026-09-13 from `apps/site-next` at `90e84991`, the squash of #267. Read back from the
production host, not from the deploy output:

`GET https://rwally.com/api/vaults` answers **402 Payment Required** with a `payment-required` header
carrying `scheme: exact`, `x402Version: 2`, `asset: 0x833589fC…A02913`, `amount: "100000"`, the payee,
flat `network: "base"`, and an `accepts[]` entry with `network: "eip155:8453"` and
`maxTimeoutSeconds: 300`. The body carries no vault data.

`GET https://rwally.com/.well-known/x402` answers **200**, free, quoting the same price.

The site itself was unchanged by the deploy: `/` and `/disclaimers` both answer 200 on the same
hashed entry bundle each — `index-Dswh-tMk.js` and `disclaimers-Bny7kgXy.js`, sharing
`main-CAxB7eBr.js` and `pageBody-CH-Y7cxl.js` — and the built page set matched the live sitemap
before the deploy was run.

**The header encoding is now conformant, and a conformant client still cannot pay.** Those are two
different things and #287 closed only the first. `PAYMENT-REQUIRED` is base64 as
`specs/transports-v2/http.md:161-167` requires — read back from the production host and decoded, not
inferred — which closed #279. What remains is the challenge's contents, tracked in #290 and measured
against PayAI rather than reasoned about: `accepts[]` carries no `extra`, and omitting it yields
`invalid_exact_evm_missing_eip712_domain`, so a third-party client has no EIP-712 domain to sign
against and cannot produce a valid signature at all. Two smaller gaps sit beside it, both still true
of the live challenge at the time of writing: `extensions` is `{}`, and `resource.url` is `""` — the
latter being the key a Bazaar catalogues a resource under, and §6.1 records why that matters.
Settlement itself has never been exercised on mainnet — the 402 proves the gate refuses unpaid
requests, and proves nothing whatever about settlement.

## 6. Phase 2 — demand

Phase 1 proves the rail with a controlled purchase. It does not prove demand, and it must not be
described as though it did: a payment you make to yourself is a working payment rail, not a customer.

The distribution hook already exists and is free to call: `/.well-known/x402` is the discovery
document an agent reads to learn what this endpoint sells and what it costs, without paying to find
out. Phase 2 is listing it where x402 clients look, publishing an integration snippet, and making the
payload worth more than its price — which most likely means the live chain read described in §1.
