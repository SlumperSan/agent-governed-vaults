/**
 * The one place this app reaches across into `apps/web/src`.
 *
 * Components import from here, never from `@atlas/*` directly, so the surface
 * that would have to change if the allocator modules moved is this file alone.
 */
export { usdcExact, usdcShort, usdcCompact, wadExact, shortAddress, parseUnits, formatUnits } from '@atlas/format';
export type { ParseUnitsResult } from '@atlas/format';
export { proposalPhase, quorumReadout, PHASES } from '@atlas/governance';
export { oracleHealth, position, vaultView } from '@atlas/vault-view';
export { NOW, VAULTS, WALLET, vaultByAddress } from '@atlas/fixtures';
// Commit-reveal salt custody (apps/web/src/vote-custody.mjs) — see that file and
// src/lib/chain-actions.ts for the design. Re-exported here, not imported directly by
// components, for the same reason as everything else in this file.
export { CUSTODY_UNREAD, CUSTODY_NONE, CUSTODY_REVEALED, CUSTODY_READY, CUSTODY_MISMATCH, canReveal } from '@atlas/vote-custody';
export type { VoteCustodyState } from '@atlas/vote-custody';
// Pre-flight refusal checks (apps/web/src/wallet-refusals.mjs, #341) and deposit-status
// classification (apps/web/src/deposit-status.mjs, #340) — what MemberActions.tsx gates a
// signature request on, so this file and that component never disagree with the pure modules.
export { canSign, requestExitPricingRefusal, creatorGateRefusal, exitFeeCeiling } from '@atlas/wallet-refusals';
export type { Refusal, ExitFeeCeiling } from '@atlas/wallet-refusals';
export { classifyDepositStatus } from '@atlas/deposit-status';
export type { DepositStatus } from '@atlas/deposit-status';

/** A basket leg as the fixtures and the chain reader both shape it. */
export interface BasketLeg {
  readonly symbol: string;
  readonly decimals: number;
  readonly address: string;
  readonly balance: bigint;
  readonly priceWad: bigint;
  readonly weightBps: number;
  readonly oracleUpdatedAt: number;
  readonly maxStalenessSec: number;
}

/** The proposal a vault currently carries, if any. */
export interface Proposal {
  /** Index signature so a Proposal satisfies governance.mjs's looser ProposalLike. */
  readonly [k: string]: unknown;
  readonly pid: number;
  readonly ptype: string;
  readonly title: string;
  readonly status: string;
  readonly proposer: string;
  readonly createdAt: number;
  readonly commitDeadline?: number;
  readonly revealDeadline?: number;
  readonly executableAt?: number;
  readonly expiresAt?: number;
  readonly forWeight?: bigint;
  readonly againstWeight?: bigint;
  readonly revealedWeight?: bigint;
  readonly snapshotTotal?: bigint;
  readonly memberCount?: number;
  readonly revealedVoterCount?: number;
  /** Cranked delegated FOR weight (VO-2b). Absent/null must read as UNKNOWN, never as 0 —
   *  `quorumReadout` already treats it that way; this field only has to carry it through. */
  readonly delegatedForWeight?: bigint | null;
}

export interface Vault {
  readonly address: string;
  readonly name: string;
  readonly operatorName: string;
  readonly operatorAddress: string;
  readonly attested: boolean;
  readonly frozen: boolean;
  readonly totalShares: bigint;
  readonly navWad: bigint;
  readonly navPerShareWad: bigint;
  readonly idleUsdc: bigint;
  readonly capacityCapUsdc: bigint;
  readonly holderCount: number;
  readonly basket: readonly BasketLeg[];
  readonly proposal: Proposal | null;
  readonly governanceConfig?: Record<string, unknown>;
  readonly votingEligibleTotalShares?: bigint;
}

export interface WalletPosition {
  readonly vault: string;
  readonly shares: bigint;
  readonly costBasisUsdc: bigint;
  readonly lastDepositTime: number;
  readonly queuedExitShares: bigint;
}

export interface Wallet {
  readonly address: string;
  readonly usdcBalance: bigint;
  readonly positions: readonly WalletPosition[];
}

/** WAD-scaled USD value of one basket leg, matching `VaultCore._assetValueWad`. */
export function legValueWad(leg: BasketLeg): bigint {
  return (leg.balance * leg.priceWad) / 10n ** BigInt(leg.decimals);
}
