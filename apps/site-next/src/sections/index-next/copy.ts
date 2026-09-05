/**
 * index-next — the reviewed copy for the closing section of index.html, held
 * as HTML SOURCE BYTES so `<Pinned>` can write it onto the element untouched.
 *
 * PROVENANCE. Every string below is lifted byte-for-byte from
 * `apps/site/index.html`, the section headed `<p class="eyebrow">Next</p>`.
 * Nothing here was rewritten, retitled, shortened or re-punctuated, and the
 * section introduces no sentence of its own. There is no number in this
 * passage, so there is no contract line to cite against one.
 *
 * THE HEADING CHANGED ON 2026-09-05. It was `There is nothing to sign up
 * for.`, one of the claims suite's PERMITTED negations — the exact fragments
 * stripped before the banned-phrase sweep runs, because the two-word
 * registration verb inside it is banned outright everywhere else on the site.
 * The corpus retired that heading here and replaced it with `There is nothing
 * to claim here.`, which contains no banned word and needs no exemption. The
 * PERMITTED entry itself was NOT deleted from the suite — it moved with the
 * sentence, and the sentence itself now lives on who-its-for.html instead
 * (grep `nothing on this site to sign up for`). Do not reintroduce the old
 * heading here on the theory that it still needs a home; it does not.
 *
 * So: NEXT_HEADING below is a verbatim string, not a headline to be tuned for
 * rhythm. The section exists to deny a funnel, and the denial is the design.
 *
 * WHY THESE CONSTANTS RATHER THAN JSX TEXT. `renderToString` escapes text
 * children, so an apostrophe or an ampersand would reach `dist/index.html` as
 * an entity and `html.includes(PHRASE)` — which is exactly how the guard
 * checks — would fail on bytes that look perfect in a browser. Neither
 * sentence needs an entity today; holding them as bytes means neither starts
 * needing one silently on the next edit. See src/shell/PinnedText.tsx.
 *
 * The two sentences below travel nowhere else, which is why they live here
 * rather than in src/shell/pinned.ts: that file is for strings that must stay
 * byte-identical across two or more surfaces.
 */

import { REPO_URL } from '../../shell/pinned';

/** The section's eyebrow. `apps/site/index.html`, `<p class="eyebrow">Next</p>`. */
export const NEXT_EYEBROW = 'Next';

/** Verbatim, terminal full stop included. Do not reword. See the file comment above for why this changed on 2026-09-05. */
export const NEXT_HEADING = 'There is nothing to claim here.';

/**
 * The body sentence pair, verbatim. It enumerates the four conversion
 * surfaces this site does not have and then says what is left.
 *
 * ONE WORD ORDER IS LOAD-BEARING HERE. `no wallet connection` is the reviewed
 * noun form. The verb form of the same pair — the imperative a wallet button
 * carries — is on the banned list outright, with no negation exemption, so
 * rewriting this clause the other way round reds the conversion-surface check
 * on a sentence whose meaning did not change.
 */
export const NEXT_BODY =
  'No mailing list, no allocation, no queue, no wallet connection on this site. The only things to do here are read, and read the code.';

/**
 * The four closing calls to action, in the order and with the labels the
 * current site carries. The labels are carried over rather than composed. The
 * three phrases a closing CTA block reaches for first — the begin imperative,
 * the registration verb and the wallet imperative — are all on the banned list
 * outright, and this is precisely the block a redesign puts one of them in.
 *
 * The first three hrefs also do double duty as navigation pins — every page
 * must literally contain `href="<page>.html"` for all eight pages, and these
 * three are among them. The `.html` suffix stays.
 */
export const NEXT_ACTIONS: ReadonlyArray<{ href: string; label: string; primary?: boolean }> = [
  { href: 'how-it-works.html', label: 'How a vault actually works', primary: true },
  { href: 'who-its-for.html', label: 'Whether it is for you' },
  { href: 'operators.html', label: 'What running one costs' },
  // The repository address is stated once for the whole build, in
  // src/shell/pinned.ts, and read from there rather than retyped.
  { href: REPO_URL, label: 'Contracts and docs' },
];
