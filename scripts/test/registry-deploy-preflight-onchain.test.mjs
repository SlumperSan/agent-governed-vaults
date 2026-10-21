/**
 * On-chain readbacks of scripts/registry-deploy-preflight.mjs, driven by a stubbed RPC (no network).
 * Every refusal has its own case, so removing any one check turns exactly that case red.
 *
 * The getters named here are the ones the preflight relies on, read from
 * contracts/src/RWAllyAgentRegistry.sol at origin/feat/registry-final-454: initialized, owner,
 * treasury, fee, feeToken, outsideRegistry, importIdCeiling. subVaultRegistry is absent at that head.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFunctionSelector } from 'viem';
import { checkOnchain, expectedArgs } from '../registry-deploy-preflight.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CFG = JSON.parse(readFileSync(path.join(REPO, 'contracts', 'config', 'agent-registry-create2.json'), 'utf8'));
const CLI = path.join(REPO, 'scripts', 'registry-deploy-preflight.mjs');

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const TREASURY = '0x4444444444444444444444444444444444444444';
const REGISTRY = CFG.address;
const OUTSIDE = CFG.outsideRegistry['arc-mainnet'];
const SNAP = CFG.importCeilings.chains['ethereum-mainnet'];

const expected = (/** @type {Record<string, any>} */ over = {}) => ({
  chain: 'ethereum-mainnet',
  owner: OWNER,
  feeToken: TOKEN,
  treasury: TREASURY,
  fee: '1000000',
  outsideRegistry: SNAP.outsideRegistry,
  importIdCeiling: String(SNAP.nextId),
  ...over,
});
const wordOf = (/** @type {bigint | string} */ v) => `0x${(typeof v === 'string' ? BigInt(v) : v).toString(16).padStart(64, '0')}`;

/** A registry that holds the expected values, with per-selector overrides: a word, or an Error to revert. */
function chain(/** @type {Record<string, bigint | string | Error>} */ over = {}, opts = {}) {
  const o = /** @type {any} */ (opts);
  const state = {
    'initialized()': 1n,
    'owner()': OWNER,
    'treasury()': TREASURY,
    'feeToken()': TOKEN,
    'fee()': 1000000n,
    'outsideRegistry()': SNAP.outsideRegistry,
    'importIdCeiling()': BigInt(SNAP.nextId),
    ...over,
  };
  const bySel = new Map(Object.entries(state).map(([sig, v]) => [toFunctionSelector(sig), v]));
  bySel.set(toFunctionSelector('subVaultRegistry()'), over['subVaultRegistry()'] ?? new Error('execution reverted'));
  return async (/** @type {string} */ _url, /** @type {any} */ init) => {
    const { method, params } = JSON.parse(init.body);
    const reply = (/** @type {any} */ b) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, ...b }) });
    if (method === 'eth_chainId') return reply({ result: o.chainId ?? '0x1' });
    if (method === 'eth_getCode') return reply({ result: o.noCode ? '0x' : '0x6080' });
    const v = bySel.get(params[0].data);
    if (v === undefined) return reply({ error: { message: 'execution reverted' } });
    if (v instanceof Error) return reply({ error: { message: v.message } });
    return reply({ result: wordOf(v) });
  };
}

const args = () => {
  const r = expectedArgs(CFG, expected());
  assert.deepEqual(r.problems, []);
  return /** @type {NonNullable<typeof r.args>} */ (r.args);
};
const run = (/** @type {any} */ fetchImpl) =>
  checkOnchain({ fetchImpl, rpcUrl: 'http://stub', registry: REGISTRY, chainId: SNAP.chainId, args: args() });

test('a registry holding exactly the expected values passes, and a missing getter is not a failure', async () => {
  assert.deepEqual(await run(chain()), []);
});

test('every readback mismatch is refused, naming the getter', async () => {
  for (const [over, getter] of /** @type {[Record<string, any>, string][]} */ ([
    [{ 'initialized()': 0n }, 'initialized()'],
    [{ 'owner()': OTHER }, 'owner()'],
    [{ 'owner()': 0n }, 'owner()'],
    [{ 'treasury()': OTHER }, 'treasury()'],
    [{ 'feeToken()': OTHER }, 'feeToken()'],
    [{ 'fee()': 1000001n }, 'fee()'],
    [{ 'outsideRegistry()': OTHER }, 'outsideRegistry()'],
    [{ 'importIdCeiling()': BigInt(SNAP.nextId) + 1n }, 'importIdCeiling()'],
    [{ 'importIdCeiling()': 0n }, 'importIdCeiling()'],
    [{ 'subVaultRegistry()': OTHER }, 'subVaultRegistry()'],
  ])) {
    const problems = await run(chain(over));
    assert.ok(problems.some((p) => p.includes(getter)), `${JSON.stringify(over, (_, v) => (typeof v === 'bigint' ? String(v) : v))}: ${problems}`);
  }
});

