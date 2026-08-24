// @ts-check
/**
 * ops-check: the thing that notices a service stopped noticing. The interesting cases are all the
 * ways a heartbeat can be untrustworthy — absent, stale, torn, or from a machine whose clock is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp, writeFile } from 'node:fs/promises';
import { evaluateHeartbeat, checkServices, formatReport, parseArgs, DEFAULT_SERVICES, DEFAULT_MAX_AGE_MS } from '../src/ops-check.mjs';
import { createHeartbeat } from '../src/heartbeat.mjs';

const NOW = 1_700_000_000_000;
const beat = (ts, staleAfterMs) => ({ service: 's', ts, pid: 7, staleAfterMs, detail: { lastBlock: 5 } });

test('a recent heartbeat inside its own budget is fresh', () => {
  const r = evaluateHeartbeat('indexer', beat(NOW - 10_000, 36_000), { nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'fresh');
  assert.equal(r.limitMs, 36_000);
  assert.match(r.detail, /pid=7 lastBlock=5/);
});

test('the writer’s own staleAfterMs wins over the blunt default', () => {
  // 60s old: stale against a 30s budget even though the 120s default would call it fine.
  const r = evaluateHeartbeat('canary', beat(NOW - 60_000, 30_000), { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'stale');
  assert.match(r.detail, /limit 30s/);
});

test('--max-age-ms overrides the writer’s hint in both directions', () => {
  assert.equal(evaluateHeartbeat('api', beat(NOW - 60_000, 30_000), { nowMs: NOW, maxAgeMs: 90_000 }).ok, true);
  assert.equal(evaluateHeartbeat('api', beat(NOW - 60_000, 300_000), { nowMs: NOW, maxAgeMs: 10_000 }).ok, false);
});

test('a heartbeat with no usable hint falls back to the default budget', () => {
  assert.equal(evaluateHeartbeat('api', beat(NOW - 10_000, undefined), { nowMs: NOW }).limitMs, DEFAULT_MAX_AGE_MS);
  assert.equal(evaluateHeartbeat('api', beat(NOW - 10_000, 0), { nowMs: NOW }).limitMs, DEFAULT_MAX_AGE_MS);
});

test('a missing file is a failure, and says why an operator might see it', () => {
  const r = evaluateHeartbeat('canary', null, { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'missing');
  assert.match(r.detail, /never started|directory/);
});

test('a heartbeat with no usable ts is unreadable, not silently fresh', () => {
  for (const ts of [undefined, null, 'yesterday', NaN]) {
    const r = evaluateHeartbeat('api', { service: 'api', ts }, { nowMs: NOW });
    assert.equal(r.ok, false, `ts=${String(ts)}`);
    assert.equal(r.state, 'unreadable');
  }
});

test('a heartbeat from the future is flagged as clock skew, not accepted', () => {
  const r = evaluateHeartbeat('indexer', beat(NOW + 600_000, 36_000), { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'future');
  assert.match(r.detail, /clock skew/);
  // A few seconds of skew is normal and must not page anyone.
  assert.equal(evaluateHeartbeat('indexer', beat(NOW + 5_000, 36_000), { nowMs: NOW }).ok, true);
});

test('checkServices is red if ANY service is red, and keeps checking past a corrupt file', async () => {
  const report = await checkServices({
    dir: '/data', nowMs: NOW,
    read: async (p) => {
      if (p.includes('indexer')) return beat(NOW - 1000, 36_000);
      if (p.includes('api')) throw new Error('EACCES');
      return null; // canary
    },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.rows.map((r) => [r.service, r.state]), [
    ['indexer', 'fresh'], ['api', 'unreadable'], ['canary', 'missing'],
  ]);
});

test('checkServices is green only when every service is fresh', async () => {
  const report = await checkServices({ dir: '/data', nowMs: NOW, read: async () => beat(NOW - 1000, 36_000) });
  assert.equal(report.ok, true);
  assert.equal(report.rows.length, DEFAULT_SERVICES.length);
});

test('the report leads with the failures', () => {
  const report = { ok: false, dir: '/data', nowMs: NOW, rows: [
    { service: 'indexer', ok: true, state: 'fresh', ageMs: 1000, limitMs: 36_000, detail: 'pid=1' },
    { service: 'canary', ok: false, state: 'stale', ageMs: 600_000, limitMs: 90_000, detail: 'down or wedged' },
  ] };
  const lines = formatReport(report).split('\n');
  assert.match(lines[0], /1 of 2 service\(s\) UNHEALTHY: canary\(stale\)/);
  assert.match(lines[1], /^FAIL canary/);
  assert.match(lines[2], /^ok {2}\s*indexer/);
});

test('a healthy report names the directory it looked in (the usual misconfiguration)', () => {
  const head = formatReport({ ok: true, dir: '/data', nowMs: NOW, rows: [{ service: 'api', ok: true, state: 'fresh', ageMs: 0, limitMs: 1, detail: '' }] }).split('\n')[0];
  assert.match(head, /1\/1 healthy \(heartbeats in \/data\)/);
});

test('parseArgs: flags, positional services, env fallbacks', () => {
  assert.deepEqual(parseArgs([], {}), { help: false, dir: parseArgs([], {}).dir, maxAgeMs: null, services: DEFAULT_SERVICES });
  assert.deepEqual(parseArgs(['--dir=/data', 'indexer'], {}).services, ['indexer']);
  assert.equal(parseArgs(['--dir=/data'], {}).dir, '/data');
  assert.equal(parseArgs(['--max-age-ms=5000'], {}).maxAgeMs, 5000);
  assert.equal(parseArgs([], { HEARTBEAT_DIR: '/hb' }).dir, '/hb');
  assert.equal(parseArgs([], { HEARTBEAT_MAX_AGE_MS: '77' }).maxAgeMs, 77);
  assert.deepEqual(parseArgs([], { OPS_CHECK_SERVICES: 'api, canary' }).services, ['api', 'canary']);
  assert.equal(parseArgs(['--help'], {}).help, true);
});

test('parseArgs rejects a typo rather than checking the wrong thing', () => {
  assert.throws(() => parseArgs(['--durr=/data'], {}), /unknown flag/);
  assert.throws(() => parseArgs(['--max-age-ms=soon'], {}), /must be a number/);
});

test('end to end on a real directory: a live beat passes, a hand-written stale one fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opscheck-'));
  try {
    await createHeartbeat({ dir, service: 'indexer', staleAfterMs: 36_000 }).beat({ lastBlock: 12 });
    await writeFile(join(dir, 'api.heartbeat.json'), JSON.stringify({ service: 'api', ts: Date.now() - 600_000, staleAfterMs: 15_000 }), 'utf8');
    const report = await checkServices({ dir, services: ['indexer', 'api'] });
    assert.equal(report.ok, false);
    assert.equal(report.rows[0].state, 'fresh');
    assert.equal(report.rows[1].state, 'stale');

    // Only the indexer: a per-service healthcheck must not fail on a sibling's outage.
    assert.equal((await checkServices({ dir, services: ['indexer'] })).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
