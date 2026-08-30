// @ts-check
/**
 * Signal (a), LIVE FLAVOR — oracle health against `ChainlinkOracle`.
 *
 * These tests are the executable statement of what freezes a post-C-6 vault. Each one perturbs
 * exactly one branch of `ChainlinkOracle.priceWad` and asserts the canary says so, so the file
 * doubles as the readable spec of the five freeze causes.
 *
 * The regression they exist to prevent is the one that shipped: the old signal called `assetConfig`
 * on an oracle that has no such function, reported DEGRADED once at startup, and then — being
 * transition-based — said nothing for the rest of the deployment's life while the flagship freeze
 * detector was dead. Two of the assertions below are aimed squarely at that: the flavor probe picks
 * the right implementation, and a detector that cannot reach its target says so LOUDLY and keeps
 * saying it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOracleSignals } from '../src/signals/oracle-health.mjs';
import { createTransitionTracker } from '../src/transitions.mjs';
import {
  mockReader, healthyVault, chainlinkVault,
  VAULT, ORACLE, ASSET, USDC, FEED, SEQ_FEED, ZERO_ADDR, SRC1, SRC2, SRC3,
} from './helpers.mjs';

const NOW = 1_700_000_000;

const readerFor = (opts = {}) => mockReader({ contracts: chainlinkVault({ nowSec: NOW, ...opts }), nowSec: NOW });

/** Run the flavor-dispatching entrypoint, exactly as the runner does. */
const run = (reader, extra = {}) => checkOracleSignals({
  reader, vault: VAULT, oracle: ORACLE, assets: [ASSET], nowSec: NOW, ...extra,
});

/** The per-asset result; the sequencer leg is keyed separately. */
const forAsset = (results, asset = ASSET) => results.find((r) => r.key === asset);
const forSequencer = (results) => results.find((r) => r.key === 'sequencer');

// ── flavor dispatch ──────────────────────────────────────────────────────────

test('a ChainlinkOracle deployment is routed to the live check, not the retired quorum math', async () => {
  const results = await run(readerFor());
  const r = forAsset(results);
  assert.equal(r.status, 'ok');
  assert.equal(r.signal, 'oracle-freshness', 'one detector identity across both oracle flavors');
  assert.equal(r.detail.margin, undefined, 'there is no quorum margin on a single-feed oracle');
  assert.equal(r.detail.heartbeatSec, 3600);
  assert.equal(r.detail.feed.toLowerCase(), FEED.toLowerCase());
});

test('a retired-aggregator deployment still routes to the quorum check — no pre-pivot deployment is orphaned', async () => {
  // healthyVault()'s oracle exposes assetConfig and no ChainlinkOracle surface at all.
  const reader = mockReader({ contracts: healthyVault(), nowSec: 1_700_000_000 });
  const [r] = await checkOracleSignals({
    reader, vault: VAULT, oracle: ORACLE, assets: [ASSET], nowSec: 1_700_000_000,
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.quorum, 2, 'the legacy path ran, margin math and all');
  assert.equal(r.detail.margin, 1);
});

test('an oracle answering NEITHER ABI is reported as a BROKEN DETECTOR, never as healthy', async () => {
  // The exact post-pivot shape: an oracle the canary cannot introspect at all.
  const reader = mockReader({
    contracts: { ...healthyVault(), [ORACLE.toLowerCase()]: { priceWad: () => 3_000000000000000000n } },
    nowSec: NOW,
  });
  const [r] = await run(reader);
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true, 'this is the flag the tracker escalates on');
  assert.match(r.message, /ORACLE DETECTOR BLIND/);
  assert.match(r.message, /UNMONITORED for the staleness freeze, not healthy/);
});

test('no basket assets means no oracle results at all, rather than a fabricated OK', async () => {
  assert.deepEqual(await checkOracleSignals({
    reader: readerFor(), vault: VAULT, oracle: ORACLE, assets: [], nowSec: NOW,
  }), []);
});

// ── the heartbeat: the freeze trigger ────────────────────────────────────────

test('a FRESH feed reads healthy — priceWad answers and the age is inside the heartbeat', async () => {
  const results = await run(readerFor({ ageSec: 10, heartbeat: 3600 }));
  assert.deepEqual(results.filter((r) => r.status === 'alert'), []);
  const r = forAsset(results);
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.ageSec, 10);
  assert.equal(r.detail.priceWadReverts, false);
  assert.equal(r.detail.priceWad, '3000000000000000000');
});

