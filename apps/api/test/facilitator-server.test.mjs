// @ts-check
/**
 * Facilitator-server tests.
 *
 * Everything here runs with mocked chain clients — no key, no network, no viem requirement for the
 * pure paths. The one test that needs real cryptography (a genuine SDK-signed envelope settling
 * through the whole server) skips when viem is absent, matching facilitator.test.mjs.
 *
 * The test that matters most is the wire-contract one: it drives the REAL `createHttpFacilitator`
 * against the REAL handler, so the two halves of the remote protocol are checked against each
 * other rather than against my assumption about what each sends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gateSettlement, checkChallengePrice, parseSettleRequest, createSettleHandler,
  startFacilitatorServer, CONSENT_ENV_VAR, FacilitatorConfigError,
} from '../src/facilitator-server.mjs';
import { createHttpFacilitator } from '../src/facilitator.mjs';
import { gate } from '../src/x402.mjs';

const viem = await import('viem').catch(() => null);
const accounts = await import('viem/accounts').catch(() => null);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const FROM = '0x' + '1'.repeat(40);
const PAYTO = '0x' + '2'.repeat(40);
const NONCE = '0x' + 'a'.repeat(64);
const SIG = '0x' + 'b'.repeat(130);
const ACCOUNT = { address: '0x' + '9'.repeat(40) };
const CONSENT = { [CONSENT_ENV_VAR]: 'yes' };

const authorization = (over = {}) => ({
  from: FROM, to: PAYTO, value: '10000', validAfter: '100', validBefore: '999999999999',
  nonce: NONCE, asset: USDC, ...over,
});
const envelope = (over = {}) => {
  const { authorization: a, ...rest } = over;
  return { x402Version: 2, scheme: 'exact', network: 'base-sepolia', signature: SIG, ...rest, authorization: authorization(a) };
};
const price = (over = {}) => ({ asset: USDC, amount: '10000', payTo: PAYTO, network: 'base-sepolia', ...over });
const okFacilitator = (receiptId = '0xdead') => ({ async verifyAndSettle() { return { ok: true, receiptId }; } });

// ── the consent gate ──

test('gateSettlement requires BOTH an injected account and the consent env var', () => {
  assert.deepEqual(gateSettlement({ account: ACCOUNT, env: CONSENT }), { consented: true, settler: ACCOUNT.address });

  assert.throws(() => gateSettlement({ account: null, env: CONSENT }), FacilitatorConfigError);
  assert.throws(() => gateSettlement({ account: ACCOUNT, env: {} }), FacilitatorConfigError);
  assert.throws(() => gateSettlement({ account: ACCOUNT, env: { [CONSENT_ENV_VAR]: 'YES' } }), FacilitatorConfigError,
    'consent value is compared exactly — "YES" must not pass');
});

test('gateSettlement names every problem at once, and never downgrades to a safe mode', () => {
  try {
    gateSettlement({ account: null, env: {} });
    assert.fail('expected a refusal');
  } catch (err) {
    assert.match(err.message, /no viem account was injected/);
    assert.match(err.message, new RegExp(CONSENT_ENV_VAR));
    assert.match(err.message, /no reduced mode to fall back to/);
  }
});

test('a private key hex string is not an account and does not satisfy the gate', () => {
  assert.throws(() => gateSettlement({ account: '0x' + 'f'.repeat(64), env: CONSENT }), FacilitatorConfigError);
});

// ── the defense-in-depth price re-check (PR #6 review) ──

test('checkChallengePrice accepts a payment that matches the posted challenge', () => {
  assert.deepEqual(checkChallengePrice({ price: price() }, envelope()), { ok: true });
});

test('checkChallengePrice rejects a redirected recipient — the open-relay case', () => {
  const attacker = '0x' + 'e'.repeat(40);
  assert.deepEqual(
    checkChallengePrice({ price: price() }, envelope({ authorization: { to: attacker } })),
    { ok: false, reason: 'recipient-mismatch' },
  );
});

test('checkChallengePrice rejects underpayment but allows overpayment', () => {
  assert.deepEqual(
    checkChallengePrice({ price: price() }, envelope({ authorization: { value: '9999' } })),
    { ok: false, reason: 'underpaid' },
  );
  assert.deepEqual(checkChallengePrice({ price: price() }, envelope({ authorization: { value: '20000' } })), { ok: true });
});

test('checkChallengePrice rejects a mismatched asset or network', () => {
  assert.deepEqual(
    checkChallengePrice({ price: price() }, envelope({ authorization: { asset: '0x' + 'd'.repeat(40) } })),
    { ok: false, reason: 'asset-mismatch' },
  );
  assert.deepEqual(
    checkChallengePrice({ price: price() }, envelope({ network: 'base' })),
    { ok: false, reason: 'network-mismatch' },
  );
});

test('checkChallengePrice compares addresses case-insensitively (EIP-55 vs lowercase)', () => {
  assert.deepEqual(
    checkChallengePrice({ price: price({ payTo: PAYTO.toUpperCase().replace('0X', '0x') }) }, envelope()),
    { ok: true },
  );
});

test('checkChallengePrice tolerates a flattened challenge and skips when no price is asserted', () => {
  assert.deepEqual(checkChallengePrice(price(), envelope()), { ok: true });
  assert.deepEqual(checkChallengePrice(price({ payTo: '0x' + 'e'.repeat(40) }), envelope()), { ok: false, reason: 'recipient-mismatch' });
  assert.deepEqual(checkChallengePrice(undefined, envelope()), { ok: true });
  assert.deepEqual(checkChallengePrice({}, envelope()), { ok: true });
});

test('checkChallengePrice rejects a malformed payTo rather than ignoring it', () => {
  assert.deepEqual(checkChallengePrice({ price: price({ payTo: 'not-an-address' }) }, envelope()), { ok: false, reason: 'challenge-bad-payTo' });
});

test('the price re-check runs BEFORE the facilitator is called (no gas on a bad request)', async () => {
  let called = false;
  const handle = createSettleHandler({ facilitator: { async verifyAndSettle() { called = true; return { ok: true }; } } });
  const res = await handle('POST', '/settle', {
    x402Version: 2, challenge: { price: price() }, envelope: envelope({ authorization: { to: '0x' + 'e'.repeat(40) } }),
  });
  assert.equal(called, false, 'facilitator must not be reached when the price check fails');
  assert.deepEqual(res, { status: 200, body: { ok: false, reason: 'recipient-mismatch' } });
});

// ── request parsing / routing ──

test('parseSettleRequest rejects malformed bodies with a precise reason', () => {
  assert.deepEqual(parseSettleRequest(undefined), { ok: false, reason: 'bad-request-body' });
  assert.deepEqual(parseSettleRequest({ x402Version: 1, envelope: envelope() }), { ok: false, reason: 'unsupported-x402-version' });
  assert.deepEqual(parseSettleRequest({ x402Version: 2 }), { ok: false, reason: 'no-envelope' });
  assert.equal(parseSettleRequest({ x402Version: 2, envelope: envelope() }).ok, true);
});

test('handler routes: /settle and / accept POST, /health answers GET, everything else 404/405', async () => {
  const handle = createSettleHandler({ facilitator: okFacilitator(), health: () => ({ settler: ACCOUNT.address }) });
  const body = { x402Version: 2, challenge: { price: price() }, envelope: envelope() };

  assert.equal((await handle('POST', '/settle', body)).status, 200);
  assert.equal((await handle('POST', '/', body)).status, 200);
  assert.deepEqual(await handle('GET', '/health', undefined), { status: 200, body: { ok: true, settler: ACCOUNT.address } });
  assert.equal((await handle('GET', '/settle', undefined)).status, 405);
  assert.equal((await handle('POST', '/nope', body)).status, 404);
});

test('a rejected payment is a 200 with a reason, not a 4xx — createHttpFacilitator loses reasons on non-2xx', async () => {
  const handle = createSettleHandler({ facilitator: { async verifyAndSettle() { return { ok: false, reason: 'authorization-used' }; } } });
  const res = await handle('POST', '/settle', { x402Version: 2, challenge: { price: price() }, envelope: envelope() });
  assert.equal(res.status, 200, 'a non-2xx would be flattened to facilitator-http-<n> by the caller');
  assert.deepEqual(res.body, { ok: false, reason: 'authorization-used' });
});

test('an unexpected throw becomes a generic 500 and never leaks the error to the payer', async () => {
  const logged = [];
  const handle = createSettleHandler({
    facilitator: { async verifyAndSettle() { throw new Error('RPC key sk-secret-123 rejected'); } },
    log: (m) => logged.push(m),
  });
  const res = await handle('POST', '/settle', { x402Version: 2, challenge: { price: price() }, envelope: envelope() });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { ok: false, reason: 'facilitator-internal-error' });
  assert.doesNotMatch(JSON.stringify(res.body), /sk-secret-123/);
  assert.match(logged.join('\n'), /sk-secret-123/, 'the detail belongs in the operator log, not the response');
});

// ── the wire contract: real createHttpFacilitator ↔ real handler ──

test('createHttpFacilitator and the handler agree on the wire, end to end through gate()', async () => {
  const seen = [];
  const handle = createSettleHandler({ facilitator: okFacilitator('0xtxhash') });

  // A fetch that pipes straight into the handler — no assumptions about the body shape.
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const { status, body: out } = await handle('POST', '/settle', body);
    return { ok: status >= 200 && status < 300, status, json: async () => out };
  };

  const facilitator = createHttpFacilitator({ url: 'http://facilitator.test/settle', fetchImpl });
  const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
  const verdict = await gate({
    headers: { 'payment-signature': b64(envelope()) },
    price: price(),
    facilitator,
    nowMs: 1_000_000,
  });

  assert.equal(verdict.status, 200, 'the paid read must be authorized');
  assert.equal(verdict.receiptId, '0xtxhash');

  // Pin the exact shape x402.mjs puts on the wire: gate() passes `{ price }`, NOT the challenge doc.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].x402Version, 2);
  assert.deepEqual(seen[0].challenge, { price: price() });
  assert.equal(seen[0].envelope.authorization.nonce, NONCE);
});

test('the wire contract carries a settlement REJECTION back through gate() as a 402 with its reason', async () => {
  const handle = createSettleHandler({ facilitator: { async verifyAndSettle() { return { ok: false, reason: 'authorization-used' }; } } });
  const fetchImpl = async (_url, init) => {
    const { status, body } = await handle('POST', '/settle', JSON.parse(init.body));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
  const verdict = await gate({
    headers: { 'payment-signature': b64(envelope()) },
    price: price(),
    facilitator: createHttpFacilitator({ url: 'http://facilitator.test/settle', fetchImpl }),
    nowMs: 1_000_000,
  });
  assert.equal(verdict.status, 402);
  assert.match(verdict.body.error, /authorization-used/, 'the on-chain reason must survive the hop');
});

// ── startup: consent + the on-chain domain proof ──

const stubClients = ({ name = 'USDC', version = '2', separator } = {}) => {
  const chainId = 84532;
  const domain = { name, version, chainId, verifyingContract: USDC };
  const onChain = separator ?? (viem ? viem.domainSeparator({ domain }) : '0x' + '0'.repeat(64));
  return {
    publicClient: {
      async readContract({ functionName }) {
        if (functionName === 'name') return name;
        if (functionName === 'version') return version;
        if (functionName === 'DOMAIN_SEPARATOR') return onChain;
        if (functionName === 'authorizationState') return false;
        throw new Error(`unexpected read ${functionName}`);
      },
      async simulateContract() { return { request: {} }; },
    },
    walletClient: { account: ACCOUNT, async writeContract() { return '0x' + '7'.repeat(64); } },
  };
};

/**
 * A genuinely signed envelope. Needed wherever the settling path runs for real: signature recovery
 * happens BEFORE the on-chain nonce check, so a placeholder signature never reaches the nonce
 * branch — it dies earlier on an invalid `v`.
 */
