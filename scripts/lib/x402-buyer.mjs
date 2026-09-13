// @ts-check
/**
 * A reusable x402 buyer: the client half of the handshake `apps/api/src/x402.mjs` (`gate`) and
 * `apps/site-next/functions/api/vaults.js` implement server-side.
 *
 * WHY THIS IS NOT JUST "SIGN WHATEVER THE 402 ASKS FOR". A server's challenge names its own price,
 * asset, recipient, network and expiry — every field a malicious or misconfigured server controls.
 * A client that signs it unconditionally is a wallet-drainer with extra steps: point it at a server
 * that answers 402 with `payTo` set to an attacker's address, or `amount` set to the caller's whole
 * balance, and an unconditional signer pays it. `validateChallenge` runs BEFORE `sign` is ever
 * called, against values the CALLER supplies up front — never against anything the server sends —
 * and a mismatch throws `ChallengeMismatchError` with nothing signed. `buyResource`'s tests assert
 * this by spying on `sign` and checking it was never invoked, not merely that the call rejected.
 *
 * WHAT SIGNS. This module holds no key. `sign` is a callback — `(typedData) => Promise<signature>`
 * — or the caller can wrap a viem local account with `signerFromAccount`. Either way the private key
 * lives in the caller's process (or, for the CLI in `scripts/x402-buy.mjs`, in an encrypted keystore
 * decrypted just-in-time by `scripts/lib/keystore.mjs`), never in this module.
 *
 * WHAT SETTLES. Nothing here broadcasts a transaction. `buyResource` signs an EIP-3009
 * `transferWithAuthorization` authorization and hands it to the server over HTTP; the server's
 * facilitator is what settles on-chain (see `apps/api/src/facilitator.mjs`). This module never
 * holds gas, never has a chain RPC write path, and cannot move funds by itself.
 *
 * WIRE FORMAT: THIS REPO'S OWN, NOT THE PUBLISHED x402 v2 SPEC. `validateChallenge` and
 * `buyResource` read/write the FLAT challenge and envelope shapes `apps/api/src/x402.mjs`
 * (`buildChallenge`, `decodeSignatureHeader`) and `packages/agent-sdk/src/eip3009.mjs`
 * (`buildEnvelope`) actually produce and expect on this server today — not the nested
 * `{accepts:[…], resource, extensions}` / `{accepted, payload:{…}, resource}` shapes the
 * Coinbase x402 v2 spec (`coinbase/x402` `specs/x402-specification-v2.md` §5.1.1 / §5.2.1) and its
 * HTTP transport (`specs/transports-v2/http.md`) define, nor that transport's requirement that
 * `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` themselves be base64-encoded (this repo's are plain
 * `JSON.stringify`). `docs/X402-INTEGRATION.md`'s "Known gap" section has the full comparison.
 * This client necessarily targets what the server actually does, per this file's own header — a
 * buyer that spoke only the spec's shapes could not pay this endpoint. If the wire format is later
 * made spec-conformant, the fields to change are `buildChallenge`/`decodeSignatureHeader` and
 * `buildEnvelope`/`authorizeFromChallenge`; `validateChallenge`'s field checks and `buyResource`'s
 * control flow (validate-then-sign-then-retry) stay the same shape either way.
 */

import { authorizeFromChallenge, buildTypedData } from '../../packages/agent-sdk/src/eip3009.mjs';

