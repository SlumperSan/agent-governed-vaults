/**
 * The one place this app reaches across into `apps/web/src` (and, for the three chain packages
 * `apps/web/src` cannot import itself, into `packages/canary`, `packages/chain-config` and
 * `packages/reference-agent` — see `vite.config.ts`'s alias comment for why those live one hop
 * further out).
 *
 * Components import from here, never from `@atlas/*` or `@chain/*` directly, so the surface
 * that would have to change if the allocator modules moved is this file alone.
 *
 * NO `@atlas/fixtures`. Plan item 0.7 closed on live chain reads replacing the bundled fixture set
 * as this app's data source; `src/lib/live-vaults.ts` is the only place `Vault`/`Proposal`/
 * `BasketLeg` values are constructed, and it builds them from `assembleVault`/`assembleLeg`/
 * `assembleProposal` below, never from `apps/web/src/fixtures.mjs`.
 */
export { usdcExact, usdcShort, usdcCompact, wadExact, shortAddress, parseUnits, formatUnits, bpsPct, duration, USDC_SCALAR } from '@atlas/format';
export type { ParseUnitsResult } from '@atlas/format';
// What an exit actually pays out (apps/web/src/exit-preview.mjs, P-O12) — mirrors
// VaultCore._settleExit/_exitFeeBps term for term. MemberActions.tsx calls this rather than
// asking a member to sign a `requestExit` blind; see that file for the fee-as-a-range rule and
// the SV-5 child-unwind scope note.
export { previewExit, exitFeeBps, secondsUntilFeeBps } from '@atlas/exit-preview';
export type { ExitPreview, ExitPreviewOk, ExitPreviewErr, ExitPreviewSlice } from '@atlas/exit-preview';
export { proposalPhase, quorumReadout, PHASES } from '@atlas/governance';
export { oracleHealth, position, vaultView } from '@atlas/vault-view';
export {
  planCore,
  planBasketAssets,
  planProposalId,
  planLegs,
  planProposal,
  planLegSafety,
  planFeeds,
  assembleVault,
  assembleLeg,
  assembleLegSafety,
  assembleProposal,
  navPerShareWad,
} from '@atlas/chain-reader';
export type {
  PlannedCall,
  CoreReads,
  PausedState,
  BlacklistState,
  LegSafety,
  AssembledLeg,
  AssembledProposal,
  AssembledVault,
} from '@atlas/chain-reader';
export { loading, empty, failed, ready, describeError } from '@atlas/freshness';
export type { Fetched } from '@atlas/freshness';
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
// The refusal VERDICTS (apps/web/src/vault-state.mjs) — the two traps it refuses beyond what the
// contract itself forbids (queueing an irrevocable Mode-F exit while frozen; skipWindow() with
// nothing pending) apply here exactly as they do on the allocator front end, since both read the
// same live chain state. MemberActions.tsx calls `actions()` to decide whether the exit button
// signs at all, rather than re-deriving the frozen/Mode-F refusal a second time in the component.
export { actions, vaultStatus } from '@atlas/vault-state';
export type { VaultFacts, VaultActions, Verdict, VaultNotice, VaultStatusBadge } from '@atlas/vault-state';
// The deposit/exit size-impact notice (#183) — the live constant-liquidity walk over the
// cirBTC/USDC pool. `sizeForecast` is the one entry point MemberActions.tsx calls; the rest are
// exported for chain-actions.ts's own use assembling `ticks` and `tokenInIsToken0` from live pool
// reads. See apps/web/src/size-impact.mjs's own header for the method and why the edge is where
// `liquidityNet` stops being a rounding error, not the nearest initialised tick.
export {
  MATERIALITY_BPS,
  MAX_TICK_WALK,
  tickBoundaries,
  findMaterialEdge,
  sizeForecast,
  valueRawAtSpot,
} from '@atlas/size-impact';
export type { MaterialEdge, SizeForecast } from '@atlas/size-impact';

/**
 * A basket leg as `chain-reader.mjs`'s `assembleLeg` shapes it, plus the per-leg safety tri-state
 * `assembleVault` merges in (card #32).
 *
 * `assetUnit`, NOT `decimals`. The exact on-chain denominator `VaultCore._assetValueWad` divides
 * by, read rather than derived — see `chain-reader.mjs`'s own note on `planLegs`. `decimals` is not
 * carried here because no live read produces one; a fixture-era version of this interface had it
 * and it is exactly the field that would have let a rendering path assume a token's precision
 * instead of reading it.
 *
 * `priceWad`/`valueWad` are `bigint | null` — null iff the leg's `priceWad()` read reverted (see
 * `src/lib/live-vaults.ts` for why that is expected on a frozen vault's affected leg). A component
 * must render "—", never `$0.00`, for a null value: zero is a claim about worth and null is a
 * claim about what could be read, and confusing the two is the exact failure plan item 0.7 exists
 * to close.
 */
