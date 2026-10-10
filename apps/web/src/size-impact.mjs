// @ts-check
/**
 * The live, on-chain-computed deposit/exit size-impact notice — plan item 1.2 (#183). Pure math
 * only: every input here is a chain read the caller already made
 * (`apps/vaults-ui/src/lib/chain-actions.ts`'s `readPoolSizeImpactInputs`); nothing in this file
 * calls a contract, and nothing in it invents a number a caller did not supply.
 *
 * THE METHOD, and why it is not "refuse past the nearest initialised tick" — that version shipped
 * and was retracted; see Findings/2026-09-19-corridor-moved-87-percent-in-a-day.md and
 * Decisions/Deposit size warning is notice-only 2026-09-18.md. Measured on the cirBTC/USDC pool:
 * crossing an initialised tick typically costs 0.001%-0.05% of `liquidity()`, three orders of
 * magnitude below a real capacity limit — so refusing at the nearest tick regardless of its size
 * refuses a question the pool can still answer. The correct edge is the first tick whose
 * `liquidityNet` is NOT a rounding error against the running liquidity: below it, price is
 * computed from the constant-liquidity fit (`sqrtP' = sqrtP +/- amountIn/L`); at or past it,
 * nothing is rendered — no number, no range, no fallback figure of any kind.
 *
 * `MATERIALITY_BPS` sits at 10 bps (0.10%): the finding's own measured boundaries range
 * 0.0007%-0.0157% of L, so 0.10% is roughly 6x the largest rounding-error step actually observed
 * on this pool, while still being two orders of magnitude below where a liquidity WALL (a real
 * capacity limit) would plausibly sit. It is a reasoned constant, not the computed edge itself —
 * the edge (a tick, and the USDC/token amount it implies) is recomputed from a live read every
 * time this module is called, per the deposit-size-warning acceptance criteria.
 *
 * DEPOSIT is a FORECAST ("a deposit like this would move price by roughly X% today"), never a
 * quote and never a block — see Decisions/Deposit size warning is notice-only 2026-09-18.md. The
 * immediate exit preview is a genuine quote; a queued exit preview takes the deposit's forecast
 * wording. This module returns the number; the caller (MemberActions.tsx) owns the wording.
 */

/** 2**96 as a Number — an exact power of two, so this conversion loses no precision. */
const Q96 = 2 ** 96;

/** See this file's header for the derivation. In bps of `liquidity()`. */
export const MATERIALITY_BPS = 10n;

/**
 * The walk is capped rather than unbounded — see Tasks/deposit-size-warning.md: "cap the walk at
 * some sane number of iterations... if you hit the cap render nothing rather than guessing
 * further." A pool whose ladder runs out (uniformly-negligible liquidityNet for 50 straight
 * candidate boundaries) is exactly the shape 2026-09-19-corridor-moved-87-percent-in-a-day.md
 * found at the FAR end of its own measurement — "the binding constraint is the map, not the
 * pool" — so this is a real branch, not a defensive-only one.
 */
export const MAX_TICK_WALK = 50;

/**
 * Candidate tick boundaries walking outward from the current tick, nearest first. Only multiples
 * of `tickSpacing` can ever be initialised, so these are the only ticks worth reading.
 * @param {{currentTick:number, tickSpacing:number, direction:1|-1, count:number}} p
 * @returns {number[]}
 */
export function tickBoundaries({ currentTick, tickSpacing, direction, count }) {
  const spacing = Math.trunc(tickSpacing);
  if (!(spacing > 0) || !Number.isFinite(currentTick)) return [];
  const base = Math.floor(currentTick / spacing) * spacing; // largest multiple of spacing <= currentTick
  const out = [];
  if (direction === 1) {
    // First boundary strictly ABOVE currentTick, then every `spacing` beyond it.
    let t = base + spacing;
    for (let i = 0; i < count; i++, t += spacing) out.push(t);
  } else {
    // First boundary AT OR BELOW currentTick — but if currentTick sits exactly on `base`,
    // crossing DOWN first meets the boundary below it, not `base` itself.
    let t = base >= currentTick ? base - spacing : base;
    for (let i = 0; i < count; i++, t -= spacing) out.push(t);
  }
  return out;
}