test('a STALE feed ALERTS and names the heartbeat it aged past', async () => {
  const r = forAsset(await run(readerFor({ ageSec: 7200, heartbeat: 3600, priceWadReverts: true })));
  assert.equal(r.status, 'alert');
  assert.match(r.message, /ORACLE FROZEN/);
  assert.match(r.message, /last updated 7200s ago, past its 3600s heartbeat/);
  assert.match(r.message, /EXITS are all frozen/);
  assert.equal(r.detail.staleBySec, 3600);
  assert.equal(r.detail.attributionGap, false);
});

test('the heartbeat boundary matches the contract: age EXACTLY the heartbeat is still fresh', async () => {
  // ChainlinkOracle reverts on `updatedAt < now - heartbeat`, i.e. only once age EXCEEDS it.
  // Alerting at age == heartbeat would page one sweep early on every heartbeat-cadence feed.
  const r = forAsset(await run(readerFor({ ageSec: 3600, heartbeat: 3600 })));
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.ageSec, 3600);
});

test('staleness is measured against CHAIN time, not the monitoring host clock', async () => {
  // Same fixture, chain far ahead: every stamp is now beyond the heartbeat.
  const results = await checkOracleSignals({
    reader: readerFor({ ageSec: 10, heartbeat: 3600, priceWadReverts: true }),
    vault: VAULT, oracle: ORACLE, assets: [ASSET], nowSec: NOW + 100_000,
  });
  const r = forAsset(results);
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.ageSec, 100_010);
  assert.match(r.message, /past its 3600s heartbeat/);
});

test('the early-warning bar is OFF by default, and alerts once enabled', async () => {
  const opts = { ageSec: 3400, heartbeat: 3600 };
  assert.equal(forAsset(await run(readerFor(opts))).status, 'ok', 'default must not page on a healthy feed');

  const warned = forAsset(await run(readerFor(opts), { stalenessWarnPct: 90 }));
  assert.equal(warned.status, 'alert');
  assert.match(warned.message, /AGEING/);
  assert.match(warned.message, /still priceable/);
  assert.equal(warned.detail.warnAtSec, 3240);
});

// ── the other four freeze causes ─────────────────────────────────────────────

test('a price outside the configured SANE-PRICE BAND alerts, and the band gates on max alone', async () => {
  const r = forAsset(await run(readerFor({
    minPriceWad: 1_000000000000000000n, maxPriceWad: 2_000000000000000000n, priceWadReverts: true,
  })));
  assert.equal(r.status, 'alert');
  assert.match(r.message, /outside the configured sane-price band/);
  assert.equal(r.detail.inBand, false);
  assert.equal(r.detail.derivedPriceWad, '3000000000000000000');
});

test('a band with maxPriceWad 0 is DISABLED, exactly as the contract reads it', async () => {
  // A zero floor with a zero ceiling is the contract's only "disabled" spelling; treating a zero
  // MIN as the disable switch would make every banded asset look unbanded.
  const r = forAsset(await run(readerFor({ minPriceWad: 0n, maxPriceWad: 0n })));
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.bandEnabled, false);
  assert.equal(r.detail.inBand, undefined, 'no band, no verdict about being inside one');
});

test('an UNLISTED basket asset alerts — feedOf returns address(0) and priceWad reverts', async () => {
  const OTHER = `0x${'ab'.repeat(18)}0003`;
  const results = await checkOracleSignals({
    reader: readerFor(), vault: VAULT, oracle: ORACLE, assets: [OTHER], nowSec: NOW,
  });
  const r = forAsset(results, OTHER);
  assert.equal(r.status, 'alert');
  assert.match(r.message, /not listed on this oracle/);
  assert.equal(r.detail.listed, false);
});

test('a DEAD or deprecated feed alerts — the single-provider failure with no fallback', async () => {
  const r = forAsset(await run(readerFor({ feedReverts: true, priceWadReverts: true })));
  assert.equal(r.status, 'alert');
  assert.match(r.message, /Chainlink feed reverts/);
  assert.match(r.message, /fails closed with no fallback/);
  assert.equal(r.detail.feedReverts, true);
});

test('a NON-POSITIVE answer alerts before anything is derived from it', async () => {
  const r = forAsset(await run(readerFor({ answer: 0n, priceWadReverts: true })));
  assert.equal(r.status, 'alert');
  assert.match(r.message, /non-positive/);
});

// ── priceWad is ground truth ─────────────────────────────────────────────────

test('a priceWad REVERT alerts rather than throwing — the runner keeps sweeping', async () => {
  // The whole point of fail-closed: the revert IS the incident, so it must never escape as an
  // exception that costs the operator every other signal on the vault.
  const results = await run(readerFor({ ageSec: 7200, heartbeat: 3600, priceWadReverts: true }));
  const r = forAsset(results);
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.priceWadReverts, true);
  assert.equal(r.detail.revertData, '0xa2671f4b');
  assert.match(r.message, /reverts StaleOracle/);
});

