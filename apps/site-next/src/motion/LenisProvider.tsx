/**
 * Scroll feel, and the one place a scroll loop is allowed to exist.
 *
 * It renders its children and nothing else — no wrapper element, no attribute,
 * no style. That matters twice over: the prerendered markup is unchanged by
 * the presence of a provider, and there is no server/client difference to
 * hydrate around.
 *
 * Lenis starts in an effect, after hydration, and only when the reader has not
 * asked for reduced motion. Smoothed scrolling IS motion; running it against
 * `prefers-reduced-motion: reduce` is the most common way a site claims to
 * respect the setting while ignoring it.
 *
 * ONE SCROLL LOOP. GSAP's ScrollTrigger, if a section uses it, must be driven
 * from this instance's tick rather than from its own requestAnimationFrame —
 * see useScrollTimeline.ts, which does the wiring. Two loops produce two
 * slightly different notions of scroll position and the symptom is a reveal
 * that fires a few pixels early on some frames and not others.
 */
import { useEffect, type JSX, type ReactNode } from 'react';
import { prefersReducedMotion } from './useReducedMotion';
import { setLenis, type ScrollDriver } from './lenisInstance';

export function LenisProvider({ children }: { children: ReactNode }): JSX.Element {
  useEffect(() => {
    if (prefersReducedMotion()) return;

    let raf = 0;
    let cancelled = false;
    let stop: (() => void) | undefined;

    // Dynamic import: the six deep pages should not pay for the scroll library
    // in their critical path, and nothing needs it before first paint.
    void import('lenis').then(({ default: Lenis }) => {
      if (cancelled) return;
      const lenis = new Lenis({ duration: 1.1, smoothWheel: true });
      // Structural cast: the slot deliberately does not import Lenis's own
      // type, so that reading the slot cannot pull the module into a bundle.
      setLenis(lenis as unknown as ScrollDriver);

      const tick = (time: number) => {
        lenis.raf(time);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      stop = () => {
        cancelAnimationFrame(raf);
        lenis.destroy();
        setLenis(null);
      };
    }).catch(() => {
      // Nothing is hidden before the import, so a rejected fetch leaves the page
      // on the browser's own native scrolling and the slot at null — the value
      // subscribeLenis already delivers when Lenis is absent.
    });

    return () => {
      cancelled = true;
      if (stop) stop();
    };
  }, []);

  return <>{children}</>;
}