test('a failed or malformed read is a failure, never a skip', async () => {
  for (const sig of ['initialized()', 'owner()', 'treasury()', 'fee()', 'importIdCeiling()']) {
    const p = await run(chain({ [sig]: new Error('boom') }));
    assert.ok(p.some((m) => m.includes(sig) && /call failed/.test(m)), `${sig}: ${p}`);
  }
  const p = await run(chain({ 'subVaultRegistry()': new Error('connection reset') }));
  assert.ok(p.some((m) => m.includes('subVaultRegistry()') && /call failed/.test(m)), String(p));
  const bad = await run(async () => ({ ok: true, status: 200, json: async () => ({ result: '0x12' }) }));
  assert.ok(bad.length > 0);
});

test('the wrong chain and an undeployed registry are refused before any value is read', async () => {
  const wrongChain = await run(chain({}, { chainId: '0x2105' }));
  assert.equal(wrongChain.length, 1);
  assert.match(wrongChain[0], /different chain/);
  const noCode = await run(chain({}, { noCode: true }));
  assert.equal(noCode.length, 1);
  assert.match(noCode[0], /no code/);
});

test('the expected values refuse a placeholder, a zero address and a ceiling that is not the recorded snapshot', () => {
  for (const [over, re] of /** @type {[Record<string, any>, RegExp][]} */ ([
    [{ importIdCeiling: 'PLACEHOLDER' }, /importIdCeiling is still a placeholder/],
    [{ importIdCeiling: '<snapshot nextId>' }, /importIdCeiling is still a placeholder/],
    [{ importIdCeiling: String(SNAP.nextId + 1) }, /differs from the recorded snapshot/],
    [{ importIdCeiling: '0' }, /no id could ever be imported/],
    [{ importIdCeiling: '-1' }, /importIdCeiling must be a non-negative integer/],
    [{ owner: 'placeholder' }, /owner is still a placeholder/],
    [{ owner: '0x0000000000000000000000000000000000000000' }, /owner must not be the zero address/],
    [{ treasury: '0x1234' }, /treasury must be an address/],
    [{ feeToken: '0x0000000000000000000000000000000000000000' }, /feeToken must not be the zero address/],
    [{ fee: '100000001' }, /exceeds MAX_FEE/],
    [{ fee: 'placeholder' }, /fee is still a placeholder/],
    [{ outsideRegistry: OTHER }, /differs from the recorded/],
    [{ chain: 'no-such-chain' }, /no importCeilings entry/],
  ])) {
    const r = expectedArgs(CFG, expected(over));
    assert.equal(r.args, null, JSON.stringify(over));
    assert.match(r.problems.join('\n'), re, JSON.stringify(over));
  }
  const noImport = expectedArgs(CFG, expected({ outsideRegistry: '0x0000000000000000000000000000000000000000', importIdCeiling: '5' }));
  assert.match(noImport.problems.join('\n'), /must be 0 when outsideRegistry is the zero address/);
  assert.equal(expectedArgs(CFG, expected({ outsideRegistry: '0x0000000000000000000000000000000000000000', importIdCeiling: '0' })).problems.length, 0);
});

test('the CLI prints the initialize arguments, exits 1 on a placeholder ceiling, and refuses --rpc alone', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'registry-onchain-preflight-'));
  try {
    const good = path.join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(expected()));
    const ok = spawnSync(process.execPath, [CLI, '--expected', good], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.includes(`importIdCeiling_ ${SNAP.nextId}`), ok.stdout);
    assert.match(ok.stdout, /calldata\s+0x[0-9a-f]+/);

    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify(expected({ importIdCeiling: 'placeholder' })));
    const red = spawnSync(process.execPath, [CLI, '--expected', bad], { encoding: 'utf8' });
    assert.equal(red.status, 1);
    assert.match(red.stderr, /PREFLIGHT FAIL: importIdCeiling is still a placeholder/);
    assert.ok(!/initialize arguments/.test(red.stdout));

    const alone = spawnSync(process.execPath, [CLI, '--rpc', 'http://127.0.0.1:1'], { encoding: 'utf8' });
    assert.equal(alone.status, 1);
    assert.match(alone.stderr, /--rpc needs --expected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
