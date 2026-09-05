/**
 * The hero: the film-title card.
 *
 * WHAT IT LOST, AND WHY THAT IS THE POINT. Until this pass the hero played a
 * seven-second ambient clip behind the headline through `MotionBackdrop`. It is
 * gone, and the star field is what is behind the words now. Three reasons, in
 * the order they mattered:
 *
 *   THE REFERENCE IS PARTICLES. The owner named artificialinu.com and said "90%
 *   what im looking for", and its hero is a near-black ground with a drifting
 *   point field and nothing else moving behind the type. A video loop under the
 *   same headline is a different kind of page.
 *
 *   THE CLIP COST MORE THAN IT SAID. It was the only reason `media-src` existed
 *   in the content security policy, the only .mp4 this origin served, and a few
 *   hundred kilobytes fetched before a reader had read four words. The field is
 *   forty spans that composite on the GPU. On a page whose entire argument is
 *   that it does the smallest honest amount of work, that is not a close call.
 *
 *   THE MASCOT HAS TWO MOMENTS ALREADY. The comic art is the character in the
 *   hive section and the full-bleed parallax in the footer. A third piece of
 *   motion competing with the headline is the accessory to take off before
 *   leaving the house.
 *
 * THE HEADLINE IS SPLIT ACROSS TWO LINES AND THE SECOND CARRIES THE ACCENT.
 * That is the reference's device and it is doing work rather than decorating:
 * "The AI agent" is the subject and "trading index." is what it is, so the break
 * falls where the sentence's own hinge is. The string is assembled from
 * `TAGLINE` rather than typed, so the two words that guard permits by name
 * cannot drift apart from the permission.
 *
 * `#top` IS ON THIS SECTION because the header's Home entry points at it. From
 * the homepage, a Home link to `index.html` is a full navigation that discards
 * scroll position to arrive where you already are; an anchor scrolls.
 */
import type { JSX } from 'react';
import { Particles } from '../../assets/Particles';
import { Mark } from '../../brand/Mark';
import { FACTORY, USDG } from '../../live/chain';
import { APP_NAV, CTA, TAGLINE } from '../../shell/pinned';
import { AddressChip } from './AddressChip';
import { CHIP_LABELS, FACT, HOW_ANCHOR, LEDE } from './copy';
import styles from './IndexHero.module.css';

/**
 * The headline, split at its hinge.
 *
 * The two halves are derived from the pinned phrase rather than written out, so
 * `TAGLINE` remains the single place the wording lives. If the tagline is ever
 * reworded past the point where this split makes sense, this throws the whole
 * phrase onto one line rather than inventing a break, which is the failure a
 * reader can see and fix.
 */
const HINGE = 'trading';
const hingeAt = TAGLINE.indexOf(HINGE);
const HEAD_LEAD = hingeAt > 0 ? TAGLINE.slice(0, hingeAt).trimEnd() : TAGLINE;
const HEAD_TAIL = hingeAt > 0 ? TAGLINE.slice(hingeAt) : '';

export default function IndexHero(): JSX.Element {
  return (
    <section className={styles.hero} id="top" aria-labelledby="hero-h">
      <Particles />

      {/* THE MARK, ENORMOUS, BLEEDING OFF THE RIGHT EDGE.
          At 1440 the headline column ends around two thirds across and the rest
          of the frame was empty: not cinematic negative space, just an unused
          six hundred pixels. The reference fills that half with its mascot, and
          Rwally's mascot is spent twice already, as the character in the hive
          section and as the ground the footer stands on. A third copy here would
          be the same drawing three times above the fold.
          So the space is filled with identity rather than with art. The ledger R
          is the brand's anchor, it is one path, it costs sixty bytes, and drawn
          at this size it is outlined rather than filled, which rhymes with the
          outlined numerals in the how-it-works rail. It is `aria-hidden`: the
          wordmark in the header already says the name in text. */}
      <Mark className={styles.watermark} />

      <div className={styles.inner}>
        <h1 className={styles.headline} id="hero-h">
          {HEAD_LEAD}
          {HEAD_TAIL ? (
            <>
              <br />
              <span className={styles.accentLine}>{HEAD_TAIL}</span>
            </>
          ) : null}
        </h1>

        <p className={styles.lede}>
          {LEDE} {FACT}
        </p>

        <div className={styles.actions}>
          <a className={styles.door} href={APP_NAV.href} rel="noopener">
            {APP_NAV.label}
          </a>
          <a className={styles.quiet} href={HOW_ANCHOR}>
            {CTA.howItWorks}
          </a>
        </div>

        <div className={styles.chips}>
          <AddressChip label={CHIP_LABELS.factory} address={FACTORY} />
          <AddressChip label={CHIP_LABELS.usdg} address={USDG} />
        </div>
      </div>
    </section>
  );
}
