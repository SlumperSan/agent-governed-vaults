/** Types for `apps/web/src/deposit-status.mjs` — see that file for the full design rationale. */

export type DepositStatusState = 'unknown' | 'none' | 'waiting' | 'available' | 'active';

export interface DepositStatus {
  readonly state: DepositStatusState;
  readonly label: string;
  readonly detail: string;
  readonly availableAt: number | null;
  readonly secondsRemaining: number | null;
}

export declare function classifyDepositStatus(v: {
  pendingAmountUsdc: unknown;
  availableAt: unknown;
  sharesOf: unknown;
  now: unknown;
}): DepositStatus;
