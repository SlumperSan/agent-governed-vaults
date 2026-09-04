// @ts-check
/**
 * Tests for the pure logic behind soak drills 4 and 5.
 *
 * The drill runners execute at import time, so their reducers and guards were extracted into
 * `series-analysis.mjs` and `agent-policy.mjs` precisely so they could be tested here without
 * starting a drill or signing anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readSeries, summarize, findGaps, summarizeFreezeSafety, summarizeSequencer,
  oracleCanaryRows, verdictOf, isAssetSubject, isBreachSample, freezeSafetyReport,
} from '../soak/series-analysis.mjs';
import {
  sequencerState, attributeAsset, classifyCallError, SEL_STALE_ORACLE, SEL_NO_PENDING,
} from '../soak/oracle-sampler.mjs';
import { resolveAgentRunConfig, policyFor, EXECUTE_ENV_VAR } from '../soak/agent-policy.mjs';

// ───────────────────────────── fixtures ─────────────────────────────

/** Real Base Sepolia basket assets, so a "subject is an address" test uses address-shaped data. */
const WETH = '0x4200000000000000000000000000000000000006';
const LINK = '0xE4aB69C077896252FAFBD49EFD26B5D171A32410';

/** For the selector drift guard: viem and the compiled ABIs, both optional in a bare checkout. */
const viem = await import('viem').catch(() => null);
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'contracts', 'out');
const abiOf = (rel) => {
  const p = path.join(OUT, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).abi ?? [] : [];
};
const ORACLE_ABI = abiOf('ChainlinkOracle.sol/ChainlinkOracle.json');
const VAULT_ABI = abiOf('VaultCore.sol/VaultCore.json');

const sample = (t, chainNow, over = {}) => ({
  t, chainNow,
  assets: [{
    symbol: 'WETH', feedUpdatedAt: chainNow - 100, ageSec: 100, maxStalenessSeconds: 86400,
    ageFractionOfBound: 100 / 86400, freshSources: 3, quorum: 2, margin: 1,
    priceWad: '2480000000000000000000', priceReverts: false,
    ...(over.asset ?? {}),
  }],
  freezeSafety: over.freezeSafety ?? [{ vault: '0xv', probed: true, verdict: 'n/a-no-pending' }],
});

const tmpFile = (contents) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-')), 'series.jsonl');
  fs.writeFileSync(p, contents);
  return p;
};

// ───────────────────────────── readSeries ─────────────────────────────

test('readSeries tolerates a torn final line from a sampler killed mid-write', () => {
  const good = JSON.stringify(sample('a', 100));
  const p = tmpFile(`${good}\n${good}\n{"t":"c","chainNow":`);
  const { samples, torn } = readSeries(p);
  assert.equal(samples.length, 2, 'both complete lines must survive');
  assert.equal(torn, 1, 'the torn line must be COUNTED, not silently dropped');
});

test('readSeries refuses a missing file and an unparseable one rather than returning empty', () => {
  assert.throws(() => readSeries(path.join(os.tmpdir(), 'definitely-not-here.jsonl')), /no oracle series/);
  assert.throws(() => readSeries(tmpFile('{{{\n[[[\n')), /no parseable samples/);
});

// ───────────────────────────── summarize ─────────────────────────────

test('summarize tracks the WORST age and the timestamp it happened at', () => {
  const s = summarize([
    sample('t1', 1000, { asset: { ageSec: 100, ageFractionOfBound: 100 / 86400 } }),
    sample('t2', 2000, { asset: { ageSec: 900, ageFractionOfBound: 900 / 86400 } }),
    sample('t3', 3000, { asset: { ageSec: 300, ageFractionOfBound: 300 / 86400 } }),
  ]);
  assert.equal(s.WETH.maxAgeSec, 900);
  assert.equal(s.WETH.worstAt, 't2', 'the worst sample must be attributable to a timestamp');
  assert.equal(s.WETH.minAgeSec, 100);
  assert.equal(s.WETH.samples, 3);
});

test('a breach is counted from EITHER a negative margin or a reverting price', () => {
  // The two are independent observations of the same failure; a disagreement is itself a finding,
  // so neither may be the sole trigger.
  const marginOnly = summarize([sample('t', 1, { asset: { margin: -2, priceReverts: false } })]);
  const revertOnly = summarize([sample('t', 1, { asset: { margin: 1, priceReverts: true } })]);
  assert.equal(marginOnly.WETH.breachSamples, 1, 'negative margin alone is a breach');
  assert.equal(revertOnly.WETH.breachSamples, 1, 'a reverting price alone is a breach');
  assert.equal(revertOnly.WETH.priceRevertSamples, 1);
});

test('a healthy series records zero breaches', () => {
  const s = summarize([sample('t1', 1), sample('t2', 2)]);
  assert.equal(s.WETH.breachSamples, 0);
  assert.equal(s.WETH.minMargin, 1);
});

// ───────────────────────────── findGaps ─────────────────────────────

test('findGaps measures against the series own median, not a configured interval', () => {
  // A sampler restarted with a different interval must not report every sample as a gap.
  const samples = [0, 120, 240, 360, 3000, 3120].map((n, i) => sample(`t${i}`, 1000 + n));
  const { gaps, medianSec } = findGaps(samples, 3);
  assert.equal(medianSec, 120);
  assert.equal(gaps.length, 1, 'exactly one interval exceeds 3x the median');
  assert.equal(gaps[0].gapSec, 2640);
});

test('findGaps returns nothing for an evenly-spaced series or a single sample', () => {
  const even = [0, 120, 240, 360].map((n, i) => sample(`t${i}`, n));
  assert.equal(findGaps(even, 3).gaps.length, 0);
  assert.deepEqual(findGaps([sample('only', 1)], 3), { gaps: [], medianSec: 0 });
});

