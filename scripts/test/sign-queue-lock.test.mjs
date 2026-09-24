// @ts-check
/**
 * The lost-update race Security reproduced on #382, which predates it (it came in with #381).
 * A GET poll reads the queue, awaits the chain to confirm a `sent` item, then writes its whole copy
 * back. A Sign POST that recorded another item's hash inside that window was overwritten: the item
 * went back to pending with no hash, its real transaction still mined, and the nonce gate then
 * refused it forever. Both handlers now take one lock around their read-modify-write.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSignQueueResponse, recordSentHash } from '../lib/sign-queue-server.mjs';
import { readQueue, writeQueueAtomic } from '../lib/sign-queue.mjs';

const TMP = mkdtempSync(path.join(tmpdir(), 'sign-queue-lock-test-'));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const FROM = '0xF000000000000000000000000000000000000f';
const TO = '0xA000000000000000000000000000000000000a';
const DATA = '0xabcdef';
const HASH_A = `0x${'a1'.repeat(32)}`;
const HASH_B = `0x${'b2'.repeat(32)}`;

const item = (over) => ({
  id: 'x', order: 1, chainId: 84532, chainName: 'Base Sepolia', what: 'w', from: FROM, to: TO, value: '0',
  data: DATA, dataTemplate: null, dependsOn: [], status: 'pending', txHash: null, receipt: null,
  predictedAddress: null, expectedNonce: null, sentData: null, builder: 'test', builtAt: 'now',
  sentAt: null, doneAt: null, verifyNote: null, ...over,
});

/** A SLOW chain (300 ms per call), so the poll is still awaiting it when the POST lands. A is
 * mined and matches, so the poll advances it to done and writes. */
function slowChain() {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    await new Promise((r) => setTimeout(r, 300));
    let result = null;
    if (body.params?.[0] === HASH_A) {
      result = body.method === 'eth_getTransactionByHash'
        ? { hash: HASH_A, from: FROM, to: TO, input: DATA, blockNumber: '0x1' }
        : { status: '0x1', from: FROM, to: TO, contractAddress: null, logs: [], blockNumber: '0x1' };
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
  };
}

test('a Sign POST that lands while a poll is confirming another item is NOT lost', async () => {
  const q = path.join(TMP, 'queue.json');
  writeQueueAtomic({ items: [
    item({ id: 'A', order: 1, status: 'sent', txHash: HASH_A, sentData: DATA, sentAt: new Date().toISOString() }),
    item({ id: 'B', order: 2 }),
  ] }, q);

  const castStub = () => { throw new Error('no cast needed for literal data'); };
  const poll = buildSignQueueResponse(slowChain(), castStub, q);
  await new Promise((r) => setTimeout(r, 50)); // the poll has read the queue and is awaiting the chain
  const post = await recordSentHash('B', { hash: HASH_B, from: FROM }, slowChain(), castStub, q);
  assert.equal(post.code, 200, post.msg);
  await poll;

  const after = readQueue(q);
  const a = after.items.find((i) => i.id === 'A');
  const b = after.items.find((i) => i.id === 'B');
  assert.equal(a.status, 'done', 'the poll still confirms A');
  assert.equal(b.status, 'sent', 'B\'s recorded send must survive the poll\'s write');
  assert.equal(b.txHash, HASH_B);
});
