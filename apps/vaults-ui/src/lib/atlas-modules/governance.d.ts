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
  readonly met: boolean;
  readonly bps: number;
  readonly quorumBps: number;
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
