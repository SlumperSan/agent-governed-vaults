// @ts-check
/**
 * The canary's own state file: durable like the snapshot, and verifiable without an RPC. Losing it
 * costs one duplicate page per still-firing signal, so "did it survive, and what was in it" is a
 * question worth being able to answer at 3am.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp, writeFile } from 'node:fs/promises';
import { createCanaryStateWriter, loadCanaryState, verifyCanaryState, formatCanaryStateReport, summariseTransitions, emptyCanaryState } from '../src/state-file.mjs';
import { backupPath } from '../../oplog/src/durable.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'canary-state-'));
const STATE = (block, transitions) => ({ lastScannedBlock: block, transitions });

test('write then load round-trips, and an absent file is a cold start not an error', async () => {
  const dir = await tmp();
  const p = join(dir, 'canary-state.json');
  try {
    assert.deepEqual(await loadCanaryState(p), emptyCanaryState());
    await createCanaryStateWriter({ path: p, backups: 0 }).save(STATE(100, { 'nav-backing|0xabc': { status: 'alert', since: 3 } }));
    const back = await loadCanaryState(p);
    assert.equal(back.lastScannedBlock, 100);
    assert.equal(back.transitions['nav-backing|0xabc'].status, 'alert');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the empty state carries a feed-identity pin map, and a file written before it existed still loads', async () => {
  assert.deepEqual(emptyCanaryState().feedIdentity, {});
  const dir = await tmp();
  const p = join(dir, 'canary-state.json');
  try {
    // The exact legacy shape: no `feedIdentity` key at all. It must be a cold pin store, not a
    // crash — and not a reason to refuse the transition history that IS in the file.
    await writeFile(p, JSON.stringify(STATE(42, { 'nav-backing|0xabc': { status: 'alert', since: 3 } })), 'utf8');
    const back = await loadCanaryState(p);
    assert.equal(back.feedIdentity, undefined, 'absent, and the runner defaults it');
    assert.equal(back.transitions['nav-backing|0xabc'].status, 'alert');
    const r = await verifyCanaryState(p);
    assert.equal(r.ok, true);
    assert.equal(r.feedsPinned, 0);
    assert.match(formatCanaryStateReport(r), /feed pins {3}0 aggregator identities remembered/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify counts the remembered aggregator identities, so "never pinned" is visible after an incident', async () => {
  const dir = await tmp();
  const p = join(dir, 'canary-state.json');
  try {
    await createCanaryStateWriter({ path: p, backups: 0 }).save({
      ...STATE(7, {}),
      feedIdentity: { 'feed-identity|0xaaa|0xbbb': { feed: '0xfeed', aggregator: '0xagg', phaseId: '4' } },
    });
    const r = await verifyCanaryState(p);
    assert.equal(r.feedsPinned, 1);
    assert.match(formatCanaryStateReport(r), /feed pins {3}1 aggregator identity remembered/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('summariseTransitions counts by status and lists what is not OK', () => {
  const s = summariseTransitions({
    a: { status: 'ok', since: 1 },
    b: { status: 'alert', since: 4 },
    c: { status: 'skipped', since: 9 },
  });
  assert.equal(s.tracked, 3);
  assert.deepEqual(s.byStatus, { ok: 1, alert: 1, skipped: 1 });
  assert.deepEqual(s.notOk.map((n) => n.id).sort(), ['b', 'c']);
});

test('summariseTransitions survives an empty or absent transition map', () => {
  assert.equal(summariseTransitions({}).tracked, 0);
  assert.equal(summariseTransitions(undefined).tracked, 0);
});

test('verify reports the cursor, the tracked signals and the ones still firing', async () => {
  const dir = await tmp();
  const p = join(dir, 'canary-state.json');
  try {
    await createCanaryStateWriter({ path: p, backups: 0 }).save(STATE(8_000_000, {
      'oracle-freshness|0xaaa|WETH': { status: 'alert', since: 12 },
      'nav-backing|0xaaa': { status: 'ok', since: 1 },
    }));
    const r = await verifyCanaryState(p);
    assert.equal(r.ok, true);
    assert.equal(r.lastScannedBlock, 8_000_000);
    assert.equal(r.summary.tracked, 2);
    const text = formatCanaryStateReport(r);
    assert.match(text, /lastScannedBlock=8000000/);
    assert.match(text, /NOT OK {4}oracle-freshness\|0xaaa\|WETH \(alert since poll 12\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an absent state file explains the consequence of starting without it', async () => {
  const r = await verifyCanaryState(join(tmpdir(), `no-canary-${process.pid}.json`));
  assert.equal(r.ok, false);
  assert.match(r.error, /re-observe every signal/);
  assert.match(formatCanaryStateReport(r), /UNUSABLE/);
});

test('a corrupt state file is reported, not thrown', async () => {
  const dir = await tmp();
  const p = join(dir, 'canary-state.json');
  try {
    await writeFile(p, '{"transitions": ', 'utf8');
    const r = await verifyCanaryState(p);
    assert.equal(r.ok, false);
    assert.equal(r.exists, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the backup ring applies here too, and verify summarises each rung', async () => {
  const dir = await tmp();
  const p = join(dir, 'canary-state.json');
  try {
    let t = 0;
    const w = createCanaryStateWriter({ path: p, backups: 2, backupIntervalMs: 0, now: () => (t += 1000) });
    for (const b of [1, 2, 3, 4]) await w.save(STATE(b, { x: { status: 'ok', since: b } }));
    const r = await verifyCanaryState(p);
    assert.equal(r.lastScannedBlock, 4);
    assert.deepEqual(r.backups.map((x) => [x.n, x.lastScannedBlock]), [[1, 3], [2, 2]]);

    await writeFile(backupPath(p, 2), 'nope', 'utf8');
    const r2 = await verifyCanaryState(p);
    assert.equal(r2.backups[1].ok, false);
    assert.match(formatCanaryStateReport(r2), /\.2 {2}UNREADABLE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
