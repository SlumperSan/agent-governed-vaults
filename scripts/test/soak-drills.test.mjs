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
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'out');
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

test('freezeSafetyReport counts PROBES and says so — the tally is per-vault, not per-sample', () => {
  // THE UNITS ARE THE CLAIM. `summarizeFreezeSafety` iterates `for (const f of s.freezeSafety)`,
  // so every counter is a per-VAULT-per-sample ROW. While the probe set was always empty that
  // count was 0 and the units could not diverge; discovery makes 3 rows per sample the norm, so
  // calling them "sample(s)" overstated the evidence THREEFOLD — 4 samples across 3 vaults
  // printed as "12 sample(s)". This is gate-3 evidence, where the count is the claim about how
  // much of it exists.
  //
  // Pinned as a UNIT test rather than a wording test: the numbers below are row counts by
  // construction, and the assertion is that the noun matches them.
  const threeVaults = summarizeFreezeSafety([
    sample('t1', 1, { freezeSafety: [
      { vault: '0xa', verdict: 'n/a-no-pending' },
      { vault: '0xb', verdict: 'n/a-no-pending' },
      { vault: '0xc', verdict: 'n/a-no-pending' },
    ] }),
    sample('t2', 2, { freezeSafety: [
      { vault: '0xa', verdict: 'n/a-no-pending' },
      { vault: '0xb', verdict: 'n/a-no-pending' },
      { vault: '0xc', verdict: 'n/a-no-pending' },
    ] }),
  ]);
  assert.equal(threeVaults.verdicts['n/a-no-pending'], 6, 'two samples over three vaults is six ROWS');

  const lines = freezeSafetyReport(threeVaults).join('\n');
  assert.match(lines, /6 probe\(s\)/, 'six rows must be reported as six probes');
  assert.doesNotMatch(lines, /\bsample\(s\)/,
    'the report must never call a per-vault row a "sample" — 2 samples are not 6');
});

test('freezeSafetyReport names the ACTUAL unmeasured kind, never a hardcoded one', () => {
  // The first version hardcoded "not-configured/not-probed" while `unreadable` sat in the same
  // bucket, so an all-`unreadable` window printed "the probe did not run" about samples that DID
  // run, and offered a fix (vault discovery) for what was a rate limit.
  const lines = freezeSafetyReport({
    verdicts: { unreadable: 3 }, probedWithPending: 0, oracleBlocked: 0, unmeasured: 3,
  }).join('\n');
  assert.match(lines, /3 probe\(s\) yielded NO MEASUREMENT \(unreadable\)/);
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
  assert.match(lines, /1 probe\(s\) yielded NO MEASUREMENT \(unreadable\)/);
  assert.match(lines, /19 probe\(s\) found NO PENDING DEPOSIT/);
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
  assert.match(lines, /2 probe\(s\) yielded NO MEASUREMENT \(not-configured\)/);
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
  assert.match(lines, /2 further probe\(s\) yielded no measurement \(unreadable\)/);
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
  // `unreadableObservations`, not `...Samples`: it SUMS across assets, so a 2-asset basket
  // contributes 2 per sample. Named for what it counts after the freeze-safety counters were
  // caught printing per-vault rows as "sample(s)" and overstating the evidence threefold.
  assert.equal(r.unreadableObservations, 1);
  assert.equal(verdictOf({}, []).verdict, 'INSUFFICIENT_EVIDENCE', 'an empty reduction certifies nothing either');
});

