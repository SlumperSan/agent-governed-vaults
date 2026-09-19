/** Types for `apps/web/src/format.mjs`. Hand-written: the source is untyped ESM. */
export declare const USDC_DECIMALS: number;
export declare const WAD_DECIMALS: number;
export declare function usdcExact(value: unknown, opts?: { unit?: boolean }): string;
export declare function usdcShort(value: unknown): string;
export declare function usdcCompact(value: unknown): string;
export declare function wadExact(value: unknown, opts?: { maxFrac?: number }): string;
export declare function formatUnits(value: unknown, decimals: number, opts?: Record<string, unknown>): string;
export declare function shortAddress(a: unknown): string;
export type ParseUnitsResult = { ok: true; value: bigint } | { ok: false; error: string };
export declare function parseUnits(input: unknown, decimals?: number, opts?: { unit?: string }): ParseUnitsResult;
