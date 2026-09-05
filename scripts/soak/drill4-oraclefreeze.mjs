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
 * The C-6 pivot retired the multi-source median: {ChainlinkOracle} prices each asset from ONE
 * genuine Chainlink Data Feed, so there is no quorum, no source set and no freshness margin. An
 * asset is either priceable or frozen, and `priceWad` reverting IS the breach — there is no
 * partial-quorum degradation for this drill to observe on ANY chain, testnet or mainnet.
 *
 * What Base Sepolia additionally cannot exercise is the SEQUENCER leg: the testnet oracle leaves
 * `sequencerUptimeFeed` at `address(0)` by design, so `_requireSequencerUp` is a no-op and the
 * grace-tail path has never executed. Being deployed to a mainnet did not discharge that either:
 * Chainlink publishes no L2 sequencer uptime feed for Robinhood Chain (4663) and has said it will
 * not add one, so its first real execution waits for a chain that has a feed to wire.
 *
 * So a "no freeze occurred" outcome is NOT a weaker version of this drill — it is the expected
 * outcome on a healthy feed, and #21 anticipates it: *"if none occurs within the soak window,
 * document the observed worst-case feed age vs the bound instead."* This script produces
 * that either way and labels which case it is, rather than reporting absence as success.
 *
 * What it will NOT do is report an absence of EVIDENCE as an absence of events. A series whose
 * samples are all unreadable yields `INSUFFICIENT_EVIDENCE` and fails the drill, because "nothing
 * broke" and "nothing was measured" are opposite claims.
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
import { deploymentPath, loadDeployment } from './deployment.mjs';
import {
  readSeries, summarize, findGaps, summarizeFreezeSafety, summarizeSequencer, oracleCanaryRows, verdictOf,
  freezeSafetyReport,
} from './series-analysis.mjs';

const dep = loadDeployment(deploymentPath(ROOT));

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
const sequencer = summarizeSequencer(samples);

const canaryExists = fs.existsSync(CANARY_STATE);
const canaryRows = canaryExists ? oracleCanaryRows(JSON.parse(fs.readFileSync(CANARY_STATE, 'utf8'))) : [];
const result = verdictOf(byAsset, canaryRows);

log('──────────────────────────────────────────────');
for (const a of Object.values(byAsset)) {
  log(`${a.symbol}: worst age ${a.maxAgeSec ?? 'n/a'}s of the ${a.staleBoundSec ?? '?'}s staleness bound (${(a.maxAgeFractionOfBound * 100).toFixed(3)}%, bound read from ${a.staleBoundSource ?? 'unknown'}) at ${a.worstAt ?? 'n/a'}`);
  log(`  priceWad reverted in ${a.priceRevertSamples}/${a.readableSamples} readable samples; ${a.unreadableSamples} sample(s) UNREADABLE (missing evidence, scored as neither breach nor health)`);
  const causes = Object.entries(a.causes ?? {});
  if (causes.length) log(`  attributed freeze causes: ${causes.map(([k, n]) => `${k}=${n}`).join(', ')}`);
  if (a.attributionGapSamples) {
    log(`  *** ${a.attributionGapSamples} freeze sample(s) this detector could NOT attribute to any known cause — the freeze is real, the model is incomplete ***`);
  }
  if (a.boundDriftSamples) {
    log(`  *** the address book's oracle.maxStalenessSeconds disagrees with the oracle's on-chain heartbeat in ${a.boundDriftSamples} sample(s) — the CONTRACT wins; fix the JSON ***`);
  }
  // A legacy (pre-pivot) series still carries these; a ChainlinkOracle series has no quorum at all.
  if (a.quorum != null) log(`  [legacy series] freshSources min ${a.minFreshSources}, quorum ${a.quorum}, margin min ${a.minMargin}`);
}

if (gaps.length) {
  log(`SAMPLING GAPS: ${gaps.length} (median interval ${medianSec}s). A gap is missing evidence, not a healthy period:`);
  for (const g of gaps.slice(0, 5)) log(`  ${g.gapSec}s between ${g.afterSample} and ${g.beforeSample}`);
}