async function signedEnvelope({ payerKey = '0x' + '4'.repeat(64), nonce = NONCE, to = PAYTO } = {}) {
  const { authorizeFromChallenge } = await import('../../../packages/agent-sdk/src/eip3009.mjs');
  const payer = accounts.privateKeyToAccount(payerKey);
  const domain = { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC };
  const env = await authorizeFromChallenge({
    challenge: { asset: USDC, amount: '10000', payTo: to, network: 'base-sepolia', nonce },
    walletAddress: payer.address,
    domain,
    sign: (td) => payer.signTypedData({ domain: td.domain, types: { TransferWithAuthorization: td.types.TransferWithAuthorization }, primaryType: 'TransferWithAuthorization', message: td.message }),
    nowSec: Math.floor(Date.now() / 1000),
  });
  return { env, payer };
}

test('startFacilitatorServer refuses to start without consent, before touching the chain', async () => {
  let touched = false;
  const publicClient = { async readContract() { touched = true; return 'USDC'; } };
  await assert.rejects(
    () => startFacilitatorServer({ account: ACCOUNT, publicClient, walletClient: {}, usdcAddress: USDC, chainId: 84532, env: {}, listen: false }),
    FacilitatorConfigError,
  );
  assert.equal(touched, false, 'the consent gate must run before any chain read');
});

