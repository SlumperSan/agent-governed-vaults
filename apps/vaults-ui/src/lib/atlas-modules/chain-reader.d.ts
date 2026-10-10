/**
 * Types for `apps/web/src/chain-reader.mjs` — hand-written, like every file in this directory,
 * because the source is untyped ESM. See this directory's own warning in `atlas.ts`'s neighbours:
 * a wrong declaration here is believed by `tsc` over the module it describes, and the mistake
 * surfaces only at render. Kept deliberately narrow — only the shapes `src/lib/live-vaults.ts`,
 * `src/lib/chain-actions.ts` and `atlas.ts` actually consume, not every export `chain-reader.mjs`
 * has: `planCore`/`assembleVault`/… (the vault-read surface `live-vaults.ts` calls) and
 * `planVoteCommit`/`assembleVoteCommit` (the vote-custody surface `chain-actions.ts` calls) are
 * two independent slices of the same module, declared together here because both PRs that added
 * them declared this same file.
 */

/** A planned read — `call()`'s shape in chain-reader.mjs. `abi` names a table in `@chain/abis`. */
export interface PlannedCall {
  readonly address: string;
  readonly abi: string;
  readonly fn: string;
  readonly args: readonly unknown[];
}

export declare function planCore(vault: string): readonly PlannedCall[];
export declare function planBasketAssets(vault: string, basketLength: number): readonly PlannedCall[];
export declare function planProposalId(governance: string, vault: string): readonly PlannedCall[];
export declare function planLegs(
  vault: string,
  oracle: string,
  assets: readonly string[],
): readonly PlannedCall[];
export declare function planProposal(governance: string, pid: number | bigint): readonly PlannedCall[];
export declare function planLegSafety(vault: string, assets: readonly string[]): readonly PlannedCall[];
export declare function planFeeds(feeds: readonly string[]): readonly PlannedCall[];

/** Card 211 (A2) — the deployment-manifest check. See `chain-reader.mjs`'s own doc comments. */
export type ManifestState = 'verified' | 'not-found' | 'unknown';
export declare function planFactoryVaultCount(factory: string): readonly PlannedCall[];
export declare function planFactoryAllVaults(factory: string, count: number): readonly PlannedCall[];
export declare function assembleManifestCheck(
  vaultAddress: string,
  countValue: unknown,
  allVaultsValues: readonly unknown[],
): ManifestState;

/** Card 211 (B2) — escrow claim surface. */
export declare function planClaimableEscrow(
  vault: string,
  member: string | null | undefined,
  assets: readonly string[],
): readonly PlannedCall[];
export interface ClaimableEscrowEntry {
  readonly asset: string;
  readonly amount: bigint;
  readonly readAt: number | null;
}
export interface UnreadEscrowEntry {
  readonly asset: string;
  readonly readAt: number | null;
}
export declare function assembleClaimableEscrow(
  entries: readonly { asset: string; value: unknown; readAt?: number | null }[],
): { claimable: readonly ClaimableEscrowEntry[]; unread: readonly UnreadEscrowEntry[] };

export interface CoreReads {
  readonly navWad: bigint | null;
  readonly totalShares: bigint;
  readonly idleUsdc: bigint;
  readonly usdcScalar: bigint;
  readonly totalPendingUsdc: bigint;
  readonly oracle: string;
  readonly governance: string;
  readonly creator: string;
  readonly childVaultCount?: number | bigint;
}

export type PausedState = 'active' | 'paused' | 'unknown';
export type BlacklistState = 'clear' | 'blacklisted' | 'unknown';

export interface LegSafety {
  readonly address: string;
  readonly paused: PausedState;
  readonly pausedReadAt: number | null;
  readonly blacklisted: BlacklistState;
  readonly blacklistedReadAt: number | null;
}

export declare const LEG_SAFETY_UNREAD: Omit<LegSafety, 'address'>;

