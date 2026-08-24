// @ts-check
/**
 * x402 (V2) payment-gate middleware for metered API access.
 *
 * Flow (per the June-2026 x402 V2 scheme — see docs/RESEARCH-SPRINT1.md):
 *   1. Unpaid request → 402 with a `PAYMENT-REQUIRED` header carrying a JSON challenge
 *      (asset, amount, payTo, network, scheme, nonce, expiry).
 *   2. Client re-requests with a `PAYMENT-SIGNATURE` header: a base64 JSON envelope holding an
 *      EIP-3009 `transferWithAuthorization` signature over USDC (the client authorizes the
 *      transfer; it is NOT executed by this server).
 *   3. Server asks a FACILITATOR to verify + settle the authorization on-chain, then serves the
 *      resource and echoes a `PAYMENT-RESPONSE` header (settlement tx / receipt id).
 *
 * Settlement is USDC via EIP-3009 executed by the facilitator, never by this server — the
 * server holds no keys and never moves funds (matches the protocol's non-custodial posture).
 *
 * The facilitator is injected (`verifyAndSettle`) so this module is unit-testable with no chain
 * and no network: production wiring passes an HTTP facilitator client; tests pass a stub.
 */

import { randomBytes } from 'node:crypto';

const HEADER_REQUIRED = 'payment-required';
const HEADER_SIGNATURE = 'payment-signature';
const HEADER_RESPONSE = 'payment-response';

/**
 * @typedef {Object} PriceSpec
 * @property {string} asset    USDC contract address
 * @property {string} amount   integer string, USDC base units (6 dp)
 * @property {string} payTo    recipient address
 * @property {string} network  e.g. "base"
 */

/**
 * @typedef {Object} Facilitator
 * @property {(challenge:object, envelope:object) => Promise<{ok:boolean, receiptId?:string, reason?:string}>} verifyAndSettle
 */


/**
 * Build the 402 challenge for a route. Injectable `nonce`/`nowMs` keep it deterministic for tests.
 *
 * The nonce MUST be unpredictable and globally unique, not a counter: the agent SDK reuses
 * `challenge.nonce` verbatim as the EIP-3009 authorization nonce, and EIP-3009 nonces are burned
 * permanently on-chain per (authorizer, nonce). A process-local counter restarts at 1 on every
 * boot, so the first paid read after any API restart would present an authorization nonce that a
 * previous run already consumed — the settlement reverts as `authorization-used` and the route is
 * unpayable until the counter walks past the burned range. Observed and fixed in sprint 14; see
 * docs/X402-LIVE-REPORT.md.
 * @param {PriceSpec} price
 * @param {{nonce?:string, nowMs:number, ttlMs?:number}} opts
 */
export function buildChallenge(price, opts) {
  const nonce = opts.nonce ?? `0x${randomBytes(32).toString('hex')}`;
  return {
    scheme: 'exact', // EIP-3009 exact-amount authorization
    x402Version: 2,
    asset: price.asset,
    amount: price.amount,
    payTo: price.payTo,
    network: price.network,
    nonce,
    expiresAt: opts.nowMs + (opts.ttlMs ?? 5 * 60_000),
  };
}

/**
 * Decode a client's PAYMENT-SIGNATURE header. Returns null on any malformation (→ 402 again).
 * @param {string|undefined} header
 */
export function decodeSignatureHeader(header) {
  if (!header) return null;
  try {
    const json = Buffer.from(header, 'base64').toString('utf8');
    const env = JSON.parse(json);
    if (!env || typeof env !== 'object') return null;
    if (env.x402Version !== 2) return null;
    if (typeof env.signature !== 'string' || typeof env.authorization !== 'object') return null;
    return env;
  } catch {
    return null;
  }
}

