// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  EVENT_LOG_FIELDS, EXEC_FAILURE_TOPIC, EXEC_SUCCESS_TOPIC,
  mergeBuiltItems, resolveTemplates, verifyReceipt,
} from '../lib/sign-queue.mjs';
import { preValidatedSignature } from '../lib/safe-exec.mjs';

const hasCast = (() => {
  try { execFileSync('cast', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

// ─────────────────────────────── resolveTemplates ───────────────────────────────

function doneItem(id, extra = {}) {
  return { id, status: 'done', receipt: { contractAddress: null, logs: [] }, ...extra };
}

test('resolveTemplates: a string with no template markers passes through unchanged', () => {
  const r = resolveTemplates('0xdeadbeef', new Map());
  assert.deepEqual(r, { ok: true, resolved: '0xdeadbeef' });
});

test('resolveTemplates: {{item:x.contractAddress}} resolves from a DONE item\'s stored receipt', () => {
  const items = new Map([['arc-oracle', doneItem('arc-oracle', { receipt: { contractAddress: '0xAbC0000000000000000000000000000000000A', logs: [] } })]]);
  const r = resolveTemplates('before {{item:arc-oracle.contractAddress}} after', items);
  assert.equal(r.ok, true);
  assert.equal(r.resolved, 'before 0xAbC0000000000000000000000000000000000A after');
});

test('resolveTemplates: a referenced item that does not exist refuses, naming it', () => {
  const r = resolveTemplates('{{item:nope.contractAddress}}', new Map());
  assert.equal(r.ok, false);
  assert.match(r.reason, /"nope".*does not exist/);
});

test('resolveTemplates: a referenced item that is not yet done refuses, never substitutes a stale/placeholder value', () => {
  const items = new Map([['arc-oracle', { id: 'arc-oracle', status: 'pending', receipt: null }]]);
  const r = resolveTemplates('{{item:arc-oracle.contractAddress}}', items);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not done yet/);
});

test('resolveTemplates: {{item:x.log:VaultCreated.vault}} resolves the indexed topic, lowercase-padded correctly', () => {
  const vault = '0x1111111111111111111111111111111111111111';
  const log = { address: '0xfactory', topics: [EVENT_LOG_FIELDS.VaultCreated.topic0, `0x${'00'.repeat(12)}${vault.slice(2)}`, '0x' + '0'.repeat(64)] };
  const items = new Map([['create', doneItem('create', { receipt: { contractAddress: null, logs: [log] } })]]);
  const r = resolveTemplates('{{item:create.log:VaultCreated.vault}}', items);
  assert.equal(r.ok, true);
  assert.equal(r.resolved.toLowerCase(), vault.toLowerCase());
});

test('resolveTemplates: a done item whose receipt has no matching event log refuses', () => {
  const items = new Map([['create', doneItem('create', { receipt: { contractAddress: null, logs: [] } })]]);
  const r = resolveTemplates('{{item:create.log:VaultCreated.vault}}', items);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no VaultCreated log/);
});

test('EVENT_LOG_FIELDS.VaultCreated.topic0 is really keccak256("VaultCreated(address,address,address,uint256)") — re-derived independently, not hand-transcribed', { skip: !hasCast && 'cast not on PATH' }, () => {
  const real = execFileSync('cast', ['keccak', 'VaultCreated(address,address,address,uint256)'], { encoding: 'utf8' }).trim();
  assert.equal(real.toLowerCase(), EVENT_LOG_FIELDS.VaultCreated.topic0.toLowerCase());
});

test('EXEC_SUCCESS_TOPIC / EXEC_FAILURE_TOPIC are really keccak256 of the Safe event signatures', { skip: !hasCast && 'cast not on PATH' }, () => {
  const success = execFileSync('cast', ['keccak', 'ExecutionSuccess(bytes32,uint256)'], { encoding: 'utf8' }).trim();
  const failure = execFileSync('cast', ['keccak', 'ExecutionFailure(bytes32,uint256)'], { encoding: 'utf8' }).trim();
  assert.equal(success.toLowerCase(), EXEC_SUCCESS_TOPIC.toLowerCase());
  assert.equal(failure.toLowerCase(), EXEC_FAILURE_TOPIC.toLowerCase());
});

// ─────────────────────────────── verifyReceipt ───────────────────────────────

function baseItem(over = {}) {
  return {
    id: 'x', from: '0xF000000000000000000000000000000000000f', to: '0xA000000000000000000000000000000000000a',
    sentData: '0xabcdef', predictedAddress: null, expectsSafeExecution: false, expectedLog: null, ...over,
  };
}
const okReceipt = () => ({ status: '0x1', from: baseItem().from, to: baseItem().to, contractAddress: null, logs: [] });
const okTx = () => ({ from: baseItem().from, to: baseItem().to, input: '0xabcdef' });

test('verifyReceipt: a fully matching call item confirms (null = confirmed)', () => {
  assert.equal(verifyReceipt({ item: baseItem(), tx: okTx(), receipt: okReceipt() }), null);
});

test('verifyReceipt: a reverted receipt (status != 1) is rejected, never confirmed', () => {
  const r = verifyReceipt({ item: baseItem(), tx: okTx(), receipt: { ...okReceipt(), status: '0x0' } });
  assert.match(r, /status/);
});

test('verifyReceipt: mismatched tx.from is rejected — a foreign hash "changes nothing"', () => {
  const r = verifyReceipt({ item: baseItem(), tx: { ...okTx(), from: '0x9999999999999999999999999999999999999a' }, receipt: okReceipt() });
  assert.match(r, /tx\.from/);
});

test('verifyReceipt: mismatched tx.to is rejected', () => {
  const r = verifyReceipt({ item: baseItem(), tx: { ...okTx(), to: '0x9999999999999999999999999999999999999a' }, receipt: okReceipt() });
  assert.match(r, /tx\.to/);
});

test('verifyReceipt: mismatched input (tx.input != item.sentData) is rejected — never compared against receipt.input, which does not exist', () => {
  const r = verifyReceipt({ item: baseItem(), tx: { ...okTx(), input: '0xffffff' }, receipt: okReceipt() });
  assert.match(r, /input/);
});

test('verifyReceipt: a CREATE item (to:null) requires receipt.contractAddress == predictedAddress', () => {
  const item = baseItem({ to: null, predictedAddress: '0xC000000000000000000000000000000000000c' });
  const tx = { from: item.from, to: null, input: item.sentData };
  const good = verifyReceipt({ item, tx, receipt: { status: '0x1', from: item.from, to: null, contractAddress: item.predictedAddress, logs: [] } });
  assert.equal(good, null);
  const bad = verifyReceipt({ item, tx, receipt: { status: '0x1', from: item.from, to: null, contractAddress: '0xD000000000000000000000000000000000000d', logs: [] } });
  assert.match(bad, /contractAddress/);
});

test('verifyReceipt: expectsSafeExecution requires an ExecutionSuccess log from the Safe, and ExecutionFailure is a hard rejection even though the outer status is 0x1', () => {
  const item = baseItem({ expectsSafeExecution: true });
  const tx = okTx();
  const noLog = verifyReceipt({ item, tx, receipt: okReceipt() });
  assert.match(noLog, /ExecutionSuccess/);
  const withFailure = verifyReceipt({
    item, tx,
    receipt: { ...okReceipt(), logs: [{ address: item.to, topics: [EXEC_FAILURE_TOPIC], data: '0x' }] },
  });
  assert.match(withFailure, /ExecutionFailure/);
  const withSuccess = verifyReceipt({
    item, tx,
    receipt: { ...okReceipt(), logs: [{ address: item.to, topics: [EXEC_SUCCESS_TOPIC], data: '0x' }] },
  });
  assert.equal(withSuccess, null);
});

test('verifyReceipt: expectedLog requires that exact event from that exact emitter', () => {
  const emitter = '0xE000000000000000000000000000000000000e';
  const item = baseItem({ expectedLog: { event: 'VaultCreated', emitter } });
  const tx = okTx();
  const missing = verifyReceipt({ item, tx, receipt: okReceipt() });
  assert.match(missing, /VaultCreated/);
  const wrongEmitter = verifyReceipt({
    item, tx,
    receipt: { ...okReceipt(), logs: [{ address: '0xWrong', topics: [EVENT_LOG_FIELDS.VaultCreated.topic0], data: '0x' }] },
  });
  assert.match(wrongEmitter, /VaultCreated/);
  const ok = verifyReceipt({
    item, tx,
    receipt: { ...okReceipt(), logs: [{ address: emitter, topics: [EVENT_LOG_FIELDS.VaultCreated.topic0], data: '0x' }] },
  });
  assert.equal(ok, null);
});

// ─────────────────────────────── mergeBuiltItems ───────────────────────────────

function descItem(id, over = {}) {
  return {
    id, order: 1, chainId: 5042, chainName: 'Arc', what: 'w', from: '0xf', to: null, value: '0',
    data: '0xd', dataTemplate: null, dependsOn: [], predictedAddress: null, expectedNonce: 0,
    builder: 'arc-deploy', status: 'pending', ...over,
  };
}

test('mergeBuiltItems: a fresh item is inserted', () => {
  const out = mergeBuiltItems([], [descItem('a')], 'arc-deploy');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
});

test('mergeBuiltItems: rebuilding a PENDING item overwrites freely (idempotent, nothing irreversible happened)', () => {
  const existing = [descItem('a', { what: 'old what' })];
  const out = mergeBuiltItems(existing, [descItem('a', { what: 'new what' })], 'arc-deploy');
  assert.equal(out[0].what, 'new what');
});

test('mergeBuiltItems: rebuilding a SENT item with IDENTICAL descriptive fields is a no-op that preserves lifecycle state', () => {
  const existing = [descItem('a', { status: 'sent', txHash: '0xhash' })];
  const out = mergeBuiltItems(existing, [descItem('a', { status: 'pending' })], 'arc-deploy');
  assert.equal(out[0].status, 'sent'); // lifecycle state preserved, not reset to the recomputed 'pending'
  assert.equal(out[0].txHash, '0xhash');
});

test('mergeBuiltItems: rebuilding a SENT item with a DIFFERENT descriptive field (e.g. data changed) THROWS rather than silently redescribing an in-flight transaction', () => {
  const existing = [descItem('a', { status: 'sent', txHash: '0xhash', data: '0xold' })];
  assert.throws(
    () => mergeBuiltItems(existing, [descItem('a', { status: 'pending', data: '0xnew' })], 'arc-deploy'),
    /already sent.*DIFFERENT data/s,
  );
});

test('mergeBuiltItems: rebuilding a DONE item with a different expectedNonce (e.g. a stale re-read) THROWS', () => {
  const existing = [descItem('a', { status: 'done', expectedNonce: 5 })];
  assert.throws(
    () => mergeBuiltItems(existing, [descItem('a', { status: 'pending', expectedNonce: 6 })], 'arc-deploy'),
    /already done.*DIFFERENT expectedNonce/s,
  );
});

test('mergeBuiltItems: items belonging to OTHER builders are left untouched', () => {
  const existing = [descItem('x', { builder: 'first-vault', status: 'sent' })];
  const out = mergeBuiltItems(existing, [descItem('a')], 'arc-deploy');
  assert.equal(out.length, 2);
  assert.ok(out.find((it) => it.id === 'x' && it.status === 'sent'));
});

// ─────────────────────────────── preValidatedSignature ───────────────────────────────

test('preValidatedSignature: 65 bytes, pad32(owner) . 32 zero bytes . 0x01 — Safe v1.4.1 checkNSignatures v==1 branch', () => {
  const owner = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
  const sig = preValidatedSignature(owner);
  assert.equal(sig.length, 2 + 65 * 2);
  assert.equal(sig.slice(0, 2), '0x');
  const r = sig.slice(2, 66);
  const s = sig.slice(66, 130);
  const v = sig.slice(130, 132);
  assert.equal(r, owner.slice(2).toLowerCase().padStart(64, '0'));
  assert.equal(s, '0'.repeat(64));
  assert.equal(v, '01');
});

test('preValidatedSignature: rejects anything that is not a 20-byte address', () => {
  assert.throws(() => preValidatedSignature('not-an-address'));
  assert.throws(() => preValidatedSignature('0x1234'));
});