test('unreadableObservations sums ACROSS assets — two assets contribute two per sample', () => {
  // The units defect, in the place the reviewer did not cite. With a 2-asset basket this counter
  // is a row count, so reporting it as "sample(s)" would double the apparent missing evidence.
  const s = summarize([liveSample('t1', 1, {
    asset: { unreadable: true, ageSec: null, priceReverts: null },
  })]);
  // Fabricate a second asset with one unreadable observation in the same single sample.
  s.LINK = { ...s.WETH, symbol: 'LINK' };
  const r = verdictOf(s, []);
  assert.equal(r.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(r.unreadableObservations, 2, 'ONE sample over TWO assets is TWO observations');
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

import { withSendLock, ROOT as LIB_ROOT, budgetExhaustedFailure, votableNow } from '../soak/lib.mjs';

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

// ─────────── transport is not a verdict (drill 3's false PASS) ───────────

test('classifyCallError: only a recognised revert is evidence about the contract', () => {
  // drill3-modef asserted `!attempt.ok` to prove settleQueuedExit was REFUSED while a rebalance
  // was pending (EE-10/K-1). A rate limit also yields `ok:false`, so the assertion PASSED on a
  // 429 and the drill persisted the 429 text as `revertedWith` — a security invariant recorded as
  // proven because the network was busy. These are the two claims that must never be conflated.
  for (const err of [
    'server returned an error response: error code 3: execution reverted, data: "0x88cce429"',
    'Error: execution reverted',
    'reverted: ExecutionPending()',
  ]) {
    assert.equal(classifyCallError(err), 'revert', `should be a contract verdict: ${err}`);
  }

  for (const err of [
    'error sending request: 429 Too Many Requests',
    'Error: operation timed out',
    'ECONNRESET',
    'getaddrinfo ENOTFOUND base-sepolia-rpc.publicnode.com',
    'max retries exceeded',
    'error sending request: 503 Service Unavailable',
  ]) {
    assert.equal(classifyCallError(err), 'transport', `must NOT be read as a contract verdict: ${err}`);
  }
});

test('classifyCallError: a revert whose text also mentions a transport-ish token is still a revert', () => {
  // The order matters. A revert reason containing "timeout" or a 429-like number must not be
  // demoted to missing evidence, or a real finding disappears.
  assert.equal(classifyCallError('execution reverted, data: "0x429" timeout'), 'revert');
  assert.equal(classifyCallError('reverted: DeadlineTimeout()'), 'revert');
});

test('classifyCallError is fail-safe for the drill: an unknown string is NOT a revert', () => {
  // Unknown wording must not satisfy an assertion that a refusal was observed. Erring toward
  // "transport" makes drill 3 fail loudly (UNPROVEN) rather than pass quietly.
  assert.equal(classifyCallError('something nobody has seen before'), 'transport');
});

// ───────── budget exhaustion is terminal, and must say so (drill 5) ─────────
//
// The guard is fed `agent.budget.summary()` in the drill, so the real producer is imported here
// rather than described: a test that hand-builds the summary cannot notice a rename in budget.mjs.

import { createBudget } from '../../packages/reference-agent/src/budget.mjs';
import { toBaseUnits } from '../../packages/reference-agent/src/config.mjs';

test('budgetExhaustedFailure fires the moment the cap is gone, and names the real cause', () => {
  // The 2026-09-04 run verbatim: cap hit at tick 5 of 40, then 35 more ticks against a blind
  // agent before failing with "vote:commit: not satisfied after 40 ticks" — a governance symptom
  // standing in for a harness budget cause.
  const msg = budgetExhaustedFailure(
    { enabled: true, spentUsdc: '0.25', capUsdc: '0.25', remainingUsdc: '0', paidReads: 25 },
    5, 40, 'vote:commit',
  );
  assert.ok(msg, 'an exhausted cap must stop the poll, not be waited out');
  assert.match(msg, /tick 5\/40/);
  assert.match(msg, /HARNESS BUDGET failure, NOT evidence about governance/);
  assert.match(msg, /SOAK_AGENT_CAP_USDC/, 'the operator needs the lever named');
  // The arithmetic must be derived, not asserted: $0.25 over 5 ticks is $0.05/tick, so 40 ticks
  // needs $2.00. Stating the shortfall is what turns a failure into a decision.
  assert.match(msg, /\$0\.050 per tick/);
  assert.match(msg, /40 ticks needs about \$2\.00/);
});

test('budgetExhaustedFailure keeps quiet while budget remains, or when payments are off', () => {
  assert.equal(
    budgetExhaustedFailure(
      { enabled: true, spentUsdc: '0.10', capUsdc: '0.25', remainingUsdc: '0.15', paidReads: 10 },
      3, 40, 'vote:commit',
    ),
    null,
    'must not abort a run that can still perceive',
  );
  assert.equal(
    budgetExhaustedFailure(
      { enabled: false, spentUsdc: '0', capUsdc: '0', remainingUsdc: '0', paidReads: 0 },
      3, 40, 'vote:commit',
    ),
    null,
    'payments disabled means the cap is irrelevant, not exhausted',
  );
  assert.equal(budgetExhaustedFailure(undefined, 3, 40, 'x'), null, 'no budget surface, no claim');
});

test('budgetExhaustedFailure fires on a remainder that is still positive but below one average read', () => {
  // THE NEAR-EXHAUSTION HALF OF THE PREDICATE. Replacing the whole condition with plain
  // `remaining > 0` — so nothing above zero ever fires — left every other test in this file green:
  // none of them distinguishes "the remainder cannot buy one more average read" from "the
  // remainder is zero". A remainder of exactly zero is the lucky case; it needs the reads to
  // divide the cap evenly. A $0.004 remainder against $0.01025 average reads is the ordinary one,
  // and it is just as blind.
  const msg = budgetExhaustedFailure(
    { enabled: true, spentUsdc: '0.246', capUsdc: '0.25', remainingUsdc: '0.004', paidReads: 24 },
    20, 40, 'vote:commit',
  );
  assert.ok(msg, 'a remainder too small to buy a read is already blind — waiting it out proves nothing');
  assert.match(msg, /tick 20\/40/);
  // Derived, not asserted: $0.246 over 24 reads averages $0.01025, which $0.004 cannot buy; and
  // $0.246 over 20 ticks is $0.0123 per tick, so 40 ticks would need about $0.49.
  assert.match(msg, /24 paid reads averaging \$0\.010/);
  assert.match(msg, /\$0\.012 per tick/);
  assert.match(msg, /40 ticks needs about \$0\.49/);
});

test('budgetExhaustedFailure reads the field names createBudget().summary() actually emits', () => {
  // THE WIRING, not the predicate. Every case above hand-builds the summary object, so nothing
  // connected the guard's five field reads to their only real producer. A rename in budget.mjs
  // would break the guard in one of two silent ways and change no test in this file: `enabled` renamed makes
  // `!spend?.enabled` short-circuit and the guard goes inert; `remainingUsdc` renamed makes
  // `Number(undefined)` NaN, `NaN > 0` false, and the guard fire on tick 1 of every run. Both
  // mutations turn this test red.
  const budget = createBudget({ maxSessionSpendUsdc: '0.25', maxSingleReadUsdc: '0.05' });
  assert.equal(
    budgetExhaustedFailure(budget.summary(), 1, 40, 'vote:commit'),
    null,
    'a budget with nothing spent must not abort the run before its first read',
  );

  // Spend it to the cap through the same call the agent's guarded signer makes: `charge()`, at
  // signature time, in base units (perceive.mjs wraps the signer with `guardSigner`, which charges).
  // Ten reads at $0.025 keeps the average read distinct from the per-tick burn, so the two
  // derivations below are pinned separately rather than coinciding.
  for (let i = 0; i < 10; i += 1) budget.charge(toBaseUnits('0.025'), 'metered read');
  assert.throws(
    () => budget.charge(toBaseUnits('0.025'), 'metered read'),
    /spend refused/,
    'the premise of the guard: this budget will not fund another average read',
  );

  const msg = budgetExhaustedFailure(budget.summary(), 4, 40, 'vote:commit');
  assert.ok(msg, 'a real spent-out budget must stop the poll');
  // One regex over the four fields the message prints, plus the average derived from two of them.
  // The fifth, `enabled`, is pinned by the guard returning a message at all rather than null.
  assert.match(msg, /\$0\.25 of \$0\.25 spent, \$0 left, 10 paid reads averaging \$0\.025/);
  assert.match(msg, /tick 4\/40/);
  assert.match(msg, /\$0\.063 per tick/);
  assert.match(msg, /40 ticks needs about \$2\.50/);
});

test('tryCall WIRES the classifier — a failed cast carries kind, not just ok:false', () => {
  // THE WIRING, not the classifier. Mutation showed that stripping `kind` from `tryCall` changed
  // no test: the classifier was well covered and drill 3's assert was well reasoned, but nothing
  // pinned the connection between them. A `kind`-keyed guard wired to a producer that never sets
  // `kind` is exactly how the freeze-safety probe shipped inert.
  //
  // CAST is read at module load, so a child process with it pointed at a binary that does not
  // exist makes every call fail at the transport layer — no RPC, no network, no transaction.
  const src = `
    process.env.CAST = 'definitely-not-a-real-binary-${'x'.repeat(8)}';
    const { tryCall } = await import(${JSON.stringify(new URL('../soak/lib.mjs', import.meta.url).href)});
    const r = tryCall('0x0000000000000000000000000000000000000000', 'foo()');
    console.log(JSON.stringify({ ok: r.ok, kind: r.kind, hasErr: typeof r.err === 'string' }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.ok, false, 'a missing binary must fail the call');
  assert.equal(r.hasErr, true);
  assert.equal(r.kind, 'transport',
    'tryCall must classify the failure — without `kind` drill 3\'s revert assertion is unguarded');
});

// ───────── votableNow: a pid is not a votable round (drill 5) ─────────

test('votableNow rejects a settled proposal that activeProposalOf still names', () => {
  // The 2026-09-04 failure. (ptype is 0 here only because this predicate ignores it unless a
  // caller passes wantPtype; on chain proposal 3 is ptype 2, ChildAllocation.) Governance assigns
  // activeProposalOf at :321 and NEVER
  // clears it on settlement, so it kept naming proposal 3 — Executed, commit window shut 14h
  // earlier. `assert(pid > 0n)` passed, the agent correctly refused to vote on every tick, and
  // the drill blamed governance 20 minutes later.
  const r = votableNow(
    { status: 'Executed', ptype: 0, createdAt: 1788479808, commitDeadline: 1788483408 },
    { now: 1788534622, snapshotWeight: 0n, currentWeight: 0n },
  );
  assert.equal(r.votable, false);
  assert.match(r.reason, /status is Executed/);
  assert.match(r.reason, /never clears that mapping/, 'the reason must name the mechanism, not just the symptom');
});

test('votableNow rejects an Active proposal whose commit window has closed', () => {
  const r = votableNow(
    { status: 'Active', ptype: 0, createdAt: 1, commitDeadline: 1000 },
    { now: 1600, snapshotWeight: 5n, currentWeight: 5n },
  );
  assert.equal(r.votable, false);
  assert.match(r.reason, /commit window closed 600s ago/, 'say how stale, not just that it is stale');
});

test('votableNow rejects a proposal raised before the voter held shares', () => {
  // The conjunct a status+deadline check would miss. Proposal 3 was raised before the agent
  // activated, so its snapshot weight is zero and commitVote reverts NoWeight — attaching to it
  // reproduces the same 40-tick stall in a different costume.
  //
  // `currentWeight: 5n` is the faithful shape of that account: it holds shares NOW, it just did
  // not hold them at `createdAt - 1`. It also proves the snapshot branch is reached on its own
  // merits rather than by a healthy current weight being absent.
  const r = votableNow(
    { status: 'Active', ptype: 0, createdAt: 1, commitDeadline: 9999 },
    { now: 100, snapshotWeight: 0n, currentWeight: 5n },
  );
  assert.equal(r.votable, false);
  assert.match(r.reason, /zero voting-eligible stake/);
  assert.match(r.reason, /NoWeight/, 'name the revert the voter would actually hit');
});

test('votableNow accepts a genuinely votable round, and only then', () => {
  const good = { status: 'Active', ptype: 0, createdAt: 1, commitDeadline: 9999 };
  assert.deepEqual(votableNow(good, { now: 100, snapshotWeight: 1n, currentWeight: 1n }), { votable: true, reason: '' });
  // and the ptype filter is opt-in, so it cannot silently reject when unused
  assert.equal(votableNow(good, { now: 100, snapshotWeight: 1n, currentWeight: 1n, wantPtype: 0 }).votable, true);
  const wrongType = votableNow(good, { now: 100, snapshotWeight: 1n, currentWeight: 1n, wantPtype: 3 });
  assert.equal(wrongType.votable, false);
  assert.match(wrongType.reason, /ptype is 0, not the expected 3/, 'the ptype reason must be asserted too, or it can be emptied unnoticed');
  assert.equal(votableNow(null, { now: 100, snapshotWeight: 1n, currentWeight: 1n }).votable, false);
});

test('votableNow rejects at the EXACT commit deadline, matching commitVote', () => {
  // Governance requires `block.timestamp < p.commitDeadline`, so equality is already too late.
  // Unpinned, `>=` could be relaxed to `>` and the suite would stay green while the drill
  // attached to a round one second past its window.
  const p = { status: 'Active', ptype: 0, createdAt: 1, commitDeadline: 1000 };
  assert.equal(votableNow(p, { now: 1000, snapshotWeight: 5n, currentWeight: 5n }).votable, false, 'now === deadline is CLOSED');
  assert.equal(votableNow(p, { now: 999, snapshotWeight: 5n, currentWeight: 5n }).votable, true, 'one second earlier is open');
});

test('votableNow names the QUEUED EXIT, not the snapshot, when only the current weight is zero', () => {
  // The two zero-weight causes are opposite in time and the message used to state only one of
  // them. `commitVote` gates on `_boundedWeight` (Governance.sol:365 -> :352-356), which is
  // min(snapshot, current); handed only that minimum, this predicate saw `0` and blamed the
  // proposal for predating the account. A voter who has queued an exit is the reverse case:
  // `votingEligibleShares` is `sharesOf - queuedExitShares` (VaultCore.sol:1025-1028), so the
  // snapshot is positive and the CURRENT term is what went to zero. Drill 5 queues an exit in its
  // own next phase (drill5-agent-execute.mjs), so a re-run reaches this exact state, and an
  // operator told "raised before this account held shares" would go looking at the wrong end of
  // the timeline.
  const p = { status: 'Active', ptype: 0, createdAt: 1, commitDeadline: 9999 };
  const r = votableNow(p, { now: 100, snapshotWeight: 7n, currentWeight: 0n });
  assert.equal(r.votable, false, 'min(7, 0) is 0, so commitVote would revert NoWeight');
  assert.match(r.reason, /no voting-eligible shares NOW/, 'the cause is present-tense, not the snapshot');
  assert.match(r.reason, /queuedExitShares/, 'name the mechanism that zeroed it');
  assert.match(r.reason, /snapshot weight 7, current 0/, 'print both terms, or the operator cannot see which one is zero');
  assert.doesNotMatch(r.reason, /raised before this account held shares/,
    'the snapshot story is FALSE here — snapshot weight is 7');
});

test('votableNow refuses rather than guesses when currentWeight is not supplied', () => {
  // FAIL CLOSED ON A MISSING INPUT. Defaulting the second term — to the snapshot, or to infinity —
  // would hand a future caller the exact wrong-cause message this pair of branches exists to
  // prevent, and nothing would go red. That is the shape of the inert SOAK_VAULTS leg: a guard
  // wired to an input nobody supplies reads identically to a guard with nothing to report.
  const p = { status: 'Active', ptype: 0, createdAt: 1, commitDeadline: 9999 };
  const r = votableNow(p, { now: 100, snapshotWeight: 5n });
  assert.equal(r.votable, false, 'an unanswerable question must not be answered "yes"');
  assert.match(r.reason, /currentWeight was not supplied/, 'name the missing input, not a symptom');
});

test('votableNow refuses on a missing snapshotWeight too, rather than falling through it', () => {
  // THE SAME FAIL-CLOSED RULE, APPLIED TO THE FIRST TERM. `undefined <= 0n` is `false`, so before
  // the null check covered both terms an omitted `snapshotWeight` skipped its own branch and the
  // predicate answered "votable" on an input it had never been given — fail OPEN on one term while
  // the other failed closed, three lines apart. Nothing in the suite caught it: every case above
  // either supplies both terms or omits `currentWeight`, so no test ever reached this path.
  const p = { status: 'Active', ptype: 0, createdAt: 1, commitDeadline: 9999 };
  const r = votableNow(p, { now: 100, currentWeight: 5n });
  assert.equal(r.votable, false, 'an unanswerable question must not be answered "yes"');
  assert.match(r.reason, /snapshotWeight was not supplied/, 'name the term that is missing, not the other one');
  assert.doesNotMatch(r.reason, /currentWeight was not supplied/, 'currentWeight WAS supplied — naming it sends the reader to the wrong caller');

  // And with neither term, the refusal names both rather than picking one.
  const neither = votableNow(p, { now: 100 });
  assert.equal(neither.votable, false);
  assert.match(neither.reason, /snapshotWeight and currentWeight were not supplied/);
});

// ───────── decodeProposal: the impure step that feeds votableNow (issue #178) ─────────
//
// Every votableNow case above hands the predicate a hand-built literal. In production its
// argument is a `readProposal` result, and `readProposal` derives `status` from
// `STATUS[Number(p[P.STATUS])]` (lib.mjs:483) after a live `cast` subprocess — so nothing in this
// file could reach that lookup. Respell an entry in STATUS and votableNow states a confident,
// wrong reason on every proposal while the suite stays green: the same silent failure the budget
// guard had before PR #177.
//
// `decodeProposal` is the pure half, split out of `readProposal` for exactly this. The two
// fixtures below are its input.
//
// PROVENANCE, stated precisely because a fixture that claims to be captured and is not is worse
// than no fixture. NEITHER TUPLE WAS CAPTURED FROM A CHAIN OR A LOG. `PROPOSAL_3_EXECUTED` is
// CONSTRUCTED around the four values this file already pins for the smoke vault's proposal 3 —
// createdAt 1788479808, commitDeadline 1788483408 and status Executed from the regression test
// above, and ptype 2 (ChildAllocation) from that test's own comment, which is a comment and not a
// chain read. The `vault` field is soak-vaults.json's `smokeVault.address`. The remaining ELEVEN
// fields, revealDeadline included, are synthetic: chosen only so that all sixteen decoded values
// are pairwise distinct, which is what makes an index shift in `P` change an asserted value
// instead of swapping two equal ones.

import { decodeProposal, STATUS, P, PROPOSAL_SIG } from '../soak/lib.mjs';

/** One cleaned `cast call` output line per tuple member, in `P` order — what `call()` returns. */
const PROPOSAL_3_EXECUTED = [
  '0xb940d71b0d695e2ba2b5853bf565c69daa3e3c98',                         // 0 vault
  '2',                                                                  // 1 ptype (ChildAllocation)
  '0x00000000000000000000000000000000000000b2',                         // 2 proposer (synthetic)
  '1788479808',                                                         // 3 createdAt
  '1788483408',                                                         // 4 commitDeadline
  '1788487008',                                                         // 5 revealDeadline (synthetic)
  '1788487009',                                                         // 6 executableAt (synthetic)
  '1788573408',                                                         // 7 expiresAt (synthetic)
  '4',                                                                  // 8 status (Executed)
  `0x${'ab'.repeat(32)}`,                                               // 9 actionHash (synthetic)
  '7000000000000000000',                                                // 10 snapshotTotal (synthetic)
  '5',                                                                  // 11 memberCount (synthetic)
  '6000000000000000000',                                                // 12 forWeight (synthetic)
  '1000000000000000000',                                                // 13 againstWeight (synthetic)
  '8000000000000000000',                                                // 14 revealedWeight (synthetic)
  '3',                                                                  // 15 revealedVoterCount (synthetic)
];

/** Wholly synthetic. Status byte 1, so it is the tuple that exercises `STATUS[1] === 'Active'`. */
const PROPOSAL_ACTIVE = [
  '0x00000000000000000000000000000000000000a1', '0',
  '0x00000000000000000000000000000000000000b2',
  '1000', '4600', '8200', '8201', '94600',
  '1',
  `0x${'11'.repeat(32)}`,
  '9000', '4', '0', '0', '0', '0',
];

test('decodeProposal maps every tuple index to its named field, and no two land on the same one', () => {
  const p = decodeProposal(PROPOSAL_3_EXECUTED);
  assert.deepEqual(
    {
      vault: p.vault, ptype: p.ptype, proposer: p.proposer, createdAt: p.createdAt,
      commitDeadline: p.commitDeadline, revealDeadline: p.revealDeadline,
      executableAt: p.executableAt, expiresAt: p.expiresAt, status: p.status,
      actionHash: p.actionHash, snapshotTotal: p.snapshotTotal, memberCount: p.memberCount,
      forWeight: p.forWeight, againstWeight: p.againstWeight, revealedWeight: p.revealedWeight,
      revealedVoterCount: p.revealedVoterCount,
    },
    {
      vault: '0xb940d71b0d695e2ba2b5853bf565c69daa3e3c98',
      ptype: 2,
      proposer: '0x00000000000000000000000000000000000000b2',
      createdAt: 1788479808,
      commitDeadline: 1788483408,
      revealDeadline: 1788487008,
      executableAt: 1788487009,
      expiresAt: 1788573408,
      status: 'Executed',
      actionHash: `0x${'ab'.repeat(32)}`,
      snapshotTotal: 7000000000000000000n,
      memberCount: 5,
      forWeight: 6000000000000000000n,
      againstWeight: 1000000000000000000n,
      revealedWeight: 8000000000000000000n,
      revealedVoterCount: 3,
    },
  );
  // The numeric fields are Numbers and the weight fields BigInts; `deepEqual` above is strict
  // about that, so a `Number`/`BigInt` swap in the decode is caught rather than coerced away.
  assert.equal(p.raw, PROPOSAL_3_EXECUTED, 'raw must carry the input lines through unchanged');
});

test('decodeProposal feeds votableNow the Executed status that stalled the 2026-09-04 run', () => {
  // END TO END ACROSS THE SEAM, which is the whole point of issue #178: the decoded object goes
  // straight into the predicate, so `STATUS[4]` and `p.status !== 'Active'` are pinned to each
  // other rather than each to a literal.
  const p = decodeProposal(PROPOSAL_3_EXECUTED);
  const r = votableNow(p, { now: 1788534622, snapshotWeight: 0n, currentWeight: 0n });
  assert.equal(r.votable, false);
  assert.match(r.reason, /status is Executed/,
    'a respelt STATUS[4] would print "status is undefined" here');
});

test('decodeProposal produces the exact Active string votableNow compares against', () => {
  // THE MUTATION ISSUE #178 DESCRIBES. `votableNow` tests `p.status !== 'Active'` against a string
  // that only `STATUS` produces. Respell `STATUS[1]` — 'Active' -> 'Activ' — and every proposal
  // becomes unvotable with the confident reason "status is Activ, not Active"; before this test
  // the whole suite stayed green through that mutation, because no test ever produced a status
  // string with the decoder.
  assert.equal(STATUS[1], 'Active', 'the literal the predicate compares against, at its source');

  const p = decodeProposal(PROPOSAL_ACTIVE);
  assert.equal(p.status, 'Active');
  assert.deepEqual(
    votableNow(p, { now: 1200, snapshotWeight: 3n, currentWeight: 3n }),
    { votable: true, reason: '' },
    'a decoded Active proposal inside its commit window must be votable',
  );
});

test('the P index map still matches the arity of PROPOSAL_SIG and uses each index exactly once', () => {
  // A fixture is only evidence if it has the shape the signature returns. `cast call` prints one
  // line per return value, so the tuple length and the highest index in `P` must agree with the
  // signature `readProposal` actually sends.
  //
  // ORDER IS NOT ASSERTED HERE, and the name no longer says it is: `PROPOSAL_SIG` is parsed for
  // its comma count only, so swapping two entries in `P` leaves every assertion below green. The
  // order pin is the sibling test above — `decodeProposal maps every tuple index to its named
  // field` — which reds on exactly that swap because the fixture's sixteen values are distinct.
  // A positional type check could not replace it anyway: the signature has five `uint64`s and six
  // `uint256`s, so same-typed neighbours are indistinguishable from the type list.
  const returns = /\)\(([^)]*)\)$/.exec(PROPOSAL_SIG);
  assert.ok(returns, 'PROPOSAL_SIG must still declare a return tuple');
  const arity = returns[1].split(',').length;
  assert.equal(arity, 16, 'proposals(uint256) returns sixteen values');
  assert.equal(PROPOSAL_3_EXECUTED.length, arity, 'the fixture must be one line per return value');
  assert.equal(PROPOSAL_ACTIVE.length, arity);
  assert.equal(Math.max(...Object.values(P)), arity - 1, 'P must not index past the tuple');
  assert.equal(new Set(Object.values(P)).size, arity, 'every index used exactly once');
  assert.equal(new Set(PROPOSAL_3_EXECUTED).size, arity,
    'the fixture values must be pairwise distinct, or an index swap decodes identically');
});

test('the two seams the fixture cannot execute are pinned as source text instead', () => {
  // WHAT A FIXTURE CANNOT REACH. `readProposal` runs `cast` in a subprocess and drill 5 executes
  // at import, so neither can be driven in-process. Mutation confirmed the gap is real: making
  // `readProposal` drop the first output line before decoding, and making drill 5 pass its
  // already-minimised weight again, each left all other tests in this file green. These are
  // text-and-order pins over the source, the same instrument the run-soak.ps1 tests below use,
  // and they catch the defect that actually happens here — an edit that re-introduces the
  // pre-#178 shape in a file no test executes.
  const lib = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'lib.mjs'), 'utf8');
  assert.match(lib, /return decodeProposal\(call\(governance, PROPOSAL_SIG, pid\)\);/,
    'readProposal must hand call()\'s lines to decodeProposal unaltered, or the fixture pins a decoder nothing uses');

  const drill5 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill5-agent-execute.mjs'), 'utf8');
  assert.match(drill5, /votableNow\(prop, \{ now: chainNow\(\), snapshotWeight: snap, currentWeight: cur \}\)/,
    'drill 5 must pass BOTH terms unbounded — handing it the min again restores the wrong-cause message');
  assert.match(drill5, /const boundedWeight = snap < cur \? snap : cur;/,
    'the local min is still what the diagnostic line prints as boundedWeight');
});

