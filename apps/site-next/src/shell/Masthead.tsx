/**
 * The masthead: a floating pill carrying the mark, a live price chip, the nav,
 * the X link and the app door.
 *
 * WHAT THIS REPLACED, AND WHY THE REASONING CHANGED RATHER THAN THE TASTE. The
 * first v3 pass, earlier on 2026-09-05, rendered the mark and the wordmark and
 * nothing else, and argued at length that a nav of two entries is chrome that
 * says nothing. Revision 2 of the brief, the same evening, did not overrule that
 * argument on its merits; it changed the premise. The owner named
 * artificialinu.com as the reference and asked that "header, footer, tab icon
 * all are the same" across rwally.com and app.rwally.com. The reference's header
 * is a floating pill with a centred nav, and two of the four entries in it are
 * not pages of this site at all: one is a same-page anchor and one is off-site.
 * A nav of four entries pointing at four different KINDS of destination is not
 * the empty chrome the earlier argument was about. See `HEADER_NAV` in
 * pinned.ts, which is where the four live and where each says what kind it is.
 *
 * THE PRICE CHIP IS THE ONE PIECE OF THIS HEADER THAT COULD LIE, so most of the
 * care in this file is spent on it.
 *
 *   IT CARRIES ITS OWN AGE, ALWAYS, AT EVERY WIDTH. A Chainlink feed prints when
 *   it prints. ETH/USD is a crypto feed and prints many times a day; the equity
 *   feeds on this chain stop with the market and are routinely twenty to fifty
 *   hours old over a weekend. A price rendered alone in a header is read as a
 *   quote from now, and on a Saturday that reading is false. So the chip renders
 *   three tokens and never two: the pair, the price, and how old the print is.
 *   The exact timestamp, to the minute in UTC, is in the LIVE section; the chip
 *   carries the age because a header has room for a token and not for a date.
 *
 *   IT IS AN ANCHOR TO THAT SECTION for the same reason. A reader who wants the
 *   timestamp, the feed's own description string and the other four reads is one
 *   click from all of them, and the chip says so in its accessible name.
 *
 *   IT RENDERS NOTHING UNTIL THE READ RETURNS. Not a zero, not a dash, not a
 *   skeleton shaped like a price. A number that appears before it is true is a
 *   number some reader will screenshot. The chip is absent from the server
 *   markup and appears when there is something to show, which is also why it
 *   cannot shift the layout: it is laid out in a slot that reserves its space.
 *
 * THE MARK STAYS INLINE SVG, for the reason it always was: it is one path, and
 * it has to follow the link's colour on hover, which an `<img>` cannot do. It is
 * `aria-hidden` and the link carries the name once in `aria-label`, because the
 * wordmark beside it already says it in text.
 *
 * THE MARK PATH IS GUARDED ACROSS THREE FILES. `src/brand/markPath.ts` here,
 * `apps/site/assets/` and `apps/app/src/index.html` all draw the same path, and
 * `test/site.test.mjs` asserts they are identical. That is what makes the tab
 * icon and the header read as one product across the two surfaces rather than
 * as two teams who both owned a logo.
 */
import type { JSX } from 'react';
import { Mark } from '../brand/Mark';
import { LivePriceChip } from '../live/LivePriceChip';
import { APP_NAV, BRAND_NAME, HEADER_NAV, TAGLINE, X_URL, type PageId } from './pinned';
import styles from './masthead.module.css';

/** The X glyph. One path, drawn at the viewBox X publishes for it. */
function XGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}

/** The door arrow, in the filled disc the CTA carries. */
function DoorArrow(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="square"
        d="M5 11 11 5M6 5h5v5"
      />
    </svg>
  );
}

export function Masthead({ page }: { page: PageId }): JSX.Element {
  return (
    <header className={styles.masthead}>
      <div className={styles.pill}>
        <div className={styles.left}>
          <a
            className={styles.brand}
            href="index.html"
            aria-label={BRAND_NAME}
            aria-current={page === 'index.html' ? 'page' : undefined}
          >
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

          <span className={styles.chipSlot}>
            <LivePriceChip page={page} />
          </span>
        </div>

        <nav className={styles.nav} aria-label="Site">
          {HEADER_NAV.map((item) => (
            <a
              key={item.label}
              className={styles.navLink}
              href={item.href}
              rel={item.external ? 'noopener' : undefined}
              aria-current={item.page === page ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className={styles.right}>
          <a className={styles.icon} href={X_URL} rel="noopener" aria-label="Rwally on X">
            <XGlyph />
          </a>
          <a className={styles.cta} href={APP_NAV.href} rel="noopener">
            <span>{APP_NAV.label}</span>
            <span className={styles.ctaDisc} aria-hidden="true">
              <DoorArrow />
            </span>
          </a>
        </div>
      </div>
    </header>
  );
}
