// @ts-check
/**
 * The edge route that takes money.
 *
 * WHAT THESE TESTS ARE FOR. Two prior guards in this repository passed something they existed to
 * block: an `assert(!rewired)` satisfied by any transport failure, and a dropped `workflowName` that
 * turned a self-exclusion into a no-op. Both were green. The equivalent failure here is a route that
 * serves the paid body without a settled payment, so the first test below is the one that matters
 * and it asserts on the BODY, not on the status code alone — a 200 with the payload is the harm, and
 * a test that only checks `status !== 200` would pass on a 500 that also leaked the body.
 *
 * The routes are Cloudflare Pages Functions: plain ES modules exporting `onRequestGet(context)`.
 * They need no Workers runtime to test, only a `context` with `request` and `env`, so these run in
 * `node --test` alongside everything else rather than in a separate harness nothing runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet as vaults } from '../functions/api/vaults.js';
import { onRequestGet as discovery } from '../functions/.well-known/x402.js';
import { BASE_MAINNET_USDC } from '../functions/api/_price.js';

const PAYTO = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';

/** A fully-configured deployment: $0.10 of Circle-native USDC on Base mainnet. */
const ENV = {
  PRICE_ASSET: BASE_MAINNET_USDC,
  PRICE_PAYTO: PAYTO,
  PRICE_AMOUNT: '100000',
  PRICE_NETWORK: 'base',
  FACILITATOR_URL: 'https://facilitator.example/settle',
};

const ctx = (env = ENV, headers = {}) => ({
  request: new Request('https://rwally.com/api/vaults', { headers }),
  env,
});

const bodyOf = async (res) => JSON.parse(await res.text());

// ── the money path ────────────────────────────────────────────────────────────────────────────

test('an unpaid request gets 402 and NOT the paid body', async () => {
  const res = await vaults(ctx());
  assert.equal(res.status, 402);

  const body = await bodyOf(res);
  assert.equal(body.error, 'payment required');
  assert.ok(body.challenge, 'a 402 must carry the challenge the caller has to sign');
  assert.equal(
    body.vaults,
    undefined,
    'THE defect this route could have: the paid payload served without payment',
  );
});

test('the 402 challenge demands exactly the configured price, asset, payee and network', async () => {
  const res = await vaults(ctx());
  const { challenge } = await bodyOf(res);
  assert.equal(challenge.amount, '100000', '$0.10 at 6dp');
  assert.equal(challenge.asset, BASE_MAINNET_USDC);
  assert.equal(challenge.payTo, PAYTO);
  assert.equal(challenge.network, 'base');
  assert.equal(challenge.scheme, 'exact', 'EVM EIP-3009, not the Solana scheme');
  assert.equal(challenge.x402Version, 2);
});

test('the challenge is echoed in the PAYMENT-REQUIRED header, which is where a client reads it', async () => {
  const res = await vaults(ctx());
  const header = res.headers.get('payment-required');
  assert.ok(header, 'no PAYMENT-REQUIRED header');
  const body = await bodyOf(res);
  assert.deepEqual(JSON.parse(header), body.challenge);
});

test('a garbage payment header is refused, and still does not serve the body', async () => {
  const res = await vaults(ctx(ENV, { 'payment-signature': 'not-base64-json' }));
  assert.equal(res.status, 402);
  const body = await bodyOf(res);
  assert.equal(body.vaults, undefined);
});

test('a well-formed envelope for the WRONG amount is refused before any facilitator call', async () => {
  // If this reached the facilitator it would be a network call from a test; it must not.
  const envelope = {
    x402Version: 2,
    signature: '0x' + '11'.repeat(65),
    authorization: {
      from: '0x1111111111111111111111111111111111111111',
      to: PAYTO,
      value: '1', // one base unit, not 100000
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 600),
      nonce: '0x' + '22'.repeat(32),
    },
  };
  const header = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  const res = await vaults(ctx(ENV, { 'payment-signature': header }));
  assert.equal(res.status, 402);
  const body = await bodyOf(res);
  assert.match(body.error, /payment invalid/);
  assert.equal(body.vaults, undefined);
});

// ── fail closed on misconfiguration ───────────────────────────────────────────────────────────

for (const missing of ['PRICE_ASSET', 'PRICE_PAYTO', 'PRICE_AMOUNT', 'PRICE_NETWORK', 'FACILITATOR_URL']) {
  test(`a deployment missing ${missing} refuses rather than serving the body free`, async () => {
    const env = { ...ENV };
    delete env[missing];
    const res = await vaults(ctx(env));
    assert.equal(res.status, 500);
    const body = await bodyOf(res);
    assert.equal(body.error, 'route misconfigured');
    assert.match(body.detail, new RegExp(missing));
    assert.equal(body.vaults, undefined, 'a misconfigured route must never serve the paid payload');
  });
}

