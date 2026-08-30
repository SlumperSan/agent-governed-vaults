// @ts-check
/**
 * Signal (a) — oracle freshness, against the DEPLOYED oracle.
 *
 * The first test is the one that matters most, and it is the test this file did not used to have:
 * pointed at a fixture shaped like the C-6 deployment on Base Sepolia — {ChainlinkOracle}, one
 * Chainlink feed per asset, an 86,400 s heartbeat, USDC pinned, no sequencer uptime feed — the
 * signal is SILENT. The old suite passed while the live signal was blind, because every fixture in
 * it stubbed `assetConfig`, a function the launch tree does not deploy. So the rule these tests now
 * hold is: model the contract that is deployed, and assert the healthy deployment produces nothing.
 *
 * The rest is the failure side: every branch of ChainlinkOracle.priceWad's fail-closed order shows
 * up as a NAMED cause, and the L2 sequencer gate pages once for the whole vault rather than once
 * per asset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOracleFreshness, SEQUENCER_KEY, MODEL_KEY } from '../src/signals/oracle-freshness.mjs';
import { mockReader, healthyVault, VAULT, ORACLE, ASSET, USDC, FEED, SEQ_FEED, ZERO_ADDR } from './helpers.mjs';

const NOW = 1_700_000_000;
const STALE_ORACLE = '0xa2671f4b';
const HEARTBEAT = 86_400;
const PRICE_WAD = 3_000000000000000000n;
const ANSWER = 300_000_000n; // $3.00 at 8 decimals; * scale 1e10 = 3e18 WAD
const BAND = [1_000000000000000000n, 100_000000000000000000n]; // $1 .. $100

/** A Chainlink round tuple: (roundId, answer, startedAt, updatedAt, answeredInRound). */
const round = (answer, updatedAt, startedAt = updatedAt) =>
  ({ latestRoundData: () => [1n, answer, BigInt(startedAt), BigInt(updatedAt), 1n] });

/** The deployed oracle's read surface, with per-test overrides. */
function chainlinkOracle({
  price = () => PRICE_WAD,
  feed = FEED,
  heartbeat = HEARTBEAT,
  band = BAND,
  usdc = USDC,
  sequencer = ZERO_ADDR,
  grace = 3600n,
} = {}) {
  return {
    priceWad: price,
    feedOf: (a) => (String(a).toLowerCase() === ASSET.toLowerCase()
      ? [feed, heartbeat, 10_000_000_000n, band[0], band[1]]
      : [ZERO_ADDR, 0, 0n, 0n, 0n]),
    usdc: () => usdc,
    sequencerUptimeFeed: () => sequencer,
    GRACE_PERIOD: () => grace,
  };
}

/** age-seconds-ago helper: what the feed's updatedAt is, expressed as "n seconds stale". */
const agoSec = (n) => NOW - n;

function readerWith(contracts, { nowSec = NOW } = {}) {
  return mockReader({ contracts: healthyVault(contracts), nowSec });
}

/**
 * Same fixture, but the oracle is REPLACED rather than patched — `healthyVault` merges overrides,
 * so patching cannot express "this oracle does not have those functions at all", which is exactly
 * what a vault pinned to a non-ChainlinkOracle looks like.
 */
function readerWithOracle(contract) {
  return mockReader({ contracts: { ...healthyVault(), [ORACLE]: contract }, nowSec: NOW });
}

const run = (reader, opts = {}) => checkOracleFreshness({
  reader, vault: VAULT, oracle: ORACLE, assets: [ASSET], nowSec: NOW, ...opts,
});

const byKey = (results, key) => results.find((r) => r.key === key);

// ── the regression test for the whole class of bug ───────────────────────────

test('the DEPLOYED oracle shape (ChainlinkOracle, empty sequencer feed) is completely silent', async () => {
  // This fixture is the Base Sepolia deployment: contracts/config/deployments/base-sepolia.json.
  const results = await run(readerWith({}));

  assert.deepEqual(
    results.filter((r) => r.status !== 'ok').map((r) => `${r.key}: ${r.status} ${r.message}`),
    [],
    'every result must be OK against the oracle the launch tree actually deploys',
  );
  assert.equal(results.length, 2, 'one result per basket asset, plus the sequencer gate');
  assert.ok(byKey(results, SEQUENCER_KEY), 'the sequencer gate is watched as its own key');
  assert.equal(byKey(results, MODEL_KEY), undefined, 'the oracle answers the modelled surface');
});

