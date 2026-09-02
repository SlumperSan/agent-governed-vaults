// @ts-check
/**
 * End-to-end sweeps with a mocked client and a real snapshot on disk — no live RPC.
 *
 * The headline test is the DONE criterion for the whole package: pointed at a healthy deployment,
 * the canary emits NOTHING. Everything else here is the failure side of that: a single broken
 * thing produces exactly one actionable line, and a signal that cannot run says so instead of
 * reporting healthy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolveCanaryConfig, collectSignals, buildCanary, EMITTABLE_SIGNALS } from '../src/canary-runner.mjs';
import { saveSnapshot } from '../../indexer/src/store.mjs';
import { emptyState } from '../../indexer/src/projections.mjs';
import {
  mockReader, healthyVault, healthyState, chainlinkVault, log,
  VAULT, USDC, ORACLE, ASSET, REGISTRY, MEMBER, CREATOR, OPERATOR, SRC1, SRC2, SRC3, SEQ_FEED,
  AGGREGATOR, AGGREGATOR_2, GOVERNANCE, GOV_CONFIG, proposalTuple,
} from './helpers.mjs';

const NOW = 1_700_000_000;
const FRESH = { latestPrice: [3_000000000000000000n, BigInt(NOW - 10)] };

/** A healthy fixture with a 5-source oracle, so the freshness margin clears the default bar. */
function healthyFixture(overrides = {}) {
  const SRC4 = '0x' + 'd'.repeat(40);
  const SRC5 = '0x' + 'e'.repeat(40);
  return healthyVault({
    [ORACLE]: { priceWad: () => 3_000000000000000000n, assetConfig: () => [[SRC1, SRC2, SRC3, SRC4, SRC5], 3600, 2] },
    [SRC1]: FRESH, [SRC2]: FRESH, [SRC3]: FRESH, [SRC4]: FRESH, [SRC5]: FRESH,
    ...overrides,
  });
}

const baseCfg = resolveCanaryConfig({ RPC_URL: 'http://localhost:8545', OPERATOR_REGISTRY_ADDRESS: REGISTRY });
const WINDOW = { fromBlock: 900, toBlock: 995, nowSec: NOW };

// ── config resolution ────────────────────────────────────────────────────────

test('config: RPC_URL is required', () => {
  assert.throws(() => resolveCanaryConfig({}), /missing required env: RPC_URL/);
});

test('config: defaults are the documented ones', () => {
  const cfg = resolveCanaryConfig({ RPC_URL: 'http://x' });
  assert.equal(cfg.chainId, 8453);
  assert.equal(cfg.confirmations, 5);
  assert.equal(cfg.pollIntervalMs, 30_000);
  assert.equal(cfg.navDivergenceBps, 50);
  assert.equal(cfg.oracleMinMargin, 0);
  assert.equal(cfg.statePath, './data/indexer-state.json');
  assert.equal(cfg.canaryStatePath, './data/canary-state.json');
  assert.notEqual(cfg.canaryStatePath, cfg.statePath, 'the canary must never write to the indexer snapshot');
  assert.equal(cfg.webhookUrl, null);
  assert.equal(cfg.pageWebhookUrl, null);
  assert.equal(cfg.logWebhookUrl, null);
  assert.equal(cfg.deadmanPingUrl, null);
  assert.equal(cfg.testAlertOnStart, false);
  assert.equal(cfg.heartbeatMs, 3_600_000, 'non-negotiable per security-ops.md §5.2 — a dead canary must not look like a healthy one');
});

test('config: PAGE_WEBHOOK_URL / LOG_WEBHOOK_URL fall back to ALERT_WEBHOOK_URL independently', () => {
  const both = resolveCanaryConfig({ RPC_URL: 'http://x', ALERT_WEBHOOK_URL: 'https://hooks.example/only' });
  assert.equal(both.pageWebhookUrl, 'https://hooks.example/only');
  assert.equal(both.logWebhookUrl, 'https://hooks.example/only');

  const split = resolveCanaryConfig({
    RPC_URL: 'http://x', ALERT_WEBHOOK_URL: 'https://hooks.example/fallback',
    PAGE_WEBHOOK_URL: 'https://hooks.example/page',
  });
  assert.equal(split.pageWebhookUrl, 'https://hooks.example/page', 'the specific URL wins over the fallback');
  assert.equal(split.logWebhookUrl, 'https://hooks.example/fallback', 'the unset one still falls back');
});

test('config: HEARTBEAT_MS=0 explicitly disables the heartbeat, distinct from leaving it unset', () => {
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x', HEARTBEAT_MS: '0' }).heartbeatMs, 0);
});

test('config: CANARY_TEST_ALERT_ON_START accepts "1" or "true"', () => {
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x' }).testAlertOnStart, false);
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x', CANARY_TEST_ALERT_ON_START: '1' }).testAlertOnStart, true);
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x', CANARY_TEST_ALERT_ON_START: 'true' }).testAlertOnStart, true);
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x', CANARY_TEST_ALERT_ON_START: 'nope' }).testAlertOnStart, false);
});

