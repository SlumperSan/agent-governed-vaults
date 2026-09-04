// @ts-check
/**
 * Signal (g) — FEED IDENTITY, the on-chain half of G2 (OPS-3, aggregator-swap drift).
 *
 * These tests are the executable statement of the one thing `ChainlinkOracle` proves at
 * construction and can never re-prove: that the feed behind each asset still reports the decimals
 * the immutable `scale` was cached from, and still quotes in USD. Every case perturbs exactly one
 * of those and asserts the canary says so.
 *
 * Two of them are load-bearing as a PAIR and are written adjacent, in order, under
 * "the severity calibration": a benign aggregator swap alerts once and clears itself, and a swap
 * that ALSO moves decimals alerts and stays alerting. The self-clear is only safe because it is
 * gated on the harm legs passing, and a future retune that breaks that gate must fail here rather
 * than quietly turning a mis-scale into a one-line notice.
 *
 * All mocked. No live RPC anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFeedIdentity, applyIdentityObservations, scaleForDecimals, isUsdQuoted, UNREADABLE_SWEEPS,
} from '../src/signals/feed-identity.mjs';
import { createTransitionTracker } from '../src/transitions.mjs';
import { createTieredWebhookSink, emitAll, tierOf } from '../src/sinks.mjs';
import {
  mockReader, healthyVault, chainlinkVault,
  VAULT, ORACLE, ASSET, FEED, AGGREGATOR, AGGREGATOR_2, ZERO_ADDR,
} from './helpers.mjs';

const NOW = 1_700_000_000;

const readerFor = (opts = {}) => mockReader({ contracts: chainlinkVault({ nowSec: NOW, ...opts }), nowSec: NOW });
const run = (reader, pins = {}) => checkFeedIdentity({ reader, vault: VAULT, oracle: ORACLE, assets: [ASSET], pins });
const one = async (opts = {}, pins = {}) => (await run(readerFor(opts), pins))[0];
/**
 * The SECOND result for an asset: the aggregator-swap notice, tracked under its own transition key
 * (`<asset>:swap`) so it can never mask a latching harm finding and can never be masked by one.
 * Every path returns both, so neither tracked id can go stale.
 */
const swapOne = async (opts = {}, pins = {}) => (await run(readerFor(opts), pins))[1];

/** The pin a healthy first sweep leaves behind. */
const PINNED = { [`feed-identity|${VAULT}|${ASSET}`]: { feed: FEED, aggregator: AGGREGATOR, phaseId: '4' } };

// ── pure helpers: the two predicates the contract owns, mirrored ──────────────

test('scaleForDecimals mirrors the cached scale formula, and refuses what could never be cached', () => {
  assert.equal(scaleForDecimals(8), 10_000_000_000n, '8 decimals is the Chainlink USD convention');
  assert.equal(scaleForDecimals(18), 1n);
  assert.equal(scaleForDecimals(0), 1_000000000000000000n);
  // ChainlinkOracle computes 10**(18 - d) in a uint8 subtraction, so d > 18 reverts at
  // construction and can never be the cached value. In JS the same expression is a RangeError, so
  // this MUST be null rather than a throw — see the alert path test below.
  assert.equal(scaleForDecimals(19), null);
  assert.equal(scaleForDecimals(20), null);
  assert.equal(scaleForDecimals(-1), null);
  assert.equal(scaleForDecimals(8.5), null);
  assert.equal(scaleForDecimals('eight'), null);
});

test('isUsdQuoted is ChainlinkOracle._requireUsdQuote, separator rule included', () => {
  assert.equal(isUsdQuoted('ETH / USD'), true);
  assert.equal(isUsdQuoted('BTC/USD'), true);
  assert.equal(isUsdQuoted('CBETH / ETH'), false);
  // The separator requirement is the whole point: a USD-ISH TOKEN is not USD.
  assert.equal(isUsdQuoted('ETH / PYUSD'), false);
  assert.equal(isUsdQuoted('USD'), false);
  assert.equal(isUsdQuoted(null), false);
});

// ── flavor dispatch ──────────────────────────────────────────────────────────

