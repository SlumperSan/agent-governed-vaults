/**
 * ops-economics — "The fee is small by design, and we will not project it for
 * you." on operators.html.
 *
 * Four definition rows: what is earned, what is not routed to you, what that
 * adds up to, what is actually on offer. The copy, its contract citations and
 * the reasoning behind every byte live in `./copy.ts`; this file is structure
 * and motion only.
 *
 * WHY THE ROWS ARE A `<dl>`. Four labelled facts read down one left edge,
 * checked by running the eye along the labels — the same ledger the row
 * sections on how-it-works, who-its-for and agents use, so a reader meets one
 * pattern across the site rather than one per page. The Powers section
 * directly above sets its two poles side by side instead, because the claim it
 * carries is an opposition rather than a list; these four are peers and are
 * laid out as peers.
 *
 * NO NOTE BLOCK, DELIBERATELY. The two sharpest disclosures in the section —
 * that a fresh operator identity resets the high-water mark, and that the
 * operator's own 5% collects the exit fee through share value — are `dd`
 * bodies in the reviewed source, not callouts. Lifting either into a bordered
 * note would add emphasis the passage does not carry, which is the same class
 * of edit as adding a figure. Both keep the weight they were reviewed at.
 *
 * MOTION. The four rows enter in sequence, 0.5s each, 60ms apart, from the
 * resting state the prerendered markup already contains. `Reveal` animates
 * nothing for a reader who asked for reduced motion, nothing for an element
 * already on screen, and nothing at all if its chunk never lands — in each of
 * those cases the finished list is what renders, because the finished list is
 * what the server sent. The heading block does not move: it is usually in view
 * before the list below it begins.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { Reveal } from '../../motion/Reveal';
import { DUR, STAGGER } from '../../motion/easings';
import {
  EYEBROW,
  HEADING,
  ROWS,
} from './copy';
import s from './OpsEconomics.module.css';

export function OpsEconomics(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby="economics-heading">
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id="economics-heading" className={s.heading}>
          {HEADING}
        </h2>

        <Reveal as="dl" className={s.rows} duration={DUR.mid} stagger={STAGGER.tight}>
          {ROWS.map((row) => (
            <div key={row.term} className={s.row}>
              <dt className={s.term}>{row.term}</dt>
              <Pinned as="dd" className={s.body} html={row.body} />
            </div>
          ))}
        </Reveal>

      </div>
    </section>
  );
}

export default OpsEconomics;
