/**
 * risks-review-status — "What the security review covers, and what it does
 * not."
 *
 * WHERE IT SITS. Second from last on disclaimers.html, between the
 * fifteen-entry register and the `Do not take this page's word for it`
 * verification section (risks-verify). A reader arriving here has just read
 * fifteen ways the protocol can hurt them; this section says what review
 * those fifteen have been through and what nobody outside the project can
 * check for themselves.
 *
 * REWRITTEN 2026-09-05: SHORTER THAN IT WAS. The old risks.html section
 * carried the NO-GO launch verdict and the remaining-blockers paragraph as a
 * second block, plus three closing action buttons. None of that survives on
 * the corpus: the verdict is not published on this redesign, and the closing
 * CTAs moved to risks-verify. This section is now exactly two paragraphs —
 * the attestation, then a one-sentence caveat — and no actions.
 *
 * SECURITY_REVIEW_ATTESTATION comes from `src/shell/pinned.ts` and renders
 * through `<Pinned>`, which writes the stored bytes onto the element instead
 * of letting React escape them. `apps/site/test/site.test.mjs` scopes it to a
 * BLOCK: wherever `external security review` appears, `no public report` must
 * sit inside the same <p>/<dd>/<li>. So it renders as ONE paragraph.
 * Splitting it for rhythm, or lifting the first sentence out as a pull quote,
 * reds that check on a section that looks correct in a browser.
 *
 * ---------------------------------------------------------------------------
 * MOTION: NONE. THAT IS THE SPEC, NOT AN OMISSION.
 * ---------------------------------------------------------------------------
 * The build brief gives this section "Motion: None", and there is no <Reveal>
 * below. Two reasons, and the second is the one that matters:
 *
 *   1. this is the page whose credibility depends on not performing. A
 *      register of fifteen ways this hurts you, followed by a fade-and-rise
 *      sequence over the sentence saying an attestation cannot be checked,
 *      would be the design arguing with the copy;
 *   2. the prerendered tree is therefore the finished tree unconditionally.
 *      Nothing here is gated on scroll, on an observer, on state or on a media
 *      query, so every sentence is in `dist/disclaimers.html` whether or not
 *      anything ever scrolls, and a reader with motion reduced or with
 *      JavaScript unavailable sees exactly what the guards read.
 *
 * ---------------------------------------------------------------------------
 * NUMBERS
 * ---------------------------------------------------------------------------
 * This section states no contract parameter — no duration, no threshold, no
 * price band — so there is no config-derived string here and no contract line
 * to cite beside one. The finding counts inside the attestation are sourced in
 * src/shell/pinned.ts.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { ATTESTATION_PARAGRAPH, CAVEAT_PARAGRAPH, EYEBROW, HEADING } from './copy';
import s from './RisksReviewStatus.module.css';

/**
 * The h2 is the section landmark's accessible name. An id is markup, not
 * published prose, which is why it is the one string in this directory that
 * was not carried over from apps/site/disclaimers.html.
 */
const HEADING_ID = 'risks-review-status';

export default function RisksReviewStatus(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id={HEADING_ID} className={s.heading}>
          {HEADING}
        </h2>

        {/* One <p>. "external security review" and "no public report" are
            asserted to share a block. */}
        <Pinned as="p" className={s.attestation} html={ATTESTATION_PARAGRAPH} />

        <Pinned as="p" className={s.status} html={CAVEAT_PARAGRAPH} />
      </div>
    </section>
  );
}
