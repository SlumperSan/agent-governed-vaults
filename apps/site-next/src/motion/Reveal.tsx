/**
 * <Reveal> — the site's one enter animation.
 *
 * HOW IT AVOIDS THE HYDRATION TRAP. The children render at their FINAL
 * position with full opacity, on the server and on the client's first render
 * alike. Only after that does the element get pushed back to its start state
 * and animated forward as it enters the viewport.
 *
 * Three things follow, and all three are requirements rather than side
 * effects:
 *   - the prerendered markup is the finished page, so every sentence a guard
 *     reads is in `dist/*.html` whether or not anything ever scrolls;
 *   - a reader with reduced motion, with JavaScript unavailable, or whose
 *     animation chunk never arrives, gets the finished page rather than an
 *     invisible one — the failure mode of the usual `opacity: 0` starting
 *     class;
 *   - server and client render the same tree, so hydration does not discard
 *     the subtree.
 *
 * HOW IT AVOIDS THE FLASH, which is the other half of the same problem. There
 * are two hazards, and the naive version hits both:
 *
 *   1. `useEffect` runs AFTER paint, so hiding the element there means the
 *      reader sees it, then sees it vanish, then sees it fade back. The start
 *      state is therefore set in a LAYOUT effect, which runs before the
 *      browser paints. `useLayoutEffect` warns when it runs on the server, so
 *      the choice between it and `useEffect` is made once at module scope from
 *      `typeof window` — a module constant, never a render-time branch, so
 *      hydration parity is untouched.
 *   2. Anything already in the viewport at load must not be hidden AT ALL.
 *      The animation library arrives in a later chunk, and hiding an above-fold
 *      section until that chunk lands blanks the top of the page for as long as
 *      the network takes. So an element that is already on screen is left
 *      exactly as it rendered.
 *
 * IF THE CHUNK NEVER ARRIVES. Hazard 2 above is the chunk arriving LATE; this
 * is it not arriving — the network drops between load and scroll, the request
 * is blocked, or the file is gone after a deploy. The symptom is not a flash
 * but a permanent blank: the start state is written before `import('motion')`
 * is even requested, so a rejected import would leave every off-screen block
 * at `opacity: 0` for the rest of the session, with nothing on screen to say
 * why. The import therefore ends in `.catch(restore)`, which clears the three
 * inline styles this effect set and returns the element to exactly what the
 * prerendered markup rendered — the same finished page the reduced-motion path
 * gets. `useScrollTimeline.ts` names its own version of this failure the same
 * way; there the effect touches no element before its import, so its catch has
 * nothing to restore.
 *
 * IT ANIMATES OPACITY AND TRANSFORM ONLY. Both are compositor properties; no
 * reveal on this site triggers layout. Nothing here changes size on hover
 * either — hover changes luminance, which is a CSS concern, not this file's.
 *
 * IT FIRES ONCE, and there is no option to turn that off. Copy that
 * re-animates every time it scrolls back into view is copy the reader is being
 * asked to watch rather than read. Note that returning nothing from motion's
 * `inView` callback only means "no leave handler" — the enter callback still
 * runs again on re-entry — so the observer is stopped explicitly.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import { DUR, EASE_ENTER, RISE_PX, STAGGER } from './easings';
import { prefersReducedMotion } from './useReducedMotion';

/** Decided once, at module scope. Never a render-time branch. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Is any part of the element already on screen? */
function isOnScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight && r.bottom > 0;
}

/**
 * The tags a Reveal may render as. A finite union of HTML tags on purpose:
 * `ElementType` made the JSX site below untypeable (see the note there), and a
 * Reveal wraps prose blocks, never components.
 */
export type RevealTag =
  | 'div'
  | 'section'
  | 'article'
  | 'aside'
  | 'p'
  | 'ul'
  | 'ol'
  | 'dl'
  | 'li'
  | 'figure'
  | 'header'
  | 'footer';

export function Reveal({
  as = 'div',
  children,
  className,
  /** Seconds. Defaults to the mid duration. */
  duration = DUR.mid,
  /** Pixels the block rises through. 0 for a pure fade. */
  rise = RISE_PX,
  /** Seconds of delay before this element starts. */
  delay = 0,
  /** Animate direct children in sequence instead of the block as a whole. */
  stagger,
}: {
  as?: RevealTag;
  children: ReactNode;
  className?: string;
  duration?: number;
  rise?: number;
  delay?: number;
  stagger?: number;
}): JSX.Element {
  const ref = useRef<HTMLElement | null>(null);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Nothing moves for a reader who asked for that, and nothing moves for
    // anything already on screen — it is already correct where it is.
    if (prefersReducedMotion()) return;
    if (isOnScreen(el)) return;

    const targets: HTMLElement[] =
      stagger === undefined
        ? [el]
        : (Array.from(el.children).filter((c) => c instanceof HTMLElement) as HTMLElement[]);
    if (targets.length === 0) return;

    // Before paint: push to the start state. Done here rather than in CSS so
    // the resting state stays what the prerendered markup renders.
    for (const t of targets) {
      t.style.opacity = '0';
      if (rise !== 0) t.style.transform = `translate3d(0, ${rise}px, 0)`;
      t.style.willChange = 'opacity, transform';
    }

    let cancelled = false;
    let stopObserving: (() => void) | undefined;

    const restore = () => {
      for (const t of targets) {
        t.style.opacity = '';
        t.style.transform = '';
        t.style.willChange = '';
      }
    };

    void import('motion').then(({ animate, inView }) => {
      if (cancelled) {
        // The chunk landed after unmount, or after this element was torn down.
        // Leave nothing hidden behind.
        restore();
        return;
      }

      stopObserving = inView(
        el,
        () => {
          // Once. `inView` fires its enter callback again on re-entry unless
          // the observer is stopped, and returning undefined only declines a
          // leave handler.
          if (stopObserving) stopObserving();

          targets.forEach((t, i) => {
            void animate(
              t,
              { opacity: 1, transform: 'translate3d(0, 0, 0)' },
              {
                duration,
                delay: delay + i * (stagger ?? STAGGER.normal),
                ease: EASE_ENTER as unknown as [number, number, number, number],
              },
            ).finished.then(() => {
              t.style.willChange = '';
            });
          });
          return undefined;
        },
        { amount: 0.2 },
      );
    }).catch(restore);

    return () => {
      cancelled = true;
      if (stopObserving) stopObserving();
      restore();
    };
  }, [delay, duration, rise, stagger]);

  // One concrete intrinsic type at the JSX site. For a union-typed tag, TS
  // resolves the element's props to the INTERSECTION of every member's props;
  // with the previous `ElementType` union that intersection was `never`, which
  // is TS2745/TS2322 on this line — caller-independent, and hidden until
  // `tsc -b` invalidated its buildinfo. The runtime element is still `as`.
  const Tag = as as 'div';
  return (
    <Tag ref={ref as Ref<HTMLDivElement>} className={className}>
      {children}
    </Tag>
  );
}
