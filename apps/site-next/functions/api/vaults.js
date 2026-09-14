/**
 * `GET /api/vaults` — the metered read, at the edge. LIVE as of this file: every 200 is a chain
 * read taken at request time, not a pinned snapshot. The previous version of this file served a
 * pinned snapshot and said so in every response (`live: false`); this route now reads Robinhood
 * Chain mainnet (4663) directly and reports the block the read was taken at.
 *
 * THIS FILE STILL CONTAINS NO PAYMENT LOGIC OF ITS OWN, and that constraint got HARDER to hold
 * with a live read in the middle of it, not easier. It imports `decodeSignatureHeader`,
 * `checkEnvelopeAgainstPrice`, `challengeResponse` and `nonceOf` from `apps/api/src/x402.mjs` —
 * the same module `apps/api` serves from — and `createStandardHttpFacilitator` from its
 * facilitator module, rather than reimplementing any of the 402 handshake. It CANNOT call that
 * module's own `gate()` directly, though, because `gate()` settles with the facilitator as soon
 * as the local envelope check passes, and this route needs a THIRD step in between: read the
 * chain, and only pay the facilitator if that read produced something to serve.
 * `challengeResponse` and `nonceOf` exist in `x402.mjs` precisely so this file does not have to
 * restate the 402 shape or the nonce-selection logic to get that ordering — see their doc
 * comments there.
 *
 * NOT `createHttpFacilitator`: that one speaks this repo's own bespoke single-POST shape, which
 * only `apps/api/src/facilitator-server.mjs` implements — no public facilitator speaks it, so a
 * route wired to it and pointed at a real facilitator 402s every payment on a transport error,
 * with nothing in the response explaining why. That is exactly what this file did until review
 * round 6 caught it. `createStandardHttpFacilitator` needs a CAIP-2 chain id
 * (`FACILITATOR_NETWORK`, e.g. `eip155:8453`) deliberately separate from `price.network` (the
 * repo-shorthand label, e.g. `base`, the 402 challenge advertises to a paying client) — see
 * `_price.js`'s `resolveFacilitatorNetwork`.
 *
 * A second implementation of the 402 handshake is the obvious way to write this and it is the
 * wrong one: two implementations of one protocol drift, and the half that drifts here is the half
 * that decides whether a caller's USDC bought anything. The bundler follows the relative import,
 * so what deploys is the audited module, not a copy of it.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER, NOT SOME OTHER ONE.
 *   1. No payment header → 402, challenge only. NO RPC CALL — an unpaid request must not cost
 *      this deployment an `eth_call` round trip.
 *   2. Header present but locally invalid (wrong amount, wrong asset, expired, ...) → 402. STILL
 *      NO RPC CALL — the envelope has to clear the same local check `gate()` runs before this
 *      route spends anything on it.
 *   3. Envelope locally valid → NOW touch the chain, binding FIRST. Three distinct ways this can
 *      still yield nothing to sell, and all three are 503 with `verifyAndSettle` never called:
 *        (a) the RPC does not answer for the chain this route DECLARES — see CHAIN BINDING below;
 *        (b) the chain cannot even report a block number — no coherent height to read anything
 *            at, handled by `readVaultsAtHead` throwing;
 *        (c) a block number came back but every field of every vault failed to read (a reader
 *            that answers `eth_blockNumber` and then fails everything else) — a block number and
 *            two addresses is not a read, and billing for it would be.
 *      None of the three is tripped by an oracle freeze or a transport hiccup on ONE field of ONE
 *      vault, which is not "nothing to sell" — it degrades that one field (`pricingFrozen` or
 *      `unreadable`) inside a response that still has real data and can still be sold. See
 *      `_vaultread.js` for that per-field distinction.
 *   4. Read produced a block AND at least one readable field somewhere → settle with the
 *      facilitator, then serve the bytes already read. A caller is billed for what this route
 *      successfully read, at the block it read it, never for a read that came back empty.
 *
 * CHAIN BINDING, AND WHY A 503 IS NOT "SWALLOWING" IT.
 * `createChainReader({rpcUrl, chainId})` builds a viem client that asserts the declared id ONTO an
 * arbitrary URL; it never checks it AGAINST the chain that URL answers for (`reader.mjs`'s own
 * words above `assertBoundToDeclaredChain`, and `packages/chain-config/src/chain-binding.mjs` for
 * the general shape, issue #204). Production takes exactly that path here — `deps.reader` is
 * undefined outside tests — so without the call below, every 200 this route serves would assert
 * `chainId: 4663, chainName: 'robinhood-mainnet'` about data whose provenance was never checked.
 * "Wrong chain → the addresses have no code → reads fail → 503" is NOT the mitigation it looks
 * like: the same deployer running the same script against Robinhood testnet produces IDENTICAL
 * CREATE addresses holding different state, so a misconfigured `DATA_RPC_URL` sells a paid 200
 * full of another chain's numbers. The binding check exists so nobody has to enumerate vectors.
 *
 * `chain-binding.mjs` instructs callers that catch broadly to RE-THROW `ChainBindingError`, because
 * the indexer's and canary's per-read handlers are fault-tolerant and would log it as one degraded
 * field and keep polling the wrong chain. Routing it into the 503 below is not that mistake and is
 * the same refusal in HTTP form: this request serves no body, the facilitator is never called, and
 * the caller is not charged. There is no loop here to keep running — a Worker invocation ends at
 * the `return`. The refusal message reaches the caller in `detail`, which is safe precisely because
 * `DATA_RPC_URL` is a public constant in this repository (contrast `_price.js`'s `FACILITATOR_URL`,
 * operator configuration published nowhere, which is withheld from its own error bodies).
 *
 * REPLAY. Unchanged from the pinned-snapshot version of this file: `seenNonces` is deliberately
 * NOT passed to anything here — an edge Worker has no memory shared across isolates or colos, so
 * an in-memory replay guard would protect only the isolate that happened to serve the first
 * request while reading like protection everywhere else. Replay protection on this route is the
 * CHAIN's: EIP-3009 authorizations are single-use by nonce and the token contract rejects a
 * reused one (verified end to end in `docs/X402-LIVE-REPORT.md`), so a replayed envelope fails at
 * settlement and never reaches the body.
 */
