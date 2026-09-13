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
 *
 * ## x402 v2 wire conformance (this section, 2026-09-13)
 *
 * Downloaded and read `specs/x402-specification-v2.md` and `specs/schemes/exact/scheme_exact_evm.md`
 * from `coinbase/x402` directly (`docs/RESEARCH-SPRINT1.md:27-32` flagged the field-level schema as
 * "Unverified" and this had never been done). Two divergences from the spec, confirmed against that
 * file, section by section:
 *
 *   - §5.1.1: the 402 body is `{x402Version, error, resource, accepts:[...], extensions}`, with
 *     `accepts[].network` in CAIP-2 (`eip155:8453` / `eip155:84532`, §11.1). This module's 402 JSON
 *     was flat (`{scheme, asset, amount, payTo, network, nonce, expiresAt}`) with a repo-shorthand
 *     network ("base" / "base-sepolia") and no `accepts`/`resource`/`extensions` at all.
 *   - §5.2.1/§5.2.2: the payment payload nests the scheme data as `payload:{signature,
 *     authorization}` under a top-level `accepted` (the chosen `PaymentRequirements`) and
 *     `resource`. This module's `decodeSignatureHeader` required `signature`/`authorization` at
 *     the TOP level instead.
 *
 * `buildChallenge` now emits BOTH: every legacy flat field stays exactly where it was (packages/
 * agent-sdk/src/eip3009.mjs, scripts/live-x402-run.mjs and scripts/soak/api-client.mjs all read
 * `challenge.asset` / `.amount` / `.payTo` / `.network` / `.nonce` directly off this object, so
 * removing them breaks three files this module cannot see from here), and the spec's `resource`/
 * `accepts`/`extensions` fields are added alongside. `decodeSignatureHeader` accepts either the
 * legacy flat envelope OR the spec's nested one and normalizes both to the same flat shape before
 * anything downstream (`checkEnvelopeAgainstPrice`, `gate()`, and the facilitator modules `gate()`
 * hands the envelope to) ever sees it — see the comments at each function for the field-by-field
 * reasoning. This is "emit conformant, accept both": a v2 client can now pay this API, and every
 * existing flat-shape consumer keeps working unchanged.
 *
 * `extra` (§5.1.2, the USDC EIP-712 domain — `facilitator.mjs`'s `readUsdcDomain` documents that it
 * varies per chain, "USDC" on Base Sepolia vs "USD Coin" on mainnet) is populated only when the
 * caller supplies `price.extra`; this module has no chain access and does not guess it.
 */

import { randomBytes } from 'node:crypto';

const HEADER_REQUIRED = 'payment-required';
const HEADER_SIGNATURE = 'payment-signature';
const HEADER_RESPONSE = 'payment-response';

/**
 * x402 v2 (spec §11.1) names chains via CAIP-2 (`namespace:reference`), e.g. `eip155:8453` for
 * Base mainnet. This repo's config has only ever used the two short names below (`serve.mjs`'s
 * `PRICE_NETWORK` default is `'base'`; `scripts/live-x402-run.mjs`'s default is `'base-sepolia'`;
 * `grep -rn PRICE_NETWORK` turns up no third value) — so only these two are mapped. Anything else
 * (an SVM network string, or an already-CAIP-2 value) passes through `toCaip2` unchanged.
 */
const CAIP2_BY_LEGACY = { base: 'eip155:8453', 'base-sepolia': 'eip155:84532' };

/**
 * Legacy short name -> CAIP-2 for the two networks this repo configures; passes through anything
 * else. Exported: `facilitator-server.mjs`'s `checkChallengePrice` re-checks the same envelope's
 * network against the same challenge's price server-side (see that function's own comment on why
 * it duplicates the check `gate()` already ran) and needs the identical equality, not a second
 * hand-rolled one — see the MAJOR-1 fix note on `checkChallengePrice` for what happens otherwise.
 */
export function toCaip2(network) {
  return CAIP2_BY_LEGACY[String(network ?? '').toLowerCase()] ?? network;
}

/**
 * True iff two network identifiers name the same chain once both are put through `toCaip2` — so a
 * spec client's `eip155:84532` matches this repo's own `'base-sepolia'`, in either argument order.
 */
export function networksEqual(a, b) {
  if (!a || !b) return false;
  return toCaip2(String(a).toLowerCase()) === toCaip2(String(b).toLowerCase());
}

