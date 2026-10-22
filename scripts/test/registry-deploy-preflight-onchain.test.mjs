/**
 * On-chain readbacks of scripts/registry-deploy-preflight.mjs, driven by a stubbed RPC (no network).
 * Every refusal has its own case, so removing any one check turns exactly that case red.
 *
 * The getters named here are the ones the preflight relies on, read from
 * contracts/src/RWAllyAgentRegistry.sol on protocol/main (after #468): initialized, owner,
 * treasury, fee, feeToken, outsideRegistry, importIdCeiling. subVaultRegistry is absent there.
 * The outside registry is a stub proxy: EIP-1967 implementation and admin slots, and owner().
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
const IMPL = '0x5555555555555555555555555555555555555555';
const ADMIN = '0x6666666666666666666666666666666666666666';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const expected = (/** @type {Record<string, any>} */ over = {}) => ({
  chain: 'ethereum-mainnet',
  owner: OWNER,
  feeToken: TOKEN,
  treasury: TREASURY,
  fee: '1000000',
  outsideRegistry: SNAP.outsideRegistry,
  importIdCeiling: String(SNAP.nextId),
  outsideImplementation: IMPL,
  outsideAdmin: ADMIN,
  ...over,
});
const wordOf = (/** @type {bigint | string} */ v) => `0x${(typeof v === 'string' ? BigInt(v) : v).toString(16).padStart(64, '0')}`;

/**
 * A registry that holds the expected values, with per-selector overrides: a word, or an Error to revert.
 * The outside registry is a UUPS-shaped proxy by default (admin slot empty, owner() the authority);
 * `outside` overrides its 'impl', 'admin' slots and its 'owner()', and `outsideNoCode` removes its code.
 */
function chain(/** @type {Record<string, bigint | string | Error>} */ over = {}, opts = {}) {
  const o = /** @type {any} */ (opts);
  const outside = { impl: IMPL, admin: 0n, 'owner()': ADMIN, ...(o.outside ?? {}) };
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
    const isOutside = (/** @type {string} */ a) => a.toLowerCase() === SNAP.outsideRegistry.toLowerCase();
    if (method === 'eth_getCode') return reply({ result: (isOutside(params[0]) ? o.outsideNoCode : o.noCode) ? '0x' : '0x6080' });
    /** @param {any} v */
    const answer = (v) => (v instanceof Error ? reply({ error: { message: v.message } }) : reply({ result: wordOf(v) }));
    if (method === 'eth_getStorageAt') {
      assert.ok(isOutside(params[0]), `storage read at ${params[0]}`);
      return answer(params[1] === IMPL_SLOT ? outside.impl : params[1] === ADMIN_SLOT ? outside.admin : 0n);
    }
    if (isOutside(params[0].to)) {
      assert.equal(params[0].data, toFunctionSelector('owner()'));
      return answer(outside['owner()']);
    }
    const v = bySel.get(params[0].data);
    if (v === undefined) return reply({ error: { message: 'execution reverted' } });
    if (v instanceof Error) return reply({ error: { message: v.message } });
    return reply({ result: wordOf(v) });
  };
}

const good = () => {
  const r = expectedArgs(CFG, expected());
  assert.deepEqual(r.problems, []);
  return { args: /** @type {NonNullable<typeof r.args>} */ (r.args), proxy: r.proxy };
};
const run = (/** @type {any} */ fetchImpl, beforeInitialize = false) =>
  checkOnchain({ fetchImpl, rpcUrl: 'http://stub', registry: REGISTRY, chainId: SNAP.chainId, ...good(), beforeInitialize });

test('a registry holding exactly the expected values passes, and a missing getter is not a failure', async () => {
  assert.deepEqual(await run(chain()), []);
  // a transparent proxy: the admin slot is set and is the authority; owner() is then not consulted
  assert.deepEqual(await run(chain({}, { outside: { admin: ADMIN, 'owner()': new Error('no owner') } })), []);
});

test('the outside registry proxy is re-read: implementation, admin and code, each a refusal', async () => {
  for (const [opts, re] of /** @type {[Record<string, any>, RegExp][]} */ ([
    [{ outside: { impl: OTHER } }, /outside registry implementation is 0x2222/],
    [{ outside: { impl: 0n } }, /outside registry implementation is 0x0000/],
    [{ outside: { impl: new Error('boom') } }, /implementation slot: read failed/],
    [{ outside: { admin: OTHER } }, /outside registry admin slot is 0x2222/],
    [{ outside: { admin: new Error('boom') } }, /admin slot: read failed/],
    [{ outside: { 'owner()': OTHER } }, /outside registry owner\(\) \(UUPS upgrade authority\) is 0x2222/],
    [{ outside: { 'owner()': new Error('boom') } }, /outside registry owner\(\).*call failed/],
    [{ outsideNoCode: true }, /outside registry 0x[0-9a-fA-F]+: no code/],
  ])) {
    for (const before of [false, true]) {
      const p = await run(chain({ 'initialized()': before ? 0n : 1n }, opts), before);
      assert.match(p.join('\n'), re, `${JSON.stringify(opts, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Error ? 'Error' : v))} before=${before}`);
    }
  }
});

