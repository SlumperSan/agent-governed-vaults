// @ts-check
/**
 * Alert sinks. The load-bearing property is that a paging OUTAGE never becomes a monitoring
 * outage: a sink that throws, times out, or returns 500 must be reported and stepped over, never
 * allowed to take the canary down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConsoleSink, createWebhookSink, createTieredWebhookSink, createDeadmanPing, emitAll,
  PAGE_SIGNALS, LOG_SIGNALS, tierOf,
} from '../src/sinks.mjs';
import { SIGNAL as EXIT_LIVENESS } from '../src/signals/exit-liveness.mjs';
import { SIGNAL as FEE_ROUTING } from '../src/signals/fee-routing.mjs';
import { SIGNAL as FEED_IDENTITY } from '../src/signals/feed-identity.mjs';
import { SIGNAL as MODULE_EVENTS } from '../src/signals/module-events.mjs';
import { SIGNAL as NAV_BACKING } from '../src/signals/nav-backing.mjs';
import { SIGNAL as ORACLE_HEALTH } from '../src/signals/oracle-health.mjs';
import { SIGNAL as SHARE_CONSERVATION } from '../src/signals/share-conservation.mjs';

const tr = (to = 'alert', signal = 'nav-backing') => ({
  id: `${signal}|0xv`, signal, vault: '0xv', key: undefined,
  from: 'ok', to, line: `${to.toUpperCase()} [${signal}] diverged`,
  result: { measured: '1.20%', threshold: '0.50%', detail: { vault: '0xv', navWad: 7n } },
});

test('console sink sends alerts to stderr and recoveries to stdout', async () => {
  const out = [], err = [];
  const sink = createConsoleSink({ log: (m) => out.push(m), error: (m) => err.push(m) });
  await sink.emit(tr('alert'));
  await sink.emit(tr('skipped'));
  await sink.emit(tr('ok'));
  assert.equal(err.length, 2, 'alerts and degradations go to stderr so `2>` is a pure problem feed');
  assert.equal(out.length, 1);
});

test('webhook posts one JSON body per transition, with the structured detail', async () => {
  const calls = [];
  const sink = createWebhookSink({
    url: 'https://example.invalid/hook',
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; },
  });
  await sink.emit(tr('alert'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.status, 'alert');
  assert.equal(body.previousStatus, 'ok');
  assert.equal(body.signal, 'nav-backing');
  assert.equal(body.vault, '0xv');
  assert.equal(body.measured, '1.20%');
  assert.equal(body.detail.navWad, '7', 'bigints must survive JSON.stringify, not throw');
  assert.equal(body.tier, 'page', 'a single-URL receiver can still route on tier without re-deriving the map');
});

test('a webhook failure is reported but never propagates', async () => {
  const errs = [];
  const sink = createWebhookSink({
    url: 'https://example.invalid/hook',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    onError: (m) => errs.push(m),
  });
  await sink.emit(tr());
  assert.equal(errs.length, 1);
  assert.match(errs[0], /webhook delivery failed/);
});

test('a non-2xx webhook response is reported but never propagates', async () => {
  const errs = [];
  const sink = createWebhookSink({
    url: 'https://example.invalid/hook',
    fetchImpl: async () => ({ ok: false, status: 503 }),
    onError: (m) => errs.push(m),
  });
  await sink.emit(tr());
  assert.match(errs[0], /webhook returned 503/);
});

test('emitAll keeps going when one sink throws — a paging outage is not a monitoring outage', async () => {
  const delivered = [];
  const errs = [];
  const broken = { name: 'broken', emit: async () => { throw new Error('boom'); } };
  const good = { name: 'good', emit: async (t) => delivered.push(t.id) };
  await emitAll([broken, good], [tr(), tr()], { onError: (m) => errs.push(m) });
  assert.equal(delivered.length, 2, 'the working sink still received both transitions');
  assert.equal(errs.length, 2);
  assert.match(errs[0], /sink broken threw/);
});

// ── severity tiers (Monitoring Gap Analysis §2 G6 / §3 item 4) ─────────────────

test('tierOf: PAGE iff the transition is an ALERT for one of the four named signals', () => {
  for (const signal of ['nav-backing', 'share-conservation', 'fee-routing', 'exit-liveness', 'oracle-freshness']) {
    assert.equal(tierOf(tr('alert', signal)), 'page', `${signal} ALERT must page`);
    assert.equal(tierOf(tr('ok', signal)), 'log', `${signal} RECOVERED must not page`);
    assert.equal(tierOf(tr('skipped', signal)), 'log', `${signal} DEGRADED must not page (SEV-3, not SEV-1)`);
  }
});

test('tierOf: feed-identity is LOG even on ALERT — not in the note\'s PAGE list', () => {
  assert.equal(tierOf(tr('alert', 'feed-identity')), 'log');
});

test('tierOf: an unknown/renamed signal defaults to LOG, never silently PAGE', () => {
  assert.equal(tierOf(tr('alert', 'some-future-signal')), 'log');
});

test('tierOf: an explicit detail.tier wins over the derived signal/status map (the self-test path)', () => {
  const forced = tr('ok', 'nav-backing');
  forced.result.detail.tier = 'page';
  assert.equal(tierOf(forced), 'page', 'a synthetic self-test can force PAGE without impersonating a real ALERT');
  const forcedLog = tr('alert', 'nav-backing');
  forcedLog.result.detail.tier = 'log';
  assert.equal(tierOf(forcedLog), 'log', 'and force LOG even on what looks like a real ALERT');
});

test('coverage: every signal name the runner can actually emit is an explicit PAGE or LOG decision', () => {
  const liveSignals = new Set([
    EXIT_LIVENESS, FEE_ROUTING, FEED_IDENTITY, MODULE_EVENTS, NAV_BACKING, ORACLE_HEALTH,
    SHARE_CONSERVATION,
    'vault-config', // the whole-vault-unreadable DETECTOR BROKEN result in canary-runner.mjs
  ]);
  for (const signal of liveSignals) {
    assert.ok(
      PAGE_SIGNALS.has(signal) || LOG_SIGNALS.has(signal),
      `${signal} is not classified in either PAGE_SIGNALS or LOG_SIGNALS — a rename or a new ` +
      'signal must be an explicit tiering decision, not fall through by accident',
    );
  }
  // And nothing in the two sets has silently drifted apart from what actually exists.
  for (const signal of [...PAGE_SIGNALS, ...LOG_SIGNALS]) {
    assert.ok(liveSignals.has(signal), `${signal} is classified but no signal file emits it any more`);
  }
});

test('createTieredWebhookSink routes a PAGE-tier transition to pageUrl only', async () => {
  const calls = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://example.invalid/page', logUrl: 'https://example.invalid/log',
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200 }; },
  });
  await sink.emit(tr('alert', 'nav-backing'));
  assert.deepEqual(calls, ['https://example.invalid/page']);
});

test('createTieredWebhookSink routes a LOG-tier transition to logUrl only', async () => {
  const calls = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://example.invalid/page', logUrl: 'https://example.invalid/log',
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200 }; },
  });
  await sink.emit(tr('skipped', 'nav-backing'));
  await sink.emit(tr('alert', 'feed-identity'));
  assert.deepEqual(calls, ['https://example.invalid/log', 'https://example.invalid/log']);
});

test('createTieredWebhookSink with only ALERT_WEBHOOK_URL set is identical to the old single-webhook behaviour', async () => {
  const calls = [];
  const only = 'https://example.invalid/hook';
  const sink = createTieredWebhookSink({
    pageUrl: only, logUrl: only, // both resolved from the same ALERT_WEBHOOK_URL fallback
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200 }; },
  });
  await sink.emit(tr('alert', 'nav-backing'));
  await sink.emit(tr('ok', 'nav-backing'));
  await sink.emit(tr('skipped', 'module-events'));
  assert.deepEqual(calls, [only, only, only], 'every transition still reaches the one configured URL exactly once');
});

test('createTieredWebhookSink silently drops a tier with no URL configured, never throws', async () => {
  const calls = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://example.invalid/page', logUrl: null,
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200 }; },
  });
  await sink.emit(tr('skipped', 'module-events')); // LOG tier, but no logUrl
  assert.deepEqual(calls, []);
  await sink.emit(tr('alert', 'nav-backing')); // PAGE tier, delivered
  assert.deepEqual(calls, ['https://example.invalid/page']);
});

test('createTieredWebhookSink with both URLs unset never posts and never throws', async () => {
  const sink = createTieredWebhookSink({ pageUrl: null, logUrl: null, fetchImpl: async () => { throw new Error('must not be called'); } });
  await sink.emit(tr('alert', 'nav-backing'));
  await sink.emit(tr('skipped', 'module-events'));
});

// ── off-host dead-man's switch (Monitoring Gap Analysis §2 G6) ────────────────

test('deadman ping: unset URL is a no-op, never calls fetch', async () => {
  const calls = [];
  const deadman = createDeadmanPing({ url: null, fetchImpl: async (u) => { calls.push(u); return { ok: true }; } });
  assert.equal(deadman.enabled, false);
  await deadman.ping();
  assert.deepEqual(calls, []);
});

test('deadman ping: a 2xx response pings and reports nothing', async () => {
  const calls = [];
  const errs = [];
  const deadman = createDeadmanPing({
    url: 'https://hc-ping.com/test-uuid',
    fetchImpl: async (url, opts) => { calls.push({ url, method: opts.method }); return { ok: true, status: 200 }; },
    onError: (m) => errs.push(m),
  });
  assert.equal(deadman.enabled, true);
  await deadman.ping();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hc-ping.com/test-uuid');
  assert.equal(errs.length, 0);
});

test('deadman ping: a non-2xx response is logged but does not throw', async () => {
  const errs = [];
  const deadman = createDeadmanPing({
    url: 'https://hc-ping.com/test-uuid',
    fetchImpl: async () => ({ ok: false, status: 500 }),
    onError: (m) => errs.push(m),
  });
  await deadman.ping();
  assert.match(errs[0], /dead-man ping returned 500/);
});

test('deadman ping: a thrown/network error is logged but does not throw — a missed page is not a monitoring outage', async () => {
  const errs = [];
  const deadman = createDeadmanPing({
    url: 'https://hc-ping.com/test-uuid',
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
    onError: (m) => errs.push(m),
  });
  await deadman.ping();
  assert.match(errs[0], /dead-man ping failed: ENOTFOUND/);
});
