/**
 * THE HIVE. The narrative beat, and the mascot's first appearance as a
 * character rather than as wallpaper.
 *
 * THE IMAGE IS AN `<img>` WITH REAL ALT TEXT, AND THE FOOTER'S COPY OF IT IS
 * NOT. Same file, two roles, and the roles decide the markup. Here the drawing
 * is the section's second half: it is what the layout is built around, and a
 * reader who cannot see it is owed a description of what is drawn. In the footer
 * the same plate is the ground the type sits on, so it is `aria-hidden` with an
 * empty alt, because describing it twice would make a screen reader read one
 * drawing's description two sections apart.
 *
 * There is no `Backdrop` component any more. It existed to render a decorative
 * plate behind a paragraph, and with the video slots gone the two remaining uses
 * of the one remaining picture are this one and the footer's, which are
 * different enough that a shared wrapper was hiding the difference rather than
 * capturing it.
 *
 * IT IS THE ONLY RASTER ASSET ON THE PAGE, which is why it is worth its bytes.
 * The hero dropped its video loop this pass and the footer reuses this same
 * file, so the page fetches one image and shows it twice at two crops rather
 * than fetching three pieces of art. `srcset` offers the 1280 and 1920 widths
 * that already exist in `public/media/`; `sizes` tells the browser this slot is
 * about half the viewport on a wide screen, so a phone never downloads the
 * 1920.
 *
 * `loading="lazy"` AND AN EXPLICIT width AND height. The dimensions are the
 * asset's real ones, 1920 by 1072, so the browser reserves the box before the
 * bytes arrive and the text beside it does not reflow when they do.
 */
import type { JSX } from 'react';
import { STILLS } from '../../assets/manifest';
import { BODY_1, BODY_2, EYEBROW, HEADING, MASCOT_ALT } from './copy';
import styles from './IndexHive.module.css';

export default function IndexHive(): JSX.Element {
  const art = STILLS.mascot;

  return (
    <section className={styles.hive} id="hive" aria-labelledby="hive-h">
      <div className={styles.inner}>
        <div className={styles.words}>
          <p className={styles.eyebrow}>{EYEBROW}</p>
          <h2 className={styles.heading} id="hive-h">
            {HEADING}
          </h2>
          <p className={styles.body}>{BODY_1}</p>
          <p className={styles.body}>{BODY_2}</p>
        </div>

        <figure className={styles.art}>
          <img
            className={styles.mascot}
            src={art.src}
            srcSet={art.srcSet}
            sizes="(max-width: 60rem) 100vw, 50vw"
            width={art.width}
            height={art.height}
            alt={MASCOT_ALT}
            loading="lazy"
            decoding="async"
          />
        </figure>
      </div>
    </section>
  );
}
