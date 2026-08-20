// @ts-check
/**
 * The chain adapter. Two things are worth testing here without a live RPC:
 *
 * 1. extractRevertData — the whole exit-liveness classification rests on it. viem nests the raw
 *    returndata several `cause` levels deep and the shape differs by transport, so a miss here
 *    would turn a real H-1 fault into "no data". That still ALERTS (empty returndata is a fault),
 *    so the failure is loud rather than silent — but it would lose the diagnosis, and these cases
 *    pin the shapes viem actually produces.
 * 2. The read-only guarantee: the reader exposes no way to send a transaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRevertData, createChainReader } from '../src/reader.mjs';

test('pulls returndata off a flat error', () => {
  assert.equal(extractRevertData({ data: '0xAB143C06' }), '0xab143c06');
});

test('walks the cause chain viem builds (ContractFunctionExecutionError → … → RpcRequestError)', () => {
  const err = { message: 'reverted', cause: { shortMessage: 'x', cause: { data: '0xa2671f4b' } } };
  assert.equal(extractRevertData(err), '0xa2671f4b');
});

test('handles the nested { data: { data } } shape', () => {
  assert.equal(extractRevertData({ cause: { data: { data: '0x08c379a0' } } }), '0x08c379a0');
});

test('falls back to scraping the message when no structured field carries it', () => {
  assert.equal(
    extractRevertData({ message: 'execution reverted, data: 0xab143c06 (Reentrancy)' }),
    '0xab143c06',
  );
});

test('returns null when there is genuinely no returndata — callers treat that as a FAULT', () => {
  assert.equal(extractRevertData({ message: 'execution reverted' }), null);
  assert.equal(extractRevertData(new Error('out of gas')), null);
  assert.equal(extractRevertData(null), null);
});

test('does not loop forever on a self-referential cause chain', () => {
  const a = { message: 'a' };
  a.cause = a;
  assert.equal(extractRevertData(a), null);
});

test('ignores a too-short hex value that cannot be a selector', () => {
  assert.equal(extractRevertData({ data: '0x00' }), null);
});

test('the reader exposes reads only — there is no send/sign/write surface', () => {
  const reader = createChainReader({ client: {} });
  assert.deepEqual(Object.keys(reader).sort(), ['chainNow', 'getLogs', 'headBlock', 'read', 'staticCall', 'tryRead']);
  for (const forbidden of ['sendTransaction', 'writeContract', 'signMessage', 'account', 'wallet']) {
    assert.equal(reader[forbidden], undefined, `the canary must expose no ${forbidden}`);
  }
});

test('refuses to build a client with neither an injection nor an rpcUrl', async () => {
  await assert.rejects(() => createChainReader({}).headBlock(), /no client injected and no rpcUrl/);
});

test('getLogs short-circuits an empty address set instead of asking for every log on chain', async () => {
  let called = false;
  const reader = createChainReader({ client: { getLogs: async () => { called = true; return []; } } });
  assert.deepEqual(await reader.getLogs({ address: [], event: {}, fromBlock: 0, toBlock: 1 }), []);
  assert.equal(called, false);
});

test('passes a pinned block through to readContract, and omits it when unpinned', async () => {
  const seen = [];
  const reader = createChainReader({ client: { readContract: async (args) => { seen.push(args); return 1n; } } });
  await reader.read('0xabc', [], 'totalShares', [], { blockNumber: 995 });
  await reader.read('0xabc', [], 'totalShares', []);
  assert.equal(seen[0].blockNumber, 995n);
  assert.equal('blockNumber' in seen[1], false);
});

test('staticCall reports a revert as data rather than throwing', async () => {
  const reader = createChainReader({
    client: { call: async () => { throw { data: '0xab143c06' }; } },
  });
  const res = await reader.staticCall({ to: '0x1', from: '0x2', data: '0x3' });
  assert.equal(res.ok, false);
  assert.equal(res.data, '0xab143c06');
});

test('staticCall passes no explicit gas — a low cap would manufacture failures the chain never has', async () => {
  const seen = [];
  const reader = createChainReader({ client: { call: async (args) => { seen.push(args); return { data: '0x' }; } } });
  await reader.staticCall({ to: '0x1', from: '0x2', data: '0x3' });
  assert.equal('gas' in seen[0], false, 'VaultCore gas-caps its own module calls; the probe must not add a second cap');
});