// ─────────────────────── freeze safety (the important one) ───────────────────────

test('freeze safety is NOT demonstrated when every probe was n/a-no-pending', () => {
  // The whole point: with no pending deposit there is nothing to cancel, so the probe proves
  // nothing. Reporting that as a pass would assert a property nothing exercised.
  const r = summarizeFreezeSafety([sample('t1', 1), sample('t2', 2)]);
  assert.equal(r.oracleBlocked, 0, 'n/a is not a violation');
  assert.equal(r.probedWithPending, 0);
  assert.equal(r.demonstrated, false, 'un-contradicted must not be reported as demonstrated');
  assert.equal(r.verdicts['n/a-no-pending'], 2);
});

test('freeze safety IS demonstrated once a real pending deposit was probed and stayed callable', () => {
  const r = summarizeFreezeSafety([
    sample('t1', 1, { freezeSafety: [{ vault: '0xv', verdict: 'callable' }] }),
    sample('t2', 2, { freezeSafety: [{ vault: '0xv', verdict: 'callable' }] }),
  ]);
  assert.equal(r.probedWithPending, 2);
  assert.equal(r.demonstrated, true);
});

test('any verdict other than callable/ok/n-a counts as a freeze-safety violation', () => {
  const r = summarizeFreezeSafety([
    sample('t1', 1, { freezeSafety: [{ vault: '0xv', verdict: 'callable' }] }),
    sample('t2', 2, { freezeSafety: [{ vault: '0xv', verdict: 'reverted', detail: 'StaleOracle' }] }),
  ]);
  assert.equal(r.oracleBlocked, 1);
  assert.equal(r.demonstrated, false, 'one blocked sample must sink the whole claim');
  assert.equal(r.blockedDetail[0].detail, 'StaleOracle');
});

test('an UNCONFIGURED probe is missing evidence, not a freeze-safety breach', () => {
  // Regression for a live run in which the sampler emitted `freezeSafety: []` for six hours,
  // because run-soak.ps1 set SOAK_PROBE_MEMBER but never SOAK_VAULTS: mapping over an empty vault
  // list produced NO ROWS, so the leg's own absence was invisible and drill 4's refusal to claim
  // freeze safety looked like "no pending deposit existed".
  //
  // The sampler now emits a `not-configured` sentinel instead. It must suppress `demonstrated` —
  // nothing was shown — WITHOUT being counted as a violation: a misconfigured harness reporting a
  // freeze-safety BREACH is the same lie in the opposite direction, and would page someone.
  const r = summarizeFreezeSafety([
    sample('t1', 1, { freezeSafety: [{ vault: null, probed: false, verdict: 'not-configured', reason: 'no vaults to probe (indexer-empty)' }] }),
    sample('t2', 2, { freezeSafety: [{ vault: null, probed: false, verdict: 'not-configured', reason: 'no vaults to probe (indexer-empty)' }] }),
  ]);
  assert.equal(r.oracleBlocked, 0, 'an unconfigured probe must never be reported as a violation');
  assert.equal(r.unmeasured, 2, 'the absence must be counted, not dropped');
  assert.equal(r.probedWithPending, 0);
  assert.equal(r.demonstrated, false, 'nothing was measured, so nothing is demonstrated');
  assert.deepEqual(r.blockedDetail, [], 'nothing to page on');
});

// ── the operator-facing prose (previously untested, and it shipped a falsehood) ──

test('freezeSafetyReport names the ACTUAL unmeasured kind, never a hardcoded one', () => {
  // The first version hardcoded "not-configured/not-probed" while `unreadable` sat in the same
  // bucket, so an all-`unreadable` window printed "the probe did not run" about samples that DID
  // run, and offered a fix (vault discovery) for what was a rate limit.
  const lines = freezeSafetyReport({
    verdicts: { unreadable: 3 }, probedWithPending: 0, oracleBlocked: 0, unmeasured: 3,
  }).join('\n');
  assert.match(lines, /3 sample\(s\) yielded NO MEASUREMENT \(unreadable\)/);
  assert.doesNotMatch(lines, /not-configured|not-probed/, 'names a cause that is not present');
  assert.doesNotMatch(lines, /probe did not run|never probed at all/i, 'the call WAS attempted');
  assert.match(lines, /transport failed/, 'must say what unreadable actually means');
  assert.doesNotMatch(lines, /SOAK_VAULTS/, 'no sampler config fixes a rate limit');
});

test('freezeSafetyReport reports the n/a remedy even when one unmeasured sample is present', () => {
  // The branches used to be exclusive, so a SINGLE transport blip in an otherwise all-`n/a`
  // window suppressed the only remedy that would have helped. One blip over six hours at N vaults
  // every 120 s is near-certain, so this is the dominant shape, not a corner.
  const lines = freezeSafetyReport({
    verdicts: { 'n/a-no-pending': 19, unreadable: 1 }, probedWithPending: 0, oracleBlocked: 0, unmeasured: 1,
  }).join('\n');
  assert.match(lines, /1 sample\(s\) yielded NO MEASUREMENT \(unreadable\)/);
  assert.match(lines, /19 sample\(s\) were probed and found NO PENDING DEPOSIT/);
  assert.match(lines, /4h observation window/, 'the remedy that would actually help must survive');
  assert.match(lines, /less rate-limited RPC/, 'and so must the one for the blip');
});

