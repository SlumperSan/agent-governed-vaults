// @ts-check
/**
 * Chain-only discovery: the vault list from the factory and the track record from the registry,
 * with no API behind either.
 *
 * Every test here runs the REAL chain reader (createChainReader) over a fake viem client, so the
 * ABI fragments, the paging arithmetic and the decoding of viem's return shapes are all exercised,
 * not a stub that skips them. The fake client reverts on an out-of-range `allVaults(i)` the way the
 * contract does, which is what makes an off-by-one visible as a missing vault.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainReader } from '../src/chain.mjs';
import { ConfigError, loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';
import { createBudget } from '../src/budget.mjs';
import { plan } from '../src/plan.mjs';
import { discoverFromChain, discoverySource, perceive } from '../src/perceive.mjs';
import { FACTORY, GOVERNANCE, OPERATOR_ADDR, REGISTRY, SUBVAULT_REGISTRY, addr, createFakeChainClient } from './fake-chain-client.mjs';

const USDC = 10n ** 6n;
const NOW = 1_700_000_000;

const readerFor = (client) => createChainReader({ client, governance: GOVERNANCE });

/** A config as `--preset` alone produces it, with this test's fake addresses over the preset's. */
const chainConfig = (over = {}) =>
  loadConfig({
    chain: { preset: 'arc-mainnet', factory: FACTORY, operatorRegistry: REGISTRY, subvaultRegistry: SUBVAULT_REGISTRY, governance: GOVERNANCE },
    ...over,
  });

const vaultsN = (n, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({ address: addr(0x1000 + i), operatorId: 1, holders: i, ...extra(i) }));

function quiet() {
  const lines = [];
  return { lines, log: createLogger({ write: (l) => lines.push(l), nowSec: () => NOW }) };
}

/** An API client that fails the test the moment anything touches it. */
const noApi = new Proxy(
  {},
  {
    get: (_t, k) => () => {
      throw new Error(`the API client was touched: ${String(k)}`);
    },
  },
);
const budget = (enabled = false) => createBudget({ maxSessionSpendUsdc: '0.25', maxSingleReadUsdc: '0.05', enabled });

// ── source selection ─────────────────────────────────────────────────────────

test('a preset with no API URL selects the chain source; an API URL, or no preset, keeps the API', () => {
  assert.equal(discoverySource(loadConfig({ chain: { preset: 'arc-mainnet' } })), 'chain');
  assert.equal(discoverySource(loadConfig({ chain: { preset: 'arc-mainnet' }, api: { baseUrl: 'https://api.example.test' } })), 'api');
  assert.equal(discoverySource(loadConfig({})), 'api', 'the Base Sepolia default is unchanged');
  // run.mjs hands loadConfig `baseUrl: undefined` when --api is absent. Without a preset that must
  // not turn into chain discovery, which has no factory to read.
  assert.equal(discoverySource(loadConfig({ api: { baseUrl: undefined } })), 'api');
});

test('a preset drops the localhost API default; an explicit URL is kept', () => {
  assert.equal(loadConfig({ chain: { preset: 'arc-mainnet' } }).api.baseUrl, null);
  assert.equal(loadConfig({ chain: { preset: 'arc-mainnet' }, api: { baseUrl: undefined } }).api.baseUrl, null);
  assert.equal(loadConfig({ chain: { preset: 'arc-mainnet' }, api: { baseUrl: 'https://api.example.test' } }).api.baseUrl, 'https://api.example.test');
  assert.equal(loadConfig({}).api.baseUrl, 'http://127.0.0.1:8402');
});

test('discovery bounds are validated at startup', () => {
  for (const bad of [{ maxVaults: 0 }, { maxVaults: 1.5 }, { pageSize: 0 }, { pageSize: -1 }, { include: ['not-an-address'] }, { include: 'x' }])
    assert.throws(() => loadConfig({ discovery: bad }), ConfigError, JSON.stringify(bad));
  assert.doesNotThrow(() => loadConfig({ discovery: { maxVaults: 3, pageSize: 1, include: [addr(1)] } }));
});

// ── the factory walk ─────────────────────────────────────────────────────────

