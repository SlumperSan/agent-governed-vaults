/**
 * ops-reference-agent — the closing section of operators.html, and the last
 * thing that page says.
 *
 * WHAT IT IS FOR. It hands the reader onward, and that is all it does now: the
 * Disclaimers page first, the mechanism second, the source third. There is no
 * field, no control that submits, and nothing here that asks the reader for
 * anything.
 *
 * WHAT IT USED TO CARRY, AND WHY IT DOES NOT. Until 2026-09-05 this section
 * also carried an eyebrow, an h2 and a paragraph saying the reference agent is
 * beta code and outside the contract review's scope. That caveat is numbered
 * risk 12 on disclaimers.html and renders there correctly, so the page body was
 * stating it a second time in weaker wording. `apps/site/operators.html`
 * carries no such block, and the owner's 2026-09-05 decision puts every risk,
 * warning and caveat on one page. See ./copy.ts for the deleted strings.
 *
 * WHY IT MOVES AS LITTLE AS IT DOES. A 0.4s fade on the block as a whole: no
 * rise, no stagger, nothing per-item. The brief pins this section to a plain
 * fade, and a staggered three-button flourish at the foot of a page about what
 * an operator owes would be the design arguing with the copy in the last thing
 * a reader sees. `<Reveal rise={0}>` is a pure opacity transition; nothing here
 * travels.
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
 *   3. ANY COPY ADDED BACK IS BYTES, NOT TEXT CHILDREN, wherever a guard could
 *      read it. `renderToString` escapes text children; a guard matching the
 *      raw file does not match an escaped entity. See ./copy.ts and
 *      src/shell/PinnedText.tsx. Nothing in this section is prose today.
 *
 * WHY THE `<section>` SITS OUTSIDE `<Reveal>`. `<Reveal>` takes no arbitrary
 * attributes, so it wraps the reading column rather than the section element.
 * That is also the right thing to animate: a landmark that fades is a landmark
 * briefly missing from what a screen reader can see.
 *
 * WHAT THIS FILE MAY NOT DO, restated because it is easy to drift into: it
 * owns `src/sections/ops-reference-agent/` and nothing else. `wrap` is the
 * shell's shared reading column, used as-is; every other class is
 * module-scoped. It composes itself into no page — `src/pages/OperatorsPage.tsx`
 * belongs to Integrate.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { ACTIONS } from './copy';
import s from './OpsReferenceAgent.module.css';

/**
 * Seconds. At the floor of the design system's band for UI motion, matching
 * the other closing block on the site that is briefed the same way. It is a
 * literal rather than a `DUR` member because the shared scale has no 0.4 and
 * should not grow one for two sections; the scale stays the scale.
 */
const FADE_SECONDS = 0.4;

/*
 * NO `aria-labelledby`, AND NO HEADING TO POINT ONE AT. The section carried an
 * h2 until 2026-09-05; it was deleted with the rest of the reference-agent
 * caveat (see ./copy.ts), which leaves this block as the corpus's own
 * actions-only closing `<section>`. An unnamed `<section>` is not exposed as a
 * landmark at all, which is correct for a row of links and is what
 * `apps/site/operators.html` renders. An `aria-labelledby` pointing at an id
 * that no longer exists would be worse than no name, so it goes with the
 * heading rather than being left dangling.
 */

export function OpsReferenceAgent(): JSX.Element {
  return (
    <section className={s.section}>
      {/* One target, one fade. `rise={0}` is the whole motion spec: opacity
          only, so the three links do not slide up under the section above
          them. */}
      <Reveal as="div" className="wrap" duration={FADE_SECONDS} rise={0}>
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