test('config: the poll interval is namespaced, so the indexer POLL_INTERVAL_MS cannot capture it', () => {
  // compose feeds one .env to every service; a canary sweep is far heavier than an indexer poll.
  const cfg = resolveCanaryConfig({ RPC_URL: 'http://x', POLL_INTERVAL_MS: '12000' });
  assert.equal(cfg.pollIntervalMs, 30_000);
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x', CANARY_POLL_INTERVAL_MS: '60000' }).pollIntervalMs, 60_000);
});

test('config: rejects malformed addresses instead of silently watching nothing', () => {
  assert.throws(() => resolveCanaryConfig({ RPC_URL: 'http://x', VAULTS: 'not-an-address' }), /non-address entry/);
  assert.throws(() => resolveCanaryConfig({ RPC_URL: 'http://x', OPERATOR_REGISTRY_ADDRESS: '0xabc' }), /not a 20-byte address/);
  assert.throws(() => resolveCanaryConfig({ RPC_URL: 'http://x', EXTRA_OPERATOR_ADDRESSES: `${OPERATOR},oops` }), /non-address entry/);
});

test('config: lowercases addresses so they key the projection consistently', () => {
  const cfg = resolveCanaryConfig({ RPC_URL: 'http://x', VAULTS: VAULT.toUpperCase().replace('0X', '0x') });
  assert.deepEqual(cfg.vaults, [VAULT]);
});

// ── a full healthy sweep ─────────────────────────────────────────────────────

test('a healthy deployment produces ZERO alerts across every signal', async () => {
  const results = await collectSignals({
    reader: mockReader({ contracts: healthyFixture(), nowSec: NOW }),
    state: healthyState(), vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  const bad = results.filter((r) => r.status !== 'ok');
  assert.deepEqual(bad.map((r) => `${r.signal}: ${r.message}`), [], 'every signal must read healthy');
  assert.deepEqual(
    [...new Set(results.map((r) => r.signal))].sort(),
    ['exit-liveness', 'fee-routing', 'governance-watch', 'module-events', 'nav-backing', 'oracle-freshness', 'share-conservation'],
    'all seven signals must actually have run',
  );
});

// ── one broken thing at a time ───────────────────────────────────────────────

test('a tripped oracle alerts on freshness and DEGRADES the dependent signals, without double-paging NAV', async () => {
  const contracts = healthyFixture({
    [ORACLE]: { priceWad: () => ({ revert: '0xa2671f4b' }), assetConfig: () => [[SRC1, SRC2, SRC3], 3600, 3] },
    [SRC1]: FRESH, [SRC2]: FRESH, [SRC3]: { latestPrice: [3n, 1n] },
    [VAULT]: { ...healthyVault()[VAULT], navWad: { revert: '0xa2671f4b' } },
  });
  const results = await collectSignals({
    reader: mockReader({ contracts, nowSec: NOW }), state: healthyState(),
    vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  const by = (s) => results.filter((r) => r.signal === s);
  assert.equal(by('oracle-freshness')[0].status, 'alert');
  assert.equal(by('nav-backing')[0].status, 'skipped', 'NAV must not double-page for the oracle');
  assert.equal(by('nav-backing')[0].detail.attributedTo, 'oracle-freshness');
  assert.equal(results.filter((r) => r.status === 'alert').length, 1, 'exactly one page for one root cause');
});

test('a fee leak produces exactly one alert and it names the vault and the amount', async () => {
  const results = await collectSignals({
    reader: mockReader({
      contracts: healthyFixture(),
      logs: [log(USDC, 'Transfer', 950, { from: VAULT, to: OPERATOR, value: 12_345n })],
      nowSec: NOW,
    }),
    state: healthyState(), vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  const alerts = results.filter((r) => r.status === 'alert');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].signal, 'fee-routing');
  assert.ok(alerts[0].message.includes(VAULT.slice(0, 6)));
  assert.ok(alerts[0].message.includes('12345'));
});

test('a vault absent from the projection DEGRADES its two projection-fed signals, never reports them OK', async () => {
  const results = await collectSignals({
    reader: mockReader({ contracts: healthyFixture(), nowSec: NOW }),
    state: emptyState(), vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  for (const signal of ['share-conservation', 'exit-liveness']) {
    const r = results.find((x) => x.signal === signal);
    assert.equal(r.status, 'skipped', `${signal} must not claim health without a projection`);
    assert.match(r.message, /not in the indexer projection|cannot run/);
  }
  // The chain-only signals still ran.
  assert.equal(results.find((r) => r.signal === 'nav-backing').status, 'ok');
});

test('an unreadable vault suspends its signals with one line instead of blinding the whole sweep', async () => {
  const OTHER = '0x' + '9'.repeat(40);
  const results = await collectSignals({
    reader: mockReader({ contracts: healthyFixture(), nowSec: NOW }),
    state: healthyState(), vaults: [OTHER, VAULT], cfg: baseCfg, window: WINDOW,
  });
  const broken = results.filter((r) => r.vault === OTHER);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].signal, 'vault-config');
  assert.equal(broken[0].status, 'skipped');
  assert.ok(results.some((r) => r.vault === VAULT && r.status === 'ok'), 'the healthy vault was still swept');
});

// ── the runner loop, end to end, against a real snapshot file ────────────────

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'canary-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Write a real indexer snapshot the canary will discover vaults from. */
async function seedSnapshot(dir) {
  const state = emptyState();
  state.vaults.set(VAULT, {
    vault: VAULT, creator: CREATOR, usdc: USDC, operatorId: 7,
    totalShares: 500_000000000000000000n, idleUsdc: 1_000_000n, memberCount: 2,
    pendingCount: 0, capacityCapUsdc: 0n, parent: null, depth: 0,
  });
  state.shares.set(VAULT, new Map([[MEMBER, 400_000000000000000000n], [CREATOR, 100_000000000000000000n]]));
  state.lastBlock = 995;
  const statePath = join(dir, 'indexer-state.json');
  await saveSnapshot(statePath, state);
  return statePath;
}

test('runOnce against a healthy deployment prints NOTHING — silence is the healthy state', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const out = [], err = [];
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: join(dir, 'canary-state.json'), OPERATOR_REGISTRY_ADDRESS: REGISTRY,
    });
    const canary = await buildCanary(cfg, {
      log: (m) => out.push(m), error: (m) => err.push(m),
      client: {}, // unused: the reader below is what actually answers
    });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;
    const mock = mockReader({ contracts: healthyFixture(), nowSec: NOW });
    Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });

    const { transitions, results } = await canary.runOnce();
    assert.deepEqual(transitions, [], 'a healthy sweep must be completely silent');
    assert.deepEqual(out, []);
    assert.deepEqual(err, []);
    assert.ok(results.length >= 6);
  });
});

