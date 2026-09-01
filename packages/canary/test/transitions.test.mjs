// @ts-check
/**
 * Transition detection — the piece that makes the canary quiet.
 *
 * The load-bearing property is NEGATIVE: a healthy chain must produce zero output, forever. If
 * that breaks, operators mute the canary and every other signal in this package stops mattering.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransitionTracker, formatLine } from '../src/transitions.mjs';
import { ok, alert, skipped } from '../src/signal.mjs';

const V = '0x' + '1'.repeat(40);
const okR = (signal = 'nav-backing', key) => ok({ signal, vault: V, key, message: 'fine', measured: '0.00%', threshold: '0.50%' });
const alertR = (signal = 'nav-backing', key) => alert({ signal, vault: V, key, message: 'diverged', measured: '1.20%', threshold: '0.50%' });
const skipR = (signal = 'exit-liveness') => skipped({ signal, vault: V, message: 'cannot run' });

test('SILENT while healthy — no output on the first poll or any poll after', () => {
  const t = createTransitionTracker();
  assert.deepEqual(t.observe([okR()], { poll: 1 }), []);
  assert.deepEqual(t.observe([okR()], { poll: 2 }), []);
  assert.deepEqual(t.observe([okR()], { poll: 3 }), []);
});

test('emits on the FIRST sighting of an alert, even with no prior OK to transition from', () => {
  const t = createTransitionTracker();
  const [tr] = t.observe([alertR()], { poll: 1 });
  assert.equal(tr.to, 'alert');
  assert.match(tr.line, /ALERT \[nav-backing\] diverged/);
});

test('one line per transition, not one per poll', () => {
  const t = createTransitionTracker();
  t.observe([okR()], { poll: 1 });
  assert.equal(t.observe([alertR()], { poll: 2 }).length, 1);
  assert.equal(t.observe([alertR()], { poll: 3 }).length, 0, 'a persisting alert must not re-page');
  assert.equal(t.observe([alertR()], { poll: 4 }).length, 0);
  const [rec] = t.observe([okR()], { poll: 5 });
  assert.equal(rec.from, 'alert');
  assert.equal(rec.to, 'ok');
  assert.match(rec.line, /RECOVERED/);
});

test('OK→SKIPPED emits — a sentinel that has stopped being able to run must be visible', () => {
  const t = createTransitionTracker();
  t.observe([ok({ signal: 'exit-liveness', vault: V, message: 'live' })], { poll: 1 });
  const [tr] = t.observe([skipR()], { poll: 2 });
  assert.equal(tr.to, 'skipped');
  assert.match(tr.line, /DEGRADED/);
});

test('per-asset keys track independently — one stale asset cannot flap the whole vault', () => {
  const t = createTransitionTracker();
  const A = '0xaaa', B = '0xbbb';
  t.observe([okR('oracle-freshness', A), okR('oracle-freshness', B)], { poll: 1 });
  const out = t.observe([alertR('oracle-freshness', A), okR('oracle-freshness', B)], { poll: 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, A);
});

test('minConsecutive holds a flapping status back until it repeats', () => {
  const t = createTransitionTracker();
  const racy = (status) => ({
    ...(status === 'ok' ? okR('share-conservation') : alertR('share-conservation')),
    detail: { minConsecutive: 2 },
  });
  t.observe([racy('ok')], { poll: 1 });
  assert.equal(t.observe([racy('alert')], { poll: 2 }).length, 0, 'one racy observation is not enough');
  assert.equal(t.observe([racy('alert')], { poll: 3 }).length, 1, 'two in a row pages');
});

test('minConsecutive resets when the status flaps back before confirming', () => {
  const t = createTransitionTracker();
  const racy = (status) => ({
    ...(status === 'ok' ? okR('share-conservation') : alertR('share-conservation')),
    detail: { minConsecutive: 3 },
  });
  t.observe([racy('ok')], { poll: 1 });
  t.observe([racy('alert')], { poll: 2 });
  t.observe([racy('ok')], { poll: 3 });
  assert.equal(t.observe([racy('alert')], { poll: 4 }).length, 0, 'the streak restarted');
});

test('state round-trips through a snapshot, so a restart does not re-page a standing alert', () => {
  const t1 = createTransitionTracker();
  t1.observe([alertR()], { poll: 1 });
  const t2 = createTransitionTracker({ initial: JSON.parse(JSON.stringify(t1.snapshot())) });
  assert.deepEqual(t2.observe([alertR()], { poll: 1 }), [], 'the alert was already reported before the restart');
  assert.equal(t2.observe([okR()], { poll: 2 }).length, 1, 'and the recovery still lands');
});

test('unhealthy() lists what is currently wrong, for the heartbeat summary', () => {
  const t = createTransitionTracker();
  t.observe([alertR('nav-backing'), okR('fee-routing'), skipR('exit-liveness')], { poll: 1 });
  assert.deepEqual(t.unhealthy().map((u) => u.id).sort(), [
    `exit-liveness|${V}`, `nav-backing|${V}`,
  ]);
});

test('an alert line names the vault, the signal, and measured vs threshold', () => {
  const line = formatLine('alert', alertR(), '2026-08-19T00:00:00.000Z');
  assert.match(line, /2026-08-19T00:00:00\.000Z/);
  assert.match(line, /ALERT/);
  assert.match(line, /\[nav-backing\]/);
  assert.match(line, /\(measured 1\.20%, threshold 0\.50%\)/);
});

// ── the one exception to report-once: a detector that cannot run at all ──────
//
// Report-once is right for a problem in the SYSTEM — someone is already looking at it. It is
// exactly wrong for a problem in the MONITOR: the pre-C-6 oracle signal called a function its
// oracle does not have, emitted one DEGRADED line at startup, and then stayed silent for the
// rest of the deployment's life while the flagship freeze detector was dead. These tests are the
// guard on that.

const brokenR = (signal = 'oracle-freshness') => skipped({
  signal, vault: V, message: 'cannot reach the oracle', detail: { detectorBroken: true },
});

test('a BROKEN detector is re-asserted on a doubling backoff instead of falling silent', () => {
  const t = createTransitionTracker();
  const seen = [];
  for (let poll = 1; poll <= 40; poll += 1) {
    for (const tr of t.observe([brokenR()], { poll })) seen.push({ poll, repeat: tr.repeat ?? 0 });
  }
  assert.deepEqual(seen.map((s) => s.poll), [1, 2, 4, 8, 16, 32], 'sweeps 1, 2, 4, 8, 16, 32');
  assert.deepEqual(seen.map((s) => s.repeat), [0, 2, 4, 8, 16, 32]);
});

test('the re-assertion says DETECTOR BROKEN and how long it has been blind, not just DEGRADED', () => {
  const t = createTransitionTracker();
  const [first] = t.observe([brokenR()], { poll: 1 });
  assert.match(first.line, /DETECTOR BROKEN \[oracle-freshness\]/);
  assert.ok(!/DEGRADED/.test(first.line), 'a blind monitor must not read like a degraded check');
  t.observe([brokenR()], { poll: 2 });
  t.observe([brokenR()], { poll: 3 });
  const [again] = t.observe([brokenR()], { poll: 4 });
  assert.match(again.line, /still blind after 4 consecutive sweeps/);
});

test('an ORDINARY degraded check still reports exactly once — the escalation is opt-in, not blanket', () => {
  // exit-liveness with no member to probe, or a NAV read behind a StaleOracle, are known-state
  // skips. Escalating those would page forever and get the whole canary muted.
  const t = createTransitionTracker();
  let lines = 0;
  for (let poll = 1; poll <= 40; poll += 1) lines += t.observe([skipR()], { poll }).length;
  assert.equal(lines, 1);
});

test('a broken detector that RECOVERS stops escalating and reports the recovery once', () => {
  const t = createTransitionTracker();
  t.observe([brokenR()], { poll: 1 });
  t.observe([brokenR()], { poll: 2 });
  const [rec] = t.observe([okR('oracle-freshness')], { poll: 3 });
  assert.equal(rec.to, 'ok');
  assert.match(rec.line, /RECOVERED/);
  for (let poll = 4; poll <= 20; poll += 1) {
    assert.deepEqual(t.observe([okR('oracle-freshness')], { poll }), [], 'healthy again means silent again');
  }
});

test('a RESTART cannot inherit silence: a still-broken detector re-asserts within two sweeps', () => {
  // The persisted state file predates these counters on any canary upgraded in place, so the
  // restored entry has no backoff position at all. It must resurface, not stay quiet forever.
  const t1 = createTransitionTracker();
  t1.observe([brokenR()], { poll: 1 });
  const restored = JSON.parse(JSON.stringify(t1.snapshot()));
  delete restored[`oracle-freshness|${V}`].brokenPolls;
  delete restored[`oracle-freshness|${V}`].brokenNext;

  const t2 = createTransitionTracker({ initial: restored });
  assert.equal(t2.observe([brokenR()], { poll: 1 }).length, 0);
  const out = t2.observe([brokenR()], { poll: 2 });
  assert.equal(out.length, 1, 'the blind detector is announced again after the restart');
  assert.match(out[0].line, /DETECTOR BROKEN/);
});

test('escalation state round-trips through a snapshot, so the backoff is not restarted every sweep', () => {
  const t = createTransitionTracker();
  for (let poll = 1; poll <= 5; poll += 1) t.observe([brokenR()], { poll });
  const snap = JSON.parse(JSON.stringify(t.snapshot()));
  assert.equal(snap[`oracle-freshness|${V}`].brokenPolls, 5);
  assert.equal(snap[`oracle-freshness|${V}`].brokenNext, 8);
});
