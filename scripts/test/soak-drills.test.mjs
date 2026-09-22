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

/**
 * For the selector drift guard: viem and the compiled ABIs.
 *
 * NEITHER IS OPTIONAL, which is a correction rather than a change of policy. `viem` is a root
 * dependency (`package.json`, `dependencies`), so it is absent only in a checkout with no
 * `npm install` — in which `node --test` does not run at all. `contracts/out` is produced by
 * `npm run build:contracts`, which `npm run gate` and `.github/workflows/ci.yml` both run before
 * `npm run test:backend`. The import is still wrapped so a missing module produces this file's own
 * failure message instead of an unhandled rejection at import time, when `test()` has not yet been
 * reached and node reports the whole file as failing to load.
 */
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
  //
  // THIS NO LONGER SKIPS, AND THE SHAPE IT REPLACED WAS WORSE THAN A SKIP. It read
  //
  //     console.log('# skipped: needs viem and `forge build` artifacts');
  //     return;
  //
  // and `node:test` counts a bare return as a PASS. It does not appear in the skipped count, so
  // this suite reported `104 tests, 104 pass, skipped 0` — a line that would have looked identical
  // if this check had silently stopped running. That is precisely the false green the docstring
  // above says must not happen to this particular assertion.
  //
  // The precedent is two files away: `contracts-size-truth.test.mjs` carries a standalone test
  // named "contracts/out exists — this guard must never skip its way to green", whose message says
  // a skipped check "is indistinguishable from a passing one". This asserts its own inputs for the
  // same reason rather than leaning on that one, because a cross-file anchor is a dependency
  // nobody reading this file can see.
  assert.ok(viem, 'viem is a root dependency and this guard needs it — run `npm install`');
  assert.ok(
    ORACLE_ABI.length && VAULT_ABI.length,
    'contracts/out is missing or incomplete, so the pinned selectors cannot be recomputed from the\n' +
      'compiled ABIs and this guard would otherwise report a pass over nothing.\n' +
      'Run `npm run build:contracts` (or `npm run gate`, which builds first).\n' +
      `  ChainlinkOracle: ${ORACLE_ABI.length} entries\n  VaultCore: ${VAULT_ABI.length} entries`,
  );
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

