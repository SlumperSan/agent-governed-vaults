/**
 * A scroll-scrubbed timeline, for the one section that has one.
 *
 * WHO ACTUALLY USES IT. `src/sections/hiw-lifecycle/StepRail.tsx:51` and
 * nothing else in the repository — so the GSAP payload is fetched by
 * how-it-works.html alone. That is checkable in the build rather than taken on
 * trust: of the eight page bundles in `dist/assets`, only
 * `how-it-works-*.js` names the `gsap-*.js` and `ScrollTrigger-*.js` chunks.
 * (The index page's scroll work is `HeroCanvas`, a separate chunk that uses no
 * GSAP.) The docstring that stood here until 2026-09-04 said "for the index
 * page and nothing else" and was wrong on both halves; `src/shell/pageBody.ts`
 * carried the same sentence and is corrected in the same change.
 *
 * WHY THE IMPORT IS DYNAMIC. GSAP and ScrollTrigger are 44,508 B gzip
 * together, for one section on one page. Measured 2026-09-04 on the two chunks
 * in `dist/assets`: `gzip -6 -c` over `gsap-*.js` (27,107 B) and
 * `ScrollTrigger-*.js` (17,401 B), which is 43.5 KiB; the same two files are
 * 112,714 B uncompressed and 40,430 B (39.5 KiB) under `brotli -q 11`. A
 * static import anywhere in the shared graph would put that payload on all
 * eight pages, so this module stays a thin wrapper whose payload lives in its
 * own chunk and is fetched only where a timeline is actually built.
 *
 * IF THE CHUNK NEVER ARRIVES. Nothing is hidden and nothing is left broken:
 * the effect below mutates no element before the import, so a rejected fetch
 * simply means the section keeps the resting state the prerendered markup
 * renders, exactly as under reduced motion. The `.catch` therefore only keeps
 * the rejection from surfacing as an unhandled promise.
 *
 * WHY IT SYNCS TO LENIS. Lenis already owns a requestAnimationFrame loop and
 * already knows the scroll position. ScrollTrigger running its own loop makes a
 * second, slightly different notion of where the page is; the symptom is a
 * trigger that fires a few pixels early on some frames and not others, and it
 * is very hard to see in a screenshot and very easy to feel. So ScrollTrigger
 * is updated from Lenis's scroll event and its own auto-refresh is left to it.
 *
 * THE SYNC SUBSCRIBES RATHER THAN SAMPLES. `LenisProvider` and this hook each
 * start a dynamic import from an effect, and React runs child effects before
 * parent effects, so this one starts first. Reading `getLenis()` once when the
 * gsap chunk resolved therefore missed the instance in the ordinary case, not
 * the rare one, and the miss was silent: no error, no console warning, just the
 * two-loop behaviour the sync exists to prevent. `subscribeLenis` attaches
 * whenever Lenis arrives, in either order, and detaches when it goes away.
 *
 * REDUCED MOTION. The hook does nothing at all — no import, no listener, no
 * subscription, no chunk fetched. A scrubbed timeline has no reduced-motion
 * equivalent worth having: the section's resting state IS the reduced-motion
 * state, and it is already on screen.
 */
import { useEffect, type RefObject } from 'react';
import { subscribeLenis } from './lenisInstance';
import { prefersReducedMotion } from './useReducedMotion';

type GsapModule = typeof import('gsap');
type ScrollTriggerModule = typeof import('gsap/ScrollTrigger');

/**
 * Build a scroll-driven timeline against an element.
 *
 * @param ref     the section the timeline is scoped to
 * @param build   called once, after hydration, with gsap and ScrollTrigger.
 *                Return a cleanup function, or nothing.
 * @param deps    anything the builder closes over
 */
export function useScrollTimeline(
  ref: RefObject<HTMLElement | null>,
  build: (ctx: {
    gsap: GsapModule['gsap'];
    ScrollTrigger: ScrollTriggerModule['ScrollTrigger'];
    element: HTMLElement;
  }) => void | (() => void),
  deps: readonly unknown[] = [],
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Before the import, deliberately: with motion reduced nothing is fetched.
    if (prefersReducedMotion()) return;

    let cancelled = false;
    let teardown: (() => void) | undefined;

    void Promise.all([import('gsap'), import('gsap/ScrollTrigger')]).then(
      ([{ gsap }, { ScrollTrigger }]) => {
        if (cancelled) return;
        gsap.registerPlugin(ScrollTrigger);

        // One scroll loop: drive ScrollTrigger from Lenis rather than letting
        // it poll on its own. The subscription fires immediately if Lenis has
        // already landed and later if it has not, so this works in both
        // orderings; `detach` tracks the instance currently listened to so the
        // handler is removed from THAT instance and not from a replacement.
        const onScroll = () => ScrollTrigger.update();
        let detach: (() => void) | undefined;
        const unsubscribe = subscribeLenis((lenis) => {
          if (detach) {
            detach();
            detach = undefined;
          }
          if (!lenis) return;
          lenis.on('scroll', onScroll);
          detach = () => lenis.off('scroll', onScroll);
        });

        const built = build({ gsap, ScrollTrigger, element });

        teardown = () => {
          unsubscribe();
          if (detach) detach();
          if (built) built();
          ScrollTrigger.getAll().forEach((t) => t.kill());
        };
      },
    ).catch(() => {
      // Nothing to undo: no element was touched before the import. See "IF THE
      // CHUNK NEVER ARRIVES" at the top of this file.
    });

    return () => {
      cancelled = true;
      if (teardown) teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