// ───────── the launcher wiring: run-soak.ps1 must actually start the companion ─────────
//
// The votability gate taught drill 5 to say "no votable round" instead of stalling for 40 ticks,
// and the message it prints names drill5-gov-companion.mjs. Nothing started that script, so the
// diagnostic was correct and the run still could not proceed.
//
// These are text-and-order pins over the PowerShell, not execution: CI runs on ubuntu-latest and
// run-soak.ps1 is PowerShell, so no node test can run it. What they CAN catch is the defect that
// actually happens here — a launcher edit that drops a step, reorders one, or leaves a claim about
// the launcher standing in a file nobody thought to update.

const SOAK_DIR = path.join(LIB_ROOT, 'scripts', 'soak');
const RUN_SOAK = fs.readFileSync(path.join(SOAK_DIR, 'run-soak.ps1'), 'utf8');
const DRILL5 = fs.readFileSync(path.join(SOAK_DIR, 'drill5-agent-execute.mjs'), 'utf8');

/** Index of the first match, asserting the anchor still exists rather than silently yielding -1. */
const anchorAt = (re, what) => {
  const m = re.exec(RUN_SOAK);
  assert.ok(m, `run-soak.ps1 no longer contains ${what} — this test lost its anchor`);
  return m.index;
};

const PS_JOIN = /New-NodeStep 'scripts\/soak\/drill5-agent-execute\.mjs' 'join'/;
const PS_ACTIVATE = /New-NodeStep 'scripts\/soak\/drill5-agent-execute\.mjs' 'activate'/;
const PS_COMPANION = /Start-Process[^\n]*drill5-gov-companion\.mjs/;
const PS_VOTE = /New-NodeStep 'scripts\/soak\/drill5-agent-execute\.mjs'\s*$/m;
const PS_WAIT = /\$comp\.WaitForExit\(\)/;

