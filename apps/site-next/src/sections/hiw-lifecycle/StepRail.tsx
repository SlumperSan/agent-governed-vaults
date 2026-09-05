/**
 * StepRail — the left rail beside the seven lifecycle steps, and the one piece
 * of scroll-driven motion on how-it-works.html.
 *
 * WHAT IT DOES. A 1px line runs the height of the walkthrough. As the reader
 * moves through it, a marker travels down the line and the accent segment
 * behind the marker lengthens; the number of whichever step the reader is
 * currently inside crossfades from its quiet colour to the accent. It scrubs
 * against scroll position, so it moves backwards when the reader scrolls back.
 * Nothing pins, nothing snaps, nothing changes size, and no step is hidden or
 * revealed by it — the rail reports where the reader is, it does not decide
 * what they may read.
 *
 * WHY THIS PASSAGE MAY CARRY MOTION AT ALL, when the risk register three pages
 * over deliberately does not move: this is a mechanism reference and the rail
 * encodes exactly one fact — position within seven ordered steps — which is
 * true, is not a claim about the protocol, and is the thing a reader loses most
 * often in a passage this long.
 *
 * THE RESTING STATE IS THE FINISHED STATE. The stylesheet draws the rail to
 * full height and leaves the marker at zero opacity. So:
 *   - with motion reduced, `useScrollTimeline` never imports GSAP, never
 *     attaches a listener and never fetches its chunk; the rail renders fully
 *     drawn and the marker is absent, which is the brief's reduced-motion
 *     state reached by doing nothing rather than by branching;
 *   - with JavaScript unavailable, the reader gets the same thing;
 *   - the server and the client render the identical tree, because nothing
 *     here is decided at render time. Every difference between the two states
 *     is an inline style written by GSAP after hydration.
 *
 * WHY IT QUERIES THE DOM RATHER THAN HOLDING SEVEN REFS. The step elements
 * belong to HiwLifecycle, not to this component, and a ref array threaded
 * through the copy loop would put motion plumbing inside the passage the
 * claims contract governs. One `querySelectorAll` inside the effect keeps all
 * of it here.
 *
 * IT IS `aria-hidden`. The `<ol>` already carries the ordering, and a progress
 * indicator that duplicates it in the accessibility tree is a second reading of
 * the same fact.
 */
import { type JSX, type RefObject } from 'react';
import { useScrollTimeline } from '../../motion/useScrollTimeline';
import s from './HiwLifecycle.module.css';

export function StepRail({
  /** The block wrapping the rail and the `<ol>`. Owned by HiwLifecycle. */
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  useScrollTimeline(containerRef, ({ gsap, ScrollTrigger, element }) => {
    const rail = element.querySelector<HTMLElement>(`.${s.rail}`);
    const progress = element.querySelector<HTMLElement>(`.${s.railProgress}`);
    const marker = element.querySelector<HTMLElement>(`.${s.railMarker}`);
    const steps = Array.from(element.querySelectorAll<HTMLElement>(`.${s.step}`));
    if (!rail || !progress || !marker) return;

    // The marker exists in the markup at zero opacity so that its absence is
    // the default rather than a thing this code has to arrange. Raising it is
    // the first act of the animated path.
    gsap.set(marker, { opacity: 1 });

    // `start`/`end` are read against the same 60% line at both ends, so the
    // marker sits on the step the reader is actually looking at rather than
    // leading or trailing it. `scrub: 0.4` is a short catch-up, not a spring:
    // nothing on this site overshoots.
    const scrollTrigger = {
      trigger: element,
      start: 'top 60%',
      end: 'bottom 60%',
      scrub: 0.4,
      // The rail's height is a function of how the seven steps wrap, which
      // changes with the viewport. Re-evaluating the function values on
      // refresh is what stops the marker running off the end of the line after
      // a rotate or a resize.
      invalidateOnRefresh: true,
    };

    const timeline = gsap.timeline({ scrollTrigger });

    timeline
      .fromTo(
        progress,
        { scaleY: 0 },
        { scaleY: 1, ease: 'none', transformOrigin: 'top center' },
        0,
      )
      .fromTo(marker, { y: 0 }, { y: () => rail.offsetHeight, ease: 'none' }, 0);

    // One trigger per step, carrying nothing but a class. The crossfade itself
    // is the CSS transition on `.step::before`.
    //
    // WITH MOTION REDUCED THE NUMBERS NEVER CHANGE COLOUR, and that is the
    // intended state rather than an oversight: `useScrollTimeline` returns
    // before it imports GSAP, so none of these triggers is ever created and
    // `.isCurrent` is never applied. The brief's reduced-motion state for this
    // section is the rail drawn and the marker absent; a colour that tracks
    // scroll position is motion by another name, and a reader who asked for
    // none does not get it. Do not "restore" it later — it was never there.
    const stepTriggers = steps.map((step) =>
      ScrollTrigger.create({
        trigger: step,
        start: 'top 60%',
        end: 'bottom 60%',
        toggleClass: { targets: step, className: s.isCurrent },
      }),
    );

    return () => {
      for (const trigger of stepTriggers) trigger.kill();
      for (const step of steps) step.classList.remove(s.isCurrent);
      timeline.kill();
      // Hand the elements back exactly as the stylesheet had them: rail drawn,
      // marker absent. Anything left inline here would outlive the animation.
      gsap.set([progress, marker], { clearProps: 'all' });
    };
  });

  return (
    <div className={s.rail} aria-hidden="true">
      <span className={s.railTrack} />
      <span className={s.railProgress} />
      <span className={s.railMarker} />
    </div>
  );
}
