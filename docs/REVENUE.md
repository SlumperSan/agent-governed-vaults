# Revenue — the metered read, and the path to the first dollar

**What this file is.** The runbook for the one revenue mechanism this repository has actually built:
paid HTTP reads settled in USDC over x402. It records what is done, what is not, and the exact steps
only the owner can run. It is not a business plan and it does not forecast anything.

**Status: the rail is published. The live read described below is not.** Measured 2026-09-13:
`https://rwally.com/api/vaults` answers `402` with a spec-shaped `PAYMENT-REQUIRED` challenge, and
`https://rwally.com/.well-known/x402` answers `200` for free — so §5.1 through §5.3 have been run.
What is serving there is the **pinned-snapshot** route (the live discovery document reports
`"live": false, "asOf": "2026-09-13"`), the version landed as 90e84991. The request-time chain read
this document describes from §1 onward is landed in the repository and has **not** been deployed;
deploying it is a re-run of §5.3. No mainnet payment has been taken — the payee's USDC balance on
Base mainnet reads `0` (`cast call balanceOf`, 2026-09-13) — and revenue to date is **$0.00**.

---

## 1. What is being sold

`GET /api/vaults` on `rwally.com` reads Robinhood Chain mainnet (4663) **at request time** and
returns, per vault: total shares, idle USDC, pending USDC, NAV and NAV-per-share, capacity cap and
headroom, minimum deposit, basket length, child vault count, lock state and creator. Two vaults
today. This used to be a pinned JSON snapshot restating creation-time facts only; it is not any
more — see the history below.

**The data chain and the payment chain are different, deliberately.** The data describes chain 4663.
Payment settles in USDC on **Base mainnet** (8453). x402 metering is an API concern that touches no
contract on either chain — `contracts/config/base-mainnet.json`'s `x402.unaffectedNote` records that
no Solidity in this repository reads the switch.

**It is a live chain read, not a pinned snapshot**, and every response says so in `live: true` and
carries `blockNumber` — the height every field in that response was read at. There is no fixed
`asOf` to quote any more, because there is nothing pinned left to date.