test('an unset sequencer uptime feed is HEALTHY, not degraded — the contract skips that gate', async () => {
  // The trap this replaces the old bug with: reporting address(0) as "cannot check" would give
  // gate 6 a second signal that can never go green, on the deployment that is actually live.
  const [seq] = (await run(readerWith({}))).filter((r) => r.key === SEQUENCER_KEY);
  assert.equal(seq.status, 'ok');
  assert.match(seq.message, /address\(0\)/);
  assert.equal(seq.detail.configured, false);
});

// ── heartbeat headroom: the forward-looking half ─────────────────────────────

test('OK with headroom to spare — 1,000s into an 86,400s heartbeat', async () => {
  const r = byKey(await run(readerWith({})), ASSET);
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.ageSec, 1_000);
  assert.equal(r.detail.headroomSec, 85_400);
  assert.equal(r.detail.headroomBps, 9_884);
});

test('ALERTS when the feed is inside the last 25% of its heartbeat', async () => {
  const reader = readerWith({
    [ORACLE]: chainlinkOracle(),
    [FEED]: round(ANSWER, agoSec(80_000)), // 6,400s left of 86,400 => 740 bps
  });
  const r = byKey(await run(reader), ASSET);
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.headroomSec, 6_400);
  assert.match(r.message, /6400s from its staleness bound/);
  assert.match(r.message, /NAV and exits freeze/);
});

test('the bar is tunable — an operator wanting an earlier warning raises ORACLE_MIN_HEADROOM_BPS', async () => {
  const r = byKey(await run(readerWith({}), { minHeadroomBps: 9_900 }), ASSET);
  assert.equal(r.status, 'alert', '9,884 bps of headroom is now inside the bar');
  assert.equal(r.threshold, `> 99.00% of the ${HEARTBEAT}s heartbeat`);
});

test('headroom is measured against CHAIN time, not the monitoring host clock', async () => {
  const reader = readerWith({});
  const [r] = await checkOracleFreshness({
    reader, vault: VAULT, oracle: ORACLE, assets: [ASSET], nowSec: NOW + 80_000,
  }).then((rs) => rs.filter((x) => x.key === ASSET));
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.ageSec, 81_000);
});

test('the pinned USDC leg is OK and has no heartbeat to run out', async () => {
  const reader = readerWith({ [ORACLE]: chainlinkOracle({ price: () => 1_000000000000000000n }) });
  const r = byKey(await run(reader, { assets: [USDC] }), USDC);
  assert.equal(r.status, 'ok');
  assert.match(r.message, /pinned USDC leg/);
  assert.equal(r.detail.pinned, true);
  assert.equal(r.detail.headroomBps, null);
});

// ── the breaker, and WHY it tripped ──────────────────────────────────────────

test('ALERTS "breaker TRIPPED" and names STALENESS as the cause', async () => {
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ price: () => ({ revert: STALE_ORACLE }) }),
    [FEED]: round(ANSWER, agoSec(90_000)),
  });
  const r = byKey(await run(reader), ASSET);
  assert.equal(r.status, 'alert');
  assert.match(r.message, /breaker TRIPPED/);
  assert.match(r.message, /NAV and exits are frozen/);
  assert.match(r.detail.tripCause, /STALE — last update 90000s ago, past its 86400s heartbeat by 3600s/);
});

test('a tripped breaker on a FRESH feed is attributed to the sane-price band, not to the feed operator', async () => {
  // The distinction is the whole point of classifying: "chase the feed" is the wrong response to a
  // depeg / deprecated-clamp band rejection.
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ price: () => ({ revert: STALE_ORACLE }) }),
    [FEED]: round(50_000_000_000n, agoSec(60)), // $500, above the $100 band ceiling
  });
  const r = byKey(await run(reader), ASSET);
  assert.equal(r.status, 'alert');
  assert.match(r.detail.tripCause, /OUTSIDE the oracle's sane-price band/);
});

test('a non-positive answer is named as such', async () => {
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ price: () => ({ revert: STALE_ORACLE }) }),
    [FEED]: round(0n, agoSec(60)),
  });
  assert.match(byKey(await run(reader), ASSET).detail.tripCause, /non-positive answer/);
});