/** Thrown when a 402 challenge does not match what the caller told us to expect. Nothing is signed. */
export class ChallengeMismatchError extends Error {
  /**
   * @param {string} reason  short machine-checkable code, e.g. "asset-mismatch"
   * @param {object} [detail]
   */
  constructor(reason, detail = {}) {
    super(`refusing to sign — challenge ${reason}`);
    this.name = 'ChallengeMismatchError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** Thrown for anything that is not a challenge-validity problem: bad status, bad body, rejected payment. */
export class PaymentFailedError extends Error {
  /**
   * @param {string} message
   * @param {{status?:number, body?:any, challenge?:object|null}} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = 'PaymentFailedError';
    this.status = detail.status;
    this.body = detail.body;
    this.challenge = detail.challenge ?? null;
  }
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parse the `PAYMENT-REQUIRED` header value into a challenge object. Returns null on anything
 * malformed — absent, not JSON, not an object — rather than throwing, so callers can turn it into
 * one clear `PaymentFailedError` instead of an unhandled JSON.parse exception.
 * @param {string|null|undefined} headerValue
 */
export function parseChallengeHeader(headerValue) {
  if (!headerValue) return null;
  try {
    const parsed = JSON.parse(headerValue);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse the `PAYMENT-RESPONSE` header value into a receipt object. Same null-on-malformed rule as
 * `parseChallengeHeader`, and for a sharper reason here: by the time this is called the payment has
 * ALREADY been authorized and accepted (the response is a `200`) — a bare `JSON.parse` throw at
 * this point would discard the paid body over a cosmetic problem with the receipt, which is a worse
 * failure than serving the data with no receipt. Losing the receipt is a real loss (nothing to
 * reconcile against the chain later, see the integration doc's "what the receipt id is good for"),
 * but it must never cost the caller the thing they already paid for.
 * @param {string|null|undefined} headerValue
 */
export function parseReceiptHeader(headerValue) {
  if (!headerValue) return null;
  try {
    const parsed = JSON.parse(headerValue);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate a 402 challenge against what the caller expects BEFORE any signature is produced.
 * Throws `ChallengeMismatchError` on the first mismatch found; returns nothing on success.
 *
 * Every field the buyer is required to check per the task this module exists for: amount (capped
 * by `expected.maxAmount`, never trusted as a floor, and required to be the exact canonical decimal
 * shape this repo signs — see the comment inline), asset, payTo, network, and expiry (both "not
 * already expired" and, unless the caller opts out, "not implausibly long-lived" — a challenge
 * that stays payable for hours is a bigger blast radius than the ~5 minute default this repo's own
 * `buildChallenge` issues, see `apps/api/src/x402.mjs`). `nonce` gets the same canonical-shape
 * treatment as `amount`, for the same reason: it is reused verbatim in what gets signed.
 *
 * @param {object} challenge
 * @param {Object} expected
 * @param {string} expected.asset      USDC (or other settlement token) address, case-insensitive
 * @param {string} expected.payTo      recipient address, case-insensitive
 * @param {string} expected.network    e.g. "base" — must match the challenge exactly
 * @param {string|bigint} expected.maxAmount  base-unit ceiling; the challenge may ask for less, never more
 * @param {number} [expected.maxTtlMs] reject a challenge whose expiry is further out than this from
 *   `nowMs`. Defaults to 15 minutes — three times this repo's own default TTL — so a legitimately
 *   slow caller is not punished but a challenge engineered to stay valid indefinitely is refused.
 * @param {number} nowMs
 */
export function validateChallenge(challenge, expected, nowMs) {
  if (!challenge || typeof challenge !== 'object')
    throw new ChallengeMismatchError('is missing or not an object', { challenge });

  if (challenge.x402Version !== 2)
    throw new ChallengeMismatchError('x402Version-mismatch', { got: challenge.x402Version, want: 2 });

  // This module signs EIP-3009 `transferWithAuthorization` only. A server asking for any other
  // scheme (e.g. `exact-svm`) gets a named refusal, not a best-effort attempt to sign the wrong
  // shape — the same principle `checkEnvelopeAgainstPrice` applies server-side to a client-chosen
  // scheme (apps/api/src/x402.mjs).
  if (challenge.scheme !== 'exact')
    throw new ChallengeMismatchError('scheme-unsupported', { got: challenge.scheme, want: 'exact' });

  if (typeof challenge.asset !== 'string' || challenge.asset.toLowerCase() !== String(expected.asset).toLowerCase())
    throw new ChallengeMismatchError('asset-mismatch', { got: challenge.asset, want: expected.asset });

  if (typeof challenge.payTo !== 'string' || challenge.payTo.toLowerCase() !== String(expected.payTo).toLowerCase())
    throw new ChallengeMismatchError('payto-mismatch', { got: challenge.payTo, want: expected.payTo });

  if (typeof challenge.network !== 'string' || challenge.network.toLowerCase() !== String(expected.network).toLowerCase())
    throw new ChallengeMismatchError('network-mismatch', { got: challenge.network, want: expected.network });

  // STRICT DECIMAL SHAPE, NOT JUST "BigInt() ACCEPTS IT". `BigInt` happily parses `"0x186a0"` and
  // whitespace-padded strings, so checking `BigInt(challenge.amount) <= max` alone validates a
  // NUMERIC VIEW of the amount while `authorizeFromChallenge` (packages/agent-sdk/src/eip3009.mjs)
  // signs `challenge.amount` VERBATIM as `authorization.value` — a hex-spelled amount that BigInt
  // reads as within budget would still be the string actually signed, and downstream typed-data
  // encoding of that string is not guaranteed to agree with the value just validated. Requiring the
  // canonical decimal shape this repo's own `buildChallenge` always emits ties what is checked to
  // what is signed, with no gap for a differently-spelled-but-numerically-equal string to hide in.
  if (typeof challenge.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(challenge.amount))
    throw new ChallengeMismatchError('bad-amount', { got: challenge.amount });
  const amount = BigInt(challenge.amount);
  const maxAmount = BigInt(expected.maxAmount);
  if (amount > maxAmount)
    throw new ChallengeMismatchError('amount-exceeds-max', { got: amount.toString(), max: maxAmount.toString() });

  // Same reasoning as the amount check, one field over: `challenge.nonce` is reused verbatim as
  // the EIP-3009 authorization's on-chain nonce (`apps/api/src/x402.mjs:48-56`'s comment), so an
  // unchecked shape here is an unchecked shape in what gets signed. This repo's own `buildChallenge`
  // always emits `0x` + 64 lowercase hex chars (32 bytes); accept exactly that.
  if (typeof challenge.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(challenge.nonce))
    throw new ChallengeMismatchError('bad-nonce', { got: challenge.nonce });

  const expiresAt = Number(challenge.expiresAt);
  if (!Number.isFinite(expiresAt))
    throw new ChallengeMismatchError('bad-expiry', { got: challenge.expiresAt });
  if (expiresAt <= nowMs)
    throw new ChallengeMismatchError('challenge-expired', { expiresAt, nowMs });
  const maxTtlMs = expected.maxTtlMs ?? 15 * 60_000;
  if (expiresAt - nowMs > maxTtlMs)
    throw new ChallengeMismatchError('challenge-ttl-too-long', { expiresAt, nowMs, maxTtlMs });
}

/**
 * Wrap a viem local account (the object `privateKeyToAccount`/`loadAccountFromKeystore` return)
 * as a `sign` callback for `authorizeFromChallenge`. Slims the typed-data `types` down to just
 * `TransferWithAuthorization` before handing it to `account.signTypedData` — viem derives
 * `EIP712Domain` from `domain` itself, so passing it explicitly is redundant and this is the same
 * shape `scripts/live-x402-run.mjs` already signs with against a real chain.
 * @param {{signTypedData:(td:object)=>Promise<string>}} account
 */
export function signerFromAccount(account) {
  return (typedData) =>
    account.signTypedData({
      domain: typedData.domain,
      types: { TransferWithAuthorization: typedData.types.TransferWithAuthorization },
      primaryType: 'TransferWithAuthorization',
      message: typedData.message,
    });
}

const b64 = (obj) => {
  const s = JSON.stringify(obj);
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'utf8').toString('base64');
};

/**
 * The full buyer loop: GET unpaid → validate the 402 challenge against `expected` → sign → retry
 * with `PAYMENT-SIGNATURE` → return the body and the settlement receipt.
 *
 * If the resource turns out to be free (a bare 200 on the first request), returns immediately with
 * `paid:false` and never calls `sign` — some routes are unmetered (`apps/api/src/server.mjs`'s
 * `FREE_ROUTES`, or an x402-disabled chain per its `x402.enabled` capability) and a buyer must not
 * treat "didn't need to pay" as an error.
 *
 * @param {Object} p
 * @param {string} p.url
 * @param {Parameters<typeof validateChallenge>[1]} p.expected
 * @param {string} p.walletAddress  the payer address (`authorization.from`)
 * @param {{name:string, version:string, chainId:number, verifyingContract:string}} p.domain
 * @param {(typedData:object) => Promise<string>} p.sign
 * @param {typeof fetch} [p.fetchImpl]
 * @param {() => number} [p.nowSec]
 * @param {number} [p.skewSec]
 * @param {Record<string,string>} [p.extraHeaders]
 * @returns {Promise<{paid:boolean, status:number, data:any, receipt:object|null, challenge:object|null, envelope:object|null}>}
 */
export async function buyResource({
  url,
  expected,
  walletAddress,
  domain,
  sign,
  fetchImpl = fetch,
  nowSec = () => Math.floor(Date.now() / 1000),
  skewSec,
  extraHeaders = {},
}) {
  const first = await fetchImpl(url, { headers: extraHeaders });

  if (first.status === 200) {
    const data = await first.json().catch(() => ({}));
    return { paid: false, status: 200, data, receipt: null, challenge: null, envelope: null };
  }

  if (first.status !== 402) {
    const body = await first.json().catch(() => null);
    throw new PaymentFailedError(`expected 402 or 200, got ${first.status}`, { status: first.status, body });
  }

  const challenge = parseChallengeHeader(first.headers.get('payment-required'));
  if (!challenge) {
    throw new PaymentFailedError('402 response carried no valid PAYMENT-REQUIRED challenge', { status: 402 });
  }

  // Everything above this line only inspects what the server sent. Nothing is signed until the
  // challenge passes validation against the caller's own expectations.
  validateChallenge(challenge, expected, Date.now());

  const envelope = await authorizeFromChallenge({
    challenge,
    walletAddress,
    domain,
    sign,
    nowSec: nowSec(),
    ...(skewSec === undefined ? {} : { skewSec }),
  });

  const second = await fetchImpl(url, {
    headers: { ...extraHeaders, 'payment-signature': b64(envelope) },
  });
  const body = await second.json().catch(() => ({}));

  if (second.status !== 200) {
    // A 402 here means settlement was attempted and refused (e.g. `settlement failed: …` from
    // `gate` in apps/api/src/x402.mjs) — the authorization was signed once already; this module
    // does not retry with a second signature.
    throw new PaymentFailedError(body?.error ?? `payment rejected with status ${second.status}`, {
      status: second.status,
      body,
      challenge,
    });
  }

  const receipt = parseReceiptHeader(second.headers.get('payment-response'));
  return { paid: true, status: 200, data: body, receipt, challenge, envelope };
}

/**
 * Parse a decimal USDC string (at most 6 decimal places) into base units. Pure and exact — no
 * floats — same parsing rule `scripts/live-x402-run.mjs`'s `resolveRunConfig` applies to `--price`
 * and `--fund`, duplicated here rather than imported because that script's `toBase` is a private
 * closure, not an export.
 * @param {string} value
 * @param {string} name  for the error message, e.g. "--max"
 */
export function parseUsdcAmount(value, name) {
  const s = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`${name} must be a USDC amount with at most 6 decimals, got ${s}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0') || '0');
}

/** @param {string} v */
export function isAddress(v) {
  return typeof v === 'string' && ADDR_RE.test(v);
}

export { buildTypedData };