test('a ChainlinkOracle deployment is checked, and a healthy feed pins itself on first sight', async () => {
  const results = await run(readerFor());
  // Two per asset, always: the harm finding and the swap notice, on separate transition keys.
  assert.equal(results.length, 2);
  const [r, swap] = results;
  assert.equal(r.status, 'ok');
  assert.equal(swap.status, 'ok', 'a first sight pins the identity rather than convicting a swap');
  assert.equal(swap.key, `${ASSET}:swap`);
  assert.match(swap.message, /PINNED/);
  assert.equal(r.signal, 'feed-identity', 'its own signal name, not oracle-freshness');
  assert.equal(r.detail.cachedScale, '10000000000');
  assert.equal(r.detail.liveDecimals, 8);
  assert.equal(r.detail.observedIdentity.aggregator, AGGREGATOR);
  assert.equal(r.detail.observedIdentity.phaseId, '4');
  // The pinning narrative belongs to the identity leg, which is now the swap-keyed result.
  assert.match(swap.message, /PINNED for .* on first sight/);
  assert.match(swap.message, /A swap that happened BEFORE this pin is invisible/, 'the residual is stated, not hidden');
  assert.match(r.message, /feed identity unchanged/, 'and the harm finding reports the harm legs only');
});

test('a retired-aggregator deployment produces NOTHING — there is no proxy there to drift', async () => {
  // Not a suppressed skip: the retired OracleAggregator has fixed source addresses in an immutable
  // config, so "feed identity" is not a capability that exists to be blind about.
  const reader = mockReader({ contracts: healthyVault(), nowSec: NOW });
  assert.deepEqual(await run(reader), []);
});

test('an oracle answering NEITHER ABI is a BROKEN DETECTOR here too, not a quiet nothing', async () => {
  // oracle-freshness reports the same vault as blind for the staleness FREEZE. That is a different
  // capability from this one, so this signal says its own piece rather than assuming coverage.
  const reader = mockReader({
    contracts: { ...healthyVault(), [ORACLE.toLowerCase()]: { priceWad: () => 3_000000000000000000n } },
    nowSec: NOW,
  });
  const [r] = await run(reader);
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true);
  assert.equal(r.key, 'flavor');
  assert.match(r.message, /UNMONITORED for aggregator-swap drift, not clean/);
});

test('no basket assets means no results at all, rather than a fabricated clean bill', async () => {
  assert.deepEqual(
    await checkFeedIdentity({ reader: readerFor(), vault: VAULT, oracle: ORACLE, assets: [] }),
    [],
  );
});

test('an asset with no feed listed is a KNOWN skip attributed elsewhere, never a broken detector', async () => {
  // feedOf returns the zero struct for anything that is not ASSET.
  const results = await checkFeedIdentity({
    reader: readerFor(), vault: VAULT, oracle: ORACLE, assets: [`0x${'7'.repeat(40)}`],
  });
  assert.equal(results[0].status, 'skipped');
  assert.equal(results[0].detail.detectorBroken, undefined, 'oracle-freshness is already paging for this');
  assert.equal(results[0].detail.attributedTo, 'oracle-freshness');
});

// ── the harm leg that needs no pin: live decimals vs the oracle's CACHED scale ──

test('the decimals check is LIVE vs CACHED, both read from the chain — no pin, no config', async () => {
  // The comparison that matters is against `feedOf().scale`, which IS the value the contract uses,
  // not against a convention or a config file. Prove the check keys off the cached scale by moving
  // the cached scale and leaving the feed alone.
  const r = await one({ scale: 1_000_000n }); // as if the oracle had been deployed against 12 decimals
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.harm, 'decimals');
  assert.equal(r.detail.cachedScale, '1000000');
  assert.equal(r.detail.liveDecimals, 8);
});

test('an aggregator swapped to FEWER decimals ALERTs, and the line says how wrong the price is', async () => {
  const r = await one({ feedDecimals: 6 }); // correct scale 1e12, cached 1e10 → prices 100x too low
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.harm, 'decimals');
  assert.equal(r.detail.expectedScale, '1000000000000');
  assert.match(r.message, /100x too LOW/);
  assert.match(r.message, /NOT frozen, it is silently WRONG/);
  assert.match(r.message, /nav-backing recomputes through the same priceWad/, 'why nothing else sees it');
});