test('an asset the oracle does not list is named as unlisted, not as a stale feed', async () => {
  const OTHER = `0x${'9'.repeat(40)}`;
  const reader = readerWith({ [ORACLE]: chainlinkOracle({ price: () => ({ revert: STALE_ORACLE }) }) });
  const r = byKey(await run(reader, { assets: [OTHER] }), OTHER);
  assert.equal(r.status, 'alert');
  assert.match(r.detail.tripCause, /NOT LISTED on this oracle/);
});

test('a feed that itself reverts is named, so the operator knows where to look', async () => {
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ price: () => ({ revert: STALE_ORACLE }) }),
    [FEED]: { latestRoundData: () => ({ revert: '0xdeadbeef' }) },
  });
  assert.match(byKey(await run(reader), ASSET).detail.tripCause, /itself reverts/);
});

test('an UNRECOGNIZED priceWad revert still ALERTS — there is no assume-healthy branch', async () => {
  const reader = readerWith({ [ORACLE]: chainlinkOracle({ price: () => ({ revert: '0xdeadbeef' }) }) });
  const r = byKey(await run(reader), ASSET);
  assert.equal(r.status, 'alert');
  assert.notEqual(r.status, 'skipped');
  assert.match(r.message, /UNRECOGNIZED error/);
  assert.equal(r.detail.revertName, null);
});

test('the tripped-breaker `measured` stays short — the cause belongs in the message, not the suffix', async () => {
  // Transition lines append "(measured X, threshold Y)". A sentence-long `measured` would wrap the
  // one-line alert format this package exists to produce.
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ price: () => ({ revert: STALE_ORACLE }) }),
    [FEED]: round(ANSWER, agoSec(90_000)),
  });
  const r = byKey(await run(reader), ASSET);
  assert.equal(r.measured, 'StaleOracle');
  assert.ok(r.measured.length < 40);
  assert.ok(r.detail.tripCause.length > 40, 'the long form is carried in detail instead');
});

// ── the L2 sequencer gate ────────────────────────────────────────────────────

test('a DOWN sequencer pages ONCE for the vault, and the assets defer to it', async () => {
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ sequencer: SEQ_FEED, price: () => ({ revert: STALE_ORACLE }) }),
    [SEQ_FEED]: round(1n, agoSec(10)),
  });
  const results = await run(reader);
  const seq = byKey(results, SEQUENCER_KEY);
  const asset = byKey(results, ASSET);

  assert.equal(seq.status, 'alert');
  assert.match(seq.message, /sequencer is DOWN/);
  assert.equal(results.filter((r) => r.status === 'alert').length, 1, 'one root cause, one page');
  assert.equal(asset.status, 'skipped', 'the asset cannot be measured, and must not read OK either');
  assert.equal(asset.detail.attributedTo, `oracle-freshness|${VAULT}|${SEQUENCER_KEY}`);
});

test('a sequencer inside its grace period ALERTS and says when capital unfreezes', async () => {
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ sequencer: SEQ_FEED, price: () => ({ revert: STALE_ORACLE }) }),
    [SEQ_FEED]: round(0n, agoSec(600), agoSec(600)),
  });
  const seq = byKey(await run(reader), SEQUENCER_KEY);
  assert.equal(seq.status, 'alert');
  assert.match(seq.message, /restarted 600s ago, inside the 3600s grace period/);
  assert.match(seq.message, /another 3000s/);
});

test('GRACE_PERIOD is READ from the oracle, never hardcoded in JS', async () => {
  // A JS copy of a Solidity constant is the drift class that made this signal blind in the first
  // place, so the grace window must come from the deployed contract.
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ sequencer: SEQ_FEED, grace: 7_200n, price: () => ({ revert: STALE_ORACLE }) }),
    [SEQ_FEED]: round(0n, agoSec(5_000), agoSec(5_000)),
  });
  const seq = byKey(await run(reader), SEQUENCER_KEY);
  assert.equal(seq.status, 'alert', '5,000s up is inside a 7,200s grace window');
  assert.equal(seq.detail.gracePeriodSec, 7_200);
});

test('a long-uneventful uptime feed is HEALTHY — its updatedAt is not staleness-checked', async () => {
  // The uptime feed only writes on an up<->down transition, so an ancient timestamp is its healthy
  // steady state. Checking it the way an asset feed is checked would page forever.
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ sequencer: SEQ_FEED }),
    [SEQ_FEED]: round(0n, agoSec(9_000_000), agoSec(9_000_000)),
  });
  const results = await run(reader);
  assert.equal(byKey(results, SEQUENCER_KEY).status, 'ok');
  assert.deepEqual(results.filter((r) => r.status !== 'ok'), []);
});