test('an unparseable FACILITATOR_URL is refused WITHOUT echoing it back', async () => {
  // Unlike the other four settings, this one is operator configuration published nowhere, and a
  // facilitator endpoint may carry a key in its path or query. Omitting the scheme is the commonest
  // URL typo, so this branch is exactly where a credential would reach an unauthenticated GET.
  const res = await vaults(ctx({ ...ENV, FACILITATOR_URL: 'facilitator.example/x?apiKey=SUPER_SECRET_KEY' }));
  assert.equal(res.status, 500);
  const body = await bodyOf(res);
  assert.ok(!body.detail.includes('SUPER_SECRET_KEY'), 'the credential must not reach the response');
  assert.ok(!body.detail.includes('facilitator.example'), 'the value must not be echoed at all');
  assert.match(body.detail, /FACILITATOR_URL/, 'but it must still name the setting at fault');
  assert.equal(body.vaults, undefined);
});

test('a non-https FACILITATOR_URL is refused — a signed envelope must not cross plain http', async () => {
  const res = await vaults(ctx({ ...ENV, FACILITATOR_URL: 'http://facilitator.example/settle' }));
  assert.equal(res.status, 500);
  const body = await bodyOf(res);
  assert.match(body.detail, /must be https/);
});

test('PRICE_AMOUNT must be positive base units, so a free or malformed price cannot deploy', async () => {
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    const res = await vaults(ctx({ ...ENV, PRICE_AMOUNT: bad }));
    assert.equal(res.status, 500, `PRICE_AMOUNT=${JSON.stringify(bad)} should refuse`);
  }
});

test('a PRICE_PAYTO that is not an address is refused — it decides who receives the money', async () => {
  const res = await vaults(ctx({ ...ENV, PRICE_PAYTO: 'vitalik.eth' }));
  assert.equal(res.status, 500);
  const body = await bodyOf(res);
  assert.match(body.detail, /PRICE_PAYTO is not an address/);
});

// ── discovery ─────────────────────────────────────────────────────────────────────────────────

test('discovery is free and quotes the SAME price the gate enforces', async () => {
  const res = await discovery({
    request: new Request('https://rwally.com/.well-known/x402'),
    env: ENV,
  });
  assert.equal(res.status, 200);
  const doc = await bodyOf(res);

  const paid = await vaults(ctx());
  const { challenge } = await bodyOf(paid);

  assert.equal(doc.routes[0].price.amount, challenge.amount, 'discovery must not quote a price the gate will not charge');
  assert.equal(doc.asset, challenge.asset);
  assert.equal(doc.payTo, challenge.payTo);
  assert.equal(doc.network, challenge.network);
});

test('discovery states the data is a pinned snapshot before a caller pays for it', async () => {
  const res = await discovery({
    request: new Request('https://rwally.com/.well-known/x402'),
    env: ENV,
  });
  const doc = await bodyOf(res);
  assert.equal(doc.routes[0].data.live, false, 'the payload is not a live chain read and must say so');
  assert.ok(doc.routes[0].data.asOf, 'a caller needs the age of the data before paying');
  assert.match(doc.routes[0].data.staleness, /not a chain read/i);
});

test('discovery names the route at the origin it was requested from', async () => {
  const res = await discovery({
    request: new Request('https://rwally.com/.well-known/x402'),
    env: ENV,
  });
  const doc = await bodyOf(res);
  assert.equal(doc.routes[0].url, 'https://rwally.com/api/vaults');
});

// ── the payload's own honesty ─────────────────────────────────────────────────────────────────

test('the snapshot carries no balance-like field, which is what `notIncluded` promises', async () => {
  const { default: snap } = await import('../functions/api/_snapshot.json', {
    with: { type: 'json' },
  });
  const banned = /balance|nav|totalShares|shareSupply|position|memberCount/i;
  for (const v of snap.vaults) {
    for (const key of Object.keys(v)) {
      assert.ok(!banned.test(key), `${key} moves block to block and cannot be pinned honestly`);
    }
  }
});

test('every snapshot vault matches the deployment record it claims to be copied from', async () => {
  const { default: snap } = await import('../functions/api/_snapshot.json', {
    with: { type: 'json' },
  });
  const { default: rec } = await import(
    '../../../contracts/config/deployments/robinhood-mainnet.json',
    { with: { type: 'json' } }
  );

  assert.equal(snap.chainId, rec.chainId, 'snapshot names a different chain than the record');

  const recorded = [rec.smokeVault, rec.secondVault];
  assert.equal(snap.vaults.length, recorded.length);

  for (const want of recorded) {
    const got = snap.vaults.find((v) => v.address === want.address);
    assert.ok(got, `${want.address} is in the record but not in the snapshot`);
    for (const field of ['createdInBlock', 'createdAt', 'creator', 'minDepositUsdc', 'capacityCapUsdc', 'runtimeCodesize']) {
      assert.equal(got[field], want[field], `${want.address}.${field} drifted from the deployment record`);
    }
  }
});