test('runOnce emits one line when something breaks, and stays quiet on the next poll', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const canaryStatePath = join(dir, 'canary-state.json');
    const out = [], err = [];
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: canaryStatePath, OPERATOR_REGISTRY_ADDRESS: REGISTRY,
    });
    const canary = await buildCanary(cfg, { log: (m) => out.push(m), error: (m) => err.push(m), client: {} });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;
    // navWad overstated by 1% — one broken thing, one expected line.
    const mock = mockReader({ contracts: healthyFixture({ [VAULT]: { ...healthyVault()[VAULT], navWad: 7_070000000000000000n } }), nowSec: NOW });
    Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });

    await canary.runOnce();
    assert.equal(err.length, 1, 'exactly one alert line');
    assert.match(err[0], /ALERT \[nav-backing\]/);
    assert.match(err[0], /measured 0\.99%, threshold 0\.50%/);

    await canary.runOnce();
    assert.equal(err.length, 1, 'a standing alert must not re-page every poll');

    // And it survives a restart without re-paging.
    const persisted = JSON.parse(await readFile(canaryStatePath, 'utf8'));
    assert.equal(persisted.lastScannedBlock, 995);
    assert.ok(Object.keys(persisted.transitions).length > 0);
  });
});

test('runOnce says so, loudly, when there is nothing to watch', async () => {
  await withTempDir(async (dir) => {
    const err = [];
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545',
      STATE_PATH: join(dir, 'absent.json'), CANARY_STATE_PATH: join(dir, 'canary-state.json'),
    });
    const canary = await buildCanary(cfg, { log: () => {}, error: (m) => err.push(m), client: {} });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;
    const { vaults } = await canary.runOnce();
    assert.deepEqual(vaults, []);
    assert.match(err[0], /no vaults to watch/, 'an empty watch set must never look like a clean bill of health');
  });
});

test('EMITTABLE_SIGNALS names exactly the signals a sweep can produce, and nothing else', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: join(dir, 'canary-state.json'), OPERATOR_REGISTRY_ADDRESS: REGISTRY,
    });
    const canary = await buildCanary(cfg, { log: () => {}, error: () => {}, client: {} });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;
    const mock = mockReader({ contracts: healthyFixture(), nowSec: NOW });
    Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });

    const { results } = await canary.runOnce();
    assert.ok(results.length > 0, 'the fixture produced no results, so this proves nothing');
    for (const r of results) {
      assert.ok(
        EMITTABLE_SIGNALS.has(r.signal),
        `a real sweep emitted '${r.signal}', which EMITTABLE_SIGNALS does not declare — sinks.mjs ` +
        'would have no tier for it',
      );
    }
  });
});

// ── the off-host dead-man's switch (Monitoring Gap Analysis G6) ──────────────
//
// The dead-man ping exists because `ops-check` runs on the SAME HOST as the canary: host death
// silences the watcher and the watcher's watcher together. That only works if the ping means
// "I am watching the chain" and not merely "my process is running".