export interface BasketLeg {
  readonly symbol: string;
  readonly address: string;
  readonly assetUnit: bigint;
  readonly balance: bigint;
  readonly priceWad: bigint | null;
  readonly valueWad: bigint | null;
  readonly weightBps: number;
  readonly oracleUpdatedAt: number;
  readonly maxStalenessSec: number;
  readonly paused: 'active' | 'paused' | 'unknown';
  readonly blacklisted: 'clear' | 'blacklisted' | 'unknown';
}

/** The proposal a vault currently carries, if any. */
export interface Proposal {
  /** Index signature so a Proposal satisfies governance.mjs's looser ProposalLike. */
  readonly [k: string]: unknown;
  readonly pid: number;
  readonly ptype: string;
  /**
   * NOT ON CHAIN. `Governance.proposals` carries `actionHash`, a hash of the encoded action, and
   * no human-readable title — `assembleProposal` does not set this field at all. Optional rather
   * than defaulted to `''`, so a component that forgets to guard it fails visibly instead of
   * rendering a blank line that looks intentional. `ProposalPanel` falls back to `ptype`.
   */
  readonly title?: string;
  readonly status: string;
  readonly proposer: string;
  readonly createdAt: number;
  readonly commitDeadline?: number | null;
  readonly revealDeadline?: number | null;
  readonly executableAt?: number | null;
  readonly expiresAt?: number | null;
  readonly forWeight?: bigint;
  readonly againstWeight?: bigint;
  readonly revealedWeight?: bigint;
  readonly snapshotTotal?: bigint;
  readonly memberCount?: number;
  readonly revealedVoterCount?: number;
  /**
   * Cranked delegated FOR weight (VO-2b). Absent/null/undefined must read as UNKNOWN, never as 0 —
   * `quorumReadout` already treats it that way; this field only has to carry it through.
   * `| undefined` alongside the optional `?` is deliberate under `exactOptionalPropertyTypes`:
   * `assembleProposal` (`chain-reader.mjs`) always sets this key, with `undefined` as its "not
   * read" value, so the property is present-but-undefined rather than omitted.
   */
  readonly delegatedForWeight?: bigint | null | undefined;
}

export interface Vault {
  readonly address: string;
  /**
   * NOT ON CHAIN — `VAULT_VIEWS` has no `name()`. `assembleVault` defaults this to `''` for a live
   * read; components fall back to `shortAddress(address)` rather than rendering a blank heading.
   */
  readonly name: string;
  /** NOT ON CHAIN either, and defaults the same way. See `operatorAddress`. */
  readonly operatorName: string;
  /**
   * `VaultCore.creator` — the immutable deploy-time payout address (`contracts/config/deployments/
   * base-sepolia.json`'s `operatorPayoutNote`), not a name from any registry. It is what a live
   * read can honestly attribute the vault to.
   */
  readonly operatorAddress: string;
  /** `OperatorRegistry.operatorIdOf(creator) !== 0` — read directly by `live-vaults.ts`, not one of
   *  `chain-reader.mjs`'s `plan*` functions (OperatorRegistry is outside that module's contract). */
  readonly attested: boolean;
  /**
   * `navWad()` reverted, per `ChainlinkOracle.priceWad` going stale/out-of-band/behind a down
   * sequencer for a basket asset. A vault-level FACT, not a transport error — see
   * `chain-reader.mjs`'s header. `navWad`/`navPerShareWad` are `0n` when this is `true` and every
   * component MUST branch on `frozen` before rendering either as currency.
   */
  readonly frozen: boolean;
  readonly totalShares: bigint;
  readonly navWad: bigint;
  readonly navPerShareWad: bigint;
  readonly idleUsdc: bigint;
  /**
   * NOT SOURCED HERE. `VaultCore.capacityCapUsdc` is a real public immutable, but
   * `chain-reader.mjs`'s `planCore`/`assembleVault` do not read it — it was event-projected by
   * `live-adapter.mjs` in the indexer path this workspace no longer goes through. Left out rather
   * than defaulted: `0n` is the contract's own "uncapped" value (VaultCore.sol:85), so defaulting
   * an unread cap to `0n` would render a real cap as "no cap", which is the opposite direction of
   * wrong from rendering nothing. `App.tsx` does not display a capacity-cap row for that reason.
   */
  readonly holderCount: number;
  readonly basket: readonly BasketLeg[];
  readonly proposal: Proposal | null;
  readonly governanceConfig?: Record<string, unknown> | null;
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
