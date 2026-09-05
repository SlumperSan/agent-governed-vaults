/**
 * hiw-exit — "Redemption is pro-rata, in kind, and sometimes queued."
 *
 * Document order, matching the `Exit` section of apps/site/how-it-works.html
 * one block at a time:
 *
 * MOTION, AND WHY THERE IS ALMOST NONE. One element on this section animates:
 * the warn note, a 0.5s fade with no rise. Everything else — the heading, the
 * three paragraphs, and above all the table — renders at rest and is readable
 * the instant it is on screen. This section tells a member the two ways their
 * exit can settle and that one of them can be held open indefinitely by someone
 * else at the cost of gas. Copy like that is read, not watched, and a reveal on
 * it is the site performing its own disclosure.
 *
 * NOTHING IN THIS SECTION IS CONDITIONALLY RENDERED. Every sentence a guard
 * reads is unconditional JSX. There is no accordion, no scroll gate and no
 * `<details>` here, which matters because two checks read this section
 * specifically: `site.test.mjs` computes `24 hours in the reference
 * configuration` from `contracts/config/robinhood-mainnet.json` and requires
 * it on this page, and the Mode-F trigger clause inside the table is checked
 * against five banned misstatements on every surface that carries it.
 *
 * NO SENTENCE HERE WAS WRITTEN FOR THIS BUILD. All of it is carried from
 * apps/site/how-it-works.html; see `copy.ts` for the byte-for-byte constants
 * and the contract lines each figure is cited to.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { Reveal } from '../../motion/Reveal';
import { DUR } from '../../motion/easings';
import { SettlementTable } from './SettlementTable';
import {
  EYEBROW,
  HEADING,
  NOTE_LABEL,
  NOTE_P_LAPSE,
  NOTE_P_WHY,
  P_IN_KIND_DEFAULT,
  P_FORWARD_WINDOW,
  P_TOKENS_NOT_DOLLARS,
} from './copy';
import s from './HiwExit.module.css';

/**
 * Namespaced by section key. Element ids share one page-wide namespace, seven
 * how-it-works sections are being written in parallel, and `exit-title` is a
 * name more than one of them could reach for.
 */
const TITLE_ID = 'hiw-exit-title';

export function HiwExit(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={TITLE_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id={TITLE_ID} className={s.heading}>
          {HEADING}
        </h2>

        <div className={s.prose}>
          <Pinned as="p" html={P_IN_KIND_DEFAULT} />
          <Pinned as="p" html={P_TOKENS_NOT_DOLLARS} />
          <Pinned as="p" html={P_FORWARD_WINDOW} />
        </div>

        <SettlementTable />

        {/* The one animated element on this section. `rise={0}` makes it a pure
            fade: the note is the beat after the table, not a second entrance. */}
        <Reveal as="div" className={s.note} rise={0} duration={DUR.mid}>
          <span className={s.noteLabel}>{NOTE_LABEL}</span>
          <Pinned as="p" html={NOTE_P_WHY} />
          <Pinned as="p" html={NOTE_P_LAPSE} />
        </Reveal>
      </div>
    </section>
  );
}

export default HiwExit;
