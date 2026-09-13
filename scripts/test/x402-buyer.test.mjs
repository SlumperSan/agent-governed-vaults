// @ts-check
/**
 * Tests for the reusable x402 buyer (`scripts/lib/x402-buyer.mjs`) and the CLI's pure config
 * resolver (`scripts/x402-buy.mjs`).
 *
 * No network, no real chain, no key: the "server" side of every handshake test is a real
 * `node:http` server on 127.0.0.1 (loopback only, an ephemeral port), speaking the exact
 * PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE header shapes `apps/api/src/x402.mjs`'s
 * `gate` produces. Signing is a plain async function the tests control directly, so every test
 * that expects a refusal can assert the sign function was never called — not just that the call
 * threw — which is the actual security property this module exists to provide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  buyResource,
  validateChallenge,
  parseChallengeHeader,
  signerFromAccount,
  parseUsdcAmount,
  isAddress,
  ChallengeMismatchError,
  PaymentFailedError,
} from '../lib/x402-buyer.mjs';
import { resolveBuyConfig } from '../x402-buy.mjs';

const ASSET = '0x' + 'a'.repeat(40);
const PAY_TO = '0x' + 'b'.repeat(40);
const WALLET = '0x' + 'c'.repeat(40);
const DOMAIN = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ASSET };
const EXPECTED = { asset: ASSET, payTo: PAY_TO, network: 'base', maxAmount: '100000' };

/** A minimal PAYMENT-REQUIRED challenge, overridable per test. */
function challenge(overrides = {}) {
  return {
    scheme: 'exact',
    x402Version: 2,
    asset: ASSET,
    amount: '100000',
    payTo: PAY_TO,
    network: 'base',
    nonce: '0x' + 'd'.repeat(64),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

/**
 * Start a fake x402 server on loopback. `behavior(req)` returns the response for the FIRST
 * (unpaid) request; the second (paid) request is answered by `onPaid`, defaulting to a 200 with a
 * receipt. Returns { url, close }.
 */
async function startFakeServer({ firstChallenge = challenge(), onPaid } = {}) {
  const paidHandler =
    onPaid ??
    ((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'payment-response': JSON.stringify({ receiptId: '0xreceipt' }) });
      res.end(JSON.stringify({ vaults: [] }));
    });
  const server = createServer((req, res) => {
    const sig = req.headers['payment-signature'];
    if (!sig) {
      res.writeHead(402, { 'content-type': 'application/json', 'payment-required': JSON.stringify(firstChallenge) });
      res.end(JSON.stringify({ error: 'payment required', challenge: firstChallenge }));
      return;
    }
    paidHandler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}/resource`, close: () => new Promise((r) => server.close(r)) };
}

/** A spy sign function: records whether it was ever called. */
function spySign(signature = '0x' + 'f'.repeat(130)) {
  const calls = [];
  const sign = async (typedData) => {
    calls.push(typedData);
    return signature;
  };
  return { sign, calls };
}

/**
 * Await a promise expected to reject and return the rejection error. `assert.rejects` without a
 * validator resolves to `undefined`, not the error, so a test that wants to inspect fields on the
 * error needs this rather than treating `assert.rejects`'s own return value as the error.
 */
async function rejection(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, got none');
}

// ── the happy path ──

test('buyResource: 402 -> validate -> sign -> retry -> 200 with data and receipt', async () => {
  const { url, close } = await startFakeServer();
  try {
    const { sign, calls } = spySign();
    const result = await buyResource({ url, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign });
    assert.equal(result.paid, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { vaults: [] });
    assert.equal(result.receipt.receiptId, '0xreceipt');
    assert.equal(calls.length, 1, 'signed exactly once');
    assert.equal(calls[0].primaryType, 'TransferWithAuthorization');
    assert.equal(result.envelope.authorization.from, WALLET);
    assert.equal(result.envelope.authorization.to, PAY_TO);
  } finally {
    await close();
  }
});

test('buyResource: a free (200) resource returns immediately and never signs', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  try {
    const { sign, calls } = spySign();
    const result = await buyResource({
      url: `http://127.0.0.1:${port}/health`,
      expected: EXPECTED,
      walletAddress: WALLET,
      domain: DOMAIN,
      sign,
    });
    assert.equal(result.paid, false);
    assert.deepEqual(result.data, { ok: true });
    assert.equal(result.receipt, null);
    assert.equal(calls.length, 0, 'never signed for a free route');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── the security property: a mismatched challenge aborts before signing ──

