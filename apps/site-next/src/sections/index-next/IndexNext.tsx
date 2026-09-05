/**
 * The RWLY beat, and the last thing on the page before the footer.
 *
 * IT LOST ITS BACKDROP THIS PASS, and the reason is that the mascot is now a
 * character rather than a texture. It appears twice on this page: as the figure
 * in the hive section, at full size with real alt text, and as the full-bleed
 * parallax the footer is built on. A third appearance, dimmed behind a
 * paragraph, would be the same drawing used as wallpaper eighty pixels after it
 * was used as a character, which devalues the two places it is doing work.
 *
 * SO THIS SECTION IS TYPE ON GROUND, AND THAT SUITS WHAT IT SAYS. It is the one
 * quiet beat on a deliberately loud page: the heading says there is nothing to
 * claim, the paragraph says the next iteration does not exist, and the only
 * thing to do here is read the Disclaimers. Decorating that would be arguing
 * with it.
 *
 * THE REVEAL SETS ITS PRE-STATE FROM JAVASCRIPT, NEVER FROM SHIPPED CSS. See
 * `src/motion/Reveal.tsx`: it writes `opacity: 0` through the CSSOM in a layout
 * effect and skips entirely for an element already on screen or a reader who has
 * asked for reduced motion. That ordering is what keeps the prerendered document
 * fully visible, which matters here for three separate reasons: a reader whose
 * script did not run sees the text, a crawler sees the text, and the word
 * counter in `test/site.test.mjs`, which reads the markup rather than the
 * pixels, is counting words that are actually on the page.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { DISCLAIMERS_PAGE_LABEL } from '../../shell/pinned';
import { DESIGN_INTENT, HEADING } from './copy';
import s from './IndexNext.module.css';

export default function IndexNext(): JSX.Element {
  return (
    <section className={s.next} aria-labelledby="next-heading">
      <div className={s.inner}>
        <span className={s.rule} aria-hidden="true" />
        <Reveal stagger={0.08}>
          <h2 className={s.heading} id="next-heading">
            {HEADING}
          </h2>
          <p className={s.body}>{DESIGN_INTENT}</p>
          <p className={s.action}>
            <a className={s.gate} href="disclaimers.html">
              {DISCLAIMERS_PAGE_LABEL}
            </a>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