test('freezeSafetyReport does not claim "n/a" about a series with NO probe rows at all', () => {
  // The pre-fix sampler emitted `freezeSafety: []` every sample, so the reducer sees nothing.
  // Reporting that as "every sample was n/a-no-pending" is the exact misattribution this whole
  // change exists to remove — and it was still being printed for precisely this input.
  const lines = freezeSafetyReport({
    verdicts: {}, probedWithPending: 0, oracleBlocked: 0, unmeasured: 0,
  }).join('\n');
  assert.match(lines, /NO freeze-safety rows at all/);
  assert.doesNotMatch(lines, /n\/a-no-pending/, 'must not describe absent rows as n/a rows');
  assert.match(lines, /mapping over an empty list/, 'name the actual mechanism');
});

test('freezeSafetyReport still names configuration when THAT is the cause', () => {
  const lines = freezeSafetyReport({
    verdicts: { 'not-configured': 2 }, probedWithPending: 0, oracleBlocked: 0, unmeasured: 2,
  }).join('\n');
  assert.match(lines, /2 sample\(s\) yielded NO MEASUREMENT \(not-configured\)/);
  assert.match(lines, /SOAK_VAULTS/, 'the config remedy belongs on the config cause');
  assert.doesNotMatch(lines, /transport failed/);
});

test('freezeSafetyReport reports BOTH causes when both are present', () => {
  const lines = freezeSafetyReport({
    verdicts: { unreadable: 1, 'not-probed': 1 }, probedWithPending: 0, oracleBlocked: 0, unmeasured: 2,
  }).join('\n');
  assert.match(lines, /unreadable\/not-probed|not-probed\/unreadable/);
  assert.match(lines, /transport failed/);
  assert.match(lines, /SOAK_VAULTS/);
});

test('freezeSafetyReport qualifies "held" when part of the window yielded no measurement', () => {
  const lines = freezeSafetyReport({
    verdicts: { callable: 1, unreadable: 2 }, probedWithPending: 1, oracleBlocked: 0, unmeasured: 2,
  }).join('\n');
  assert.match(lines, /freeze safety held/);
  assert.match(lines, /2 further sample\(s\) yielded no measurement \(unreadable\)/);
  assert.match(lines, /measured samples only, not over the whole window/);
});

test('freezeSafetyReport puts a real breach first and never softens it', () => {
  const lines = freezeSafetyReport({
    verdicts: { callable: 1, BLOCKED: 1, unreadable: 5 },
    probedWithPending: 1,
    oracleBlocked: 1,
    unmeasured: 5,
    blockedDetail: [{ at: 't2', vault: '0xv', verdict: 'BLOCKED', detail: 'StaleOracle' }],
  }).join('\n');
  assert.match(lines, /freeze-safety VIOLATED/);
  assert.match(lines, /StaleOracle/);
  assert.doesNotMatch(lines, /freeze safety held/, 'a breach must not be reported as held');
});

test('a transport failure is unmeasured, not a freeze-safety breach', () => {
  // A rate-limited or timed-out RPC is a fact about the transport, never about the contract.
  // Before this, two consecutive transport failures on the cancelPending static call fell through
  // to BLOCKED, and drill 4 prints BLOCKED as "freeze-safety VIOLATED" — a fabricated claim that
  // member funds were trapped, caused by a 429. Latent while the probe set was always empty; the
  // discovery fallback is what makes it reachable, at 3 vaults every 120 s.
  const r = summarizeFreezeSafety([
    sample('t1', 1, { freezeSafety: [{ vault: '0xv', probed: true, verdict: 'unreadable', detail: '429 Too Many Requests' }] }),
    sample('t2', 2, { freezeSafety: [{ vault: '0xv', verdict: 'callable' }] }),
  ]);
  assert.equal(r.oracleBlocked, 0, 'a 429 must never be reported as member funds being trapped');
  assert.equal(r.unmeasured, 1);
  assert.equal(r.probedWithPending, 1);
  assert.deepEqual(r.blockedDetail, []);
});

test('a REAL revert still counts as a breach — the transport carve-out must not swallow it', () => {
  // The other direction: making transport failures unmeasured must not make contract reverts
  // unmeasured too, or the guard stops guarding.
  const r = summarizeFreezeSafety([
    sample('t1', 1, { freezeSafety: [{ vault: '0xv', verdict: 'callable' }] }),
    sample('t2', 2, { freezeSafety: [{ vault: '0xv', verdict: 'BLOCKED', detail: 'StaleOracle' }] }),
  ]);
  assert.equal(r.oracleBlocked, 1);
  assert.equal(r.demonstrated, false);
  assert.equal(r.blockedDetail[0].detail, 'StaleOracle');
});

test('not-probed (no SOAK_PROBE_MEMBER) is unmeasured too, and does not mask a real breach', () => {
  const r = summarizeFreezeSafety([
    sample('t1', 1, { freezeSafety: [{ vault: '0xv', probed: false, verdict: 'not-probed' }] }),
    sample('t2', 2, { freezeSafety: [{ vault: '0xv', verdict: 'callable' }] }),
    sample('t3', 3, { freezeSafety: [{ vault: '0xv', verdict: 'BLOCKED', detail: 'StaleOracle' }] }),
  ]);
  assert.equal(r.unmeasured, 1);
  assert.equal(r.probedWithPending, 1);
  assert.equal(r.oracleBlocked, 1, 'a real breach must still surface alongside unmeasured samples');
  assert.equal(r.demonstrated, false);
});

// ───────────────────────────── canary + verdict ─────────────────────────────