test('buyResource: amount above the caller max aborts WITHOUT signing', async () => {
  const { url, close } = await startFakeServer({ firstChallenge: challenge({ amount: '999999999' }) });
  try {
    const { sign, calls } = spySign();
    await assert.rejects(
      () => buyResource({ url, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }),
      ChallengeMismatchError,
    );
    assert.equal(calls.length, 0, 'a signature must never be produced for a challenge that fails validation');
  } finally {
    await close();
  }
});

test('buyResource: a different payTo than expected aborts WITHOUT signing', async () => {
  const attacker = '0x' + '9'.repeat(40);
  const { url, close } = await startFakeServer({ firstChallenge: challenge({ payTo: attacker }) });
  try {
    const { sign, calls } = spySign();
    const err = await rejection(() => buyResource({ url, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }));
    assert.equal(err.name, 'ChallengeMismatchError');
    assert.equal(err.reason, 'payto-mismatch');
    assert.equal(calls.length, 0, 'a signature must never be produced when payTo does not match');
  } finally {
    await close();
  }
});

test('buyResource: a different asset than expected aborts WITHOUT signing', async () => {
  const other = '0x' + '7'.repeat(40);
  const { url, close } = await startFakeServer({ firstChallenge: challenge({ asset: other }) });
  try {
    const { sign, calls } = spySign();
    await assert.rejects(() => buyResource({ url, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }), { reason: 'asset-mismatch' });
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('buyResource: a different network than expected aborts WITHOUT signing', async () => {
  const { url, close } = await startFakeServer({ firstChallenge: challenge({ network: 'base-sepolia' }) });
  try {
    const { sign, calls } = spySign();
    await assert.rejects(() => buyResource({ url, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }), { reason: 'network-mismatch' });
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('buyResource: an unsupported scheme (e.g. exact-svm) aborts WITHOUT signing', async () => {
  const { url, close } = await startFakeServer({ firstChallenge: challenge({ scheme: 'exact-svm' }) });
  try {
    const { sign, calls } = spySign();
    await assert.rejects(() => buyResource({ url, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }), { reason: 'scheme-unsupported' });
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('buyResource: an already-expired challenge aborts WITHOUT signing', async () => {
  const { url, close } = await startFakeServer({ firstChallenge: challenge({ expiresAt: Date.now() - 1000 }) });
  try {
    const { sign, calls } = spySign();
    await assert.rejects(() => buyResource({ url, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }), { reason: 'challenge-expired' });
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('buyResource: a challenge whose expiry is implausibly far out aborts WITHOUT signing', async () => {
  const { url, close } = await startFakeServer({ firstChallenge: challenge({ expiresAt: Date.now() + 60 * 60_000 }) });
  try {
    const { sign, calls } = spySign();
    await assert.rejects(() => buyResource({ url, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }), { reason: 'challenge-ttl-too-long' });
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

// ── malformed / absent challenge ──

test('buyResource: a 402 with no PAYMENT-REQUIRED header aborts WITHOUT signing', async () => {
  const server = createServer((req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'payment required' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  try {
    const { sign, calls } = spySign();
    await assert.rejects(
      () => buyResource({ url: `http://127.0.0.1:${port}/x`, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }),
      PaymentFailedError,
    );
    assert.equal(calls.length, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('buyResource: a 402 with an unparseable PAYMENT-REQUIRED header aborts WITHOUT signing', async () => {
  const server = createServer((req, res) => {
    res.writeHead(402, { 'content-type': 'application/json', 'payment-required': '{not json' });
    res.end(JSON.stringify({ error: 'payment required' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  try {
    const { sign, calls } = spySign();
    await assert.rejects(() => buyResource({ url: `http://127.0.0.1:${port}/x`, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }));
    assert.equal(calls.length, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('buyResource: an unexpected status on the unpaid request throws, no signing', async () => {
  const server = createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  try {
    const { sign, calls } = spySign();
    const err = await rejection(() => buyResource({ url: `http://127.0.0.1:${port}/x`, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }));
    assert.equal(err.status, 500);
    assert.equal(calls.length, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('buyResource: settlement refused after signing (second 402) still surfaces as an error', async () => {
  const { url, close } = await startFakeServer({
    onPaid: (req, res) => {
      const bad = challenge();
      res.writeHead(402, { 'content-type': 'application/json', 'payment-required': JSON.stringify(bad) });
      res.end(JSON.stringify({ error: 'settlement failed: facilitator-unreachable', challenge: bad }));
    },
  });
  try {
    const { sign, calls } = spySign();
    const err = await rejection(() => buyResource({ url, expected: EXPECTED, walletAddress: WALLET, domain: DOMAIN, sign }));
    assert.ok(err instanceof PaymentFailedError);
    assert.match(err.message, /settlement failed/);
    assert.equal(calls.length, 1, 'the authorization WAS signed once — this asserts on the message, not on re-signing');
  } finally {
    await close();
  }
});

// ── validateChallenge as a pure unit (direct, no server) ──

test('validateChallenge accepts a challenge matching every expected field', () => {
  assert.doesNotThrow(() => validateChallenge(challenge(), EXPECTED, Date.now()));
});

test('validateChallenge rejects a challenge cheaper than the max (that is fine) but never one costlier', () => {
  assert.doesNotThrow(() => validateChallenge(challenge({ amount: '1' }), EXPECTED, Date.now()));
  assert.throws(() => validateChallenge(challenge({ amount: '100001' }), EXPECTED, Date.now()), ChallengeMismatchError);
});

test('validateChallenge rejects a non-object and a wrong x402Version', () => {
  assert.throws(() => validateChallenge(null, EXPECTED, Date.now()), ChallengeMismatchError);
  assert.throws(() => validateChallenge(challenge({ x402Version: 1 }), EXPECTED, Date.now()), { reason: 'x402Version-mismatch' });
});

test('parseChallengeHeader returns null rather than throwing on anything malformed', () => {
  assert.equal(parseChallengeHeader(null), null);
  assert.equal(parseChallengeHeader(undefined), null);
  assert.equal(parseChallengeHeader('not json'), null);
  assert.equal(parseChallengeHeader('"a string, not an object"'), null);
  assert.deepEqual(parseChallengeHeader(JSON.stringify(challenge())).asset, ASSET);
});

// ── signerFromAccount ──

test('signerFromAccount slims typed data to TransferWithAuthorization before calling the account', async () => {
  let captured = null;
  const account = {
    signTypedData: async (td) => {
      captured = td;
      return '0xsig';
    },
  };
  const sign = signerFromAccount(account);
  const sig = await sign({
    domain: DOMAIN,
    types: { EIP712Domain: [{ name: 'name', type: 'string' }], TransferWithAuthorization: [{ name: 'from', type: 'address' }] },
    primaryType: 'TransferWithAuthorization',
    message: { from: WALLET },
  });
  assert.equal(sig, '0xsig');
  assert.deepEqual(Object.keys(captured.types), ['TransferWithAuthorization']);
  assert.equal(captured.primaryType, 'TransferWithAuthorization');
  assert.equal(captured.message.from, WALLET);
});

// ── parseUsdcAmount / isAddress ──

test('parseUsdcAmount parses exact decimal USDC amounts with no floats', () => {
  assert.equal(parseUsdcAmount('0.10', '--max'), 100_000n);
  assert.equal(parseUsdcAmount('5', '--max'), 5_000_000n);
  assert.throws(() => parseUsdcAmount('1e-2', '--max'), /at most 6 decimals/);
  assert.throws(() => parseUsdcAmount('-1', '--max'), /at most 6 decimals/);
});

test('isAddress accepts only well-formed 20-byte hex addresses', () => {
  assert.equal(isAddress(ASSET), true);
  assert.equal(isAddress('not-an-address'), false);
  assert.equal(isAddress('0x' + 'a'.repeat(39)), false);
});

// ── the CLI's pure config resolver: never a key from argv, never a mainnet default ──

const BASE_ENV = { BUYER_KEYSTORE: '/keys/buyer', BUYER_KEYSTORE_PASSWORD: 'pw' };
const BASE_ARGS = {
  url: 'https://example.com/api/vaults',
  network: 'base',
  'rpc-url': 'https://mainnet.base.org',
  asset: ASSET,
  'pay-to': PAY_TO,
  max: '0.10',
};

test('resolveBuyConfig accepts a complete, explicit configuration', () => {
  const cfg = resolveBuyConfig({ env: BASE_ENV, args: BASE_ARGS });
  assert.equal(cfg.network, 'base');
  assert.equal(cfg.maxAmount, 100_000n);
  assert.equal(cfg.asset, ASSET);
  assert.equal(cfg.payTo, PAY_TO);
});

test('resolveBuyConfig refuses when --network or --max is omitted — no default network, no default spend', () => {
  const { network, ...noNetwork } = BASE_ARGS;
  assert.throws(() => resolveBuyConfig({ env: BASE_ENV, args: noNetwork }), /--network is required/);
  const { max, ...noMax } = BASE_ARGS;
  assert.throws(() => resolveBuyConfig({ env: BASE_ENV, args: noMax }), /--max is required/);
});

test('resolveBuyConfig refuses a key passed as a CLI argument', () => {
  assert.throws(
    () => resolveBuyConfig({ env: BASE_ENV, args: { ...BASE_ARGS, key: '0x' + 'f'.repeat(64) } }),
    /a key must never be passed as a CLI argument/,
  );
  assert.throws(
    () => resolveBuyConfig({ env: BASE_ENV, args: { ...BASE_ARGS, 'private-key': '0x' + 'f'.repeat(64) } }),
    /a key must never be passed as a CLI argument/,
  );
});

test('resolveBuyConfig refuses a raw private key in the environment, pointing at the keystore instead', () => {
  assert.throws(
    () => resolveBuyConfig({ env: { ...BASE_ENV, BUYER_PRIVATE_KEY: '0x' + 'f'.repeat(64) }, args: BASE_ARGS }),
    /refusing to run with a raw private key/,
  );
  assert.throws(
    () => resolveBuyConfig({ env: { ...BASE_ENV, PRIVATE_KEY: '0x' + 'f'.repeat(64) }, args: BASE_ARGS }),
    /refusing to run with a raw private key/,
  );
});

test('resolveBuyConfig refuses without a keystore path or password', () => {
  assert.throws(() => resolveBuyConfig({ env: {}, args: BASE_ARGS }), /BUYER_KEYSTORE .*is not set/);
  assert.throws(() => resolveBuyConfig({ env: { BUYER_KEYSTORE: '/k' }, args: BASE_ARGS }), /BUYER_KEYSTORE_PASSWORD is not set/);
});

test('resolveBuyConfig enforces its own hard ceiling on --max independent of the caller', () => {
  assert.throws(() => resolveBuyConfig({ env: BASE_ENV, args: { ...BASE_ARGS, max: '5.01' } }), /hard ceiling/);
  assert.doesNotThrow(() => resolveBuyConfig({ env: BASE_ENV, args: { ...BASE_ARGS, max: '5' } }));
});

test('resolveBuyConfig rejects a plain-http --url or --rpc-url that is not a local test fixture', () => {
  assert.throws(
    () => resolveBuyConfig({ env: BASE_ENV, args: { ...BASE_ARGS, url: 'http://example.com/api/vaults' } }),
    /must be https/,
  );
  assert.doesNotThrow(() =>
    resolveBuyConfig({ env: BASE_ENV, args: { ...BASE_ARGS, url: 'http://127.0.0.1:8402/vaults', 'rpc-url': 'http://127.0.0.1:8545' } }),
  );
});

test('resolveBuyConfig rejects malformed addresses for --asset / --pay-to', () => {
  assert.throws(() => resolveBuyConfig({ env: BASE_ENV, args: { ...BASE_ARGS, asset: 'not-an-address' } }), /--asset is not an address/);
  assert.throws(() => resolveBuyConfig({ env: BASE_ENV, args: { ...BASE_ARGS, 'pay-to': 'not-an-address' } }), /--pay-to is not an address/);
});
