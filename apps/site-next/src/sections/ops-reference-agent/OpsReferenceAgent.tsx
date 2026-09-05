/**
 * ops-reference-agent — the closing section of operators.html, and the last
 * thing that page says.
 *
 * WHAT IT IS FOR. The four sections above it describe what an operator owes,
 * what an operator may and may not do, and what an operator earns. This one
 * describes the software in the repository that an operator might reach for,
 * and it does so by naming its limits: it is beta code, and the contract
 * security review did not cover it. The page therefore closes on a warning
 * rather than on an invitation, and then hands the reader onward — the risk
 * register first, the mechanism second, the source third. There is no field,
 * no control that submits, and nothing here that asks the reader for anything.
 *
 * WHY IT MOVES AS LITTLE AS IT DOES. A 0.4s fade on the block as a whole: no
 * rise, no stagger, nothing per-item. The brief pins this section to a plain
 * fade, and a staggered three-button flourish under a paragraph telling a
 * reader not to point unreviewed code at real capital would be the design
 * arguing with the copy in the last thing they see. `<Reveal rise={0}>` is a
 * pure opacity transition; nothing here travels.
 *
 * THE STATIC BRANCH IS `<Reveal>` ITSELF, not a second path beside it. It
 * starts nothing for a reader who asked for reduced motion, nothing for an
 * element already on screen, and nothing at all if its chunk never arrives —
 * and in every one of those cases the finished section is what renders,
 * because the resting state is what the markup below already contains. The
 * global sheet separately neuters transitions under `prefers-reduced-motion`,
 * which covers the luminance shift on the three links.
 *
 * THREE CONSTRAINTS THIS FILE IS BUILT AROUND, each of which fails silently:
 *
 *   1. NOTHING IS CONDITIONALLY RENDERED. The build prerenders and the guards
 *      read the prerendered file. Every word and every href below is in
 *      `dist/operators.html` before a module runs, so copy behind a scroll
 *      state, an observer or a React-state toggle is copy the guard cannot
 *      see. Two of the hrefs are navigation pins the suite matches literally.
 *   2. THE RESTING STATE IS THE FINISHED STATE. The tree below is what the
 *      server renders, what the client renders while hydrating, and what a
 *      reader with motion reduced or with JavaScript unavailable keeps.
 *      Nothing branches on `matchMedia` or on viewport width, so the subtree
 *      the guards verified is the subtree hydration keeps.
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
 * THE HEADING ID IS DERIVED FROM THE SECTION KEY. Four other sections land on
 * operators.html and each names its own landmark the same way, so collision is
 * avoided by construction rather than by luck.
 *
 * WHAT THIS FILE MAY NOT DO, restated because it is easy to drift into: it
 * owns `src/sections/ops-reference-agent/` and nothing else. `wrap` is the
 * shell's shared reading column, used as-is; every other class is
 * module-scoped. It composes itself into no page — `src/pages/OperatorsPage.tsx`
 * belongs to Integrate.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import { ACTIONS, BODY, EYEBROW, HEADING } from './copy';
import s from './OpsReferenceAgent.module.css';

/**
 * Seconds. At the floor of the design system's band for UI motion, matching
 * the other closing block on the site that is briefed the same way. It is a
 * literal rather than a `DUR` member because the shared scale has no 0.4 and
 * should not grow one for two sections; the scale stays the scale.
 */
const FADE_SECONDS = 0.4;

/**
 * The heading's id, used to name the section landmark. A `<section>` with no
 * accessible name is a generic container rather than a landmark, and naming it
 * from the heading already on the page means the landmark carries no new
 * sentence.
 */
const HEADING_ID = 'reference-agent-heading';

export function OpsReferenceAgent(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      {/* One target, one fade. `rise={0}` is the whole motion spec: opacity
          only, so the three links do not slide up under the warning above
          them. */}
      <Reveal as="div" className="wrap" duration={FADE_SECONDS} rise={0}>
        <p className={s.eyebrow}>{EYEBROW}</p>
        <Pinned as="h2" id={HEADING_ID} className={s.heading} html={HEADING} />
        <Pinned as="p" className={s.body} html={BODY} />

        <div className={s.actions}>
          {ACTIONS.map((a) => (
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

export default OpsReferenceAgent;
