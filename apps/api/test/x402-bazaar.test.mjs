// @ts-check
/**
 * Bazaar cataloguing and the EIP-712 domain — the three things that stood between a settled
 * payment and a catalogue entry (issue #290), pinned so none of them can silently revert.
 *
 * WHERE THE EXPECTED SHAPES COME FROM. Not from vendor documentation. Every shape asserted below
 * was read on 2026-09-16 from entries this facilitator has actually catalogued:
 *
 *     curl -s "https://facilitator.payai.network/discovery/resources?limit=40"
 *
 * THE COUNTS FROM THAT ENDPOINT MOVE BETWEEN READS — it is a live catalogue, and two reads minutes
 * apart in the session that wrote this file returned different numbers of EVM entries. So nothing
 * below pins a count. What it pins is the INVARIANT that held across every entry in both reads:
 *
 *   - `resource` is an ABSOLUTE url, and path parameters template into it as `:name` — e.g.
 *     `https://api.paysponge.com/v0/inboxes/:inbox_id/messages` is a real catalogued key.
 *   - `extensions.bazaar.info.input` is at minimum `{type:'http', method}`; `output` is
 *     `{type, example}`; `schema` is an optional JSON Schema.
 *   - every entry settling Circle USDC on Base mainnet carries exactly one distinct `extra`,
 *     `{name: 'USD Coin', version: '2'}` — `{name, version}`, and nothing else.
 *
 * THE MUTATION TEST FOR THIS FILE, since a guard that passes with and without the defect is
 * decorative. Each test below names the single edit that reddens it, so the check is reproducible
 * by hand rather than asserted to have been done.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, buildChallenge, buildResourceInfo } from '../src/x402.mjs';
import { createStandardHttpFacilitator } from '../src/facilitator.mjs';
import { createApi } from '../src/server.mjs';

const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + 'd'.repeat(40);
const price = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' };

/** The minimum entry shape seen in the wild, and what this API declares for a collection route. */
const BAZAAR = { info: { input: { type: 'http', method: 'GET' }, output: { type: 'json' } } };

/** A minimal valid EVM envelope, shaped like `api.test.mjs`'s own helper. */
function envelope({ nonce, value = '10000', to = PAYTO, asset = USDC, network = 'base', validBefore = 0 } = {}) {
  return { x402Version: 2, network, signature: '0xsig', authorization: { asset, to, value, nonce, validBefore } };
}

/** A stricter envelope: `verifyEnvelopeShape` in facilitator.mjs checks `from`, the 65-byte
 *  signature, a 32-byte nonce and expiry, none of which gate()'s own check looks at. */
function wireEnvelope(nonceByte) {
  return {
    x402Version: 2,
    network: 'base',
    signature: '0x' + '1'.repeat(130),
    authorization: {
      from: '0x' + 'a'.repeat(40), to: PAYTO, value: '10000', asset: USDC,
      validAfter: '0', validBefore: String(Date.now() + 600_000),
      nonce: '0x' + String(nonceByte).repeat(64),
    },
  };
}

const okFacilitator = { verifyAndSettle: async () => ({ ok: true, receiptId: '0xreceipt' }) };

/** Records what gate() hands the facilitator, so the catalogue fields can be inspected. */
function recordingFacilitator() {
  const seen = [];
  return { seen, verifyAndSettle: async (challenge, envelope) => { seen.push({ challenge, envelope }); return { ok: true, receiptId: '0xr' }; } };
}

// ---------------------------------------------------------------------------------------------
// 1. The challenge carries the bazaar entry.
// ---------------------------------------------------------------------------------------------

test('buildChallenge puts the caller\'s bazaar entry in extensions, under the `bazaar` key', () => {
  const c = buildChallenge(price, { nowMs: 1000, bazaar: BAZAAR });
  assert.deepEqual(c.extensions, { bazaar: BAZAAR });
});

test('buildChallenge still emits an EMPTY extensions map when no entry is supplied', () => {
  // Not an oversight and not a placeholder: `extensions` is Required-but-may-be-empty in
  // §5.1.1, and every pre-existing conformance test asserts `deepEqual(extensions, {})`. A
  // change that made the key conditional would break a conformant client that reads it.
  // Mutation: make `extensions` conditional on `opts.bazaar` and this reddens.
  assert.deepEqual(buildChallenge(price, { nowMs: 1000 }).extensions, {});
});

// ---------------------------------------------------------------------------------------------
// 2. The facilitator is told the two things cataloguing reads.
// ---------------------------------------------------------------------------------------------

