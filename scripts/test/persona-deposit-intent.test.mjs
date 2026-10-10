// @ts-check
/**
 * `personaIntentRefusal` (scripts/lib/sign-queue-preconditions.mjs): a persona item is signable only
 * if the bytes the page will send match a DECLARED intent the builder did not write — the #329
 * lesson applied to deposits (Chairman, via the CEO, 2026-09-24).
 *
 * The passing items here are built by the REAL builder (`persona-deposit.mjs`'s `build()`), with
 * calldata encoded by viem rather than by the module under test, so a pass means the check and the
 * builder agree independently. Every refusal case changes exactly one field of a passing item.
 * The wiring tests at the bottom go through the real `buildSignQueueResponse`.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeFunctionData, parseAbiItem, toFunctionSelector } from 'viem';
import { personaIntentRefusal } from '../lib/sign-queue-preconditions.mjs';
import { build } from '../sign-queue/persona-deposit.mjs';
import { validateSeededAddressesDoc } from '../lib/seeded-addresses.mjs';
import * as server from '../lib/sign-queue-server.mjs';
import * as sq from '../lib/sign-queue.mjs';

const VAULT = '0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6';
const USDC = '0x3600000000000000000000000000000000000000';
const FROM = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const AMOUNT = 100_000_000n;

const roots = [];
after(() => { for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

const ENTRY = {
  address: FROM, persona: 'Ballast', model: 'x', fundedBy: 'x', addedAt: 'x', note: 'x',
  intendedDeposit: { vault: VAULT, amountUsdcRaw: AMOUNT.toString() },
};

function fixtureRoot({ entries = [ENTRY], recordVault = VAULT, chainId = 5042, usdc = USDC, omit = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'persona-intent-'));
  roots.push(root);
  const put = (rel, doc) => {
    if (omit.includes(rel)) return;
    const p = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(doc));
  };
  put('docs/seeded-addresses.json', { readme: 'x', addresses: entries });
  put('contracts/config/deployments/arc-mainnet.json', { chainId, firstVault: { address: recordVault } });
  put('contracts/config/arc-mainnet.json', { usdc, smoke: { minDepositUsdc: '100000000' } });
  return root;
}

/** A `cast calldata` stand-in that encodes with viem — independent of the module under test. */
function viemCast(args) {
  assert.equal(args[0], 'calldata');
  const [, sig, ...rest] = args;
  const abi = parseAbiItem(`function ${sig}`);
  const typed = rest.map((v, i) => (abi.inputs[i].type === 'uint256' ? BigInt(v) : v));
  return encodeFunctionData({ abi: [abi], args: typed });
}

function builtItems(root, over = {}) {
  const items = build({
    from: FROM, persona: 'Ballast', amountUsdcRaw: AMOUNT, root, castFn: viemCast, readNonce: () => 3, ...over,
  });
  return Object.fromEntries(items.map((it) => [it.personaAction, it]));
}

test('selectors the check rebuilds calldata from match viem', () => {
  // The check hard-codes these; if either drifts every real item would refuse (fail-closed), but the
  // messages would mislead, so pin them.
  assert.equal(toFunctionSelector('approve(address,uint256)'), '0x095ea7b3');
  assert.equal(toFunctionSelector('deposit(uint256)'), '0xb6b55f25');
  assert.equal(toFunctionSelector('activate(address)'), '0x1c5a9d9c');
});

test('all three items the real builder makes pass against a matching declaration', () => {
  const root = fixtureRoot();
  const b = builtItems(root);
  for (const action of ['approve', 'deposit', 'activate']) assert.equal(personaIntentRefusal(b[action], root), null, action);
});

test('calldata in upper-case hex still passes (case is not intent)', () => {
  const root = fixtureRoot();
  const b = builtItems(root);
  assert.equal(personaIntentRefusal({ ...b.approve, data: `0x${b.approve.data.slice(2).toUpperCase()}` }, root), null);
});

const REFUSALS = [
  ['approve to the vault instead of USDC', 'approve', (it) => ({ ...it, to: VAULT }), /addressed to/],
  ['approve spender is another address', 'approve', (it) => ({ ...it, data: viemCast(['calldata', 'approve(address,uint256)', OTHER, AMOUNT.toString()]) }), /calldata/],
  ['approve for max uint256', 'approve', (it) => ({ ...it, data: viemCast(['calldata', 'approve(address,uint256)', VAULT, (2n ** 256n - 1n).toString()]) }), /calldata/],
  ['approve with trailing bytes', 'approve', (it) => ({ ...it, data: `${it.data}00` }), /calldata/],
  ['deposit of a different amount', 'deposit', (it) => ({ ...it, data: viemCast(['calldata', 'deposit(uint256)', '200000000']) }), /calldata/],
  ['deposit through the slippage overload', 'deposit', (it) => ({ ...it, data: viemCast(['calldata', 'deposit(uint256,uint256)', AMOUNT.toString(), '0']) }), /calldata/],
  ['deposit sent to USDC', 'deposit', (it) => ({ ...it, to: USDC }), /addressed to/],
  ['deposit to a contract creation (to: null)', 'deposit', (it) => ({ ...it, to: null }), /addressed to/],
  ['activate for another member', 'activate', (it) => ({ ...it, data: viemCast(['calldata', 'activate(address)', OTHER]) }), /calldata/],
  ['a non-zero value', 'deposit', (it) => ({ ...it, value: '1' }), /value is 1/],
  ['an unparseable value', 'deposit', (it) => ({ ...it, value: 'lots' }), /not a number/],
  ['a dataTemplate', 'approve', (it) => ({ ...it, dataTemplate: { kind: 'safe-exec' } }), /dataTemplate/],
  ['a stored resolvedData', 'approve', (it) => ({ ...it, resolvedData: '0x' }), /resolvedData/],
  ['a non-Arc chainId', 'approve', (it) => ({ ...it, chainId: 1 }), /not Arc/],
  ['item.vault differs from the declaration', 'deposit', (it) => ({ ...it, vault: OTHER }), /item\.vault/],
  ['item.usdc differs from the config', 'approve', (it) => ({ ...it, usdc: OTHER }), /item\.usdc/],
  ['item.amountUsdcRaw differs from the declaration', 'deposit', (it) => ({ ...it, amountUsdcRaw: '100000001' }), /item\.amountUsdcRaw/],
  ['the wrong persona', 'approve', (it) => ({ ...it, persona: 'Momentum' }), /declares .* as "Ballast", not "Momentum"/],
  ['an unknown personaAction', 'approve', (it) => ({ ...it, personaAction: 'withdraw' }), /unknown personaAction/],
];
for (const [name, action, mutate, re] of REFUSALS) {
  test(`refuses: ${name}`, () => {
    const root = fixtureRoot();
    const b = builtItems(root);
    assert.match(String(personaIntentRefusal(mutate(b[action]), root)), re);
  });
}

