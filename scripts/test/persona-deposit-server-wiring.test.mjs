// @ts-check
/**
 * Card 210: the SERVER-SIDE WIRING for persona-deposit items — `scripts/lib/sign-queue-server.mjs`'s
 * `preconditionRefusal` branch and its post-`done` shares/NAV/idle/balance recording
 * (`recordPersonaPostCheck`, run from inside `advanceSentItems`). The deep precondition LOGIC
 * (`personaDepositPreconditionRefusal`, `personaActivatePreconditionRefusal`,
 * `personaOrderingGateRefusal`, `seededPersonaRefusal`) is already exercised directly, with every
 * knob independently stubbed, in `scripts/test/persona-deposit-preconditions.test.mjs`; this file
 * proves those functions are actually WIRED to the right item/action and run in the right order,
 * through the real `buildSignQueueResponse`/`advanceSentItems` entry points, against temp queue
 * paths only — see the real-queue-untouched guard below, copied from
 * `scripts/test/sign-queue-server.test.mjs`.
 *
 * `docs/seeded-addresses.json` (PR #391) is NOT merged to `protocol/main` as of this writing, so
 * every persona-deposit item in THIS repo's real checkout is correctly blocked by
 * `seededPersonaRefusal` before any deeper precondition runs — proven directly below, and used
 * deliberately to also prove the nonce gate is checked BEFORE the seeded gate (branch ordering).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { advanceSentItems, buildSignQueueResponse } from '../lib/sign-queue-server.mjs';
import { QUEUE_PATH, writeQueueAtomic } from '../lib/sign-queue.mjs';

const TMP = mkdtempSync(path.join(tmpdir(), 'persona-deposit-server-wiring-test-'));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const tmpQueuePath = () => path.join(TMP, `q${n++}.json`);

// Same guard sign-queue-server.test.mjs uses: prove no test here ever touches the REAL queue file.
const REAL_QUEUE_BEFORE = existsSync(QUEUE_PATH) ? readFileSync(QUEUE_PATH, 'utf8') : null;
after(() => {
  const now = existsSync(QUEUE_PATH) ? readFileSync(QUEUE_PATH, 'utf8') : null;
  assert.equal(now, REAL_QUEUE_BEFORE, 'a test in this file wrote to the REAL Sign-queue file');
});

const VAULT = '0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6';
const USDC = '0x3600000000000000000000000000000000000000';
const FROM = '0x1111111111111111111111111111111111111111';
const AMOUNT = '100000000';
const DATA = '0xdeadbeef';
const word = (n2) => BigInt(n2).toString(16).padStart(64, '0');

function personaItem(over = {}) {
  return {
    id: 'persona-ballast-approve', order: 1, chainId: 5042, chainName: 'Arc',
    what: 'w', from: FROM, to: USDC, value: '0', data: DATA, dataTemplate: null,
    dependsOn: [], status: 'pending', txHash: null, receipt: null, predictedAddress: null,
    expectedNonce: 5, sentData: null, builder: 'persona-deposit', builtAt: 'now',
    sentAt: null, doneAt: null, verifyNote: null,
    persona: 'Ballast', amountUsdcRaw: AMOUNT, vault: VAULT, usdc: USDC,
    personaAction: 'approve', postCheckPlan: { vault: VAULT, usdc: USDC, holder: FROM },
    ...over,
  };
}

const throwFetch = async () => { throw new Error('fetch must not be called'); };

// ─────────────────────────────── preconditionRefusal wiring ───────────────────────────────

test('buildSignQueueResponse: a persona-deposit item with the WRONG live nonce is blocked by the nonce gate, before the seeded-address gate ever runs', async () => {
  const qp = tmpQueuePath();
  writeQueueAtomic({ items: [personaItem({ expectedNonce: 999 })] }, qp);
  const fetchImpl = async (_url, opts) => {
    const { method, id } = JSON.parse(opts.body);
    if (method === 'eth_getTransactionCount') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: '0x5' }) };
    throw new Error(`unexpected further RPC call ${method} — the nonce gate should have refused first`);
  };
  const res = await buildSignQueueResponse(fetchImpl, () => { throw new Error('castFn should not be needed — item.data is already a literal'); }, qp);
  const item = res.items.find((it) => it.id === 'persona-ballast-approve');
  assert.equal(item.ready, false);
  assert.match(item.blockedReason, /live nonce for .* is 5, this item was built expecting 999/);
});

test('buildSignQueueResponse: a persona-deposit item with NO expectedNonce recorded refuses rather than skipping the nonce gate ("a guard that can skip is a guard that will")', async () => {
  const qp = tmpQueuePath();
  writeQueueAtomic({ items: [personaItem({ expectedNonce: null })] }, qp);
  const res = await buildSignQueueResponse(throwFetch, () => { throw new Error('unused'); }, qp);
  const item = res.items.find((it) => it.id === 'persona-ballast-approve');
  assert.equal(item.ready, false);
  assert.match(item.blockedReason, /no expectedNonce recorded/);
});

test('buildSignQueueResponse: with the nonce satisfied, a persona-deposit item for an undisclosed address is blocked by the seeded-address gate', async () => {
  // Runs against THIS real checkout's actual docs/seeded-addresses.json (present once PR #391
  // merges, absent until then) — deliberately not stubbed, so this proves the wiring reaches the
  // real filesystem check. The synthetic FROM address used throughout this file is not a genuine
  // persona wallet either way, so the gate refuses regardless of which state the file is in; the
  // assertion below matches both messages ("not found" pre-#391, "is not listed" post-#391) so this
  // test does not race that merge.
  const qp = tmpQueuePath();
  writeQueueAtomic({ items: [personaItem({ expectedNonce: 5 })] }, qp);
  const fetchImpl = async (_url, opts) => {
    const { method, id } = JSON.parse(opts.body);
    if (method === 'eth_getTransactionCount') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: '0x5' }) };
    throw new Error(`unexpected further RPC call ${method} — seededPersonaRefusal is a filesystem check, not a chain read`);
  };
  const res = await buildSignQueueResponse(fetchImpl, () => { throw new Error('unused'); }, qp);
  const item = res.items.find((it) => it.id === 'persona-ballast-approve');
  assert.equal(item.ready, false);
  assert.match(item.blockedReason, /seeded-addresses\.json/);
});

test('buildSignQueueResponse: the SECOND persona deposit is blocked by the ordering gate until the first persona activate is done (V-398-r1 wiring)', async () => {
  // Reaches the real call site in preconditionRefusal: nonce satisfied, first activate still pending.
  // Replacing the call site with `if (false)` falls through to the seeded-address gate instead, whose
  // message this does not match, so the test goes red.
  const qp = tmpQueuePath();
  const FIRST = '0x2222222222222222222222222222222222222222';
  writeQueueAtomic({ items: [
    personaItem({ id: 'persona-ballast-activate', from: FIRST, personaAction: 'activate', status: 'pending', expectedNonce: 7 }),
    personaItem({ id: 'persona-momentum-deposit', persona: 'Momentum', personaAction: 'deposit', expectedNonce: 5,
      orderingGate: { firstActivateId: 'persona-ballast-activate', firstPersonaFrom: FIRST } }),
  ] }, qp);
  const fetchImpl = async (_url, opts) => {
    const { method, params, id } = JSON.parse(opts.body);
    if (method === 'eth_getTransactionCount') {
      const who = String(params[0]).toLowerCase();
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: who === FIRST.toLowerCase() ? '0x7' : '0x5' }) };
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(0)}` }) };
  };
  const res = await buildSignQueueResponse(fetchImpl, () => { throw new Error('unused'); }, qp);
  const item = res.items.find((it) => it.id === 'persona-momentum-deposit');
  assert.equal(item.ready, false);
  assert.match(item.blockedReason, /waiting on the first persona .* to activate before a second persona may deposit/);
});

// ─────────────────────────────── recordPersonaPostCheck (via advanceSentItems) ───────────────────────────────

test('advanceSentItems: once a persona-deposit item confirms done, its postCheck is recorded from sharesOf/totalShares/navWad/idleUsdc/balanceOf reads', async () => {
  const hash = `0x${'77'.repeat(32)}`;
  const item = {
    id: 'persona-ballast-deposit', order: 2, chainId: 5042, chainName: 'Arc', what: 'w',
    from: FROM, to: VAULT, value: '0', data: DATA, dataTemplate: null, dependsOn: [],
    status: 'sent', txHash: hash, receipt: null, predictedAddress: null, expectedNonce: 6,
    sentData: DATA, builder: 'persona-deposit', builtAt: 'now', sentAt: new Date().toISOString(),
    doneAt: null, verifyNote: null, persona: 'Ballast', amountUsdcRaw: AMOUNT, vault: VAULT, usdc: USDC,
    personaAction: 'deposit', postCheckPlan: { vault: VAULT, usdc: USDC, holder: FROM },
  };
  const queue = { items: [item] };
  const fetchImpl = async (_url, opts) => {
    const { method, params, id } = JSON.parse(opts.body);
    if (method === 'eth_getTransactionByHash') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: { from: FROM, to: VAULT, input: DATA } }) };
    if (method === 'eth_getTransactionReceipt') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: { status: '0x1', from: FROM, to: VAULT, contractAddress: null, logs: [] } }) };
    if (method === 'eth_call') {
      const sel = params[0].data.slice(0, 10);
      const by = {
        '0xf5eb42dc': 123n, // sharesOf(address)
        '0x3a98ef39': 999n, // totalShares()
        '0xd09074c0': 5000n, // navWad()
        '0x047b7fc7': 4000n, // idleUsdc()
        '0x70a08231': 900n, // balanceOf(address) — persona's remaining USDC after the deposit
      };
      if (sel in by) return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(by[sel])}` }) };
      throw new Error(`unstubbed selector ${sel}`);
    }
    throw new Error(`unstubbed method ${method}`);
  };
  const changed = await advanceSentItems(queue, fetchImpl, tmpQueuePath());
  assert.equal(changed, true);
  assert.equal(queue.items[0].status, 'done');
  assert.deepEqual(queue.items[0].postCheck, {
    at: queue.items[0].postCheck.at, // timestamp, not asserted exactly
    sharesOfHolder: '123', totalShares: '999', navWad: '5000', idleUsdc: '4000',
    holderUsdcBalance: '900', holderUsdcBalanceDelta: null, // no sibling approve item in this queue to diff against
    readErrors: [],
  });
  assert.match(queue.items[0].postCheck.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('advanceSentItems: the deposit item\'s holderUsdcBalanceDelta diffs against its sibling approve item\'s ALREADY-RECORDED postCheck balance', async () => {
  const hash = `0x${'99'.repeat(32)}`;
  const approveSibling = {
    id: 'persona-ballast-approve', builder: 'persona-deposit', persona: 'Ballast', personaAction: 'approve',
    postCheck: { holderUsdcBalance: '1000' },
  };
  const depositItem = {
    id: 'persona-ballast-deposit', order: 2, chainId: 5042, chainName: 'Arc', what: 'w',
    from: FROM, to: VAULT, value: '0', data: DATA, dataTemplate: null, dependsOn: ['persona-ballast-approve'],
    status: 'sent', txHash: hash, receipt: null, predictedAddress: null, expectedNonce: 6,
    sentData: DATA, builder: 'persona-deposit', builtAt: 'now', sentAt: new Date().toISOString(),
    doneAt: null, verifyNote: null, persona: 'Ballast', amountUsdcRaw: AMOUNT, vault: VAULT, usdc: USDC,
    personaAction: 'deposit', postCheckPlan: { vault: VAULT, usdc: USDC, holder: FROM },
  };
  const queue = { items: [approveSibling, depositItem] };
  const fetchImpl = async (_url, opts) => {
    const { method, params, id } = JSON.parse(opts.body);
    if (method === 'eth_getTransactionByHash') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: { from: FROM, to: VAULT, input: DATA } }) };
    if (method === 'eth_getTransactionReceipt') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: { status: '0x1', from: FROM, to: VAULT, contractAddress: null, logs: [] } }) };
    if (method === 'eth_call') {
      const sel = params[0].data.slice(0, 10);
      const by = {
        '0xf5eb42dc': 0n, '0x3a98ef39': 0n, '0xd09074c0': 5000n, '0x047b7fc7': 0n,
        '0x70a08231': 900n, // 1000 (approve's recorded balance) - 100 deposited = 900
      };
      if (sel in by) return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(by[sel])}` }) };
      throw new Error(`unstubbed selector ${sel}`);
    }
    throw new Error(`unstubbed method ${method}`);
  };
  await advanceSentItems(queue, fetchImpl, tmpQueuePath());
  const done = queue.items.find((it) => it.id === 'persona-ballast-deposit');
  assert.equal(done.status, 'done');
  assert.equal(done.postCheck.holderUsdcBalance, '900');
  assert.equal(done.postCheck.holderUsdcBalanceDelta, '-100');
});

test('advanceSentItems: an item with NO postCheckPlan (a non-persona-deposit builder) is left with no postCheck field at all', async () => {
  const hash = `0x${'88'.repeat(32)}`;
  const item = {
    id: 'other', order: 1, chainId: 5042, chainName: 'Arc', what: 'w', from: FROM, to: VAULT,
    value: '0', data: DATA, dataTemplate: null, dependsOn: [], status: 'sent', txHash: hash,
    receipt: null, predictedAddress: null, expectedNonce: null, sentData: DATA, builder: 'some-other-builder',
    builtAt: 'now', sentAt: new Date().toISOString(), doneAt: null, verifyNote: null,
  };
  const queue = { items: [item] };
  const fetchImpl = async (_url, opts) => {
    const { method, id } = JSON.parse(opts.body);
    if (method === 'eth_getTransactionByHash') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: { from: FROM, to: VAULT, input: DATA } }) };
    if (method === 'eth_getTransactionReceipt') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: { status: '0x1', from: FROM, to: VAULT, contractAddress: null, logs: [] } }) };
    throw new Error(`unexpected eth_call — recordPersonaPostCheck must be a no-op for a non-persona-deposit item`);
  };
  await advanceSentItems(queue, fetchImpl, tmpQueuePath());
  assert.equal(queue.items[0].status, 'done');
  assert.equal(queue.items[0].postCheck, undefined);
});
