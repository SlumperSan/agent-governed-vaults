# Revenue — the metered read, and the path to the first dollar

**What this file is.** The runbook for the one revenue mechanism this repository has actually built:
paid HTTP reads settled in USDC over x402. It records what is done, what is not, and the exact steps
only the owner can run. It is not a business plan and it does not forecast anything.

**Status: the rail is built and unpublished.** Every step below up to "What the owner runs" is
landed and tested. Nothing has been deployed, no mainnet payment has been taken, and revenue to date
is **$0.00**.

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

## 3. How it is served, and why `FACILITATOR=http` holds no key

`apps/site-next/functions/api/vaults.js` is a Cloudflare Pages Function. It **imports** `gate` from
`apps/api/src/x402.mjs` and `createHttpFacilitator` from `apps/api/src/facilitator.mjs` rather than
reimplementing the 402 handshake. Two implementations of one payment protocol drift, and the half
that drifts at the edge is the half deciding whether a caller's USDC bought anything. The build
inlines the real module: a `wrangler@4 pages functions build` on 2026-09-13 emitted a 31 KB bundle
containing `gate`, `verifyAndSettle` and the Base USDC constant.

**This deployment cannot hold a private key.** `apps/api` has three SELECTABLE facilitator modes --
`facilitatorFromConfig` builds exactly `stub`, `http` and `svm` -- and exactly one of those holds a key — `svm`, where Solana's flow makes the server the fee payer and there is nothing to
delegate. This route hard-wires the `http` mode: it POSTs a signed envelope to `FACILITATOR_URL` and
reads back a receipt, using nothing but `fetch`. Grep `apps/site-next/functions/` for `KEYPAIR`,
`PRIVATE_KEY` or `signer` and the result is empty.

**It fails closed.** Each of the five settings is refused rather than defaulted; a deployment missing
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
| The edge route refuses to serve unpaid | **Proven** — 18 tests in `apps/site-next/test/x402-edge.test.mjs` |
| The Worker bundle builds | **Proven** — `wrangler@4 pages functions build`, 2026-09-13 |
| A mainnet payment has settled | **No.** Nothing has been deployed |
| Anyone has paid anything | **No.** Revenue is $0.00 |

**The one dependency outside this repository is the facilitator.** Settling `transferWithAuthorization`
on Base mainnet costs gas, so somebody's funded key must broadcast it. This route delegates that over
HTTPS to `FACILITATOR_URL`. Which facilitator to point at is an owner decision and is **not** made
here. There are two real options, and an earlier version of this section named a third that does
not exist — there is no `FACILITATOR` value that makes `apps/api` settle on an EVM chain.
`facilitatorFromConfig` in `apps/api/src/serve.mjs` builds only `http`, `svm` and `stub`, and `svm`
is Solana. The in-repo EVM path is `createSettlingFacilitator`, which its own definition in
`apps/api/src/facilitator.mjs` records as not wired into the API server and intended to run as a
SEPARATE process — which is how the Sepolia run did it. The other option is a third-party
facilitator reached over HTTPS. Until that URL exists, the route answers 500 by design rather than
serving reads for free.

## 5. What the owner runs

Everything above is landed. These are the steps an agent cannot take — they need the Cloudflare
account, the payee address, and real funds. `docs/SWARM.md` §10 puts all three out of bounds.

**5.1 — Choose the payee and the facilitator.** An address you control on Base mainnet to receive
USDC, and the HTTPS URL of an x402 facilitator that settles on Base mainnet.

**5.2 — Set the five variables** on the Pages project (Settings → Environment variables →
Production), then redeploy so they take effect:

```
PRICE_ASSET      0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
PRICE_PAYTO      <your Base mainnet address>
PRICE_AMOUNT     100000
PRICE_NETWORK    base
FACILITATOR_URL  <https facilitator that settles on Base mainnet>
```

`PRICE_ASSET` is Circle-native USDC on Base. It is **not** USDbC (`0xd9aA…4CA2`), the bridged legacy
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
