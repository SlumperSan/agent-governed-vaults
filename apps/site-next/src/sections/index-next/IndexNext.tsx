/**
 * index-next — the closing section of index.html, and the last thing the page
 * says.
 *
 * WHAT IT IS FOR. Every other long-scroll page on the internet ends this block
 * with a capture: a field, a button, a promise. This one ends it by stating
 * that there is no such thing here and then pointing four ways out, three of
 * them further into the disclosures and the fourth into the repository. The
 * denial is the whole section; the CTAs exist to give the reader somewhere to
 * go that is not a form.
 *
 * WHY IT MOVES AS LITTLE AS IT DOES. A 0.5s fade, no rise, no stagger, nothing
 * per-item. The brief's phrasing for this section is that the page ends
 * quietly, and a staggered four-button flourish under a sentence about there
 * being no funnel would be the design contradicting the copy in the last
 * thing the reader sees. `<Reveal rise={0}>` is a pure opacity transition on
 * the block as a whole.
 *
 * THREE CONSTRAINTS THIS FILE IS BUILT AROUND, each of which fails silently:
 *
 *   1. NOTHING IS CONDITIONALLY RENDERED. The build prerenders and the claims
 *      guards read the prerendered file. The heading here is a PERMITTED
 *      exemption in the claims suite and is separately asserted to be in use
 *      somewhere in the build, so copy that only appears after a scroll, an
 *      observer or a state change is copy that is absent from the file the
 *      guard reads.
 *   2. THE RESTING STATE IS THE FINISHED STATE. The tree below is what the
 *      server renders, what the client renders while hydrating, and what a
 *      reader with motion reduced or with JavaScript unavailable keeps. The
 *      enter animation is added afterwards, in an effect, by `<Reveal>` —
 *      which also leaves anything already on screen exactly where it is, so
 *      this section is never blanked while a chunk is in flight.
 *   3. THE COPY IS BYTES, NOT TEXT CHILDREN. See ./copy.ts and
 *      src/shell/PinnedText.tsx: `renderToString` escapes text children, and a
 *      guard matching on the raw file does not match an escaped entity.
 *
 * OWNERSHIP. This directory and nothing else. The section imports the shell's
 * repository URL and the shell's reveal primitive; it defines no token, edits
 * no stylesheet outside its own module, and composes itself into no page —
 * `src/pages/IndexPage.tsx` belongs to Integrate.
 */
import type { JSX } from 'react';
import { Backdrop } from '../../assets/Backdrop';
import { DUR } from '../../motion/easings';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import { NEXT_ACTIONS, NEXT_BODY, NEXT_EYEBROW, NEXT_HEADING } from './copy';
import s from './IndexNext.module.css';

/**
 * The heading's id, used to name the section landmark. A `<section>` with no
 * accessible name is a generic container rather than a landmark, and naming it
 * from the heading that is already on the page means the landmark carries no
 * invented prose.
 */
const HEADING_ID = 'next-heading';

export default function IndexNext(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <Backdrop slot="next" />
      {/* One target, one fade. `rise={0}` makes it opacity-only: the block
          does not travel, so the four links do not slide under a sentence
          about there being nothing to do here. */}
      <Reveal className="wrap" rise={0} duration={DUR.mid}>
        <p className={s.eyebrow}>{NEXT_EYEBROW}</p>
        <Pinned as="h2" id={HEADING_ID} className={s.heading} html={NEXT_HEADING} />
        <Pinned as="p" className={s.body} html={NEXT_BODY} />
        <div className={s.actions}>
          {NEXT_ACTIONS.map((a) => (
            <a
              key={a.href}
              className={a.primary ? `${s.action} ${s.actionPrimary}` : s.action}
              href={a.href}
            >
              {a.label}
            </a>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