test('listFactoryVaults reads every index from count-1 down to 0 and never past the end', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(4) });
  const r = await readerFor(client).listFactoryVaults(FACTORY, { maxVaults: 25, pageSize: 10 });
  assert.equal(r.total, 4);
  assert.deepEqual(r.addresses, [addr(0x1003), addr(0x1002), addr(0x1001), addr(0x1000)], 'newest first, all four');
  assert.equal(r.truncated, false);
  assert.deepEqual(r.failedIndexes, []);
  const idx = client.calls.filter((c) => c.functionName === 'allVaults').map((c) => Number(c.args[0])).sort();
  assert.deepEqual(idx, [0, 1, 2, 3], 'allVaults(4) would revert; the last valid index is vaultCount - 1');
});

test('listFactoryVaults bounds the walk to a window of the newest maxVaults', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(50) });
  const r = await readerFor(client).listFactoryVaults(FACTORY, { maxVaults: 7, pageSize: 3 });
  assert.equal(r.total, 50);
  assert.equal(r.truncated, true);
  assert.equal(r.addresses.length, 7);
  assert.equal(r.addresses[0], addr(0x1000 + 49));
  assert.equal(r.addresses[6], addr(0x1000 + 43));
  assert.equal(client.count('allVaults'), 7, 'a factory of any size costs at most maxVaults indexed reads');
});

test('listFactoryVaults reads one page at a time', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(20) });
  await readerFor(client).listFactoryVaults(FACTORY, { maxVaults: 20, pageSize: 4 });
  assert.ok(client.maxInFlight <= 4, `at most pageSize reads in flight, saw ${client.maxInFlight}`);
  assert.ok(client.maxInFlight >= 2, 'a page is read in parallel, not one call at a time');
  assert.equal(client.count('allVaults'), 20, 'paging covers the whole window exactly once');
});

test('listFactoryVaults: window and page sizes that do not divide evenly still cover every index once', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(10) });
  const r = await readerFor(client).listFactoryVaults(FACTORY, { maxVaults: 7, pageSize: 3 });
  assert.deepEqual(
    r.addresses,
    [9, 8, 7, 6, 5, 4, 3].map((i) => addr(0x1000 + i)),
  );
  const idx = client.calls.filter((c) => c.functionName === 'allVaults').map((c) => Number(c.args[0]));
  assert.equal(new Set(idx).size, idx.length, 'no index is read twice');
});

test('listFactoryVaults: an empty factory is an empty list, not an error', async () => {
  const client = createFakeChainClient({ vaults: [] });
  const r = await readerFor(client).listFactoryVaults(FACTORY);
  assert.deepEqual({ total: r.total, n: r.addresses.length, truncated: r.truncated }, { total: 0, n: 0, truncated: false });
  assert.equal(client.count('allVaults'), 0);
});

test('listFactoryVaults: an unreadable vaultCount is null, never zero', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(3), failing: new Set(['vaultCount']) });
  const r = await readerFor(client).listFactoryVaults(FACTORY);
  assert.equal(r.total, null, 'a failed count must not read as "no vaults"');
  assert.deepEqual(r.addresses, []);
});

test('listFactoryVaults: one failed index is named and skipped, the rest are returned', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(5), failing: new Set(['allVaults:2']) });
  const r = await readerFor(client).listFactoryVaults(FACTORY, { maxVaults: 25, pageSize: 2 });
  assert.deepEqual(r.failedIndexes, [2]);
  assert.equal(r.addresses.length, 4);
  assert.ok(!r.addresses.includes(addr(0x1002)));
});

test('listFactoryVaults refuses a non-positive bound instead of looping', async () => {
  const reader = readerFor(createFakeChainClient({ vaults: vaultsN(2) }));
  await assert.rejects(() => reader.listFactoryVaults(FACTORY, { maxVaults: 0, pageSize: 1 }), /maxVaults/);
  await assert.rejects(() => reader.listFactoryVaults(FACTORY, { maxVaults: 1, pageSize: 0 }), /pageSize/);
});

// ── the registry record ──────────────────────────────────────────────────────

test('readOperatorRecord serves the leaderboard shape the policy reads, net = gain - loss', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(1), operators: { 1: { gain: 900n * USDC, loss: 400n * USDC, fees: 50n * USDC, vaultCount: 3 } } });
  const row = await readerFor(client).readOperatorRecord(REGISTRY, 1);
  assert.deepEqual(row, {
    operatorId: 1,
    operator: OPERATOR_ADDR(1),
    netRealizedUsdc: String(500n * USDC),
    lifetimeGainUsdc: String(900n * USDC),
    lifetimeLossUsdc: String(400n * USDC),
    lifetimeFeesUsdc: String(50n * USDC),
    vaultCount: 3,
  });
});