test('startFacilitatorServer refuses to start when the token domain does not reproduce DOMAIN_SEPARATOR', {
  skip: !viem ? 'viem not installed' : false,
}, async () => {
  const { publicClient, walletClient } = stubClients({ name: 'USD Coin' , separator: viem.domainSeparator({ domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC } }) });
  await assert.rejects(
    () => startFacilitatorServer({ account: ACCOUNT, publicClient, walletClient, usdcAddress: USDC, chainId: 84532, env: CONSENT, listen: false, log: () => {} }),
    (err) => {
      assert.match(err.message, /domain mismatch/);
      assert.match(err.message, /"USD Coin"/, 'the message must show what the token actually reported');
      assert.match(err.message, /Refusing to start/);
      return true;
    },
  );
});

test('startFacilitatorServer verifies the domain on-chain and uses it (not the hardcoded default)', {
  skip: !viem ? 'viem not installed' : false,
}, async () => {
  const { publicClient, walletClient } = stubClients();
  const srv = await startFacilitatorServer({
    account: ACCOUNT, publicClient, walletClient, usdcAddress: USDC, chainId: 84532,
    env: CONSENT, listen: false, log: () => {},
  });
  assert.equal(srv.domain.name, 'USDC', 'Base Sepolia USDC is "USDC", not the "USD Coin" default');
  assert.equal(srv.domain.matches, true);
  const health = await srv.handle('GET', '/health', undefined);
  assert.equal(health.body.domain.name, 'USDC');
  assert.equal(health.body.settler, ACCOUNT.address);
});

