/** Types for `packages/terms/src/terms-text.mjs`. Hand-written: the source is untyped ESM — the
 *  same convention `apps/vaults-ui/src/lib/atlas-modules/*.d.ts` uses for `apps/web/src`'s own
 *  untyped modules. Resolved to the real file by the `@rwally/terms` alias in `vite.config.ts`;
 *  `tsconfig.json`'s `paths` entry points type-checking at this file instead. */

export declare const TERMS_VERSION: string;
export declare const TERMS_SUBTITLE: string;
export declare const TERMS_TEXT: string;

export type TermsBlock =
  | { readonly type: 'p'; readonly html: string }
  | { readonly type: 'ul'; readonly items: readonly string[] };

export interface TermsSection {
  readonly id: string;
  readonly number: number;
  readonly heading: string;
  readonly body: readonly TermsBlock[];
}

export declare function parseTermsSections(text: string): TermsSection[];

/** SHA-256 hex digest of `TERMS_TEXT`, via Web Crypto. Memoized: every caller in one page load
 *  gets the same resolved string. */
export declare function termsTextSha256(): Promise<string>;