test('an aggregator swapped to 18 decimals ALERTs — the Chainlink-precedent drift, prices 1e10 too high', async () => {
  const r = await one({ feedDecimals: 18 });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.expectedScale, '1');
  assert.match(r.message, /10000000000x too HIGH/);
});

test('decimals ABOVE 18 is a named ALERT, not a RangeError swallowed into a generic broken detector', async () => {
  // 10n ** BigInt(18 - 20) throws. If it escaped, the runner would convert a real mis-scale into
  // "this signal ERRORED" — a live mispricing reported as a monitoring fault.
  const r = await one({ feedDecimals: 20 });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.harm, 'decimals');
  assert.equal(r.detail.expectedScale, null);
  assert.match(r.message, /no cacheable scale exists/);
});

test('a feed that still reports 8 decimals against a 1e10 cached scale is OK — no false positive', async () => {
  const r = await one({ feedDecimals: 8 });
  assert.equal(r.status, 'ok');
});

// ── the other pin-free harm leg: denomination ────────────────────────────────

test('a feed that stops quoting USD ALERTs — the constructor proved this once and cannot re-prove it', async () => {
  const r = await one({ feedDescription: 'CBETH / ETH' });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.harm, 'denomination');
  assert.match(r.message, /NOT USD-quoted/);
});

test('a USD-ish TOKEN quote does not pass on a bare suffix match', async () => {
  const r = await one({ feedDescription: 'ETH / PYUSD' });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.harm, 'denomination');
});

test('a renamed but still USD-quoted feed is NOT an alert — the predicate is denomination, not identity', async () => {
  const r = await one({ feedDescription: 'Ethereum / USD' });
  assert.equal(r.status, 'ok');
});

test('the harm legs run in the CONSTRUCTOR order: denomination is named before decimals', async () => {
  // ChainlinkOracle runs _requireUsdQuote then reads decimals(). Mirroring the order decides which
  // cause a responder chases when both are true.
  const r = await one({ feedDescription: 'CBETH / ETH', feedDecimals: 6 });
  assert.equal(r.detail.harm, 'denomination');
});

// ── the severity calibration: the two cases that must NOT behave the same ─────
//
// A Chainlink aggregator swap is routine and legitimate; a decimals change is not. The pair below
// is the pinned statement of that difference, and it is a CONJUNCTION: the benign swap only clears
// itself because the harm legs passed on the same sweep.