import {
  HEADERS, decodeSignatureHeader, checkEnvelopeAgainstPrice, challengeResponse, nonceOf,
  buildSettlementResponse, encodeHeaderJson,
} from '../../../api/src/x402.mjs';
import { createStandardHttpFacilitator } from '../../../api/src/facilitator.mjs';
import { resolvePrice, resolveFacilitatorUrl, resolveFacilitatorNetwork, configErrorResponse } from './_price.js';
import { createChainReader } from '../../../../packages/canary/src/reader.mjs';
import { readVaultsAtHead, vaultYieldedNoData } from './_vaultread.js';
import { DATA_CHAIN_ID, DATA_CHAIN_NAME, DATA_RPC_URL, VAULTS } from './_chain.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** Header names, lowercased once. Workers' Headers.get is case-insensitive; the gate's plain object is not. */
function headerBag(request) {
  const bag = {};
  for (const [k, v] of request.headers) bag[k.toLowerCase()] = v;
  return bag;
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function respond402(decision) {
  return json(decision.body, decision.status, decision.headers);
}

/**
 * `context` from Cloudflare Pages: `{request, env}`. `deps` is a test seam only — production
 * calls this with no third argument and every default below applies. Nothing under `deps` is
 * reachable from a request; it exists so `apps/site-next/test/x402-edge.test.mjs` can inject a
 * fake chain reader and a spy facilitator without a network.
 * @param {{request:Request, env:object}} context
 * @param {{reader?:object, facilitator?:object, nowMs?:number}} [deps]
 */
export async function handle(context, deps = {}) {
  const { request, env } = context;

  let price;
  let facilitatorUrl;
  let facilitatorNetwork;
  try {
    price = resolvePrice(env);
    facilitatorUrl = resolveFacilitatorUrl(env);
    facilitatorNetwork = resolveFacilitatorNetwork(env);
  } catch (err) {
    // Fail CLOSED. A route that cannot resolve who gets paid must not serve the paid body.
    return configErrorResponse(err);
  }

  const nowMs = deps.nowMs ?? Date.now();

  // ── step 1 & 2: local checks only. Neither branch below touches the chain. ──
  const sigHeader = headerBag(request)[HEADERS.SIGNATURE];
  const envelope = decodeSignatureHeader(sigHeader);
  if (!envelope) {
    return respond402(challengeResponse(price, nowMs, 'payment required'));
  }
  const localCheck = checkEnvelopeAgainstPrice(price, envelope, nowMs);
  if (!localCheck.ok) {
    return respond402(challengeResponse(price, nowMs, `payment invalid: ${localCheck.reason}`));
  }

  // ── step 3: the envelope is locally valid. Read the chain BEFORE spending a facilitator call. ──
  const reader = deps.reader ?? createChainReader({
    rpcUrl: DATA_RPC_URL, chainId: DATA_CHAIN_ID, chainName: DATA_CHAIN_NAME,
  });
  let read;
  try {
    // BEFORE any address is read: prove the RPC answers for the chain this route declares, or
    // refuse. `ChainBindingError` lands in the `catch` below as a 503 — see CHAIN BINDING in the
    // header for why that is the refusal and not a swallow. Kept inside the same `try` as the read
    // on purpose: both mean "this deployment has nothing it can honestly sell right now", and one
    // exit is harder to route a paid 200 past than two.
    await reader.assertBoundToDeclaredChain();
    read = await readVaultsAtHead(reader, VAULTS);
  } catch (err) {
    // Either the RPC is not the chain this route declares, or the chain never told us what block
    // it is on. Both mean there is nothing coherent to sell. 503, and the facilitator is never
    // called below this line: the caller is not charged for a read this deployment could not
    // perform, nor for one it could not prove was of the right chain. `detail` carries the
    // refusal verbatim, which for a binding failure names both chain ids.
    return json(
      {
        error: 'chain read failed',
        detail: err?.shortMessage ?? err?.message ?? String(err),
        chainId: DATA_CHAIN_ID,
        chainName: DATA_CHAIN_NAME,
      },
      503,
    );
  }

  // A block number alone is not "a read that produced something to serve": a reader whose
  // `headBlock()` answers but whose every subsequent `tryRead()` fails as transport (a bad RPC
  // that answers one call and fails the rest) reaches this point with a block number and NOTHING
  // else — every vault entirely `unreadable`. Billing for that is billing for two addresses and a
  // number, which is not the read this route sells. Caught here, before the facilitator is asked
  // to settle anything.
  if (read.vaults.every(vaultYieldedNoData)) {
    return json(
      {
        error: 'chain read failed',
        detail: 'a block number was read, but every field of every vault failed to read',
        chainId: DATA_CHAIN_ID,
        chainName: DATA_CHAIN_NAME,
        blockNumber: read.blockNumber,
      },
      503,
    );
  }

  // ── step 4: the read produced a block AND at least some data. Settle, then serve what was read. ──
  // `network` is the CAIP-2 id the FACILITATOR expects, deliberately separate from
  // `price.network`, which is the label the CHALLENGE advertises to the paying client.
  const facilitator = deps.facilitator ?? createStandardHttpFacilitator({ url: facilitatorUrl, network: facilitatorNetwork });
  const settled = await facilitator.verifyAndSettle({ price }, envelope);
  if (!settled.ok) {
    return respond402(challengeResponse(price, nowMs, `settlement failed: ${settled.reason ?? 'unknown'}`));
  }

  const nonce = nonceOf(price, envelope);
  return json(
    {
      live: true,
      liveNote:
        'Chain read taken at request time, not a pinned snapshot. `blockNumber` is the height ' +
        'every field below was read at. A vault missing a field carries `unreadable` for it ' +
        '(the read failed and nothing was guessed); `pricingFrozen: true` means the oracle itself ' +
        'reverted the NAV read, which is a real product signal, not a missing one. There is no ' +
        '`notIncluded` list any more (that was the pinned-snapshot version\'s mechanism for the ' +
        'same concern) — a live field is either present, `unreadable`, or explained by ' +
        '`pricingFrozen`, per vault, which is a strictly finer-grained answer to "what is absent ' +
        'and why" than a fixed list could give.',
      chainId: DATA_CHAIN_ID,
      chainName: DATA_CHAIN_NAME,
      blockNumber: read.blockNumber,
      vaults: read.vaults,
      receiptId: settled.receiptId ?? '',
    },
    200,
    {
      // Built and encoded by `x402.mjs`, not by this file. #287 made `PAYMENT-RESPONSE` a spec
      // §5.3.2 `SettlementResponse` (`{success, transaction, network, payer?}`, superset of the
      // legacy `{receiptId, nonce}`) AND base64 per `specs/transports-v2/http.md:161-167`. This
      // route used to hand-roll `JSON.stringify({receiptId, nonce})` here, which was correct
      // against the old server and is a wrong shape in a wrong encoding against the new one. That
      // is precisely the "second implementation of one protocol" this file's header refuses, so
      // the shape and the encoding both come from the module that owns them.
      [HEADERS.RESPONSE]: encodeHeaderJson(buildSettlementResponse({ price, env: envelope, settled, nonce })),
      // `live: true` rests on no intermediary caching it — a cached 200 would keep answering with
      // a stale block after the chain moved.
      'cache-control': 'no-store',
    },
  );
}

export const onRequestGet = (context) => handle(context);

export { HEADERS };