test('run-soak.ps1 starts the governance companion, between drill 5 activating and voting', () => {
  // The ordering is FORCED, not a preference: drill5-gov-companion.mjs refuses to propose until
  // the agent holds shares (voting weight snapshots at createdAt-1), and drill 5's vote phase
  // refuses to tick until a votable round exists. Each is the other's precondition, so the only
  // sequence satisfying both puts the companion between activate and vote.
  const iJoin = anchorAt(PS_JOIN, "drill 5's join step");
  const iActivate = anchorAt(PS_ACTIVATE, "drill 5's activate step");
  const iComp = anchorAt(PS_COMPANION, 'the companion launch');
  const iVote = anchorAt(PS_VOTE, "drill 5's phase-less vote+exit step");
  const iWait = anchorAt(PS_WAIT, 'the wait for the companion');
  assert.ok(iJoin < iActivate, 'join must precede activate');
  assert.ok(iActivate < iComp, 'the companion cannot propose before the agent holds shares');
  assert.ok(iComp < iVote, 'drill 5 has nothing to vote on until the companion has raised a round');
  assert.ok(iVote < iWait, 'the companion settles the agent exit, so track B waits for it LAST');
});

test('run-soak.ps1 waits for the round to exist before drill 5 goes looking for it', () => {
  // Backgrounding the companion and immediately running drill 5 loses a race that the vote gate
  // would report as a governance problem. The launcher waits on the companion's own state file,
  // which records steps.propose.done only after the proposal id is confirmed on chain.
  const region = RUN_SOAK.slice(
    anchorAt(PS_COMPANION, 'the companion launch'),
    anchorAt(PS_VOTE, "drill 5's phase-less vote+exit step"),
  );
  assert.match(region, /Test-Path '\$compState'/, 'the wait must key on the companion state file');
  assert.match(region, /steps\.propose\.done/, 'propose is the step drill 5 depends on');
  assert.match(region, /AddMinutes\(\d+\)/, 'an unbounded wait would hang track B on a dead companion');

  // And $compState must resolve the way drill5-gov-companion.mjs does — SOAK_STATE_DIR, else
  // <repo>/scripts/soak — or the launcher watches a file nobody writes and always times out.
  assert.match(RUN_SOAK, /\$compStateDir = if \(\$env:SOAK_STATE_DIR\) \{ \$env:SOAK_STATE_DIR \} else \{ Join-Path \$Root 'scripts\\soak' \}/);
  assert.match(RUN_SOAK, /\$compState = Join-Path \$compStateDir '\.state-drill5gov\.json'/);
});

