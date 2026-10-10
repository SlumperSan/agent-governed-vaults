/** Types for `apps/web/src/vault-view.mjs`. */

/**
 * Matched to the real return shape of `oracleHealth`, not left `Record<string, unknown>` the way
 * `proposalPhase` once was — that declaration lied about an object as a string, `tsc` believed it
 * over the module, and the page threw at render (`ssr-smoke.tsx`'s own header tells that story).
 * `state` is a closed union rather than `string` for the same reason.
 */
export interface OracleLegHealth {
  readonly symbol: string;
  readonly state: 'unheld' | 'unknown' | 'stale' | 'ageing' | 'fresh';
  readonly ageSec: number | null;
  readonly boundSec: number | null;
  readonly overBySec: number | null;
}
export interface OracleHealth {
  readonly assets: readonly OracleLegHealth[];
  readonly frozen: boolean;
  /** false when any leg's `state` is `'unknown'` — the vault's freshness cannot be fully read. */
  readonly determinable: boolean;
  readonly culprits: readonly string[];
}
export declare function oracleHealth(basket: unknown, nowSec: number): OracleHealth;
export declare function votingEligibility(args: Record<string, unknown>): Record<string, unknown>;
export declare function position(
  vault: unknown,
  holding: unknown,
  nowSec: number,
  viewerAddress?: string,
): Record<string, unknown>;
export declare function vaultView(vault: unknown, wallet: unknown, nowSec: number): Record<string, unknown>;
export declare const SORTS: Record<string, (a: unknown, b: unknown) => number>;
