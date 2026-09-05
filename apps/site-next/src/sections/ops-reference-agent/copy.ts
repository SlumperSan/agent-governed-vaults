/**
 * ops-reference-agent — the reviewed copy for the closing section of
 * operators.html, held as HTML SOURCE BYTES wherever a guard could read the
 * sentence, so `<Pinned>` writes it onto the element untouched.
 *
 * PROVENANCE. `EYEBROW`, `HEADING` and `BODY` below are lifted byte-for-byte
 * from `apps/site/operators.html`'s final `<section>` as it read at the time
 * this file was written (grep for "The reference agent is beta code, and
 * outside the review scope"); the current corpus has moved on for that
 * section — see the UNPAIRED note below. `ACTIONS` is kept in step with
 * whatever that closing block currently links to. Nothing here was rewritten,
 * retitled, shortened or re-punctuated, and this section introduces no
 * sentence of its own beyond what stands unpaired.
 *
 * NO NUMBER APPEARS IN THIS SECTION, so there is no contract line to cite. The
 * operators page states one quantified obligation — the 2,500 USDG figure, the
 * 5% share of supply, the proposal threshold and the withdrawal gate — and all
 * of it lives in ops-obligation, several sections above. Restating any part of
 * it here would put a second copy of a pinned figure on the page, which is how
 * two statements of one number drift apart. This section carries none.
 *
 * UNPAIRED WITH THE CURRENT CORPUS, BEYOND THE ACTIONS. The corpus's final
 * `<section>` on operators.html is now actions-only — no eyebrow, no heading,
 * no body paragraph, just the three closing links. `EYEBROW`, `HEADING` and
 * `BODY` below therefore have no corpus counterpart any more. Per the rule for
 * redesign-only content, they are left in place rather than deleted or
 * restructured — nothing in them contradicts the corpus, and removing the
 * section's landmark heading is a structural change this pass does not make.
 * Only `ACTIONS[0]` changes, because it is the one thing the corpus's actions
 * block still constrains.
 *
 * NOTHING PINNED TRAVELS THROUGH HERE. The two footer sentences carry an exact
 * count of one on operators.html, and they are the shell footer's. Repeating
 * either in a closing block would be a second copy, and the sweep that strips
 * only the permitted count would then find the licence and token-denial words
 * it forbids outside the footer standing loose on the page. Neither appears
 * below, and neither may be added.
 *
 * WHY THESE CONSTANTS RATHER THAN JSX TEXT. `renderToString` escapes text
 * children, so an apostrophe or an ampersand would reach `dist/operators.html`
 * as an entity, and a guard checking `html.includes(SENTENCE)` against the raw
 * file would fail on bytes that look correct in a browser. None of these
 * strings needs an entity today; holding them as bytes means none starts
 * needing one silently on the next edit. See src/shell/PinnedText.tsx.
 *
 * These strings travel nowhere else, which is why they live here rather than
 * in src/shell/pinned.ts — that file is for sentences that must stay
 * byte-identical across two or more surfaces.
 */

import { REPO_URL } from '../../shell/pinned';

/** The section's eyebrow. `apps/site/operators.html`, `<p class="eyebrow">Reference agent</p>`. */
export const EYEBROW = 'Reference agent';

/**
 * The closing heading, verbatim, terminal full stop included.
 *
 * It states two things about a piece of software in the repository — its
 * maturity, and what the contract security review did and did not cover — so
 * there is no contract function to read it against; the source is the scope of
 * the review itself, which the attestation paragraph on index.html,
 * disclaimers.html and faq.html states in full (risks.html no longer exists as
 * a file — it carried this paragraph before the disclaimers.html rename). This
 * heading does not restate that paragraph and must not be edited into a
 * shortened version of it.
 */
export const HEADING = 'The reference agent is beta code, and outside the review scope.';

/**
 * The section's one paragraph, verbatim.
 *
 * Three sentences, and the order is load-bearing: what exists, what it has not
 * been through, and the instruction that follows. The last clause — "do not run
 * it against real capital on the assumption that anyone has checked it" — is
 * the whole point of the passage, and it is the clause a shortened rewrite
 * drops first.
 */
export const BODY =
  'A reference implementation of an operator agent ships in the repository. It is beta reference code and it was not inside the scope of the contract security review. Read it as a starting point, not as a reviewed component, and do not run it against real capital on the assumption that anyone has checked it.';

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