test('a not-OK `sequencer` row does NOT count as the canary tracking a freeze', () => {
  // PR #89 added a per-vault `sequencer` row under the `oracle-freshness` signal name. Where
  // sequencerUptimeFeed is address(0) that row was permanently `skipped` — under the old
  // `rows.some(r => r.status !== 'ok')` it satisfied the assertion by itself, whether or not any
  // asset row ever left OK. That is a drill certifying nothing while exiting 0. The canary now
  // reports that case as not-applicable `ok`, so this exact fixture is a state file written by an
  // older build; the guard is kept because the exclusion must hold on STATUS-blind grounds — the
  // `flavor` row below is `skipped` today and would otherwise walk straight back through.
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

test('drill 4 does not claim the sequencer row is permanently skipped on a zero-feed oracle', () => {
  // WHY A TEXT PIN. The two comments above describe an allowlist whose only runtime consumer is
  // drill4-oraclefreeze.mjs, which executes at import and prints this rationale in the assertion
  // message it fails with — so no fixture in this file reaches that prose. Nor does a guard:
  // scripts/test/config-doc-truth.test.mjs and scripts/test/claims-lede-truth.test.mjs walk
  // `.md`/`.html`/`.txt`/`.json`, and `.mjs` is in neither set. This is a text pin over the
  // source, the same instrument the run-soak.ps1 tests below use, and it catches the defect that
  // did happen: the claim was rewritten here and in series-analysis.mjs and left standing in the
  // drill. On a zero `sequencerUptimeFeed` the leg returns `notApplicable`
  // (packages/canary/src/signals/oracle-health.mjs:266), which is an `ok`, so a present-tense
  // "permanently skipped" is false about the deployment the drill actually runs against.
  const drill4 = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'soak', 'drill4-oraclefreeze.mjs'),
    'utf8',
  );
  assert.doesNotMatch(drill4, /sequencer row is permanently skipped/,
    'the sequencer row on a zero-feed oracle now reports ok (not-applicable), never skipped');
  assert.match(drill4, /neither evidences anything about an asset/,
    'the exclusion rests on status-blind grounds, so the rationale must survive the status change — without this the pin above would also pass on a deleted message');
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
  // Not 'the first execution is mainnet': a mainnet deployment on Robinhood Chain did not discharge
  // this, because Chainlink publishes no uptime feed for chain 4663 to wire.
  assert.equal(
    q.exercised,
    false,
    'an unconfigured feed means this code never runs; a first execution waits for a chain that has one',
  );
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

test('SOAK_RPC outranks BASE_SEPOLIA_RPC, which still works on its own', () => {
  // Drill 5's viem writes go to whatever this returns while its cast reads go to lib.mjs's `RPC`.
  // The two resolve in the same order, so an operator who sets only the new name, or only the old
  // one, gets one endpoint rather than two.
  assert.equal(resolveAgentRunConfig({ ...okEnv, SOAK_RPC: 'https://a.example' }).rpcUrl, 'https://a.example');
  assert.equal(resolveAgentRunConfig({ ...okEnv, BASE_SEPOLIA_RPC: 'https://b.example' }).rpcUrl, 'https://b.example');
  assert.equal(
    resolveAgentRunConfig({ ...okEnv, SOAK_RPC: 'https://a.example', BASE_SEPOLIA_RPC: 'https://b.example' }).rpcUrl,
    'https://a.example', 'SOAK_RPC wins when both are set');
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

import {
  withSendLock, ROOT as LIB_ROOT, budgetExhaustedFailure, votableNow, revealableNow, cooldownWait,
  decideReveal,
} from '../soak/lib.mjs';

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

// ───────── assertLogsServed: a pruning RPC must be loud, not silent ─────────

// A stand-in for `cast`, answering only the four subcommands the probe uses. `SERVE_LOGS` decides
// whether `cast logs` returns the VaultCreated announcing allVaults[0] or an empty string — which
// is exactly the difference between a full-history provider and a pruning one, and exactly the
// difference that carries no error, no warning and no other tell.
//
// It is loaded with `--require`, and `CAST` is set to node itself, so `cast <args>` becomes
// `node <args>` with this preloaded: it reads argv, prints, and exits before node can complain
// that `logs` is not a script. That works identically on Windows, which has no shebang.
const FAKE_CAST_SRC = `
const a = process.argv.slice(1);
// NODE resolves argv[1] to an absolute path before the preload sees it, so the subcommand
// arrives as C:\\...\\call rather than 'call'. Take the basename.
const sub = String(a[0] || '').replace(/\\\\/g, '/').split('/').pop();
// The preload lands in EVERY node process that inherits NODE_OPTIONS, the driver that spawns
// the fake cast included. A driver invoked with -e has no argv[1], so anything that does not
// look like a cast subcommand is passed straight through. Without this the preload exits the
// driver before it can run the probe at all.
if (a.length && !sub.startsWith('-')) {
const VAULT = '0xb940d71b0d695e2ba2b5853bf565c69daa3e3c98';
const TOPIC0 = '0x4dda9a6d0ba03769e9813c47681795a7210f951e6ef31e64772e13b9ea0f1406';
let out = '';
if (sub === 'keccak') out = TOPIC0;
else if (sub === 'block-number') out = '46610832';
else if (sub === 'call' && String(a[2]).startsWith('vaultCount')) out = '1';
else if (sub === 'call' && String(a[2]).startsWith('allVaults')) out = VAULT;
else if (sub === 'logs') {
  // A pruning endpoint returns an empty result and exit 0. That is the whole hazard.
  out = process.env.SERVE_LOGS === '1'
    ? '- address: 0xC1cb782471e506c71ae91feB91AdCEFc34A99743\\n  topics: [\\n\\t' + TOPIC0
      + '\\n\\t0x000000000000000000000000' + VAULT.slice(2) + '\\n  ]'
    : '';
} else { process.exit(3); }
if (out) process.stdout.write(out + '\\n');
process.exit(0);
}
`;

function runLogsProbe(serveLogs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-logsprobe-'));
  const stub = path.join(dir, 'fake-cast.cjs');
  fs.writeFileSync(stub, FAKE_CAST_SRC);
  const src = `
    const { assertLogsServed } = await import(${JSON.stringify(new URL('../soak/lib.mjs', import.meta.url).href)});
    assertLogsServed('0xc1cb782471e506c71ae91feb91adcefc34a99743', 46307173, { chunk: 50000, maxChunks: 2 });
    console.log('PROBE_RETURNED');
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAST: process.execPath,
        NODE_OPTIONS: `--require ${JSON.stringify(stub)}`,
        SERVE_LOGS: serveLogs ? '1' : '0',
        SOAK_RPC: 'http://stub.invalid',
      },
    });
    return { exit: 0, out, err: '' };
  } catch (e) {
    return { exit: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('assertLogsServed PASSES when the endpoint serves the positive control', () => {
  const r = runLogsProbe(true);
  assert.equal(r.exit, 0, `the probe must not fail a serving endpoint: ${r.err}`);
  assert.match(r.out, /PROBE_RETURNED/);
  assert.match(r.out, /serves historical logs/);
});

test('assertLogsServed FAILS when the endpoint returns no logs for a range that provably has one', () => {
  // THIS IS THE TEST FOR THE 2026-09-09 MISTAKE. The soak's then-default RPC returned nothing for a
  // range containing the VaultCreated that announced the pinned smoke vault, and the emptiness was
  // read as "the factory never announced it" — a conclusion written into this repository as a chain
  // reading and shipped in a pull request. Nothing in the run could have caught it, because an empty
  // log response is exactly what a range with no events returns. The probe is the positive control
  // that tells the two apart; this test is what stops it going inert the way the freeze-safety leg
  // did.
  const r = runLogsProbe(false);
  assert.notEqual(r.exit, 0, 'a pruning endpoint MUST fail the run, not be trusted');
  assert.doesNotMatch(r.out, /PROBE_RETURNED/, 'the probe must not return on a pruning endpoint');
  const said = r.out + r.err;
  assert.match(said, /SERVED NO LOG FOR A RANGE THAT PROVABLY CONTAINS ONE/);
  assert.match(said, /allVaults\[0\] is 0xb940d71b/, 'the message must name the control it looked for');
  assert.match(said, /sepolia\.base\.org/, 'the message must name an endpoint that does serve it');
});

// ───────── send(): issue #214, retry the estimation preflight, never the broadcast ─────────

// A stand-in for `cast`, answering only `send` and `block-number` — the two subcommands
// `send()` invokes. Same technique as FAKE_CAST_SRC above: CAST is pointed at node itself and
// this is preloaded with `--require`, so `cast <args>` becomes `node <args>` with this file
// deciding the outcome before node can complain about the subcommand not being a script.
//
// `FAKE_SEND_FAIL_COUNT` invocations of `send` fail before the (fail_count + 1)th succeeds.
// `FAKE_SEND_FAIL_KIND` picks the wording: 'estimate' reproduces the exact string from issue
// #214 ("Failed to estimate gas: execution reverted, data: 0x"), 'timeout' is a plausible
// POST-broadcast-shaped failure (a receipt-wait timeout) that must NEVER be retried by this
// code path. `FAKE_SEND_COUNTER_FILE` persists the call count ACROSS process invocations —
// each `cast()` call is a fresh child process — so a test can assert exactly how many times
// `send` was actually invoked, which is the only way to prove a failure was retried the right
// number of times, or not retried at all.
const FAKE_CAST_SEND_SRC = `
const a = process.argv.slice(1);
// See FAKE_CAST_SRC's note above: node resolves argv[1] to an absolute path before the preload
// sees it, so take the basename to recover the subcommand.
const sub = String(a[0] || '').replace(/\\\\/g, '/').split('/').pop();
if (a.length && !sub.startsWith('-')) {
const fs = require('fs');
if (sub === 'send') {
  const counterFile = process.env.FAKE_SEND_COUNTER_FILE;
  let n = 0;
  try { n = Number(fs.readFileSync(counterFile, 'utf8')) || 0; } catch {}
  n += 1;
  fs.writeFileSync(counterFile, String(n));
  const failCount = Number(process.env.FAKE_SEND_FAIL_COUNT || '0');
  if (n <= failCount) {
    const kind = process.env.FAKE_SEND_FAIL_KIND || 'estimate';
    const msg = kind === 'estimate'
      ? 'Error: Failed to estimate gas: execution reverted, data: 0x'
      : 'Error: error sending request for url (http://stub.invalid/): operation timed out';
    process.stderr.write(msg + '\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ status: '0x1', transactionHash: '0xabc123', blockNumber: '0x64' }) + '\\n');
  process.exit(0);
} else if (sub === 'block-number') {
  process.stdout.write('100\\n');
  process.exit(0);
} else {
  process.exit(3);
}
}
`;

/**
 * @param {{failCount?: number, failKind?: 'estimate'|'timeout'}} opts
 * @returns {{ok: boolean, status?: string, message?: string, calls: number, log: string}}
 */
function runSendProbe({ failCount = 0, failKind = 'estimate' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-sendprobe-'));
  const stub = path.join(dir, 'fake-cast-send.cjs');
  fs.writeFileSync(stub, FAKE_CAST_SEND_SRC);
  const counterFile = path.join(dir, 'send-count.txt');
  const src = `
    process.env.SOAK_SIGNER_ARGS = '--account test';
    const { send } = await import(${JSON.stringify(new URL('../soak/lib.mjs', import.meta.url).href)});
    try {
      const r = send('probe', '0x0000000000000000000000000000000000000001', 'createVault(string)', 'soak-test');
      console.log(JSON.stringify({ ok: true, status: r.status }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, message: e.message }));
    }
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAST: process.execPath,
        NODE_OPTIONS: `--require ${JSON.stringify(stub)}`,
        SOAK_RPC: 'http://stub.invalid',
        FAKE_SEND_COUNTER_FILE: counterFile,
        FAKE_SEND_FAIL_COUNT: String(failCount),
        FAKE_SEND_FAIL_KIND: failKind,
      },
    });
    const last = out.trim().split('\n').pop();
    const calls = Number(fs.readFileSync(counterFile, 'utf8') || '0');
    return { ...JSON.parse(last), calls, log: out };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('send() retries a gas-estimation preflight failure and succeeds once a later attempt is clean', () => {
  // The exact wording from the 2026-09-05 soak: "Failed to estimate gas: execution reverted,
  // data: 0x". Fails twice, succeeds on the third of SEND_ESTIMATE_MAX_ATTEMPTS (3).
  const r = runSendProbe({ failCount: 2, failKind: 'estimate' });
  assert.equal(r.ok, true, `send() must recover once a retry succeeds: ${r.message}`);
  assert.equal(r.status, '0x1');
  assert.equal(r.calls, 3, 'exactly two failed sends and one successful send must have run');
  assert.match(r.log, /gas estimation failed on attempt 1\/3/);
  assert.match(r.log, /gas estimation failed on attempt 2\/3/);
  assert.match(r.log, /nothing has been\s+broadcast yet/);
});

test('send() gives up after its bounded retry budget on a persistent estimation failure', () => {
  // Never-succeeding version of the same wording. The retry must be BOUNDED — this is the test
  // that would fail if the loop above ever lost its `attempt >= SEND_ESTIMATE_MAX_ATTEMPTS` exit.
  const r = runSendProbe({ failCount: 99, failKind: 'estimate' });
  assert.equal(r.ok, false, 'a persistent estimation failure must eventually fail the drill');
  assert.match(r.message, /Failed to estimate gas/);
  assert.equal(r.calls, 3, 'must stop at SEND_ESTIMATE_MAX_ATTEMPTS, not retry forever');
});

test('send() does NOT retry a failure that is not the gas-estimation phase', () => {
  // THE SAFETY PROPERTY. A receipt-wait timeout is exactly the shape of failure that can follow
  // a transaction that WAS already broadcast — retrying it risks the double-send the brief
  // warns about. `classifyCallError` cannot be the gate here either way (see the comment above
  // `send()` in lib.mjs): this proves the code retries on the PHASE marker alone, and does
  // nothing at all — not even one extra call — for wording that does not carry it.
  const r = runSendProbe({ failCount: 99, failKind: 'timeout' });
  assert.equal(r.ok, false, 'a non-estimation failure must still fail the drill');
  assert.match(r.message, /operation timed out/);
  assert.equal(r.calls, 1, 'a non-estimation failure must be reported on the FIRST attempt, never retried');
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

// ───────── revealableNow: the reveal-phase analogue of votableNow (drill 2) ─────────
//
// Measured live 2026-09-21/22: drill 2 resumed after a long stop, re-read its OWN persisted
// revealDeadline, and called revealVote straight into a WrongPhase revert — proposal 12,
// revealDeadline=1790042522, chain now at the failing call 1790046852, 4330s (72 min) past it.
// The guard the commit window already had (votableNow, above) had no equivalent for reveal.

test('revealableNow rejects a settled proposal that activeProposalOf still names', () => {
  const r = revealableNow(
    { status: 'Defeated', commitDeadline: 1000, revealDeadline: 2000 },
    { now: 2500, hasCommit: true, alreadyRevealed: false },
  );
  assert.equal(r.revealable, false);
  assert.match(r.reason, /status is Defeated/);
  assert.match(r.reason, /never clears that mapping/, 'the reason must name the mechanism, not just the symptom');
});

test('revealableNow rejects THE MEASURED DEFECT: an Active proposal whose reveal window has closed', () => {
  // Proposal 12, verbatim: revealDeadline=1790042522, chain now at the failing call 1790046852.
  const r = revealableNow(
    { status: 'Active', commitDeadline: 1790038922, revealDeadline: 1790042522 },
    { now: 1790046852, hasCommit: true, alreadyRevealed: false },
  );
  assert.equal(r.revealable, false);
  assert.match(r.reason, /reveal window closed 4330s ago/, 'say how stale, not just that it is stale');
});

test('revealableNow rejects too-early: still in the commit phase', () => {
  const r = revealableNow(
    { status: 'Active', commitDeadline: 1000, revealDeadline: 2000 },
    { now: 500, hasCommit: true, alreadyRevealed: false },
  );
  assert.equal(r.revealable, false);
  assert.match(r.reason, /still in the commit phase/);
});

test('revealableNow rejects at the EXACT reveal deadline, matching revealVote (< not <=)', () => {
  const p = { status: 'Active', commitDeadline: 1000, revealDeadline: 2000 };
  assert.equal(revealableNow(p, { now: 2000, hasCommit: true, alreadyRevealed: false }).revealable, false,
    'now === revealDeadline is CLOSED');
  assert.equal(revealableNow(p, { now: 1999, hasCommit: true, alreadyRevealed: false }).revealable, true,
    'one second earlier is open');
  assert.equal(revealableNow(p, { now: 1000, hasCommit: true, alreadyRevealed: false }).revealable, true,
    'now === commitDeadline is already OPEN (revealVote requires >=)');
  assert.equal(revealableNow(p, { now: 999, hasCommit: true, alreadyRevealed: false }).revealable, false,
    'one second before commitDeadline is still the commit phase');
});

test('revealableNow rejects when no commitment was recorded', () => {
  const r = revealableNow(
    { status: 'Active', commitDeadline: 1000, revealDeadline: 2000 },
    { now: 1500, hasCommit: false, alreadyRevealed: false },
  );
  assert.equal(r.revealable, false);
  assert.match(r.reason, /no commitment is recorded/);
  assert.match(r.reason, /NoCommit/, 'name the revert the voter would actually hit');
});

test('revealableNow rejects a voter who has already revealed', () => {
  const r = revealableNow(
    { status: 'Active', commitDeadline: 1000, revealDeadline: 2000 },
    { now: 1500, hasCommit: true, alreadyRevealed: true },
  );
  assert.equal(r.revealable, false);
  assert.match(r.reason, /already revealed/);
  assert.match(r.reason, /AlreadyRevealed/, 'name the revert the voter would actually hit');
});

test('revealableNow accepts a genuinely revealable round, and only then — the non-firing branch', () => {
  // A healthy in-window reveal must NOT trigger recovery. This is the case drill 2 hits on every
  // normal, non-interrupted run, so it must stay green.
  const p = { status: 'Active', commitDeadline: 1000, revealDeadline: 2000 };
  assert.deepEqual(
    revealableNow(p, { now: 1500, hasCommit: true, alreadyRevealed: false }),
    { revealable: true, reason: '' },
  );
  assert.equal(revealableNow(null, { now: 1500, hasCommit: true, alreadyRevealed: false }).revealable, false);
});

test('revealableNow refuses rather than guesses when alreadyRevealed is not supplied', () => {
  // FAIL CLOSED ON A MISSING INPUT, matching votableNow's convention: `undefined` read as falsy
  // would silently mean "not yet revealed" — the fail-OPEN direction — so this must refuse by
  // name rather than fall through as votable.
  const p = { status: 'Active', commitDeadline: 1000, revealDeadline: 2000 };
  const r = revealableNow(p, { now: 1500, hasCommit: true });
  assert.equal(r.revealable, false, 'an unanswerable question must not be answered "yes"');
  assert.match(r.reason, /alreadyRevealed was not supplied/, 'name the missing input, not a symptom');
});

test('revealableNow refuses on a missing hasCommit too, rather than falling through it', () => {
  const p = { status: 'Active', commitDeadline: 1000, revealDeadline: 2000 };
  const r = revealableNow(p, { now: 1500, alreadyRevealed: false });
  assert.equal(r.revealable, false, 'an unanswerable question must not be answered "yes"');
  assert.match(r.reason, /hasCommit was not supplied/, 'name the term that is missing, not the other one');
  assert.doesNotMatch(r.reason, /alreadyRevealed was not supplied/, 'alreadyRevealed WAS supplied — naming it sends the reader to the wrong caller');

  const neither = revealableNow(p, { now: 1500 });
  assert.match(neither.reason, /hasCommit and alreadyRevealed were not supplied/);
});

test('revealableNow refuses rather than guesses when now is not supplied', () => {
  const p = { status: 'Active', commitDeadline: 1000, revealDeadline: 2000 };
  const r = revealableNow(p, { hasCommit: true, alreadyRevealed: false });
  assert.equal(r.revealable, false);
  assert.match(r.reason, /now was not supplied/);
});

// ───────── decideReveal: the shared reveal-recovery decision (drill 2, drill 3, drill 5 companion) ─────────
//
// Pure, so unlike the drills themselves it can be called directly rather than pinned as source
// text. It is the ONE place all three call sites decide "reveal, no-op, restart, or bug" — see
// its doc comment in lib.mjs for why three separate copies of this branch is exactly the drift
// this repo's CLAUDE.md warns about.

function proposalAt(overrides = {}) {
  return { status: 'Active', commitDeadline: 1_000, revealDeadline: 2_000, ...overrides };
}

test('decideReveal: already revealed is a silent no-op, checked before anything else', () => {
  // Deliberately handed a proposal that would ALSO look revealable, to prove alreadyRevealed is
  // checked first rather than falling through to revealableNow's own (matching) check.
  const r = decideReveal(proposalAt(), { now: 1_500, hasCommit: true, alreadyRevealed: true });
  assert.deepEqual(r, { action: 'already-revealed', reason: '' });
});

test('decideReveal: a genuinely revealable round says reveal — the non-firing branch', () => {
  const r = decideReveal(proposalAt(), { now: 1_500, hasCommit: true, alreadyRevealed: false });
  assert.deepEqual(r, { action: 'reveal', reason: '' });
});

test('decideReveal: THE MEASURED LIVE INCIDENT — proposal 13, resumed with reveal PENDING past revealDeadline', () => {
  // Reconstructed from tonight's .state-drill3.json: pid=13, commitDeadline=1790050702,
  // revealDeadline=1790054302, steps done propose/proveModeIWindow/commit, reveal PENDING, the
  // track A process dead. A resume reading chain time comfortably past revealDeadline must be
  // classified 'restart', never 'reveal' (which would send revealVote and revert WrongPhase,
  // exactly like drill 2's proposal 12).
  const p = proposalAt({ commitDeadline: 1_790_050_702, revealDeadline: 1_790_054_302 });
  const resumedNow = 1_790_054_302 + 300; // 5 minutes after the reveal window closed
  const r = decideReveal(p, { now: resumedNow, hasCommit: true, alreadyRevealed: false });
  assert.equal(r.action, 'restart', 'a resume past revealDeadline with zero reveals must trigger recovery, not a bare revealVote send');
  assert.match(r.reason, /reveal window closed 300s ago/);
});

test('decideReveal: the healthy in-window resume must NOT trigger recovery — the non-firing branch, restated at the boundary', () => {
  const p = proposalAt({ commitDeadline: 1_790_050_702, revealDeadline: 1_790_054_302 });
  const stillInWindow = 1_790_050_702 + 60; // 1 minute into the reveal phase
  const r = decideReveal(p, { now: stillInWindow, hasCommit: true, alreadyRevealed: false });
  assert.deepEqual(r, { action: 'reveal', reason: '' }, 'a resume still inside the reveal window must send revealVote normally, not restart');
});

test('decideReveal: a settled proposal (activeProposalOf still names it) is also a restart, not a bug', () => {
  const r = decideReveal(proposalAt({ status: 'Defeated' }), { now: 1_500, hasCommit: true, alreadyRevealed: false });
  assert.equal(r.action, 'restart');
});

test('decideReveal: no commitment recorded, but the round is still live, is a BUG — must not restart blindly', () => {
  const r = decideReveal(proposalAt(), { now: 1_500, hasCommit: false, alreadyRevealed: false });
  assert.equal(r.action, 'bug', 'a live round with no commitment is a real defect, not a stale-resume; restarting would hide it');
  assert.match(r.reason, /no commitment is recorded/);
});

test('decideReveal: MUTATION CHECK — a version that skips the guard always says reveal, which is exactly the pre-fix defect', () => {
  // Not a test of decideReveal itself (already covered above) but a written record of the
  // mutation: reverting decideReveal's body to `return { action: 'reveal', reason: '' };`
  // unconditionally reproduces the pre-#369/#(this PR) shape and turns the proposal-13
  // reconstruction test above RED (it asserts 'restart', not 'reveal'). Restoring the real
  // body turns it GREEN again — verified by hand while preparing this change (reintroduce the
  // unguarded reveal, run the suite, confirm red; restore, confirm green).
  const p = proposalAt({ commitDeadline: 1_790_050_702, revealDeadline: 1_790_054_302 });
  const resumedNow = 1_790_054_302 + 300;
  const guarded = decideReveal(p, { now: resumedNow, hasCommit: true, alreadyRevealed: false });
  const unguarded = { action: 'reveal', reason: '' }; // what the pre-fix drills always did
  assert.notDeepEqual(guarded, unguarded, 'the guard must diverge from the unconditional-reveal shape on a dead round');
});

// ───────── finalizeDeadRound / waitOutProposalCooldown: lifted out of drill 2 into lib.mjs ─────────
//
// Both are impure (send/call/chainNow reach a live `cast`), so — like `send`/`cast` themselves —
// they are not unit-called here. These pin their presence and contract in lib.mjs, the single
// definition every call site below is checked to use rather than a copy of.

test('finalizeDeadRound lives in lib.mjs and only finalizes when the contract\'s own gate is met, matching Governance.sol:577', () => {
  const lib = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'lib.mjs'), 'utf8');
  assert.match(lib, /export function finalizeDeadRound\(governance, pid, label\)/);
  assert.match(lib, /fresh\.status === 'Active' && freshNow >= fresh\.revealDeadline/,
    'finalize must only be sent when the contract\'s own gate (status Active, now >= revealDeadline) is met');
  assert.match(lib, /settled\.status === 'Defeated'/,
    'the recovery finalize must verify the dead round actually settled Defeated, not assume it');
});

test('waitOutProposalCooldown lives in lib.mjs and reads proposalCooldown/lastProposalAt live, never hardcoded', () => {
  const lib = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'lib.mjs'), 'utf8');
  assert.match(lib, /export async function waitOutProposalCooldown\(governance, vault, proposer, maxWaitSec\)/);
  assert.match(lib, /'configOf\(address\)\(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32\)'/,
    'proposalCooldown must be read live from configOf, matching the GovConfig struct order');
  assert.match(lib, /'lastProposalAt\(address,address\)\(uint64\)'/,
    'lastAt must be read live from lastProposalAt(vault, proposer), not assumed');
  assert.doesNotMatch(lib, /proposalCooldown = 3600/,
    'the cooldown value itself must never be hardcoded — it is validated only within a FLOOR..CAP range and can differ per vault');
});

// ───────── drill2-subvault.mjs: the reveal-window recovery path, now delegating to lib.mjs ─────────
//
// drill2-subvault.mjs executes its drill at import (same reason drill5's votableNow wiring is
// pinned as source text above rather than imported and run), so this is a source-text pin over
// the same instrument: it catches an edit that quietly re-introduces the pre-fix shape, OR that
// grows a second, drifted copy of the decision logic instead of calling the shared one.

test('drill2 govRound reads chain truth and consults decideReveal before revealing, not the persisted deadline blindly', () => {
  const drill2 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill2-subvault.mjs'), 'utf8');
  assert.match(drill2, /const p = readProposal\(dep\.governance, pid\);\s*\n\s*const now = chainNow\(\);/,
    'the reveal step must re-read the proposal and the chain clock before deciding, not trust the saved deadline');
  assert.match(drill2, /decideReveal\(p, \{ now, hasCommit, alreadyRevealed \}\)/,
    'the reveal step must consult the SHARED decideReveal rather than reimplementing the branch or calling revealVote unconditionally');
  assert.doesNotMatch(drill2, /function decideReveal/, 'drill2 must import decideReveal from lib.mjs, not define its own copy');
});

test('drill2 recovery only restarts on decideReveal\'s restart verdict, and fails loudly on a bug verdict', () => {
  const drill2 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill2-subvault.mjs'), 'utf8');
  assert.match(drill2, /\} else if \(action === 'restart'\) \{/,
    'restart must be driven by decideReveal\'s own verdict, not a re-derived condition');
  assert.match(drill2, /assert\(false, `\$\{label\}: cannot reveal proposal \$\{pid\} and this is not a stale-window case/,
    'a bug verdict must fail the drill loudly, not restart blindly');
});

test('drill2 restart is bounded and calls the shared finalizeDeadRound rather than a local copy', () => {
  const drill2 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill2-subvault.mjs'), 'utf8');
  assert.match(drill2, /const MAX_ROUND_RESTARTS = 2;/, 'the restart cap must exist as a named, bounded constant');
  assert.match(drill2, /assert\(priorRestarts < MAX_ROUND_RESTARTS,/,
    'recovery must assert the cap BEFORE restarting again, or the loop is unbounded');
  assert.match(drill2, /await finalizeDeadRound\(dep\.governance, pid, label\);/,
    'recovery must call the shared finalizeDeadRound rather than sending its own finalize');
  assert.doesNotMatch(drill2, /governance\.finalize\(stale/, 'the finalize-a-stale-round tx must be sent from inside finalizeDeadRound, not duplicated in drill2');
});

test('drill2 recovery discards exactly this round\'s persisted keys and steps, not the whole state file', () => {
  const drill2 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill2-subvault.mjs'), 'utf8');
  assert.match(drill2, /\['Pid', 'CommitDeadline', 'RevealDeadline', 'Salt', 'ExecutableAt'\]/,
    'recovery must discard the round-scoped keys the doc comment promises to discard');
  assert.match(drill2, /\['Commit', 'Reveal', 'Finalize', 'Execute'\]/,
    'recovery must discard the round-scoped step flags, or the resumed round thinks steps are already done');
});

test('drill2 normal-path Finalize assertion is untouched: a round that fails to pass still fails the drill', () => {
  // The one assertion this change must NOT weaken. Distinct from the recovery path's own
  // Defeated-on-purpose finalize (that one lives inside finalizeDeadRound now).
  const drill2 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill2-subvault.mjs'), 'utf8');
  assert.match(drill2, /assert\(p\.status === 'Passed', `\$\{label\} finalized as \$\{p\.status\}, expected Passed`\);/,
    'the normal governance-round Finalize step must still demand Passed, not accept anything the recovery path would produce');
});

test('drill2 propose (initial and every restart) waits out the shared proposal cooldown', () => {
  const drill2 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill2-subvault.mjs'), 'utf8');
  assert.match(drill2, /await waitOutProposalCooldown\(dep\.governance, PARENT, state\.signer, MAX_COOLDOWN_WAIT_SEC\);\s*\n\s*const r = send\(`governance\.propose/,
    'propose must be preceded by the shared cooldown wait, on every call — the very first one and every restart');
  assert.match(drill2, /const MAX_COOLDOWN_WAIT_SEC = 2 \* 3600;/,
    'the affordability cap must exist as a named, bounded constant');
});

// ───────── drill3-modef.mjs: the identical defect, ported, plus two Mode-F-specific guards ─────────
//
// Same reasoning as drill2's pins above: drill3 executes at import, so its recovery wiring is
// verified as source text. Measured live 2026-09-21/22: proposal 13, `.state-drill3.json` with
// pid=13, commitDeadline=1790050702, revealDeadline=1790054302, steps done
// propose/proveModeIWindow/commit, reveal PENDING, the track A process dead — the identical
// WrongPhase shape drill 2's proposal 12 hit three days earlier.

test('drill3 voteRound consults the shared decideReveal, not a reimplementation', () => {
  const drill3 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill3-modef.mjs'), 'utf8');
  assert.match(drill3, /const p = readProposal\(dep\.governance, state\.pid\);\s*\n\s*const now = chainNow\(\);/,
    'the reveal step must re-read the proposal and chain clock, not trust the persisted deadline');
  assert.match(drill3, /decideReveal\(p, \{ now, hasCommit, alreadyRevealed \}\)/,
    'drill3 must consult the SAME shared decideReveal drill2 uses, not grow its own copy');
  assert.doesNotMatch(drill3, /function decideReveal/, 'drill3 must import decideReveal from lib.mjs, not define its own copy');
});

test('drill3 restart re-enters from propose, so proveModeIWindow is re-proved against the NEW proposal', () => {
  // The Mode-F-specific guard #1: merely completing after a restart is not enough — the drill
  // exists to prove the negative half of the mode boundary (Governance.sol:519), and that must
  // be re-proved against the restarted proposal's own commitDeadline, not skipped because an OLD
  // proposal's proveModeIWindow.done is still sitting in state.
  const drill3 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill3-modef.mjs'), 'utf8');
  assert.match(drill3, /for \(const step of \['propose', 'proveModeIWindow', 'commit', 'reveal'\]\) delete state\.steps\[step\];/,
    'restart must clear proveModeIWindow along with propose/commit/reveal, or the restarted round never re-proves the Mode-I negative');
  assert.match(drill3, /if \(!state\.steps\.propose\?\.done\) stepPropose\(\);/,
    'voteRound must be able to re-enter from propose on a restart, not only resume from reveal');
});

test('drill3 restart refuses once the Mode-F exit has queued, rather than restarting into an unreachable quorum', () => {
  // The Mode-F-specific guard #2: votingEligibleShares = sharesOf - queuedExitShares
  // (VaultCore.sol:1025-1028,1039-1041), so a restart against a signer with queued shares could
  // never supply quorum again. Structurally unreachable at this step (reveal precedes
  // requestExitModeF), but checked live rather than assumed.
  const drill3 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill3-modef.mjs'), 'utf8');
  assert.match(drill3, /const queued = callU\(state\.vault, 'queuedExitShares\(address\)\(uint256\)', state\.signer\);\s*\n\s*assert\(queued === 0n,/,
    'recovery must read queuedExitShares live and refuse to restart if any are queued');
  assert.match(drill3, /votingEligibleShares = sharesOf -/,
    'the refusal must name the reason a restart would be unwinnable, not just fail opaquely');
  assert.match(drill3, /queuedExitShares, VaultCore\.sol:1025-1028,1039-1041/,
    'the refusal must cite the contract lines backing the claim');
});

test('drill3 restart is bounded and calls the shared finalizeDeadRound rather than a local copy', () => {
  const drill3 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill3-modef.mjs'), 'utf8');
  assert.match(drill3, /const MAX_ROUND_RESTARTS = 2;/, 'the restart cap must exist as a named, bounded constant');
  assert.match(drill3, /assert\(priorRestarts < MAX_ROUND_RESTARTS,/,
    'recovery must assert the cap BEFORE restarting again, or the loop is unbounded');
  assert.match(drill3, /await finalizeDeadRound\(dep\.governance, pid, 'Mode-F round'\);/,
    'recovery must call the shared finalizeDeadRound rather than sending its own finalize');
});

test('drill3 voteRound is registered as one resumable step, backward-compatible with tonight\'s existing state-file step names', () => {
  const drill3 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill3-modef.mjs'), 'utf8');
  assert.match(drill3, /\['voteRound', voteRound\],/,
    'the step list must register voteRound as one step, so runSteps\'s own skip-gate works on resume');
  assert.doesNotMatch(drill3, /\['propose', stepPropose\]/,
    'propose/proveModeIWindow/commit/reveal must no longer be separate top-level runSteps entries — voteRound owns their sequencing so a restart can re-enter from propose');
});

test('drill3 preflight resume-guard checks the step it actually writes (requestExitModeF), not a name it never sets', () => {
  // The adjacent bug: preflight used to check state.steps.requestExit, a key this drill never
  // writes (the real step is requestExitModeF) — so the guard against re-queuing an exit on
  // resume was always false. Fixed in this same change since it is the same resume-correctness
  // family as the reveal recovery above, in the same file.
  const drill3 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill3-modef.mjs'), 'utf8');
  assert.match(drill3, /queued === 0n \|\| state\.steps\.requestExitModeF\?\.done/,
    'the preflight resume-guard must check the step name the drill actually sets');
  assert.doesNotMatch(drill3, /state\.steps\.requestExit\?\.done/,
    'the old wrong-key check must be gone entirely, not left as a second (dead) condition');
});

test('drill3 THE central assertion — proposal must finalize Passed against real quorum — is unweakened by the recovery path', () => {
  const drill3 = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill3-modef.mjs'), 'utf8');
  assert.match(drill3, /assert\(p\.status === 'Passed',\s*\n\s*`proposal finalized as \$\{p\.status\}, expected Passed\./,
    'stepFinalize must still demand Passed against real quorum, exactly as before this change — the recovery path only ever produces Defeated, on a DIFFERENT (discarded) proposal');
});

// ───────── drill5-gov-companion.mjs: the same defect, fixed WITHOUT auto-restart ─────────
//
// This round is co-driven with drill5-agent-execute.mjs (same pid, agent polls hasRevealed on
// it), so unlike drill2/drill3 a dead round here must NOT trigger a fresh propose — see the doc
// comment at the reveal step for why. Verified as source text for the same reason as the drills
// above: this script executes at import.

test('drill5-gov-companion reveal step consults the shared decideReveal before sending revealVote', () => {
  const companion = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill5-gov-companion.mjs'), 'utf8');
  assert.match(companion, /const p = readProposal\(dep\.governance, state\.pid\);\s*\n\s*const now = chainNow\(\);/,
    'the reveal step must re-read chain truth before deciding, not trust the persisted deadline');
  assert.match(companion, /decideReveal\(p, \{ now, hasCommit, alreadyRevealed \}\)/,
    'the companion must consult the same shared decideReveal drill2/drill3 use');
});

test('drill5-gov-companion finalizes a dead round but does NOT restart it — the deliberate deviation from drill2/drill3', () => {
  const companion = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'drill5-gov-companion.mjs'), 'utf8');
  assert.match(companion, /await finalizeDeadRound\(dep\.governance, state\.pid, 'deployer reveal \(companion\)'\);/,
    'a dead round must still be finalized, so the vault is not left permanently blocked for the next governance round');
  assert.match(companion, /assert\(false,\s*\n\s*`proposal \$\{state\.pid\} died while this drill was stopped/,
    'a dead round must fail the drill loudly rather than silently re-propose — restarting here would desynchronize drill5-agent-execute.mjs, which is committed to THIS pid');
  assert.doesNotMatch(companion, /return govRound|return voteRound/,
    'the companion must not recurse back into a propose/vote cycle from the restart branch');
  const proposeCalls = companion.match(/propose\(address,uint8,bytes32\)/g) ?? [];
  assert.equal(proposeCalls.length, 1,
    `the companion must send propose exactly once — found ${proposeCalls.length}; a second call would mean the restart branch re-proposes`);
});

// ───────── corpus: every drill that ever calls revealVote must be accounted for ─────────
//
// DERIVED, not listed — the same discipline the claims-lede-truth guard and the merge-policy
// exemption both enforce elsewhere in this repo (a hand-picked subset is the #349/#351 defect
// shape). `grep -ln "revealVote" scripts/soak/*.mjs` is the literal corpus command; this test
// reproduces it via fs so a FUTURE drill that grows an unguarded revealVote call trips this
// suite rather than shipping silently uncovered.

test('every scripts/soak/*.mjs file that calls revealVote is one this suite has fix-pinned, or is lib.mjs itself', () => {
  const soakDir = path.join(LIB_ROOT, 'scripts', 'soak');
  const files = fs.readdirSync(soakDir).filter((f) => f.endsWith('.mjs'));
  const callsRevealVote = files.filter((f) => /revealVote/.test(fs.readFileSync(path.join(soakDir, f), 'utf8')));

  // lib.mjs matches in JSDoc prose (documenting Governance.sol's revealVote requires), not a
  // call site — named and dismissed rather than silently excluded.
  const drills = callsRevealVote.filter((f) => f !== 'lib.mjs');
  assert.deepEqual(
    new Set(drills),
    new Set(['drill2-subvault.mjs', 'drill3-modef.mjs', 'drill5-gov-companion.mjs']),
    'the set of drills calling revealVote has changed — a new one needs the same decideReveal wiring ' +
    '(or an explicit, recorded reason it does not need it, like drill5-agent-execute.mjs\'s agent-loop ' +
    'delegation), not silent omission from this suite',
  );

  // drill5-agent-execute.mjs delegates reveal-sending to agent.loop() (packages/, not scripts/soak),
  // and polls hasRevealed() with a bounded MAX_TICKS that already fails naming the harness/agent
  // cause rather than reverting raw — a structurally different shape, not an oversight. Pinned here
  // so a future edit that starts calling revealVote directly from that file is caught by the
  // assertion above rather than silently falling outside the corpus.
  assert.ok(!callsRevealVote.includes('drill5-agent-execute.mjs'),
    'drill5-agent-execute.mjs is not expected to call revealVote directly (see agent.loop() delegation) — if this now fails, it has grown a direct call and needs the same fix, not a shrug');
});

// ───────── cooldownWait: propose's SECOND require, the one a restart can also hit ─────────
//
// Flagged by an independent chain read against the live soak governance
// (0xD963f553e3eCd1872aF1622b3e4664f133A51805, parent 0xB940d71b0D695e2BA2b5853bF565C69DaA3E3C98):
// configOf reads proposalCooldown=3600 (1h, PER-PROPOSER — lastProposalAt is keyed [vault][proposer],
// Governance.sol:162,317,344), and the drill 2 restart in recoverStaleRound re-proposes without
// ever checking it. Restart #1 for tonight's stuck proposal 12 is safe (createdAt was ~3.2h before
// the restart), but a restart is not guaranteed to land outside the window in general — see the
// scenario the "restart #2" test below documents.

test('cooldownWait: a proposer who has never proposed on this vault needs no wait', () => {
  assert.deepEqual(
    cooldownWait({ now: 1000, lastAt: 0, proposalCooldown: 3600, maxWaitSec: 7200 }),
    { waitSec: 0, affordable: true, reason: '' },
  );
});

test('cooldownWait: past the cooldown already needs no wait', () => {
  const r = cooldownWait({ now: 5000, lastAt: 1000, proposalCooldown: 3600, maxWaitSec: 7200 });
  assert.deepEqual(r, { waitSec: 0, affordable: true, reason: '' }, 'now (5000) is already >= lastAt+cooldown (4600)');
});

test('cooldownWait rejects at the EXACT cooldown boundary, matching propose (>= not >)', () => {
  // Governance requires `lastAt == 0 || block.timestamp >= lastAt + cfg.proposalCooldown` — so
  // equality already clears it, the opposite boundary direction from commitDeadline/revealDeadline.
  //
  // deepEqual on the WHOLE result, not just waitSec: at exactly the boundary a mutant that
  // weakens `>=` to `>` still computes waitSec as `earliest - now === 0` on the fall-through path,
  // so a waitSec-only check passes on both the correct code and the mutant. The `reason` field is
  // what actually differs — '' on the fast path, a non-empty "inside cooldown" string on the
  // fall-through — so asserting the full object is what catches the off-by-one.
  assert.deepEqual(
    cooldownWait({ now: 4600, lastAt: 1000, proposalCooldown: 3600, maxWaitSec: 7200 }),
    { waitSec: 0, affordable: true, reason: '' },
    'now === lastAt + cooldown is already OPEN, with no "inside cooldown" reason attached',
  );
  const oneEarly = cooldownWait({ now: 4599, lastAt: 1000, proposalCooldown: 3600, maxWaitSec: 7200 });
  assert.equal(oneEarly.waitSec, 1, 'one second earlier still needs a 1s wait');
  assert.equal(oneEarly.affordable, true);
  assert.notEqual(oneEarly.reason, '', 'a real wait must carry an explanatory reason');
});

test('cooldownWait: THE MEASURED LIVE CONFIG — restart #2 landing inside a 1h cooldown after a fast-dying restart #1', () => {
  // The scenario the coordinator's review names: restart #1 re-proposes at T, and if THAT new
  // round also dies before its commit window closes (status stops being Active for some other
  // reason), restart #2 can be attempted as early as commitDeadline — inside the SAME proposer's
  // 1h cooldown from restart #1's own propose, if commitDuration < proposalCooldown.
  const T = 1_790_000_000;
  const commitDuration = 1800; // shorter than the 3600s cooldown, unlike tonight's 1:1 live config
  const r = cooldownWait({ now: T + commitDuration, lastAt: T, proposalCooldown: 3600, maxWaitSec: 7200 });
  assert.equal(r.affordable, true, 'inside the affordability cap, so the drill must wait, not refuse');
  assert.equal(r.waitSec, 3600 - commitDuration, 'wait exactly the remaining cooldown, not the whole hour again');
  assert.match(r.reason, /per-proposer cooldown/);
  assert.match(r.reason, /Cooldown\(\)/, 'name the revert this wait exists to avoid');
});

test('cooldownWait refuses rather than silently stalling when the wait exceeds maxWaitSec', () => {
  // proposalCooldown can be configured up to PROPOSAL_COOLDOWN_CAP (30 days, Governance.sol:253).
  // A drill must fail plainly rather than hang for anywhere near that long.
  const r = cooldownWait({ now: 1000, lastAt: 1000, proposalCooldown: 30 * 86400, maxWaitSec: 7200 });
  assert.equal(r.affordable, false, 'a 30-day cooldown must not be silently awaited');
  assert.equal(r.waitSec, 30 * 86400);
  assert.match(r.reason, /affordability cap/);
  assert.match(r.reason, /7200s affordability cap/);
});

test('cooldownWait refuses rather than guesses when a term is not supplied', () => {
  const missingNow = cooldownWait({ lastAt: 1000, proposalCooldown: 3600, maxWaitSec: 7200 });
  assert.equal(missingNow.affordable, false);
  assert.match(missingNow.reason, /now was not supplied/);

  const missingLastAt = cooldownWait({ now: 1000, proposalCooldown: 3600, maxWaitSec: 7200 });
  assert.match(missingLastAt.reason, /lastAt was not supplied/);

  const missingCooldown = cooldownWait({ now: 1000, lastAt: 1000, maxWaitSec: 7200 });
  assert.match(missingCooldown.reason, /proposalCooldown was not supplied/);

  const missingMax = cooldownWait({ now: 1000, lastAt: 1000, proposalCooldown: 3600 });
  assert.match(missingMax.reason, /maxWaitSec was not supplied/);
});

// The two source-pins that used to live here (drill2 reading proposalCooldown/lastProposalAt
// live, and the cooldown wait being bounded) now live in the "waitOutProposalCooldown lives in
// lib.mjs..." and "drill2 propose (initial and every restart) waits out the shared proposal
// cooldown" tests above, since #369's per-drill implementation was lifted into lib.mjs by this
// change and drill2's call site shrank to a 4-argument call into the shared function.

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

// ───────── no soak entrypoint may pin a chain id in its own source ─────────
//
// Eight entrypoints each carried `{ expectChainId: 84532 }` beside their `loadDeployment` call, so
// the expected chain was written down eight times and the address book's own `chainId` a ninth.
// Pointing a run at another chain meant editing all eight, and until someone did, drill coverage
// was reachable on Base Sepolia and nowhere else. The chain id now comes from the record, and
// `assertLiveChainId` proves the endpoint matches it.
//
// A source-text pin, like the run-soak.ps1 tests below, because these files execute at import and
// no node test can run them. What it catches is the defect that actually happens: a new drill, or
// an edit to an old one, quietly re-pinning a literal in a file nothing else checks.

const SOAK_ENTRYPOINTS = [
  'drill1-multivault.mjs', 'drill2-subvault.mjs', 'drill3-modef.mjs', 'drill4-oraclefreeze.mjs',
  'drill5-agent-execute.mjs', 'drill5-fasttrack.mjs', 'drill5-gov-companion.mjs',
  'oracle-sampler.mjs',
];

test('the eight soak entrypoints contain no chain-id literal at all', () => {
  for (const name of SOAK_ENTRYPOINTS) {
    const src = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', name), 'utf8');
    assert.doesNotMatch(src, /\b84532\b/, `${name} still names Base Sepolia's chain id`);
    // Every chain id, not just this one: re-pinning 4663 in a drill would recreate the same
    // defect pointing the other way.
    assert.doesNotMatch(src, /expectChainId/,
      `${name} passes expectChainId — the record's own chainId is the expected value`);
  }
});

test('every soak entrypoint loads the address book through deploymentPath', () => {
  // The other half of the same property. Dropping the literal but keeping a hardcoded
  // `path.join(ROOT, ..., 'base-sepolia.json')` would leave the file un-repointable and this
  // file's 84532 assertion above would still pass.
  for (const name of SOAK_ENTRYPOINTS) {
    const src = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', name), 'utf8');
    assert.match(src, /loadDeployment\(deploymentPath\(ROOT\)\)/,
      `${name} must resolve its address book through deploymentPath`);
    assert.doesNotMatch(src, /'base-sepolia\.json'/,
      `${name} names the Base Sepolia book directly, so SOAK_DEPLOYMENT cannot repoint it`);
  }
});

test('the one surviving 84532 is the drill-5 testnet allowlist, and it is still a Set of chain ids', () => {
  // NOT swept, deliberately. `TESTNET_CHAIN_IDS` is the gate that stops a throwaway keystore
  // signing on a chain where the funds are real; widening it is a launch-parameter decision, not a
  // portability fix. Pinned here so the exemption stays exactly this one declaration — a second
  // 84532 appearing elsewhere in agent-policy.mjs would go unnoticed if the file were skipped.
  const src = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'agent-policy.mjs'), 'utf8');
  const hits = src.match(/\b84532\b/g) ?? [];
  assert.equal(hits.length, 1, 'agent-policy.mjs must name 84532 exactly once');
  assert.match(src, /export const TESTNET_CHAIN_IDS = new Set\(\[84532, /,
    'the single occurrence must be the testnet allowlist');
});

test('the soak scripts resolve their RPC from SOAK_RPC first, then BASE_SEPOLIA_RPC', () => {
  // Two resolvers, two files: lib.mjs drives every `cast` read and write, agent-policy.mjs drives
  // drill 5's viem client. Letting them disagree would put the reads and the writes of one drill on
  // two different endpoints, which is exactly the kind of split a chain-id check cannot see.
  // Same names AND the same operator. `??` in one and `||` in the other agree on every set value
  // and disagree on an exported-but-empty one, which is precisely the split this pins shut — and
  // one `assertLiveChainId` cannot catch, because drill 5 reads the chain id through the viem url.
  const lib = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'lib.mjs'), 'utf8');
  assert.match(lib, /process\.env\.SOAK_RPC \|\| process\.env\.BASE_SEPOLIA_RPC \|\|/);
  const sampler = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'oracle-sampler.mjs'), 'utf8');
  assert.match(sampler, /process\.env\.SOAK_RPC \|\| process\.env\.BASE_SEPOLIA_RPC \|\|/);
  const policy = fs.readFileSync(path.join(LIB_ROOT, 'scripts', 'soak', 'agent-policy.mjs'), 'utf8');
  assert.match(policy, /rpcUrl: env\.SOAK_RPC \|\| env\.BASE_SEPOLIA_RPC \|\| defaultRpc/);
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

test('the launcher takes the signer and the endpoint from the same places the drills do', () => {
  // run-soak.ps1 hardcoded the deployer address and defaulted only BASE_SEPOLIA_RPC. Both were
  // copies of something the drills resolve differently, so a run repointed at another chain would
  // have had its preflight compare the unlocked key against Base Sepolia's deployer and reject it.
  // No node test can execute PowerShell in CI (ubuntu-latest), so these are text pins.
  assert.match(RUN_SOAK, /\$Deployer = \(Get-Content -Raw \$Book \| ConvertFrom-Json\)\.deployer/,
    'the signer must come from the address book, not a second copy in the launcher');
  assert.doesNotMatch(RUN_SOAK, /\$Deployer = '0x/, 'no hardcoded deployer address may return');
  assert.match(RUN_SOAK, /\$env:SOAK_DEPLOYMENT/, '$Book must honour the same override the drills read');
  assert.match(RUN_SOAK, /base-sepolia\.json/, 'and fall back to the same committed default');

  // SOAK_RPC first, BASE_SEPOLIA_RPC second — lib.mjs's order. Then BOTH are exported, so a child
  // reading either name sees one endpoint.
  const rpc = /\$env:SOAK_RPC = if \(\$env:SOAK_RPC\) \{ \$env:SOAK_RPC \}[\s\S]*?elseif \(\$env:BASE_SEPOLIA_RPC\)[\s\S]*?else \{ 'https:\/\/sepolia\.base\.org' \}/;
  assert.match(RUN_SOAK, rpc);
  assert.match(RUN_SOAK, /\$env:BASE_SEPOLIA_RPC = \$env:SOAK_RPC/);
});

test('reading the address book cannot break -Stop, because it happens after that block', () => {
  // $ErrorActionPreference is 'Stop'. Resolving $Book above the -Status/-Stop early exits would let
  // a typo'd SOAK_DEPLOYMENT throw before -Stop killed the pids — and -Stop is the only thing that
  // reaches the detached companion, which runs with a --password-file the operator deletes after
  // the run. The read belongs below those exits, where it is first needed.
  const iStop = anchorAt(/^if \(\$Stop\) \{/m, 'the -Stop block');
  const iExit = RUN_SOAK.indexOf('exit 0', iStop);
  assert.ok(iExit > iStop, 'the -Stop block must still end in an early exit');
  const iBook = anchorAt(/\$Book = if \(\$env:SOAK_DEPLOYMENT\)/, 'the address-book resolution');
  const iDeployer = anchorAt(/\$Deployer = \(Get-Content -Raw \$Book/, 'the signer read');
  assert.ok(iBook > iExit, '$Book must resolve only after -Stop has already exited');
  assert.ok(iDeployer > iBook, 'the signer is read from $Book, so it comes after it');
});

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
