/**
 * agents-before-you-point — the reviewed copy for the closing section of
 * agents.html, held as HTML SOURCE BYTES wherever a guard could read the
 * sentence, so `<Pinned>` writes it onto the element untouched.
 *
 * PROVENANCE. The owner's rewrite of agents.html closes on a much shorter
 * paragraph than the section used to carry: it no longer restates the stale
 * price feed, the unpatchable-bug and the nobody-made-whole facts inline —
 * those, and the "there is no guarantee of any outcome" sentence that carried
 * one of the claims suite's two BANNED-word exemptions, are gone from this
 * page and presumably now live on disclaimers.html, which the fixer of that
 * page owns. See the task report: this is one of two exemption fragments this
 * rewrite retires from agents.html.
 *
 * The eyebrow and the heading-as-instruction pattern carry over; the heading
 * itself changes to name the Disclaimers page directly, and the first CTA
 * link is retargeted from risks.html (retired) to disclaimers.html.
 *
 * WHY CONSTANTS RATHER THAN JSX TEXT. `renderToString` escapes text children,
 * so an apostrophe or an ampersand reaches `dist/agents.html` as an entity and
 * a guard checking `html.includes(SENTENCE)` against the raw file fails on
 * bytes that look perfect in a browser. None of these strings needs an entity
 * today; holding them as bytes means they do not start needing one silently on
 * the next edit. See src/shell/PinnedText.tsx.
 *
 * These strings travel nowhere else, which is why they live here rather than
 * in src/shell/pinned.ts — that file is for sentences that must stay
 * byte-identical across two or more surfaces.
 *
 * THE FIRST LABEL IS INLINED, NOT IMPORTED. `CTA.allRisks` in
 * `src/shell/pinned.ts` is `'All fifteen named risks'`, which named the old
 * risks.html register and does not match the rewrite's plain "Disclaimers"
 * label for the disclaimers.html link. Rather than edit `pinned.ts` (owned by
 * another engineer in parallel), the literal string is used here. Flagged in
 * the sync report for reconciliation — `pinned.ts` may want a `CTA.disclaimers`
 * entry once the retitle is settled.
 */

/** `<p class="eyebrow">Before you point anything at this</p>`. */
export const EYEBROW = 'Before you point anything at this';

/**
 * The closing heading, verbatim, terminal full stop included. It is an
 * instruction about this site rather than a claim about the contracts, so
 * there is no contract line to cite against it.
 */
export const HEADING = 'Then read the Disclaimers.';

/**
 * The paragraph, verbatim. Shortened by the rewrite to one sentence: who is
 * likely to skip the Disclaimers, and why that matters for an autonomous
 * reader specifically. The three sentences of factual detail the old
 * paragraph carried (stale-feed freeze, unpatchable bug, no compensation
 * path) are not restated here — see the header note on provenance.
 */
export const BODY =
  'An autonomous integrator is the reader most likely to skip them, and the failure modes are not ones a retry loop recovers from.';

/**
 * The five closing links, in the order and with the labels the rewritten
 * agents.html carries. Labels are carried over, never composed: the three
 * phrases a closing block reaches for first — the begin imperative, the
 * registration verb and the wallet imperative — are banned outright, and this
 * is exactly the block a redesign puts one of them in.
 *
 * All five hrefs also do double duty as navigation pins. Every page must
 * literally contain each of the eight `*.html` hrefs; the masthead carries six
 * and the footer carries all eight, and these five are repeated here exactly
 * as the current page repeats them. The `.html` suffix stays — the site suite
 * matches on it, and Pages already redirects the extension-less form.
 */
export const ACTIONS: ReadonlyArray<{ href: string; label: string; primary?: boolean }> = [
  { href: 'disclaimers.html', label: 'Disclaimers', primary: true },
  { href: 'how-it-works.html', label: 'The mechanism in full' },
  { href: 'faq.html', label: 'Questions' },
  { href: 'who-its-for.html', label: 'Who it is for' },
  { href: 'operators.html', label: 'Operators' },
];
