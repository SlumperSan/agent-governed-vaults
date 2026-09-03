// @ts-check
/**
 * Tests the env-driven indexer entrypoint: config resolution (pure) and the full wiring via
 * buildIndexer with an injected fake client (no viem, no RPC) — including resume seeding of the
 * known-vault set and the START_BLOCK cursor floor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { resolveIndexerConfig, buildIndexer } from '../src/index-runner.mjs';
import { saveSnapshot } from '../src/store.mjs';
import { applyAll, vaultView } from '../src/projections.mjs';

const A40 = (c) => '0x' + c.repeat(40);
const FULL_ENV = {
  RPC_URL: 'https://rpc.example',
  FACTORY_ADDRESS: A40('f'), OPERATOR_REGISTRY_ADDRESS: A40('e'),
  SUBVAULT_REGISTRY_ADDRESS: A40('d'), GOVERNANCE_ADDRESS: A40('c'),
};

test('resolveIndexerConfig applies defaults and parses numbers', () => {
  const cfg = resolveIndexerConfig(FULL_ENV);
  assert.equal(cfg.chainId, 8453);
  assert.equal(cfg.chainName, 'base');
  assert.equal(cfg.confirmations, 5);
  assert.equal(cfg.batchBlocks, 2000);
  assert.equal(cfg.statePath, './data/indexer-state.json');
  assert.equal(cfg.addresses.factory, A40('f'));
});

test('resolveIndexerConfig honors overrides', () => {
  const cfg = resolveIndexerConfig({ ...FULL_ENV, CHAIN_ID: '84532', CHAIN_NAME: 'base-sepolia', START_BLOCK: '100', CONFIRMATIONS: '2', STATE_PATH: '/tmp/s.json' });
  assert.equal(cfg.chainId, 84532);
  assert.equal(cfg.chainName, 'base-sepolia');
  assert.equal(cfg.startBlock, 100);
  assert.equal(cfg.confirmations, 2);
  assert.equal(cfg.statePath, '/tmp/s.json');
});

test('resolveIndexerConfig lists every missing required var', () => {
  assert.throws(() => resolveIndexerConfig({}), /RPC_URL.*FACTORY_ADDRESS.*OPERATOR_REGISTRY_ADDRESS.*SUBVAULT_REGISTRY_ADDRESS.*GOVERNANCE_ADDRESS/s);
});

// -- the .env.example placeholder must not validate as a real deployment --
// `0x0000...0000` satisfies the 20-byte address regex and is truthy, so before this it passed every
// check: `cp .env.example .env` produced a config that resolved cleanly and indexed nothing.

const ZERO = '0x' + '0'.repeat(40);

test('a zero-address singleton is rejected, naming the placeholder', () => {
  for (const k of ['FACTORY_ADDRESS', 'OPERATOR_REGISTRY_ADDRESS', 'SUBVAULT_REGISTRY_ADDRESS', 'GOVERNANCE_ADDRESS']) {
    assert.throws(
      () => resolveIndexerConfig({ ...FULL_ENV, [k]: ZERO }),
      /is the zero address/,
      `${k} accepted the zero address`,
    );
  }
  // Mixed case is the same address.
  assert.throws(() => resolveIndexerConfig({ ...FULL_ENV, FACTORY_ADDRESS: '0X' + '0'.repeat(40) }), /zero address|not a 20-byte/);
});

test('a zero-address FEE_ENGINE_ADDRESS reads as UNSET, so the startup warning still fires', () => {
  // NOT an error: an unset FeeEngine is a supported (if near-always mistaken) configuration, and
  // the whole point of the F5 warning is that it fires for it. The placeholder used to SUPPRESS
  // that warning -- the PR defeating its own fix in its own example file.
  const cfg = resolveIndexerConfig({ ...FULL_ENV, FEE_ENGINE_ADDRESS: ZERO });
  assert.equal(cfg.addresses.feeEngine, undefined, 'the zero address is not a FeeEngine');
  assert.equal(!cfg.addresses.feeEngine, true, 'this is the exact predicate buildIndexer warns on');

  const real = resolveIndexerConfig({ ...FULL_ENV, FEE_ENGINE_ADDRESS: A40('9') });
  assert.equal(real.addresses.feeEngine, A40('9'), 'a real address is still honored');
});

test('cp .env.example .env produces a config that FAILS, never one that silently indexes nothing', async () => {
  // The whole file, parsed as an operator would use it. Before this, every address row was a zero
  // placeholder that satisfied the address regex and was truthy, so an un-filled copy resolved
  // completely cleanly and then indexed nothing at all, with no error and no warning.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const text = await readFile(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');

  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line); // uncommented assignments only
    if (m) env[m[1]] = m[2].split('#')[0].trim();
  }
  assert.ok(env.RPC_URL, 'sanity: the example file was parsed');

  assert.throws(() => resolveIndexerConfig(env), /is the zero address/,
    'an un-filled .env.example must be rejected by name, not accepted');
});

test('the .env.example FEE_ENGINE_ADDRESS line does not suppress the warning', async () => {
  // Reads the shipped file rather than a copy of its text, so editing it back re-fails this.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const example = await readFile(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');
  const line = example.split(/\r?\n/).find((l) => /^\s*#?\s*FEE_ENGINE_ADDRESS=/.test(l));
  assert.ok(line, 'FEE_ENGINE_ADDRESS must still be documented in .env.example');

  const m = /^\s*(#?)\s*FEE_ENGINE_ADDRESS=(.*)$/.exec(line);
  const commentedOut = m[1] === '#';
  const value = m[2].split('#')[0].trim();
  const cfg = resolveIndexerConfig(commentedOut ? FULL_ENV : { ...FULL_ENV, FEE_ENGINE_ADDRESS: value });
  assert.equal(!cfg.addresses.feeEngine, true,
    'as shipped, .env.example must leave feeEngine unset so the indexer.feeEngine.unset warning fires');
});

// -- ADAPTER_ADDRESSES (Review107 F2, strong form) --

test('ADAPTER_ADDRESSES parses a comma-separated list and tolerates whitespace', () => {
  const cfg = resolveIndexerConfig({ ...FULL_ENV, ADAPTER_ADDRESSES: ` ${A40('1')} , ${A40('2')} ` });
  assert.deepEqual(cfg.configuredAdapters, [A40('1'), A40('2')]);
});

test('ADAPTER_ADDRESSES defaults to empty and drops zero-address placeholders', () => {
  assert.deepEqual(resolveIndexerConfig(FULL_ENV).configuredAdapters, []);
  assert.deepEqual(resolveIndexerConfig({ ...FULL_ENV, ADAPTER_ADDRESSES: '' }).configuredAdapters, []);
  assert.deepEqual(resolveIndexerConfig({ ...FULL_ENV, ADAPTER_ADDRESSES: `${ZERO},${A40('1')}` }).configuredAdapters, [A40('1')]);
});

test('a non-address entry in ADAPTER_ADDRESSES is a config error, not a silent drop', () => {
  assert.throws(() => resolveIndexerConfig({ ...FULL_ENV, ADAPTER_ADDRESSES: `${A40('1')},0xnope` }), /ADAPTER_ADDRESSES/);
});

test('resolveIndexerConfig rejects a malformed address', () => {
  assert.throws(() => resolveIndexerConfig({ ...FULL_ENV, GOVERNANCE_ADDRESS: '0xnothex' }), /governance is not a 20-byte address/);
});

/**
 * The WIRING, not the two halves of it. `resolveIndexerConfig` parsing ADAPTER_ADDRESSES is tested
 * above and `createChainSource` honoring `configuredAdapters` is tested in rpc.test.mjs -- and
 * both stayed green while `buildIndexer` stopped forwarding the value between them, which is the
 * only place the two ever meet. So this asserts the OUTCOME an operator cares about: an address
 * placed in the env is an address the poller actually asks the RPC about.
 */
