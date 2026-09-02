// @ts-check
/**
 * Alert sinks. The load-bearing property is that a paging OUTAGE never becomes a monitoring
 * outage: a sink that throws, times out, or returns 500 must be reported and stepped over, never
 * allowed to take the canary down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { sep } from 'node:path';
import {
  createConsoleSink, createWebhookSink, createTieredWebhookSink, createDeadmanPing, emitAll,
  PAGE_SIGNALS, LOG_SIGNALS, CONDITIONAL_PAGE, tierOf,
} from '../src/sinks.mjs';
import { EMITTABLE_SIGNALS } from '../src/canary-runner.mjs';

/**
 * Every SIGNAL name `src/signals/` can emit, read from DISK rather than from a hand-written import
 * list. The list version could only catch a RENAME: adding a whole new signal file left the
 * coverage test below passing while `tierOf` routed the new signal to LOG by default — exactly the
 * silent-severity-decision this test exists to prevent. Resolved against `import.meta.url`, not the
 * cwd, because `npm run gate` runs the suite from the repo root. A file with no `SIGNAL` export is
 * a shared helper, not a signal, and is skipped.
 */
const SIGNALS_DIR = new URL('../src/signals/', import.meta.url);
async function signalNamesOnDisk() {
  // RECURSIVE on purpose. A non-recursive readdir could not see `src/signals/<subdir>/x.mjs`, which
  // made such a file invisible to BOTH halves of the coverage test below — absent from the live set
  // so the forward check never saw it, absent from every tier set so the reverse check never saw it
  // — and it routed to LOG with a green suite.
  const files = (await readdir(SIGNALS_DIR, { recursive: true })).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 0, 'src/signals/ resolved to an empty directory — the URL above is wrong');
  const names = new Set();
  for (const file of files) {
    const mod = await import(new URL(file.split(sep).join('/'), SIGNALS_DIR).href);
    // Two files legitimately export the SAME name (`oracle-freshness.mjs` and the post-pivot
    // `oracle-health.mjs`, which kept the wire name across the rename); a Set is the point.
    if (typeof mod.SIGNAL === 'string') names.add(mod.SIGNAL);
  }
  return names;
}

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

test('tierOf: a feed-identity ALERT that carries HARM pages; the self-clearing swap does not', () => {
  const harmful = (harm) => {
    const t = tr('alert', 'feed-identity');
    t.result.detail = { ...t.result.detail, harm };
    return t;
  };
  // The two LATCHING alerts: the oracle's cached scale / denomination is now permanently wrong and
  // cannot be repaired, only evacuated. Above BTC $100,000 the sane-price band no longer catches a
  // -2-decimal drift at all (Owner Decisions 2026-09-01 §1), so this is the ONLY detector.
  assert.equal(tierOf(harmful('decimals')), 'page', 'a mis-scaled feed is member capital wrong-priced — SEV-1');
  assert.equal(tierOf(harmful('denomination')), 'page', 'a non-USD-quoted feed is the same latch by another route');
  // The harmless one: a routine Chainlink aggregator swap, re-pinned and self-cleared next sweep.
  assert.equal(tierOf(harmful(null)), 'log', 'a benign aggregator swap must not wake anyone');
  // A feed-identity result with no `harm` key at all (an older state file, a future leg) is not
  // proven harmful, so it must not page.
  assert.equal(tierOf(tr('alert', 'feed-identity')), 'log');
  // And the predicate is only ever consulted on an ALERT.
  const degraded = tr('skipped', 'feed-identity');
  degraded.result.detail = { ...degraded.result.detail, harm: 'decimals' };
  assert.equal(tierOf(degraded), 'log', 'a DEGRADED feed-identity is a broken detector, not a proven drift');
});

test('tierOf: an unknown/renamed signal defaults to LOG, never silently PAGE', () => {
  assert.equal(tierOf(tr('alert', 'some-future-signal')), 'log');
});

