// @ts-check
/**
 * Server paths V-381-r1-8083f497 (Security, PR #381) found untested: `advanceSentItems`'s
 * confirm/foreign/revert transitions, `recordSentHash`'s refusals, and the Origin/Host/
 * Content-Type gate this round adds. Every RPC call is a stub — no network, no `cast`, and no
 * writes to the real Sign-queue file (every test that touches disk uses its own temp path under
 * the OS temp dir, removed in `after`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  advanceSentItems, originGateRefusal, recordSentHash,
} from '../lib/sign-queue-server.mjs';
import { QUEUE_PATH, readQueue, writeQueueAtomic } from '../lib/sign-queue.mjs';

const TMP = mkdtempSync(path.join(tmpdir(), 'sign-queue-server-test-'));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const tmpQueuePath = () => path.join(TMP, `q${n++}.json`);

// GUARD AGAINST THIS FILE'S OWN PAST DEFECT: an earlier draft of the `advanceSentItems` tests below
// omitted the `tmpQueuePath()` third argument, so every `changed:true` case (done/foreign-revert/
// failed/grace-period-revert) defaulted to the REAL `QUEUE_PATH` and overwrote the live Sign-queue
// file with a single fake test item — caught only by manually re-inspecting the real file after a
// run, not by anything in this suite. Snapshot the real file's bytes before any test here runs, and
// assert in `after` that not one byte changed. Every test in this file MUST pass an explicit
// `tmpQueuePath()` to any function that can write.
const REAL_QUEUE_BEFORE = existsSync(QUEUE_PATH) ? readFileSync(QUEUE_PATH, 'utf8') : null;
after(() => {
  const nowExists = existsSync(QUEUE_PATH);
  const now = nowExists ? readFileSync(QUEUE_PATH, 'utf8') : null;
  assert.equal(now, REAL_QUEUE_BEFORE, 'a test in this file wrote to the REAL Sign-queue file — every write-capable call must pass an explicit tmpQueuePath()');
});

const FROM = '0xF000000000000000000000000000000000000f';
const TO = '0xA000000000000000000000000000000000000a';
const DATA = '0xabcdef';

function pendingItem(over = {}) {
  return {
    id: 'x', order: 1, chainId: 5042, chainName: 'Arc', what: 'w', from: FROM, to: TO, value: '0',
    data: DATA, dataTemplate: null, dependsOn: [], status: 'pending', txHash: null, receipt: null,
    predictedAddress: null, expectedNonce: null, sentData: null, builder: 'test', builtAt: 'now',
    sentAt: null, doneAt: null, verifyNote: null, ...over,
  };
}

/** A JSON-RPC stub keyed by method; `byHash` maps a tx hash to `{tx, receipt}` (either may be
 * `null` to simulate "not found yet"). Mirrors the shape `rpcCall` (chain-rpc.mjs) expects. */
function stubFetch(byHash) {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const hash = body.params[0];
    const entry = byHash[hash] ?? { tx: null, receipt: null };
    const result = body.method === 'eth_getTransactionByHash' ? entry.tx : entry.receipt;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
  };
}

// ─────────────────────────────── originGateRefusal ───────────────────────────────

test('originGateRefusal: the dashboard\'s own same-origin fetch (Host set, Origin matching, JSON content-type) passes', () => {
  const r = originGateRefusal({ host: '127.0.0.1:4270', origin: 'http://127.0.0.1:4270', 'content-type': 'application/json' }, 4270);
  assert.equal(r, null);
});

test('originGateRefusal: a request with NO Origin header (a plain form POST shape) still passes if Host and Content-Type agree', () => {
  const r = originGateRefusal({ host: '127.0.0.1:4270', 'content-type': 'application/json' }, 4270);
  assert.equal(r, null);
});

test('originGateRefusal: wrong Host refuses — this is what stops DNS rebinding', () => {
  const r = originGateRefusal({ host: 'attacker.example', origin: 'http://127.0.0.1:4270', 'content-type': 'application/json' }, 4270);
  assert.match(r, /Host/);
});