test('a sweep that found ZERO vaults does NOT ping the dead-man — the external monitor must go red', async () => {
  await withTempDir(async (dir) => {
    const pings = [];
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545',
      STATE_PATH: join(dir, 'absent.json'), CANARY_STATE_PATH: join(dir, 'canary-state.json'),
      DEADMAN_PING_URL: 'https://hc-ping.invalid/uuid', CANARY_POLL_INTERVAL_MS: '20',
    });
    const err = [];
    const canary = await buildCanary(cfg, {
      log: () => {}, error: (m) => err.push(m), client: {},
      fetchImpl: async (url) => { pings.push(url); return { ok: true, status: 200 }; },
    });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;

    const running = canary.start();
    await new Promise((r) => setTimeout(r, 30));
    await canary.stop();
    await running;

    assert.deepEqual(pings, [], 'pinging here would tell the ONE off-host monitor that a canary watching nothing is alive');
    assert.ok(
      err.some((m) => /no vaults to watch/.test(m)),
      'and the empty watch set must be visible, not silent',
    );
    assert.ok(
      err.some((m) => /dead-man ping is being WITHHELD/.test(m)),
      'the line must say the ping was withheld, or the red external check looks like an unrelated outage',
    );
  });
});

test('a sweep that DID watch vaults pings the dead-man', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const pings = [];
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: join(dir, 'canary-state.json'), OPERATOR_REGISTRY_ADDRESS: REGISTRY,
      DEADMAN_PING_URL: 'https://hc-ping.invalid/uuid', CANARY_POLL_INTERVAL_MS: '20',
    });
    const canary = await buildCanary(cfg, {
      log: () => {}, error: () => {}, client: {},
      fetchImpl: async (url) => { pings.push(url); return { ok: true, status: 200 }; },
    });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;
    const mock = mockReader({ contracts: healthyFixture(), nowSec: NOW });
    Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });

    const running = canary.start();
    await new Promise((r) => setTimeout(r, 30));
    await canary.stop();
    await running;

    assert.ok(pings.length > 0, 'the healthy path must still ping, or the switch is permanently dead');
    assert.ok(pings.every((u) => u === 'https://hc-ping.invalid/uuid'));
  });
});

test('startup states which sinks are wired, by boolean — never the URLs, which are credentials', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const out = [], err = [];
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: join(dir, 'canary-state.json'), OPERATOR_REGISTRY_ADDRESS: REGISTRY,
      CANARY_POLL_INTERVAL_MS: '20',
    });
    const canary = await buildCanary(cfg, { log: (m) => out.push(m), error: (m) => err.push(m), client: {} });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;
    const mock = mockReader({ contracts: healthyFixture(), nowSec: NOW });
    Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });

    const running = canary.start();
    await new Promise((r) => setTimeout(r, 10));
    await canary.stop();
    await running;

    const sinkLine = out.find((m) => /^canary sinks:/.test(m));
    assert.ok(sinkLine, 'nothing at startup said whether anything was wired up at all');
    assert.match(sinkLine, /PAGE webhook NOT configured/);
    assert.match(sinkLine, /off-host dead-man NOT configured/);
    assert.ok(err.some((m) => /DEADMAN_PING_URL is unset/.test(m)), 'an unset dead-man must not be a silent no-op');
    assert.ok(err.some((m) => /Nobody is being paged/.test(m)));
  });
});

test('startup never prints a configured webhook or ping URL', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const out = [], err = [];
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: join(dir, 'canary-state.json'), OPERATOR_REGISTRY_ADDRESS: REGISTRY,
      PAGE_WEBHOOK_URL: 'https://hooks.invalid/s3cr3t-page',
      LOG_WEBHOOK_URL: 'https://hooks.invalid/s3cr3t-log',
      DEADMAN_PING_URL: 'https://hc-ping.invalid/s3cr3t-uuid',
      CANARY_POLL_INTERVAL_MS: '20',
    });
    const canary = await buildCanary(cfg, {
      log: (m) => out.push(m), error: (m) => err.push(m), client: {},
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;
    const mock = mockReader({ contracts: healthyFixture(), nowSec: NOW });
    Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });

    const running = canary.start();
    await new Promise((r) => setTimeout(r, 10));
    await canary.stop();
    await running;

    for (const m of [...out, ...err]) {
      assert.ok(!/s3cr3t/.test(m), `a sink URL leaked into the log stream: ${m}`);
    }
    assert.match(out.find((m) => /^canary sinks:/.test(m)) ?? '', /PAGE webhook configured.*LOG webhook configured.*dead-man configured/);
  });
});

test('CANARY_TEST_ALERT_ON_START warns that it re-fires on every restart', async () => {
  await withTempDir(async (dir) => {
    const err = [];
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', CANARY_STATE_PATH: join(dir, 'canary-state.json'),
      STATE_PATH: join(dir, 'absent.json'),
      CANARY_TEST_ALERT_ON_START: '1', CANARY_POLL_INTERVAL_MS: '20',
    });
    const canary = await buildCanary(cfg, { log: () => {}, error: (m) => err.push(m), client: {} });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;

    const running = canary.start();
    await new Promise((r) => setTimeout(r, 10));
    await canary.stop();
    await running;

    assert.ok(
      err.some((m) => /fires on EVERY start.*restart: unless-stopped/s.test(m)),
      'compose restarts this service automatically; a self-test left switched on pages the rotation every time',
    );
  });
});

test('the canary never writes to the indexer snapshot', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const before = await readFile(statePath, 'utf8');
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: join(dir, 'canary-state.json'), OPERATOR_REGISTRY_ADDRESS: REGISTRY,
    });
    const canary = await buildCanary(cfg, { log: () => {}, error: () => {}, client: {} });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;
    const mock = mockReader({ contracts: healthyFixture(), nowSec: NOW });
    Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });
    await canary.runOnce();
    assert.equal(await readFile(statePath, 'utf8'), before, 'the indexer snapshot must be read-only to the canary');
  });
});