test('gate() forwards resource AND extensions to the facilitator, not the price alone', async () => {
  // This is the defect that made the other two fixes inert: the call was `verifyAndSettle({price})`,
  // so a perfectly formed bazaar entry in the 402 never reached the thing that catalogues it.
  // Mutation: drop `resource`/`extensions` from the verifyAndSettle argument and this reddens.
  const fac = recordingFacilitator();
  const env = envelope({ nonce: '0xn9' });
  const v = await gate({
    headers: { 'payment-signature': Buffer.from(JSON.stringify(env), 'utf8').toString('base64') },
    price, facilitator: fac, nowMs: Date.now(),
    resource: { url: 'https://api.example.com/vaults' },
    bazaar: BAZAAR,
  });
  assert.equal(v.status, 200, 'the payment should settle; otherwise this test is checking nothing');
  assert.equal(fac.seen.length, 1);
  assert.deepEqual(fac.seen[0].challenge.resource, { url: 'https://api.example.com/vaults' });
  assert.deepEqual(fac.seen[0].challenge.extensions, { bazaar: BAZAAR });
  assert.equal(fac.seen[0].challenge.price, price, 'price must still be the same object it always was');
});

test('gate() OMITS resource and extensions rather than sending them empty', async () => {
  // An empty `resource` is a catalogue key of `''`, which collides with every other seller that
  // sent the same thing — strictly worse than absent. It also keeps this argument byte-identical
  // for callers that supply neither, which `facilitator-server`'s wire-contract test pins.
  // Mutation: send them unconditionally and that wire-contract test reddens alongside this one.
  const fac = recordingFacilitator();
  const env = envelope({ nonce: '0xn8' });
  const v = await gate({
    headers: { 'payment-signature': Buffer.from(JSON.stringify(env), 'utf8').toString('base64') },
    price, facilitator: fac, nowMs: Date.now(),
  });
  assert.equal(v.status, 200);
  assert.deepEqual(Object.keys(fac.seen[0].challenge), ['price']);
});

test('the standard facilitator POSTs resource and extensions inside the PaymentPayload', async () => {
  // Cataloguing reads them off `PaymentPayload`, so forwarding them into gate() is only half the
  // path. Mutation: drop either spread from `paymentPayload` and this reddens.
  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => (String(url).endsWith('/verify') ? { isValid: true } : { success: true, transaction: '0xtx' }) };
  };
  const fac = createStandardHttpFacilitator({ url: 'https://f.example', network: 'eip155:8453', fetchImpl });
  const out = await fac.verifyAndSettle(
    { price, resource: { url: 'https://api.example.com/vaults' }, extensions: { bazaar: BAZAAR } },
    wireEnvelope(7),
  );
  assert.equal(out.ok, true, out.reason ?? '');
  assert.ok(posted.length >= 1);
  const payload = posted[0].body.paymentPayload;
  assert.deepEqual(payload.resource, { url: 'https://api.example.com/vaults' });
  assert.deepEqual(payload.extensions, { bazaar: BAZAAR });
});