test('ADAPTER_ADDRESSES reaches the RPC: a configured adapter is polled end to end', async () => {
  const path = join(tmpdir(), `runner-adapters-${process.pid}-${Date.now()}.json`);
  try {
    const ADAPTER = A40('9');
    /** Every address the fake RPC was actually asked about. */
    const polled = new Set();
    const client = {
      async getBlockNumber() { return 40n; },
      async getLogs({ address }) {
        for (const a of (Array.isArray(address) ? address : [address])) polled.add(a.toLowerCase());
        return [];
      },
    };

    const cfg = resolveIndexerConfig({
      ...FULL_ENV, STATE_PATH: path, CONFIRMATIONS: '0', BATCH_BLOCKS: '5000',
      ADAPTER_ADDRESSES: ADAPTER,
    });
    assert.deepEqual(cfg.configuredAdapters, [ADAPTER], 'config parsed it');

    const { daemon } = await buildIndexer(cfg, { log: () => {}, client });
    await daemon.catchUp();

    assert.ok(polled.has(ADAPTER.toLowerCase()),
      'the configured adapter was never polled — config never reached the chain source');
  } finally {
    await rm(path, { force: true });
  }
});

test('buildIndexer resumes known vaults from the snapshot and indexes new VaultCore events', async () => {
  const path = join(tmpdir(), `runner-${process.pid}-${Date.now()}.json`);
  try {
    const V = A40('1');
    // Pre-seed a snapshot as if an earlier run already indexed this vault up to block 20.
    const seeded = applyAll([
      { name: 'VaultCreated', vault: V, blockNumber: 10, logIndex: 0, args: { vault: V, creator: A40('a'), usdc: A40('b'), capacityCapUsdc: 1000n } },
    ]);
    seeded.lastBlock = 20;
    await saveSnapshot(path, seeded);

    // A fake client returning only a later ExitSettled on the seeded vault (no VaultCreated now).
    const client = {
      async getBlockNumber() { return 40n; },
      async getLogs({ address, events, fromBlock, toBlock }) {
        const addrs = new Set((Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase()));
        if (!addrs.has(V) || !events.some((e) => e.name === 'DepositActivated')) return [];
        if (25n < fromBlock || 25n > toBlock) return [];
        return [{ address: V, eventName: 'DepositActivated', blockNumber: 25n, logIndex: 0, args: { member: A40('2'), amountUsdc: 50n, sharesMinted: 50n } }];
      },
    };

    const cfg = resolveIndexerConfig({ ...FULL_ENV, STATE_PATH: path, CONFIRMATIONS: '0', BATCH_BLOCKS: '5000' });
    const { daemon } = await buildIndexer(cfg, { log: () => {}, client });
    await daemon.catchUp();

    const v = vaultView(daemon.getState(), V);
    assert.equal(v.totalShares, 50n, 'resumed vault must index its later deposit');
    assert.equal(v.creator, A40('a'), 'resumed vault metadata preserved');
  } finally {
    await rm(path, { force: true });
  }
});