/**
 * Walk pre-fetched `{tick, liquidityNet}` entries — ordered nearest-to-farthest, all on one side
 * — and find the first tick whose crossing is NOT a rounding error against the running
 * liquidity. That is the edge: below it the constant-liquidity fit holds, at or past it nothing
 * is rendered.
 *
 * @param {Object} p
 * @param {bigint} p.liquidity            live `liquidity()` at the current tick
 * @param {Array<{tick:number, liquidityNet:bigint|null}>} p.ticks   nearest-first, one side
 * @param {1|-1} p.direction              +1 walking up, -1 walking down — the sign Uniswap
 *   applies `liquidityNet` with when a swap crosses this boundary in this direction
 * @returns {{edgeTick:number|null, edgeIndex:number|null, ticksWalked:number,
 *            cappedByLimit:boolean, readFailed:boolean}}
 */
export function findMaterialEdge({ liquidity, ticks, direction }) {
  if (liquidity == null || liquidity <= 0n) {
    return { edgeTick: null, edgeIndex: null, ticksWalked: 0, cappedByLimit: false, readFailed: true };
  }
  let runningL = liquidity;
  const limit = Math.min(ticks.length, MAX_TICK_WALK);
  for (let i = 0; i < limit; i++) {
    const { tick, liquidityNet } = ticks[i];
    if (liquidityNet === null || liquidityNet === undefined) {
      // A read failure mid-walk: nothing past this point can be certified either way.
      return { edgeTick: null, edgeIndex: null, ticksWalked: i, cappedByLimit: false, readFailed: true };
    }
    const magnitude = liquidityNet < 0n ? -liquidityNet : liquidityNet;
    // material iff magnitude/runningL >= MATERIALITY_BPS/10000 — cross-multiplied to stay integer.
    const material = magnitude * 10_000n >= MATERIALITY_BPS * runningL;
    if (material) {
      return { edgeTick: tick, edgeIndex: i, ticksWalked: i + 1, cappedByLimit: false, readFailed: false };
    }
    runningL = direction === 1 ? runningL + liquidityNet : runningL - liquidityNet;
    if (runningL <= 0n) {
      // Nonsense data (liquidity cannot go to zero or negative from a rounding-sized step) —
      // treat as the edge rather than divide by a value that can no longer be trusted.
      return { edgeTick: tick, edgeIndex: i, ticksWalked: i + 1, cappedByLimit: false, readFailed: false };
    }
  }
  if (ticks.length < MAX_TICK_WALK) {
    // Fewer candidates were supplied than the cap — nothing further to check, and nothing
    // material was found in what there was. This is a read-shape issue for the caller, not a
    // capped walk; treated the same as capped (render nothing) since either way the fit was not
    // verified past this point.
    return { edgeTick: null, edgeIndex: null, ticksWalked: limit, cappedByLimit: true, readFailed: false };
  }
  return { edgeTick: null, edgeIndex: null, ticksWalked: limit, cappedByLimit: true, readFailed: false };
}

/**
 * sqrt(price) at `currentTick + deltaTicks`, given the EXACT current sqrtPriceX96 as an anchor.
 * Exact identity — sqrtP(t) = sqrtP(t0) * 1.0001^((t-t0)/2) — deliberately used in RELATIVE form
 * rather than the absolute tick->sqrtPrice conversion: `deltaTicks` here is at most
 * `MAX_TICK_WALK * tickSpacing`, a small exponent, so float64 carries it to far more precision
 * than a dollar-rounded forecast needs, with no need to port Uniswap's own vendored, GPL-licensed
 * TickMath bit-manipulation (contracts/test/retired/vendor/TickMath.sol) into this MIT-licensed
 * module for a computation this identity gives directly.
 * @param {bigint} sqrtPriceX96
 * @param {number} deltaTicks
 * @returns {number} unscaled sqrt-price ratio (raw token1 per raw token0, square-rooted)
 */
