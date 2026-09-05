/**
 * index-immutability — "Four powers nobody holds."
 *
 * Four cards, then the note that states every one of them as a limitation.
 * The reversal is the section: a page that lists four things a contract cannot
 * do and stops there has sold the reader a feature list. This one turns each
 * card over before the reader moves on, and the motion is arranged so the
 * turn reads as a beat rather than as more content.
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS IN HERE THAT LOOK LIKE STYLE AND ARE NOT
 * ---------------------------------------------------------------------------
 *
 * 1. THE `Cannot take your funds` BODY IS THE ENUMERATED OPERATOR SENTENCE and
 *    is imported from `src/shell/pinned.ts` rather than retyped. The list of
 *    verbs after `no authority` is what makes it true: the operator identity
 *    receives the 10% performance fee (contracts/src/FeeEngine.sol:35, credited
 *    at :104), so a blanket negative about what the operator holds is
 *    falsifiable in one transaction. Compressing this card into a punchier line
 *    is the single most likely claims violation available in this section.
 *
 * 4. EVERY BODY PARAGRAPH GOES THROUGH `<Pinned>`. `renderToString` escapes an
 *    apostrophe to `&#x27;`, and three of these paragraphs carry one — so a
 *    byte-comparison against the reviewed original in `apps/site/index.html`
 *    would fail on markup that renders perfectly. The two paragraphs that carry
 *    no apostrophe go through it as well, so the section has one rule rather
 *    than an exception nobody remembers.
 *
 * MOTION. Cards enter as a staggered grid, once, on the grid's own entry; the
 * note enters after a deliberate hold. `Reveal` renders the finished state on
 * the server and on the client's first render, then animates from it in a
 * layout effect — so the reduced-motion branch, the no-JavaScript branch and
 * the prerendered markup the claims guards read are all the same finished
 * page. There is no `matchMedia` in this render tree and there must not be one.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { OPERATOR_ENUMERATED } from '../../shell/pinned';
import { Reveal } from '../../motion/Reveal';
import { Backdrop } from '../../assets/Backdrop';
import { DUR, STAGGER } from '../../motion/easings';
import {
  CARD_1_BODY,
  CARD_1_TITLE,
  CARD_2_TITLE,
  CARD_3_BODY,
  CARD_3_TITLE,
  CARD_4_BODY,
  CARD_4_TITLE,
  NOTE_LABEL,
  NOTE_PARAGRAPH_1,
  NOTE_PARAGRAPH_2,
} from './copy';
import s from './IndexImmutability.module.css';

/**
 * The hold before the reversal, in seconds. It is a delay on the note's own
 * entry rather than a sequencer chained to the grid finishing: the two blocks
 * are separate observers, and a cross-component sequence would need shared
 * state that the server cannot render.
 */
const NOTE_HOLD = 0.2;

const HEADING_ID = 'immutability-heading';

export default function IndexImmutability(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <Backdrop slot="immutability" />
      <div className="wrap">
        <p className={s.eyebrow}>Immutability</p>
        <h2 id={HEADING_ID} className={s.heading}>
          Four powers nobody holds.
        </h2>

        <Reveal className={s.grid} stagger={STAGGER.loose} duration={DUR.slow}>
          <div className={s.card}>
            <h3 className={s.cardTitle}>{CARD_1_TITLE}</h3>
            <Pinned as="p" className={s.cardBody} html={CARD_1_BODY} />
          </div>

          <div className={s.card}>
            <h3 className={s.cardTitle}>{CARD_2_TITLE}</h3>
            {/* The enumeration, from the one source. Never shortened here. */}
            <Pinned as="p" className={s.cardBody} html={OPERATOR_ENUMERATED} />
          </div>

          <div className={s.card}>
            <h3 className={s.cardTitle}>{CARD_3_TITLE}</h3>
            <Pinned as="p" className={s.cardBody} html={CARD_3_BODY} />
          </div>

          <div className={s.card}>
            <h3 className={s.cardTitle}>{CARD_4_TITLE}</h3>
            <Pinned as="p" className={s.cardBody} html={CARD_4_BODY} />
          </div>
        </Reveal>

        <Reveal className={s.noteWarn} delay={NOTE_HOLD} duration={DUR.slow}>
          <span className={s.label}>{NOTE_LABEL}</span>
          <Pinned as="p" html={NOTE_PARAGRAPH_1} />
          <Pinned as="p" html={NOTE_PARAGRAPH_2} />
        </Reveal>
      </div>
    </section>
  );
}
