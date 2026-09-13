/**
 * `GET /api/vaults` — the metered read, at the edge.
 *
 * THIS FILE DELIBERATELY CONTAINS NO PAYMENT LOGIC. It imports `gate` from `apps/api/src/x402.mjs`,
 * the same module `apps/api` serves from, and `createHttpFacilitator` from its facilitator module.
 * A second implementation of the 402 handshake is the obvious way to write this and it is the wrong
 * one: two implementations of one protocol drift, and the half that drifts here is the half that
 * decides whether a caller's USDC bought anything. The bundler follows the relative import, so what
 * deploys is the audited module, not a copy of it.
 *
 * WHAT A CALLER GETS, AND WHAT THEY DO NOT.
 * The body is a PINNED SNAPSHOT of indexed vault state, not a live chain read, and it says so in
 * every response via `asOf` and `live: false`. An edge Worker could read an RPC per request, and
 * that is the honest next step, but it is not what this route does today and the payload must not
 * imply otherwise. A caller paying for data is entitled to know its age before they pay: the price
 * and the staleness are both published on the free discovery document at `/.well-known/x402`, so
 * the decision is made before any money moves.
 *
 * REPLAY. `gate` takes a `seenNonces` set and refuses a nonce it has already settled. An edge
 * Worker is not one process — there is no shared memory between isolates or between colos — so an
 * in-memory Set here would be a replay guard that silently covers only the isolate that happened to
 * serve the first request. That is worse than none, because it reads like protection. It is
 * therefore NOT passed, and the guarantee is stated plainly: replay protection on this route is the
 * CHAIN's. EIP-3009 authorizations are single-use by nonce and the token contract itself rejects a
 * reused one, which is the property the Sepolia run verified end to end (`docs/X402-LIVE-REPORT.md`
 * records the resubmission returning `authorization-used`). The facilitator's settlement call is
 * what fails on a replay, so a replayed envelope reaches `settlement failed` and never reaches the
 * body. Adding a durable store (KV or a Durable Object) would let this route reject a replay before
 * spending a facilitator call; it would not change what a caller can obtain.
 */
import { gate, HEADERS } from '../../../api/src/x402.mjs';
import { createHttpFacilitator } from '../../../api/src/facilitator.mjs';
import { resolvePrice, resolveFacilitatorUrl, configErrorResponse } from './_price.js';
import snapshot from './_snapshot.json' with { type: 'json' };

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** Header names, lowercased once. Workers' Headers.get is case-insensitive; the gate's plain object is not. */
function headerBag(request) {
  const bag = {};
  for (const [k, v] of request.headers) bag[k.toLowerCase()] = v;
  return bag;
}

export const onRequestGet = async (context) => {
  const { request, env } = context;

  let price;
  let facilitatorUrl;
  try {
    price = resolvePrice(env);
    facilitatorUrl = resolveFacilitatorUrl(env);
  } catch (err) {
    // Fail CLOSED. A route that cannot resolve who gets paid must not serve the paid body.
    return configErrorResponse(err);
  }

  const decision = await gate({
    headers: headerBag(request),
    price,
    facilitator: createHttpFacilitator({ url: facilitatorUrl }),
    nowMs: Date.now(),
    // seenNonces deliberately omitted — see the header comment.
  });

  if (decision.status !== 200) {
    return new Response(JSON.stringify(decision.body), {
      status: decision.status,
      headers: { ...JSON_HEADERS, ...decision.headers },
    });
  }

  return new Response(
    JSON.stringify({
      asOf: snapshot.asOf,
      live: false,
      liveNote:
        'Pinned snapshot served from the edge, not a chain read at request time. `asOf` is when it was taken.',
      chainId: snapshot.chainId,
      chainName: snapshot.chainName,
      vaults: snapshot.vaults,
      // Served because the FREE discovery document promises it by name. A buyer decides to pay
      // partly on what is absent, so the absence has to arrive with the thing they bought.
      notIncluded: snapshot.notIncluded,
      receiptId: decision.receiptId,
    }),
    { status: 200, headers: { ...JSON_HEADERS, ...decision.headers } },
  );
};

export { HEADERS };
