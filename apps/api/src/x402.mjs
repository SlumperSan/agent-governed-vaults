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
 * THAT SENTENCE IS ABOUT THIS FILE AND STAYS TRUE OF IT: the gate holds nothing and calls an
 * injected `verifyAndSettle`. It is no longer true of every FACILITATOR the process can be
 * configured with. Since 2026-09-09 there is ONE exception and it is opt-in: `FACILITATOR=svm`. The x402 `exact` scheme on Solana has the facilitator sign as fee payer, so that mode holds a keypair by design — see
 * `facilitator-svm.mjs`. The gate is unchanged either way; what changed is that one of the things
 * it can be handed is custodial, and a blanket claim about "the server" now needs the qualifier.
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
  const base = {
    scheme: price.svm ? 'exact-svm' : 'exact', // EIP-3009 authorization, or an SPL TransferChecked
    x402Version: 2,
    asset: price.asset,
    amount: price.amount,
    payTo: price.payTo,
    network: price.network,
    nonce,
    expiresAt: opts.nowMs + (opts.ttlMs ?? 5 * 60_000),
  };
  // AN SVM CLIENT BUILDS THE TRANSACTION, SO IT NEEDS TWO THINGS AN EVM CLIENT NEVER ASKS FOR.
  //
  //   feePayer — the facilitator co-signs as fee payer and REFUSES a transaction that names anybody
  //              else (`wrong-fee-payer`). The client cannot guess it; nothing else in the protocol
  //              publishes it. Omit it and every payment is rejected for a reason the client has no
  //              way to fix.
  //   decimals — `TransferChecked` takes the mint's decimals as an argument and the token program
  //              rejects a wrong one. The client would otherwise have to fetch the mint, which is a
  //              round trip to learn something the server already knows.
  //
  // The nonce stays in both shapes even though the SVM path does not use it: it costs nothing, and a
  // challenge that changes shape more than it must is a challenge clients special-case more than
  // they must. The replay bound on Solana is the blockhash, not the nonce — see svm-exact.mjs.
  return price.svm ? { ...base, feePayer: price.svm.feePayer, decimals: price.svm.decimals } : base;
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
    // TWO ENVELOPE SHAPES, AND THIS FUNCTION KNOWS NOTHING ABOUT THE PRICE, so it can only reject
    // what is neither. It required `{signature, authorization}` unconditionally until a review built
    // an envelope with the shipped `buildSvmEnvelope` and watched `gate()` 402 it forever: the SVM
    // envelope carries `{scheme, network, transaction}` and has no signature field at all, because
    // the signatures live inside the serialised transaction. The whole SVM path was unreachable
    // through the only production entry point, while the commit that removed the boot refusal said
    // the path was finished.
    //
    // Accepting both shapes here is safe because it decides nothing: `checkEnvelopeAgainstPrice`
    // selects the scheme from `price`, which the server owns, and refuses the shape that does not
    // match it. Decoding is not authorisation.
    const evmShape = typeof env.signature === 'string' && typeof env.authorization === 'object';
    const svmShape = env.scheme === 'exact-svm' && typeof env.transaction === 'string';
    if (!evmShape && !svmShape) return null;
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
  // AN SVM ENVELOPE CARRIES A TRANSACTION, NOT AN AUTHORIZATION, so every field below is absent and
  // the first comparison rejects it as `asset-mismatch` — a reason that would send a client looking
  // at its mint. There is nothing useful to check here for that scheme: the facilitator decodes the
  // transaction and checks the mint, the destination, the amount, the fee payer and every other
  // instruction in it, which is strictly more than this function could. So this defers rather than
  // guessing, and the network check below still applies because it is scheme-independent.
  //
  // THE BRANCH IS TAKEN FROM `price`, WHICH THE SERVER OWNS, AND NEVER FROM `env.scheme`, WHICH THE
  // CLIENT WRITES. It read `env.scheme === 'exact-svm'` until a review demonstrated the consequence:
  // against an EVM price, an envelope that simply asserted `scheme: 'exact-svm'` and carried any
  // non-empty `transaction` string returned `{ok:true}` — skipping asset, recipient, amount and
  // expiry, and skipping the replay guard too, since that reads `env.authorization.nonce` and a
  // spoofed envelope has none. A client-supplied string must never select which of the server's
  // checks run. `price.svm` is set only by the operator's own configuration, so when it is absent
  // this function does exactly what it did before this scheme existed.
  if (price.svm) {
    if ((env.network ?? '').toLowerCase() !== price.network.toLowerCase())
      return { ok: false, reason: 'network-mismatch' };
    if (env.scheme !== 'exact-svm') return { ok: false, reason: 'scheme-mismatch' };
    if (typeof env.transaction !== 'string' || env.transaction === '')
      return { ok: false, reason: 'no-transaction' };
    return { ok: true };
  }
  // Symmetrically: an SVM envelope presented against an EVM price is refused by name rather than
  // falling through to `asset-mismatch`, which would describe the wrong problem.
  if (env.scheme === 'exact-svm') return { ok: false, reason: 'scheme-mismatch' };
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

  // AN SVM ENVELOPE HAS NO `nonce`, so reading one leaves this guard inert on that path. The
  // transaction bytes are the right key: they carry the payer's signature over a specific blockhash,
  // so two envelopes with identical bytes ARE the same payment. Solana refuses a duplicate signature
  // within the blockhash's ~2-minute life on its own, which is the real protection; this is the
  // local half, and an inert local half is worse than an absent one because it looks present.
  const nonce = env.authorization?.nonce ?? (env.scheme === 'exact-svm' ? env.transaction : undefined);
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
