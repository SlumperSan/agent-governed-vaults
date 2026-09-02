// @ts-check
/**
 * SIGTERM behaviour for the indexer, driven through `stop()` with a fake chain client — no signals,
 * no RPC. The promise is "finishes the current batch + snapshots", and the tests below check both
 * halves of it, including the part that only bites on a cold-start backlog: catchUp() must notice
 * the abort BETWEEN batches instead of grinding through a thousand of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp } from 'node:fs/promises';
import { resolveIndexerConfig, buildIndexer } from '../src/index-runner.mjs';
import { createIndexerDaemon } from '../src/daemon.mjs';
import { verifySnapshot } from '../src/store.mjs';
import { readHeartbeatFile } from '../../oplog/src/heartbeat.mjs';

const A40 = (c) => '0x' + c.repeat(40);
const V = A40('e');
const tmp = () => mkdtemp(join(tmpdir(), 'idx-shutdown-'));

const ENV = (dir) => ({
  RPC_URL: 'http://localhost:8545',
  FACTORY_ADDRESS: A40('1'), OPERATOR_REGISTRY_ADDRESS: A40('2'),
  SUBVAULT_REGISTRY_ADDRESS: A40('3'), GOVERNANCE_ADDRESS: A40('4'),
  STATE_PATH: join(dir, 'indexer-state.json'), HEARTBEAT_DIR: dir,
  POLL_INTERVAL_MS: '20', CONFIRMATIONS: '0', BATCH_BLOCKS: '10',
});

/** A chain source that hands out one VaultCreated at block 5 and then nothing. */
function fakeClient(head = 30) {
  return {
    getBlockNumber: async () => BigInt(head),
    getLogs: async ({ fromBlock, toBlock }) => (Number(fromBlock) <= 5 && 5 <= Number(toBlock)
      ? [{ address: A40('1'), eventName: 'VaultCreated', blockNumber: 5n, logIndex: 0, args: { vault: V, creator: A40('a'), usdc: A40('b'), capacityCapUsdc: 1000n } }]
      : []),
  };
}

/**
 * Wait for something the daemon actually reaches, instead of for a duration we hope is long
 * enough. A fixed sleep here was a race: on a loaded runner the poll loop is still working
 * through the backlog when the sleep expires, stop() then honours the abort at the next batch
 * boundary, and the assertions red against a cursor short of head — CI run 33696190801 failed
 * this file with lastBlock 29 on a README-only PR.
 *
 * The deadline is an upper bound that FAILS, and it is deliberately far above any plausible load:
 * `node --test` has no timeout by default, so a condition that never comes true has to red the
 * job rather than hang it forever.
 */
