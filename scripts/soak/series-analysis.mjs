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
 * Is this per-asset sample a BREACH — i.e. did the vault's pricing actually fail?
 *
 * Post-C-6 the oracle is single-feed-per-asset: there is no quorum and no margin, so an asset is
 * either priceable or frozen, and `priceWad` reverting IS the breach. The `margin < 0` term is
 * retained for a PRE-pivot series (the retired `OracleAggregator`, whose freshness margin was a
 * second, independent observation of the same failure) so an archived run still reduces correctly.
 *
 * `margin` is guarded on type rather than truthiness: a post-pivot sample carries no `margin` at
 * all, and `undefined < 0` quietly reading as "no breach" is the kind of accident this file exists
 * to stop being possible.
 * @param {any} a
 */
export function isBreachSample(a) {
  if (a?.unreadable) return false; // missing evidence is never a finding
  if (a?.priceReverts === true) return true;
  return typeof a?.margin === 'number' && a.margin < 0;
}

/** null-safe min/max that ignore absent observations rather than folding them in as 0. */
const minOf = (cur, v) => (typeof v !== 'number' || Number.isNaN(v) ? cur : cur == null ? v : Math.min(cur, v));
const maxOf = (cur, v) => (typeof v !== 'number' || Number.isNaN(v) ? cur : cur == null ? v : Math.max(cur, v));

/**
 * Reduce the series per asset: worst age, breach count, and the attributed freeze causes.
 *
 * THE RULE THAT MATTERS HERE: an UNREADABLE sample is missing evidence and is counted as neither a
 * breach nor health. The pre-pivot sampler did the opposite — it folded a reverting `latestPrice()`
 * into `fresh: false`, so an unreadable source became a fabricated quorum breach on every sample of
 * a perfectly healthy oracle. Graceful degradation in a measurement tool manufactures findings.
 *
 * The staleness bound is taken from the sample's own `staleBoundSec` (the oracle's on-chain
 * heartbeat) when present, falling back to a legacy sample's config-derived `maxStalenessSeconds`.
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
        readableSamples: 0,
        unreadableSamples: 0,
        ageSamples: 0,
        maxAgeSec: null,
        minAgeSec: null,
        maxAgeFractionOfBound: 0,
        staleBoundSec: a.staleBoundSec ?? a.maxStalenessSeconds ?? null,
        staleBoundSource: a.staleBoundSource ?? (a.maxStalenessSeconds != null ? 'config.maxStalenessSeconds' : null),
        boundDriftSamples: 0,
        quorum: a.quorum ?? null,
        minFreshSources: null,
        minMargin: null,
        priceRevertSamples: 0,
        breachSamples: 0,
        attributionGapSamples: 0,
        causes: /** @type {Record<string, number>} */ ({}),
        worstAt: null,
      });
      acc.samples++;
      if (a.unreadable) { acc.unreadableSamples++; continue; }
      acc.readableSamples++;

      if (typeof a.ageSec === 'number') {
        acc.ageSamples++;
        if (acc.maxAgeSec == null || a.ageSec > acc.maxAgeSec) { acc.maxAgeSec = a.ageSec; acc.worstAt = s.t; }
        acc.minAgeSec = minOf(acc.minAgeSec, a.ageSec);
      }
      acc.maxAgeFractionOfBound = maxOf(acc.maxAgeFractionOfBound, a.ageFractionOfBound ?? 0) ?? 0;
      if (a.staleBoundSec != null) { acc.staleBoundSec = a.staleBoundSec; acc.staleBoundSource = a.staleBoundSource ?? 'feedOf.heartbeat'; }
      if (a.boundDrift) acc.boundDriftSamples++;
      acc.minFreshSources = minOf(acc.minFreshSources, a.freshSources);
      acc.minMargin = minOf(acc.minMargin, a.margin);
      if (a.priceReverts === true) acc.priceRevertSamples++;
      if (a.frozenCauseKey) acc.causes[a.frozenCauseKey] = (acc.causes[a.frozenCauseKey] ?? 0) + 1;
      if (a.attributionGap) acc.attributionGapSamples++;
      if (isBreachSample(a)) acc.breachSamples++;
    }
  }
  return byAsset;
}

