/**
 * Types for the slice of `apps/web/src/chain-reader.mjs` this app calls directly:
 * `planVoteCommit`/`assembleVoteCommit`, the read plan `vote-custody.mjs` (and this app's
 * `chain-actions.ts`) consume. The rest of chain-reader.mjs (planCore, assembleVault, …) is not
 * declared here because nothing in this app calls it yet — vaults-ui still renders fixtures for
 * everything except the wallet-signed actions this card adds.
 */

/** A planned read — `call()`'s shape in chain-reader.mjs. `abi` names a table in `@chain/abis`. */
export interface PlannedCall {
  readonly address: string;
  readonly abi: 'VAULT_VIEWS' | 'GOVERNANCE_VIEWS' | string;
  readonly fn: string;
  readonly args: readonly unknown[];
}

export declare const VOTE_COMMIT_ZERO: string;

export declare function planVoteCommit(
  governance: string,
  pid: number | bigint,
  member: string,
): readonly PlannedCall[];

export declare function assembleVoteCommit(r: {
  commitOfValue: unknown;
  revealedValue: unknown;
  revealedSupportValue: unknown;
}): {
  onChainCommitment: string | undefined;
  revealed: boolean | undefined;
  revealedSupport: boolean | undefined;
};
