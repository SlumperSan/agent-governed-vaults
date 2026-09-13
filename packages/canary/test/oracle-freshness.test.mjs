// @ts-check
/**
 * Signal (a) — oracle freshness. Healthy and alerting fixtures for every branch of the margin.
 * The freshness rule is reproduced from OracleAggregator.priceWad, so these tests double as the
 * executable statement of what "within one breaker-trip" means.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOracleFreshness } from '../src/signals/oracle-freshness.mjs';
import { mockReader, healthyVault, VAULT, ORACLE, ASSET, SRC1, SRC2, SRC3 } from './helpers.mjs';

const NOW = 1_700_000_000;
const FRESH = { latestPrice: [3_000000000000000000n, BigInt(NOW - 10)] };
const STALE = { latestPrice: [3_000000000000000000n, BigInt(NOW - 99_999)] };
const ZERO_PRICE = { latestPrice: [0n, BigInt(NOW - 10)] };
const BROKEN = { latestPrice: { revert: '0xdeadbeef' } };

/** 3 sources, quorum 2, 1h staleness — the shape the aggregator's floors enforce. */
function withSources(s1, s2, s3, { quorum = 2, maxStaleness = 3600 } = {}) {
  return mockReader({
    contracts: healthyVault({
      [ORACLE]: { assetConfig: () => [[SRC1, SRC2, SRC3], maxStaleness, quorum] },
      [SRC1]: s1, [SRC2]: s2, [SRC3]: s3,
    }),
    nowSec: NOW,
  });
}

const run = (reader) => checkOracleFreshness({
  reader, vault: VAULT, oracle: ORACLE, assets: [ASSET], nowSec: NOW,
});

test('OK at the protocol MINIMUM source set (3 sources, quorum 2, all fresh)', () => runOk());

// This is the calibration that decides whether the signal is usable. A vault on the protocol
// floor sits at margin 1 when perfectly healthy: it takes TWO failures to trip the breaker, so it
// is not "within 1 breaker-trip". Alerting here would page forever and get the canary muted.
async function runOk() {
  const [r] = await run(withSources(FRESH, FRESH, FRESH));
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.margin, 1);
}

test('an operator who wants the earlier warning can set minMargin=1', async () => {
  const [r] = await checkOracleFreshness({
    reader: withSources(FRESH, FRESH, FRESH), vault: VAULT, oracle: ORACLE,
    assets: [ASSET], nowSec: NOW, minMargin: 1,
  });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.margin, 1);
});

test('OK when the margin clears minMargin — 5 fresh sources at quorum 3', async () => {
  const reader = mockReader({
    contracts: healthyVault({
      [ORACLE]: { assetConfig: () => [[SRC1, SRC2, SRC3, '0x' + 'd'.repeat(40), '0x' + 'e'.repeat(40)], 3600, 3] },
      [SRC1]: FRESH, [SRC2]: FRESH, [SRC3]: FRESH,
      ['0x' + 'd'.repeat(40)]: FRESH, ['0x' + 'e'.repeat(40)]: FRESH,
    }),
    nowSec: NOW,
  });
  const [r] = await run(reader);
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.margin, 2);
  assert.equal(r.detail.freshSources, 5);
});

test('ALERTS at margin 0 — any single source failure now freezes NAV and exits', async () => {
  const [r] = await run(withSources(FRESH, FRESH, STALE));
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.margin, 0);
  assert.match(r.message, /ANY source failure freezes NAV and exits/);
  assert.equal(r.measured, 'margin 0');
});

test('ALERTS with "breaker TRIPPED" when fresh sources fall below quorum', async () => {
  const [r] = await run(withSources(FRESH, STALE, STALE));
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.margin, -1);
  assert.match(r.message, /breaker TRIPPED/);
  assert.match(r.message, /NAV and exits are frozen/);
});

test('a REVERTING source counts as not-fresh, exactly as the aggregator try/catch does', async () => {
  const [r] = await run(withSources(FRESH, FRESH, BROKEN));
  assert.equal(r.detail.freshSources, 2, 'a broken feed is stale, not an error');
  assert.equal(r.status, 'alert'); // margin 0
  assert.deepEqual(r.detail.staleSources.map((s) => s.reason), ['reverted']);
});

test('a zero price counts as not-fresh (the ChainlinkSourceAdapter (0,0) path)', async () => {
  const [r] = await run(withSources(FRESH, FRESH, ZERO_PRICE));
  assert.equal(r.detail.freshSources, 2);
  assert.deepEqual(r.detail.staleSources.map((s) => s.reason), ['zero price']);
});

