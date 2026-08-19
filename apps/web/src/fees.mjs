// @ts-check
/**
 * Sub-vault fee-stacking math for the SV-4 "cumulative effective fee" display. Mirrors
 * SubVaultRegistry.stackedPerfFeeBps / stackedExitFeeCapBps exactly, so the UI shows what the
 * contract enforces. Pure + tested (see test/fees.test.mjs).
 */

const PERF_FEE_BPS = 1000; // 10% per level, protocol-fixed

/**
 * Cumulative effective performance fee across a chain of `levels` (1 = root), in bps.
 * 1 - (1 - f)^levels. A depositor at a depth-2 child pays 19%, not 20% — fees compound on
 * net-of-fee value, not additively.
 * @param {number} levels
 */
export function stackedPerfFeeBps(levels) {
  let keep = 10_000;
  for (let i = 0; i < levels; i++) keep = Math.floor((keep * (10_000 - PERF_FEE_BPS)) / 10_000);
  return 10_000 - keep;
}

/**
 * Cumulative exit-fee ceiling across the ancestor chain, in bps — the sum of each level's
 * exitFeeMaxBps (they can each fire on a withdrawal that unwinds through the chain).
 * @param {number[]} exitFeeMaxBpsByLevel  root-first
 */
export function stackedExitFeeCapBps(exitFeeMaxBpsByLevel) {
  return exitFeeMaxBpsByLevel.reduce((a, b) => a + b, 0);
}

/** Format bps as a percentage string, e.g. 1900 -> "19.00%". */
export function bpsToPct(bps) {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Build the full effective-fee breakdown for a vault at `depth` (0 = root) with per-level exit
 * fee ceilings. Returns the numbers the UI renders.
 * @param {number} depth
 * @param {number[]} exitFeeMaxBpsByLevel root-first, length depth+1
 */
export function effectiveFees(depth, exitFeeMaxBpsByLevel) {
  const levels = depth + 1;
  return {
    levels,
    stackedPerfFeeBps: stackedPerfFeeBps(levels),
    stackedExitFeeCapBps: stackedExitFeeCapBps(exitFeeMaxBpsByLevel.slice(0, levels)),
    perLevelPerfFeeBps: PERF_FEE_BPS,
  };
}
