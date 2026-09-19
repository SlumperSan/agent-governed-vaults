/** Types for `apps/web/src/governance.mjs`, which mirrors `Governance.sol`. */
export interface ProposalLike {
  readonly pid?: number;
  readonly ptype?: string;
  readonly status?: string;
  readonly commitDeadline?: number;
  readonly revealDeadline?: number;
  readonly executableAt?: number;
  readonly expiresAt?: number;
  readonly [k: string]: unknown;
}
export interface QuorumReadout {
  readonly regime: string;
  /**
   * THREE STATES, NOT TWO. `null` means "not measurable from what was read", and
   * `quorumReadout` returns it on six paths (five literal, one computed) — including the sub-five regime whenever
   * `delegatedForWeight` was not supplied, because both of that regime's stake terms are
   * `forWeight` MINUS cranked delegated weight (VO-2b) and neither is knowable without it.
   * Declaring this `boolean` is what let `ProposalPanel` render an unknown as a definite
   * "not met" — the mistake this file's siblings exist to prevent, made in this file.
   */
  readonly met: boolean | null;
  /** The >=5-member stake regime only: revealed stake as bps of the snapshot. */
  readonly bps?: number;
  /** Sub-five and RuleChange return this in place of `bps`. */
  readonly forBps?: number;
  /** RuleChange only. */
  readonly revealedBps?: number;
  /** `null` where the vault's own configured quorum was not exposed; absent on other paths. */
  readonly quorumBps?: number | null;
  /** A finished sentence. Render it; do not reassemble one from the parts. */
  readonly text: string;
}
export declare const PROPOSAL_TYPES: readonly string[];
export declare const QUORUM_FLOOR_BPS: number;
export declare const SIGNER_REGIME_BELOW: number;
export declare const PHASES: readonly string[];
/** VERIFIED against governance.mjs by rendering it, not by reading its name. */
export interface Phase {
  readonly phase: string;
  readonly index: number;
  readonly deadline: number;
  readonly deadlineLabel: string;
}
export declare function proposalPhase(p: ProposalLike, nowSec: number): Phase;
export declare function hasPendingExecution(p: ProposalLike, nowSec: number): boolean;
export declare function quorumReadout(args: Record<string, unknown>): QuorumReadout;
export declare function proposalRight(args: Record<string, unknown>): Record<string, unknown>;