test('a freeze the detector cannot attribute is still PAGED, with the gap named — never swallowed', async () => {
  // priceWad reverts while every field the detector knows about reads healthy. That means this
  // file's model of the oracle is incomplete; it must not become a reason to report health.
  const r = forAsset(await run(readerFor({ ageSec: 10, priceWadReverts: true })));
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.attributionGap, true);
  assert.equal(r.detail.detectorBroken, undefined, 'the freeze is detected; only the explanation is missing');
  assert.match(r.message, /NONE of the causes this detector knows about/);
  assert.match(r.message, /model of the oracle is incomplete/);
});

test('a non-StaleOracle revert is reported with its raw returndata rather than mislabelled', async () => {
  const r = forAsset(await run(readerFor({ priceWadReverts: true, priceWadRevertData: '0xdeadbeef' })));
  assert.equal(r.status, 'alert');
  assert.match(r.message, /reverts with 0xdeadbeef/);
});

test('feedOf reverting on an oracle that claimed to be a ChainlinkOracle is a BROKEN DETECTOR', async () => {
  const r = forAsset(await run(mockReader({
    contracts: chainlinkVault({ nowSec: NOW, overrides: { [ORACLE]: { feedOf: () => ({ revert: '0xdeadbeef' }) } } }),
    nowSec: NOW,
  })));
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true);
  assert.match(r.message, /UNMONITORED for the staleness freeze, not healthy/);
});

// ── the L2 sequencer gate ────────────────────────────────────────────────────

test('the sequencer gate is DEGRADED, not OK, when no uptime feed is configured', async () => {
  // Correct off a sequencer L2 (Base Sepolia leaves it address(0) by design) — but it is a check
  // that cannot run, and on mainnet it would mean the deployment shipped with no guard at all.
  const s = forSequencer(await run(readerFor()));
  assert.equal(s.status, 'skipped');
  assert.equal(s.detail.configured, false);
  assert.equal(s.detail.detectorBroken, undefined, 'a known-state skip must not escalate as a broken detector');
  assert.match(s.message, /no sequencer guard/);
});

test('a DOWN sequencer alerts vault-wide, and says pricing resumes AFTER the restart, not at it', async () => {
  const s = forSequencer(await run(readerFor({ sequencerUptimeFeed: SEQ_FEED, sequencerAnswer: 1n })));
  assert.equal(s.status, 'alert');
  assert.match(s.message, /BASE SEQUENCER DOWN/);
  assert.match(s.message, /3600s AFTER the sequencer restarts, not at the restart itself/);
  assert.equal(s.detail.answer, '1');
});

test('the GRACE TAIL alerts and publishes the exact resume timestamp — the one honest ETA we have', async () => {
  const s = forSequencer(await run(readerFor({
    sequencerUptimeFeed: SEQ_FEED, sequencerAnswer: 0n, sequencerUpForSec: 600,
  })));
  assert.equal(s.status, 'alert');
  assert.match(s.message, /SEQUENCER GRACE PERIOD/);
  // Contract: reverts while now - startedAt <= 3600, so the first second that prices is +3601.
  assert.equal(s.detail.resumesAtSec, NOW - 600 + 3601);
  assert.equal(s.detail.resumesInSec, 3001);
});

test('the grace boundary matches the contract: still frozen AT 3600s, healthy at 3601s', async () => {
  const at = async (upFor) => forSequencer(await run(readerFor({
    sequencerUptimeFeed: SEQ_FEED, sequencerUpForSec: upFor,
  })));
  assert.equal((await at(3600)).status, 'alert', 'the contract reverts while up-for <= GRACE_PERIOD');
  assert.equal((await at(3601)).status, 'ok');
});

test('the sequencer gate reads answer + startedAt and IGNORES updatedAt', async () => {
  // The uptime feed is event-driven: it writes only on an up<->down transition, so a healthy feed's
  // updatedAt can be arbitrarily old. The fixture pins updatedAt to 1 — a detector that
  // staleness-checked it would report a permanent outage on a perfectly healthy chain.
  const s = forSequencer(await run(readerFor({ sequencerUptimeFeed: SEQ_FEED, sequencerUpForSec: 90_000 })));
  assert.equal(s.status, 'ok');
  assert.equal(s.detail.upForSec, 90_000);
});

test('an uptime feed that REVERTS alerts — the contract catches it and freezes every asset', async () => {
  const s = forSequencer(await run(readerFor({ sequencerUptimeFeed: SEQ_FEED, sequencerReverts: true })));
  assert.equal(s.status, 'alert');
  assert.match(s.message, /SEQUENCER UPTIME FEED UNREADABLE/);
  assert.match(s.message, /frozen vault-wide/);
});

