/**
 * risks-review-status — the reviewed copy for the `Review` section of
 * disclaimers.html (risks.html's replacement), held as HTML SOURCE BYTES so
 * `<Pinned>` can write it onto the element untouched.
 *
 * REWRITTEN 2026-09-05. The old risks.html section here was headed "On the
 * security review" / "What has and has not been checked." and carried the
 * NO-GO launch verdict plus the remaining-blockers paragraph as its second
 * block. Both are gone from this section on the corpus: the verdict and the
 * blockers moved elsewhere (the verdict is not published on this redesign at
 * all — see the note on index-status), and this section is now just the
 * attestation paragraph plus one short caveat sentence. There are no action
 * buttons in this section on the corpus any more either; the closing
 * "Do not take this page's word for it" section (risks-verify) carries the
 * page's CTAs instead.
 *
 * PROVENANCE. Every string below is lifted byte-for-byte from the `Review`
 * section of `apps/site/disclaimers.html` (grep `What the security review
 * covers`).
 *
 * WHY BYTES RATHER THAN JSX TEXT. `renderToString` escapes text children, so
 * an apostrophe reaches `dist/disclaimers.html` as `&#x27;` and a guard doing
 * `html.includes(SENTENCE)` against the raw file fails on a page that looks
 * perfect in a browser. See src/shell/PinnedText.tsx.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PASSAGE THAT IS NOT DEFINED HERE, AND WHY
 * ---------------------------------------------------------------------------
 * The security-review attestation paragraph is byte-identical wherever it
 * still appears — as of 2026-09-05 that is disclaimers.html only, index.html
 * and faq.html having dropped it — so it lives in `src/shell/pinned.ts` as
 * `SECURITY_REVIEW_ATTESTATION` and this section imports it rather than
 * retyping it.
 */

import { SECURITY_REVIEW_ATTESTATION } from '../../shell/pinned';

/** The section's eyebrow. `apps/site/disclaimers.html`, `<p class="eyebrow">Review</p>`. */
export const EYEBROW = 'Review';

/** The section's h2. Verbatim, terminal full stop included. */
export const HEADING = 'What the security review covers, and what it does not.';

/** The attestation paragraph, imported verbatim rather than retyped — see above. */
export const ATTESTATION_PARAGRAPH = SECURITY_REVIEW_ATTESTATION;

/**
 * The closing caveat. CHANGED 2026-09-05: was "...and we are not going to
 * describe the code with a word that implies you can check it." (still the
 * exact wording index-status carried, and index-status no longer exists in
 * this form — see that section's note). The corpus's disclaimers.html phrases
 * the same idea in the third person: "...and this site will not use a word
 * that implies you can check it."
 */
export const CAVEAT_PARAGRAPH =
  'Read that as it is written. An attestation you cannot check is weaker evidence than a report you can, and this site will not use a word that implies you can check it.';
