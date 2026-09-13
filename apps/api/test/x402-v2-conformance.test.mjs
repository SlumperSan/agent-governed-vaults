// @ts-check
/**
 * x402 v2 wire conformance — pins the emitted 402 body and the accepted payment envelope to the
 * shapes documented in `coinbase/x402`'s `specs/x402-specification-v2.md` (downloaded via
 * `gh api repos/coinbase/x402/contents/specs/x402-specification-v2.md`) and
 * `specs/schemes/exact/scheme_exact_evm.md`, field by field, so the shape cannot silently drift
 * back to the flat, non-conformant form without a test going red.
 *
 * This is the durable deliverable for the x402 v2 conformance work: `apps/api/src/x402.mjs`'s
 * module header documents each divergence found and fixed, with the spec section number; this
 * file is the regression pin for that fix.
 *
 * Every JSON literal below (the `accepts[0]` object, the `payload`/`accepted` envelope) is
 * transcribed directly from the spec's own example JSON at the section cited in each test's name
 * — not paraphrased, not inferred.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, buildChallenge, decodeSignatureHeader, checkEnvelopeAgainstPrice, HEADERS } from '../src/x402.mjs';
import { checkChallengePrice } from '../src/facilitator-server.mjs';

const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + 'd'.repeat(40);
const price = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base-sepolia' }; // $0.01

const okFacilitator = {
  async verifyAndSettle() {
    return { ok: true, receiptId: 'rcpt_1' };
  },
};

// ---------------------------------------------------------------------------------------------
// §5.1.1 — the 402 PaymentRequired body / `accepts[]` PaymentRequirements object.
// ---------------------------------------------------------------------------------------------

test('402 body §5.1.1: x402Version, resource, accepts and extensions are all present', async () => {
  const v = await gate({ headers: {}, price, facilitator: okFacilitator, nowMs: 1000 });
  assert.equal(v.status, 402);
  const body = v.body;

  // The four spec-required/optional top-level fields (§5.1.2's table: x402Version, error,
  // resource, accepts, extensions).
  assert.equal(body.x402Version, 2);
  assert.equal(typeof body.error, 'string');
  assert.equal(typeof body.resource, 'object');
  assert.ok(Array.isArray(body.accepts), 'accepts must be an array');
  assert.equal(body.accepts.length, 1);
  assert.equal(typeof body.extensions, 'object');
  assert.deepEqual(body.extensions, {});
});

test('402 body §5.1.1: the PAYMENT-REQUIRED header carries the same accepts/resource/extensions', async () => {
  const v = await gate({ headers: {}, price, facilitator: okFacilitator, nowMs: 1000 });
  const header = JSON.parse(v.headers[HEADERS.REQUIRED]);
  assert.equal(header.x402Version, 2);
  assert.ok(Array.isArray(header.accepts));
  assert.equal(header.accepts.length, 1);
  assert.equal(typeof header.resource, 'object');
  assert.deepEqual(header.extensions, {});
});

test('accepts[0] §5.1.2: exactly the documented PaymentRequirements fields, right types, right values', async () => {
  const v = await gate({
    headers: {},
    price,
    facilitator: okFacilitator,
    nowMs: 1000,
    resource: { url: '/vaults' },
  });
  const [req] = v.body.accepts;

  // §5.1.2's table: scheme, network, amount, asset, payTo, maxTimeoutSeconds (all Required),
  // extra (Optional). Check field-by-field against the spec's example JSON at §5.1.1:
  //   { "scheme": "exact", "network": "eip155:84532", "amount": "10000",
  //     "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  //     "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  //     "maxTimeoutSeconds": 60, "extra": {"name": "USDC", "version": "2"} }
  assert.equal(req.scheme, 'exact');
  assert.equal(typeof req.network, 'string');
  assert.equal(typeof req.amount, 'string');
  assert.equal(typeof req.asset, 'string');
  assert.equal(typeof req.payTo, 'string');
  assert.equal(typeof req.maxTimeoutSeconds, 'number');

  // Values, not just types, against THIS price/opts:
  assert.equal(req.amount, price.amount);
  assert.equal(req.asset, price.asset);
  assert.equal(req.payTo, price.payTo);
  assert.equal(req.maxTimeoutSeconds, 300, 'default TTL is 5 minutes = 300s');

  // §11.1: network MUST be CAIP-2 (`namespace:reference`), e.g. `eip155:84532` for Base Sepolia —
  // never the repo's own shorthand ("base-sepolia") that used to be emitted here.
  assert.equal(req.network, 'eip155:84532');
});

test('accepts[0].network §11.1: Base mainnet maps to eip155:8453', () => {
  const c = buildChallenge({ ...price, network: 'base' }, { nowMs: 1000 });
  assert.equal(c.accepts[0].network, 'eip155:8453');
});

test('accepts[0].extra §5.1.2: populated only when price.extra is supplied — never hardcoded', () => {
  // Omitted: `facilitator.mjs`'s `readUsdcDomain` documents that the USDC EIP-712 domain name
  // varies per chain ("USDC" on Base Sepolia, "USD Coin" on mainnet); this module has no chain
  // access, so it must not guess. No `price.extra` -> no `extra` key at all (spec §5.1.2: Optional).
  const withoutExtra = buildChallenge(price, { nowMs: 1000 });
  assert.equal('extra' in withoutExtra.accepts[0], false);

  // Supplied: the caller's domain is echoed verbatim, not replaced by any built-in default.
  const withExtra = buildChallenge({ ...price, extra: { name: 'USDC', version: '2' } }, { nowMs: 1000 });
  assert.deepEqual(withExtra.accepts[0].extra, { name: 'USDC', version: '2' });
});

test('resource §5.1.1: ResourceInfo carries the url the caller supplied', async () => {
  const v = await gate({
    headers: {},
    price,
    facilitator: okFacilitator,
    nowMs: 1000,
    resource: { url: '/vaults', description: 'Indexed vault state', mimeType: 'application/json' },
  });
  assert.deepEqual(v.body.resource, {
    url: '/vaults',
    description: 'Indexed vault state',
    mimeType: 'application/json',
  });
});

// ---------------------------------------------------------------------------------------------
// Backward compatibility: the legacy flat fields this repo's own consumers read must survive.
// packages/agent-sdk/src/index.mjs:71 does `JSON.parse(res.headers.get('payment-required'))` and
// hands the WHOLE object straight to `authorizeFromChallenge`, which reads `.payTo`/`.amount`/
// `.nonce`/`.asset`/`.network` off the TOP level — so the superset shape must keep those flat.
// ---------------------------------------------------------------------------------------------

test('backward compat: legacy flat challenge fields are unchanged by the v2 additions', async () => {
  const v = await gate({ headers: {}, price, facilitator: okFacilitator, nowMs: 1000 });
  const ch = JSON.parse(v.headers[HEADERS.REQUIRED]);
  assert.equal(ch.scheme, 'exact');
  assert.equal(ch.asset, price.asset);
  assert.equal(ch.amount, price.amount);
  assert.equal(ch.payTo, price.payTo);
  assert.equal(ch.network, price.network, 'flat network stays the repo shorthand, not CAIP-2');
  assert.equal(typeof ch.nonce, 'string');
  assert.equal(typeof ch.expiresAt, 'number');
});

test('backward compat: body still carries the legacy nested `challenge` key some callers read', async () => {
  // scripts/soak/api-client.mjs:53-54 falls back to `(await first.json()).challenge` when the
  // header is unavailable, and checks `challenge.scheme` to recognise the flat shape.
  const v = await gate({ headers: {}, price, facilitator: okFacilitator, nowMs: 1000 });
  assert.equal(typeof v.body.challenge, 'object');
  assert.equal(v.body.challenge.scheme, 'exact');
  assert.equal(v.body.challenge.asset, price.asset);
});

// ---------------------------------------------------------------------------------------------
// §5.2.1/§5.2.2 — the accepted PaymentPayload envelope. Every literal here is the spec's own
// example JSON at that section, with only the values swapped for this test's fixtures.
// ---------------------------------------------------------------------------------------------

/** Base64-encode a PAYMENT-SIGNATURE envelope, exactly as a real client would send it. */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