test('a backlog larger than one window reports the unscanned gap instead of skipping it silently', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const canaryStatePath = join(dir, 'canary-state.json');
    const err = [];
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: canaryStatePath, OPERATOR_REGISTRY_ADDRESS: REGISTRY,
      MAX_LOG_SPAN_BLOCKS: '10',
    });
    const canary = await buildCanary(cfg, { log: () => {}, error: (m) => err.push(m), client: {} });
    let head = 1000;
    canary.reader.headBlock = async () => head;
    canary.reader.chainNow = async () => NOW;
    const mock = mockReader({ contracts: healthyFixture(), nowSec: NOW });
    Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });

    await canary.runOnce();          // establishes lastScannedBlock = 995
    assert.deepEqual(err, [], 'the first sweep is healthy and silent');

    head = 2000;                     // the canary was down for ~1000 blocks
    await canary.runOnce();
    assert.equal(err.length, 1);
    assert.match(err[0], /event scan gap/);
    assert.match(err[0], /blocks 996-1984/);
    assert.match(err[0], /MAX_LOG_SPAN_BLOCKS=10/);
  });
});

// ── the pivoted (ChainlinkOracle) deployment, end to end ─────────────────────
//
// Everything above prices through the RETIRED aggregator, because that is what the original
// fixture models. These sweep the oracle the protocol actually launches on. The bug being guarded
// here is not subtle and it shipped: against a ChainlinkOracle the old signal read a function that
// does not exist, degraded once, and then reported nothing for the life of the deployment.

/** The same healthy vault, priced by a ChainlinkOracle with a live sequencer uptime feed. */
const pivotedFixture = (opts = {}) => chainlinkVault({ nowSec: NOW, sequencerUptimeFeed: SEQ_FEED, ...opts });

