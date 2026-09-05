/**
 * The footer: a full-bleed mascot, the four doors, and the legal line.
 *
 * WHAT CHANGED AND WHY THE OLD REASONING NO LONGER APPLIES.
 *
 *   THE X LINK IS HERE NOW. This file used to argue, correctly, that nothing was
 *   better than an `href="#"` placeholder because a link that lies about having
 *   a destination is worse than no link. The premise was that the handle was
 *   unknown. The owner gave it on 2026-09-05, so the argument is satisfied
 *   rather than overruled: there is a destination, so there is a link.
 *
 *   IT IS A PICTURE NOW, NOT A ROW. The v3 brief's revision 2 names the
 *   reference's "full bleed parallax mascot footer" and asks that the footer be
 *   the same across rwally.com and app.rwally.com. So the mascot fills the band,
 *   a gradient lifts the type off it, and the links sit on top.
 *
 * THE ART IS DECORATION HERE AND CONTENT IN THE HIVE SECTION, WHICH IS WHY IT IS
 * A BACKGROUND IN ONE PLACE AND AN `<img>` IN THE OTHER. The same file, twice, at
 * two crops. In the hive section it is the subject and carries alt text
 * describing what is drawn. Here it is the ground the type sits on: a reader
 * who cannot see it loses nothing, because every word over it is text. Giving it
 * alt text in both places would make a screen reader read the same description
 * twice for one drawing.
 *
 * THE SCRIM IS NOT OPTIONAL AND IT IS NOT TASTE. The drawing has a bright violet
 * shaft through it, and --ink over that shaft is a contrast failure at exactly
 * the place the eye lands. The gradient in the stylesheet takes the band to
 * --scrim-deep behind the type and lets the picture through at the top, which is
 * what makes the 7:1 hold over every pixel a word sits on rather than over the
 * average of the image.
 *
 * BOTH PAGES ARE LISTED ON BOTH PAGES. With a header nav of four entries, two of
 * which leave the site, this list is still the complete map of the two documents
 * here, so neither is dropped on itself; the current one carries
 * `aria-current="page"`.
 *
 * THE LICENCE SENTENCE IS COUNTED. `Source-available under BUSL-1.1, not open
 * source.` is the only permitted use of the words "open source" anywhere on this
 * site, and `test/site.test.mjs` pins how many times it may appear per page.
 * Rendering it here puts one copy on both pages.
 */
import { useRef, type JSX } from 'react';
import { STILLS } from '../assets/manifest';
import { Mark } from '../brand/Mark';
import { useParallax } from '../motion/useParallax';
import {
  APP_NAV,
  BRAND_NAME,
  FOOTER_LICENCE,
  FOOTER_PAGES,
  REPO_URL,
  TAGLINE,
  X_URL,
  type PageId,
} from './pinned';
import { Pinned } from './PinnedText';
import styles from './footer.module.css';

export function Footer({ page }: { page: PageId }): JSX.Element {
  const art = STILLS.mascot;
  const band = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  useParallax(band, picture);

  return (
    <footer className={styles.footer}>
      {/* The band. `aria-hidden` on the whole picture layer, with the scrim
          drawn over it by the stylesheet rather than by a second element. */}
      <div className={styles.band} aria-hidden="true" ref={band}>
        <img
          className={styles.art}
          ref={picture}
          src={art.src}
          srcSet={art.srcSet}
          sizes="100vw"
          width={art.width}
          height={art.height}
          alt=""
          loading="lazy"
          decoding="async"
        />
      </div>

      <div className={styles.inner}>
        <a className={styles.brand} href="index.html" aria-label={BRAND_NAME}>
          <Mark className={styles.mark} />
          <span className={styles.lockup}>
            <span className={styles.name} aria-hidden="true">
              {BRAND_NAME}
            </span>
            <span className={styles.tagline} aria-hidden="true">
              {TAGLINE}
            </span>
          </span>
        </a>

        <nav className={styles.nav} aria-label="Site">
          <a className={styles.door} href={APP_NAV.href} rel="noopener">
            {APP_NAV.label}
          </a>
          <a className={styles.link} href={X_URL} rel="noopener">
            X
          </a>
          <a className={styles.link} href={REPO_URL} rel="noopener">
            GitHub
          </a>
          {FOOTER_PAGES.map((item) => (
            <a
              className={styles.link}
              key={item.id}
              href={item.id}
              aria-current={item.id === page ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <Pinned as="p" className={styles.legal} html={FOOTER_LICENCE} />
      </div>
    </footer>
  );
}
