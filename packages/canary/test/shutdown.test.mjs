// @ts-check
/**
 * SIGTERM behaviour for the canary: the sweep loop stops and the transition state is FLUSHED.
 * Driven through `stop()` with a stub reader — no signals, no RPC. The thing being protected is
 * the operator's inbox: an unflushed restart re-pages every signal that was already firing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp, writeFile } from 'node:fs/promises';
import { resolveCanaryConfig, buildCanary } from '../src/canary-runner.mjs';
import { verifyCanaryState } from '../src/state-file.mjs';
import { readHeartbeatFile } from '../../oplog/src/heartbeat.mjs';
import { saveSnapshot } from '../../indexer/src/store.mjs';
import { applyAll } from '../../indexer/src/projections.mjs';

const A40 = (c) => '0x' + c.repeat(40);
const VAULT = A40('a');
const tmp = () => mkdtemp(join(tmpdir(), 'canary-shutdown-'));

const ENV = (dir) => ({
  RPC_URL: 'http://localhost:8545',
  STATE_PATH: join(dir, 'indexer-state.json'),
  CANARY_STATE_PATH: join(dir, 'canary-state.json'),
  HEARTBEAT_DIR: dir,
  CANARY_POLL_INTERVAL_MS: '20',
});

/** Seed a snapshot holding one vault, so the canary has something to watch. */
async function seed(dir) {
  await saveSnapshot(join(dir, 'indexer-state.json'), applyAll([
    { name: 'VaultCreated', vault: VAULT, blockNumber: 5, logIndex: 0, args: { vault: VAULT, creator: A40('b'), usdc: A40('c'), capacityCapUsdc: 1000n } },
  ]));
}

/**
 * A reader whose vault config read fails, so every signal lands as `skipped` (DEGRADED). That is
 * plenty: what these tests check is loop and persistence behaviour, not signal maths, which
 * runner.test.mjs already covers against a full fixture.
 */
function stubReader(canary) {
  canary.reader.headBlock = async () => 1000;
  canary.reader.chainNow = async () => 1_700_000_000;
  canary.reader.read = async () => { throw new Error('unreadable in this test'); };
  canary.reader.tryRead = async () => null;
  canary.reader.getLogs = async () => [];
  canary.reader.staticCall = async () => ({ ok: false });
}

test('stop() ends the sweep loop and flushes what the tracker knows', async () => {
  const dir = await tmp();
  try {
    await seed(dir);
    const cfg = resolveCanaryConfig(ENV(dir));
    const canary = await buildCanary(cfg, { log: () => {}, error: () => {}, logger: {}, client: {} });
    stubReader(canary);

    const running = canary.start();
    await new Promise((r) => setTimeout(r, 60));
    const flushed = await canary.stop();
    await running;

    assert.ok(flushed.tracked > 0, 'it had observed something worth remembering');
    assert.equal(flushed.lastScannedBlock, 995);

    const report = await verifyCanaryState(cfg.canaryStatePath);
    assert.equal(report.ok, true);
    assert.equal(report.lastScannedBlock, 995);
    assert.equal(report.summary.tracked, flushed.tracked);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the flushed state is what stops a restart re-paging every standing alert', async () => {
  const dir = await tmp();
  try {
    await seed(dir);
    const cfg = resolveCanaryConfig(ENV(dir));

    const first = await buildCanary(cfg, { log: () => {}, error: () => {}, logger: {}, client: {} });
    stubReader(first);
    await first.runOnce();
    const emitted = (await first.runOnce(), first.tracker.size);
    await first.stop();
    assert.ok(emitted > 0);

    // A fresh process over the SAME state file: nothing has changed, so nothing is announced.
    const out = [], err = [];
    const second = await buildCanary(cfg, { log: (m) => out.push(m), error: (m) => err.push(m), logger: {}, client: {} });
    stubReader(second);
    const { transitions } = await second.runOnce();
    await second.stop();
    assert.deepEqual(transitions, [], 'a restart must not re-announce what was already reported');
    assert.deepEqual(err, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop() before start() still writes clean state', async () => {
  const dir = await tmp();
  try {
    await seed(dir);
    const cfg = resolveCanaryConfig(ENV(dir));
    const canary = await buildCanary(cfg, { log: () => {}, error: () => {}, logger: {}, client: {} });
    await canary.stop();
    const report = await verifyCanaryState(cfg.canaryStatePath);
    assert.equal(report.ok, true);
    assert.equal(report.summary.tracked, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the canary heartbeats only after a SUCCESSFUL sweep', async () => {
  const dir = await tmp();
  try {
    await seed(dir);
    const cfg = resolveCanaryConfig(ENV(dir));
    assert.equal(cfg.heartbeatStaleMs, 60_000, 'floored: a sweep is many RPC round-trips');

    const canary = await buildCanary(cfg, { log: () => {}, error: () => {}, logger: {}, client: {} });
    // A reader that cannot even reach the head — the sweep throws, so nothing is being watched.
    canary.reader.headBlock = async () => { throw new Error('RPC down'); };
    canary.start();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(await readHeartbeatFile(canary.heartbeat.path), null,
      'a canary that cannot reach the chain must not report itself as watching');

    // Now let it work; the heartbeat appears and carries what it is watching.
    stubReader(canary);
    await new Promise((r) => setTimeout(r, 60));
    await canary.stop();

    const hb = await readHeartbeatFile(canary.heartbeat.path);
    assert.equal(hb.service, 'canary');
    assert.equal(hb.staleAfterMs, 60_000);
    assert.equal(hb.detail.vaults, 1);
    assert.equal(hb.detail.lastScannedBlock, 995);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the canary state file gets the backup ring too', async () => {
  const dir = await tmp();
  try {
    await seed(dir);
    const cfg = resolveCanaryConfig({ ...ENV(dir), SNAPSHOT_BACKUPS: '2', SNAPSHOT_BACKUP_INTERVAL_MS: '0' });
    const canary = await buildCanary(cfg, { log: () => {}, error: () => {}, logger: {}, client: {} });
    stubReader(canary);
    await canary.runOnce();
    await canary.runOnce();
    await canary.stop();

    const report = await verifyCanaryState(cfg.canaryStatePath);
    assert.ok(report.backups.length >= 1, 'something to restore from');
    assert.ok(report.backups.every((b) => b.ok));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt canary state is reported by verify rather than silently re-paging', async () => {
  const dir = await tmp();
  try {
    const path = join(dir, 'canary-state.json');
    await writeFile(path, '{"transitions": {"a": ', 'utf8');
    const report = await verifyCanaryState(path);
    assert.equal(report.ok, false);
    assert.equal(report.exists, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
