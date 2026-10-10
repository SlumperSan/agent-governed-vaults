// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIALITY_BPS,
  MAX_TICK_WALK,
  tickBoundaries,
  findMaterialEdge,
  sqrtRatioAtOffset,
  amountInForTargetSqrtPrice,
  sqrtPriceAfterAmountIn,
  priceImpactFrac,
  sizeForecast,
  valueRawAtSpot,
} from '../src/size-impact.mjs';

const Q96 = 2 ** 96;
const L = 1_000_000n; // round liquidity so bps math is easy to hand-check
const SQRT_PRICE_X96_ONE = BigInt(Math.round(Q96)); // price == 1 (sqrtP == 1)

// ── the four required mutation tests, plus the fifth (cap-hit) the advisor flagged ──

test('a genuinely material liquidityNet step stops the walk there — MUTATION: this must be RED if the walk keeps going past it', () => {
  // 5% of L, five hundred times MATERIALITY_BPS (10 bps) — unambiguously material.
  const ticks = [{ tick: 100, liquidityNet: -50_000n }];
  const edge = findMaterialEdge({ liquidity: L, ticks, direction: 1 });
  assert.equal(edge.edgeTick, 100, 'the material tick must become the edge');
  assert.equal(edge.ticksWalked, 1);
  assert.equal(edge.readFailed, false);

  const forecast = sizeForecast({
    liquidity: L, sqrtPriceX96: SQRT_PRICE_X96_ONE, currentTick: 0, direction: 1,
    tokenInIsToken0: false, ticks, requestedAmountInRaw: 1e12, // a huge request, well past capacity
  });
  assert.equal(forecast.ok, true);
  assert.equal(forecast.edgeTick, 100);
  assert.equal(forecast.pastEdge, true, 'a size past the material edge must render no number');
  assert.equal(forecast.impactFrac, null);
});

test('a rounding-error-sized liquidityNet step is walked PAST, not stopped at — MUTATION: this must be RED if the walk truncates at the first tick regardless of size (the exact bug that shipped and was retracted)', () => {
  // -0.05% of L at the first boundary (below MATERIALITY_BPS=10bps => rounding error, per the
  // finding's own measured range 0.0007%-0.0157%), then a clearly material step further out.
  const roundingNet = -(L * 5n) / 10_000n; // 0.05% of L
  const materialNet = -(L * 20n) / 100n; // 20% of L
  const ticks = [
    { tick: 100, liquidityNet: roundingNet },
    { tick: 200, liquidityNet: materialNet },
  ];
  const edge = findMaterialEdge({ liquidity: L, ticks, direction: 1 });
  assert.notEqual(edge.edgeTick, 100, 'a rounding-error step must NOT become the edge');
  assert.equal(edge.edgeTick, 200, 'the walk must extend past the rounding-error tick to the real edge');
  assert.equal(edge.ticksWalked, 2);

  // And a size that sits BETWEEN the rounding-error tick and the real edge must still get a
  // number — proving the rounding tick did not truncate capacity either.
  const forecast = sizeForecast({
    liquidity: L, sqrtPriceX96: SQRT_PRICE_X96_ONE, currentTick: 0, direction: 1,
    tokenInIsToken0: false, ticks, requestedAmountInRaw: 1, // tiny — comfortably below any capacity here
  });
  assert.equal(forecast.pastEdge, false);
  assert.ok(forecast.impactFrac !== null, 'a size below the real (200) edge must render a number, not nothing');
});

