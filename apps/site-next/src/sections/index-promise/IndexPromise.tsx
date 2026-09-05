/**
 * index-promise — "Fees are designed to turn into stock."
 *
 * NEW SECTION, copy deck v2 (2026-09-05). Sits between the two doors and "Why
 * it exists" on index.html, immediately after the doors because it is the
 * thing the owner wants a visitor to leave with. Every sentence below is
 * lifted byte-for-byte from the `<section>` on `apps/site/index.html` whose
 * eyebrow reads "Where it is going" — the reviewed source of truth for this
 * passage.
 *
 * EVERY SENTENCE IS DESIGN INTENT, and the register says so throughout: "is
 * designed to" rather than the present tense. Two of the four sentences carry
 * an apostrophe or an em-dash as HTML source bytes (the chain's Uniswap,
 * starting with SPY — then down the list), so they are rendered through
 * <Pinned> rather than as text children; the other two are plain text.
 *
 * "RWLY does not exist yet, and none of this is built." is NOT the exact
 * pinned sentence `apps/site/test/site.test.mjs` requires verbatim on
 * index.html (that sentence ends "RWLY does not exist yet." with a period,
 * and lives in the hero's LEDE_CLOSE, unchanged by this section) — this is an
 * additional, independent mention, and both are true.
 *
 * Two actions close the section, `vision.html` (primary) and
 * `disclaimers.html`, matching the corpus exactly. Neither label is a banned
 * funnel phrase.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import s from './IndexPromise.module.css';

const ENTER_SECONDS = 0.6;

const HEADING_ID = 'where-it-is-going';

const LEDE = 'The index is designed to grow by owning the liquidity it trades against.';

const RWLY_LINE = 'RWLY does not exist yet, and none of this is built.';

const BODY =
  'RWLY is designed to pair with stock tokens on the chain&rsquo;s Uniswap, and the fees those pools generate are designed to buy stock into the index &mdash; starting with SPY, then down the list as the fees allow.';

export default function IndexPromise(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <Reveal className={s.intro} duration={ENTER_SECONDS}>
          <p className={s.eyebrow}>Where it is going</p>
          <h2 id={HEADING_ID} className={s.heading}>
            Fees are designed to turn into stock.
          </h2>
          <p className={s.lede}>{LEDE}</p>
          <p className={s.body}>{RWLY_LINE}</p>
          <Pinned as="p" className={s.body} html={BODY} />

          <div className={s.actions}>
            <a className={`${s.btn} ${s.btnLead}`} href="vision.html">
              The whole design
            </a>
            <a className={s.btn} href="disclaimers.html">
              Read the Disclaimers
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
