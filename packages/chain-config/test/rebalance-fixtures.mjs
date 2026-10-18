/**
 * Fixed inputs and helpers shared by the two byte-identity tests for the Rebalance builder:
 * packages/chain-config/test/rebalance-order.test.mjs (golden digests) and
 * scripts/test/build-rebalance-order-shim.test.mjs (shim equals package). Not named `*.test.mjs`,
 * so the runner does not execute it as a test.
 *
 * The golden digests were captured by running these exact inputs through
 * `scripts/build-rebalance-order.mjs` as it stood on origin/protocol/main 0d7306378, BEFORE the
 * builder moved. Changing an input here without re-capturing from a pre-move copy defeats them.
 */
import { createHash } from 'node:crypto';

export const ADAPTER = '0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1';
export const USDC = '0x3600000000000000000000000000000000000000';
export const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';

export const BASE = {
  adapter: ADAPTER,
  usdc: USDC,
  tokenOut: CIRBTC,
  amountIn: 5_000_000n,
  unitOut: 10n ** 8n,
  priceOutWad: 70000n * 10n ** 18n,
  usdcScalar: 10n ** 12n,
  poolFeeRawPpm: 500n,
  grossOut: 7142n,
  floorBufferBps: 10n,
  deadline: 1_800_000_000n,
};

export const FIXED_CASES = {
  derived: BASE,
  override: { ...BASE, overrideBps: 60n },
  refusedAboveCap: { ...BASE, poolFeeRawPpm: 3000n, grossOut: 7100n, floorBufferBps: 5n },
  // Odd pool fee: ppm to bps rounds UP, so 501 ppm is 6 bps and 500 ppm is 5.
  oddFee: { ...BASE, poolFeeRawPpm: 501n },
  // Pool fill below the oracle floor: exercises the execution-gap ceiling division.
  gapRounding: { ...BASE, grossOut: 7133n },
  // Oracle floor is exactly 10000 units and the pool pays 9960, so the gap is exactly 40 bps with no
  // remainder: the one input where a ceiling division and a floor-plus-one differ.
  exactGap: { ...BASE, priceOutWad: 50000n * 10n ** 18n, grossOut: 9960n },
  // Floor buffer at the chosen tolerance: refused before any minAmountOut is computed.
  bufferAtChosen: { ...BASE, overrideBps: 60n, floorBufferBps: 60n },
  // Buffer inside the tolerance but more than the pool pays after its fee: refused as unaffordable.
  unaffordable: { ...BASE, overrideBps: 150n, floorBufferBps: 149n },
  bigAmount: { ...BASE, amountIn: 123_456_789n, grossOut: 176366n, deadline: 262800n + 1_700_000_000n },
};

/** The whole builder result, bigint-safe, in a stable key order. */
export const stringify = (r) => JSON.stringify(r, (_, x) => (typeof x === 'bigint' ? `${x}n` : x));
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
