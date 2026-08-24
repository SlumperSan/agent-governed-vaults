// @ts-check
/**
 * The backup ring. The properties that matter are all about what an operator finds on disk AFTER
 * something went wrong: the live file always present, the ring ordered newest-first, and backups
 * spaced by time rather than by write so the horizon is useful.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { createRotatingWriter, rotateBackups, atomicWriteFile, listBackups, backupPath, resolveDurabilityOptions } from '../src/durable.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'durable-'));
const read = (p) => readFile(p, 'utf8');

test('atomicWriteFile creates the directory and leaves no .tmp behind', async () => {
  const dir = await tmp();
  try {
    const p = join(dir, 'deep', 'state.json');
    await atomicWriteFile(p, '{"a":1}');
    assert.equal(await read(p), '{"a":1}');
    assert.deepEqual(await readdir(join(dir, 'deep')), ['state.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the ring keeps N copies, newest at .1, and drops the oldest', async () => {
  const dir = await tmp();
  const p = join(dir, 'state.json');
  try {
    let t = 0;
    const w = createRotatingWriter({ path: p, backups: 2, backupIntervalMs: 0, now: () => (t += 1000) });
    for (const v of ['v1', 'v2', 'v3', 'v4']) await w.write({ v });

    assert.equal(JSON.parse(await read(p)).v, 'v4', 'live file is the newest write');
    assert.equal(JSON.parse(await read(backupPath(p, 1))).v, 'v3');
    assert.equal(JSON.parse(await read(backupPath(p, 2))).v, 'v2');
    // v1 fell off the end: keep=2 means exactly two backups exist.
    assert.equal((await listBackups(p, 5)).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the live file is never absent — it is COPIED to .1, not renamed', async () => {
  const dir = await tmp();
  const p = join(dir, 'state.json');
  try {
    await atomicWriteFile(p, '{"v":"first"}');
    // rotateBackups is the only window in which `path` could vanish; assert it survives.
    assert.equal(await rotateBackups(p, 3), true);
    assert.ok(await stat(p), 'live file still present after rotation');
    assert.equal(await read(backupPath(p, 1)), '{"v":"first"}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('backups are spaced by TIME, not by write — 12s snapshots do not shred the horizon', async () => {
  const dir = await tmp();
  const p = join(dir, 'state.json');
  try {
    let t = 0;
    const w = createRotatingWriter({ path: p, backups: 3, backupIntervalMs: 300_000, now: () => t });
    // 100 writes 12s apart = 20 minutes: at a 5-minute interval that is ~4 backups taken,
    // not 100 rotations.
    for (let i = 0; i < 100; i += 1) { await w.write({ i }); t += 12_000; }
    assert.equal(w.backupCount, 4);
    const ring = await listBackups(p, 5);
    assert.equal(ring.length, 3, 'ring size is still N');
    // .1 is 5 minutes old, not 12 seconds old — that is the whole point.
    assert.equal(JSON.parse(await read(backupPath(p, 1))).i, 75);
    assert.equal(JSON.parse(await read(p)).i, 99);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the FIRST real state is captured, not skipped for a whole interval', async () => {
  const dir = await tmp();
  const p = join(dir, 'state.json');
  try {
    let t = 0;
    const w = createRotatingWriter({ path: p, backups: 2, backupIntervalMs: 300_000, now: () => t });
    await w.write({ i: 1 });                 // no file yet → nothing to back up
    assert.equal(w.backupCount, 0);
    t += 1000;
    await w.write({ i: 2 });                 // still inside the interval, but nothing was ever taken
    assert.equal(w.backupCount, 1);
    assert.equal(JSON.parse(await read(backupPath(p, 1))).i, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('backups: 0 disables the ring entirely (writes stay atomic)', async () => {
  const dir = await tmp();
  const p = join(dir, 'state.json');
  try {
    const w = createRotatingWriter({ path: p, backups: 0, backupIntervalMs: 0 });
    await w.write({ i: 1 });
    await w.write({ i: 2 });
    assert.deepEqual(await readdir(dir), ['state.json']);
    assert.equal(await rotateBackups(p, 0), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotating before any file exists is a no-op, not a crash', async () => {
  const dir = await tmp();
  try {
    assert.equal(await rotateBackups(join(dir, 'never-written.json'), 3), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt live file is still backed up — the ring is bytes, not judgement', async () => {
  // Rotation happens BEFORE the new write, so the ring holds prior states even if the current
  // file is garbage. That is what makes restore-from-.1 possible after a bad write.
  const dir = await tmp();
  const p = join(dir, 'state.json');
  try {
    await writeFile(p, '{ truncated', 'utf8');
    const w = createRotatingWriter({ path: p, backups: 1, backupIntervalMs: 0 });
    await w.write({ good: true });
    assert.equal(await read(backupPath(p, 1)), '{ truncated');
    assert.equal(JSON.parse(await read(p)).good, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listBackups reports size and mtime, newest first, skipping gaps', async () => {
  const dir = await tmp();
  const p = join(dir, 'state.json');
  try {
    await writeFile(backupPath(p, 1), 'aa', 'utf8');
    await writeFile(backupPath(p, 3), 'bbbb', 'utf8');
    const ring = await listBackups(p, 3);
    assert.deepEqual(ring.map((b) => [b.n, b.bytes]), [[1, 2], [3, 4]]);
    assert.ok(ring[0].mtime.endsWith('Z'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveDurabilityOptions: defaults, overrides, and rejected nonsense', () => {
  assert.deepEqual(resolveDurabilityOptions({}), { backups: 3, backupIntervalMs: 300_000 });
  assert.deepEqual(resolveDurabilityOptions({ SNAPSHOT_BACKUPS: '0', SNAPSHOT_BACKUP_INTERVAL_MS: '60000' }), { backups: 0, backupIntervalMs: 60_000 });
  assert.throws(() => resolveDurabilityOptions({ SNAPSHOT_BACKUPS: '-1' }), /non-negative integer/);
  assert.throws(() => resolveDurabilityOptions({ SNAPSHOT_BACKUPS: 'three' }), /non-negative integer/);
  assert.throws(() => resolveDurabilityOptions({ SNAPSHOT_BACKUP_INTERVAL_MS: 'soon' }), /non-negative number/);
});