/**
 * Reduce the per-sample sequencer gate rows a ChainlinkOracle series carries.
 *
 * `_requireSequencerUp` runs BEFORE any price is trusted, so when it trips every asset of every
 * vault on the oracle freezes at once — it is one row per sample, not per asset. On Base Sepolia
 * `sequencerUptimeFeed` is `address(0)` by design, so the expected reduction there is
 * `{ 'not-configured': N }` and `exercised: false`: the leg is not being tested, which is a stated
 * limit of the testnet run rather than a passing sub-check.
 * @param {any[]} samples
 */
export function summarizeSequencer(samples) {
  /** @type {Record<string, number>} */
  const states = {};
  let configuredSamples = 0;
  let notUpSamples = 0;
  let earliestResumesAtSec = null;
  for (const s of samples) {
    const q = s.sequencer;
    if (!q || typeof q.state !== 'string') continue;
    states[q.state] = (states[q.state] ?? 0) + 1;
    if (q.configured) configuredSamples++;
    if (q.configured && q.state !== 'up' && q.state !== 'unreadable') notUpSamples++;
    if (typeof q.resumesAtSec === 'number' && (earliestResumesAtSec == null || q.resumesAtSec < earliestResumesAtSec)) {
      earliestResumesAtSec = q.resumesAtSec;
    }
  }
  return {
    states,
    configuredSamples,
    notUpSamples,
    earliestResumesAtSec,
    // The leg was actually EXERCISED only if a configured feed was observed. Absence of a feed is
    // not a healthy sequencer; it is an unexecuted code path.
    exercised: configuredSamples > 0,
  };
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
 *
 * `not-configured` / `not-probed` are a THIRD category, added after a live run in which the
 * sampler emitted `freezeSafety: []` for six hours because `SOAK_VAULTS` was never set: the probe
 * had nothing to iterate, so it produced no rows and its own absence was invisible. Those verdicts
 * now record the absence explicitly, and they must NOT be counted as `oracleBlocked` — a
 * misconfigured harness reporting a freeze-safety BREACH is the same class of lie in the opposite
 * direction.
 * @param {any[]} samples
 */
/**
 * Verdicts that mean NOTHING WAS MEASURED, as opposed to something was measured and was fine
 * (`callable`/`ok`), or measured and was not (`BLOCKED`).
 *
 * `unreadable` belongs here for the same reason the others do: a rate-limited RPC is a fact about
 * the transport, never about the contract. Folding it into the failure bucket would let a 429
 * print as "freeze-safety VIOLATED" — a fabricated claim that member funds were trapped.
 */
export const UNMEASURED_VERDICTS = ['not-configured', 'not-probed', 'unreadable'];

/**
 * The operator-facing lines for the freeze-safety leg. A PURE function of the summary, living here
 * rather than inline in drill 4, for one reason: nothing in the repository executes
 * `drill4-oraclefreeze.mjs`, so prose written inline has no regression coverage at all — and the
 * first version of these branches shipped a falsehood because of exactly that.
 *
 * It hardcoded "not-configured/not-probed" as the cause while `unreadable` sat in the same bucket,
 * so an all-`unreadable` window printed "the probe did not run" about samples that ran, and a TO
 * FIX block naming vault discovery for what was a rate limit. That is a statement about
 * CONFIGURATION standing in for a statement about TRANSPORT — the same substitution the branch
 * above it exists to remove, re-created eleven lines below. The cause is now read from the verdict
 * tally instead of assumed, and this function is unit-tested.
 *
 * @param {{verdicts: Record<string, number>, probedWithPending: number, oracleBlocked: number,
 *          unmeasured?: number, blockedDetail?: any[]}} freeze
 * @returns {string[]} lines to log, in order
 */
export function freezeSafetyReport(freeze) {
  const out = [`freeze-safety verdicts: ${JSON.stringify(freeze.verdicts)}`];
  const kinds = Object.keys(freeze.verdicts ?? {}).filter((v) => UNMEASURED_VERDICTS.includes(v));
  const named = kinds.join('/') || 'not-configured/not-probed';
  // `unreadable` means the call WAS attempted and the transport failed. The others mean it was
  // never attempted. Only the latter is fixed by configuring the sampler.
  const ranButUnreadable = kinds.includes('unreadable');
  const unmeasured = freeze.unmeasured ?? 0;

  if (freeze.oracleBlocked > 0) {
    out.push(`  *** cancelPending was NOT callable in ${freeze.oracleBlocked} sample(s) — freeze-safety VIOLATED ***`);
    for (const b of freeze.blockedDetail ?? []) out.push(`     ${b.at} ${b.vault}: ${b.verdict} — ${b.detail}`);
    return out;
  }

  if (freeze.probedWithPending === 0 && unmeasured > 0) {
    out.push(`  cancelPending produced NO USABLE MEASUREMENT: ${unmeasured} sample(s) carry ${named}.`);
    out.push('  This is MISSING EVIDENCE, not a passing check and not an on-chain finding.');
    if (ranButUnreadable) {
      out.push('  `unreadable` means the static call WAS attempted and the transport failed (rate limit,');
      out.push('  timeout, unreachable RPC) — not a contract verdict, and not something the sampler');
      out.push('  configuration can fix. TO FIX: use a less rate-limited RPC and re-run.');
    }
    if (kinds.some((k) => k !== 'unreadable')) {
      out.push('  `not-configured`/`not-probed` mean the probe never ran. TO FIX: the sampler resolves its');
      out.push('  vault set from SOAK_VAULTS, else from the indexer projection. An empty result means the');
      out.push('  indexer had projected no vaults yet (start the sampler after it catches up), or');
      out.push('  SOAK_PROBE_MEMBER was unset. The per-sample `reason` field names which.');
    }
    return out;
  }

  if (freeze.probedWithPending === 0) {
    out.push('  cancelPending was never probed against a REAL pending deposit (every sample was n/a-no-pending),');
    out.push('  so freeze safety is NOT demonstrated by this run — it is merely un-contradicted.');
    out.push('  TO FIX: the sampler must run DURING a 4h observation window, with SOAK_PROBE_MEMBER set');
    out.push('  to the depositor. Drills 1, 2 and 5 each open one — that is the window in which a pending');
    out.push('  deposit actually exists to cancel. Restart oracle-sampler.mjs right after a deposit lands.');
    return out;
  }

  out.push(`  cancelPending stayed callable in all ${freeze.probedWithPending} probed sample(s) — freeze safety held`);
  // Partial coverage must be said out loud. "Held" over a window that was only partly measured is a
  // narrower claim than "held", and the difference is invisible unless it is printed.
  if (unmeasured > 0) {
    out.push(`  NOTE: ${unmeasured} further sample(s) yielded no measurement (${named}),`);
    out.push('  so that holds over the measured samples only, not over the whole window.');
  }
  return out;
}

export function summarizeFreezeSafety(samples) {
  /** @type {Record<string, number>} */
  const verdicts = {};
  let probedWithPending = 0;
  let oracleBlocked = 0;
  let unmeasured = 0;
  const blockedDetail = [];
  for (const s of samples) {
    for (const f of s.freezeSafety ?? []) {
      verdicts[f.verdict] = (verdicts[f.verdict] ?? 0) + 1;
      if (f.verdict === 'callable' || f.verdict === 'ok') probedWithPending++;
      // MISSING EVIDENCE IS NOT A BREACH. `not-configured` (no vaults resolved) and `not-probed`
      // (no SOAK_PROBE_MEMBER) mean the probe never ran; treating them as `oracleBlocked` would
      // report a freeze-safety FAILURE caused entirely by the harness being misconfigured, which
      // is the mirror image of the bug that made this leg silent in the first place.
      //
      // They do NOT suppress `demonstrated` on their own — an earlier version of this comment said
      // they did, which overstated it. `demonstrated` turns on `probedWithPending > 0 &&
      // oracleBlocked === 0`, so unmeasured samples alongside a real `callable` leave it true. That
      // is the right behaviour (positive evidence exists, no breach) and drill 4 prints the
      // unmeasured count beside the verdict so partial coverage is visible rather than implied.
      else if (UNMEASURED_VERDICTS.includes(f.verdict)) unmeasured++;
      else if (f.verdict !== 'n/a-no-pending') {
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
    unmeasured,
    blockedDetail,
    demonstrated: probedWithPending > 0 && oracleBlocked === 0,
  };
}

/**
 * Does this canary transition row describe a BASKET ASSET, as opposed to a per-vault meta row?
 *
 * Both oracle-signal flavors key their per-asset rows by the asset ADDRESS
 * (`oracle-freshness|<vault>|<asset>`). The live flavor also emits two per-vault rows under the
 * same signal name — `sequencer` and `flavor` — and NEITHER may stand in for asset coverage:
 *
 *  - `sequencer` is permanently `skipped` on Base Sepolia, where the oracle leaves
 *    `sequencerUptimeFeed` at `address(0)` by design. A `status !== 'ok'` test that counted it
 *    would be satisfied on every run whether or not any asset row ever left OK.
 *  - `flavor` is the `DETECTOR BROKEN` row emitted when the oracle answers neither known ABI. It is
 *    `skipped` too, and counting it would be strictly worse: a BLIND detector would certify that
 *    the canary tracked the freeze.
 *
 * An address-shaped allowlist is used rather than a `!== 'sequencer'` denylist precisely because
 * the denylist would have missed `flavor`, and would miss the next meta key someone adds.
 * @param {unknown} subject
 */
export function isAssetSubject(subject) {
  return typeof subject === 'string' && /^0x[0-9a-fA-F]{40}$/.test(subject);
}

/**
 * The canary's transition rows for the oracle-freshness signal only.
 * Keys are `signal|vault|subject`. Every row is returned (the drill prints them all); each is
 * tagged `isAsset` so the verdict can require real asset coverage.
 * @param {any} canaryState
 */
export function oracleCanaryRows(canaryState) {
  const out = [];
  for (const [key, v] of Object.entries(canaryState?.transitions ?? {})) {
    if (!key.startsWith('oracle-freshness|')) continue;
    const [signal, vault, subject] = key.split('|');
    out.push({ signal, vault, subject, isAsset: isAssetSubject(subject), ...(/** @type {any} */ (v)) });
  }
  return out;
}

/**
 * The drill's verdict. Separated from printing so the decision is testable.
 *
 * Three outcomes, not two. `INSUFFICIENT_EVIDENCE` exists because "no breach was observed" and "no
 * observation was possible" are opposite conclusions, and the second one used to render as the
 * first: an empty or wholly-unreadable series produced NO_EVENT, which the drill prints as "the
 * expected outcome on a live feed and NOT a failed drill". A drill that certifies nothing must not
 * exit 0.
 * @param {Record<string, any>} byAsset
 * @param {any[]} canaryRows
 */
export function verdictOf(byAsset, canaryRows) {
  const assets = Object.values(byAsset);
  const readable = assets.filter((a) => (a.readableSamples ?? a.samples ?? 0) > 0);
  if (readable.length === 0) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      breached: [], worst: null, canaryTracked: null, canaryAssetRows: 0,
      unreadableSamples: assets.reduce((n, a) => n + (a.unreadableSamples ?? 0), 0),
    };
  }

  const breached = readable.filter((a) => a.breachSamples > 0);
  // Only rows keyed by a basket asset can evidence that the canary saw an asset freeze.
  const assetRows = canaryRows.filter((r) => isAssetSubject(r.subject));
  if (breached.length === 0) {
    const worst = [...readable].sort((a, b) => b.maxAgeFractionOfBound - a.maxAgeFractionOfBound)[0] ?? null;
    return { verdict: 'NO_EVENT_WORST_CASE_DOCUMENTED', breached, worst, canaryTracked: null, canaryAssetRows: assetRows.length };
  }
  // If the chain breached, at least one canary ASSET row must have left 'ok', or the canary missed
  // it. Zero asset rows is therefore "not tracked" — `.some()` on an empty list is false, which is
  // the correct and deliberate reading: no coverage is not coverage.
  const canaryTracked = assetRows.some((r) => r.status !== 'ok');
  return { verdict: 'STALENESS_EVENT_OBSERVED', breached, worst: null, canaryTracked, canaryAssetRows: assetRows.length };
}