test('freshness is measured against CHAIN time, not the host clock', async () => {
  const reader = withSources(FRESH, FRESH, FRESH);
  // Same fixture, but the chain is far ahead: every updatedAt is now beyond maxStaleness.
  const [r] = await checkOracleFreshness({
    reader, vault: VAULT, oracle: ORACLE, assets: [ASSET], nowSec: NOW + 100_000,
  });
  assert.equal(r.detail.freshSources, 0);
  assert.match(r.message, /breaker TRIPPED/);
});

test('ALERTS when a basket asset is unlisted on the oracle — priceWad reverts StaleOracle', async () => {
  const reader = mockReader({
    contracts: healthyVault({ [ORACLE]: { assetConfig: () => [[], 0, 0] } }),
    nowSec: NOW,
  });
  const [r] = await run(reader);
  assert.equal(r.status, 'alert');
  assert.match(r.message, /NO sources listed/);
});

test('fans out one result per asset so one stale asset cannot flap the whole vault', async () => {
  const OTHER = '0x' + '9'.repeat(40);
  const reader = mockReader({
    contracts: healthyVault({
      [ORACLE]: {
        // ASSET: 5 sources at quorum 2 (4 fresh => margin 2, healthy).
        // OTHER: 3 sources at quorum 3 (2 fresh => margin -1, breaker tripped).
        assetConfig: (a) => (String(a).toLowerCase() === OTHER
          ? [[SRC1, SRC2, SRC3], 3600, 3]
          : [[SRC1, SRC2, SRC3, '0x' + 'd'.repeat(40), '0x' + 'e'.repeat(40)], 3600, 2]),
      },
      [SRC1]: FRESH, [SRC2]: FRESH, [SRC3]: STALE,
      ['0x' + 'd'.repeat(40)]: FRESH, ['0x' + 'e'.repeat(40)]: FRESH,
    }),
    nowSec: NOW,
  });
  const results = await checkOracleFreshness({
    reader, vault: VAULT, oracle: ORACLE, assets: [ASSET, OTHER], nowSec: NOW,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].key, ASSET);
  assert.equal(results[1].key, OTHER);
  assert.notEqual(results[0].id, results[1].id, 'distinct transition keys per asset');
  assert.equal(results[0].status, 'ok', '4 fresh of 5 at quorum 2 => margin 2, healthy');
  assert.equal(results[1].status, 'alert', '2 fresh of 3 at quorum 3 => margin -1, tripped');
});

test('DEGRADED, not OK, when the oracle config itself is unreadable', async () => {
  const reader = mockReader({
    contracts: healthyVault({ [ORACLE]: { assetConfig: () => ({ revert: '0xdeadbeef' }) } }),
    nowSec: NOW,
  });
  const [r] = await run(reader);
  assert.equal(r.status, 'skipped');
  assert.notEqual(r.status, 'ok');
});

// ── transport is not a verdict ───────────────────────────────────────────────

const UNREACHABLE = { latestPrice: { transport: 'HTTP request failed.' } };

test('a source the canary could not READ is neither fresh nor stale — a 429 must not trip the breaker', async () => {
  // Two unreadable sources against quorum 2 used to count as two STALE sources, walking the margin
  // to -1 and paging "oracle breaker TRIPPED … NAV and exits are frozen" off a rate limit.
  const [r] = await run(withSources(FRESH, UNREACHABLE, UNREACHABLE));
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true, 'blindness must stay visible, not collapse into ok');
  assert.match(r.message, /BLIND/);
  assert.doesNotMatch(r.message, /TRIPPED/);
  assert.equal(r.detail.unreadableSources.length, 2);
  assert.equal(r.detail.staleSources.length, 0, 'unreadable is its own bucket, not a stale source');
});

test('an unreadable source cannot HIDE a freeze either: quorum out of reach in the best case still ALERTS', async () => {
  // quorum 3, one fresh, one unreadable, one genuinely stale: even counting the unreadable one as
  // fresh leaves 2 < 3, so the verdict is sound on the best case and must still be given.
  const [r] = await run(withSources(FRESH, UNREACHABLE, STALE, { quorum: 3 }));
  assert.equal(r.status, 'alert');
  assert.match(r.message, /TRIPPED/);
});

test('a healthy margin is still reported when it holds on the WORST case, unreadable sources and all', async () => {
  // quorum 1, two fresh, one unreadable: the margin is at least 1 whatever the unreadable one is.
  const [r] = await run(withSources(FRESH, FRESH, UNREACHABLE, { quorum: 1 }));
  assert.equal(r.status, 'ok');
});

test('a source that genuinely REVERTS is still counted stale — the fix did not blind the detector', async () => {
  const [r] = await run(withSources(FRESH, BROKEN, BROKEN));
  assert.equal(r.status, 'alert');
  assert.match(r.message, /TRIPPED/);
  assert.equal(r.detail.staleSources.length, 2);
});
