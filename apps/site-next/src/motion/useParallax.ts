/**
 * The footer's parallax. One transform, driven by how far the band has scrolled
 * into view.
 *
 * THE ELEMENT IS DRAWN TALLER THAN ITS BAND AND SLID INSIDE IT. The stylesheet
 * gives the picture 128% of the band's height and centres it; this hook moves it
 * between roughly -12% and +12% of the overshoot as the band crosses the
 * viewport. Because the overshoot is what is being spent, the band is never
 * uncovered at either end of the travel, which is the failure every naive
 * parallax has: a strip of background showing at the top on fast scroll.
 *
 * IT IS DRIVEN BY THE SCROLL POSITION, NOT BY AN ANIMATION. There is no
 * duration, no easing and no state to get out of sync. At any scroll offset the
 * transform is a pure function of `getBoundingClientRect().top`, so an
 * interrupted scroll, a jump to an anchor, a resize and a restored scroll
 * position all land in the right place with no special handling.
 *
 * IT READS IN rAF AND WRITES IN THE SAME FRAME. The listener does nothing but
 * set a flag; the measurement and the write happen once per frame in the
 * animation callback. A scroll handler that measures synchronously on every
 * event forces layout on every event, which is the classic way a parallax turns
 * a smooth page into a stuttering one.
 *
 * IT DOES NOTHING AT ALL FOR A READER WHO ASKED FOR LESS MOTION. Not a reduced
 * amount: none. The picture is centred by the stylesheet and stays there, and no
 * listener is attached, so there is no per-frame cost either. Parallax is the
 * effect most likely to make a motion-sensitive reader ill, and a subtle version
 * of it is still the effect.
 *
 * IT IS ALSO OFF WHEN THE BAND IS OFF SCREEN. The `IntersectionObserver` gate
 * means the page does no scroll work at all until the footer is near, which on a
 * page this long is most of the time a reader spends on it.
 */
import { useEffect, type RefObject } from 'react';
import { prefersReducedMotion } from './useReducedMotion';

/** How much of the picture's overshoot is spent across a full crossing. */
const TRAVEL = 0.24;

/**
 * THE CENTRING THE STYLESHEET APPLIES, REPEATED HERE BECAUSE THIS HOOK REPLACES
 * THE WHOLE `transform` PROPERTY.
 *
 * The picture is positioned at `top: 50%; left: 50%` and pulled back by half its
 * own size, so its resting transform is `translate3d(-50%, -50%, 0)`. Writing
 * `translate3d(-50%, <shift>%, 0)` from here does not ADD a shift to that: it
 * overwrites it, and the image drops by half its height the instant the first
 * frame runs. That is exactly what happened on the first build, and the symptom
 * was a hard horizontal edge across the footer where the top of the plate had
 * fallen into the middle of the band, which reads as an image that failed to
 * load rather than as a bug in a transform. So both terms are written every
 * frame and the shift is applied ON TOP of the -50%.
 */
const CENTRE_Y = -50;

export function useParallax(
  band: RefObject<HTMLElement | null>,
  art: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const bandEl = band.current;
    const artEl = art.current;
    if (!bandEl || !artEl) return;
    if (prefersReducedMotion()) return;

    let frame = 0;
    let near = false;

    const write = () => {
      frame = 0;
      const rect = bandEl.getBoundingClientRect();
      // 0 when the band's top is at the bottom of the viewport, 1 when its
      // bottom has reached the top. Clamped, so a band taller than the viewport
      // does not run the transform past its overshoot.
      const span = window.innerHeight + rect.height;
      const progress = Math.min(1, Math.max(0, (window.innerHeight - rect.top) / span));
      const shift = CENTRE_Y + (progress - 0.5) * TRAVEL * 100;
      artEl.style.transform = 'translate3d(-50%, ' + shift.toFixed(2) + '%, 0)';
    };

    const request = () => {
      if (frame || !near) return;
      frame = requestAnimationFrame(write);
    };

    const io = new IntersectionObserver(
      (entries) => {
        near = entries.some((e) => e.isIntersecting);
        if (near) request();
      },
      { rootMargin: '20% 0px' },
    );
    io.observe(bandEl);

    window.addEventListener('scroll', request, { passive: true });
    window.addEventListener('resize', request, { passive: true });

    return () => {
      io.disconnect();
      window.removeEventListener('scroll', request);
      window.removeEventListener('resize', request);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [band, art]);
}
