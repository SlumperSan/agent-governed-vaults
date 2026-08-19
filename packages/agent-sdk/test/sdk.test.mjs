// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProtocolClient, ProtocolError } from '../src/index.mjs';
import { authorizeFromChallenge, buildTypedData } from '../src/eip3009.mjs';
import { gate } from '../../../apps/api/src/x402.mjs';

const USDC = '0x' + 'c'.repeat(40);
const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC };
const wallet = { address: '0x' + 'a'.repeat(40), sign: async () => '0x' + 'f'.repeat(130) };

function makeRes(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => body };
}

test('buildTypedData produces a valid EIP-3009 TransferWithAuthorization struct', () => {
  const td = buildTypedData({
    authorization: { from: wallet.address, to: '0xpay', value: '10000', validAfter: '0', validBefore: '999', nonce: '0xabc', asset: USDC },
    domain,
  });
  assert.equal(td.primaryType, 'TransferWithAuthorization');
  assert.equal(td.domain.chainId, 8453);
  assert.equal(td.message.value, '10000');
  assert.ok(td.types.TransferWithAuthorization.find((f) => f.name === 'nonce' && f.type === 'bytes32'));
});

test('authorizeFromChallenge signs and wraps into a V2 envelope', async () => {
  const challenge = { asset: USDC, amount: '10000', payTo: '0xpay', network: 'base', nonce: '0xnonce' };
  let signedTd = null;
  const env = await authorizeFromChallenge({
    challenge, walletAddress: wallet.address, domain, nowSec: 1000,
    sign: async (td) => { signedTd = td; return '0xsig'; },
  });
  assert.equal(env.x402Version, 2);
  assert.equal(env.authorization.value, '10000');
  assert.equal(env.authorization.to, '0xpay');
  assert.equal(env.authorization.from, wallet.address);
  assert.equal(env.network, 'base');
  assert.equal(signedTd.primaryType, 'TransferWithAuthorization');
});

test('client follows 402 → authorize → retry and returns typed data', async () => {
  const challenge = { asset: USDC, amount: '10000', payTo: '0xpay', network: 'base', nonce: '0xn1' };
  const fetchImpl = async (url, opts) => {
    if (!opts?.headers?.['payment-signature'])
      return makeRes(402, { error: 'payment required' }, { 'payment-required': JSON.stringify(challenge) });
    return makeRes(200, { leaderboard: [{ operatorId: 1, operator: 'Meridian', netRealizedUsdc: '500' }] }, { 'payment-response': JSON.stringify({ receiptId: 'r1' }) });
  };
  const client = createProtocolClient({ baseUrl: 'http://x', wallet, domain, fetchImpl, nowSec: () => 1000 });
  const { data, receipt } = await client.leaderboard();
  assert.equal(data.leaderboard[0].operator, 'Meridian');
  assert.equal(receipt.receiptId, 'r1');
});

test('free route needs no signature', async () => {
  let signed = false;
  const w2 = { address: wallet.address, sign: async () => { signed = true; return '0x'; } };
  const client = createProtocolClient({ baseUrl: 'http://x', wallet: w2, domain, fetchImpl: async () => makeRes(200, { ok: true, lastBlock: 42 }) });
  const health = await client.health();
  assert.equal(health.lastBlock, 42);
  assert.equal(signed, false);
});

test('ProtocolError carries status and body on failure', async () => {
  const client = createProtocolClient({ baseUrl: 'http://x', wallet, domain, fetchImpl: async () => makeRes(404, { error: 'unknown vault' }) });
  await assert.rejects(() => client.getVault('0xzzz'), (e) => e instanceof ProtocolError && e.status === 404 && e.message === 'unknown vault');
});

// ── the SDK envelope actually satisfies the SERVER gate (contract-level integration) ──
test('SDK-produced envelope is accepted by the real server gate', async () => {
  const price = { asset: USDC, amount: '10000', payTo: '0x' + 'd'.repeat(40), network: 'base' };
  const challenge = { asset: price.asset, amount: price.amount, payTo: price.payTo, network: price.network, nonce: '0xintegration' };
  const envelope = await authorizeFromChallenge({ challenge, walletAddress: wallet.address, domain, sign: async () => '0xsig', nowSec: 1000 });
  const sigHeader = Buffer.from(JSON.stringify(envelope)).toString('base64');

  const facilitator = { async verifyAndSettle() { return { ok: true, receiptId: 'ok' }; } };
  const verdict = await gate({ headers: { 'payment-signature': sigHeader }, price, facilitator, nowMs: 1000_000 });
  assert.equal(verdict.status, 200, 'server accepts the SDK envelope end to end');
});
