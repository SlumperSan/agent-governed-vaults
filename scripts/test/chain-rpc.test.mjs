// @ts-check
/**
 * `scripts/lib/chain-rpc.mjs`: `rpcCall` never throws, and each thin wrapper sends the method and
 * params its name says. Every request goes to a stub `fetchImpl`; nothing reaches a network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ethCall,
  ethChainId,
  ethGetCode,
  ethGetTransactionByHash,
  ethGetTransactionCountPending,
  ethGetTransactionReceipt,
  rpcCall,
} from '../lib/chain-rpc.mjs';

const URL_ = 'https://rpc.example.invalid';
const ADDR = '0x' + '1'.repeat(40);
const HASH = '0x' + 'a'.repeat(64);

/** A fetch stub that records each request body and answers with `respond(body)`. */
function recorder(respond = () => ({ jsonrpc: '2.0', id: 1, result: '0x1' })) {
  /** @type {any[]} */
  const calls = [];
  /** @type {any} */
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, opts, body });
    return { ok: true, status: 200, json: async () => respond(body) };
  };
  return { calls, fetchImpl };
}

test('rpcCall posts a JSON-RPC 2.0 body with a timeout signal and returns the result', async () => {
  const { calls, fetchImpl } = recorder(() => ({ result: '0x2a' }));
  const r = await rpcCall(fetchImpl, URL_, 'eth_blockNumber', []);
  assert.deepEqual(r, { ok: true, result: '0x2a' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
  assert.ok(calls[0].opts.signal instanceof AbortSignal);
  assert.deepEqual(calls[0].body, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
});

test('rpcCall: a null result is a result, not a missing one', async () => {
  const { fetchImpl } = recorder(() => ({ result: null }));
  assert.deepEqual(await rpcCall(fetchImpl, URL_, 'eth_getTransactionReceipt', [HASH]), { ok: true, result: null });
});

test('rpcCall turns every failure into ok:false with the method named', async () => {
  /** @type {Array<[string, any, RegExp]>} */
  const cases = [
    ['network', async () => { throw new Error('ECONNREFUSED'); }, /^m: request failed — ECONNREFUSED$/],
    ['http', async () => ({ ok: false, status: 503 }), /^m: HTTP 503$/],
    ['not json', async () => ({ ok: true, json: async () => { throw new Error('bad token'); } }), /^m: response was not JSON — bad token$/],
    ['rpc error', async () => ({ ok: true, json: async () => ({ error: { code: -32000, message: 'execution reverted' } }) }), /^m: RPC error — execution reverted$/],
    ['rpc error without message', async () => ({ ok: true, json: async () => ({ error: { code: 7 } }) }), /^m: RPC error — \{"code":7\}$/],
    ['no result', async () => ({ ok: true, json: async () => ({ id: 1 }) }), /^m: no result in response$/],
    ['null body', async () => ({ ok: true, json: async () => null }), /^m: no result in response$/],
  ];
  for (const [name, fetchImpl, re] of cases) {
    const r = await rpcCall(fetchImpl, URL_, 'm', []);
    assert.equal(r.ok, false, name);
    assert.match(/** @type {any} */ (r).reason, re, name);
  }
});

test('rpcCall honours the timeout argument', async () => {
  /** @type {any} */
  const hang = (_u, opts) =>
    new Promise((_res, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason)));
  // AbortSignal.timeout's timer is unref'd, so hold the event loop open until it fires.
  const keepAlive = setTimeout(() => {}, 5000);
  const r = await rpcCall(hang, URL_, 'm', [], 20);
  clearTimeout(keepAlive);
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).reason, /^m: request failed — /);
});

test('each wrapper sends its own method and params', async () => {
  const { calls, fetchImpl } = recorder();
  await ethCall(fetchImpl, URL_, ADDR, '0xdeadbeef');
  await ethGetCode(fetchImpl, URL_, ADDR);
  await ethChainId(fetchImpl, URL_);
  await ethGetTransactionCountPending(fetchImpl, URL_, ADDR);
  await ethGetTransactionByHash(fetchImpl, URL_, HASH);
  await ethGetTransactionReceipt(fetchImpl, URL_, HASH);
  assert.deepEqual(
    calls.map((c) => [c.body.method, c.body.params]),
    [
      ['eth_call', [{ to: ADDR, data: '0xdeadbeef' }, 'latest']],
      ['eth_getCode', [ADDR, 'latest']],
      ['eth_chainId', []],
      // PENDING, not latest: the nonce gate needs the count MetaMask will queue off.
      ['eth_getTransactionCount', [ADDR, 'pending']],
      ['eth_getTransactionByHash', [HASH]],
      ['eth_getTransactionReceipt', [HASH]],
    ],
  );
  for (const c of calls) assert.equal(c.url, URL_);
});