test('a healthy PIVOTED deployment produces zero alerts, and the oracle signal really ran', async () => {
  const results = await collectSignals({
    reader: mockReader({ contracts: pivotedFixture(), nowSec: NOW }),
    state: healthyState(), vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  assert.deepEqual(results.filter((r) => r.status !== 'ok').map((r) => r.message), []);
  const oracle = results.filter((r) => r.signal === 'oracle-freshness');
  assert.equal(oracle.length, 2, 'one sequencer result plus one per basket asset');
  assert.ok(oracle.some((r) => r.detail.heartbeatSec === 3600), 'the ChainlinkOracle path ran, not the quorum one');
});

test('a frozen PIVOTED oracle pages once and DEGRADES the dependent signals, exactly as the retired one did', async () => {
  const results = await collectSignals({
    reader: mockReader({
      contracts: pivotedFixture({
        ageSec: 90_000, heartbeat: 3600, priceWadReverts: true,
        overrides: { [VAULT]: { ...healthyVault()[VAULT], navWad: { revert: '0xa2671f4b' } } },
      }),
      nowSec: NOW,
    }),
    state: healthyState(), vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  const alerts = results.filter((r) => r.status === 'alert');
  assert.equal(alerts.length, 1, 'exactly one page for one root cause');
  assert.equal(alerts[0].signal, 'oracle-freshness');
  assert.match(alerts[0].message, /past its 3600s heartbeat/);
  // The attribution nav-backing has always claimed is finally true again: something DOES page.
  const nav = results.find((r) => r.signal === 'nav-backing');
  assert.equal(nav.status, 'skipped');
  assert.equal(nav.detail.attributedTo, 'oracle-freshness');
});

test('an oracle the canary cannot introspect is a BROKEN DETECTOR in a full sweep, not a quiet skip', async () => {
  const contracts = pivotedFixture();
  // Strip the whole oracle surface: exactly the post-pivot shape, where the signal called a
  // function the deployed contract does not have.
  contracts[ORACLE.toLowerCase()] = { priceWad: () => 3_000000000000000000n };
  const results = await collectSignals({
    reader: mockReader({ contracts, nowSec: NOW }),
    state: healthyState(), vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  const r = results.find((x) => x.signal === 'oracle-freshness');
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true, 'the tracker escalates on this flag');
});

test('a signal that THROWS is a broken detector, not a one-line skip that goes quiet', async () => {
  // collectSignals catches per-signal exceptions so one bad vault cannot lose the sweep. That
  // catch used to produce an ordinary `skipped`, which transitions report once and never again.
  const reader = mockReader({ contracts: pivotedFixture(), nowSec: NOW });
  const realGetLogs = reader.getLogs;
  reader.getLogs = async () => { throw new Error('RPC exploded'); };
  const results = await collectSignals({
    reader, state: healthyState(), vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  reader.getLogs = realGetLogs;
  const broken = results.filter((r) => r.detail?.detectorBroken === true);
  assert.ok(broken.length > 0, 'a check that threw measured nothing and must say so, repeatedly');
  assert.match(broken[0].message, /ERRORED/);
  assert.match(broken[0].message, /unmonitored for that signal, not healthy/);
});

test('an unreadable vault is a BROKEN DETECTOR — it is the only case where NOTHING is covered', async () => {
  const OTHER = '0x' + '9'.repeat(40);
  const results = await collectSignals({
    reader: mockReader({ contracts: pivotedFixture(), nowSec: NOW }),
    state: healthyState(), vaults: [OTHER], cfg: baseCfg, window: WINDOW,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].signal, 'vault-config');
  assert.equal(results[0].detail.detectorBroken, true);
});

test('config: the ChainlinkOracle early-warning bar is off by default and is its own env var', async () => {
  // ORACLE_MIN_MARGIN belongs to the retired quorum regime and keeps its meaning; the new knob
  // must not capture it, or a pre-pivot deployment's calibration would silently change.
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x' }).oracleStalenessWarnPct, 0);
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x', ORACLE_MIN_MARGIN: '1' }).oracleStalenessWarnPct, 0);
  const cfg = resolveCanaryConfig({ RPC_URL: 'http://x', ORACLE_STALENESS_WARN_PCT: '80' });
  assert.equal(cfg.oracleStalenessWarnPct, 80);
  assert.equal(cfg.oracleMinMargin, 0, 'the retired knob is untouched');
});

test('config: "unset" and "explicitly 0" are distinguishable, which is what lets the derived bar apply by default', () => {
  // The derived default in signals/oracle-health.mjs must only fire when nothing was set — an
  // operator who explicitly wrote ORACLE_STALENESS_WARN_PCT=0 chose to force it off, and that must
  // not look identical to never having set it at all.
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x' }).oracleStalenessWarnPctSet, false);
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x', ORACLE_STALENESS_WARN_PCT: '0' }).oracleStalenessWarnPctSet, true);
  assert.equal(resolveCanaryConfig({ RPC_URL: 'http://x', ORACLE_STALENESS_WARN_PCT: '80' }).oracleStalenessWarnPctSet, true);
});

test('config: ORACLE_FEED_CADENCE_SECONDS parses address:seconds pairs, lowercased, for the derived bar', () => {
  const cfg = resolveCanaryConfig({
    RPC_URL: 'http://x',
    ORACLE_FEED_CADENCE_SECONDS: `${ASSET}:1200, 0x${'cd'.repeat(20)}:600`,
  });
  assert.deepEqual(cfg.oracleFeedCadenceSeconds, {
    [ASSET.toLowerCase()]: 1200,
    [`0x${'cd'.repeat(20)}`]: 600,
  });
});

test('config: ORACLE_FEED_CADENCE_SECONDS rejects a malformed address instead of silently mis-mapping it', () => {
  assert.throws(
    () => resolveCanaryConfig({ RPC_URL: 'http://x', ORACLE_FEED_CADENCE_SECONDS: 'not-an-address:1200' }),
    /ORACLE_FEED_CADENCE_SECONDS contains a non-address entry/,
  );
});

test('config: ORACLE_FEED_CADENCE_SECONDS rejects a non-positive or missing cadence', () => {
  assert.throws(
    () => resolveCanaryConfig({ RPC_URL: 'http://x', ORACLE_FEED_CADENCE_SECONDS: `${ASSET}:0` }),
    /non-positive\/invalid cadence/,
  );
  assert.throws(
    () => resolveCanaryConfig({ RPC_URL: 'http://x', ORACLE_FEED_CADENCE_SECONDS: `${ASSET}` }),
    /non-positive\/invalid cadence/,
  );
});

test('a full sweep derives the early-warning bar from ORACLE_FEED_CADENCE_SECONDS with no manual override set', async () => {
  const cfg = resolveCanaryConfig({
    RPC_URL: 'http://x', OPERATOR_REGISTRY_ADDRESS: REGISTRY,
    ORACLE_FEED_CADENCE_SECONDS: `${ASSET}:1200`,
  });
  const results = await collectSignals({
    reader: mockReader({ contracts: pivotedFixture({ ageSec: 2500, heartbeat: 3600 }), nowSec: NOW }),
    state: healthyState(), vaults: [VAULT], cfg, window: WINDOW,
  });
  const r = results.find((x) => x.signal === 'oracle-freshness' && x.key === ASSET);
  assert.equal(r.status, 'alert', 'ageSec 2500 is past the derived 2400s bar (2x the 1200s cadence)');
  assert.match(r.message, /AGEING/);
  assert.equal(r.detail.warnBarSource, 'derived');
  assert.equal(r.detail.warnAtSec, 2400);
});

// ── feed identity (signal g) is wired into the sweep ─────────────────────────

test('a healthy PIVOTED sweep runs EIGHT signals — feed-identity and governance-watch included, and silent', async () => {
  const results = await collectSignals({
    reader: mockReader({ contracts: pivotedFixture(), nowSec: NOW }),
    state: healthyState(), vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  assert.deepEqual(results.filter((r) => r.status !== 'ok').map((r) => r.message), []);
  assert.deepEqual(
    [...new Set(results.map((r) => r.signal))].sort(),
    ['exit-liveness', 'fee-routing', 'feed-identity', 'governance-watch', 'module-events', 'nav-backing', 'oracle-freshness', 'share-conservation'],
  );
});

test('a RETIRED-oracle sweep still runs exactly seven signals — feed-identity has nothing to watch there', async () => {
  const results = await collectSignals({
    reader: mockReader({ contracts: healthyFixture(), nowSec: NOW }),
    state: healthyState(), vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  assert.ok(!results.some((r) => r.signal === 'feed-identity'), 'no Chainlink proxy exists to drift');
});

test('a mis-scaled feed pages from feed-identity while every other signal reads healthy', async () => {
  // The whole point of the signal: the vault is NOT frozen. priceWad answers, so oracle-freshness
  // is OK, and nav-backing recomputes through that same priceWad so its two sides still agree.
  const results = await collectSignals({
    reader: mockReader({ contracts: pivotedFixture({ feedDecimals: 6 }), nowSec: NOW }),
    state: healthyState(), vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  const alerts = results.filter((r) => r.status === 'alert');
  assert.equal(alerts.length, 1, 'exactly one page for one root cause');
  assert.equal(alerts[0].signal, 'feed-identity');
  assert.match(alerts[0].message, /FEED DECIMALS DRIFT/);
  assert.equal(results.find((r) => r.signal === 'oracle-freshness' && r.key === ASSET).status, 'ok');
  assert.equal(results.find((r) => r.signal === 'nav-backing').status, 'ok');
});

test('the aggregator pin survives a restart through the canary state file, so a swap pages once and only once', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const canaryStatePath = join(dir, 'canary-state.json');
    const mkCfg = () => resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: canaryStatePath, OPERATOR_REGISTRY_ADDRESS: REGISTRY,
    });
    const wire = async (contracts, out, err) => {
      const canary = await buildCanary(mkCfg(), { log: (m) => out.push(m), error: (m) => err.push(m), client: {} });
      canary.reader.headBlock = async () => 1000;
      canary.reader.chainNow = async () => NOW;
      const mock = mockReader({ contracts, nowSec: NOW });
      Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });
      return canary;
    };

    const out = [], err = [];
    const first = await wire(pivotedFixture(), out, err);
    assert.deepEqual((await first.runOnce()).transitions, [], 'first sight pins silently');
    await first.stop();
    const pinned = JSON.parse(await readFile(canaryStatePath, 'utf8')).feedIdentity;
    assert.equal(Object.keys(pinned).length, 1);
    assert.equal(pinned[`feed-identity|${VAULT}|${ASSET}`].aggregator, AGGREGATOR);

    // A fresh process against a SWAPPED aggregator — the pin has to come off disk, or the swap is
    // invisible and every restart silently re-pins to whatever is live.
    const swapped = pivotedFixture({ feedAggregator: AGGREGATOR_2, feedPhaseId: 5 });
    const second = await wire(swapped, out, err);
    const t = (await second.runOnce()).transitions;
    assert.equal(t.length, 1);
    assert.match(t[0].line, /AGGREGATOR SWAPPED/);
    // Same process, same fixture: the re-pin clears it rather than parking a permanent not-OK row.
    assert.equal((await second.runOnce()).transitions[0].to, 'ok');
    assert.deepEqual((await second.runOnce()).transitions, []);
    await second.stop();
    assert.equal(
      JSON.parse(await readFile(canaryStatePath, 'utf8')).feedIdentity[`feed-identity|${VAULT}|${ASSET}`].phaseId,
      '5',
    );
  });
});

test('a canary state file written BEFORE feedIdentity existed loads and re-pins, rather than throwing', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const canaryStatePath = join(dir, 'canary-state.json');
    await writeFile(canaryStatePath, JSON.stringify({ transitions: {}, lastScannedBlock: 990 }), 'utf8');
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: canaryStatePath, OPERATOR_REGISTRY_ADDRESS: REGISTRY,
    });
    const canary = await buildCanary(cfg, { log: () => {}, error: () => {}, client: {} });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;
    const mock = mockReader({ contracts: pivotedFixture(), nowSec: NOW });
    Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });

    assert.deepEqual((await canary.runOnce()).transitions, []);
    const flushed = await canary.flush();
    assert.equal(flushed.feedsPinned, 1);
  });
});