test('decodeSignatureHeader §5.2.1: accepts the spec-nested envelope shape', () => {
  // Transcribed from §5.2.1's example, with this test's own asset/payTo/amount:
  //   { "x402Version": 2, "resource": {...}, "accepted": {scheme, network, amount, asset, payTo,
  //     maxTimeoutSeconds, extra}, "payload": {"signature": "0x...", "authorization": {from, to,
  //     value, validAfter, validBefore, nonce}}, "extensions": {} }
  const specEnvelope = {
    x402Version: 2,
    resource: { url: '/vaults', description: 'Indexed vault state', mimeType: 'application/json' },
    accepted: {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      asset: USDC,
      payTo: PAYTO,
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    },
    payload: {
      signature: '0x' + '2'.repeat(130),
      authorization: {
        from: '0x' + '7'.repeat(40),
        to: PAYTO,
        value: '10000',
        validAfter: '1740672089',
        validBefore: '9999999999',
        nonce: '0x' + 'f'.repeat(64),
      },
    },
    extensions: {},
  };

  const decoded = decodeSignatureHeader(b64(specEnvelope));
  assert.notEqual(decoded, null, 'a spec-nested envelope must decode, not 402 forever');

  // Normalized to the flat shape checkEnvelopeAgainstPrice/gate() already read.
  assert.equal(decoded.signature, specEnvelope.payload.signature);
  assert.equal(decoded.authorization.from, specEnvelope.payload.authorization.from);
  assert.equal(decoded.authorization.to, PAYTO);
  assert.equal(decoded.authorization.value, '10000');
  assert.equal(decoded.authorization.nonce, specEnvelope.payload.authorization.nonce);
  // §5.2.2's Authorization has no `asset` field; it must be backfilled from `accepted.asset`.
  assert.equal(decoded.authorization.asset, USDC);
  // network is hoisted from `accepted.network` (still CAIP-2 at this point; checkEnvelopeAgainstPrice
  // is what maps it against the repo-shorthand price.network).
  assert.equal(decoded.network, 'eip155:84532');

  // The original nested fields are preserved too, not dropped.
  assert.equal(decoded.accepted.scheme, 'exact');
  assert.deepEqual(decoded.payload.authorization, specEnvelope.payload.authorization);
});

