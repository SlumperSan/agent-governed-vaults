/**
 * agents-reference-client — the reviewed copy for the "Reference client"
 * section of agents.html, held as HTML SOURCE BYTES wherever a guard could
 * read the sentence, so `<Pinned>` writes it onto the element untouched.
 *
 * PROVENANCE. The owner rewrote agents.html to drop the x402 /
 * metered-read-API framing. This section's heading and first paragraph carry
 * over unchanged from before that rewrite; the second paragraph (BODY_DETAIL)
 * is new to the rewrite and is now a short pointer at the Disclaimers page
 * rather than a paragraph naming the two launch-class bugs inline — those
 * details now live on disclaimers.html, not here. Nothing here was rewritten,
 * retitled or re-punctuated beyond that; this section introduces no sentence
 * of its own.
 *
 * NOTE FOR WHOEVER RUNS `./_out/verify.mjs` NEXT: at the time of this sync,
 * `apps/site/agents.html` (the file that script reads as SOURCE) still carries
 * the pre-rewrite x402 copy, not the text below. The text below matches the
 * corpus the owner's rewrite produced, not the current bytes of that file.
 * Re-run the verify script only after `apps/site/agents.html` itself has been
 * regenerated from the same rewrite; until then a failure there is expected
 * and is not evidence this file is wrong.
 *
 * WHY THESE CONSTANTS RATHER THAN JSX TEXT. `renderToString` escapes text
 * children, so an apostrophe or an ampersand would reach `dist/agents.html` as
 * an entity, and a guard checking `html.includes(SENTENCE)` against the raw
 * file would fail on bytes that look correct in a browser. None of these
 * strings needs an entity today; holding them as bytes means none starts
 * needing one silently on the next edit. See src/shell/PinnedText.tsx.
 *
 * These strings travel nowhere else, which is why they live here rather than
 * in src/shell/pinned.ts — that file is for sentences that must stay
 * byte-identical across two or more surfaces.
 */

import { REPO_URL } from '../../shell/pinned';

/** The section's eyebrow. `<p class="eyebrow">Reference client</p>`. */
export const EYEBROW = 'Reference client';

/**
 * The heading, verbatim, terminal full stop included.
 *
 * It states that a piece of software exists at a location a reader can open,
 * which is why both calls to action below point at that location rather than
 * at a description of it. There is no contract function behind this sentence;
 * the evidence is the repository itself.
 */
export const HEADING = 'There is a working agent in the repository.';

/**
 * The first paragraph, verbatim.
 *
 * Two sentences: what the reference client reads and decides, then the two
 * conditions under which it will not act. The second sentence is the one that
 * matters to an integrator who is about to run it — dry-run by default, and an
 * explicit environment gate standing between it and a signature — and it is
 * stated as a property of the code rather than as a reassurance about
 * outcomes.
 */
export const BODY_WHAT_IT_DOES =
  'It reads the chain, decides whether to join, vote or exit, and prints the exact calls it would make. It is dry-run by default and cannot sign without an explicit environment gate.';

/**
 * The second paragraph, verbatim, and now a pointer rather than an inline
 * account: what to read this as, and where the review scope and the two
 * launch-class bugs running it live exposed are described in full (the
 * Disclaimers page), rather than restated here.
 */
export const BODY_DETAIL =
  'Read it as a worked example of the integration, not as a strategy and not as production code. Its review scope, and the two launch-class bugs running it live exposed, are in the <a href="disclaimers.html">Disclaimers</a>.';

/**
 * The two calls to action, in the order and with the labels agents.html
 * already carries. Labels are carried over, never composed: the three phrases
 * a closing block reaches for first — the begin imperative, the registration
 * verb and the wallet imperative — are all banned outright, and this is
 * precisely the block a redesign puts one of them in.
 *
 * BOTH POINT OFF-SITE, AND THAT IS CORRECT. This section contributes none of
 * the eight navigation pins every page must carry; the masthead, the footer
 * and the section that follows this one carry all eight between them. Adding
 * an internal link here to help that assertion along would be inventing copy
 * to satisfy a guard, which is the inversion of what the guard is for.
 *
 * The repository address is stated once for the whole build, in
 * src/shell/pinned.ts, and the document link is composed from it rather than
 * retyped — an origin written twice is an origin that moves once.
 */
export const DOC_URL = `${REPO_URL}/blob/protocol/main/docs/REFERENCE-AGENT.md`;

export const ACTIONS: ReadonlyArray<{ href: string; label: string }> = [
  { href: DOC_URL, label: 'Reference agent' },
  { href: REPO_URL, label: 'Contracts and docs' },
];