// ── full crypto round trip: SDK signs, server settles ──

test('a genuine SDK-signed envelope settles through the server (viem)', {
  skip: !viem || !accounts ? 'viem not installed' : false,
}, async () => {
  const { authorizeFromChallenge } = await import('../../../packages/agent-sdk/src/eip3009.mjs');
  const payer = accounts.privateKeyToAccount('0x' + '4'.repeat(64));
  const domain = { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC };

  const challenge = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base-sepolia', nonce: NONCE };
  const env = await authorizeFromChallenge({
    challenge, walletAddress: payer.address, domain,
    sign: (td) => payer.signTypedData({ domain: td.domain, types: { TransferWithAuthorization: td.types.TransferWithAuthorization }, primaryType: 'TransferWithAuthorization', message: td.message }),
    nowSec: Math.floor(Date.now() / 1000),
  });

  const sent = [];
  const { publicClient, walletClient } = stubClients();
  publicClient.simulateContract = async (req) => { sent.push(req); return { request: req }; };

  const srv = await startFacilitatorServer({
    account: ACCOUNT, publicClient, walletClient, usdcAddress: USDC, chainId: 84532,
    env: CONSENT, listen: false, log: () => {},
  });
  const res = await srv.handle('POST', '/settle', { x402Version: 2, challenge: { price: price() }, envelope: env });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, `expected settlement, got ${JSON.stringify(res.body)}`);
  assert.match(res.body.receiptId, /^0x7{64}$/);

  // v must be normalized into the 27/28 range the token expects.
  const v = sent[0].args[6];
  assert.ok(v === 27 || v === 28, `v must be 27/28, got ${v}`);
  assert.equal(sent[0].args[0].toLowerCase(), payer.address.toLowerCase());
});