test('the standard facilitator omits both when the caller supplies neither', () => {
  // Same reason as gate()'s omission, one layer down: an empty catalogue key is worse than none.
  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => (String(url).endsWith('/verify') ? { isValid: true } : { success: true, transaction: '0xtx' }) };
  };
  const fac = createStandardHttpFacilitator({ url: 'https://f.example', network: 'eip155:8453', fetchImpl });
  return fac.verifyAndSettle({ price }, wireEnvelope(6)).then(() => {
    const payload = posted[0].paymentPayload;
    assert.equal('resource' in payload, false);
    assert.equal('extensions' in payload, false);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The EIP-712 domain the payer has to sign against.
// ---------------------------------------------------------------------------------------------

test('the standard facilitator publishes the exact domain it will demand', () => {
  // `{name, version}` and nothing else — the projection every catalogued Base-mainnet entry shows.
  // `readUsdcDomain` returns those two plus chainId, verifyingContract and both separators, so a
  // call site that spread its whole return would advertise four fields the spec does not define.
  const fac = createStandardHttpFacilitator({ url: 'https://f.example', network: 'eip155:8453' });
  assert.deepEqual(fac.extra, { name: 'USD Coin', version: '2' });
  assert.deepEqual(Object.keys(fac.extra).sort(), ['name', 'version']);
});

test('a configured domain is published instead of the Base default — the USDG case', () => {
  // USDG on chain 4663 is `Global Dollar`/`1`, and it exposes no version() getter, so it cannot be
  // read off the token at all. It has to come from configuration, and the default is wrong for it.
  const fac = createStandardHttpFacilitator({ url: 'https://f.example', network: 'eip155:4663', usdcName: 'Global Dollar', usdcVersion: '1' });
  assert.deepEqual(fac.extra, { name: 'Global Dollar', version: '1' });
});

test('a challenge built from a price carrying extra advertises it in accepts[0]', () => {
  const c = buildChallenge({ ...price, extra: { name: 'USD Coin', version: '2' } }, { nowMs: 1000 });
  assert.deepEqual(c.accepts[0].extra, { name: 'USD Coin', version: '2' });
});

test('a price without extra still omits it, rather than guessing a domain', () => {
  // Guessing is the one thing that must not happen: the domain differs per chain, and a wrong one
  // fails AFTER the payer has signed. Mutation: default `extra` in buildChallenge and this reddens.
  assert.equal('extra' in buildChallenge(price, { nowMs: 1000 }).accepts[0], false);
});

// ---------------------------------------------------------------------------------------------
// 4. The catalogue key: absolute, templated, and never taken from the client.
// ---------------------------------------------------------------------------------------------

test('buildResourceInfo is the one builder, and drops the optional fields it was not given', () => {
  assert.deepEqual(buildResourceInfo({ url: '/x' }), { url: '/x' });
  assert.deepEqual(buildResourceInfo({ url: '/x', mimeType: 'application/json' }), { url: '/x', mimeType: 'application/json' });
  assert.deepEqual(buildResourceInfo(undefined), { url: '' });
});

/** Drive one unpaid GET through the real API and return the decoded 402 challenge. */
async function challengeFor(path, { publicBaseUrl = null, headers = {} } = {}) {
  const api = createApi({
    state: { vaults: new Map(), lastBlock: 0 },
    facilitator: okFacilitator, price, publicBaseUrl,
  });
  const res = await api.handle('GET', path, headers);
  assert.equal(res.status, 402, `expected a 402 for ${path}`);
  return JSON.parse(res.body);
}

test('resource.url is ABSOLUTE when the public origin is configured', async () => {
  // Every catalogued entry keys on a full url; a bare `/vaults` collides with every other seller
  // that published a path. Mutation: ignore publicBaseUrl and this reddens.
  const body = await challengeFor('/vaults', { publicBaseUrl: 'https://api.rwally.com' });
  assert.equal(body.resource.url, 'https://api.rwally.com/vaults');
});

test('resource.url falls back to the bare path when no origin is configured', async () => {
  const body = await challengeFor('/vaults');
  assert.equal(body.resource.url, '/vaults');
});

test('the Host header CANNOT choose what this seller is catalogued as', async () => {
  // Host is client-supplied. Deriving the catalogue key from it would let any caller list this
  // seller under a domain of their choosing with one request. Mutation: fall back to the Host
  // header when publicBaseUrl is unset and this reddens.
  const body = await challengeFor('/vaults', { headers: { host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com' } });
  assert.equal(body.resource.url, '/vaults');
  assert.ok(!JSON.stringify(body).includes('evil.example.com'), 'no client-supplied host may appear anywhere in the challenge');
});

test('a parameterised route is catalogued as the ROUTE, with :name placeholders', async () => {
  // Catalogued under the concrete url the caller happened to request, this API would publish one
  // vault per payment and never the route. Mutation: use `path` instead of the template and this
  // reddens.
  const one = await challengeFor('/vaults/0x' + 'a'.repeat(40), { publicBaseUrl: 'https://api.rwally.com' });
  assert.equal(one.resource.url, 'https://api.rwally.com/vaults/:address');
  assert.deepEqual(one.extensions.bazaar.info.input.pathParams, { address: '' });

  const member = await challengeFor(`/vaults/0x${'a'.repeat(40)}/members/0x${'b'.repeat(40)}`, { publicBaseUrl: 'https://api.rwally.com' });
  assert.equal(member.resource.url, 'https://api.rwally.com/vaults/:address/members/:member');
  assert.deepEqual(member.extensions.bazaar.info.input.pathParams, { address: '', member: '' });
});

test('every metered route that resolves declares a bazaar entry shaped like a live one', async () => {
  for (const path of ['/vaults', '/operators/leaderboard']) {
    const body = await challengeFor(path);
    const entry = body.extensions.bazaar;
    assert.ok(entry, `${path} declares no bazaar entry, so it can never be catalogued`);
    assert.equal(entry.info.input.type, 'http');
    assert.equal(entry.info.input.method, 'GET');
    assert.equal(entry.info.output.type, 'json');
    assert.equal(typeof entry.info.description, 'string');
    assert.ok(entry.info.description.length > 0);
  }
});

test('an UNKNOWN path is gated but never catalogued', async () => {
  // Unknown paths are gated before route resolution, so they reach the catalogue lookup. Indexing
  // one would publish a resource that answers nothing. Mutation: return an entry from the fallback
  // branch and this reddens.
  const body = await challengeFor('/not-a-route');
  assert.deepEqual(body.extensions, {});
  assert.equal(body.resource.url, '/not-a-route');
});
