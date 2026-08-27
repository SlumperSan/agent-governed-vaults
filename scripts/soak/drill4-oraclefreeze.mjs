#!/usr/bin/env node
// @ts-check
/**
 * DRILL 4 — ORACLE FREEZE. Verdict over the staleness series that `oracle-sampler.mjs`
 * collected across the soak window.
 *
 * This drill SIGNS NOTHING. It has no signer, sends no transaction, and needs no key: every
 * claim it makes is a reduction over data the sampler already read from chain, plus the
 * canary's own transition log. That is deliberate — a freeze drill that had to transact would
 * be unable to run during the very condition it exists to observe.
 *
 * The reducers live in `series-analysis.mjs` so they can be unit-tested; this file is the
 * driver that reads the files, prints the findings and records the verdict.
 *
 * ## What this deployment can and cannot prove
 *
 * Base Sepolia runs THREE `ChainlinkSourceAdapter` instances over ONE underlying feed per
 * asset (the documented testnet compromise). All three therefore share a single heartbeat and
 * go stale TOGETHER. The aggregator's freshness margin (`freshSources - quorum`) is
 * all-or-nothing: `+1` while the feed lives, `-2` the instant it lapses. There is no gradual
 * decay, and the canary's `oracle-freshness` signal jumps OK → ALERT with no intermediate
 * state. Mainnet's three mechanism-diverse sources (Sprint 11) would decay independently.
 *
 * So a "no freeze occurred" outcome is NOT a weaker version of this drill — it is the expected
 * outcome on a healthy feed, and #21 anticipates it: *"if none occurs within the soak window,
 * document the observed worst-case feed age vs the 1-day bound instead."* This script produces
 * that either way and labels which case it is, rather than reporting absence as success.
 *
 * ## The property that actually matters: freeze safety
 *
 * SF-2/K-4 freeze every NAV path on a stale oracle — exits included, with no hatch. The one
 * member-capital path that MUST survive is `cancelPending`: a pending deposit has not been
 * priced yet, so returning escrowed USDC needs no oracle at all. If that were also frozen, a
 * depositor's capital would be trapped for the duration of an oracle outage with no recourse.
 *
 * `n/a-no-pending` is a legitimate verdict, not a pass. The drill will NOT claim freeze-safety
 * was demonstrated if every sample was `n/a` — that would assert a property nothing exercised.
 *
 * Env: SOAK_SERIES (default data/oracle-series.jsonl), SOAK_CANARY_STATE
 *      (default data/canary-state.json), SOAK_STATE_DIR, SOAK_MAX_GAP_MULT (default 3).
 * Run:  node scripts/soak/drill4-oraclefreeze.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log, assert, openState } from './lib.mjs';
import { loadDeployment } from './deployment.mjs';
import {
  readSeries, summarize, findGaps, summarizeFreezeSafety, oracleCanaryRows, verdictOf,
} from './series-analysis.mjs';

const dep = loadDeployment(
  path.join(ROOT, 'contracts', 'config', 'deployments', 'base-sepolia.json'),
  { expectChainId: 84532 },
);

const SERIES = process.env.SOAK_SERIES ?? path.join(ROOT, 'data', 'oracle-series.jsonl');
const CANARY_STATE = process.env.SOAK_CANARY_STATE ?? path.join(ROOT, 'data', 'canary-state.json');
const STATE_DIR = process.env.SOAK_STATE_DIR ?? path.join(ROOT, 'scripts', 'soak');
const STATE_PATH = path.join(STATE_DIR, '.state-drill4.json');
const MAX_GAP_MULT = Number(process.env.SOAK_MAX_GAP_MULT ?? 3);

const { state, save } = openState(STATE_PATH, dep.factory);

log('DRILL 4 — oracle freeze: staleness series verdict, canary reconciliation, freeze safety');
log('(read-only: this drill signs nothing and needs no key)');

const { samples, torn } = readSeries(SERIES);
if (torn) log(`WARNING: ${torn} unparseable line(s) in the series — a sampler killed mid-write`);

const first = samples[0];
const last = samples[samples.length - 1];
const windowSec = last.chainNow - first.chainNow;
log(`series: ${samples.length} samples spanning ${windowSec}s (${(windowSec / 3600).toFixed(2)}h) of chain time`);

const byAsset = summarize(samples);
const { gaps, medianSec } = findGaps(samples, MAX_GAP_MULT);
const freeze = summarizeFreezeSafety(samples);

const canaryExists = fs.existsSync(CANARY_STATE);
const canaryRows = canaryExists ? oracleCanaryRows(JSON.parse(fs.readFileSync(CANARY_STATE, 'utf8'))) : [];
const result = verdictOf(byAsset, canaryRows);

log('──────────────────────────────────────────────');
for (const a of Object.values(byAsset)) {
  log(`${a.symbol}: worst age ${a.maxAgeSec}s of ${a.maxStalenessSeconds}s bound (${(a.maxAgeFractionOfBound * 100).toFixed(3)}% of the 1-day limit) at ${a.worstAt}`);
  log(`  freshSources min ${a.minFreshSources} (quorum ${a.quorum}), margin min ${a.minMargin}, price reverted in ${a.priceRevertSamples}/${a.samples} samples`);
}

if (gaps.length) {
  log(`SAMPLING GAPS: ${gaps.length} (median interval ${medianSec}s). A gap is missing evidence, not a healthy period:`);
  for (const g of gaps.slice(0, 5)) log(`  ${g.gapSec}s between ${g.afterSample} and ${g.beforeSample}`);
}

log(`freeze-safety verdicts: ${JSON.stringify(freeze.verdicts)}`);
if (freeze.oracleBlocked > 0) {
  log(`  *** cancelPending was NOT callable in ${freeze.oracleBlocked} sample(s) — freeze-safety VIOLATED ***`);
  for (const b of freeze.blockedDetail) log(`     ${b.at} ${b.vault}: ${b.verdict} — ${b.detail}`);
} else if (freeze.probedWithPending === 0) {
  log('  cancelPending was never probed against a REAL pending deposit (every sample was n/a-no-pending),');
  log('  so freeze safety is NOT demonstrated by this run — it is merely un-contradicted.');
  log('  TO FIX: the sampler must run DURING a 4h observation window, with SOAK_PROBE_MEMBER set');
  log('  to the depositor. Drills 1, 2 and 5 each open one — that is the window in which a pending');
  log('  deposit actually exists to cancel. Restart oracle-sampler.mjs right after a deposit lands.');
} else {
  log(`  cancelPending stayed callable in all ${freeze.probedWithPending} probed sample(s) — freeze safety held`);
}

log(`canary oracle-freshness rows: ${canaryRows.length}${canaryExists ? '' : ' (canary state file absent)'}`);
for (const r of canaryRows) log(`  ${r.subject} status=${r.status} since=${r.since} pending=${r.pendingStatus ?? '-'}`);

if (result.verdict === 'STALENESS_EVENT_OBSERVED') {
  log('VERDICT: STALENESS EVENT OBSERVED');
  for (const a of result.breached) log(`  ${a.symbol}: ${a.breachSamples}/${a.samples} samples below quorum`);
  assert(result.canaryTracked,
    'a staleness breach was observed on-chain but every canary oracle-freshness row still reads ok — the canary did NOT track the freeze');
  log('  canary tracked the event (at least one row left ok)');
} else {
  log('VERDICT: NO STALENESS EVENT IN THE WINDOW — documenting worst-case age instead (per #21)');
  if (result.worst) {
    log(`  closest approach: ${result.worst.symbol} reached ${result.worst.maxAgeSec}s = ${(result.worst.maxAgeFractionOfBound * 100).toFixed(3)}% of the ${result.worst.maxStalenessSeconds}s bound`);
  }
  log('  this is the expected outcome on a live feed and is NOT a failed drill');
}

state.steps.analyze = {
  done: true,
  seriesFile: SERIES, samples: samples.length, tornLines: torn,
  windowSec, medianIntervalSec: medianSec,
  firstSample: first.t, lastSample: last.t,
  byAsset, gaps,
  freezeSafety: freeze,
  canary: { present: canaryExists, oracleRows: canaryRows },
  verdict: result.verdict,
  testnetCaveat:
    'three ChainlinkSourceAdapters share ONE underlying feed per asset on Base Sepolia, so sources go stale together and the margin is all-or-nothing (+1 / -2). Mainnet Sprint-11 sources decay independently; this drill cannot exercise partial-quorum degradation.',
};
save();

log('──────────────────────────────────────────────');
log(`DRILL 4 COMPLETE — verdict ${result.verdict}`);
log(`  state file ${STATE_PATH}`);
