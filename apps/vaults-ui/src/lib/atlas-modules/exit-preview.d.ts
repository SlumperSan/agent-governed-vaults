/** Types for `apps/web/src/exit-preview.mjs` — see that file for the full design rationale
 *  (term-for-term mirror of `VaultCore._settleExit`/`_exitFeeBps`, the fee-as-a-range rule, and
 *  the scope note on what `SV-5` child-unwind shortfall it does NOT model). */

export declare function exitFeeBps(p: {
  exitFeeMaxBps: unknown;
  exitFeeDecayPeriodSec: unknown;
  tenureSec: unknown;
  isSoleHolder?: boolean;
}): bigint;

export declare function secondsUntilFeeBps(
  p: { exitFeeMaxBps: unknown; exitFeeDecayPeriodSec: unknown; tenureSec: unknown },
  targetBps: unknown,
): number | null;

export interface ExitPreviewSlice {
  readonly symbol: string;
  readonly amount: bigint;
  readonly amountMin: bigint | null;
  readonly decimals: number;
  readonly valueWad: bigint | null;
}

export interface ExitPreviewOk {
  readonly ok: true;
  readonly feeBps: bigint;
  readonly keepBps: bigint;
  readonly isSoleHolder: boolean;
  readonly isFullExit: boolean;
  readonly usdcPay: bigint;
  readonly usdcPayMin: bigint | null;
  readonly slices: readonly ExitPreviewSlice[];
  readonly payoutValueWad: bigint | null;
  readonly payoutValueMinWad: bigint | null;
  readonly perfFee: { readonly gainUsdc: bigint; readonly maxUsdc: bigint; readonly maxFracWad: bigint } | null;
  readonly feeValueWad: bigint | null;
  readonly valueComplete: boolean;
  readonly coversFromChildren: boolean;
}

export interface ExitPreviewErr {
  readonly ok: false;
  readonly error: string;
}

export type ExitPreview = ExitPreviewOk | ExitPreviewErr;

export declare function previewExit(p: {
  burnShares: unknown;
  memberShares: unknown;
  totalShares: unknown;
  idleUsdc: unknown;
  basket?: readonly { symbol: string; balance: unknown; priceWad?: unknown; decimals: number }[];
  costBasisUsdc?: unknown;
  exitFeeMaxBps: unknown;
  exitFeeDecayPeriodSec: unknown;
  tenureSec: unknown;
  childValueWad?: unknown;
}): ExitPreview;