test('a BENIGN aggregator swap alerts EXACTLY ONCE and then clears itself — routine, not a standing incident', async () => {
  const tracker = createTransitionTracker();
  let pins = {};
  let poll = 0;
  const sweep = async (opts) => {
    const results = await run(readerFor(opts), pins);
    const transitions = tracker.observe(results, { poll: (poll += 1) });
    pins = applyIdentityObservations(pins, results);
    return transitions;
  };

  assert.deepEqual(await sweep({}), [], 'first sight pins silently');
  const swapped = await sweep({ feedAggregator: AGGREGATOR_2, feedPhaseId: 5 });
  assert.equal(swapped.length, 1);
  assert.equal(swapped[0].to, 'alert');
  assert.match(swapped[0].line, /AGGREGATOR SWAPPED/);
  assert.match(swapped[0].line, /LEGITIMATE routine Chainlink operation/);
  assert.match(swapped[0].line, /verify it against Chainlink's announcement/);

  const after = await sweep({ feedAggregator: AGGREGATOR_2, feedPhaseId: 5 });
  assert.equal(after.length, 1);
  assert.equal(after[0].to, 'ok', 'the re-pin clears it: there is no operator action that resolves a swap');
  assert.deepEqual(await sweep({ feedAggregator: AGGREGATOR_2, feedPhaseId: 5 }), [], 'and then it is silent');
});

test('a swap that ALSO moves decimals alerts and STAYS alerting — the self-clear is gated on the harm legs', async () => {
  const tracker = createTransitionTracker();
  let pins = {};
  let poll = 0;
  const sweep = async (opts) => {
    const results = await run(readerFor(opts), pins);
    const transitions = tracker.observe(results, { poll: (poll += 1) });
    pins = applyIdentityObservations(pins, results);
    return transitions;
  };

  assert.deepEqual(await sweep({}), []);
  const bad = { feedAggregator: AGGREGATOR_2, feedPhaseId: 5, feedDecimals: 6 };
  const first = await sweep(bad);
  // BOTH facts are now reported, on their own keys. Before the split they shared one transition id,
  // so the harm alert was the only line and the swap was masked -- and, worse, a harm drift arriving
  // on the sweep AFTER a benign swap was `alert -> alert` and emitted nothing at all.
  assert.equal(first.length, 2, 'the harm finding and the swap notice are separate transitions');
  const harm = first.find((t) => /FEED DECIMALS DRIFT/.test(t.line));
  const swap = first.find((t) => /AGGREGATOR SWAPPED/.test(t.line));
  assert.ok(harm && swap, 'both the harm finding and the swap notice must be emitted');
  assert.equal(harm.key, ASSET, 'the harm finding keeps the bare-asset key');
  assert.equal(swap.key, `${ASSET}:swap`, 'the swap notice is tracked apart from it');
  assert.match(
    swap.line, /not established as harmless/,
    'and it must not claim the swap was harmless while a harm leg alerts on the same sweep',
  );
  assert.equal(harm.to, 'alert');

  // The pin is refreshed exactly as in the benign case, and it must NOT be what silences the HARM.
  const second = await sweep(bad);
  assert.equal(
    second.filter((t) => t.key === ASSET).length, 0,
    'no RECOVERED line for the harm finding: the vault is still mispriced',
  );
  const third = await sweep(bad);
  assert.deepEqual(third.filter((t) => t.key === ASSET), []);
  assert.equal(
    tracker.unhealthy().filter((b) => !b.id.endsWith(':swap')).length, 1,
    'the harm finding stays not-OK until the oracle is replaced',
  );
});

// ── the identity leg on its own ──────────────────────────────────────────────

test('phaseId convicts a swap on its own, even when aggregator() does not answer', async () => {
  const r = await swapOne({ feedPhaseId: 5, feedAggregatorReverts: true }, PINNED);
  assert.equal(r.status, 'alert');
  assert.match(r.message, /phaseId moved 4 -> 5/);
});

test('an unreadable aggregator() alone does NOT convict — an empty return is not evidence of a swap', async () => {
  // PR #92 recorded observing exactly this burst against a live proxy on 2026-08-30. Convicting on
  // it would page on network noise.
  const r = await swapOne({ feedAggregatorReverts: true }, PINNED);
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.identityPartial, true);
});

test('a changed aggregator() convicts when phaseId is unreadable but both addresses are', async () => {
  const r = await swapOne({ feedAggregator: AGGREGATOR_2, feedPhaseIdReverts: true }, PINNED);
  assert.equal(r.status, 'alert');
  assert.match(r.message, /aggregator\(\) moved/);
});

test('a first sighting with no pin is never a swap', async () => {
  const r = await one({ feedAggregator: AGGREGATOR_2, feedPhaseId: 9 }, {});
  assert.equal(r.status, 'ok');
});

// ── a check that cannot run is never silent ──────────────────────────────────

test('an unreadable decimals() is a BROKEN DETECTOR — the harm check could not run', async () => {
  const r = await one({ feedDecimalsReverts: true });
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true);
  assert.equal(r.detail.minConsecutive, UNREADABLE_SWEEPS);
  assert.match(r.message, /UNMONITORED for aggregator-swap drift, not clean/);
});

test('an unreadable description() is a BROKEN DETECTOR for the same reason', async () => {
  const r = await one({ feedDescriptionReverts: true });
  assert.equal(r.detail.detectorBroken, true);
  assert.match(r.message, /description\(\)/);
});

