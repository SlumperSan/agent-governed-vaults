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
  readSeries, summarize, findGaps, summarizeFreezeSafety, oracleCanaryRows, verdictOf,
} from '../soak/series-analysis.mjs';
import { resolveAgentRunConfig, policyFor, EXECUTE_ENV_VAR } from '../soak/agent-policy.mjs';

// ───────────────────────────── fixtures ─────────────────────────────

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
  const r = verdictOf(byAsset, [{ status: 'ok' }, { status: 'ok' }]);
  assert.equal(r.verdict, 'STALENESS_EVENT_OBSERVED');
  assert.equal(r.canaryTracked, false, 'this is the case that must fail the drill');
});

test('breach with a canary row off ok is reported as tracked', () => {
  const byAsset = summarize([sample('t1', 1, { asset: { priceReverts: true } })]);
  const r = verdictOf(byAsset, [{ status: 'ok' }, { status: 'alert' }]);
  assert.equal(r.canaryTracked, true);
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