test('before initialize: the registry must be deployed and not yet initialized, and nothing else is read from it', async () => {
  assert.deepEqual(await run(chain({ 'initialized()': 0n, 'owner()': 0n, 'treasury()': new Error('boom') }), true), []);
  const p = await run(chain(), true);
  assert.match(p.join('\n'), /registry\.initialized\(\) is true, expected false/);
  assert.match((await run(chain({}, { noCode: true }), true)).join('\n'), /no code/);
});

test('with no outside registry there is no proxy to record or read', async () => {
  const r = expectedArgs(CFG, expected({ outsideRegistry: ZERO_ADDR, importIdCeiling: '0', outsideImplementation: undefined, outsideAdmin: undefined }));
  assert.deepEqual(r.problems, []);
  assert.equal(r.proxy, null);
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
    [{ treasury: CFG.initializer }, /treasury is the initializer key \(PROTOCOL_INITIALIZER\); the registry treasury is FEE_TREASURY/],
    [{ treasury: CFG.initializer.toLowerCase() }, /treasury is the initializer key/],
    [{ outsideRegistry: REGISTRY }, /outsideRegistry is the registry itself/],
    [{ outsideRegistry: REGISTRY.toLowerCase() }, /outsideRegistry is the registry itself/],
    [{ outsideImplementation: undefined }, /outsideImplementation must be recorded as an address/],
    [{ outsideImplementation: 'placeholder' }, /outsideImplementation is still a placeholder/],
    [{ outsideImplementation: ZERO_ADDR }, /outsideImplementation must not be the zero address/],
    [{ outsideAdmin: undefined }, /outsideAdmin must be recorded as an address/],
    [{ outsideAdmin: '<admin>' }, /outsideAdmin is still a placeholder/],
    [{ outsideAdmin: ZERO_ADDR }, /outsideAdmin must not be the zero address/],
  ])) {
    const r = expectedArgs(CFG, expected(over));
    assert.equal(r.args, null, JSON.stringify(over));
    assert.match(r.problems.join('\n'), re, JSON.stringify(over));
  }
  const noImport = expectedArgs(CFG, expected({ outsideRegistry: '0x0000000000000000000000000000000000000000', importIdCeiling: '5' }));
  assert.match(noImport.problems.join('\n'), /must be 0 when outsideRegistry is the zero address/);
  assert.equal(expectedArgs(CFG, expected({ outsideRegistry: '0x0000000000000000000000000000000000000000', importIdCeiling: '0' })).problems.length, 0);
});

test('the treasury is FEE_TREASURY when it is known, and an overridden registry address is the one outsideRegistry must not be', () => {
  assert.deepEqual(expectedArgs(CFG, expected(), undefined, { feeTreasury: TREASURY.toUpperCase().replace('0X', '0x') }).problems, []);
  assert.match(expectedArgs(CFG, expected(), undefined, { feeTreasury: OTHER }).problems.join('\n'), /treasury differs from FEE_TREASURY/);
  assert.match(
    expectedArgs(CFG, expected(), undefined, { registry: SNAP.outsideRegistry }).problems.join('\n'),
    /outsideRegistry is the registry itself/,
  );
});

test('the CLI prints the initialize arguments, exits 1 on a placeholder ceiling, and refuses --rpc alone', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'registry-onchain-preflight-'));
  try {
    const good = path.join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(expected()));
    const { FEE_TREASURY: _unset, ...env } = process.env;
    const ok = spawnSync(process.execPath, [CLI, '--expected', good], { encoding: 'utf8', env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.includes(`importIdCeiling_ ${SNAP.nextId}`), ok.stdout);
    assert.match(ok.stdout, /FEE_TREASURY not set: not cross-checked/);
    assert.match(ok.stdout, /outside proxy\s+implementation 0x5555/);
    assert.match(ok.stdout, /calldata\s+0x[0-9a-f]+/);

    const wrongTreasury = spawnSync(process.execPath, [CLI, '--expected', good], { encoding: 'utf8', env: { ...env, FEE_TREASURY: OTHER } });
    assert.equal(wrongTreasury.status, 1);
    assert.match(wrongTreasury.stderr, /PREFLIGHT FAIL: treasury differs from FEE_TREASURY/);

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