export function sqrtRatioAtOffset(sqrtPriceX96, deltaTicks) {
  const sqrtPCurrent = Number(sqrtPriceX96) / Q96;
  return sqrtPCurrent * Math.pow(1.0001, deltaTicks / 2);
}

/**
 * Raw amount of `tokenIn` required to move price from the current sqrtPrice to `targetSqrtP`,
 * under constant liquidity `L` — the two Uniswap v3 exact-in identities:
 *   giving token1 in (price rises):  dIn = L * (sqrtP_target - sqrtP_current)
 *   giving token0 in (price falls):  dIn = L * (1/sqrtP_target - 1/sqrtP_current)
 * Positive when `targetSqrtP` is on the side `tokenInIsToken0` actually moves price toward;
 * callers only ever call this with a target already known to be in the right direction (the
 * walk's own edge tick, or a tick strictly between current and the edge).
 * @param {{sqrtPriceX96:bigint, liquidity:bigint, targetSqrtP:number, tokenInIsToken0:boolean}} p
 * @returns {number} raw base units of `tokenIn`
 */
export function amountInForTargetSqrtPrice({ sqrtPriceX96, liquidity, targetSqrtP, tokenInIsToken0 }) {
  const sqrtP = Number(sqrtPriceX96) / Q96;
  const L = Number(liquidity);
  if (tokenInIsToken0) return L * (1 / targetSqrtP - 1 / sqrtP);
  return L * (targetSqrtP - sqrtP);
}

/**
 * sqrt(price) after `amountInRaw` of `tokenIn` is applied under constant liquidity — the inverse
 * of `amountInForTargetSqrtPrice`, used for "what would THIS specific size do" rather than "how
 * much reaches THIS specific edge".
 * @param {{sqrtPriceX96:bigint, liquidity:bigint, amountInRaw:number, tokenInIsToken0:boolean}} p
 * @returns {number}
 */
export function sqrtPriceAfterAmountIn({ sqrtPriceX96, liquidity, amountInRaw, tokenInIsToken0 }) {
  const sqrtP = Number(sqrtPriceX96) / Q96;
  const L = Number(liquidity);
  if (tokenInIsToken0) return 1 / (1 / sqrtP + amountInRaw / L);
  return sqrtP + amountInRaw / L;
}

/** Fractional price move between two (unscaled) sqrt-prices — price = sqrtP^2, so this is exact,
 * not a linear approximation, and correct at both small and large moves. */
export function priceImpactFrac(sqrtPBefore, sqrtPAfter) {
  const p0 = sqrtPBefore * sqrtPBefore;
  const p1 = sqrtPAfter * sqrtPAfter;
  if (!(p0 > 0)) return null;
  return Math.abs(p1 - p0) / p0;
}

/**
 * The full forecast for one side (deposit OR exit), independently of the other — never derived
 * from it by a ratio (measured: the buy and sell edges move independently and asymmetrically,
 * 1.35x one day and 16.7x the next — see 2026-09-19-corridor-moved-87-percent-in-a-day.md).
 *
 * @param {Object} p
 * @param {bigint} p.liquidity
 * @param {bigint} p.sqrtPriceX96
 * @param {number} p.currentTick
 * @param {1|-1} p.direction          +1 for a deposit that moves price up, -1 for one that moves
 *   it down (the caller derives this from which side of the pool USDC sits on)
 * @param {boolean} p.tokenInIsToken0 whether the token being GIVEN IN (USDC for a deposit, the
 *   other basket asset for an exit) is the pool's token0
 * @param {Array<{tick:number, liquidityNet:bigint|null}>} p.ticks   nearest-first walk in `direction`
 * @param {number|null} [p.requestedAmountInRaw]   raw amount of the token given in, or null/absent
 *   to skip the per-size figure and report only the edge/capacity
 * @returns {{
 *   ok: boolean,                      false only on a genuine read failure — render nothing
 *   pastEdge: boolean,                true => render nothing numeric, qualitative-only
 *   edgeTick: number|null,
 *   capacityInRaw: number|null,       max `amountInRaw` before the fit stops holding
 *   impactFrac: number|null,          only set when a requested size was given and it is below the edge
 *   ticksWalked: number,
 *   cappedByLimit: boolean,
 * }}
 */