test('readOperatorRecord: a net loss is negative, not an absolute value', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(1), operators: { 1: { gain: 100n * USDC, loss: 700n * USDC } } });
  assert.equal((await readerFor(client).readOperatorRecord(REGISTRY, 1)).netRealizedUsdc, String(-600n * USDC));
});

test('readOperatorRecord: unattested, unknown and unreadable operators are a missing row, never zeros', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(1), operators: { 1: {} } });
  const reader = readerFor(client);
  assert.equal(await reader.readOperatorRecord(REGISTRY, 0), null, 'operatorId 0 is unattested');
  assert.equal(client.count('leaderboardEntry'), 0, 'and costs no read');
  assert.equal(await reader.readOperatorRecord(REGISTRY, 9), null, 'an id with no operator address has no record');
  assert.equal(await reader.readOperatorRecord(null, 1), null);
  const failing = createFakeChainClient({ vaults: vaultsN(1), operators: { 1: {} }, failing: new Set(['leaderboardEntry']) });
  assert.equal(await readerFor(failing).readOperatorRecord(REGISTRY, 1), null);
});

test('readOperatorRecord also decodes a positional stats tuple', async () => {
  const client = { readContract: async () => [OPERATOR_ADDR(2), [5n, 3n, 1n, 2n]] };
  const row = await readerFor(client).readOperatorRecord(REGISTRY, 2);
  assert.equal(row.netRealizedUsdc, '2');
  assert.equal(row.vaultCount, 2);
});

test('readVaultIdentity: holderCount and creator, null on a failed read', async () => {
  const client = createFakeChainClient({ vaults: [{ address: addr(1), holders: 7, creator: addr(0xbeef) }] });
  assert.deepEqual(await readerFor(client).readVaultIdentity(addr(1)), { holderCount: 7, creator: addr(0xbeef), operatorRegistry: REGISTRY.toLowerCase() });
  const failing = createFakeChainClient({ vaults: [{ address: addr(1) }], failing: new Set(['holderCount']) });
  assert.equal((await readerFor(failing).readVaultIdentity(addr(1))).holderCount, null);
});

// ── discovery rows ───────────────────────────────────────────────────────────

test('discoverFromChain builds rows in the shape the join policy already consumes', async () => {
  const client = createFakeChainClient({
    vaults: [
      { address: addr(0x2000), operatorId: 1, holders: 4, creator: addr(0xc1) },
      { address: addr(0x2001), operatorId: 0, holders: 1, creator: addr(0xc2) },
    ],
    operators: { 1: { gain: 10n * USDC } },
  });
  const gaps = [];
  const { log } = quiet();
  const { vaults, leaderboard } = await discoverFromChain({ chainReader: readerFor(client), config: chainConfig(), log, gaps });
  assert.deepEqual(gaps, []);
  const byVault = new Map(vaults.map((v) => [v.vault, v]));
  assert.deepEqual(byVault.get(addr(0x2000)), {
    vault: addr(0x2000),
    operatorId: 1,
    memberCount: 4,
    depth: 0,
    parent: null,
    capacityCapUsdc: null,
    attested: true,
    creator: addr(0xc1),
  });
  assert.equal(byVault.get(addr(0x2001)).attested, false, 'operatorId 0 is unattested');
  assert.equal(byVault.get(addr(0x2001)).operatorId, 0);
  assert.deepEqual(leaderboard.map((r) => r.operatorId), [1], 'only attested operators get a record read');
});

test('discoverFromChain: a window smaller than the factory is NAMED as a gap', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(9), operators: { 1: {} } });
  const gaps = [];
  const { log } = quiet();
  const { vaults } = await discoverFromChain({ chainReader: readerFor(client), config: chainConfig({ discovery: { maxVaults: 4, pageSize: 2 } }), log, gaps });
  assert.equal(vaults.length, 4);
  assert.ok(gaps.some((g) => /window: the newest 4 of 9/.test(g)), gaps.join('; '));
});