// ── alert-delivery self-test (security-ops.md §5.3) ──────────────────────────
//
// "A webhook that 500s is logged and skipped, by design. Something must test the alert path
// end-to-end on a schedule, or the first real page is also the first test." testAlert() fires one
// synthetic PAGE and one synthetic LOG transition through the SAME sinks a real sweep would use.

test('testAlert() emits exactly one PAGE-tier and one LOG-tier line through the real sinks', async () => {
  await withTempDir(async (dir) => {
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', CANARY_STATE_PATH: join(dir, 'canary-state.json'),
      PAGE_WEBHOOK_URL: 'https://example.invalid/page', LOG_WEBHOOK_URL: 'https://example.invalid/log',
    });
    const out = [], err = [], hooked = [];
    const canary = await buildCanary(cfg, {
      log: (m) => out.push(m), error: (m) => err.push(m), client: {},
      fetchImpl: async (url) => { hooked.push(url); return { ok: true, status: 200 }; },
    });

    const synthetic = await canary.testAlert();

    assert.equal(synthetic.length, 2);
    assert.equal(synthetic[0].to, 'alert');
    assert.equal(synthetic[1].to, 'skipped');
    // Both lines are non-'ok', so the console sink puts both on stderr — same split a real ALERT
    // and a real DEGRADED line would use.
    assert.equal(err.length, 2);
    assert.equal(out.length, 0);
    assert.match(err[0], /self-test \(PAGE tier\)/);
    assert.match(err[1], /self-test \(LOG tier\)/);
    assert.deepEqual(hooked, ['https://example.invalid/page', 'https://example.invalid/log'], 'each synthetic transition reached its own tier\'s URL');
  });
});