test('tierOf: detail.tier is honoured ONLY alongside detail.selfTest — a real signal cannot demote its own page', () => {
  const forced = tr('ok', 'nav-backing');
  forced.result.detail.tier = 'page';
  forced.result.detail.selfTest = true;
  assert.equal(tierOf(forced), 'page', 'a synthetic self-test can force PAGE without impersonating a real ALERT');
  const forcedLog = tr('alert', 'self-test');
  forcedLog.result.detail.tier = 'log';
  forcedLog.result.detail.selfTest = true;
  assert.equal(tierOf(forcedLog), 'log', 'and force LOG for the LOG-tier half of the self-test');

  // The footgun this scoping closes: `detail` is a bag of DECODED ON-CHAIN VALUES. A future signal
  // that spreads a struct containing a field named `tier` into it would otherwise be able to
  // silently route a real SEV-1 ALERT to the LOG endpoint.
  const smuggled = tr('alert', 'nav-backing');
  smuggled.result.detail.tier = 'log';
  assert.equal(tierOf(smuggled), 'page', 'a real nav-backing ALERT pages no matter what detail.tier says');
  const promoted = tr('alert', 'module-events');
  promoted.result.detail.tier = 'page';
  assert.equal(tierOf(promoted), 'log', 'and the override cannot promote a real LOG signal either');
});

test('a governance-watch ALERT reaches the PAGER, and its recovery and blind-detector lines do not', async () => {
  // Monitoring Gap Analysis §3 item 5 is explicit that this signal pages. Asserting the ROUTE, not
  // membership of PAGE_SIGNALS, is what stops a future tierOf() refactor from quietly demoting it:
  // the set could stay correct while the derivation stopped consulting it.
  const { SIGNAL: GOVERNANCE_WATCH } = await import('../src/signals/governance-watch.mjs');
  const calls = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://example.invalid/page', logUrl: 'https://example.invalid/log',
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200 }; },
  });
  await sink.emit(tr('alert', GOVERNANCE_WATCH));
  // Leaving a phase is a RECOVERED line and a blind governance detector is a DEGRADED one; both
  // route LOG, because tierOf pages only on `to === 'alert'`. That is the package-wide rule for
  // every signal's non-alert statuses, recorded here rather than changed.
  await sink.emit(tr('ok', GOVERNANCE_WATCH));
  await sink.emit(tr('skipped', GOVERNANCE_WATCH));
  assert.deepEqual(calls, [
    'https://example.invalid/page',
    'https://example.invalid/log',
    'https://example.invalid/log',
  ]);
  assert.equal(tierOf(tr('alert', GOVERNANCE_WATCH)), 'page');
});

test('coverage: the signal files and the runner\'s declaration agree — neither proxy is trusted alone', async () => {
  const onDisk = await signalNamesOnDisk();
  // `vault-config` is the one emittable name with no file: `canary-runner.mjs` synthesises it when a
  // whole vault's config is unreadable. Everything else must exist in both places.
  for (const signal of EMITTABLE_SIGNALS) {
    assert.ok(
      signal === 'vault-config' || onDisk.has(signal),
      `${signal} is declared EMITTABLE by the runner but no file under src/signals/ exports it`,
    );
  }
  for (const signal of onDisk) {
    assert.ok(
      EMITTABLE_SIGNALS.has(signal),
      `${signal} has a signal file but the runner does not declare it emittable — either wire it up ` +
      'in collectSignals and add it to EMITTABLE_SIGNALS, or delete the file. A signal that exists ' +
      'but is never dispatched is a detector everyone believes is running.',
    );
  }
});

test('coverage: every signal the runner can EMIT is an explicit PAGE / CONDITIONAL / LOG decision', async () => {
  // The runner's own declaration, not a directory listing — the directory is a proxy for this, and
  // the test above is what keeps the two honest.
  const liveSignals = new Set(EMITTABLE_SIGNALS);

  const classify = (signal) => [
    PAGE_SIGNALS.has(signal) && 'PAGE_SIGNALS',
    CONDITIONAL_PAGE.has(signal) && 'CONDITIONAL_PAGE',
    LOG_SIGNALS.has(signal) && 'LOG_SIGNALS',
  ].filter(Boolean);

  for (const signal of liveSignals) {
    assert.deepEqual(
      classify(signal).length, 1,
      `${signal} is classified in ${classify(signal).length} of PAGE_SIGNALS / CONDITIONAL_PAGE / ` +
      'LOG_SIGNALS, and must be in exactly one. A NEW SIGNAL FILE, or a rename, is a severity ' +
      'decision somebody has to make on purpose — it must not fall through to LOG by accident. ' +
      'Three canary PRs were adding signals when this test was written (#115 operator-power and ' +
      'depeg-reference, #117 governance-watch); whichever lands last adds its names to sinks.mjs.',
    );
  }
  // And nothing classified has silently drifted apart from what actually exists on disk.
  for (const signal of [...PAGE_SIGNALS, ...CONDITIONAL_PAGE.keys(), ...LOG_SIGNALS]) {
    assert.ok(liveSignals.has(signal), `${signal} is classified but no signal file emits it any more`);
  }
  // A self-check on the mechanism: eight emittable names when this was written — seven dispatched by
  // `collectSignals` plus the synthesised `vault-config`.
  assert.ok(liveSignals.size >= 8, `only ${liveSignals.size} signals discovered — EMITTABLE_SIGNALS is not being read`);
});