test('a well-formed signature over a DIFFERENT amount is rejected as signer-mismatch (viem)', {
  skip: !viem || !accounts ? 'viem not installed' : false,
}, async () => {
  const { publicClient, walletClient } = stubClients();
  let wrote = false;
  walletClient.writeContract = async () => { wrote = true; return '0x' + '7'.repeat(64); };

  // Sign honestly, then inflate the value. The signature stays structurally valid, so this
  // exercises real recovery rather than a malformed-input early exit.
  const { env } = await signedEnvelope();
  env.authorization.value = '999999';

  const srv = await startFacilitatorServer({
    account: ACCOUNT, publicClient, walletClient, usdcAddress: USDC, chainId: 84532,
    env: CONSENT, listen: false, log: () => {},
  });
  const res = await srv.handle('POST', '/settle', { x402Version: 2, challenge: { price: price() }, envelope: env });
  assert.deepEqual(res.body, { ok: false, reason: 'signer-mismatch' });
  assert.equal(wrote, false, 'nothing may be broadcast for a signature that recovers to a stranger');
});

test('an envelope signed under the WRONG domain name recovers to a stranger — the "USD Coin" bug (viem)', {
  skip: !viem || !accounts ? 'viem not installed' : false,
}, async () => {
  const { authorizeFromChallenge } = await import('../../../packages/agent-sdk/src/eip3009.mjs');
  const payer = accounts.privateKeyToAccount('0x' + '5'.repeat(64));
  // The payer uses the old hardcoded default; Base Sepolia's token says "USDC".
  const env = await authorizeFromChallenge({
    challenge: { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base-sepolia', nonce: NONCE },
    walletAddress: payer.address,
    domain: { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: USDC },
    sign: (td) => payer.signTypedData({ domain: td.domain, types: { TransferWithAuthorization: td.types.TransferWithAuthorization }, primaryType: 'TransferWithAuthorization', message: td.message }),
    nowSec: Math.floor(Date.now() / 1000),
  });

  const { publicClient, walletClient } = stubClients();
  const srv = await startFacilitatorServer({
    account: ACCOUNT, publicClient, walletClient, usdcAddress: USDC, chainId: 84532,
    env: CONSENT, listen: false, log: () => {},
  });
  const res = await srv.handle('POST', '/settle', { x402Version: 2, challenge: { price: price() }, envelope: env });
  assert.deepEqual(res.body, { ok: false, reason: 'signer-mismatch' },
    'a wrong domain name fails as an opaque signer-mismatch — which is exactly why startup asserts the domain');
});

test('an already-used authorization is refused before simulate (the live replay path)', {
  skip: !viem || !accounts ? 'viem not installed' : false,
}, async () => {
  const { publicClient, walletClient } = stubClients();
  let simulated = false;
  publicClient.readContract = async ({ functionName }) => {
    if (functionName === 'name') return 'USDC';
    if (functionName === 'version') return '2';
    if (functionName === 'DOMAIN_SEPARATOR') return viem.domainSeparator({ domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC } });
    if (functionName === 'authorizationState') return true; // already consumed on-chain
    throw new Error('unexpected');
  };
  publicClient.simulateContract = async () => { simulated = true; return { request: {} }; };

  const srv = await startFacilitatorServer({
    account: ACCOUNT, publicClient, walletClient, usdcAddress: USDC, chainId: 84532,
    env: CONSENT, listen: false, log: () => {},
  });
  const { env } = await signedEnvelope();
  const res = await srv.handle('POST', '/settle', { x402Version: 2, challenge: { price: price() }, envelope: env });
  assert.deepEqual(res.body, { ok: false, reason: 'authorization-used' });
  assert.equal(simulated, false, 'a burned nonce must be caught before spending a simulate call');
});
