// @ts-check
/**
 * `verify`: read a snapshot and say whether it is usable, WITHOUT starting a poller or needing an
 * RPC. Exercised here at the library level; the entrypoint wiring is covered in index-runner.test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { applyAll } from '../src/projections.mjs';
import { saveSnapshot, createSnapshotWriter, verifySnapshot, formatSnapshotReport, countState } from '../src/store.mjs';
import { backupPath } from '../../oplog/src/durable.mjs';

const V = '0x' + '1'.repeat(40);
const M = '0x' + '2'.repeat(40);
const USDC = '0x' + 'c'.repeat(40);
const tmp = () => mkdtemp(join(tmpdir(), 'verify-'));

const created = (block) => ({ name: 'VaultCreated', vault: V, blockNumber: block, logIndex: 0, args: { vault: V, creator: M, usdc: USDC, capacityCapUsdc: 1_000_000n } });

test('a good snapshot reports its cursor, its resume block and its counts', async () => {
  const dir = await tmp();
  const p = join(dir, 'indexer-state.json');
  try {
    await saveSnapshot(p, applyAll([created(4242)]));
    const r = await verifySnapshot(p);
    assert.equal(r.ok, true);
    assert.equal(r.exists, true);
    assert.equal(r.lastBlock, 4242);
    assert.equal(r.resumeFrom, 4243, 'the block a restarted indexer would poll from');
    assert.equal(r.counts.vaults, 1);
    assert.ok(r.bytes > 0 && r.mtime.endsWith('Z'));
    assert.match(formatSnapshotReport(r), /OK[\s\S]*lastBlock=4242[\s\S]*vaults=1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an absent snapshot is reported as unusable, and says what would happen', async () => {
  const r = await verifySnapshot(join(tmpdir(), `no-such-${process.pid}.json`));
  assert.equal(r.ok, false);
  assert.equal(r.exists, false);
  assert.match(r.error, /no snapshot at .*START_BLOCK/);
  assert.match(formatSnapshotReport(r), /UNUSABLE/);
});

test('a corrupt snapshot is reported as unusable rather than throwing at the caller', async () => {
  const dir = await tmp();
  const p = join(dir, 'indexer-state.json');
  try {
    await writeFile(p, '{ truncated mid-w', 'utf8');
    const r = await verifySnapshot(p);
    assert.equal(r.ok, false);
    assert.equal(r.exists, true, 'the file is there — it is the CONTENT that is bad');
    assert.ok(r.error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a snapshot from a future schema version is refused, not half-read', async () => {
  const dir = await tmp();
  const p = join(dir, 'indexer-state.json');
  try {
    await writeFile(p, JSON.stringify({ version: 99, lastBlock: 1, lastLogIndex: -1, vaults: [], operators: [], shares: [], proposals: [], activeProposal: [] }), 'utf8');
    const r = await verifySnapshot(p);
    assert.equal(r.ok, false);
    assert.match(r.error, /unsupported snapshot version: 99/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify summarises each BACKUP with its own cursor — "restore from which one?"', async () => {
  const dir = await tmp();
  const p = join(dir, 'indexer-state.json');
  try {
    let t = 0;
    const w = createSnapshotWriter({ path: p, backups: 3, backupIntervalMs: 0, now: () => (t += 1000) });
    for (const b of [10, 20, 30, 40]) await w.save(applyAll([created(b)]));

    const r = await verifySnapshot(p);
    assert.equal(r.lastBlock, 40);
    assert.deepEqual(r.backups.map((b) => [b.n, b.lastBlock, b.ok]), [[1, 30, true], [2, 20, true], [3, 10, true]]);
    const text = formatSnapshotReport(r);
    assert.match(text, /backups {5}3 \(newest first\)/);
    assert.match(text, /\.1 {2}lastBlock=30/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt BACKUP is flagged individually — the readable ones stay usable', async () => {
  const dir = await tmp();
  const p = join(dir, 'indexer-state.json');
  try {
    const w = createSnapshotWriter({ path: p, backups: 2, backupIntervalMs: 0 });
    await w.save(applyAll([created(10)]));
    await w.save(applyAll([created(20)]));
    await w.save(applyAll([created(30)]));
    await writeFile(backupPath(p, 1), 'garbage', 'utf8');

    const r = await verifySnapshot(p);
    assert.equal(r.ok, true, 'the live snapshot is unaffected');
    assert.equal(r.backups[0].ok, false);
    assert.ok(r.backups[0].error);
    assert.equal(r.backups[1].ok, true);
    assert.equal(r.backups[1].lastBlock, 10);
    assert.match(formatSnapshotReport(r), /\.1 {2}UNREADABLE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createSnapshotWriter is a drop-in for saveSnapshot: byte-identical output', async () => {
  const dir = await tmp();
  try {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    const state = applyAll([created(7)]);
    await saveSnapshot(a, state);
    await createSnapshotWriter({ path: b, backups: 0 }).save(state);
    assert.equal(await readFile(a, 'utf8'), await readFile(b, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('countState tallies holders across every share book', () => {
  const state = applyAll([
    created(1),
    { name: 'DepositActivated', vault: V, blockNumber: 2, logIndex: 0, args: { member: M, sharesMinted: 10n } },
    { name: 'DepositActivated', vault: V, blockNumber: 3, logIndex: 0, args: { member: '0x' + '3'.repeat(40), sharesMinted: 5n } },
  ]);
  const c = countState(state);
  assert.equal(c.vaults, 1);
  assert.equal(c.shareBooks, 1);
  assert.equal(c.holders, 2);
});