export interface AssembledLeg {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly assetUnit: bigint;
  readonly balance: bigint;
  /** `null` when the price read reverted — the caller must not fabricate a number for it. */
  readonly priceWad: bigint | null;
  readonly feed: string;
  readonly oracleUpdatedAt: number;
  readonly maxStalenessSec: number;
  readonly weightBps: number;
  /** `null` iff `priceWad` is `null`. */
  readonly valueWad: bigint | null;
}

export declare function assembleLeg(r: {
  address: string;
  symbol?: string;
  decimals?: number;
  assetUnit: bigint;
  balance: bigint;
  priceWad: bigint | null;
  feed: { feed: string; heartbeat: number | bigint };
  oracleUpdatedAt: number;
}): AssembledLeg;

export declare function assembleLegSafety(r: {
  address: string;
  pausedValue: unknown;
  pausedReadAt: number | null;
  blacklistedValue: unknown;
  blacklistedReadAt: number | null;
}): LegSafety;

export interface AssembledProposal {
  /** So an `AssembledProposal` satisfies `Proposal`'s (and `ProposalLike`'s) looser index signature. */
  readonly [k: string]: unknown;
  readonly pid: number;
  readonly ptype: string;
  readonly status: string;
  readonly proposer: string;
  readonly createdAt: number;
  readonly commitDeadline: number | null;
  readonly revealDeadline: number | null;
  readonly executableAt: number | null;
  readonly expiresAt: number | null;
  readonly actionHash: string;
  readonly snapshotTotal: bigint;
  readonly memberCount: number;
  readonly forWeight: bigint;
  readonly againstWeight: bigint;
  readonly revealedWeight: bigint;
  readonly revealedVoterCount: number;
  readonly delegatedForWeight: bigint | undefined;
}

export declare function assembleProposal(
  pid: number | bigint,
  p: unknown,
  delegatedForWeight?: bigint | number | null,
): AssembledProposal | null;

export interface AssembledVault {
  readonly address: string;
  readonly name: string;
  readonly operatorName: string;
  readonly operatorAddress: string;
  readonly attested: boolean;
  readonly frozen: boolean;
  readonly chainRead: true;
  readonly navWad: bigint;
  readonly navPerShareWad: bigint;
  readonly totalShares: bigint;
  readonly idleUsdc: bigint;
  readonly totalPendingUsdc: bigint;
  readonly usdcScalar: bigint;
  readonly holderCount: number;
  /**
   * `null` — never `0` — when unread (card 210). "addresses with shares > 0, EXCLUDING the
   * creator" (VaultCore.sol:107), as distinct from `holderCount`'s "creator included"
   * (VaultCore.sol:128). This is the count `apps/web/src/seeded.mjs`'s `organicMemberBound`
   * expects, never `holderCount` itself — the creator is the RWAlly team's own Safe, not on the
   * seeded-persona list, so subtracting only seeded addresses from `holderCount` would silently
   * count the creator as organic.
   */
  readonly nonCreatorMemberCount: number | null;
  readonly childVaultCount: number;
  readonly oracle: string;
  readonly governance: string;
  readonly creator: string;
  readonly basket: readonly (AssembledLeg & Omit<LegSafety, 'address'>)[];
  readonly proposal: AssembledProposal | null;
  readonly governanceConfig: Record<string, unknown> | null;
  readonly blockNumber: bigint | number | null;
}

export declare function assembleVault(r: {
  address: string;
  core: CoreReads;
  legs?: readonly AssembledLeg[];
  legSafety?: readonly (LegSafety | undefined)[];
  proposal?: AssembledProposal | null;
  governanceConfig?: Record<string, unknown> | null;
  name?: string;
  operatorName?: string;
  operatorAddress?: string;
  attested?: boolean;
  holderCount?: number;
  nonCreatorMemberCount?: number;
  blockNumber?: bigint | number | null;
}): AssembledVault;

export declare function legValueWad(leg: {
  balance: bigint;
  priceWad: bigint;
  assetUnit: bigint;
}): bigint;

export declare function navPerShareWad(navWad: bigint, totalShares: bigint): bigint;

/** Commit-reveal vote custody (#339) — the read plan `vote-custody.mjs` and `chain-actions.ts` consume. */
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