test('oracleCanaryRows selects only the oracle-freshness signal and splits its composite key', () => {
  const rows = oracleCanaryRows({
    transitions: {
      'oracle-freshness|0xvault|0xweth': { status: 'ok', since: 1 },
      'nav-backing|0xvault|custody': { status: 'ok', since: 1 },
      'exit-liveness|0xvault|probe': { status: 'degraded', since: 4 },
    },
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { signal: rows[0].signal, vault: rows[0].vault, subject: rows[0].subject, status: rows[0].status },
    { signal: 'oracle-freshness', vault: '0xvault', subject: '0xweth', status: 'ok' },
  );
});

test('oracleCanaryRows survives an absent or empty transitions map', () => {
  assert.deepEqual(oracleCanaryRows({}), []);
  assert.deepEqual(oracleCanaryRows(null), []);
});

test('no breach → NO_EVENT verdict naming the closest approach', () => {
  const byAsset = summarize([
    sample('t1', 1, { asset: { symbol: 'WETH', ageSec: 100, ageFractionOfBound: 0.01 } }),
  ]);
  const r = verdictOf(byAsset, [{ status: 'ok' }]);
  assert.equal(r.verdict, 'NO_EVENT_WORST_CASE_DOCUMENTED');
  assert.equal(r.worst.symbol, 'WETH');
});

test('breach with an all-ok canary is reported as NOT tracked — the canary missed it', () => {
  const byAsset = summarize([sample('t1', 1, { asset: { margin: -2 } })]);
  const r = verdictOf(byAsset, [{ subject: WETH, status: 'ok' }, { subject: LINK, status: 'ok' }]);
  assert.equal(r.verdict, 'STALENESS_EVENT_OBSERVED');
  assert.equal(r.canaryTracked, false, 'this is the case that must fail the drill');
});

test('breach with a canary row off ok is reported as tracked', () => {
  const byAsset = summarize([sample('t1', 1, { asset: { priceReverts: true } })]);
  const r = verdictOf(byAsset, [{ subject: WETH, status: 'ok' }, { subject: LINK, status: 'alert' }]);
  assert.equal(r.canaryTracked, true);
});

// ══════════════════════════════════════════════════════════════════════════════
// C-6 PIVOT: the sampler now models ChainlinkOracle, not the retired OracleAggregator.
//
// The bug these tests exist to keep dead: the old sampler polled per-source `latestPrice()`, which
// REVERTS on a Chainlink proxy, swallowed the revert into `fresh: false`, and so recorded
// `margin = -1` on every sample of a perfectly healthy oracle — a fabricated permanent breach that
// drove drill 4 to report a staleness event that never happened.
// ══════════════════════════════════════════════════════════════════════════════

const ZERO = '0x0000000000000000000000000000000000000000';
const SEQ_FEED = '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433';
/** Base Sepolia WETH leg, read on-chain 2026-08-30: heartbeat 86400s, scale 1e10, band $100..$100k. */
const cfgWeth = (over = {}) => ({
  feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
  heartbeat: 86_400, scale: 10_000_000_000n,
  minPriceWad: 100_000_000_000_000_000_000n, maxPriceWad: 100_000_000_000_000_000_000_000n,
  ...over,
});
const round = (over = {}) => ({ ok: true, answer: '245833847163', updatedAt: 1_788_056_290, startedAt: 1_788_056_290, ...over });
const NO_SEQ_CAUSE = { causeKey: null, cause: null };

// ───────────────────── the pinned revert selectors ─────────────────────

test('the pinned revert selectors are recomputed from the COMPILED ABIs, not trusted', () => {
  // PR #89's lesson, applied to this file: an ABI constant validated only against itself is not
  // validated. `SEL_NO_PENDING` decides whether a `cancelPending` revert is a freeze-safety
  // VIOLATION or a benign "nothing to cancel", and `SEL_STALE_ORACLE` labels which revert froze the
  // vault. A signature moving out from under either would silently reclassify real evidence.
  // Skips when viem or the artifacts are absent, matching packages/canary/test/abis.test.mjs.
  if (!viem || !ORACLE_ABI.length || !VAULT_ABI.length) {
    console.log('# skipped: needs viem and `forge build` artifacts');
    return;
  }
  const selectorOf = (sig) => viem.keccak256(viem.toBytes(sig)).slice(0, 10);
  const errorsIn = (abi) => abi.filter((e) => e.type === 'error').map((e) => `${e.name}(${e.inputs.map((i) => i.type).join(',')})`);

  assert.ok(errorsIn(ORACLE_ABI).includes('StaleOracle(address)'), 'ChainlinkOracle must still declare StaleOracle(address)');
  assert.equal(SEL_STALE_ORACLE, selectorOf('StaleOracle(address)'));
  assert.ok(errorsIn(VAULT_ABI).includes('NoPending()'), 'VaultCore must still declare NoPending()');
  assert.equal(SEL_NO_PENDING, selectorOf('NoPending()'));
});

// ───────────────────── call-error classification ─────────────────────

test('a revert is a contract verdict and a transport failure is not — they must never be conflated', () => {
  // The whole "missing evidence" discipline rests on this split: a rate-limited RPC recorded as a
  // freeze is exactly the defect verify-chainlink-oracle.mjs once found in itself.
  assert.equal(classifyCallError('server returned an error response: error code 3: execution reverted'), 'revert');
  assert.equal(classifyCallError('Error: (code: 3, message: execution reverted, data: "0xa2671f4b")'), 'revert');
  assert.equal(classifyCallError('error sending request: operation timed out'), 'transport');
  assert.equal(classifyCallError('server returned an error response: error code 429: rate limit exceeded'), 'transport');
  assert.equal(classifyCallError('ECONNRESET'), 'transport');
  // Anything we cannot positively identify as a revert is missing evidence, not a finding.
  assert.equal(classifyCallError('something nobody has seen before'), 'transport');
});

// ───────────────────────── the sequencer gate ─────────────────────────

test('an unconfigured sequencer feed is neither a fault nor health — it is an unexercised path', () => {
  const s = sequencerState({ feed: ZERO, round: null, chainNow: 1000, grace: 3600 });
  assert.equal(s.configured, false);
  assert.equal(s.state, 'not-configured');
  assert.equal(s.causeKey, null, 'address(0) must not be reported as a freeze cause');
  assert.equal(s.unreadable, false);
});

test('the grace window publishes the EXACT second pricing resumes: startedAt + GRACE_PERIOD + 1', () => {
  // The contract reverts while `block.timestamp - startedAt <= GRACE_PERIOD`, so the first second
  // that prices again is one PAST the window. That number is the only honest ETA we can publish.
  const s = sequencerState({ feed: SEQ_FEED, round: { ok: true, answer: '0', startedAt: 1000 }, chainNow: 1000 + 3600, grace: 3600 });
  assert.equal(s.state, 'grace');
  assert.equal(s.causeKey, 'sequencer-grace');
  assert.equal(s.resumesAtSec, 4601);
  // One second later the window has fully elapsed and the gate opens.
  const after = sequencerState({ feed: SEQ_FEED, round: { ok: true, answer: '0', startedAt: 1000 }, chainNow: 1000 + 3601, grace: 3600 });
  assert.equal(after.state, 'up');
  assert.equal(after.causeKey, null);
});

test('a down sequencer, an unusable round and a future startedAt are all freeze causes', () => {
  assert.equal(sequencerState({ feed: SEQ_FEED, round: { ok: true, answer: '1', startedAt: 1 }, chainNow: 10_000, grace: 3600 }).causeKey, 'sequencer-down');
  assert.equal(sequencerState({ feed: SEQ_FEED, round: { ok: true, answer: '0', startedAt: 0 }, chainNow: 10_000, grace: 3600 }).causeKey, 'sequencer-unusable-round');
  assert.equal(sequencerState({ feed: SEQ_FEED, round: { ok: true, answer: '0', startedAt: 99_999 }, chainNow: 10_000, grace: 3600 }).causeKey, 'sequencer-unusable-round');
});

test('an uptime feed that REVERTS is a live freeze; one that is unreachable is missing evidence', () => {
  const reverts = sequencerState({ feed: SEQ_FEED, round: { ok: false, err: 'execution reverted', kind: 'revert' }, chainNow: 1, grace: 3600 });
  assert.equal(reverts.causeKey, 'sequencer-feed-reverts', 'the contract try/catches this and reverts StaleOracle vault-wide');
  assert.equal(reverts.unreadable, false);

  const blip = sequencerState({ feed: SEQ_FEED, round: { ok: false, err: 'operation timed out', kind: 'transport' }, chainNow: 1, grace: 3600 });
  assert.equal(blip.unreadable, true);
  assert.equal(blip.causeKey, null, 'an RPC blip must never be attributed as a sequencer freeze');
});

// ───────────────────── per-asset attribution (mirrors priceWad) ─────────────────────

test('a healthy ChainlinkOracle asset attributes NO cause and reports the real age', () => {
  const a = attributeAsset({ cfg: cfgWeth(), round: round(), chainNow: 1_788_056_572, pinned: false, sequencer: NO_SEQ_CAUSE });
  assert.equal(a.causeKey, null, 'a healthy live oracle must produce no finding at all');
  assert.equal(a.ageSec, 282);
  assert.equal(a.detail.inBand, true);
  assert.equal(a.unreadable, false);
});

test('staleness trips at age STRICTLY GREATER than the heartbeat — equal is still fresh', () => {
  // The contract's bound is `updatedAt < now - heartbeat`. Off by one here pages a poll early on
  // every heartbeat-cadence feed, which is how a correct canary gets muted.
  const at = (age) => attributeAsset({
    cfg: cfgWeth({ heartbeat: 3600 }), round: round({ updatedAt: 1_000_000 }),
    chainNow: 1_000_000 + age, pinned: false, sequencer: NO_SEQ_CAUSE,
  }).causeKey;
  assert.equal(at(3599), null);
  assert.equal(at(3600), null, 'age EXACTLY equal to the heartbeat is fresh');
  assert.equal(at(3601), 'heartbeat-exceeded');
});

test('the SEQUENCER cause wins over a stale feed, because priceWad checks it first', () => {
  // Not a corner case: the Base outages on record ran 2,760s / 9,432s / 3,612s, so a 3600s-heartbeat
  // feed is stale by the end of any of them. "Outage + stale feed" IS the shape of the grace hour,
  // and naming the heartbeat there sends a responder after the wrong thing.
  const a = attributeAsset({
    cfg: cfgWeth({ heartbeat: 3600 }), round: round({ updatedAt: 1_000_000 }), chainNow: 1_010_000,
    pinned: false, sequencer: { causeKey: 'sequencer-grace', cause: 'the sequencer is inside its post-restart grace period' },
  });
  assert.equal(a.causeKey, 'sequencer-grace', 'the contract reverts on the sequencer before it ever reads the feed');
  assert.match(a.cause, /grace/);
});

test('the sane-price band is enabled by maxPriceWad ALONE, exactly as the contract gates it', () => {
  const low = round({ answer: '1' }); // 1e-8 USD scaled to WAD = 1e10, far below the $100 floor
  assert.equal(attributeAsset({ cfg: cfgWeth(), round: low, chainNow: 1_788_056_290, pinned: false, sequencer: NO_SEQ_CAUSE }).causeKey, 'band-trip');
  // max == 0 is the only "disabled" spelling; a stray floor must not re-enable the band.
  const disabled = cfgWeth({ maxPriceWad: 0n, minPriceWad: 100_000_000_000_000_000_000n });
  assert.equal(attributeAsset({ cfg: disabled, round: low, chainNow: 1_788_056_290, pinned: false, sequencer: NO_SEQ_CAUSE }).causeKey, null);
});

test('unlisted, non-positive, unset and future-stamped rounds each name their own cause', () => {
  const go = (over, cfgOver) => attributeAsset({
    cfg: cfgWeth(cfgOver), round: round(over), chainNow: 1_788_056_572, pinned: false, sequencer: NO_SEQ_CAUSE,
  }).causeKey;
  assert.equal(attributeAsset({ cfg: cfgWeth({ feed: ZERO }), round: round(), chainNow: 1, pinned: false, sequencer: NO_SEQ_CAUSE }).causeKey, 'unlisted');
  assert.equal(go({ answer: '0' }), 'non-positive-answer');
  assert.equal(go({ answer: '-1' }), 'non-positive-answer');
  assert.equal(go({ updatedAt: 0 }), 'unset-round');
  assert.equal(go({ updatedAt: 1_999_999_999 }), 'future-timestamp');
});

test('a feed that REVERTS is a dead-feed freeze; a feed we could not reach is missing evidence', () => {
  const dead = attributeAsset({
    cfg: cfgWeth(), round: { ok: false, err: 'execution reverted', kind: 'revert' },
    chainNow: 1, pinned: false, sequencer: NO_SEQ_CAUSE,
  });
  assert.equal(dead.causeKey, 'feed-reverts');
  assert.equal(dead.unreadable, false);

  const blip = attributeAsset({
    cfg: cfgWeth(), round: { ok: false, err: 'operation timed out', kind: 'transport' },
    chainNow: 1, pinned: false, sequencer: NO_SEQ_CAUSE,
  });
  assert.equal(blip.unreadable, true, 'an RPC timeout is not a deprecated feed');
  assert.equal(blip.causeKey, null);
});

test('a pinned USDC leg is answered before any feed is read, and only the sequencer can freeze it', () => {
  const pinned = attributeAsset({ cfg: cfgWeth({ feed: ZERO }), round: round(), chainNow: 1, pinned: true, sequencer: NO_SEQ_CAUSE });
  assert.equal(pinned.causeKey, null, 'the pin returns 1e18 without touching a feed, so "unlisted" would be wrong');
  const frozen = attributeAsset({
    cfg: cfgWeth({ feed: ZERO }), round: round(), chainNow: 1, pinned: true,
    sequencer: { causeKey: 'sequencer-down', cause: 'the L2 sequencer is reporting DOWN' },
  });
  assert.equal(frozen.causeKey, 'sequencer-down');
});

// ───────────────── summarize, post-pivot (the regression that matters) ─────────────────

/** A ChainlinkOracle-shaped sample: no `margin`, no `quorum`, no `freshSources`. */
const liveSample = (t, chainNow, over = {}) => ({
  t, chainNow,
  sequencer: { configured: false, state: 'not-configured', causeKey: null, unreadable: false, ...(over.sequencer ?? {}) },
  assets: [{
    symbol: 'WETH', asset: WETH, unreadable: false, ageUnreadable: false, listed: true,
    staleBoundSec: 86_400, staleBoundSource: 'feedOf.heartbeat',
    configMaxStalenessSeconds: 86_400, boundDrift: false,
    feedUpdatedAt: chainNow - 282, ageSec: 282, ageFractionOfBound: 282 / 86_400,
    priceWad: '2458338471630000000000', priceReverts: false, frozenCauseKey: null, attributionGap: false,
    ...(over.asset ?? {}),
  }],
  freezeSafety: over.freezeSafety ?? [],
});

test('a HEALTHY ChainlinkOracle series records zero breaches — the fabricated-margin bug, dead', () => {
  // This is the exact regression: pre-pivot this series scored a breach on every sample because
  // `latestPrice()` reverts on a Chainlink proxy and the revert was folded into `margin = -1`.
  const s = summarize([liveSample('t1', 1_000_000), liveSample('t2', 1_000_120)]);
  assert.equal(s.WETH.breachSamples, 0, 'a healthy live oracle must produce no breach at all');
  assert.equal(s.WETH.readableSamples, 2);
  assert.equal(s.WETH.minMargin, null, 'a post-pivot sample carries no margin; inventing one is the bug');
  assert.equal(s.WETH.quorum, null, 'there is no quorum on a single-feed oracle');
  assert.equal(s.WETH.priceRevertSamples, 0);
});

test('the staleness bound is read from the ORACLE, and a disagreeing address book is flagged', () => {
  // The contract's config is immutable and the JSON is editable, so the JSON is what can drift.
  const s = summarize([
    liveSample('t1', 1, { asset: { staleBoundSec: 3600, configMaxStalenessSeconds: 86_400, boundDrift: true } }),
    liveSample('t2', 2, { asset: { staleBoundSec: 3600, configMaxStalenessSeconds: 86_400, boundDrift: true } }),
  ]);
  assert.equal(s.WETH.staleBoundSec, 3600);
  assert.equal(s.WETH.staleBoundSource, 'feedOf.heartbeat');
  assert.equal(s.WETH.boundDriftSamples, 2);
});

test('a bound-less sample (a pinned leg) must not overwrite a real heartbeat with 0', () => {
  // A pinned USDC leg has no feed, so `feedOf` returns the zero struct. Emitting its `heartbeat: 0`
  // would report permanent bound drift AND clobber a real bound in the reduction — the same
  // "helpfully substitute a value for a missing one" defect this whole rewrite is about.
  const s = summarize([
    liveSample('t1', 1),
    liveSample('t2', 2, { asset: { staleBoundSec: null, staleBoundSource: null, boundDrift: false, ageSec: null } }),
  ]);
  assert.equal(s.WETH.staleBoundSec, 86_400, 'the real heartbeat must survive a bound-less sample');
  assert.equal(s.WETH.staleBoundSource, 'feedOf.heartbeat');
  assert.equal(s.WETH.boundDriftSamples, 0);
});

test('an UNREADABLE sample is scored as neither a breach nor health', () => {
  const s = summarize([
    liveSample('t1', 1),
    liveSample('t2', 2, { asset: { unreadable: true, unreadableReason: 'priceWad unreadable (timed out)', ageSec: null, ageFractionOfBound: null, priceReverts: null } }),
  ]);
  assert.equal(s.WETH.samples, 2);
  assert.equal(s.WETH.readableSamples, 1);
  assert.equal(s.WETH.unreadableSamples, 1);
  assert.equal(s.WETH.breachSamples, 0, 'missing evidence must never manufacture a finding');
  assert.equal(s.WETH.ageSamples, 1, 'and it must not contribute an age either');
  assert.equal(isBreachSample({ unreadable: true, priceReverts: true }), false, 'not even if a stale verdict rides along');
});

test('freeze causes are counted per key, and an unattributable freeze is flagged rather than hidden', () => {
  const s = summarize([
    liveSample('t1', 1, { asset: { priceReverts: true, frozenCauseKey: 'heartbeat-exceeded', ageSec: 90_000 } }),
    liveSample('t2', 2, { asset: { priceReverts: true, frozenCauseKey: 'heartbeat-exceeded', ageSec: 90_100 } }),
    liveSample('t3', 3, { asset: { priceReverts: true, frozenCauseKey: null, attributionGap: true } }),
  ]);
  assert.equal(s.WETH.breachSamples, 3);
  assert.deepEqual(s.WETH.causes, { 'heartbeat-exceeded': 2 });
  assert.equal(s.WETH.attributionGapSamples, 1, 'a freeze the model cannot explain is still a freeze');
});

// ───────────── the false green: a per-vault meta row is not asset coverage ─────────────

test('isAssetSubject accepts an address and rejects every per-vault meta key', () => {
  assert.equal(isAssetSubject(WETH), true);
  assert.equal(isAssetSubject('sequencer'), false);
  assert.equal(isAssetSubject('flavor'), false);
  assert.equal(isAssetSubject(undefined), false);
});

test('a permanently-skipped `sequencer` row does NOT count as the canary tracking a freeze', () => {
  // PR #89 added a per-vault `sequencer` row under the `oracle-freshness` signal name. On Base
  // Sepolia sequencerUptimeFeed is address(0), so that row is permanently `skipped` — under the old
  // `rows.some(r => r.status !== 'ok')` it satisfied the assertion by itself, whether or not any
  // asset row ever left OK. That is a drill certifying nothing while exiting 0.
  const byAsset = summarize([liveSample('t1', 1, { asset: { priceReverts: true, frozenCauseKey: 'heartbeat-exceeded' } })]);
  const rows = oracleCanaryRows({
    transitions: {
      [`oracle-freshness|0xvault|${WETH}`]: { status: 'ok', since: 1 },
      'oracle-freshness|0xvault|sequencer': { status: 'skipped', since: 1 },
    },
  });
  const r = verdictOf(byAsset, rows);
  assert.equal(r.verdict, 'STALENESS_EVENT_OBSERVED');
  assert.equal(r.canaryTracked, false, 'the freeze went untracked; the drill must fail');
  assert.equal(r.canaryAssetRows, 1);
});

test('a DETECTOR BROKEN `flavor` row does not count either — a blind detector tracks nothing', () => {
  // Strictly worse than the sequencer case: this row exists precisely because the canary cannot see
  // the oracle at all, so counting it would certify coverage from a confirmed blind spot.
  const byAsset = summarize([liveSample('t1', 1, { asset: { priceReverts: true } })]);
  const rows = oracleCanaryRows({ transitions: { 'oracle-freshness|0xvault|flavor': { status: 'skipped', since: 1 } } });
  assert.equal(rows[0].isAsset, false);
  const r = verdictOf(byAsset, rows);
  assert.equal(r.canaryTracked, false);
  assert.equal(r.canaryAssetRows, 0, 'zero asset rows is no coverage, not silent coverage');
});

test('an asset row that left ok DOES count, so the fix does not simply disable the check', () => {
  const byAsset = summarize([liveSample('t1', 1, { asset: { priceReverts: true } })]);
  const rows = oracleCanaryRows({
    transitions: {
      [`oracle-freshness|0xvault|${WETH}`]: { status: 'alert', since: 9 },
      'oracle-freshness|0xvault|sequencer': { status: 'skipped', since: 1 },
    },
  });
  assert.equal(verdictOf(byAsset, rows).canaryTracked, true);
});

// ───────────────── insufficient evidence is not "no event" ─────────────────

test('a series with no readable asset observation is INSUFFICIENT_EVIDENCE, never NO_EVENT', () => {
  // NO_EVENT prints as "the expected outcome on a live feed and is NOT a failed drill". Reporting
  // an unmeasured window that way is the same class of false green as the sequencer row.
  const s = summarize([liveSample('t1', 1, { asset: { unreadable: true, ageSec: null, priceReverts: null } })]);
  const r = verdictOf(s, []);
  assert.equal(r.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(r.unreadableSamples, 1);
  assert.equal(verdictOf({}, []).verdict, 'INSUFFICIENT_EVIDENCE', 'an empty reduction certifies nothing either');
});

// ───────────────────────── the sequencer leg over a window ─────────────────────────

test('an unconfigured sequencer leg reports exercised:false — an unexecuted path, not a pass', () => {
  const q = summarizeSequencer([liveSample('t1', 1), liveSample('t2', 2)]);
  assert.deepEqual(q.states, { 'not-configured': 2 });
  assert.equal(q.exercised, false, 'Base Sepolia never runs this code; the first execution is mainnet');
  assert.equal(q.configuredSamples, 0);
});

test('a real grace window is counted and carries the earliest computed resume second', () => {
  const grace = { configured: true, state: 'grace', causeKey: 'sequencer-grace', resumesAtSec: 4601, unreadable: false };
  const q = summarizeSequencer([
    liveSample('t1', 1, { sequencer: grace }),
    liveSample('t2', 2, { sequencer: { ...grace, resumesAtSec: 4602 } }),
    liveSample('t3', 3, { sequencer: { configured: true, state: 'up', causeKey: null, unreadable: false } }),
  ]);
  assert.equal(q.exercised, true);
  assert.equal(q.notUpSamples, 2);
  assert.equal(q.earliestResumesAtSec, 4601);
  assert.equal(q.states.up, 1);
});

// ───────────────────────── drill 5 guards ─────────────────────────

const okEnv = {
  [EXECUTE_ENV_VAR]: 'yes',
  SOAK_AGENT_KEYSTORE: '/tmp/ks',
  SOAK_AGENT_KEYSTORE_PASSWORD: 'pw',
};

test('resolveAgentRunConfig accepts a complete environment and defaults the API and RPC', () => {
  const c = resolveAgentRunConfig({ ...okEnv });
  assert.equal(c.keystore, '/tmp/ks');
  assert.equal(c.apiBaseUrl, 'http://127.0.0.1:8402');
  assert.match(c.rpcUrl, /^https:\/\//);
});

test('resolveAgentRunConfig names EVERY problem at once, not just the first', () => {
  // An operator fixing a three-item misconfiguration one error at a time is an operator who
  // eventually pastes a private key into a shell to make it stop.
  let msg = '';
  try { resolveAgentRunConfig({}); assert.fail('expected a refusal'); }
  catch (e) { msg = String(/** @type {Error} */ (e).message); }
  assert.match(msg, new RegExp(EXECUTE_ENV_VAR));
  assert.match(msg, /SOAK_AGENT_KEYSTORE \(/);
  assert.match(msg, /SOAK_AGENT_KEYSTORE_PASSWORD/);
  assert.equal(msg.split('\n  - ').length - 1, 3, 'all three problems in one message');
});

test('a raw private key in the environment is a hard refusal, even when everything else is valid', () => {
  for (const key of ['SOAK_AGENT_PRIVATE_KEY', 'AGENT_PRIVATE_KEY']) {
    assert.throws(
      () => resolveAgentRunConfig({ ...okEnv, [key]: '0x' + '1'.repeat(64) }),
      /refusing to run with a raw private key/,
      `${key} must be refused`,
    );
  }
});

test('missing consent alone blocks the run — the gate never downgrades to a safe mode', () => {
  assert.throws(() => resolveAgentRunConfig({ ...okEnv, [EXECUTE_ENV_VAR]: 'no' }), new RegExp(EXECUTE_ENV_VAR));
  assert.throws(() => resolveAgentRunConfig({ ...okEnv, [EXECUTE_ENV_VAR]: 'YES' }), new RegExp(EXECUTE_ENV_VAR));
});

test('policyFor sizes the deposit from config and keeps minFreeCapacity in step', () => {
  const p = policyFor('join', { depositUsdc: '1' });
  assert.equal(p.join.depositUsdc, '1');
  assert.equal(p.join.minFreeCapacityUsdc, '1', 'a vault too full to take the deposit must not be joined');
  assert.equal(p.join.requireProvenOperator, false, 'the smoke vault operator has no realized track record');
  assert.equal(p.exit.maxDrawdownBps, 1000, 'non-exit phases keep the normal threshold');
});

test('the exit phase forces the drawdown trigger AND flags it as forced', () => {
  // The flag is what stops the report claiming a real drawdown was observed.
  const p = policyFor('exit', { depositUsdc: '1' });
  assert.equal(p.exit.maxDrawdownBps, 1);
  assert.equal(p.exit.forced, true);
  assert.notEqual(policyFor('join', { depositUsdc: '1' }).exit.forced, true);
});

// ───────────────────── send lock (nonce contention) ─────────────────────
//
// Regression: the first unattended launch ran two drill tracks in parallel against ONE signer.
// Governance serializes per vault, but nonces are per ACCOUNT, so two concurrent `cast send`
// calls collided and both drills died. Cross-process exclusion is verified separately by
// running two node processes; these cover the in-process contract.

import { withSendLock, ROOT as LIB_ROOT } from '../soak/lib.mjs';

const LOCK = path.join(LIB_ROOT, 'data', '.soak-send.lock');

test('withSendLock runs the body, returns its value, and releases the lock', () => {
  const before = fs.existsSync(LOCK);
  const got = withSendLock(() => 'receipt');
  assert.equal(got, 'receipt');
  assert.equal(fs.existsSync(LOCK), before, 'the lock must not outlive the call');
});

test('the lock is released even when the body throws — a reverted tx must not deadlock the run', () => {
  assert.throws(() => withSendLock(() => { throw new Error('reverted'); }), /reverted/);
  assert.equal(fs.existsSync(LOCK), false, 'a throwing send must still release the lock');
});

test('a stale lock from a crashed drill is broken rather than waited on forever', () => {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, '99999 crashed-holder\n');
  // Backdate it past the 5-minute staleness bound.
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(LOCK, old, old);
  const got = withSendLock(() => 'proceeded');
  assert.equal(got, 'proceeded', 'a dead holder must not block the rest of the soak');
  assert.equal(fs.existsSync(LOCK), false);
});