test('a sequencer outage ATTRIBUTES the per-asset freeze instead of leaving it unexplained', async () => {
  const results = await run(readerFor({
    sequencerUptimeFeed: SEQ_FEED, sequencerAnswer: 1n, priceWadReverts: true,
  }));
  const r = forAsset(results);
  assert.equal(r.status, 'alert');
  assert.match(r.message, /the L2 sequencer is reporting DOWN/);
  assert.equal(r.detail.attributionGap, false);
});

test('the GRACE_PERIOD used is the deployment’s own constant, not a hardcoded 3600', async () => {
  const s = forSequencer(await run(readerFor({
    sequencerUptimeFeed: SEQ_FEED, sequencerUpForSec: 4000, gracePeriod: 7200n,
  })));
  assert.equal(s.status, 'alert');
  assert.equal(s.detail.gracePeriodSec, 7200);
});

// ── shape ────────────────────────────────────────────────────────────────────

test('the pinned USDC leg reads healthy and is never reported stale', async () => {
  const results = await checkOracleSignals({
    reader: mockReader({ contracts: chainlinkVault({ nowSec: NOW, usdcPin: USDC }), nowSec: NOW }),
    vault: VAULT, oracle: ORACLE, assets: [USDC], nowSec: NOW,
  });
  const r = forAsset(results, USDC);
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.pinned, true);
  assert.match(r.message, /can never go stale/);
});

test('fans out one result per asset, plus its own key for the sequencer', async () => {
  const OTHER = `0x${'cd'.repeat(18)}0004`;
  const results = await checkOracleSignals({
    reader: mockReader({
      contracts: chainlinkVault({ nowSec: NOW, sequencerUptimeFeed: SEQ_FEED }),
      nowSec: NOW,
    }),
    vault: VAULT, oracle: ORACLE, assets: [ASSET, OTHER], nowSec: NOW,
  });
  assert.deepEqual(results.map((r) => r.key), ['sequencer', ASSET, OTHER]);
  assert.equal(new Set(results.map((r) => r.id)).size, 3, 'distinct transition keys');
  assert.equal(forAsset(results, ASSET).status, 'ok');
  assert.equal(forAsset(results, OTHER).status, 'alert', 'the unlisted asset freezes on its own');
});

// ── the property this whole change exists for ────────────────────────────────

test('a BROKEN DETECTOR keeps re-asserting instead of going silent after one line', async () => {
  const reader = mockReader({
    contracts: { ...healthyVault(), [ORACLE.toLowerCase()]: { priceWad: () => 3_000000000000000000n } },
    nowSec: NOW,
  });
  const tracker = createTransitionTracker();
  const lines = [];
  for (let poll = 1; poll <= 9; poll += 1) {
    for (const t of tracker.observe(await run(reader), { poll })) lines.push({ poll, line: t.line, repeat: t.repeat ?? 0 });
  }
  // Sweeps 1, 2, 4 and 8 — a doubling backoff, not one line and then silence.
  assert.deepEqual(lines.map((l) => l.poll), [1, 2, 4, 8]);
  assert.match(lines[0].line, /DETECTOR BROKEN \[oracle-freshness\]/);
  assert.match(lines[3].line, /still blind after 8 consecutive sweeps/);
  // Contrast: the pre-fix behaviour emitted exactly one line, at poll 1, forever.
  assert.ok(lines.length > 1, 'a dead detector must be loud, not silent');
});

test('a HEALTHY oracle stays completely silent across many sweeps — escalation costs nothing', async () => {
  const reader = readerFor({ sequencerUptimeFeed: SEQ_FEED });
  const tracker = createTransitionTracker();
  for (let poll = 1; poll <= 20; poll += 1) {
    assert.deepEqual(tracker.observe(await run(reader), { poll }), [], `poll ${poll} broke the silence`);
  }
});

test('a legacy quorum oracle is NOT mistaken for a broken detector', async () => {
  // Regression guard on the probe order: the retired aggregator has no ChainlinkOracle surface at
  // all, and misreading that absence as "blind" would page every sweep on a working deployment.
  const reader = mockReader({ contracts: healthyVault(), nowSec: 1_700_000_000 });
  const [r] = await checkOracleSignals({
    reader, vault: VAULT, oracle: ORACLE, assets: [ASSET], nowSec: 1_700_000_000,
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail?.detectorBroken, undefined);
  assert.ok([SRC1, SRC2, SRC3].length === 3);
});
