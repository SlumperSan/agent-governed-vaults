// @ts-check
/**
 * The restore procedure from docs/RUNTIME.md §8.3, executed rather than asserted in prose.
 *
 * A runbook nobody has run is a hypothesis. This walks the documented steps against real files —
 * corrupt the snapshot, verify, keep the bad file, copy the backup into place, re-verify, resume —
 * and checks the thing that actually matters at the end: that the indexer resumes from the
 * restored cursor and re-folds the gap into the same state that was lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp, writeFile, copyFile, rename, readdir } from 'node:fs/promises';
import { resolveIndexerConfig, buildIndexer } from '../src/index-runner.mjs';
import { verifySnapshot, loadSnapshot } from '../src/store.mjs';
import { backupPath } from '../../oplog/src/durable.mjs';

const A40 = (c) => '0x' + c.repeat(40);
const FACTORY = A40('1');
const V = A40('e');
const MEMBER = A40('7');

const ENV = (dir) => ({
  RPC_URL: 'http://localhost:8545',
  FACTORY_ADDRESS: FACTORY, OPERATOR_REGISTRY_ADDRESS: A40('2'),
  SUBVAULT_REGISTRY_ADDRESS: A40('3'), GOVERNANCE_ADDRESS: A40('4'),
  STATE_PATH: join(dir, 'indexer-state.json'), HEARTBEAT_DIR: dir,
  CONFIRMATIONS: '0', BATCH_BLOCKS: '10', POLL_INTERVAL_MS: '5',
  SNAPSHOT_BACKUPS: '3', SNAPSHOT_BACKUP_INTERVAL_MS: '0',
});

/**
 * A chain with a vault created at block 5 and a deposit at block 25. `head` is mutable so the test
 * can index a prefix, take a backup, then let the rest of history arrive.
 */
function chain(headRef) {
  const logs = [
    { address: FACTORY, eventName: 'VaultCreated', blockNumber: 5n, logIndex: 0, args: { vault: V, creator: A40('a'), usdc: A40('b'), capacityCapUsdc: 1000n } },
    { address: V, eventName: 'DepositActivated', blockNumber: 25n, logIndex: 0, args: { member: MEMBER, amountUsdc: 50n, sharesMinted: 50n } },
  ];
  // The chain source issues one getLogs per contract GROUP, so the fake must honour the address
  // filter — otherwise every group returns the same log and the fold counts it once per group.
  return {
    getBlockNumber: async () => BigInt(headRef.head),
    getLogs: async ({ address, fromBlock, toBlock }) => {
      const want = new Set((Array.isArray(address) ? address : [address]).filter(Boolean).map((a) => String(a).toLowerCase()));
      return logs.filter((l) => want.has(l.address.toLowerCase())
        && Number(l.blockNumber) >= Number(fromBlock) && Number(l.blockNumber) <= Number(toBlock));
    },
  };
}

test('RUNTIME.md §8.3 restore: a corrupt snapshot is rolled back and the gap is re-indexed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'restore-'));
  const path = join(dir, 'indexer-state.json');
  try {
    const headRef = { head: 10 };
    const cfg = resolveIndexerConfig(ENV(dir));

    // ── Normal operation: index to block 10, twice, so a backup exists ──
    const first = await buildIndexer(cfg, { log: () => {}, logger: {}, client: chain(headRef) });
    await first.daemon.catchUp();
    headRef.head = 20;
    await first.daemon.catchUp();
    await first.stop();

    const healthy = await verifySnapshot(path);
    assert.equal(healthy.ok, true);
    assert.equal(healthy.lastBlock, 20);
    assert.equal(healthy.counts.vaults, 1);
    assert.ok(healthy.backups.length >= 1, 'the ring has something to restore from');
    // The newest rung is whatever the live file held before the last write — stop()'s final
    // snapshot rotated once more, so .1 is block 20 and .2 is the block-10 state.
    const rung = healthy.backups.find((b) => b.lastBlock === 10);
    assert.ok(rung, `expected a rung at block 10, got ${JSON.stringify(healthy.backups.map((b) => b.lastBlock))}`);
    assert.equal(rung.ok, true);

    // ── Step 0: something writes garbage over the live snapshot ──
    await writeFile(path, '{"version":1,"lastBlock":20,"vaults":[[', 'utf8');

    // ── Step 2: verify tells you it is unusable, and which rung to take ──
    const broken = await verifySnapshot(path);
    assert.equal(broken.ok, false);
    assert.equal(broken.exists, true, 'the file is present; the CONTENT is bad');
    assert.equal(broken.backups[0].ok, true, 'and the ring is readable');
    const target = broken.backups.find((b) => b.lastBlock === 10);
    assert.ok(target, 'a rung with an earlier cursor is available');

    // ── Step 3: keep the bad file — it is the only evidence of what happened ──
    const kept = `${path}.bad-test`;
    await rename(path, kept);

    // ── Step 4: COPY the backup into place, so the ring survives a failure here ──
    await copyFile(backupPath(path, target.n), path);
    assert.ok((await readdir(dir)).includes('indexer-state.json.1'), 'the ring is intact after the copy');

    // ── Step 5: verify the restored file and read off the resume cursor ──
    const restored = await verifySnapshot(path);
    assert.equal(restored.ok, true);
    assert.equal(restored.lastBlock, 10);
    assert.equal(restored.resumeFrom, 11);

    // ── Step 6: restart. It resumes from 11 and re-folds the range it lost ──
    headRef.head = 30;
    const second = await buildIndexer(cfg, { log: () => {}, logger: {}, client: chain(headRef) });
    await second.daemon.catchUp();
    await second.stop();

    const after = await verifySnapshot(path);
    assert.equal(after.ok, true);
    assert.equal(after.lastBlock, 30);

    // The projection is a pure fold, so replaying the gap rebuilds exactly what was lost —
    // including the block-25 deposit that only ever existed in the destroyed snapshot's future.
    const state = await loadSnapshot(path);
    assert.equal(state.vaults.size, 1);
    assert.equal(state.shares.get(V)?.get(MEMBER), 50n, 'the deposit after the backup point is back');
    assert.ok((await readdir(dir)).includes('indexer-state.json.bad-test'), 'the evidence was kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the last-resort path: no usable snapshot, rebuild from START_BLOCK', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'restore-'));
  const path = join(dir, 'indexer-state.json');
  try {
    const headRef = { head: 30 };
    // No snapshot at all, START_BLOCK at the factory deploy block — the documented fallback.
    const cfg = resolveIndexerConfig({ ...ENV(dir), START_BLOCK: '5' });
    const warnings = [];
    const { daemon, stop } = await buildIndexer(cfg, { log: (m) => warnings.push(m), logger: {}, client: chain(headRef) });
    await daemon.catchUp();
    await stop();

    const state = await loadSnapshot(path);
    assert.equal(state.vaults.size, 1, 'full history rebuilt from chain');
    assert.equal(state.shares.get(V)?.get(MEMBER), 50n);
    // And the warning the docs tell you to heed when you are tempted to set a LATER block.
    assert.ok(warnings.some((w) => /vaults created before block 5 will NOT be discovered/.test(w)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
