/**
 * Types for `apps/web/src/chain-reader.mjs` — hand-written, like every file in this directory,
 * because the source is untyped ESM. See this directory's own warning in `atlas.ts`'s neighbours:
 * a wrong declaration here is believed by `tsc` over the module it describes, and the mistake
 * surfaces only at render. Kept deliberately narrow — only the shapes `src/lib/live-vaults.ts`
 * and `atlas.ts` actually consume, not every export `chain-reader.mjs` has.
 */

/** A planned read. `abi` names the fragment table (`@chain/abis`) the caller must encode against. */
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
  blockNumber?: bigint | number | null;
}): AssembledVault;

export declare function legValueWad(leg: {
  balance: bigint;
  priceWad: bigint;
  assetUnit: bigint;
}): bigint;

export declare function navPerShareWad(navWad: bigint, totalShares: bigint): bigint;
