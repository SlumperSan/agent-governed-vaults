import { parseTermsSections, TERMS_SUBTITLE, TERMS_TEXT, TERMS_VERSION, termsTextSha256 } from '@rwally/terms';
import type { TermsSection } from '@rwally/terms';

/**
 * The typed source `Terms.tsx` renders from — same role as `disclaimers-copy.ts` plays for
 * `Disclaimers.tsx`. Unlike that file, the sentences here are not hand-ported: they come straight
 * from `packages/terms/src/terms-text.mjs`'s `TERMS_TEXT`, the one string both this app and
 * `apps/vaults-ui` hash, so this file re-exports rather than re-authors the words. Card #214: this
 * is the "typed source the same way disclaimers-copy.ts is" — typed, and walked by the claims
 * guards once built, same as every other page.
 */

export { TERMS_VERSION, TERMS_SUBTITLE, TERMS_TEXT, termsTextSha256 };
export type { TermsSection };

export const HERO = {
  eyebrow: 'Terms of Use',
  title: `Version ${TERMS_VERSION}.`,
  subtitle: TERMS_SUBTITLE,
} as const;

/** Parsed from TERMS_TEXT, not hand-copied — a second transcription is a second place for the
 *  words to drift from what is actually hashed. */
export const SECTIONS: readonly TermsSection[] = parseTermsSections(TERMS_TEXT);

export const SELF_REFERENCE = 'You are reading the <a href="terms.html">Terms of Use</a>.';