test('an unreadable feedOf() is a BROKEN DETECTOR: the cached scale is the thing being compared against', async () => {
  const reader = mockReader({
    contracts: {
      ...chainlinkVault({ nowSec: NOW }),
      [ORACLE.toLowerCase()]: {
        sequencerUptimeFeed: () => ZERO_ADDR,
        feedOf: () => ({ revert: '0xdeadbeef' }),
      },
    },
    nowSec: NOW,
  });
  const [r] = await run(reader);
  assert.equal(r.detail.detectorBroken, true);
  assert.match(r.message, /feedOf\(\) on .* reverts/);
});

test('a blind IDENTITY leg is still loud, and the line says the harm checks DID run', async () => {
  // The blind identity leg lives on the SWAP key now, so this reads the second result.
  const r = await swapOne({ feedAggregatorReverts: true, feedPhaseIdReverts: true });
  assert.equal(r.detail.detectorBroken, true);
  assert.match(r.message, /answered neither aggregator\(\) nor phaseId\(\)/);
  assert.match(r.message, /denomination and cached-scale checks DID pass this sweep/);
});

test('an established detector is DAMPED against one flaky sweep, but three consecutive escalate', async () => {
  const tracker = createTransitionTracker();
  let poll = 0;
  const sweep = async (opts) => tracker.observe(await run(readerFor(opts)), { poll: (poll += 1) });

  assert.deepEqual(await sweep({}), [], 'healthy: silent');
  assert.deepEqual(await sweep({ feedDecimalsReverts: true }), [], 'one empty return is RPC noise');
  assert.deepEqual(await sweep({ feedDecimalsReverts: true }), []);
  const escalated = await sweep({ feedDecimalsReverts: true });
  assert.equal(escalated.length, 1);
  assert.match(escalated[0].line, /DETECTOR BROKEN/);
  // Recovery is not damped: an ok result carries no minConsecutive, so coverage resumes at once.
  const recovered = await sweep({});
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].to, 'ok');
});

test('a FIRST sighting that cannot be read reports immediately — never observed must not look like silence', async () => {
  // Deliberate, and asymmetric with the damping above: the tracker never applies minConsecutive to
  // an id it has not seen before. A monitor that has never once succeeded must say so on sweep one,
  // even at the cost of a line that clears next sweep.
  const tracker = createTransitionTracker();
  const first = tracker.observe(await run(readerFor({ feedDecimalsReverts: true })), { poll: 1 });
  assert.equal(first.length, 1);
  assert.match(first[0].line, /DETECTOR BROKEN/);
});

// ── the pin store ────────────────────────────────────────────────────────────

test('applyIdentityObservations never writes an absent value over a present one', async () => {
  // Dev12's recorded bug, as a guard: overwriting a real anchor with a null from one empty read
  // would make the NEXT real swap unnarratable.
  const results = await run(readerFor({ feedAggregatorReverts: true }), PINNED);
  const next = applyIdentityObservations(PINNED, results);
  const rec = next[`feed-identity|${VAULT}|${ASSET}`];
  assert.equal(rec.aggregator, AGGREGATOR, 'the pinned aggregator survived an unreadable sweep');
  assert.equal(rec.phaseId, '4');
});

test('a leg that never reached the feed pins nothing, and the input map is not mutated', async () => {
  // feedOf reverting means no feed address was even resolved: there is nothing to remember, and
  // writing a placeholder would be the same class of mistake as overwriting with a null.
  const before = {};
  const reader = mockReader({
    contracts: {
      ...chainlinkVault({ nowSec: NOW }),
      [ORACLE.toLowerCase()]: { sequencerUptimeFeed: () => ZERO_ADDR, feedOf: () => ({ revert: '0xdeadbeef' }) },
    },
    nowSec: NOW,
  });
  assert.deepEqual(applyIdentityObservations(before, await run(reader, before)), {});
  assert.deepEqual(before, {}, 'pure: the caller owns the write');
});