test('checkEnvelopeAgainstPrice + gate(): a spec-nested envelope settles end to end against a base-sepolia price', async () => {
  // THE REGRESSION THIS PINS (PR review, MAJOR-1). This test used to stub `verifyAndSettle` with
  // an always-`ok:true` spy and assert only on the fields the spy happened to echo back — so it
  // was named "settles end to end" while never exercising the ONE leg where the actual defect
  // lived. `gate()` hoists a spec-nested envelope's `network` from `accepted.network`, which is
  // CAIP-2 (`eip155:84532`); `checkEnvelopeAgainstPrice` (x402.mjs) already normalized that
  // through `networksEqual`, but `facilitator-server.mjs`'s `checkChallengePrice` — the SAME
  // relay guard a real `FACILITATOR=http` deployment runs on every `POST /settle` — compared it
  // by exact lowercase string equality against the repo-shorthand `price.network`. Every
  // correctly-signed v2 envelope failed there as `network-mismatch`, so the capability this PR's
  // title claims did not actually hold end to end. The facilitator spy below now genuinely calls
  // `checkChallengePrice`, so a regression here fails this test again instead of passing quietly.
  const specEnvelope = {
    x402Version: 2,
    resource: { url: '/vaults' },
    accepted: {
      scheme: 'exact',
      network: 'eip155:84532', // CAIP-2 — must match price.network:'base-sepolia' via networksEqual
      amount: '10000',
      asset: USDC,
      payTo: PAYTO,
      maxTimeoutSeconds: 60,
    },
    payload: {
      signature: '0x' + '3'.repeat(130),
      authorization: {
        from: '0x' + '8'.repeat(40),
        to: PAYTO,
        value: '10000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x' + 'a'.repeat(64),
      },
    },
    extensions: {},
  };

  const decoded = decodeSignatureHeader(b64(specEnvelope));
  assert.equal(checkEnvelopeAgainstPrice(price, decoded, 1000).ok, true);

  let seenEnvelope = null;
  // A REAL relay guard, not a stub that always says yes: exactly what `startFacilitatorServer`
  // wires `verifyAndSettle` behind in production (`facilitator-server.mjs`'s `createSettleHandler`
  // runs `checkChallengePrice` before ever touching a chain client).
  const relayFacilitator = {
    async verifyAndSettle(challenge, e) {
      seenEnvelope = e;
      const check = checkChallengePrice(challenge, e);
      if (!check.ok) return { ok: false, reason: check.reason };
      return { ok: true, receiptId: 'r' };
    },
  };
  const v = await gate({
    headers: { [HEADERS.SIGNATURE]: b64(specEnvelope) },
    price,
    facilitator: relayFacilitator,
    nowMs: 1000,
  });
  assert.equal(v.status, 200, `expected settlement, got ${v.status} ${JSON.stringify(v.body)}`);
  assert.equal(v.receiptId, 'r');
  // The facilitator receives the normalized flat authorization, not the spec-nested one, AND its
  // own network re-check (checkChallengePrice) must independently agree the network matches —
  // this is the assertion the previous version of this test was missing.
  assert.equal(seenEnvelope.authorization.asset, USDC);
  assert.equal(seenEnvelope.authorization.to, PAYTO);
  assert.equal(checkChallengePrice({ price }, seenEnvelope).ok, true, 'the relay guard must independently accept the CAIP-2 network too');
});

