/**
 * ops-powers — "What an operator can and cannot do." on operators.html.
 *
 * WHY IT IS A TWO-COLUMN FIGURE, AND STILL A `<dl>`. The passage is one claim
 * read three ways, and two of the three are an opposition — what an operator
 * can do, and what it cannot. Setting those two beside each other does not
 * balance them: "Cannot" is around four times the length of "Can", it stays
 * four times the length, and the rule between the columns runs the depth of
 * the longer one, on past where "Can" has finished. That disparity is the
 * argument the section exists to make, so the figure draws it rather than
 * absorbing it into a list of equal rows. "Is" is not part of the opposition
 * and does not sit in it; it spans both columns underneath. The elements stay
 * `<dt>` and `<dd>` because each body is still the definition of the term
 * above it, and a screen reader still reads term-then-definition three times.
 *
 * WHAT THE LAYOUT MAY NOT DO. The long column is an itemised list of specific
 * capabilities and every item in it is load bearing — a blanket negative in
 * its place is falsifiable in one transaction, which is what `copy.ts` sets
 * out at length. So nothing here truncates it, collapses it, puts it behind a
 * control, or narrows its column to make the two sides match.
 *
 * MOTION, AND WHAT DOES NOT MOVE. The three blocks enter in sequence, 0.5s
 * each, 60ms apart, from the resting state the prerendered markup already
 * contains. They are the `<dl>`'s only direct children, which is what the
 * stagger walks — an extra element between them would take a slot and push the
 * rest out of sequence. `Reveal` starts nothing for a reader who asked for
 * reduced motion, nothing for an element already on screen, and nothing at all
 * if its chunk never arrives; in every one of those cases the finished figure
 * is what renders.
 *
 * The note is deliberately static. It is the section's hard edge, and a
 * warning that arrives with an entrance is a warning presented as a flourish;
 * a reader who scrolls to it should find it already there. The heading block
 * does not move either, for the same reason it does not in the sibling row
 * sections: it is usually in view before the figure below it starts.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { Reveal } from '../../motion/Reveal';
import { DUR, STAGGER } from '../../motion/easings';
import {
  EYEBROW,
  HEADING,
  NOTE_BODY,
  NOTE_LABEL,
  ROWS,
} from './copy';
import s from './OpsPowers.module.css';

/**
 * Which of the figure's three positions each term takes. Keyed by the term
 * rather than by index on purpose: the geometry is a property of what the row
 * says, so reordering `ROWS` in copy.ts cannot silently swap the two poles.
 * A term with no entry here simply gets the shared block styling.
 */
const PLACE: Record<string, string> = {
  Can: s.poleCan,
  Cannot: s.poleCannot,
  Is: s.poleIs,
};

export function OpsPowers(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby="powers-heading">
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id="powers-heading" className={s.heading}>
          {HEADING}
        </h2>

        <Reveal as="dl" className={s.figure} duration={DUR.mid} stagger={STAGGER.tight}>
          {ROWS.map((row) => (
            <div key={row.term} className={`${s.pole} ${PLACE[row.term] ?? ''}`.trim()}>
              <dt className={s.term}>{row.term}</dt>
              <Pinned as="dd" className={s.body} html={row.body} />
            </div>
          ))}
        </Reveal>

        <div className={s.note}>
          <span className={s.noteLabel}>{NOTE_LABEL}</span>
          <Pinned as="p" className={s.noteBody} html={NOTE_BODY} />
        </div>
      </div>
    </section>
  );
}

export default OpsPowers;