test('an identity read that DID succeed is pinned even when a harm leg was blind', async () => {
  // The legs are independent: `aggregator()`/`phaseId()` answering is a complete, valid observation
  // whether or not `decimals()` answered on the same sweep. Discarding it would mean a swap during
  // a decimals-blind window went untracked — and that window is exactly when one is most likely.
  const results = await run(readerFor({ feedDecimalsReverts: true }), {});
  assert.equal(results[0].detail.detectorBroken, true, 'still loudly blind on the harm leg');
  const rec = applyIdentityObservations({}, results)[`feed-identity|${VAULT}|${ASSET}`];
  assert.equal(rec.aggregator, AGGREGATOR);
});

test('applyIdentityObservations ignores results from every other signal', () => {
  const foreign = [{ id: 'oracle-freshness|v|a', signal: 'oracle-freshness', detail: { observedIdentity: { aggregator: AGGREGATOR } } }];
  assert.deepEqual(applyIdentityObservations({}, foreign), {});
});

// -- the reason the swap notice has its own key, driven end to end -------------
//
// Not a claim about which SET a signal is in, and not a claim about `tierOf` in isolation: this
// drives the real `checkFeedIdentity` through the real tracker into the real tiered sink and asserts
// which URL physically received the POST. The bug it pins was invisible to every test that stopped
// short of dispatch, because the failure was that NOTHING was dispatched at all.

test('case B: a benign swap followed NEXT SWEEP by a decimals drift still PAGES', async () => {
  const tracker = createTransitionTracker({});
  const posted = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://example.invalid/page', logUrl: 'https://example.invalid/log',
    fetchImpl: async (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
  });
  let pins = {}, poll = 0;
  const sweep = async (opts) => {
    const results = await run(readerFor(opts), pins);
    const transitions = tracker.observe(results, { poll: (poll += 1) });
    pins = applyIdentityObservations(pins, results);
    await emitAll([sink], transitions);
    return transitions;
  };

  await sweep({});                                                        // healthy, pins the identity
  await sweep({ feedAggregator: AGGREGATOR_2, feedPhaseId: 5 });          // benign swap: LOG
  posted.length = 0;
  // The very next sweep, with NO intervening OK on the harm key: the aggregator stays where the
  // swap left it (so no second swap is convicted) and decimals now drift. Before the key split this
  // was `alert -> alert` on one shared id and emitted NOTHING -- the drift reached no endpoint and
  // the CONDITIONAL_PAGE predicate was never consulted.
  await sweep({ feedAggregator: AGGREGATOR_2, feedPhaseId: 5, feedDecimals: 6 });

  const paged = posted.filter((x) => x.url === 'https://example.invalid/page');
  assert.equal(paged.length, 1, 'the latching decimals drift must reach the PAGE endpoint');
  assert.equal(paged[0].body.tier, 'page');
  assert.equal(paged[0].body.detail.harm, 'decimals');
  assert.match(paged[0].body.text, /FEED DECIMALS DRIFT/);
});

test('the swap notice self-clears on its own key, so no tracked id is left stranded', async () => {
  const tracker = createTransitionTracker({});
  let pins = {}, poll = 0;
  const sweep = async (opts) => {
    const results = await run(readerFor(opts), pins);
    const t = tracker.observe(results, { poll: (poll += 1) });
    pins = applyIdentityObservations(pins, results);
    return t;
  };
  await sweep({});
  const swapSweep = await sweep({ feedAggregator: AGGREGATOR_2, feedPhaseId: 5 });
  assert.equal(swapSweep.length, 1);
  assert.equal(swapSweep[0].key, `${ASSET}:swap`);
  assert.equal(tierOf(swapSweep[0]), 'log', 'a routine rotation must not wake anyone');

  // `transitions.mjs` never prunes an id that stops being observed, so a key emitted only on some
  // paths would strand its last status forever. Both keys are emitted every sweep, so this clears.
  const after = await sweep({ feedAggregator: AGGREGATOR_2, feedPhaseId: 5 });
  assert.equal(after.length, 1, 'the swap notice self-clears once the pin is re-taken');
  assert.equal(after[0].to, 'ok');
  assert.equal(after[0].key, `${ASSET}:swap`);
  assert.deepEqual(tracker.unhealthy(), [], 'nothing is left standing not-OK');
});