test('originGateRefusal: a present but WRONG Origin refuses, even with the right Host', () => {
  const r = originGateRefusal({ host: '127.0.0.1:4270', origin: 'https://evil.example', 'content-type': 'application/json' }, 4270);
  assert.match(r, /Origin/);
});

test('originGateRefusal: a non-JSON content-type refuses — this is what a no-cors cross-origin POST is stuck with', () => {
  const r = originGateRefusal({ host: '127.0.0.1:4270', origin: 'http://127.0.0.1:4270', 'content-type': 'text/plain' }, 4270);
  assert.match(r, /Content-Type/);
});

test('originGateRefusal: the exact CSRF shape from V-381-r1 (foreign Origin, no CORS preflight content-type) refuses', () => {
  const r = originGateRefusal({ host: '127.0.0.1:4270', origin: 'https://some-website-the-owner-has-open.example', 'content-type': 'text/plain;charset=UTF-8' }, 4270);
  assert.ok(r);
});

// ─────────────────────────────── advanceSentItems ───────────────────────────────

test('advanceSentItems: a matching, successful receipt moves the item to done — and DOES require verifyReceipt (a matching from/to but WRONG input still refuses)', async () => {
  const hash = `0x${'11'.repeat(32)}`;
  const good = {
    tx: { from: FROM, to: TO, input: DATA },
    receipt: { status: '0x1', from: FROM, to: TO, contractAddress: null, logs: [] },
  };
  const queue = { items: [pendingItem({ status: 'sent', txHash: hash, sentData: DATA, sentAt: new Date().toISOString() })] };
  const changed = await advanceSentItems(queue, stubFetch({ [hash]: good }), tmpQueuePath());
  assert.equal(changed, true);
  assert.equal(queue.items[0].status, 'done');

  // Same shape, but the on-chain input does not match what was frozen at send time.
  const wrongInput = {
    tx: { from: FROM, to: TO, input: '0xffffff' },
    receipt: { status: '0x1', from: FROM, to: TO, contractAddress: null, logs: [] },
  };
  const queue2 = { items: [pendingItem({ status: 'sent', txHash: hash, sentData: DATA, sentAt: new Date().toISOString() })] };
  await advanceSentItems(queue2, stubFetch({ [hash]: wrongInput }), tmpQueuePath());
  assert.notEqual(queue2.items[0].status, 'done');
});