// ── the feed-identity split, proven by DISPATCH rather than by set membership ─
//
// The coverage test above is a claim about the SETS. This is the claim that actually matters, and
// it is only true if the whole path — emitAll -> tiered sink -> tierOf -> CONDITIONAL_PAGE
// predicate -> the chosen URL — agrees: a LATCHING feed-identity drift must physically arrive at
// the PAGE endpoint, and the self-clearing aggregator swap must physically arrive at the LOG one.

/** One real feed-identity ALERT transition, shaped the way `signals/feed-identity.mjs` emits it. */
const feedIdentityAlert = (harm) => ({
  id: 'feed-identity|0xv|0xasset', signal: 'feed-identity', vault: '0xv', key: '0xasset',
  from: 'ok', to: 'alert', line: `ALERT [feed-identity] harm=${harm}`,
  result: {
    signal: 'feed-identity', vault: '0xv', key: '0xasset', status: 'alert',
    measured: 'decimals 6', threshold: 'the cached scale 10000000000',
    detail: { vault: '0xv', asset: '0xasset', feed: '0xfeed', harm },
  },
});

test('dispatch: a LATCHING feed-identity ALERT physically reaches the PAGE endpoint', async () => {
  for (const harm of ['decimals', 'denomination']) {
    const posted = [];
    const sink = createTieredWebhookSink({
      pageUrl: 'https://example.invalid/page', logUrl: 'https://example.invalid/log',
      fetchImpl: async (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
    });
    await emitAll([sink], [feedIdentityAlert(harm)]);
    assert.equal(posted.length, 1, `harm='${harm}' must produce exactly one POST`);
    assert.equal(posted[0].url, 'https://example.invalid/page', `harm='${harm}' must WAKE somebody: the oracle's cached scale is now permanently wrong and only feed-identity can see it`);
    assert.equal(posted[0].body.tier, 'page', 'and the body must say so, for a receiver on a single shared URL');
    assert.equal(posted[0].body.signal, 'feed-identity');
    assert.equal(posted[0].body.detail.harm, harm);
  }
});

test('dispatch: a self-clearing feed-identity aggregator swap physically reaches the LOG endpoint', async () => {
  const posted = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://example.invalid/page', logUrl: 'https://example.invalid/log',
    fetchImpl: async (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
  });
  const swap = feedIdentityAlert(null);
  swap.result.detail.swapped = true;
  await emitAll([sink], [swap]);
  assert.deepEqual(posted.map((p) => p.url), ['https://example.invalid/log'], 'routine Chainlink operation that clears itself next sweep must not wake anyone');
  assert.equal(posted[0].body.tier, 'log');
});

test('dispatch: both feed-identity tiers in ONE sweep split across the two endpoints', async () => {
  const posted = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://example.invalid/page', logUrl: 'https://example.invalid/log',
    fetchImpl: async (url) => { posted.push(url); return { ok: true, status: 200 }; },
  });
  // Two assets on one vault: one drifted, one merely rotated. Same signal, same sweep.
  const drifted = feedIdentityAlert('decimals');
  const rotated = feedIdentityAlert(null);
  rotated.id = 'feed-identity|0xv|0xasset2';
  rotated.key = '0xasset2';
  await emitAll([sink], [drifted, rotated]);
  assert.deepEqual(posted, ['https://example.invalid/page', 'https://example.invalid/log'],
    'the split is per-transition, not per-signal — one signal name, two endpoints, same sweep');
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
