/**
 * ops-reference-agent — the reviewed copy for the closing section of
 * operators.html, which is now three links and nothing else.
 *
 * PROVENANCE. `ACTIONS` is the corpus's own closing block: the three links,
 * in the order and with the labels `apps/site/operators.html` carries. Nothing
 * here was rewritten, retitled, shortened or re-punctuated, and this section
 * composes no sentence of its own.
 *
 * NO NUMBER APPEARS IN THIS SECTION, so there is no contract line to cite. The
 * operators page states one quantified obligation — the 2,500 USDG figure, the
 * 5% share of supply, the proposal threshold and the withdrawal gate — and all
 * of it lives in ops-obligation, several sections above. Restating any part of
 * it here would put a second copy of a pinned figure on the page, which is how
 * two statements of one number drift apart. This section carries none.
 *
 * DELETED 2026-09-05: `EYEBROW` ("Reference agent"), `HEADING` ("The reference
 * agent is beta code, and outside the review scope.") and `BODY` (the
 * three-sentence beta-code paragraph). The corpus's final `<section>` on
 * operators.html is actions-only, and the caveat itself lives on the
 * Disclaimers page as numbered risk 12, "The reference agent is beta code",
 * which this build already renders correctly. Carrying it here as well stated
 * one caveat twice in two different wordings, and the operators wording was
 * the weaker of the two: the register entry records the two launch-class bugs
 * that running the agent live exposed, and this paragraph did not. One
 * statement, on the page the owner's 2026-09-05 decision put every caveat on.
 * Do not restore an eyebrow, a heading or a body paragraph to this section.
 *
 * NOTHING PINNED TRAVELS THROUGH HERE. The two footer sentences carry an exact
 * count of one on operators.html, and they are the shell footer's. Repeating
 * either in a closing block would be a second copy, and the sweep that strips
 * only the permitted count would then find the licence and token-denial words
 * it forbids outside the footer standing loose on the page. Neither appears
 * below, and neither may be added.
 *
 * NO PROSE IS LEFT IN THIS FILE, so nothing here goes through `<Pinned>` any
 * more. If a sentence is ever added back, hold it as HTML source bytes and
 * render it through `<Pinned>`: `renderToString` escapes text children, so an
 * apostrophe or an ampersand would reach `dist/operators.html` as an entity and
 * a guard checking `html.includes(SENTENCE)` against the raw file would fail on
 * bytes that look correct in a browser. See src/shell/PinnedText.tsx.
 *
 * The labels travel nowhere else, which is why they live here rather than
 * in src/shell/pinned.ts — that file is for sentences that must stay
 * byte-identical across two or more surfaces.
 */

import { REPO_URL } from '../../shell/pinned';

/**
 * The three closing calls to action, in the order and with the labels
 * `apps/site/operators.html` already carries. Labels are carried over, never
 * composed: the three phrases a closing block reaches for first — the begin
 * imperative, the registration verb and the wallet imperative — are all banned
 * outright, and this is precisely the block a redesign puts one of them in.
 *
 * These labels are page-local and are NOT the shared set in
 * `src/shell/pinned.ts`. That set (`CTA`) holds the labels repeated across
 * pages; none of its entries match "Disclaimers", so the primary label below
 * is inlined rather than forced into a near-synonym from that map. The other
 * two are the ones this page has always used, and swapping in a shared
 * near-synonym would be a rewrite of reviewed copy dressed as a tidy-up.
 *
 * The first two hrefs also do double duty as navigation pins. Every page must
 * literally contain `href="disclaimers.html"` and `href="how-it-works.html"`
 * among the eight; the masthead carries seven and the footer carries all
 * eight, and these two are repeated here exactly as the current page repeats
 * them. The `.html` suffix stays — the site suite matches on it, and Pages
 * already redirects the extension-less form.
 */
export const ACTIONS: ReadonlyArray<{ href: string; label: string; primary?: boolean }> = [
  { href: 'disclaimers.html', label: 'Disclaimers', primary: true },
  { href: 'how-it-works.html', label: 'Governance mechanics' },
  // The repository address is stated once for the whole build, in
  // src/shell/pinned.ts, and read from there rather than retyped.
  { href: REPO_URL, label: 'Read the agent source' },
];