export function sizeForecast({
  liquidity, sqrtPriceX96, currentTick, direction, tokenInIsToken0, ticks, requestedAmountInRaw = null,
}) {
  const edge = findMaterialEdge({ liquidity, ticks, direction });
  if (edge.readFailed) {
    return {
      ok: false, pastEdge: false, edgeTick: null, capacityInRaw: null, impactFrac: null,
      ticksWalked: edge.ticksWalked, cappedByLimit: false,
    };
  }
  if (edge.edgeTick === null) {
    // Walked the whole cap (or ran out of supplied candidates) with nothing material — the fit's
    // extent past the cap is unverified, so this renders exactly like "past the edge": nothing
    // numeric, qualitative only. Distinct from a genuine read failure (`ok` stays true here).
    return {
      ok: true, pastEdge: true, edgeTick: null, capacityInRaw: null, impactFrac: null,
      ticksWalked: edge.ticksWalked, cappedByLimit: edge.cappedByLimit,
    };
  }
  const deltaTicks = edge.edgeTick - currentTick;
  const targetSqrtP = sqrtRatioAtOffset(sqrtPriceX96, deltaTicks);
  const capacityInRaw = amountInForTargetSqrtPrice({ sqrtPriceX96, liquidity, targetSqrtP, tokenInIsToken0 });
  const capacity = capacityInRaw > 0 ? capacityInRaw : 0;

  let impactFrac = null;
  let pastEdge = false;
  if (requestedAmountInRaw != null) {
    if (requestedAmountInRaw >= capacity) {
      pastEdge = true;
    } else {
      const sqrtPBefore = Number(sqrtPriceX96) / Q96;
      const sqrtPAfter = sqrtPriceAfterAmountIn({ sqrtPriceX96, liquidity, amountInRaw: requestedAmountInRaw, tokenInIsToken0 });
      impactFrac = priceImpactFrac(sqrtPBefore, sqrtPAfter);
    }
  }
  return {
    ok: true,
    pastEdge,
    edgeTick: edge.edgeTick,
    capacityInRaw: capacity,
    impactFrac: pastEdge ? null : impactFrac,
    ticksWalked: edge.ticksWalked,
    cappedByLimit: edge.cappedByLimit,
  };
}

/**
 * Convert a raw amount of one pool token into an APPROXIMATE raw amount of the other, at the
 * CURRENT pool spot price — a display-only valuation (never used to size a walk, only to show a
 * USDC-equivalent figure next to an exit's own token amount), so it does not need execution-price
 * precision. Always a live read (`sqrtPriceX96`), never a stored/oracle price — the whole reason
 * this module never mixes the AMM's own basis with the oracle's; see
 * 2026-09-19-corridor-moved-87-percent-in-a-day.md.
 * @param {{sqrtPriceX96:bigint, amountRaw:number, amountIsToken0:boolean}} p
 * @returns {number}
 */
export function valueRawAtSpot({ sqrtPriceX96, amountRaw, amountIsToken0 }) {
  const sqrtP = Number(sqrtPriceX96) / Q96;
  const priceToken1PerToken0 = sqrtP * sqrtP;
  if (!(priceToken1PerToken0 > 0)) return 0;
  return amountIsToken0 ? amountRaw * priceToken1PerToken0 : amountRaw / priceToken1PerToken0;
}
