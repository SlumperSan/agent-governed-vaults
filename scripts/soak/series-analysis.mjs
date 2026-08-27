// @ts-check
/**
 * Pure reducers over the oracle staleness series that `oracle-sampler.mjs` writes.
 *
 * Extracted from drill 4 so they are unit-testable: the drill itself runs its analysis at
 * import time (like every drill runner here), so importing it from a test would execute it.
 * These functions touch no chain, no clock and no filesystem except `readSeries`, which is
 * the one place a file is read.
 */
import fs from 'node:fs';

/**
 * Parse a JSONL series, tolerating a torn final line from a sampler killed mid-write.
 * @param {string} file
 * @returns {{samples: any[], torn: number}}
 */
export function readSeries(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`no oracle series at ${file} — oracle-sampler.mjs must have run across the soak window`);
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const samples = [];
  let torn = 0;
  for (const l of lines) {
    try { samples.push(JSON.parse(l)); } catch { torn++; }
  }
  if (samples.length === 0) throw new Error(`oracle series at ${file} has no parseable samples`);
  return { samples, torn };
}

/**
 * Reduce the series per asset: worst age, freshness floor, and breach count.
 *
 * A "breach" is the aggregator losing quorum — `margin < 0` OR `priceWad` reverting. Both are
 * counted because they are different observations of the same failure: margin is computed from
 * source freshness, `priceReverts` is the breaker's own live verdict, and a disagreement
 * between them would itself be a finding.
 * @param {any[]} samples
 */
export function summarize(samples) {
  /** @type {Record<string, any>} */
  const byAsset = {};
  for (const s of samples) {
    for (const a of s.assets ?? []) {
      const acc = (byAsset[a.symbol] ??= {
        symbol: a.symbol,
        samples: 0,
        maxAgeSec: -1,
        minAgeSec: Number.MAX_SAFE_INTEGER,
        maxAgeFractionOfBound: 0,
        maxStalenessSeconds: a.maxStalenessSeconds,
        quorum: a.quorum,
        minFreshSources: Number.MAX_SAFE_INTEGER,
        minMargin: Number.MAX_SAFE_INTEGER,
        priceRevertSamples: 0,
        breachSamples: 0,
        worstAt: null,
      });
      acc.samples++;
      if (a.ageSec > acc.maxAgeSec) { acc.maxAgeSec = a.ageSec; acc.worstAt = s.t; }
      acc.minAgeSec = Math.min(acc.minAgeSec, a.ageSec);
      acc.maxAgeFractionOfBound = Math.max(acc.maxAgeFractionOfBound, a.ageFractionOfBound ?? 0);
      acc.minFreshSources = Math.min(acc.minFreshSources, a.freshSources);
      acc.minMargin = Math.min(acc.minMargin, a.margin);
      if (a.priceReverts) acc.priceRevertSamples++;
      if (a.margin < 0 || a.priceReverts) acc.breachSamples++;
    }
  }
  return byAsset;
}

/**
 * Find sampling gaps against the series' own median interval.
 *
 * Gaps must be visible rather than interpolated: a period with no samples is missing evidence,
 * and reading it as "healthy" is exactly the mistake that would let a real freeze go unrecorded.
 * The median is used rather than the configured interval so a sampler restarted with different
 * settings does not report every sample as a gap.
 * @param {any[]} samples
 * @param {number} maxGapMult
 */
export function findGaps(samples, maxGapMult) {
  const deltas = [];
  for (let i = 1; i < samples.length; i++) deltas.push(samples[i].chainNow - samples[i - 1].chainNow);
  if (deltas.length === 0) return { gaps: [], medianSec: 0 };
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const gaps = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].chainNow - samples[i - 1].chainNow;
    if (median > 0 && d > median * maxGapMult) {
      gaps.push({ afterSample: samples[i - 1].t, beforeSample: samples[i].t, gapSec: d, medianSec: median });
    }
  }
  return { gaps, medianSec: median };
}

/**
 * Freeze safety (SF-2/K-4): `cancelPending` must stay callable while the oracle is frozen,
 * because escrowed USDC has not been priced and returning it needs no oracle.
 *
 * `n/a-no-pending` is counted SEPARATELY and never as a pass: with no pending deposit there is
 * nothing to cancel, so the probe proves nothing. A run in which every sample was `n/a` leaves
 * the property un-contradicted, not demonstrated — `demonstrated` says so.
 * @param {any[]} samples
 */
export function summarizeFreezeSafety(samples) {
  /** @type {Record<string, number>} */
  const verdicts = {};
  let probedWithPending = 0;
  let oracleBlocked = 0;
  const blockedDetail = [];
  for (const s of samples) {
    for (const f of s.freezeSafety ?? []) {
      verdicts[f.verdict] = (verdicts[f.verdict] ?? 0) + 1;
      if (f.verdict === 'callable' || f.verdict === 'ok') probedWithPending++;
      if (!['callable', 'ok', 'n/a-no-pending'].includes(f.verdict)) {
        oracleBlocked++;
        if (blockedDetail.length < 5) {
          blockedDetail.push({ at: s.t, vault: f.vault, verdict: f.verdict, detail: f.detail });
        }
      }
    }
  }
  return {
    verdicts,
    probedWithPending,
    oracleBlocked,
    blockedDetail,
    demonstrated: probedWithPending > 0 && oracleBlocked === 0,
  };
}

/**
 * The canary's transition rows for the oracle-freshness signal only.
 * Keys are `signal|vault|subject`.
 * @param {any} canaryState
 */
export function oracleCanaryRows(canaryState) {
  const out = [];
  for (const [key, v] of Object.entries(canaryState?.transitions ?? {})) {
    if (!key.startsWith('oracle-freshness|')) continue;
    const [signal, vault, subject] = key.split('|');
    out.push({ signal, vault, subject, ...(/** @type {any} */ (v)) });
  }
  return out;
}

/**
 * The drill's verdict. Separated from printing so the decision is testable.
 * @param {Record<string, any>} byAsset
 * @param {any[]} canaryRows
 */
export function verdictOf(byAsset, canaryRows) {
  const breached = Object.values(byAsset).filter((a) => a.breachSamples > 0);
  if (breached.length === 0) {
    const worst = Object.values(byAsset).sort((a, b) => b.maxAgeFractionOfBound - a.maxAgeFractionOfBound)[0] ?? null;
    return { verdict: 'NO_EVENT_WORST_CASE_DOCUMENTED', breached, worst, canaryTracked: null };
  }
  // If the chain breached, at least one canary row must have left 'ok', or the canary missed it.
  const canaryTracked = canaryRows.some((r) => r.status !== 'ok');
  return { verdict: 'STALENESS_EVENT_OBSERVED', breached, worst: null, canaryTracked };
}
