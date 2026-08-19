// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/api-client.mjs';

// Minimal Headers/Response stand-ins for node:test (no DOM).
function makeRes(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

// btoa polyfill for node
globalThis.btoa = globalThis.btoa ?? ((s) => Buffer.from(s, 'binary').toString('base64'));

test('follows the 402 → authorize → retry loop and returns data + receipt', async () => {
  const calls = [];
  const challenge = { asset: '0xUSDC', amount: '10000', payTo: '0xpay', network: 'base', nonce: '0xn' };
  const fetchImpl = async (url, opts) => {
    calls.push(opts?.headers ?? null);
    if (!opts?.headers?.['payment-signature'])
      return makeRes(402, { error: 'payment required' }, { 'payment-required': JSON.stringify(challenge) });
    return makeRes(200, { operatorId: 7 }, { 'payment-response': JSON.stringify({ receiptId: 'r1' }) });
  };
  const signer = async (ch) => {
    assert.equal(ch.amount, '10000');
    return { x402Version: 2, network: 'base', signature: '0xsig', authorization: { asset: ch.asset, to: ch.payTo, value: ch.amount, nonce: ch.nonce } };
  };

  const client = createClient({ baseUrl: 'http://x', signer, fetchImpl });
  const { data, receipt } = await client.get('/vaults/0xabc');
  assert.equal(data.operatorId, 7);
  assert.equal(receipt.receiptId, 'r1');
  assert.equal(calls.length, 2); // unpaid then paid
  assert.ok(calls[1]['payment-signature']);
});

test('free route returns immediately without invoking the signer', async () => {
  let signerCalled = false;
  const fetchImpl = async () => makeRes(200, { ok: true });
  const client = createClient({ baseUrl: 'http://x', signer: async () => { signerCalled = true; return {}; }, fetchImpl });
  const { data } = await client.get('/health');
  assert.equal(data.ok, true);
  assert.equal(signerCalled, false);
});

test('surfaces a non-2xx, non-402 error', async () => {
  const fetchImpl = async () => makeRes(404, { error: 'unknown vault' });
  const client = createClient({ baseUrl: 'http://x', signer: async () => ({}), fetchImpl });
  await assert.rejects(() => client.get('/vaults/0xzzz'), /HTTP 404/);
});