/**
 * @typedef {Object} PriceSpec
 * @property {string} asset    USDC contract address
 * @property {string} amount   integer string, USDC base units (6 dp)
 * @property {string} payTo    recipient address
 * @property {string} network  e.g. "base"
 * @property {{name:string, version:string}} [extra]
 *   the USDC EIP-712 domain (spec §5.1.2's `extra`), when the caller has one to supply (e.g. from
 *   `facilitator.mjs`'s `readUsdcDomain`, read off the token itself). Optional per spec; omitted
 *   when not supplied rather than guessed — see the module header.
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
 * @param {{nonce?:string, nowMs:number, ttlMs?:number, resource?:{url?:string, description?:string, mimeType?:string}}} opts
 */
export function buildChallenge(price, opts) {
  const nonce = opts.nonce ?? `0x${randomBytes(32).toString('hex')}`;
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const base = {
    scheme: price.svm ? 'exact-svm' : 'exact', // EIP-3009 authorization, or an SPL TransferChecked
    x402Version: 2,
    asset: price.asset,
    amount: price.amount,
    payTo: price.payTo,
    network: price.network,
    nonce,
    expiresAt: opts.nowMs + ttlMs,
    // --- x402 v2 spec additions, ADDITIVE only (see the module header) ---
    // §5.1.1's ResourceInfo. `url` is Required there; this module has no request path to put in
    // it (that lives at the server.mjs call site), so an unsupplied `opts.resource` yields `''`
    // rather than a guessed value — still spec-legal (a string), just not informative on its own.
    resource: {
      url: opts.resource?.url ?? '',
      ...(opts.resource?.description ? { description: opts.resource.description } : {}),
      ...(opts.resource?.mimeType ? { mimeType: opts.resource.mimeType } : {}),
    },
    // §5.1.1/§5.1.2's `accepts` array of PaymentRequirements. `network` is CAIP-2 (§11.1);
    // `maxTimeoutSeconds` is this same challenge's TTL, in seconds; `extra` (§5.1.2, Optional) is
    // included only when the caller supplied `price.extra` — see the `PriceSpec` typedef above.
    accepts: [
      {
        scheme: price.svm ? 'exact-svm' : 'exact',
        network: toCaip2(price.network),
        amount: price.amount,
        asset: price.asset,
        payTo: price.payTo,
        maxTimeoutSeconds: Math.round(ttlMs / 1000),
        ...(price.extra ? { extra: price.extra } : {}),
      },
    ],
    extensions: {}, // §5.1.1: Optional; none implemented, so an empty map rather than omitted.
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
    // x402 v2 spec §5.2.1 nests the scheme payload as `payload:{signature, authorization}` under
    // a top-level `accepted` (the chosen PaymentRequirements) and `resource`, instead of this
    // repo's flat top-level `signature`/`authorization`. Read whichever is present so a
    // spec-conformant client and this repo's existing flat-envelope clients (packages/agent-sdk,
    // scripts/live-x402-run.mjs, scripts/soak/api-client.mjs) are both understood.
    const nested = typeof env.payload === 'object' && env.payload !== null;
    const flatSig = nested ? env.payload.signature : env.signature;
    const flatAuth = nested ? env.payload.authorization : env.authorization;
    const accepted = typeof env.accepted === 'object' && env.accepted !== null ? env.accepted : undefined;

    const evmShape = typeof flatSig === 'string' && typeof flatAuth === 'object' && flatAuth !== null;
    const svmShape = env.scheme === 'exact-svm' && typeof env.transaction === 'string';
    if (!evmShape && !svmShape) return null;

    // Neither a legacy flat envelope nor an SVM one needs normalization — return exactly what was
    // decoded, byte for byte, as this function always has. Only a genuinely spec-nested envelope
    // (carrying `payload` and/or `accepted`) needs its `signature`/`authorization`/`network`
    // hoisted to the top level that `checkEnvelopeAgainstPrice` and `gate()` already read.
    if (!evmShape || (!nested && !accepted)) return env;

    // §5.2.2's Authorization object has exactly {from, to, value, validAfter, validBefore, nonce}
    // — no `asset`. This repo's flat authorization has always carried `asset` directly (see
    // api.test.mjs's `envelope()` helper, and `facilitator-server.mjs`'s `checkChallengePrice`
    // function, which reads `auth.asset` off exactly this field), so a spec-shaped authorization
    // needs it backfilled from `accepted.asset`. Never overwrite a value the envelope actually
    // supplied — `!= null` also treats an explicit `null` as "fill it".
    const authorization = flatAuth.asset != null ? flatAuth : { ...flatAuth, asset: accepted?.asset };

    return {
      ...env,
      signature: flatSig,
      authorization,
      network: env.network ?? accepted?.network,
    };
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
    if (!networksEqual(env.network, price.network))
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
  if (!networksEqual(env.network, price.network))
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
 * @param {{url?:string, description?:string, mimeType?:string}} [params.resource]
 *        spec §5.1.1 ResourceInfo for the 402 body's `resource`/`accepts` fields (see
 *        `buildChallenge`); omitted = `{url:''}`, since this function has no request path of its
 *        own — the caller (server.mjs) is the one that knows the path being requested.
 * @returns {Promise<
 *   {status:402, headers:Record<string,string>, body:object} |
 *   {status:200, headers:Record<string,string>, receiptId:string}
 * >}
 */
export async function gate({ headers, price, facilitator, nowMs, seenNonces, resource }) {
  const sigHeader = headers[HEADER_SIGNATURE];
  const env = decodeSignatureHeader(sigHeader);

  if (!env) {
    const challenge = buildChallenge(price, { nowMs, resource });
    return {
      status: 402,
      headers: { [HEADER_REQUIRED]: JSON.stringify(challenge) },
      // The body is the superset of the challenge (so it is itself a spec §5.1.1-shaped
      // PaymentRequired JSON: x402Version/resource/accepts/extensions all present at the top
      // level) PLUS `error` and the legacy nested `challenge` key some callers still read
      // (scripts/soak/api-client.mjs:53-54's fallback path).
      body: { ...challenge, error: 'payment required', challenge },
    };
  }

  const localCheck = checkEnvelopeAgainstPrice(price, env, nowMs);
  if (!localCheck.ok) {
    const challenge = buildChallenge(price, { nowMs, resource });
    return {
      status: 402,
      headers: { [HEADER_REQUIRED]: JSON.stringify(challenge) },
      body: { ...challenge, error: `payment invalid: ${localCheck.reason}`, challenge },
    };
  }

  // AN SVM ENVELOPE HAS NO `nonce`, so reading one leaves this guard inert on that path. The
  // transaction bytes are the right key: they carry the payer's signature over a specific blockhash,
  // so two envelopes with identical bytes ARE the same payment. Solana refuses a duplicate signature
  // within the blockhash's ~2-minute life on its own, which is the real protection; this is the
  // local half, and an inert local half is worse than an absent one because it looks present.
  //
  // THE KEY IS CHOSEN FROM `price`, NOT FROM THE ENVELOPE, and this line got that wrong once
  // already. It read `env.authorization?.nonce ?? (env.scheme === 'exact-svm' ? env.transaction :
  // undefined)`, and `env.authorization` is client-supplied while the SVM branch of
  // `checkEnvelopeAgainstPrice` never looks at it — so a client could attach a fresh invented
  // `authorization.nonce` to identical transaction bytes and present the same payment as many times
  // as it liked. Demonstrated: five presentations, five 200s. That is the SAME defect as the
  // `env.scheme` branch fixed above, one line beneath the comment explaining why it was a defect.
  // A client-supplied field must never select which server check runs, nor what it runs on.
  const nonce = price.svm ? env.transaction : env.authorization?.nonce;
  if (seenNonces && nonce) {
    if (seenNonces.has(nonce)) {
      const challenge = buildChallenge(price, { nowMs, resource });
      return {
        status: 402,
        headers: { [HEADER_REQUIRED]: JSON.stringify(challenge) },
        body: { ...challenge, error: 'payment invalid: replayed-nonce', challenge },
      };
    }
  }

  const settled = await facilitator.verifyAndSettle({ price }, env);
  if (!settled.ok) {
    const challenge = buildChallenge(price, { nowMs, resource });
    return {
      status: 402,
      headers: { [HEADER_REQUIRED]: JSON.stringify(challenge) },
      body: { ...challenge, error: `settlement failed: ${settled.reason ?? 'unknown'}`, challenge },
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
