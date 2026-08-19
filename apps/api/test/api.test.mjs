// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, buildChallenge, checkEnvelopeAgainstPrice, decodeSignatureHeader, HEADERS } from '../src/x402.mjs';
import { createApi } from '../src/server.mjs';
import { applyAll } from '../../../packages/indexer/src/projections.mjs';

const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + 'd'.repeat(40);
const price = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' }; // $0.01

const okFacilitator = {
  async verifyAndSettle() {
    return { ok: true, receiptId: 'rcpt_1' };
  },
};
const rejectFacilitator = {
  async verifyAndSettle() {
    return { ok: false, reason: 'signature-invalid' };
  },
};

function envelope({ value = '10000', to = PAYTO, asset = USDC, network = 'base', nonce = '0xnonce1', validBefore = 0 } = {}) {
  const env = {
    x402Version: 2,
    network,
    signature: '0xsig',
    authorization: { asset, to, value, nonce, validBefore },
  };
  return Buffer.from(JSON.stringify(env)).toString('base64');
}

test('unpaid request returns a 402 challenge', async () => {
  const v = await gate({ headers: {}, price, facilitator: okFacilitator, nowMs: 1000 });
  assert.equal(v.status, 402);
  const ch = JSON.parse(v.headers[HEADERS.REQUIRED]);
  assert.equal(ch.asset, USDC);
  assert.equal(ch.amount, '10000');
  assert.equal(ch.x402Version, 2);
});

test('valid signature settles and authorizes (200)', async () => {
  const v = await gate({
    headers: { [HEADERS.SIGNATURE]: envelope() },
    price,
    facilitator: okFacilitator,
    nowMs: 1000,
  });
  assert.equal(v.status, 200);
  assert.equal(v.receiptId, 'rcpt_1');
  assert.equal(JSON.parse(v.headers[HEADERS.RESPONSE]).receiptId, 'rcpt_1');
});

test('underpayment is rejected before the facilitator is called', async () => {
  let called = false;
  const spy = { async verifyAndSettle() { called = true; return { ok: true }; } };
  const v = await gate({
    headers: { [HEADERS.SIGNATURE]: envelope({ value: '9999' }) },
    price,
    facilitator: spy,
    nowMs: 1000,
  });
  assert.equal(v.status, 402);
  assert.match(JSON.parse(v.headers[HEADERS.REQUIRED]) ? v.body.error : '', /underpaid/);
  assert.equal(called, false, 'facilitator must not be billed for a locally-invalid envelope');
});

test('wrong recipient / asset / network rejected locally', () => {
  assert.equal(checkEnvelopeAgainstPrice(price, { authorization: { asset: USDC, to: '0x' + '9'.repeat(40), value: '10000' }, network: 'base' }, 1000).ok, false);
  assert.equal(checkEnvelopeAgainstPrice(price, { authorization: { asset: '0x' + '9'.repeat(40), to: PAYTO, value: '10000' }, network: 'base' }, 1000).ok, false);
  assert.equal(checkEnvelopeAgainstPrice(price, { authorization: { asset: USDC, to: PAYTO, value: '10000' }, network: 'ethereum' }, 1000).ok, false);
});

test('expired authorization rejected', () => {
  const r = checkEnvelopeAgainstPrice(price, { authorization: { asset: USDC, to: PAYTO, value: '10000', validBefore: 1 }, network: 'base' }, 999_999_999_000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'authorization-expired');
});

test('facilitator rejection surfaces as 402', async () => {
  const v = await gate({
    headers: { [HEADERS.SIGNATURE]: envelope() },
    price,
    facilitator: rejectFacilitator,
    nowMs: 1000,
  });
  assert.equal(v.status, 402);
  assert.match(v.body.error, /settlement failed/);
});

test('replayed nonce rejected on second use', async () => {
  const seen = new Set();
  const first = await gate({ headers: { [HEADERS.SIGNATURE]: envelope({ nonce: '0xreplay' }) }, price, facilitator: okFacilitator, nowMs: 1000, seenNonces: seen });
  assert.equal(first.status, 200);
  const second = await gate({ headers: { [HEADERS.SIGNATURE]: envelope({ nonce: '0xreplay' }) }, price, facilitator: okFacilitator, nowMs: 1000, seenNonces: seen });
  assert.equal(second.status, 402);
  assert.match(second.body.error, /replayed-nonce/);
});

test('malformed signature header decodes to null → 402', () => {
  assert.equal(decodeSignatureHeader('not-base64-!!!'), null);
  assert.equal(decodeSignatureHeader(Buffer.from('{"x402Version":1}').toString('base64')), null); // wrong version
});

// ── end-to-end through the server handler ────────────────────────────────────

const VAULT = '0x' + '1'.repeat(40);

function seededApi(facilitator) {
  const state = applyAll([
    { name: 'VaultCreated', vault: VAULT, blockNumber: 1, logIndex: 0, args: { vault: VAULT, creator: '0x' + 'a'.repeat(40), usdc: USDC, capacityCapUsdc: 1000n } },
    { name: 'OperatorRegistered', vault: VAULT, blockNumber: 1, logIndex: 1, args: { opId: 1, operator: '0x' + 'a'.repeat(40) } },
    { name: 'VaultAttested', vault: VAULT, blockNumber: 1, logIndex: 2, args: { vault: VAULT, opId: 1 } },
    { name: 'RealizationRecorded', vault: VAULT, blockNumber: 2, logIndex: 0, args: { opId: 1, gainUsdc: 100n, lossUsdc: 0n } },
  ]);
  return createApi({ state, facilitator, price, now: () => 1000 });
}

test('health route is free', async () => {
  const api = seededApi(okFacilitator);
  const r = await api.handle('GET', '/health', {});
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
});

test('vault route requires payment then serves data', async () => {
  const api = seededApi(okFacilitator);
  const unpaid = await api.handle('GET', `/vaults/${VAULT}`, {});
  assert.equal(unpaid.status, 402);

  const paid = await api.handle('GET', `/vaults/${VAULT}`, { [HEADERS.SIGNATURE]: envelope({ nonce: '0xv1' }) });
  assert.equal(paid.status, 200);
  assert.equal(JSON.parse(paid.body).operatorId, 1);
});

test('leaderboard route serves aggregated operators when paid', async () => {
  const api = seededApi(okFacilitator);
  const paid = await api.handle('GET', '/operators/leaderboard', { [HEADERS.SIGNATURE]: envelope({ nonce: '0xlb1' }) });
  assert.equal(paid.status, 200);
  const body = JSON.parse(paid.body);
  assert.equal(body.leaderboard[0].netRealizedUsdc, '100');
});
