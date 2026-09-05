/**
 * faq-next — the reviewed copy for the closing section of faq.html, held as
 * HTML SOURCE BYTES where a guard could ever read the sentence, so `<Pinned>`
 * writes it onto the element untouched.
 *
 * PROVENANCE. Every string below is lifted byte-for-byte from the corpus
 * faq.html's final `<section>`, headed `<p class="eyebrow">Still reading</p>`.
 * Nothing here was rewritten, retitled, shortened or re-punctuated, and this
 * section introduces no sentence of its own.
 *
 * 2026-09-05 CORPUS SYNC. The closing heading and the first call to action
 * changed: risks.html no longer exists as a page, so the corpus points the
 * reader at the Disclaimers page instead of a fifteen-entry risk register —
 * `The risks page answers more than this one does.` became `The Disclaimers
 * answer more than this page does.`, and the `Fifteen named risks` button
 * became a plain `Disclaimers` button linking to `disclaimers.html`. The
 * other two actions (`The mechanism`, `Read the code`) are unchanged.
 *
 * NOTHING PINNED TRAVELS THROUGH HERE. The footer's standing-fact sentences
 * live in the shell footer and (per the 2026-09-05 sync) nowhere else on this
 * page — see src/sections/faq-questions/copy.ts. Neither sentence appears
 * below, and neither may be added.
 *
 * WHY THESE CONSTANTS RATHER THAN JSX TEXT. `renderToString` escapes text
 * children, so an apostrophe or an ampersand would reach `dist/faq.html` as an
 * entity, and a guard checking `html.includes(SENTENCE)` against the raw file
 * would fail on bytes that look perfect in a browser. None of these strings
 * needs an entity today; holding the heading as bytes means it does not start
 * needing one silently on the next edit. See src/shell/PinnedText.tsx.
 *
 * These strings travel nowhere else, which is why they live here rather than
 * in src/shell/pinned.ts — that file is for sentences that must stay
 * byte-identical across two or more surfaces.
 */

import { REPO_URL } from '../../shell/pinned';

/** The section's eyebrow. Unchanged by the 2026-09-05 sync. */
export const NEXT_EYEBROW = 'Still reading';

/**
 * The closing heading, verbatim, terminal full stop included.
 *
 * It is a comparison between two pages of this site and not a claim about the
 * contracts, so there is no contract line to cite against it. It is also the
 * one sentence in this section a guard could plausibly read, which is why it
 * is held as bytes and rendered through `<Pinned>`.
 */
export const NEXT_HEADING = 'The Disclaimers answer more than this page does.';

/**
 * The three closing calls to action, in the order and with the labels the
 * corpus faq.html carries. Labels are carried over, never composed.
 *
 * The `.html` suffix stays — the site suite matches on it, and Pages already
 * redirects the extension-less form.
 */
export const NEXT_ACTIONS: ReadonlyArray<{ href: string; label: string; primary?: boolean }> = [
  { href: 'disclaimers.html', label: 'Disclaimers', primary: true },
  { href: 'how-it-works.html', label: 'The mechanism' },
  // The repository address is stated once for the whole build, in
  // src/shell/pinned.ts, and read from there rather than retyped.
  { href: REPO_URL, label: 'Read the code' },
];
