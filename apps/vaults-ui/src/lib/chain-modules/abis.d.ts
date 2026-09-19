/**
 * Types for the read-call ABI fragments in `packages/canary/src/abis.mjs` this app resolves
 * `planVoteCommit`'s string-named tables against, plus the two direct reads (`usdc`, `governance`,
 * `sharesOf`) `chain-actions.ts` makes to build a deposit/exit transaction. Only the two tables
 * this app touches are declared here — the rest of abis.mjs is the canary's own concern.
 */
import type { Abi } from 'viem';

export declare const VAULT_VIEWS: Abi;
export declare const GOVERNANCE_VIEWS: Abi;
