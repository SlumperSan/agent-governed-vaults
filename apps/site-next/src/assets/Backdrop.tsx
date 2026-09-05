/**
 * The one way a picture gets behind a section.
 *
 * A section says which SLOT it wants; it never names a file, a width or a
 * format. That is what makes the visual set swappable — see the manifest, which
 * records that the current abstract set is a placeholder for an illustrated one
 * being drawn under a separate brief.
 *
 * ALWAYS DECORATIVE. The wrapper is `aria-hidden` and the image's `alt` is
 * empty, so nothing here reaches the accessibility tree and nothing here is a
 * claim. The manifest records the by-eye check that no image in the set carries
 * lettering.
 *
 * IT DOES NOT DARKEN THE COPY ITSELF. The overlay that holds the contrast floor
 * is in `backdrop.module.css`, in front of the image and behind the section's
 * own children, because a scrim painted with the picture cannot be tuned
 * without re-encoding the picture.
 *
 * THE HOST SECTION OWES TWO DECLARATIONS: `position: relative` so the absolute
 * box has something to sit in, and `isolation: isolate` so the backdrop's
 * `z-index: -1` is bounded by the section and cannot reach past it to sit
 * behind the page. Both are in each host section's own stylesheet, next to a
 * comment saying so.
 */
import { useEffect, useState, type JSX } from 'react';
import { prefersReducedMotion } from '../motion/useReducedMotion';
import { LOOP, STILLS, type StillId } from './manifest';
import s from './backdrop.module.css';

/** A still behind a section. */
export function Backdrop({ slot }: { slot: StillId }): JSX.Element {
  const a = STILLS[slot];
  return (
    <div className={s.backdrop} aria-hidden="true">
      <img
        className={s.media}
        src={a.src}
        srcSet={a.srcSet}
        sizes="100vw"
        width={a.width}
        height={a.height}
        alt=""
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

/**
 * The moving backdrop, and the only `<video>` on this site.
 *
 * THE SERVER RENDERS THE POSTER AND ONLY THE POSTER, and the clip is ADDED
 * after mount. Three things follow from that, and they are the reasons it is
 * written this way rather than with a CSS media query:
 *
 *   1. NO HYDRATION MISMATCH. `src/shell/App.tsx` states the rule: the tree
 *      must not branch on anything the server cannot know. `useState(false)` is
 *      false on the server and false on the client's hydrating render, so both
 *      trees agree; the effect below runs afterwards and adds the clip.
 *   2. A READER WHO ASKED FOR REDUCED MOTION NEVER DOWNLOADS IT. `display:
 *      none` on a `<video>` still fetches it. Not rendering the element is the
 *      only way not to spend a reader's bytes on motion they declined.
 *   3. IT IS LAZY BY CONSTRUCTION. Nothing is requested until React has
 *      hydrated, which is after the page has painted, and the browser defers an
 *      offscreen autoplaying element until it is scrolled to.
 *
 * NO `preload` ATTRIBUTE, because it was measured to make no difference and an
 * attribute that changes nothing is a claim about behaviour that nobody has
 * checked. Three elements were created on the served page under the real CSP on
 * 2026-09-05, identical but for `preload` — `none`, `metadata`, and the
 * attribute absent — and all three reached `readyState` 4, `paused` false and
 * 2.5 s of playback within the same 2.5 s window. The browser's own policy for
 * a muted autoplaying element governs: it defers the element while offscreen
 * and starts it when it is not, whatever `preload` says.
 *
 * A NOTE FOR WHOEVER MEASURES THIS NEXT, because it cost a wrong conclusion
 * once. The first reading of this element said `readyState` 0 and the clip
 * never requested, and the cause was not the page: the static server used for
 * measurement parses `dist/_headers` ONCE at start-up, and it had been started
 * before `media-src 'self'` was added to that file. The element was being
 * refused by a stale policy, and Chrome reports that as
 * `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check` rather than as
 * a CSP violation, which is not a message that points at the cause. Restart the
 * server after editing `_headers`.
 *
 * `useReducedMotion` is deliberately NOT used: its own docstring forbids using
 * it to decide what to render. This asks the same question in an effect, which
 * is what that file says the question is for.
 *
 * The poster stays mounted underneath. It is what fills the box while the first
 * frames arrive, and it is what a reader sees if the clip fails to decode.
 */
/**
 * IS THE CLIP WORTH THIS READER'S BYTES?
 *
 * MEASURED, and the reason this function exists. The clip is 301,702 B and it is
 * the largest thing the hero paints, so on a slow connection it becomes the
 * largest contentful paint and drags it out: at 1440 under 4x CPU throttling and
 * a Slow 4G profile (400 kbit/s, 400 ms RTT, cache disabled) the median LCP was
 * 9,388 ms with the `<video>` as the LCP element, against 4,880 ms with the h1
 * as the LCP element when no clip was mounted. Both measured 2026-09-05 over the
 * served build.
 *
 * So a reader the browser tells us is on a slow connection, or who has asked for
 * reduced data, keeps the poster. It is the same shape of decision as the
 * reduced-motion one directly above: an enhancement that costs bytes is not
 * added for a reader the bytes would hurt.
 *
 * The API is not universal, and its absence means "no reason to hold back"
 * rather than "hold back": a browser with no Network Information API is
 * overwhelmingly a desktop browser on a connection that can afford 300 KB.
 *
 * VERIFIED IN A BROWSER RATHER THAN ASSERTED, because the throttled perf run
 * cannot exercise it: CDP's `Network.emulateNetworkConditions` throttles the
 * transport and leaves `navigator.connection.effectiveType` reading "4g", so a
 * Slow 4G profile alone never trips this branch. The property was instead
 * overridden before any script ran, on the served build, 2026-09-05:
 *
 *   no connection API      video mounted, clip requested
 *   4g, saveData false     video mounted, clip requested
 *   3g                     NO video element, clip never requested
 *   4g, saveData true      NO video element, clip never requested
 *
 * The poster is on screen in all four.
 */
function worthTheBytes(): boolean {
  const c = (navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean } }).connection;
  if (!c) return true;
  if (c.saveData) return false;
  return c.effectiveType === undefined || c.effectiveType === '4g';
}

export function MotionBackdrop(): JSX.Element {
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    if (!worthTheBytes()) return;
    // One frame later rather than synchronously, so hydration finishes and the
    // page paints before the clip is asked for. It also keeps this out of the
    // render that mounts it: a setState called straight from an effect body
    // starts a second render before the browser has drawn the first.
    const id = requestAnimationFrame(() => setMoving(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className={s.backdrop} aria-hidden="true">
      <img
        className={s.media}
        src={LOOP.src}
        srcSet={LOOP.srcSet}
        sizes="100vw"
        width={LOOP.width}
        height={LOOP.height}
        alt=""
        loading="lazy"
        decoding="async"
      />
      {moving ? (
        <video
          className={s.media}
          src={LOOP.video}
          poster={LOOP.src}
          width={LOOP.videoWidth}
          height={LOOP.videoHeight}
          autoPlay
          muted
          loop
          playsInline
          tabIndex={-1}
        />
      ) : null}
    </div>
  );
}