test('testAlert() never touches the transition tracker or canary-state.json', async () => {
  await withTempDir(async (dir) => {
    const canaryStatePath = join(dir, 'canary-state.json');
    const cfg = resolveCanaryConfig({ RPC_URL: 'http://localhost:8545', CANARY_STATE_PATH: canaryStatePath });
    const canary = await buildCanary(cfg, { log: () => {}, error: () => {}, client: {} });

    const sizeBefore = canary.tracker.size;
    await canary.testAlert();
    assert.equal(canary.tracker.size, sizeBefore, 'a self-test must never plant state that could suppress a real future transition');

    await canary.flush();
    const persisted = JSON.parse(await readFile(canaryStatePath, 'utf8'));
    assert.deepEqual(persisted.transitions, {}, 'the self-test left nothing behind to persist');
  });
});

test('testAlert() reaches the ALERT_WEBHOOK_URL fallback exactly once per synthetic transition, matching real-sweep back-compat', async () => {
  await withTempDir(async (dir) => {
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', CANARY_STATE_PATH: join(dir, 'canary-state.json'),
      ALERT_WEBHOOK_URL: 'https://example.invalid/only',
    });
    const hooked = [];
    const canary = await buildCanary(cfg, {
      log: () => {}, error: () => {}, client: {},
      fetchImpl: async (url) => { hooked.push(url); return { ok: true, status: 200 }; },
    });
    await canary.testAlert();
    assert.deepEqual(hooked, ['https://example.invalid/only', 'https://example.invalid/only']);
  });
});

test('CANARY_TEST_ALERT_ON_START fires the self-test once, before the sweep loop begins', async () => {
  await withTempDir(async (dir) => {
    const statePath = await seedSnapshot(dir);
    const cfg = resolveCanaryConfig({
      RPC_URL: 'http://localhost:8545', STATE_PATH: statePath,
      CANARY_STATE_PATH: join(dir, 'canary-state.json'), OPERATOR_REGISTRY_ADDRESS: REGISTRY,
      CANARY_TEST_ALERT_ON_START: '1', CANARY_POLL_INTERVAL_MS: '20',
    });
    const out = [], err = [];
    const canary = await buildCanary(cfg, { log: (m) => out.push(m), error: (m) => err.push(m), client: {} });
    canary.reader.headBlock = async () => 1000;
    canary.reader.chainNow = async () => NOW;
    const mock = mockReader({ contracts: healthyFixture(), nowSec: NOW });
    Object.assign(canary.reader, { read: mock.read, tryRead: mock.tryRead, getLogs: mock.getLogs, staticCall: mock.staticCall });

    const running = canary.start();
    await new Promise((r) => setTimeout(r, 10));
    await canary.stop();
    await running;

    assert.ok(err.some((m) => /self-test \(PAGE tier\)/.test(m)), 'the self-test line appears even though the underlying deployment is healthy');
    const trackedIds = Object.keys(canary.tracker.snapshot());
    assert.ok(
      trackedIds.every((id) => !id.startsWith('self-test')),
      'the self-test must never be recorded as a real signal transition, even once the real sweep loop has also run',
    );
  });
});

// ── governance watch (signal h) is wired into the sweep ──────────────────────

test('an open proposal pages exactly once from governance-watch while every other signal reads healthy', async () => {
  const contracts = healthyFixture({
    [GOVERNANCE]: {
      activeProposalOf: () => 1n,
      configOf: () => GOV_CONFIG,
      proposals: () => proposalTuple({ createdAt: NOW - 60, commitDeadline: NOW + 3540, revealDeadline: NOW + 7140, status: 1 }),
    },
  });
  const results = await collectSignals({
    reader: mockReader({ contracts, nowSec: NOW }), state: healthyState(),
    vaults: [VAULT], cfg: baseCfg, window: WINDOW,
  });
  const alerts = results.filter((r) => r.status === 'alert');
  assert.equal(alerts.length, 1, alerts.map((r) => r.message).join('; '));
  assert.equal(alerts[0].signal, 'governance-watch');
  assert.equal(alerts[0].key, 'commit');
  assert.equal(alerts[0].detail.revealDeadline, NOW + 7140);
  assert.equal(alerts[0].detail.earliestExecuteAt, NOW + 7140 + GOV_CONFIG[2]);
  // The sweep found Governance through the vault itself — no config carries its address.
  assert.equal(alerts[0].detail.governance, GOVERNANCE);
  assert.equal(baseCfg.governance, undefined);
});
