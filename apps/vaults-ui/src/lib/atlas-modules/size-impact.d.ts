/** Types for `apps/web/src/size-impact.mjs` — see that file for the full method (the
 *  constant-liquidity walk, the materiality threshold, and why "the nearest initialised tick" is
 *  the wrong edge). */

export declare const MATERIALITY_BPS: bigint;
export declare const MAX_TICK_WALK: number;

export declare function tickBoundaries(p: {
  currentTick: number;
  tickSpacing: number;
  direction: 1 | -1;
  count: number;
}): number[];

export interface MaterialEdge {
  readonly edgeTick: number | null;
  readonly edgeIndex: number | null;
  readonly ticksWalked: number;
  readonly cappedByLimit: boolean;
  readonly readFailed: boolean;
}

export declare function findMaterialEdge(p: {
  liquidity: bigint;
  ticks: readonly { tick: number; liquidityNet: bigint | null }[];
  direction: 1 | -1;
}): MaterialEdge;

export interface SizeForecast {
  readonly ok: boolean;
  readonly pastEdge: boolean;
  readonly edgeTick: number | null;
  readonly capacityInRaw: number | null;
  readonly impactFrac: number | null;
  readonly ticksWalked: number;
  readonly cappedByLimit: boolean;
}

export declare function sizeForecast(p: {
  liquidity: bigint;
  sqrtPriceX96: bigint;
  currentTick: number;
  direction: 1 | -1;
  tokenInIsToken0: boolean;
  ticks: readonly { tick: number; liquidityNet: bigint | null }[];
  requestedAmountInRaw?: number | null;
}): SizeForecast;

export declare function valueRawAtSpot(p: {
  sqrtPriceX96: bigint;
  amountRaw: number;
  amountIsToken0: boolean;
}): number;