test('a companion that cannot raise a round is logged, and never masks drill 5', () => {
  const region = RUN_SOAK.slice(
    anchorAt(PS_COMPANION, 'the companion launch'),
    anchorAt(PS_VOTE, "drill 5's phase-less vote+exit step"),
  );
  // `exit $LASTEXITCODE` is how New-NodeStep abandons a track. This region must not use it:
  // drill 5's own round-availability diagnostic is the evidence that belongs on the record.
  assert.doesNotMatch(region, /exit \$LASTEXITCODE/, 'the launcher must not abort track B here');
  assert.match(region, /HasExited/, 'a dead companion must be detected, not waited out');
  assert.match(region, /running drill 5 anyway/, 'say plainly that drill 5 still runs');
});

test('the companion logs beside the other drills, and its pid is in the file -Stop reads', () => {
  // "must not outlive the run" reduces to exactly this. run-soak.ps1 has no automatic
  // password-file wipe — it PRINTS a Remove-Item for the operator — and Start-Process detaches the
  // companion, so killing track B's powershell would not reach it. The pid-file entry is the
  // whole guarantee.
  assert.match(RUN_SOAK, /Join-Path \$LogDir 'gov-companion\.log'/);
  assert.match(RUN_SOAK, /Join-Path \$LogDir 'gov-companion\.err\.log'/);
  assert.match(RUN_SOAK, /Add-Content -Path '\$PidFile' -Value \('gov-companion='/);
  assert.match(RUN_SOAK, /if \(\$Stop\) \{[\s\S]*?Get-Content \$PidFile[\s\S]*?Stop-Process/,
    '-Stop must still be the thing that reads the pid file');
});

test('the x402 session cap covers a whole poll window, and launcher and drill agree on it', () => {
  // Derived, not asserted. The 2026-09-04 run spent $0.25 by tick 5 of 40, so a tick costs $0.05
  // and the 40-tick window needs $2.00 — the same arithmetic budgetExhaustedFailure prints.
  const OBSERVED_SPEND = 0.25;
  const OBSERVED_TICK = 5;
  const WINDOW_TICKS = 40;
  const needed = (OBSERVED_SPEND / OBSERVED_TICK) * WINDOW_TICKS;
  assert.equal(needed, 2, 'the observed rate must still work out to $2.00 for 40 ticks');

  const inDrill = /SOAK_AGENT_CAP_USDC \?\? '([0-9.]+)'/.exec(DRILL5);
  assert.ok(inDrill, 'drill 5 must still carry a default cap');
  const inPs1 = /\$env:SOAK_AGENT_CAP_USDC = '([0-9.]+)'/.exec(RUN_SOAK);
  assert.ok(inPs1, 'run-soak.ps1 must state the cap rather than inherit it silently');

  assert.equal(Number(inPs1[1]), Number(inDrill[1]),
    'a launcher that sets a different cap than the drill defaults to is two answers to one question');
  assert.ok(Number(inDrill[1]) >= needed,
    `cap $${inDrill[1]} does not cover ${WINDOW_TICKS} ticks at the observed rate ($${needed.toFixed(2)})`);
  assert.match(RUN_SOAK, /if \(-not \$env:SOAK_AGENT_CAP_USDC\)/, 'an operator override must survive');
  assert.match(RUN_SOAK, /Write-Host "  SOAK_AGENT_CAP_USDC = /, 'the operator has to SEE the cap');
});

test('drill 5 documents SOAK_AGENT_CAP_USDC among its optional env', () => {
  const doc = DRILL5.slice(0, DRILL5.indexOf('*/'));
  assert.match(doc, /Env \(optional\)[\s\S]*?SOAK_AGENT_CAP_USDC/,
    'a knob a failure message tells the operator to set must be listed where they look for knobs');
});

// The NEGATIVE guard, and the one that matters most. A positive list can only ever require too
// little; a negative guard must enumerate from the filesystem, because the stale claim arrives in
// the file nobody added to a list. Same reasoning as config-doc-truth.test.mjs's header.
//
// Text is normalized first: the claim this replaces lived across two string concatenations
// ("...run-soak.ps1 does\n' + '  not start it."), so matching raw source would miss it.
const CLAIM_SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'lib', 'out', 'cache', 'broadcast', 'coverage', 'logs', 'data']);
const CLAIM_EXTS = ['.md', '.mjs', '.js', '.ps1', '.json', '.txt', '.html'];
const NOT_STARTED_SHAPES = [
  /run-soak(\.ps1)?\s+(does not|doesn.t|will not|won.t|cannot|can.t|never)\s+(start|launch|run)/i,
  /(not|never)\s+(started|launched|run)\s+by\s+run-soak/i,
];

test('no file still claims run-soak.ps1 does not start the companion', () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!CLAIM_SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (CLAIM_EXTS.some((e) => entry.name.endsWith(e))) {
        files.push(path.join(dir, entry.name));
      }
    }
  })(LIB_ROOT);
  assert.ok(files.length > 50, `the walker found only ${files.length} files — it is not walking the repo`);

  const offenders = [];
  for (const file of files) {
    if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue;
    const normalized = fs.readFileSync(file, 'utf8')
      .replace(/\\n/g, ' ').replace(/['"`+]/g, ' ').replace(/\s+/g, ' ');
    for (const shape of NOT_STARTED_SHAPES) {
      const m = shape.exec(normalized);
      if (m) offenders.push(`${path.relative(LIB_ROOT, file)}: "${m[0]}"`);
    }
  }
  assert.deepEqual(offenders, [], 'run-soak.ps1 starts drill5-gov-companion.mjs — these say otherwise');
});

