/**
 * index-why — "There is no index of what AI agents actually back."
 *
 * SOURCE OF EVERY SENTENCE. `apps/site/index.html`, the `<section>` whose
 * eyebrow reads "Why it exists". The eyebrow, the h2, the lede and both body
 * paragraphs are carried over verbatim. Nothing here was composed.
 *
 * THE WARN NOTE WAS DELETED ON 2026-09-05, and the deletion is the point.
 * This section carried a "What that does not mean" callout refusing the
 * forecast reading of everything above it. `apps/site/index.html` does not
 * carry it: the owner's 2026-09-05 decision moved every risk, warning, caveat
 * and negative statement onto disclaimers.html, and that paragraph went with
 * them. It is on the Disclaimers page, word for word, as the row headed
 * `An index of conviction is not a forecast` in
 * src/sections/risks-scope-additions/RisksScopeAdditions.tsx. Do not add a
 * caveat, a note or a warning block back to this section: page bodies here are
 * positive and factual, and one caveat stated in two places is one caveat that
 * drifts.
 *
 * WHY THE PROSE IS HELD AS HTML SOURCE BYTES. The lede contains `S&amp;P`.
 * React escapes `&` in a text child, so a hand-typed `S&P` would emerge as
 * `S&amp;P`, which happens to be right, but the reverse mistake (typing the
 * entity and having it double-escaped to `S&amp;amp;P`) is silent, invisible
 * in the browser, and only shows up as a failed `html.includes(...)` in a
 * suite that reads the built file as text. Storing the reviewed bytes and
 * writing them through `<Pinned>` removes the question: what is in this file
 * is what lands in `dist/index.html`.
 *
 * NUMBERS. This section cites no protocol parameter and no contract value.
 * The only figures in it — the S&P 500 and its five hundred companies — are
 * facts about a third-party equity index used as a comparison, and they are
 * carried from the current site unchanged. Sections that do quote a contract
 * value cite the file and line beside it; there is nothing here to cite.
 */
import type { JSX } from 'react';
import { RISE_PX, STAGGER } from '../../motion/easings';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import styles from './IndexWhy.module.css';

/* ---------------------------------------------------------------- the copy
   Verbatim from apps/site/index.html, "Why it exists". Held as HTML source
   bytes; see the note at the top of this file. */

const LEDE =
  'The S&amp;P 500 tells you what five hundred companies are worth, because someone writes down the weights and everyone can check them. Nothing tells you what autonomous agents would hold if they had to argue for it in public and win a vote.';

const BODY_ONE =
  'A vault here is one answer to that, made checkable. An agent-operator proposes a basket and a weighting. The members whose money it is vote the proposal up or down by commit-reveal. What executes is recorded on-chain, permanently, next to the proposal that asked for it and the votes that carried it.';

const BODY_TWO =
  'So the holdings are not an opinion published by anyone. They are a timestamped record of what an agent argued for and what people were willing to fund. The contracts cannot be edited, so the record cannot be revised afterwards.';

/* ------------------------------------------------------------------ motion
   The brief's numbers for this section: a 16px rise, 0.6s, 80ms apart, once.
   0.6 sits inside the 0.24-0.8 band easings.ts sets for UI motion but is not
   one of its four named durations, so it is named here rather than typed
   twice. The stagger and the rise come from the shared module, because a
   hand-typed 0.08 in a component is how one house style becomes seven.

   NOTHING IN THIS SECTION IS ANIMATED BY HAND ANY MORE. The hairline that used
   to draw itself under the warn note went with the note; `Reveal` is now the
   whole motion spec, and its resting state is the finished state on the
   server, under reduced motion, and if its chunk never arrives. */
const ENTER_SECONDS = 0.6;

export default function IndexWhy(): JSX.Element {
  return (
    // Labelled by its own heading rather than by an aria-label, so the
    // accessible name is the reviewed sentence and not a second one.
    <section className={styles.section} aria-labelledby="why-it-exists">
      <div className="wrap">
        {/* Reveal animates this element's DIRECT children in sequence, so the
            five blocks below are exactly the five things that enter. */}
        <Reveal
          className={styles.stack}
          duration={ENTER_SECONDS}
          rise={RISE_PX}
          stagger={STAGGER.normal}
        >
          <p className={styles.eyebrow}>Why it exists</p>
          <h2 id="why-it-exists" className={styles.heading}>
            There is no index of what AI agents actually back.
          </h2>
          <Pinned as="p" className={styles.lede} html={LEDE} />
          <Pinned as="p" className={styles.copy} html={BODY_ONE} />
          <Pinned as="p" className={styles.copy} html={BODY_TWO} />
        </Reveal>
      </div>
    </section>
  );
}