test('deposit and exit edges are computed independently — never a shared ratio', () => {
  const depositTicks = [
    { tick: 60, liquidityNet: -(L * 1n) / 10_000n }, // rounding
    { tick: 120, liquidityNet: -(L * 1n) / 10_000n }, // rounding
    { tick: 180, liquidityNet: -(L * 30n) / 100n }, // material — edge at 180
  ];
  const exitTicksA = [
    { tick: -60, liquidityNet: -(L * 30n) / 100n }, // material immediately — edge at -60
  ];
  const depositForecastA = sizeForecast({
    liquidity: L, sqrtPriceX96: SQRT_PRICE_X96_ONE, currentTick: 0, direction: 1,
    tokenInIsToken0: false, ticks: depositTicks,
  });
  const exitForecastA = sizeForecast({
    liquidity: L, sqrtPriceX96: SQRT_PRICE_X96_ONE, currentTick: 0, direction: -1,
    tokenInIsToken0: true, ticks: exitTicksA,
  });
  assert.equal(depositForecastA.edgeTick, 180);
  assert.equal(exitForecastA.edgeTick, -60);
  assert.notEqual(depositForecastA.capacityInRaw, exitForecastA.capacityInRaw);

  // Change ONLY the exit side (move its material step further out) and recompute. If the two
  // sides were ever derived from each other by a stored ratio, changing exit's inputs alone
  // would perturb deposit's own edge/capacity. It must not.
  const exitTicksB = [
    { tick: -60, liquidityNet: -(L * 1n) / 10_000n }, // now rounding, not material
    { tick: -120, liquidityNet: -(L * 1n) / 10_000n }, // rounding
    { tick: -180, liquidityNet: -(L * 40n) / 100n }, // material — edge at -180
  ];
  const depositForecastB = sizeForecast({
    liquidity: L, sqrtPriceX96: SQRT_PRICE_X96_ONE, currentTick: 0, direction: 1,
    tokenInIsToken0: false, ticks: depositTicks,
  });
  const exitForecastB = sizeForecast({
    liquidity: L, sqrtPriceX96: SQRT_PRICE_X96_ONE, currentTick: 0, direction: -1,
    tokenInIsToken0: true, ticks: exitTicksB,
  });
  assert.equal(depositForecastB.edgeTick, depositForecastA.edgeTick, 'deposit edge must be unchanged by an exit-only input change');
  assert.equal(depositForecastB.capacityInRaw, depositForecastA.capacityInRaw, 'deposit capacity must be unchanged by an exit-only input change');
  assert.equal(exitForecastB.edgeTick, -180, 'exit edge must move independently when only exit inputs change');
  assert.notEqual(exitForecastB.capacityInRaw, exitForecastA.capacityInRaw);

  // The ratio between the two sides is not constant across the two scenarios — proof there is no
  // fixed multiplier relating one to the other.
  const ratioA = Number(exitForecastA.capacityInRaw) / Number(depositForecastA.capacityInRaw);
  const ratioB = Number(exitForecastB.capacityInRaw) / Number(depositForecastB.capacityInRaw);
  assert.notEqual(ratioA, ratioB);
});

test('a read failure renders nothing/qualitative-only, never a stale or fallback number', () => {
  // liquidity itself unreadable.
  const zeroLiquidity = sizeForecast({
    liquidity: 0n, sqrtPriceX96: SQRT_PRICE_X96_ONE, currentTick: 0, direction: 1,
    tokenInIsToken0: false, ticks: [{ tick: 60, liquidityNet: 0n }], requestedAmountInRaw: 1,
  });
  assert.equal(zeroLiquidity.ok, false);
  assert.equal(zeroLiquidity.edgeTick, null);
  assert.equal(zeroLiquidity.capacityInRaw, null);
  assert.equal(zeroLiquidity.impactFrac, null);

  // A tick read reverted mid-walk (null liquidityNet) — nothing past it can be certified.
  const midWalkFailure = sizeForecast({
    liquidity: L, sqrtPriceX96: SQRT_PRICE_X96_ONE, currentTick: 0, direction: 1,
    tokenInIsToken0: false,
    ticks: [
      { tick: 60, liquidityNet: -(L * 1n) / 10_000n },
      { tick: 120, liquidityNet: null },
      { tick: 180, liquidityNet: -(L * 30n) / 100n },
    ],
    requestedAmountInRaw: 1,
  });
  assert.equal(midWalkFailure.ok, false, 'a failed read anywhere in the walk must refuse to certify anything past it');
  assert.equal(midWalkFailure.edgeTick, null);
  assert.equal(midWalkFailure.impactFrac, null);
});

test('exhausting the walk cap with nothing material renders nothing numeric — a distinct branch from a read failure', () => {
  const negligible = -(L * 1n) / 10_000n; // 0.01% of L at every boundary
  const ticks = Array.from({ length: MAX_TICK_WALK }, (_, i) => ({ tick: (i + 1) * 60, liquidityNet: negligible }));
  const edge = findMaterialEdge({ liquidity: L, ticks, direction: 1 });
  assert.equal(edge.edgeTick, null);
  assert.equal(edge.readFailed, false, 'a capped-out walk is NOT a read failure');
  assert.equal(edge.cappedByLimit, true);
  assert.equal(edge.ticksWalked, MAX_TICK_WALK);

  const forecast = sizeForecast({
    liquidity: L, sqrtPriceX96: SQRT_PRICE_X96_ONE, currentTick: 0, direction: 1,
    tokenInIsToken0: false, ticks, requestedAmountInRaw: 1,
  });
  assert.equal(forecast.ok, true, 'a capped walk is a genuine (if incomplete) verdict, not a read failure');
  assert.equal(forecast.pastEdge, true, 'nothing numeric renders once the cap is hit with no edge found');
  assert.equal(forecast.impactFrac, null);
});

// ── supporting math: reasoned-threshold sanity and the AMM primitives ──

