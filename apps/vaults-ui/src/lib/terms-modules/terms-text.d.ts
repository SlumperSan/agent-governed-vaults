/** Types for `packages/terms/src/terms-text.mjs`. Hand-written: the source is untyped ESM, same
 *  convention as the sibling `../atlas-modules/*.d.ts` files for `apps/web/src`'s own modules. */

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