test('checkChallengePrice §11.1 (facilitator-server.mjs): CAIP-2 network matches its repo-shorthand price in both directions', () => {
  // Direct, minimal pin for MAJOR-1: BEFORE the fix, `checkChallengePrice` compared
  // `envelope.network` to `price.network` with exact lowercase string equality, so this returned
  // `{ok:false, reason:'network-mismatch'}` for a perfectly valid v2 envelope.
  const shorthandPrice = { price: { network: 'base-sepolia' } };
  const caip2Envelope = { authorization: {}, network: 'eip155:84532' };
  assert.equal(checkChallengePrice(shorthandPrice, caip2Envelope).ok, true);

  const caip2Price = { price: { network: 'eip155:84532' } };
  const shorthandEnvelope = { authorization: {}, network: 'base-sepolia' };
  assert.equal(checkChallengePrice(caip2Price, shorthandEnvelope).ok, true);

  // And a genuinely different chain must still be refused under the normalization.
  const mainnetEnvelope = { authorization: {}, network: 'eip155:8453' };
  const r = checkChallengePrice(shorthandPrice, mainnetEnvelope);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'network-mismatch');
});

test('decodeSignatureHeader: still accepts the legacy flat envelope, byte for byte (regression)', () => {
  // The exact shape docs/X402-LIVE-REPORT.md's live Base Sepolia settlement used, and what
  // packages/agent-sdk/src/eip3009.mjs's buildEnvelope still produces today.
  const legacy = {
    x402Version: 2,
    scheme: 'exact',
    network: 'base-sepolia',
    signature: '0x' + '4'.repeat(130),
    authorization: {
      from: '0x' + '9'.repeat(40),
      to: PAYTO,
      value: '10000',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: '0x' + 'b'.repeat(64),
      asset: USDC,
    },
  };
  const decoded = decodeSignatureHeader(b64(legacy));
  assert.deepEqual(decoded, legacy, 'a legacy envelope must decode completely unchanged');
});

test('checkEnvelopeAgainstPrice: a CAIP-2 envelope network matches a repo-shorthand price network', () => {
  const r = checkEnvelopeAgainstPrice(
    price, // network: 'base-sepolia'
    { authorization: { asset: USDC, to: PAYTO, value: '10000' }, network: 'eip155:84532' },
    1000,
  );
  assert.equal(r.ok, true);
});

test('checkEnvelopeAgainstPrice: a repo-shorthand envelope network matches a CAIP-2 price network', () => {
  const caip2Price = { ...price, network: 'eip155:84532' };
  const r = checkEnvelopeAgainstPrice(
    caip2Price,
    { authorization: { asset: USDC, to: PAYTO, value: '10000' }, network: 'base-sepolia' },
    1000,
  );
  assert.equal(r.ok, true);
});

test('checkEnvelopeAgainstPrice: a genuinely different network is still rejected under CAIP-2 normalization', () => {
  const r = checkEnvelopeAgainstPrice(
    price, // 'base-sepolia' == eip155:84532
    { authorization: { asset: USDC, to: PAYTO, value: '10000' }, network: 'eip155:8453' }, // Base mainnet
    1000,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'network-mismatch');
});