const DECLARATION_REFUSALS = [
  ['the address is not listed', { entries: [{ ...ENTRY, address: OTHER }] }, /not listed/],
  ['the persona declares no intendedDeposit (watch-only)', { entries: [{ ...ENTRY, intendedDeposit: undefined }] }, /no intendedDeposit/],
  ['the declared amount is not a raw integer string', { entries: [{ ...ENTRY, intendedDeposit: { vault: VAULT, amountUsdcRaw: 100 } }] }, /positive integer string/],
  ['the declared vault is not the deployment record\'s firstVault', { recordVault: OTHER }, /not the deployment record's firstVault/],
  ['the deployment record is not Arc', { chainId: 1 }, /chainId is 1/],
  ['the seeded list is missing', { omit: ['docs/seeded-addresses.json'] }, /seeded-addresses\.json not found/],
  ['the deployment record is missing', { omit: ['contracts/config/deployments/arc-mainnet.json'] }, /deployments\/arc-mainnet\.json not found/],
];
for (const [name, opts, re] of DECLARATION_REFUSALS) {
  test(`refuses when ${name}`, () => {
    // Items are built against a CORRECT root, then checked against the altered declarations.
    const b = builtItems(fixtureRoot());
    assert.match(String(personaIntentRefusal(b.deposit, fixtureRoot(opts))), re);
  });
}

test('the seeded-addresses validator rejects a malformed intendedDeposit and accepts a good one', () => {
  assert.deepEqual(validateSeededAddressesDoc({ readme: 'x', addresses: [ENTRY] }), { ok: true });
  const bad = validateSeededAddressesDoc({ readme: 'x', addresses: [{ ...ENTRY, intendedDeposit: { vault: VAULT.toLowerCase(), amountUsdcRaw: '0' } }] });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.errors.some((e) => /intendedDeposit\.vault/.test(e)) && bad.errors.some((e) => /intendedDeposit\.amountUsdcRaw/.test(e)));
});

// ─────────────── wiring through the real buildSignQueueResponse ───────────────

const TMP = mkdtempSync(path.join(tmpdir(), 'persona-intent-queue-'));
roots.push(TMP);
let qn = 0;
function respond(items, root, fetchImpl) {
  const qp = path.join(TMP, `q${qn++}.json`);
  assert.notEqual(qp, sq.QUEUE_PATH);
  sq.writeQueueAtomic({ items }, qp);
  return server.buildSignQueueResponse(fetchImpl, () => { throw new Error('castFn unused for literal data'); }, qp, root);
}
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

test('wiring: an approve whose calldata is not the declared intent is blocked by the intent check, before any chain read past the nonce', async () => {
  const root = fixtureRoot();
  const b = builtItems(root);
  const tampered = { ...b.approve, data: viemCast(['calldata', 'approve(address,uint256)', OTHER, AMOUNT.toString()]) };
  const fetchImpl = async (_url, opts) => {
    const { method, id } = JSON.parse(opts.body);
    if (method === 'eth_getTransactionCount') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: '0x3' }) };
    throw new Error(`unexpected chain read ${method} — the intent check must refuse first`);
  };
  const res = await respond([tampered], root, fetchImpl);
  const it = res.items.find((x) => x.id === 'persona-ballast-approve');
  assert.equal(it.ready, false);
  assert.match(it.blockedReason, /approve calldata .* is not the declared intent/);
});

test('wiring: a matching approve passes the intent check and reaches the chain-read gates, and is signable when they pass', async () => {
  const root = fixtureRoot();
  const b = builtItems(root);
  const seen = [];
  const fetchImpl = async (_url, opts) => {
    const { method, params, id } = JSON.parse(opts.body);
    seen.push(method);
    if (method === 'eth_getTransactionCount') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: '0x3' }) };
    if (method === 'eth_call') {
      const sel = params[0].data.slice(0, 10);
      const by = { '0xd98656fd': AMOUNT, '0x70a08231': AMOUNT + 1_000_000n, '0xd09074c0': 10n ** 18n };
      if (sel in by) return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(by[sel])}` }) };
    }
    throw new Error(`unstubbed ${method}`);
  };
  const res = await respond([b.approve], root, fetchImpl);
  const it = res.items.find((x) => x.id === 'persona-ballast-approve');
  assert.equal(it.blockedReason, null);
  assert.equal(it.ready, true);
  assert.ok(seen.includes('eth_call'));
});
