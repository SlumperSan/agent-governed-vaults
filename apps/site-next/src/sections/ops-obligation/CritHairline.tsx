/**
 * CritHairline — the one thing that moves in this section.
 *
 * A 1px rule in --crit under the note's label, drawn left to right over 0.4s
 * the first time the note enters the viewport. The brief allots this section
 * exactly that and nothing else: the table below it must be readable the
 * instant it is on screen, and a page quantifying what an operator stands to
 * lose is not a page that should perform.
 *
 * WHY IT DOES NOT IMPORT THE MOTION LIBRARY. The whole animation is one
 * transform on one decorative element. Setting `.style.transition` and
 * `.style.transform` from JavaScript is CSSOM, not the inline `style=`
 * attribute the CSP refuses, so this needs no library — and staying off the
 * motion chunk means the operators page does not download an animation runtime
 * to draw a hairline.
 *
 * IT MIRRORS `src/motion/Reveal.tsx` RATHER THAN INVENTING A SECOND PATTERN.
 * The same three guards, in the same order, for the same three reasons:
 *
 *   1. THE RESTING STATE IS WHAT RENDERS. The fill is drawn at full width on
 *      the server and on the client's first render alike. Only afterwards is it
 *      collapsed and drawn forward. So a reader with reduced motion, or with
 *      JavaScript unavailable, sees the finished rule rather than an empty gap,
 *      and the prerendered markup is the finished markup.
 *   2. THE START STATE IS SET BEFORE PAINT. `useEffect` runs after the browser
 *      paints, so collapsing the rule there would show it, hide it, then draw
 *      it. A layout effect runs first. `useLayoutEffect` warns on the server,
 *      so the choice between the two is made once at module scope from
 *      `typeof window` — a module constant, never a render-time branch, so
 *      hydration parity is untouched.
 *   3. ANYTHING ALREADY ON SCREEN IS LEFT ALONE. Collapsing an above-fold rule
 *      and waiting for an observer to notice it is on screen is a rule that
 *      flickers for no reason.
 *
 * WHY A TRACK AND A FILL RATHER THAN ONE ELEMENT. The observer watches the
 * track, which keeps its box whatever the fill is doing. An element collapsed
 * to `scaleX(0)` has a zero-area rectangle, and intersection ratios computed
 * against a zero area are exactly the kind of thing that behaves differently in
 * one engine from another. The track is never transformed, so the question
 * never arises.
 */
import { useEffect, useLayoutEffect, useRef, type JSX } from 'react';
import { prefersReducedMotion } from '../../motion/useReducedMotion';
import s from './OpsObligation.module.css';

/** Decided once, at module scope. Never a render-time branch. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Seconds. The build brief specifies the motion per section, and this section's
 * entry reads "the crit note draws a 1px --crit hairline on enter, 0.4s". It is
 * inside the 0.24-0.8s band src/motion/easings.ts sets for UI, and it is held
 * here as a named constant rather than typed into the transition string so
 * there is one place to read it.
 */
const DRAW_SECONDS = 0.4;

/** Is any part of the element already on screen? */
function isOnScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight && r.bottom > 0;
}

export function CritHairline(): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLSpanElement | null>(null);

  useIsomorphicLayoutEffect(() => {
    const track = trackRef.current;
    const fill = fillRef.current;
    if (!track || !fill) return;

    // Nothing moves for a reader who asked for that, and nothing moves for
    // something already on screen — it is already correct where it is.
    if (prefersReducedMotion()) return;
    if (isOnScreen(track)) return;
    if (typeof IntersectionObserver !== 'function') return;

    const restore = () => {
      fill.style.transition = '';
      fill.style.transform = '';
      fill.style.willChange = '';
    };

    // Before paint: collapse to the start state.
    fill.style.transition = 'none';
    fill.style.transform = 'scaleX(0)';
    fill.style.willChange = 'transform';

    const onDone = () => {
      fill.removeEventListener('transitionend', onDone);
      restore();
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;

        // Once. Re-drawing a rule every time the reader scrolls back past it
        // turns a single beat into a tic.
        observer.disconnect();

        // Read a layout property so the collapsed state is committed before the
        // transition is armed. Without this the browser coalesces both writes
        // into one style recalculation and the rule simply appears.
        void fill.getBoundingClientRect();

        fill.style.transition = `transform ${DRAW_SECONDS}s var(--ease-enter)`;
        fill.style.transform = 'scaleX(1)';
        fill.addEventListener('transitionend', onDone);
      },
      // Fires when the rule is clear of the bottom edge rather than the instant
      // it crosses it, so the draw happens where the reader is looking.
      { rootMargin: '0px 0px -15% 0px' },
    );
    observer.observe(track);

    return () => {
      observer.disconnect();
      fill.removeEventListener('transitionend', onDone);
      restore();
    };
  }, []);

  return (
    <div ref={trackRef} className={s.hairlineTrack} aria-hidden="true">
      <span ref={fillRef} className={s.hairlineFill} />
    </div>
  );
}
