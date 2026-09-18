/** Types for `apps/web/src/fixtures.mjs` — the allocator front end's test fixtures. */
export declare const NOW: number;
export declare const ASSETS: Record<string, unknown>;
export declare const VAULTS: ReadonlyArray<Record<string, unknown>>;
export declare const LEADERBOARD: ReadonlyArray<Record<string, unknown>>;
export declare const WALLET: Record<string, unknown>;
export declare function vaultByAddress(addr: string): Record<string, unknown> | undefined;