test('advanceSentItems: a FOREIGN tx (from does not match) reverts the item to pending — signable again, not stuck at sent', async () => {
  const hash = `0x${'22'.repeat(32)}`;
  const foreign = {
    tx: { from: '0x9999999999999999999999999999999999999a', to: TO, input: DATA },
    receipt: { status: '0x1', from: '0x9999999999999999999999999999999999999a', to: TO, contractAddress: null, logs: [] },
  };
  const queue = { items: [pendingItem({ status: 'sent', txHash: hash, sentData: DATA, sentAt: new Date().toISOString() })] };
  const changed = await advanceSentItems(queue, stubFetch({ [hash]: foreign }), tmpQueuePath());
  assert.equal(changed, true);
  const it = queue.items[0];
  assert.equal(it.status, 'pending');
  assert.equal(it.txHash, null);
  assert.equal(it.sentData, null);
  assert.match(it.verifyNote, /not this item's send|does not match/);
});

test('advanceSentItems: a matching tx that genuinely REVERTED on chain goes to failed, not back to pending', async () => {
  const hash = `0x${'33'.repeat(32)}`;
  const reverted = {
    tx: { from: FROM, to: TO, input: DATA },
    receipt: { status: '0x0', from: FROM, to: TO, contractAddress: null, logs: [] },
  };
  const queue = { items: [pendingItem({ status: 'sent', txHash: hash, sentData: DATA, sentAt: new Date().toISOString() })] };
  await advanceSentItems(queue, stubFetch({ [hash]: reverted }), tmpQueuePath());
  assert.equal(queue.items[0].status, 'failed');
});

test('advanceSentItems: a hash not yet found stays sent (still might just be propagating) — no premature revert', async () => {
  const hash = `0x${'44'.repeat(32)}`;
  const queue = { items: [pendingItem({ status: 'sent', txHash: hash, sentData: DATA, sentAt: new Date().toISOString() })] };
  const changed = await advanceSentItems(queue, stubFetch({ [hash]: { tx: null, receipt: null } }), tmpQueuePath());
  assert.equal(changed, false);
  assert.equal(queue.items[0].status, 'sent');
});

test('advanceSentItems: a hash not found for a LONG time (past the grace period) reverts to pending — the junk-hash recovery path', async () => {
  const hash = `0x${'55'.repeat(32)}`;
  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const queue = { items: [pendingItem({ status: 'sent', txHash: hash, sentData: DATA, sentAt: longAgo })] };
  const changed = await advanceSentItems(queue, stubFetch({ [hash]: { tx: null, receipt: null } }), tmpQueuePath());
  assert.equal(changed, true);
  assert.equal(queue.items[0].status, 'pending');
});

// ─────────────────────────────── recordSentHash ───────────────────────────────

const HASH = `0x${'aa'.repeat(32)}`;

test('recordSentHash: a well-formed hash from the correct signer is recorded, freezing sentData now', async () => {
  const qp = tmpQueuePath();
  writeQueueAtomic({ items: [pendingItem()] }, qp);
  const out = await recordSentHash('x', { hash: HASH, from: FROM }, fetch, () => '', qp);
  assert.equal(out.code, 200);
  const q = readQueue(qp);
  assert.equal(q.items[0].status, 'sent');
  assert.equal(q.items[0].txHash, HASH);
  assert.equal(q.items[0].sentData, DATA);
});

test('recordSentHash: a wrong `from` refuses and changes nothing', async () => {
  const qp = tmpQueuePath();
  writeQueueAtomic({ items: [pendingItem()] }, qp);
  const out = await recordSentHash('x', { hash: HASH, from: '0x1111111111111111111111111111111111111111' }, fetch, () => '', qp);
  assert.equal(out.code, 400);
  assert.equal(readQueue(qp).items[0].status, 'pending');
});

test('recordSentHash: an already-sent item refuses (409), never overwriting the first hash', async () => {
  const qp = tmpQueuePath();
  writeQueueAtomic({ items: [pendingItem({ status: 'sent', txHash: '0xalready', sentData: DATA })] }, qp);
  const out = await recordSentHash('x', { hash: HASH, from: FROM }, fetch, () => '', qp);
  assert.equal(out.code, 409);
  assert.equal(readQueue(qp).items[0].txHash, '0xalready');
});

test('recordSentHash: an item with an unmet dependency refuses', async () => {
  const qp = tmpQueuePath();
  writeQueueAtomic({ items: [pendingItem({ dependsOn: ['missing-dep'] })] }, qp);
  const out = await recordSentHash('x', { hash: HASH, from: FROM }, fetch, () => '', qp);
  assert.equal(out.code, 409);
});

test('recordSentHash: a malformed hash refuses before touching the queue at all', async () => {
  const qp = tmpQueuePath();
  writeQueueAtomic({ items: [pendingItem()] }, qp);
  const out = await recordSentHash('x', { hash: 'not-a-hash', from: FROM }, fetch, () => '', qp);
  assert.equal(out.code, 400);
  assert.equal(readQueue(qp).items[0].status, 'pending');
});

test('recordSentHash: an unknown item id 404s', async () => {
  const qp = tmpQueuePath();
  writeQueueAtomic({ items: [pendingItem()] }, qp);
  const out = await recordSentHash('nope', { hash: HASH, from: FROM }, fetch, () => '', qp);
  assert.equal(out.code, 404);
});