/**
 * Validate that a client's authorization envelope matches the challenge we would issue: same
 * asset, amount at least the price, correct recipient and network, unexpired. This is the
 * server-side gate BEFORE we spend a facilitator call; the facilitator does the cryptographic
 * and on-chain verification.
 * @param {PriceSpec} price
 * @param {object} env  decoded envelope
 * @param {number} nowMs
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkEnvelopeAgainstPrice(price, env, nowMs) {
  const auth = env.authorization ?? {};
  if ((auth.asset ?? '').toLowerCase() !== price.asset.toLowerCase())
    return { ok: false, reason: 'asset-mismatch' };
  if ((auth.to ?? '').toLowerCase() !== price.payTo.toLowerCase())
    return { ok: false, reason: 'recipient-mismatch' };
  if ((env.network ?? '').toLowerCase() !== price.network.toLowerCase())
    return { ok: false, reason: 'network-mismatch' };
  let paid;
  try {
    paid = BigInt(auth.value ?? '0');
  } catch {
    return { ok: false, reason: 'bad-value' };
  }
  if (paid < BigInt(price.amount)) return { ok: false, reason: 'underpaid' };
  const validBefore = Number(auth.validBefore ?? 0) * 1000;
  if (validBefore && validBefore < nowMs) return { ok: false, reason: 'authorization-expired' };
  return { ok: true };
}

/**
 * Core gate. Framework-agnostic: given a raw request's headers and a price + facilitator, returns
 * either a 402 response spec (challenge) or an "authorized" verdict with the PAYMENT-RESPONSE
 * header to echo. Replay protection is delegated to the facilitator (EIP-3009 nonces are
 * single-use on-chain), with an optional local seen-nonce guard for defense in depth.
 *
 * @param {Object} params
 * @param {Record<string,string|undefined>} params.headers   lowercased header map
 * @param {PriceSpec} params.price
 * @param {Facilitator} params.facilitator
 * @param {number} params.nowMs
 * @param {Set<string>} [params.seenNonces]
 * @returns {Promise<
 *   {status:402, headers:Record<string,string>, body:object} |
 *   {status:200, headers:Record<string,string>, receiptId:string}
 * >}
 */
export async function gate({ headers, price, facilitator, nowMs, seenNonces }) {
  const sigHeader = headers[HEADER_SIGNATURE];
  const env = decodeSignatureHeader(sigHeader);

  if (!env) {
    const challenge = buildChallenge(price, { nowMs });
    return {
      status: 402,
      headers: { [HEADER_REQUIRED]: JSON.stringify(challenge) },
      body: { error: 'payment required', challenge },
    };
  }

  const localCheck = checkEnvelopeAgainstPrice(price, env, nowMs);
  if (!localCheck.ok) {
    const challenge = buildChallenge(price, { nowMs });
    return {
      status: 402,
      headers: { [HEADER_REQUIRED]: JSON.stringify(challenge) },
      body: { error: `payment invalid: ${localCheck.reason}`, challenge },
    };
  }

  const nonce = env.authorization?.nonce;
  if (seenNonces && nonce) {
    if (seenNonces.has(nonce)) {
      const challenge = buildChallenge(price, { nowMs });
      return {
        status: 402,
        headers: { [HEADER_REQUIRED]: JSON.stringify(challenge) },
        body: { error: 'payment invalid: replayed-nonce', challenge },
      };
    }
  }

  const settled = await facilitator.verifyAndSettle({ price }, env);
  if (!settled.ok) {
    const challenge = buildChallenge(price, { nowMs });
    return {
      status: 402,
      headers: { [HEADER_REQUIRED]: JSON.stringify(challenge) },
      body: { error: `settlement failed: ${settled.reason ?? 'unknown'}`, challenge },
    };
  }

  if (seenNonces && nonce) seenNonces.add(nonce);
  return {
    status: 200,
    headers: {
      [HEADER_RESPONSE]: JSON.stringify({ receiptId: settled.receiptId, nonce }),
    },
    receiptId: settled.receiptId ?? '',
  };
}

export const HEADERS = {
  REQUIRED: HEADER_REQUIRED,
  SIGNATURE: HEADER_SIGNATURE,
  RESPONSE: HEADER_RESPONSE,
};