**A field can be absent instead of a number, and that is not the same as zero.** Two distinct
reasons, both tested in `apps/site-next/test/x402-edge.test.mjs`: `pricingFrozen: true` means the
oracle itself reverted the NAV read (`StaleOracle`) — a real product signal, not missing data; a
field named under `unreadable` means this deployment could not read it this request — a transport
failure, a revert the route does not recognise, or a local decode defect (`kind: 'decode'`, e.g. an
address that failed to checksum) — missing evidence, and never presented as a value. A revert and
a transport failure are kept structurally distinct on purpose: this repository
has twice shipped a defect where the two collapsed into one field (issues #266, PR #185), so a test
drives a reader whose every read fails as a transport error and asserts no vault ever reports
`pricingFrozen` from that.

This shipped as a live read on top of #267's pinned-snapshot version, which said explicitly that a
chain read per request was the honest next step and not what shipped at the time. It is now.

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

`apps/site-next/functions/api/vaults.js` is a Cloudflare Pages Function. It does **not** call
`x402.mjs`'s `gate()` any more — it did while the route served a pinned snapshot, but the live read
needs the chain read wedged in BETWEEN the local envelope check and the facilitator call (so a
caller who has not paid, or whose envelope is locally invalid, never costs this deployment an RPC
call, and a chain read that fails costs the caller nothing rather than being billed anyway), and
`gate()` settles as soon as the local check passes, with no seam at that point. So this route
imports `gate()`'s pieces instead — `decodeSignatureHeader`, `checkEnvelopeAgainstPrice`,
`challengeResponse`, `nonceOf` from `apps/api/src/x402.mjs`, and `createStandardHttpFacilitator`
from `apps/api/src/facilitator.mjs` (why that one and not the bespoke `createHttpFacilitator` is
below, under "This deployment cannot hold a private key") — and composes them in that order,
rather than reimplementing any of them. `challengeResponse` and
`nonceOf` are used INSIDE `gate()` itself too (not duplicated beside it), so the edge route and
`gate()` still share one implementation of the 402 shape and the nonce-selection logic; only the
ORDER in which the pieces run differs between the two callers.

The route's chain read reuses `packages/canary/src/reader.mjs`'s `createChainReader`, the same
component the canary uses to tell a genuine on-chain revert apart from a transport failure — this
repository has shipped that exact confusion twice (issues #266, PR #185), so the read path at the
edge reuses the tested classifier rather than re-deriving it.

The build inlines all of it. Measured 2026-09-13: `wrangler@4 pages functions build` reports
"Compiled Worker successfully" and emits a bundle of 439,370 bytes minified (135,684 bytes gzip) —
up substantially from the pinned-snapshot version's 31 KB, because this route now statically pulls
in viem via `apps/site-next/functions/api/_vaultread.js` (`reader.mjs` itself still lazy-imports
viem; the static import that pulls it into this bundle is in `_vaultread.js`, for `getAddress`).
Still well inside Cloudflare Workers' size limits (3 MB free / 10 MB paid, both compressed).

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
set, and neither `gate` (when `apps/api` calls it directly) nor this route's own composition of
`gate`'s pieces is given one here: an edge Worker has no shared memory between
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
| The edge route refuses to serve unpaid, makes no RPC call while refusing, and never echoes `FACILITATOR_URL` | **Proven** — 44 tests in `apps/site-next/test/x402-edge.test.mjs`. "No RPC call" covers the chain BINDING too, not only the reads: the reader that every unpaid-path test injects throws if `assertBoundToDeclaredChain` is called at all, so an `eth_chainId` round trip before the envelope clears locally would fail the suite. |
| The route settles through a facilitator that speaks the standard wire protocol, not the repo's bespoke shape | **Proven** — wired to `createStandardHttpFacilitator`, not `createHttpFacilitator`; `FACILITATOR_NETWORK` (CAIP-2) is required and independently rejects six malformed shapes, and a test asserts it is allowed to differ from `PRICE_NETWORK` |
| The live read's values are correct | **Proven against a live RPC read**, reproduced independently in review — NOT cross-checked against `contracts/config/deployments/robinhood-mainnet.json`, which records only `address`, `creator`, `minDepositUsdc` and `capacityCapUsdc` per vault (grep it: no `navWad`, `navPerShareWad`, `totalShares`, `usdcScalar`, `totalPendingUsdc`, or `childVaultCount` key exists there). Those four fields DO match the record. `capacityHeadroomUsdc` is derived at request time from live inputs and checks arithmetically against them, not against any recorded value. |
| The read is OF the chain the response names | **Proven** — `vaults.js` awaits `reader.assertBoundToDeclaredChain()` before a single address is read, so `chainId: 4663` in a paid 200 is a checked fact rather than a declared one (issue #204). Without it, `createChainReader({rpcUrl, chainId})` asserts the declared id ONTO whatever URL it was given. "A wrong RPC would just fail the reads" is **false**: the same deployer running the same script on another Robinhood chain yields identical CREATE addresses holding different state. Both refusal shapes — a mismatched id and an unreadable one — are tested, and the tests go red if the call is deleted **or** moved after the read. |
| A revert (oracle freeze) and a transport failure never collapse into one field | **Proven** — tested against an injected reader whose every read fails as a transport error: no vault ever reports `pricingFrozen`, matching the requirement drawn from issues #266 and PR #185 |
| A chain read that fails costs the caller nothing | **Proven for three distinct failure shapes**: the RPC does not answer for chain 4663; the chain cannot report a block number at all; and a block number comes back but every field of every vault fails to read (a bad RPC that answers `eth_blockNumber` and fails everything after). All three are 503 with the facilitator never called. A read where at least one field of at least one vault succeeds still settles — a partial read is still a read. |
| The Worker bundle builds | **Proven** — `wrangler@4 pages functions build`, 2026-09-13, "Compiled Worker successfully"; `wrangler@3` also builds it, re-measured |
| The live read is what `rwally.com` serves today | **No.** The route is deployed and answering `402`, but the deployed build is the pinned-snapshot one — the live discovery document reports `"live": false` (measured 2026-09-13). Deploying this change is §5.3 |
| A mainnet payment has settled | **No.** The payee's USDC balance on Base mainnet reads `0` (`cast call balanceOf`, 2026-09-13) |
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

**5.1 through 5.3 have already been run once**, for the pinned-snapshot route: `rwally.com` answers
`402` on the paid route and `200` on the discovery document today. They are kept here in full because
5.3 is exactly what puts the live chain read above in front of callers, and because 5.2's variables
are what a redeploy must not lose. **5.4 and 5.5 have not been run.**

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
build with the retired one. Caught in review before any deploy; the retired site was never
published, and what `rwally.com` serves today is `apps/site-next` — its Functions are what answer
`/api/vaults` with a `402` rather than the site's HTML.

The `wrangler@4` above is not a requirement any more — see `apps/site-next/wrangler.toml`'s own
comment for why. It used to be: the pinned-snapshot version of this route imported a JSON file with
an attribute wrangler 3's esbuild could not parse. That file is gone, and `wrangler@3 pages
functions build` was re-measured 2026-09-13 against the live-read route and also reports "Compiled
Worker successfully". `@4` is kept in the command above because nothing here has re-tested every
other Pages feature this deployment uses against wrangler 3 — it is the version this whole runbook
has been proven against, not a hard requirement of this one route.

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
out. Phase 2 is listing it where x402 clients look and publishing an integration snippet — the
payload itself (§1) is now the live chain read that used to be named here as the thing that would
make it worth more than its price; what would make it worth more again is not yet decided.
