// @ts-check
/**
 * Three Sign queue gates with no direct test of their own: `nonceGateRefusal` and
 * `finalizePreconditionRefusal` (scripts/lib/sign-queue-preconditions.mjs) and `isForeignTx`
 * (scripts/lib/sign-queue.mjs). Every RPC is a stub; nothing reaches a network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPOSIT_GAS_HEADROOM_RAW,
  GAS_HEADROOM_RAW,
  finalizePreconditionRefusal,
  nonceGateRefusal,
} from '../lib/sign-queue-preconditions.mjs';
import { isForeignTx } from '../lib/sign-queue.mjs';
import { P, STATUS } from '../lib/proposal-decode.mjs';

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const GOV = '0x3333333333333333333333333333333333333333';

const word = (n) => BigInt(n).toString(16).padStart(64, '0');

/** A fetch stub answering each JSON-RPC method from `answers[method]` (a result or an error). */
function stub(answers) {
  /** @type {any[]} */
  const seen = [];
  /** @type {any} */
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body);
    const a = answers[body.method];
    if (a === undefined) throw new Error(`unstubbed method ${body.method}`);
    const payload = a instanceof Error ? { error: { message: a.message } } : { result: typeof a === 'function' ? a(body) : a };
    return { ok: true, status: 200, json: async () => payload };
  };
  return { seen, fetchImpl };
}

// ── nonceGateRefusal ──────────────────────────────────────────────────────────

test('nonceGateRefusal passes only on the exact pending nonce', async () => {
  const { seen, fetchImpl } = stub({ eth_getTransactionCount: '0x7' });
  assert.equal(await nonceGateRefusal(fetchImpl, 'u', FROM, 7), null);
  assert.deepEqual(seen[0].params, [FROM, 'pending']);
});

test('nonceGateRefusal refuses a nonce on either side of the expected one', async () => {
  for (const live of ['0x6', '0x8']) {
    const { fetchImpl } = stub({ eth_getTransactionCount: live });
    const r = await nonceGateRefusal(fetchImpl, 'u', FROM, 7);
    assert.match(String(r), new RegExp(`live nonce for ${FROM} is ${Number(live)}, this item was built expecting 7`));
    assert.match(String(r), /Refusing/);
  }
});

test('nonceGateRefusal refuses when the nonce cannot be read', async () => {
  const { fetchImpl } = stub({ eth_getTransactionCount: new Error('rate limited') });
  assert.match(String(await nonceGateRefusal(fetchImpl, 'u', FROM, 0)), /could not read the live nonce .*rate limited/);
});

// ── finalizePreconditionRefusal ───────────────────────────────────────────────

/** ABI words for a `proposals(id)` return with the given status index and reveal deadline. */
function proposalWords(statusIdx, revealDeadline) {
  const words = Array.from({ length: Math.max(P.STATUS, P.REVEAL_DEADLINE) + 4 }, () => word(0));
  words[P.STATUS] = word(statusIdx);
  words[P.REVEAL_DEADLINE] = word(revealDeadline);
  return '0x' + words.join('');
}

const finalizeStub = (statusIdx, revealDeadline, nowSec) =>
  stub({
    eth_call: proposalWords(statusIdx, revealDeadline),
    eth_getBlockByNumber: { timestamp: '0x' + nowSec.toString(16) },
  });

test('finalizePreconditionRefusal: Active and at or past the reveal deadline passes', async () => {
  const active = STATUS.indexOf('Active');
  assert.equal(await finalizePreconditionRefusal(finalizeStub(active, 1000, 1000).fetchImpl, GOV, 4), null);
  assert.equal(await finalizePreconditionRefusal(finalizeStub(active, 1000, 5000).fetchImpl, GOV, 4), null);
});

test('finalizePreconditionRefusal reads proposals(id) on the governance contract', async () => {
  const { seen, fetchImpl } = finalizeStub(STATUS.indexOf('Active'), 1, 2);
  await finalizePreconditionRefusal(fetchImpl, GOV, 4);
  const call = seen.find((b) => b.method === 'eth_call');
  assert.equal(call.params[0].to, GOV);
  assert.equal(call.params[0].data, '0x013cf08b' + word(4));
});

test('finalizePreconditionRefusal: still inside the reveal window refuses', async () => {
  const r = await finalizePreconditionRefusal(finalizeStub(STATUS.indexOf('Active'), 1000, 999).fetchImpl, GOV, 4);
  assert.match(String(r), /still within its reveal window \(chain time 999, deadline 1000\)/);
});

test('finalizePreconditionRefusal: every status but Active refuses by name', async () => {
  for (const name of STATUS.filter((s) => s !== 'Active')) {
    const r = await finalizePreconditionRefusal(finalizeStub(STATUS.indexOf(name), 0, 10).fetchImpl, GOV, 9);
    assert.equal(r, `proposal 9 is ${name}, not Active — finalize() would revert WrongPhase`);
  }
  const r = await finalizePreconditionRefusal(finalizeStub(17, 0, 10).fetchImpl, GOV, 9);
  assert.match(String(r), /is unknown\(17\), not Active/);
});

test('finalizePreconditionRefusal refuses when either read fails', async () => {
  const noProp = stub({ eth_call: new Error('reverted'), eth_getBlockByNumber: { timestamp: '0x1' } });
  assert.match(String(await finalizePreconditionRefusal(noProp.fetchImpl, GOV, 1)), /could not read proposals\(1\): .*reverted/);
  const noClock = stub({ eth_call: proposalWords(1, 0), eth_getBlockByNumber: new Error('down') });
  assert.match(String(await finalizePreconditionRefusal(noClock.fetchImpl, GOV, 1)), /could not read the chain's own clock: .*down/);
});

test('the deposit item headroom is smaller than the approve item headroom', () => {
  assert.equal(DEPOSIT_GAS_HEADROOM_RAW, 100_000n);
  assert.ok(DEPOSIT_GAS_HEADROOM_RAW < GAS_HEADROOM_RAW);
});

// ── isForeignTx ───────────────────────────────────────────────────────────────

const item = (over = {}) => /** @type {any} */ ({ from: FROM, to: TO, sentData: '0xabcdef', ...over });
const tx = (over = {}) => ({ from: FROM, to: TO, input: '0xabcdef', ...over });

test('isForeignTx: the matching transaction is not foreign, whatever the case or padding', () => {
  assert.equal(isForeignTx(item(), tx()), false);
  assert.equal(isForeignTx(item(), tx({ from: ` ${FROM.toUpperCase().replace('0X', '0x')} `, input: '0xABCDEF' })), false);
});

test('isForeignTx: any differing field makes it foreign', () => {
  assert.equal(isForeignTx(item(), tx({ from: TO })), true);
  assert.equal(isForeignTx(item(), tx({ to: FROM })), true);
  assert.equal(isForeignTx(item(), tx({ input: '0xabcdee' })), true);
});

test('isForeignTx: an item without recorded sentData is always foreign', () => {
  assert.equal(isForeignTx(item({ sentData: undefined }), tx()), true);
  assert.equal(isForeignTx(item({ sentData: null }), tx()), true);
});

test('isForeignTx: a CREATE item matches only a transaction with no recipient', () => {
  const create = item({ to: null });
  assert.equal(isForeignTx(create, tx({ to: null })), false);
  assert.equal(isForeignTx(create, tx({ to: undefined })), false);
  assert.equal(isForeignTx(create, tx({ to: TO })), true);
  // And a CALL item does not match a CREATE.
  assert.equal(isForeignTx(item(), tx({ to: null })), true);
});