test('an unreadable uptime feed ALERTS — the contract catches it and freezes every price', async () => {
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ sequencer: SEQ_FEED, price: () => ({ revert: STALE_ORACLE }) }),
    [SEQ_FEED]: { latestRoundData: () => ({ revert: '0xdeadbeef' }) },
  });
  const seq = byKey(await run(reader), SEQUENCER_KEY);
  assert.equal(seq.status, 'alert');
  assert.match(seq.message, /UNREADABLE/);
});

// ── degradation is stated, never silently folded into OK ─────────────────────

test('an oracle that is not a ChainlinkOracle degrades ONCE, and keeps paging for freezes', async () => {
  // A vault pinned to some other IOracleAggregator: the headroom early-warning is unavailable, the
  // freeze alarm is not. The signal says exactly that, once, instead of parking silently.
  const reader = readerWithOracle({ priceWad: () => PRICE_WAD });
  const results = await run(reader);
  const model = byKey(results, MODEL_KEY);

  assert.equal(model.status, 'skipped');
  assert.match(model.message, /CANNOT be measured/);
  assert.equal(byKey(results, ASSET).status, 'ok', 'priceWad answers, so the asset is priced');
  assert.equal(byKey(results, ASSET).detail.headroomBps, null);
  assert.equal(byKey(results, SEQUENCER_KEY), undefined);
});

test('the freeze alarm survives on a non-ChainlinkOracle oracle', async () => {
  const reader = readerWithOracle({ priceWad: () => ({ revert: STALE_ORACLE }) });
  const r = byKey(await run(reader), ASSET);
  assert.equal(r.status, 'alert');
  assert.match(r.message, /breaker TRIPPED/);
});

test('DEGRADED, not OK, when the feed config is unreadable while pricing still works', async () => {
  const reader = readerWithOracle({ ...chainlinkOracle(), feedOf: () => ({ revert: '0xdeadbeef' }) });
  const r = byKey(await run(reader), ASSET);
  assert.equal(r.status, 'skipped');
  assert.match(r.message, /early-warning/);
});

test('DEGRADED when the feed cannot answer latestRoundData but priceWad still prices the asset', async () => {
  const reader = readerWith({ [FEED]: { latestRoundData: () => ({ revert: '0xdeadbeef' }) } });
  const r = byKey(await run(reader), ASSET);
  assert.equal(r.status, 'skipped');
  assert.notEqual(r.status, 'ok');
});

// ── fan-out ──────────────────────────────────────────────────────────────────

test('fans out one result per asset so one stale asset cannot flap the whole vault', async () => {
  const OTHER = `0x${'9'.repeat(40)}`;
  const OTHER_FEED = `0x${'8'.repeat(40)}`;
  const reader = readerWith({
    [ORACLE]: {
      ...chainlinkOracle(),
      feedOf: (a) => (String(a).toLowerCase() === OTHER.toLowerCase()
        ? [OTHER_FEED, HEARTBEAT, 10_000_000_000n, 0n, 0n]
        : [FEED, HEARTBEAT, 10_000_000_000n, BAND[0], BAND[1]]),
    },
    [OTHER_FEED]: round(ANSWER, agoSec(85_000)), // 1,400s left => 162 bps
  });
  const results = await run(reader, { assets: [ASSET, OTHER] });

  assert.equal(results.length, 3, 'two assets plus the sequencer gate');
  assert.equal(byKey(results, ASSET).status, 'ok');
  assert.equal(byKey(results, OTHER).status, 'alert');
  assert.equal(new Set(results.map((r) => r.id)).size, 3, 'distinct transition keys');
});

test('a sequencer that recovers mid-sweep leaves the two results reconcilable', async () => {
  // The sequencer read and the price read are separate eth_calls in one sweep, so an ALERTing
  // sequencer key beside a priced asset is reachable, not a fixture artifact. Both are true as
  // measured; the asset must carry the gate reason so a consumer can pair them.
  const reader = readerWith({
    [ORACLE]: chainlinkOracle({ sequencer: SEQ_FEED }), // priceWad succeeds
    [SEQ_FEED]: round(1n, agoSec(10)),                  // ...while the gate reads DOWN
  });
  const results = await run(reader);
  assert.equal(byKey(results, SEQUENCER_KEY).status, 'alert');
  assert.equal(byKey(results, ASSET).status, 'ok');
  assert.equal(byKey(results, ASSET).detail.gateFailing, 'sequencer-down');
});
