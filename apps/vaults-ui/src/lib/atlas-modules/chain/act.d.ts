/**
 * Types for the write-call ABI fragments in `packages/reference-agent/src/act.mjs`. Only the
 * fragment tables are declared — `createActor` itself is agent-loop plumbing (dry-run/execute
 * modes, intents, a `log` object, `config.danger`) this app does not use; it drives viem's
 * `writeContract` directly with these same fragments instead (see `src/lib/chain-actions.ts`).
 */
import type { Abi } from 'viem';

export declare const VAULT_WRITE_ABI: Abi;
export declare const ERC20_WRITE_ABI: Abi;
export declare const GOVERNANCE_WRITE_ABI: Abi;
