/** Types for `apps/web/src/wallet-refusals.mjs` — see that file for the four cases' full rationale. */

export type Refusal =
  | { kind: 'allowed'; code: null; reason: string }
  | { kind: 'allowed-irreversible'; code: null; reason: string }
  | { kind: 'refused'; code: string; reason: string }
  | { kind: 'unknown'; code: null; reason: string };

export declare const CREATOR_MIN_STAKE_BPS: bigint;

export declare function canSign(v: Refusal): boolean;

export declare function skipWindowRefusal(f: { skipOptIn: boolean | null | undefined }): Refusal;

export declare function requestExitPricingRefusal(f: {
  proposal: Record<string, unknown> | null | 'unknown';
  nowSec: number;
}): Refusal;

export declare function creatorGateRefusal(f: {
  creator: string | null;
  member: string | null;
  sharesOf: bigint | string | null;
  totalShares: bigint | string | null;
  nonCreatorMemberCount: bigint | string | null;
  burnShares: bigint | string | null;
}): Refusal;

export type ExitFeeCeiling =
  | { kind: 'allowed'; ceilingBps: bigint; reason: string }
  | { kind: 'unknown'; ceilingBps: null; reason: string };

export declare function exitFeeCeiling(f: {
  exitFeeMaxBps: bigint | number | string | null | undefined;
  exitFeeDecayPeriodSec: bigint | number | string | null | undefined;
  tenureSec: bigint | number | string | null | undefined;
}): ExitFeeCeiling;