async function waitFor(condition, describe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${describe()}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** The completion signal these tests actually mean by "let it catch up": the cursor reached head. */
const caughtUpTo = (daemon, block) => waitFor(
  () => daemon.getState().lastBlock === block,
  () => `the poll loop to drain to block ${block} (cursor is at ${daemon.getState().lastBlock})`,
);

test('catchUp checks the abort signal BETWEEN batches, so SIGTERM is honoured mid-backlog', async () => {
  const dir = await tmp();
  try {
    // A 10 000-block backlog in 10-block batches: without the check this would run 1000 times.
    const ac = new AbortController();
    let ticks = 0;
    const d = createIndexerDaemon({
      statePath: join(dir, 's.json'),
      headBlock: async () => 10_000,
      confirmations: 0,
      batchBlocks: 10,
      fetchEvents: async () => { ticks += 1; if (ticks === 3) ac.abort(); return []; },
    });
    await d.init();
    await d.catchUp({ signal: ac.signal });
    assert.equal(ticks, 3, 'stopped at the batch boundary, not after draining the backlog');
    // The batch it did finish is on disk — that is what makes "finished the current batch" true.
    assert.equal((await verifySnapshot(join(dir, 's.json'))).lastBlock, 29);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('catchUp with no signal still drains to the head (existing behaviour unchanged)', async () => {
  const dir = await tmp();
  try {
    let ticks = 0;
    const d = createIndexerDaemon({
      statePath: join(dir, 's.json'), headBlock: async () => 45, confirmations: 0, batchBlocks: 10,
      fetchEvents: async () => { ticks += 1; return []; },
    });
    await d.init();
    await d.catchUp();
    assert.equal(ticks, 5, 'blocks 0-45 in 10-block batches');
    assert.equal((await verifySnapshot(join(dir, 's.json'))).lastBlock, 45);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop() ends the poll loop and leaves a readable snapshot at the right cursor', async () => {
  const dir = await tmp();
  try {
    const cfg = resolveIndexerConfig(ENV(dir));
    const { start, stop, daemon } = await buildIndexer(cfg, { log: () => {}, logger: {}, client: fakeClient(30) });
    const running = start();
    await caughtUpTo(daemon, 30);                   // it caught up and is idling — not "60ms elapsed"

    const lastBlock = await stop();
    assert.equal(lastBlock, 30);
    await running;                                  // the loop really exited, not just aborted

    const report = await verifySnapshot(cfg.statePath);
    assert.equal(report.ok, true, 'the file a restart will resume from is intact');
    assert.equal(report.lastBlock, 30);
    assert.equal(report.counts.vaults, 1, 'the vault it indexed survived the shutdown');
    assert.equal(report.resumeFrom, 31);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop() is safe before start() — a process killed during boot still writes clean state', async () => {
  const dir = await tmp();
  try {
    const cfg = resolveIndexerConfig(ENV(dir));
    const { stop } = await buildIndexer(cfg, { log: () => {}, logger: {}, client: fakeClient(30) });
    assert.equal(await stop(), 0);
    assert.equal((await verifySnapshot(cfg.statePath)).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the indexer heartbeats while polling, stamped with its own staleness budget', async () => {
  const dir = await tmp();
  try {
    const cfg = resolveIndexerConfig(ENV(dir));
    // POLL_INTERVAL_MS=20 → floored at 30s so a fast poll cannot become a hair-trigger.
    assert.equal(cfg.heartbeatStaleMs, 30_000);

    const { start, stop, heartbeat, daemon } = await buildIndexer(cfg, { log: () => {}, logger: {}, client: fakeClient(30) });
    start();
    await caughtUpTo(daemon, 30);

    // Beaten at boot, before the first batch: an indexer grinding through a cold-start backlog is
    // alive and must not be reported dead while it works.
    const boot = await readHeartbeatFile(heartbeat.path);
    assert.equal(boot.service, 'indexer');
    assert.equal(boot.staleAfterMs, 30_000);

    // And it keeps advancing as it polls. The 1s floor on writes is why this waits: a fast
    // catch-up ticks far quicker than that and must not turn into a write per batch.
    await new Promise((r) => setTimeout(r, 1100));
    const later = await readHeartbeatFile(heartbeat.path);
    await stop();
    assert.ok(later.ts > boot.ts, 'the beat keeps advancing while polling');
    assert.equal(later.detail.lastBlock, 30);
    assert.equal(later.detail.vaults, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the poll loop does not leak an abort listener per iteration', async () => {
  // The loop sleeps once per poll against ONE signal that lives for the whole process. Attaching
  // a listener per sleep and never detaching would grow without bound for the lifetime of the
  // service; Node notices past ten and warns, which is what this catches.
  const dir = await tmp();
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  process.on('warning', onWarning);
  try {
    const cfg = resolveIndexerConfig({ ...ENV(dir), POLL_INTERVAL_MS: '1' });
    const { start, stop } = await buildIndexer(cfg, { log: () => {}, logger: {}, client: fakeClient(30) });
    start();
    await new Promise((r) => setTimeout(r, 200));   // ~100+ sleeps on one long-lived signal
    await stop();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(warnings.filter((w) => /MaxListenersExceeded/.test(w.name)), []);
  } finally {
    process.off('warning', onWarning);
    await rm(dir, { recursive: true, force: true });
  }
});

test('the backup ring is wired through from env to the snapshot on disk', async () => {
  const dir = await tmp();
  try {
    const cfg = resolveIndexerConfig({ ...ENV(dir), SNAPSHOT_BACKUPS: '2', SNAPSHOT_BACKUP_INTERVAL_MS: '0' });
    assert.equal(cfg.backups, 2);
    const { daemon, stop } = await buildIndexer(cfg, { log: () => {}, logger: {}, client: fakeClient(30) });
    await daemon.catchUp();
    await daemon.catchUp();
    await stop();
    const report = await verifySnapshot(cfg.statePath);
    assert.ok(report.backups.length >= 1, 'a backup exists to restore from');
    assert.ok(report.backups.every((b) => b.ok), 'and it is readable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