test('discoverFromChain: include pins a vault outside the window, once', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(9), operators: { 1: {} } });
  const gaps = [];
  const { log } = quiet();
  const old = addr(0x1000); // index 0, far outside a window of 3
  const cfg = chainConfig({ discovery: { maxVaults: 3, pageSize: 3, include: [old, addr(0x1008)] } });
  const { vaults } = await discoverFromChain({ chainReader: readerFor(client), config: cfg, log, gaps });
  const got = vaults.map((v) => v.vault);
  assert.ok(got.includes(old), 'a pinned old vault is read');
  assert.equal(new Set(got).size, got.length, 'a vault both pinned and in the window appears once');
  assert.equal(got.length, 4, 'two pinned + the window of three, with one overlap');
});

test('discoverFromChain: an unreadable vaultCount is a gap and no vaults, not an empty success', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(3), failing: new Set(['vaultCount']) });
  const gaps = [];
  const { log } = quiet();
  const { vaults } = await discoverFromChain({ chainReader: readerFor(client), config: chainConfig(), log, gaps });
  assert.equal(vaults.length, 0);
  assert.ok(gaps.some((g) => /vaultCount unreadable/.test(g)));
});

test('discoverFromChain: a failed allVaults index is a gap naming the index', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(3), operators: { 1: {} }, failing: new Set(['allVaults:1']) });
  const gaps = [];
  const { log } = quiet();
  const { vaults } = await discoverFromChain({ chainReader: readerFor(client), config: chainConfig(), log, gaps });
  assert.equal(vaults.length, 2);
  assert.ok(gaps.some((g) => /allVaults read failed at index 1/.test(g)));
});

test('discoverFromChain: an unreadable operator id is a gap and the vault is treated as unattested', async () => {
  const client = createFakeChainClient({ vaults: vaultsN(1), failing: new Set(['operatorOf']) });
  const gaps = [];
  const { log } = quiet();
  const { vaults } = await discoverFromChain({ chainReader: readerFor(client), config: chainConfig(), log, gaps });
  assert.equal(vaults[0].attested, false);
  assert.ok(gaps.some((g) => /operator id unreadable/.test(g)));
});

test('discoverFromChain: a config with no factory says so instead of reading nothing silently', async () => {
  const gaps = [];
  const { log } = quiet();
  const base = chainConfig();
  const cfg = { ...base, chain: { ...base.chain, factory: null } };
  const { vaults } = await discoverFromChain({ chainReader: readerFor(createFakeChainClient({ vaults: [] })), config: cfg, log, gaps });
  assert.equal(vaults.length, 0);
  assert.match(gaps[0], /chain\.factory/);
});

// ── the whole perception pass ────────────────────────────────────────────────

test('perceive on the chain source contacts no API, spends nothing, and returns the rows the planner reads', async () => {
  const client = createFakeChainClient({
    vaults: [{ address: addr(0x3000), operatorId: 1, holders: 2, capUsdc: 500_000n * USDC }],
    operators: { 1: { gain: 5_000n * USDC, loss: 1_000n * USDC } },
  });
  const { log } = quiet();
  const b = budget();
  const world = await perceive({ client: noApi, chainReader: readerFor(client), budget: b, config: chainConfig(), member: null, log, nowSec: NOW });

  assert.equal(world.source, 'chain');
  assert.equal(world.discovery, null);
  assert.equal(world.health, null);
  assert.deepEqual(world.gaps, []);
  assert.equal(b.summary().paidReads, 0);
  assert.equal(world.vaults.length, 1);
  const o = world.vaults[0];
  assert.equal(o.summary.vault, addr(0x3000));
  assert.equal(o.summary.memberCount, 2);
  assert.equal(o.summary.attested, true);
  assert.equal(o.summary.capacityCapUsdc, String(500_000n * USDC), 'the row carries the cap read from the vault itself');
  assert.equal(o.detail, null);
  assert.equal(o.registryOperatorId, 1);
  assert.equal(o.operatorRow.netRealizedUsdc, String(4_000n * USDC));
});

test('perceive on the chain source: the operator record reaches the join decision (a proven operator joins)', async () => {
  const client = createFakeChainClient({
    vaults: [
      { address: addr(0x3000), operatorId: 1, holders: 2 },
      { address: addr(0x3001), operatorId: 2, holders: 2 },
    ],
    operators: { 1: { gain: 5_000n * USDC, loss: 1_000n * USDC }, 2: { gain: 100n * USDC, loss: 900n * USDC } },
  });
  const { log } = quiet();
  const config = chainConfig();
  const world = await perceive({ client: noApi, chainReader: readerFor(client), budget: budget(), config, member: null, log, nowSec: NOW });
  const { intents, decisions } = plan({ world, config, entryMarks: new Map(), log });
  const join = Object.fromEntries(decisions.filter((d) => d.kind === 'join').map((d) => [d.vault, d.join]));
  assert.equal(join[addr(0x3000)], true, 'positive net, attested, in bounds');
  assert.equal(join[addr(0x3001)], false, 'negative net is refused');
  assert.deepEqual(intents.map((i) => i.vault), [addr(0x3000)]);
});