// ───────── ROOT survives a checkout path containing a space ─────────

test('lib.mjs ROOT resolves a checkout whose path contains a space to a real directory', () => {
  // `new URL(import.meta.url).pathname` hands back the path PERCENT-ENCODED, so a checkout at
  // `.../sp ace/` yields `.../sp%20ace/` — a directory that does not exist. Every drill joins ROOT
  // to reach the address book at module scope (`scripts/soak/drill1-multivault.mjs:37`), so
  // `loadDeployment` throws "deployment: address book not found at ..."
  // (`scripts/soak/deployment.mjs:134`) at load, before any drill's own skip logic can run. The
  // encoding is not Windows-only: only the drive-letter strip in the old expression was, so this
  // asserts nothing platform-shaped.
  //
  // Reproduced by copying lib.mjs and its single non-builtin import into a scratch tree whose
  // path contains a space, then reading ROOT back out of a child process. The child's import
  // specifier is built with pathToFileURL rather than string concatenation, so the harness cannot
  // reintroduce the very encoding bug under test.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-space-'));
  const root = path.join(scratch, 'sp ace');
  const copies = [
    ['scripts', 'soak', 'lib.mjs'],
    ['packages', 'canary', 'src', 'call-error.mjs'],
  ];
  try {
    const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    for (const rel of copies) {
      fs.mkdirSync(path.join(root, ...rel.slice(0, -1)), { recursive: true });
      fs.copyFileSync(path.join(repo, ...rel), path.join(root, ...rel));
    }
    // A file reachable ONLY by joining onto ROOT, standing in for the address book.
    fs.writeFileSync(path.join(root, 'marker.txt'), 'root-relative read');

    const target = pathToFileURL(path.join(root, 'scripts', 'soak', 'lib.mjs')).href;
    const src = `
      import fs from 'node:fs';
      import path from 'node:path';
      const m = await import(${JSON.stringify(target)});
      const exists = fs.existsSync(m.ROOT);
      console.log(JSON.stringify({
        root: m.ROOT,
        exists,
        marker: exists ? fs.readFileSync(path.join(m.ROOT, 'marker.txt'), 'utf8') : null,
      }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop());

    assert.equal(r.root, root, 'ROOT must be the real directory, not a percent-encoded twin of it');
    assert.ok(!r.root.includes('%20'), 'a space must arrive decoded — %20 names no directory');
    assert.equal(r.exists, true, 'ROOT must exist, or every path joined onto it is unreadable');
    assert.equal(r.marker, 'root-relative read',
      'a file addressed through ROOT must open — this is the read the address book load performs');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
