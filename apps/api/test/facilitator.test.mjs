// @ts-check
/**
 * Facilitator tests. The non-crypto surface (shape validation, typed-data reconstruction,
 * HTTP delegation, stub) is unit-tested with no dependencies. A crypto round-trip against the
 * real SDK signer is included but SKIPS when viem is absent, so CI stays zero-dependency while a
 * dev with viem gets true end-to-end signature coverage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconstructTypedData, verifyEnvelopeShape, createStubFacilitator, createHttpFacilitator, recoverPayer,
} from '../src/facilitator.mjs';
import { buildTypedData } from '../../../packages/agent-sdk/src/eip3009.mjs';

const USDC = '0x' + 'c'.repeat(40);
const FROM = '0x' + '1'.repeat(40);
const TO = '0x' + '2'.repeat(40);
const NONCE = '0x' + 'a'.repeat(64);
const SIG = '0x' + 'b'.repeat(130);

const authorization = () => ({ from: FROM, to: TO, value: '10000', validAfter: '100', validBefore: '999999999999', nonce: NONCE, asset: USDC });
const envelope = (over = {}) => {
  const { authorization: authOver, ...rest } = over;
  return { x402Version: 2, scheme: 'exact', network: 'base', signature: SIG, ...rest, authorization: { ...authorization(), ...(authOver ?? {}) } };
};

// ── typed-data reconstruction MUST equal the SDK's builder (or valid sigs won't recover) ──

test('reconstructTypedData matches the SDK buildTypedData field-for-field', () => {
  const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC };
  const sdk = buildTypedData({ authorization: authorization(), domain });
  const server = reconstructTypedData(envelope(), { chainId: 8453, usdcAddress: USDC });
  assert.deepEqual(server.domain, sdk.domain);
  assert.deepEqual(server.message, sdk.message);
  assert.deepEqual(server.types.TransferWithAuthorization, sdk.types.TransferWithAuthorization);
  assert.equal(server.primaryType, sdk.primaryType);
});

test('reconstructTypedData uses config USDC over the envelope-declared asset (no trust in the envelope)', () => {
  const evilAsset = '0x' + 'd'.repeat(40);
  const td = reconstructTypedData(envelope({ authorization: { asset: evilAsset } }), { chainId: 8453, usdcAddress: USDC });
  assert.equal(td.domain.verifyingContract, USDC, 'must bind to the operator-configured USDC, not the client asset');
});

// ── shape validation ──

test('verifyEnvelopeShape accepts a well-formed envelope', () => {
  assert.deepEqual(verifyEnvelopeShape(envelope(), 1000), { ok: true });
});

test('verifyEnvelopeShape rejects malformations with a precise reason', () => {
  assert.equal(verifyEnvelopeShape(null, 1000).reason, 'no-envelope');
  assert.equal(verifyEnvelopeShape({ x402Version: 1 }, 1000).reason, 'bad-version');
  assert.equal(verifyEnvelopeShape(envelope({ signature: '0x1234' }), 1000).reason, 'bad-signature-format');
  assert.equal(verifyEnvelopeShape(envelope({ authorization: { from: 'nope' } }), 1000).reason, 'bad-from');
  assert.equal(verifyEnvelopeShape(envelope({ authorization: { value: '0' } }), 1000).reason, 'nonpositive-value');
  assert.equal(verifyEnvelopeShape(envelope({ authorization: { nonce: '0x00' } }), 1000).reason, 'bad-nonce');
  // validBefore is in seconds; 100s * 1000 = 100000ms < now 200000ms → expired
  assert.equal(verifyEnvelopeShape(envelope({ authorization: { validBefore: '100' } }), 200_000).reason, 'authorization-expired');
});

// ── stub ──

test('createStubFacilitator accepts and denies as configured', async () => {
  const ok = await createStubFacilitator().verifyAndSettle({ price: {} }, envelope());
  assert.equal(ok.ok, true);
  assert.match(ok.receiptId, /^stub_1_/);
  const deny = await createStubFacilitator({ accept: false }).verifyAndSettle({ price: {} }, envelope());
  assert.deepEqual(deny, { ok: false, reason: 'stub-deny' });
});

// ── HTTP facilitator delegates and maps the remote verdict ──

test('createHttpFacilitator posts challenge+envelope and returns the remote receipt', async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ ok: true, receiptId: 'remote_42' }) };
  };
  const fac = createHttpFacilitator({ url: 'https://facilitator.example/settle', fetchImpl });
  const r = await fac.verifyAndSettle({ price: { amount: '10000' } }, envelope());
  assert.deepEqual(r, { ok: true, receiptId: 'remote_42', reason: undefined });
  assert.equal(captured.url, 'https://facilitator.example/settle');
  assert.equal(captured.body.envelope.authorization.from, FROM);
  assert.equal(captured.body.challenge.price.amount, '10000');
});

test('createHttpFacilitator surfaces a non-2xx remote failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, json: async () => ({ ok: false, reason: 'insufficient-balance' }) });
  const r = await createHttpFacilitator({ url: 'x', fetchImpl }).verifyAndSettle({}, envelope());
  assert.deepEqual(r, { ok: false, reason: 'insufficient-balance' });
});

test('createHttpFacilitator treats an unreachable facilitator as a settlement failure (never throws)', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await createHttpFacilitator({ url: 'x', fetchImpl }).verifyAndSettle({}, envelope());
  assert.equal(r.ok, false);
  assert.match(r.reason, /unreachable/);
});

// ── crypto round-trip: skips without viem, so CI stays dependency-free ──

let viem = null;
try { viem = await import('viem'); } catch { /* optional */ }
let accounts = null;
try { accounts = await import('viem/accounts'); } catch { /* optional */ }

test('recoverPayer confirms a genuine SDK-signed authorization (viem)', { skip: !viem || !accounts ? 'viem not installed' : false }, async () => {
  const pk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // well-known test key (not a real account)
  const account = accounts.privateKeyToAccount(pk);
  const chainId = 8453;
  const auth = { from: account.address, to: TO, value: '10000', validAfter: '100', validBefore: '999999999999', nonce: NONCE, asset: USDC };
  const td = buildTypedData({ authorization: auth, domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: USDC } });
  const signature = await account.signTypedData({
    domain: td.domain,
    types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
    primaryType: 'TransferWithAuthorization',
    message: td.message,
  });
  const good = await recoverPayer({ authorization: auth, signature }, { chainId, usdcAddress: USDC });
  assert.equal(good.ok, true);
  assert.equal(good.payer, account.address.toLowerCase());

  // Tampering with the amount must break recovery (signer-mismatch).
  const bad = await recoverPayer({ authorization: { ...auth, value: '99999' }, signature }, { chainId, usdcAddress: USDC });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'signer-mismatch');
});
