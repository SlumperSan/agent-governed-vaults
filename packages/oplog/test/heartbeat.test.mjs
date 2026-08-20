// @ts-check
/**
 * Heartbeats: written atomically, throttled, self-describing (the writer stamps its own staleness
 * budget), and never fatal to the service that emits them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rm, mkdtemp, readdir } from 'node:fs/promises';
import { createHeartbeat, heartbeatPath, readHeartbeatFile, writeHeartbeatFile, defaultHeartbeatDir } from '../src/heartbeat.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'hb-'));

test('heartbeatPath / defaultHeartbeatDir', () => {
  assert.equal(heartbeatPath('/data', 'indexer'), join('/data', 'indexer.heartbeat.json'));
  assert.equal(defaultHeartbeatDir({ HEARTBEAT_DIR: '/hb' }), '/hb');
  assert.equal(defaultHeartbeatDir({ STATE_PATH: '/data/indexer-state.json' }), dirname('/data/indexer-state.json'));
  assert.equal(defaultHeartbeatDir({}), dirname('./data/indexer-state.json'));
});

test('beat() writes a readable record round-trip, creating the directory', async () => {
  const dir = join(await tmp(), 'nested');
  try {
    const hb = createHeartbeat({ dir, service: 'indexer', staleAfterMs: 36_000, now: () => 1_700_000_000_000, pid: 4242 });
    assert.equal(await hb.beat({ lastBlock: 99 }), true);
    const rec = await readHeartbeatFile(hb.path);
    assert.equal(rec.service, 'indexer');
    assert.equal(rec.ts, 1_700_000_000_000);
    assert.equal(rec.pid, 4242);
    assert.equal(rec.staleAfterMs, 36_000);
    assert.deepEqual(rec.detail, { lastBlock: 99 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the write is atomic: no .tmp is left behind for a reader to trip over', async () => {
  const dir = await tmp();
  try {
    await writeHeartbeatFile(heartbeatPath(dir, 'api'), { service: 'api', ts: 1 });
    assert.deepEqual(await readdir(dir), ['api.heartbeat.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('minIntervalMs throttles a fast loop, and force bypasses it', async () => {
  const writes = [];
  let t = 0;
  const hb = createHeartbeat({
    dir: '/x', service: 'indexer', staleAfterMs: 1000, minIntervalMs: 5000,
    now: () => t, write: async (p, r) => { writes.push(r.ts); },
  });
  assert.equal(await hb.beat(), true);      // first always writes
  t = 1000;
  assert.equal(await hb.beat(), false);     // too soon
  assert.equal(await hb.beat({}, { force: true }), true);
  t = 9000;
  assert.equal(await hb.beat(), true);
  assert.deepEqual(writes, [0, 1000, 9000]);
});

test('a failing write is reported, not thrown — a full disk must not kill the indexer', async () => {
  const seen = [];
  const hb = createHeartbeat({
    dir: '/x', service: 'canary', staleAfterMs: 1,
    write: async () => { throw new Error('ENOSPC'); },
    onError: (e) => seen.push(e.message),
  });
  assert.equal(await hb.beat(), false);
  assert.deepEqual(seen, ['ENOSPC']);
});

test('a throttled beat that fails does not poison the throttle clock', async () => {
  let fail = true;
  let t = 0;
  const writes = [];
  const hb = createHeartbeat({
    dir: '/x', service: 'api', staleAfterMs: 1, minIntervalMs: 1000, now: () => t,
    write: async (p, r) => { if (fail) throw new Error('nope'); writes.push(r.ts); },
    onError: () => {},
  });
  assert.equal(await hb.beat(), false);
  fail = false;
  // Still inside minIntervalMs, but the failed attempt never counted — the retry writes.
  t = 10;
  assert.equal(await hb.beat(), true);
  assert.deepEqual(writes, [10]);
});

test('readHeartbeatFile: absent file is null, not an error', async () => {
  assert.equal(await readHeartbeatFile(join(tmpdir(), 'definitely-not-here.heartbeat.json')), null);
});