log(`sequencer gate: ${JSON.stringify(sequencer.states)}`);
if (!sequencer.exercised) {
  log('  the sequencer leg was NOT exercised in this window (sequencerUptimeFeed is address(0) — Base Sepolia by design).');
  log('  That is an unexecuted code path, not a passing sub-check: a first real execution waits for a chain');
  log('  that has an uptime feed to wire, which Robinhood Chain (4663) does not.');
} else if (sequencer.notUpSamples) {
  log(`  *** the sequencer was not fully up in ${sequencer.notUpSamples} sample(s); earliest computed resume ${sequencer.earliestResumesAtSec ?? 'n/a'} ***`);
}

// The wording lives in series-analysis so it can be unit-tested: nothing here executes this file,
// so prose written inline has no regression coverage, and the first version of these branches
// shipped a falsehood for exactly that reason.
for (const line of freezeSafetyReport(freeze)) log(line);

log(`canary oracle-freshness rows: ${canaryRows.length} (${result.canaryAssetRows ?? 0} keyed by a basket asset)${canaryExists ? '' : ' (canary state file absent)'}`);
for (const r of canaryRows) {
  log(`  ${r.subject}${r.isAsset ? '' : ' [per-vault meta row — cannot evidence asset coverage]'} status=${r.status} since=${r.since} pending=${r.pendingStatus ?? '-'}`);
}

if (result.verdict === 'INSUFFICIENT_EVIDENCE') {
  log('VERDICT: INSUFFICIENT EVIDENCE — the series contains no readable asset observation');
  log(`  ${result.unreadableObservations} unreadable asset observation(s). "Nothing broke" and "nothing was measured" are opposite claims;`);
  log('  this drill will not report the second as the first. Fix the sampler/RPC and re-run across a fresh window.');
  assert(false,
    'drill 4 collected no readable oracle observation across the window — it certifies nothing, so it must not pass');
} else if (result.verdict === 'STALENESS_EVENT_OBSERVED') {
  log('VERDICT: STALENESS EVENT OBSERVED');
  for (const a of result.breached) log(`  ${a.symbol}: ${a.breachSamples}/${a.readableSamples} readable samples frozen (priceWad reverted)`);
  assert(result.canaryTracked,
    `a staleness breach was observed on-chain but no canary oracle-freshness row keyed by a BASKET ASSET left ok (${result.canaryAssetRows} such row(s) exist) — the canary did NOT track the freeze. Per-vault meta rows (sequencer, flavor) are excluded on purpose: neither evidences anything about an asset. The sequencer row used to be permanently skipped where sequencerUptimeFeed is address(0) and would have satisfied this check by itself; it now reports ok (not-applicable), and the exclusion is kept on status-blind grounds because the flavor row is skipped today`);
  log('  canary tracked the event (at least one ASSET row left ok)');
} else {
  log('VERDICT: NO STALENESS EVENT IN THE WINDOW — documenting worst-case age instead (per #21)');
  if (result.worst) {
    log(`  closest approach: ${result.worst.symbol} reached ${result.worst.maxAgeSec}s = ${(result.worst.maxAgeFractionOfBound * 100).toFixed(3)}% of the ${result.worst.staleBoundSec}s bound`);
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
  sequencer,
  canary: { present: canaryExists, oracleRows: canaryRows, assetRows: result.canaryAssetRows ?? 0 },
  verdict: result.verdict,
  testnetCaveat:
    'Post-C-6 the oracle is ChainlinkOracle: ONE Chainlink feed per asset, no quorum and no freshness margin, so partial-quorum degradation does not exist to be exercised on any chain. What Base Sepolia specifically cannot exercise is the sequencer gate — sequencerUptimeFeed is address(0) there by design, so _requireSequencerUp is a no-op and the grace-tail path first executes on mainnet.',
};
save();

log('──────────────────────────────────────────────');
log(`DRILL 4 COMPLETE — verdict ${result.verdict}`);
log(`  state file ${STATE_PATH}`);
