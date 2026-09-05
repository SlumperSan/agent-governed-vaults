/**
 * hiw-corrections — "Corrections, before you assume them." on how-it-works.html.
 *
 * The last section of the mechanism page: two rows that take back the two
 * things a reader has probably already assumed by the time they arrive, then
 * the closing links. It is a correction notice, so it is the quietest block on
 * the page — one fade, no rise, no stagger, nothing that asks to be watched.
 *
 * WHAT IS PRERENDERED. Everything. Both terms, both bodies and all three links
 * are in the markup before any module runs; the enter animation is added
 * afterwards by <Reveal>, which starts from the resting state rather than from
 * an `opacity: 0` class. A reader with motion reduced, or with JavaScript
 * unavailable, gets the finished section, and the bytes the claims suite reads
 * are there whether or not anything scrolls.
 *
 * WHY THE SECTION ELEMENT IS OUTSIDE <Reveal>. The landmark carries
 * `aria-labelledby` pointing at its own heading, so the section is named by
 * copy that already exists rather than by a new string. <Reveal> takes no
 * arbitrary attributes, so it wraps the reading column instead — which is also
 * the right thing to animate, since a landmark that fades is a landmark that is
 * briefly missing from the accessibility tree's visible content.
 *
 * WHAT THIS FILE MAY NOT DO, restated because it is easy to drift into: it owns
 * `src/sections/hiw-corrections/` and nothing else. The `wrap` class is the
 * shell's shared reading column and is used as-is; every other class here is
 * module-scoped. `.rows`, `.actions` and `.btn` are re-implemented locally
 * rather than added to `index.css`, because that file belongs to Shell.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import { REPO_URL } from '../../shell/pinned';
import {
  CTA_OPERATORS,
  CTA_RISKS,
  CTA_SOURCE,
  ERC4626_BODY,
  ERC4626_TERM,
  EYEBROW,
  FRONTEND_BODY,
  FRONTEND_TERM,
  HEADING,
} from './copy';
import s from './HiwCorrections.module.css';

/**
 * Seconds. Inside the design system's 0.4-0.8s band for UI motion, at its
 * floor: the brief pins this section to a plain fade at 0.4s, deliberately, so
 * that the page's final word does not perform. It is a literal rather than a
 * `DUR` member because no other section moves at this speed; the shared scale
 * stays the shared scale.
 */
const FADE_SECONDS = 0.4;

/** The heading's id, so the landmark is named by the heading rather than by new prose. */
const HEADING_ID = 'corrections';

export default function HiwCorrections(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      {/* rise={0} is the whole motion spec: opacity only, no travel, no stagger. */}
      <Reveal as="div" className="wrap" duration={FADE_SECONDS} rise={0}>
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id={HEADING_ID} className={s.heading}>
          {HEADING}
        </h2>

        <dl className={s.rows}>
          <div className={s.row}>
            <dt className={s.term}>{ERC4626_TERM}</dt>
            <Pinned as="dd" className={s.body} html={ERC4626_BODY} />
          </div>
          <div className={s.row}>
            <dt className={s.term}>{FRONTEND_TERM}</dt>
            <Pinned as="dd" className={s.body} html={FRONTEND_BODY} />
          </div>
        </dl>

        <div className={s.actions}>
          <a className={`${s.btn} ${s.btnPrimary}`} href="disclaimers.html">
            {CTA_RISKS}
          </a>
          <a className={s.btn} href="operators.html">
            {CTA_OPERATORS}
          </a>
          <a className={s.btn} href={REPO_URL}>
            {CTA_SOURCE}
          </a>
        </div>
      </Reveal>
    </section>
  );
}
