/** Types for `apps/web/src/vault-view.mjs`. */
export declare function oracleHealth(basket: unknown, nowSec: number): Record<string, unknown>;
export declare function votingEligibility(args: Record<string, unknown>): Record<string, unknown>;
export declare function position(
  vault: unknown,
  holding: unknown,
  nowSec: number,
  viewerAddress?: string,
): Record<string, unknown>;
export declare function vaultView(vault: unknown, wallet: unknown, nowSec: number): Record<string, unknown>;
export declare const SORTS: Record<string, (a: unknown, b: unknown) => number>;
