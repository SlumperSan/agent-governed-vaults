// @ts-check
import { EPOCH_SECONDS } from './constants.mjs';

/**
 * Epoch `n` covers [anchor + n*EPOCH_SECONDS, anchor + (n+1)*EPOCH_SECONDS). The start is inclusive
 * and the end exclusive: a balance change stamped exactly at the start belongs to the new epoch.
 * @param {number} anchor unix seconds of the first agent vault's deploy block (per-chain config)
 * @param {number} n
 */
export function epochBounds(anchor, n) {
  assertInt(anchor, 'anchor');
  assertInt(n, 'epoch number');
  const start = anchor + n * EPOCH_SECONDS;
  return { start, end: start + EPOCH_SECONDS };
}

/** The epoch number containing `ts`; throws before the anchor. */
export function epochOf(anchor, ts) {
  assertInt(anchor, 'anchor');
  assertInt(ts, 'timestamp');
  if (ts < anchor) throw new Error(`epochOf: ${ts} is before the anchor ${anchor}`);
  return Math.floor((ts - anchor) / EPOCH_SECONDS);
}

function assertInt(v, what) {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`epoch: ${what} must be a non-negative integer, got ${v}`);
}