test('perceive on the chain source: an operator with no realizations is listed and refused by the existing gate', async () => {
  const client = createFakeChainClient({ vaults: [{ address: addr(0x3000), operatorId: 1 }], operators: { 1: {} } });
  const { log } = quiet();
  const config = chainConfig();
  const world = await perceive({ client: noApi, chainReader: readerFor(client), budget: budget(), config, member: null, log, nowSec: NOW });
  assert.equal(world.vaults.length, 1, 'the vault is discovered');
  const { decisions } = plan({ world, config, entryMarks: new Map(), log });
  const d = decisions.find((x) => x.kind === 'join');
  assert.equal(d.join, false);
  assert.ok(d.checks.find((c) => c.name === 'operator-net-positive' && !c.ok), 'refused on the track-record gate, which this item does not change');
});

test('perceive on the chain source: a vault pointing at a different registry is unattested, with the reason named', async () => {
  // The vault points at some other contract that claims operatorId 1 for it; the configured
  // registry has never attested it. The pointer's claim must not be believed.
  const client = createFakeChainClient({ vaults: [{ address: addr(0x3000), operatorId: 1, realOperatorId: 0, registry: addr(0xdead) }], operators: { 1: { gain: 9n * USDC } } });
  const { log } = quiet();
  const config = chainConfig();
  const world = await perceive({ client: noApi, chainReader: readerFor(client), budget: budget(), config, member: null, log, nowSec: NOW });
  const { intents } = plan({ world, config, entryMarks: new Map(), log });
  assert.equal(intents.length, 0);
  assert.equal(world.vaults[0].summary.attested, false);
  assert.equal(world.vaults[0].summary.operatorId, 0);
  assert.equal(world.vaults[0].registryOperatorId, 0, 'the attestation is read from the configured registry, not from the vault pointer');
  assert.ok(world.gaps.some((g) => /reports operator registry 0x0+dead.*treated as unattested/.test(g)), world.gaps.join('; '));
});

test('perceive on the chain source makes no paid read even when payments are enabled', async () => {
  const client = createFakeChainClient({ vaults: [{ address: addr(0x3000), operatorId: 1 }], operators: { 1: { gain: 1n } } });
  const paid = [];
  const spy = new Proxy({}, { get: (_t, k) => async () => { paid.push(String(k)); return { data: {} }; } });
  const { log } = quiet();
  const b = budget(true);
  const world = await perceive({ client: spy, chainReader: readerFor(client), budget: b, config: chainConfig(), member: null, log, nowSec: NOW });
  assert.deepEqual(paid, [], 'no API method is called, in particular getVault');
  assert.equal(world.vaults.length, 1);
  assert.equal(b.summary().paidReads, 0);
});

test('perceive with an API URL still uses the API (the chain source is not a replacement)', async () => {
  const calls = [];
  const client = {
    discovery: async () => {
      calls.push('discovery');
      return { x402Version: 2, enabled: false };
    },
    health: async () => {
      calls.push('health');
      return { ok: true, lastBlock: 1 };
    },
    listVaults: async () => {
      calls.push('listVaults');
      return { data: { vaults: [] } };
    },
    leaderboard: async () => {
      calls.push('leaderboard');
      return { data: { leaderboard: [] } };
    },
    getVault: async () => ({ data: {} }),
  };
  const { log } = quiet();
  const config = chainConfig({ api: { baseUrl: 'https://api.example.test', payments: { maxSessionSpendUsdc: '0.25', maxSingleReadUsdc: '0.05' } } });
  const world = await perceive({ client, chainReader: readerFor(createFakeChainClient({ vaults: vaultsN(2) })), budget: budget(true), config, member: null, log, nowSec: NOW });
  assert.equal(world.source, 'api');
  assert.deepEqual(calls, ['discovery', 'health', 'listVaults', 'leaderboard']);
  assert.equal(world.vaults.length, 0, 'the factory is not consulted when the API is the source');
});
