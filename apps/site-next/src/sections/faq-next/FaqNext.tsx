/**
 * faq-next — the closing section of faq.html, and the last thing that page
 * says.
 *
 * WHAT IT IS FOR. The FAQ answers fourteen questions and then, rather than
 * closing on a capture, hands the reader onward: the Disclaimers first, the
 * mechanism second, the repository third. The heading is an admission — the
 * Disclaimers answer more than this page does — and the three links exist so
 * that a reader who believes it has somewhere to go. There is no field, no
 * control that submits, and nothing here that asks the reader for anything.
 *
 * WHY IT MOVES AS LITTLE AS IT DOES. A 0.4s fade on the block as a whole: no
 * rise, no stagger, nothing per-item. The brief pins this section to a plain
 * fade, and a staggered three-button flourish under a sentence conceding that
 * the page the reader is on is the weaker of the two would be the design
 * arguing with the copy in the last thing they see. `<Reveal rise={0}>` is a
 * pure opacity transition; nothing here travels.
 *
 * THREE CONSTRAINTS THIS FILE IS BUILT AROUND, each of which fails silently:
 *
 *   1. NOTHING IS CONDITIONALLY RENDERED. The build prerenders and the guards
 *      read the prerendered file. Every word and every href below is in
 *      `dist/faq.html` before a module runs, so copy behind a scroll state, an
 *      observer or a React-state toggle is copy the guard cannot see. That
 *      matters more on this page than on any other: faq.html is the page whose
 *      pinned sentences are counted rather than merely found.
 *   2. THE RESTING STATE IS THE FINISHED STATE. The tree below is what the
 *      server renders, what the client renders while hydrating, and what a
 *      reader with motion reduced or with JavaScript unavailable keeps.
 *      `<Reveal>` adds the enter afterwards, in a layout effect, and leaves
 *      anything already on screen exactly where it is — so this section is
 *      never blanked while a chunk is in flight.
 *   3. THE COPY IS BYTES, NOT TEXT CHILDREN, wherever a guard could read it.
 *      `renderToString` escapes text children; a guard matching the raw file
 *      does not match an escaped entity. See ./copy.ts and
 *      src/shell/PinnedText.tsx.
 *
 * WHY THE `<section>` SITS OUTSIDE `<Reveal>`. The landmark is named by
 * `aria-labelledby` pointing at its own heading, so it carries no invented
 * prose; `<Reveal>` takes no arbitrary attributes, so it wraps the reading
 * column instead. That is also the right thing to animate — a landmark that
 * fades is a landmark briefly missing from what a screen reader can see.
 *
 * WHAT THIS FILE MAY NOT DO, restated because it is easy to drift into: it
 * owns `src/sections/faq-next/` and nothing else. `wrap` is the shell's shared
 * reading column, used as-is; every other class is module-scoped. It composes
 * itself into no page — `src/pages/FaqPage.tsx` belongs to Integrate.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import { NEXT_ACTIONS, NEXT_EYEBROW, NEXT_HEADING } from './copy';
import s from './FaqNext.module.css';

/**
 * Seconds. At the floor of the design system's band for UI motion, matching
 * the other blocks the brief pins to a plain fade at this speed. It is a
 * literal rather than a `DUR` member for the simple reason that the shared
 * scale has no 0.4 and a section may not add one — `src/motion/easings.ts`
 * belongs to Shell. The scale stays the scale.
 */
const FADE_SECONDS = 0.4;

/**
 * The heading's id, used to name the section landmark. A `<section>` with no
 * accessible name is a generic container rather than a landmark, and naming it
 * from the heading already on the page means the landmark carries no new
 * sentence.
 */
const HEADING_ID = 'still-reading';

export default function FaqNext(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      {/* One target, one fade. `rise={0}` is the whole motion spec: opacity
          only, so the three links do not slide up under the concession above
          them. */}
      <Reveal as="div" className="wrap" duration={FADE_SECONDS} rise={0}>
        <p className={s.eyebrow}>{NEXT_EYEBROW}</p>
        <Pinned as="h2" id={HEADING_ID} className={s.heading} html={NEXT_HEADING} />

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
