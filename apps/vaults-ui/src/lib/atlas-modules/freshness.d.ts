/**
 * Types for `apps/web/src/freshness.mjs`. Hand-written, source is untyped ESM.
 *
 * `Fetched<T>` is the four states EVERY network-backed surface in this app must render — the union
 * is named so a screen cannot quietly implement only two of them. `src/lib/live-vaults.ts` is the
 * only producer for this workspace; `App.tsx` is the only consumer.
 */
export type Fetched<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string; readonly detail?: string; readonly retryable: boolean }
  | { readonly kind: 'ready'; readonly data: T; readonly freshness: Record<string, unknown> };

export declare function loading<T>(): Fetched<T>;
export declare function empty<T>(message: string): Fetched<T>;
export declare function failed<T>(message: string, detail?: string, retryable?: boolean): Fetched<T>;
export declare function ready<T>(data: T, freshness: Record<string, unknown>): Fetched<T>;
export declare function describeError<T>(err: unknown): Fetched<T>;
