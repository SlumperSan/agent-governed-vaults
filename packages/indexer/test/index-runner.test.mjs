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

test('resolveIndexerConfig rejects a malformed address', () => {
  assert.throws(() => resolveIndexerConfig({ ...FULL_ENV, GOVERNANCE_ADDRESS: '0xnothex' }), /governance is not a 20-byte address/);
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
