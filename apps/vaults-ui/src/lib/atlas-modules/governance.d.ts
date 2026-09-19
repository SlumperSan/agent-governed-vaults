/** Types for `apps/web/src/governance.mjs`, which mirrors `Governance.sol`. */
export interface ProposalLike {
  readonly pid?: number;
  readonly ptype?: string;
  readonly status?: string;
  /**
   * `| null`, not just `| undefined` — matches `governance.mjs`'s own JSDoc
   * (`commitDeadline?:number|null` etc. on `proposalPhase`). `assembleProposal`
   * (`chain-reader.mjs`) returns an explicit `null` for "not set for this proposal type", and this
   * declaration previously omitted it — invisible with fixture data (cast through `unknown`) and
   * live from the first live proposal that reached it. Same class of bug PR #336/#338 found here.
   */
  readonly commitDeadline?: number | null;
  readonly revealDeadline?: number | null;
  readonly executableAt?: number | null;
  readonly expiresAt?: number | null;
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
  /** `null` for `executed`/`defeated`/`expired` — `governance.mjs` returns it that way; this
   *  declaration previously said `number`, unreachable-in-practice with fixture data alone. */
  readonly deadline: number | null;
  readonly deadlineLabel: string;
}
export declare function proposalPhase(p: ProposalLike, nowSec: number): Phase;
export declare function hasPendingExecution(p: ProposalLike, nowSec: number): boolean;
export declare function quorumReadout(args: Record<string, unknown>): QuorumReadout;
export declare function proposalRight(args: Record<string, unknown>): Record<string, unknown>;
