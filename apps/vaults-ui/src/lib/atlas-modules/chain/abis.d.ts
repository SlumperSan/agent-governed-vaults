/**
 * Types for `packages/canary/src/abis.mjs`. Hand-written: the source is untyped ESM, drift-checked
 * against the compiled contracts by `packages/canary/test/abis.test.mjs` — not by this file. Only
 * the fragment tables `src/lib/live-vaults.ts` and `src/lib/chain-actions.ts` actually encode
 * against are declared — two independent callers of the same module, one file each side of a
 * merge, consolidated here rather than left as two declarations of the same export.
 */
import type { Abi } from 'viem';

export declare const VAULT_VIEWS: Abi;
export declare const GOVERNANCE_VIEWS: Abi;
export declare const CHAINLINK_ORACLE_VIEWS: Abi;
export declare const AGGREGATOR_V3_VIEWS: Abi;
export declare const TOKEN_SAFETY_VIEWS: Abi;
export declare const OPERATOR_REGISTRY_VIEWS: Abi;
/** Card 211 (A2) — `allowSubVaults`/`vaultCount`/`allVaults`, the manifest read. */
export declare const VAULT_FACTORY_VIEWS: Abi;
// The size-impact notice's pool reads (#183) — chain-actions.ts's readPoolSizeImpactInputs.
export declare const UNISWAP_V3_FACTORY_VIEWS: Abi;
export declare const UNISWAP_V3_POOL_VIEWS: Abi;