test('MATERIALITY_BPS sits above the measured rounding-error range and below a plausible wall', () => {
  // Findings/2026-09-19-corridor-moved-87-percent-in-a-day.md's own measured range: 0.0007%-0.0157%.
  assert.equal(MATERIALITY_BPS, 10n); // 0.10%
  assert.ok(Number(MATERIALITY_BPS) / 100 > 0.0157, 'threshold must clear every measured rounding step');
});

test('tickBoundaries walks outward in tickSpacing steps, nearest first, on both sides', () => {
  assert.deepEqual(tickBoundaries({ currentTick: 0, tickSpacing: 60, direction: 1, count: 3 }), [60, 120, 180]);
  assert.deepEqual(tickBoundaries({ currentTick: 0, tickSpacing: 60, direction: -1, count: 3 }), [-60, -120, -180]);
  // A tick that is not itself on a boundary still walks from the nearest ones around it.
  assert.deepEqual(tickBoundaries({ currentTick: 67, tickSpacing: 60, direction: 1, count: 2 }), [120, 180]);
  assert.deepEqual(tickBoundaries({ currentTick: 67, tickSpacing: 60, direction: -1, count: 2 }), [60, 0]);
});

test('sqrtRatioAtOffset is the exact relative identity: zero offset returns the anchor, and offsets compose', () => {
  const anchor = SQRT_PRICE_X96_ONE;
  assert.ok(Math.abs(sqrtRatioAtOffset(anchor, 0) - 1) < 1e-12);
  // sqrtP(t0+2) = sqrtP(t0) * 1.0001^(2/2) = sqrtP(t0) * 1.0001^1.
  const at2 = sqrtRatioAtOffset(anchor, 2);
  assert.ok(Math.abs(at2 - 1.0001) < 1e-12);
  // sqrtP(t0+1) = sqrtP(t0) * 1.0001^(1/2) = sqrtP(t0) * sqrt(1.0001).
  const at1 = sqrtRatioAtOffset(anchor, 1);
  assert.ok(Math.abs(at1 - Math.sqrt(1.0001)) < 1e-12);
  // Composability: offset by a then by b from the result of a must equal offset by a+b directly.
  const viaTwoSteps = sqrtRatioAtOffset(BigInt(Math.round(sqrtRatioAtOffset(anchor, 40) * Q96)), 20);
  const direct = sqrtRatioAtOffset(anchor, 60);
  assert.ok(Math.abs(viaTwoSteps - direct) / direct < 1e-9);
});

test('amountInForTargetSqrtPrice and sqrtPriceAfterAmountIn are inverses, for both token sides', () => {
  // Each token side only ever moves price ONE way — token1 in raises it, token0 in lowers it —
  // so each branch is tested against a target on its own physically-reachable side.
  const cases = [
    { tokenInIsToken0: false, target: sqrtRatioAtOffset(SQRT_PRICE_X96_ONE, 40) }, // price up
    { tokenInIsToken0: true, target: sqrtRatioAtOffset(SQRT_PRICE_X96_ONE, -40) }, // price down
  ];
  for (const { tokenInIsToken0, target } of cases) {
    const dIn = amountInForTargetSqrtPrice({
      sqrtPriceX96: SQRT_PRICE_X96_ONE, liquidity: L, targetSqrtP: target, tokenInIsToken0,
    });
    assert.ok(dIn > 0, `amountIn must be positive for tokenInIsToken0=${tokenInIsToken0}`);
    const roundTrip = sqrtPriceAfterAmountIn({
      sqrtPriceX96: SQRT_PRICE_X96_ONE, liquidity: L, amountInRaw: dIn, tokenInIsToken0,
    });
    assert.ok(Math.abs(roundTrip - target) / target < 1e-9, `round trip drifted for tokenInIsToken0=${tokenInIsToken0}`);
  }
});

test('priceImpactFrac is symmetric in sign and exact (not a linear approximation) at a large move', () => {
  assert.equal(priceImpactFrac(1, 1), 0);
  const frac = priceImpactFrac(1, 1.1);
  assert.ok(Math.abs(frac - (1.1 * 1.1 - 1)) < 1e-12);
});

test('valueRawAtSpot converts through the live spot price symmetrically', () => {
  // price != 1 so the two directions are not accidentally identical.
  const sqrtPriceX96 = BigInt(Math.round(2 * Q96)); // price = 4 (token1 per token0)
  const inToken1 = valueRawAtSpot({ sqrtPriceX96, amountRaw: 100, amountIsToken0: true });
  assert.ok(Math.abs(inToken1 - 400) < 1e-6);
  const back = valueRawAtSpot({ sqrtPriceX96, amountRaw: inToken1, amountIsToken0: false });
  assert.ok(Math.abs(back - 100) < 1e-6);
});
