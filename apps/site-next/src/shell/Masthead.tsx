/**
 * The masthead: brand, then the primary nav carrying seven pages.
 *
 * SEVEN, NOT EIGHT. status.html is reached from the footer of every page and is
 * deliberately absent here — the owner's decision of 2026-09-04 asked for a link
 * in the footer rather than a header entry, and site.test.mjs asserts that no
 * <nav> contains status.html.
 *
 * THE .html SUFFIX STAYS. Every page must literally contain
 * `href="index.html"`, `href="how-it-works.html"`, `href="agents.html"`,
 * `href="who-its-for.html"`, `href="operators.html"`, `href="risks.html"`,
 * `href="faq.html"` and `href="status.html"` — the first seven from this nav,
 * the eighth from the footer's Pages list. Cloudflare Pages 301s `/risks.html`
 * to `/risks`, so the suffix costs one redirect a reader never sees; dropping
 * it for tidiness reds eight checks at once.
 *
 * There is no client router. Each link is an ordinary document navigation to
 * one of eight separately built HTML files.
 */
import type { JSX } from 'react';
import { Mark } from '../brand/Mark';
import { BRAND_NAME, NAV, type PageId } from './pinned';

export function Masthead({ page }: { page: PageId }): JSX.Element {
  return (
    <header className="masthead">
      <div className="wrap">
        {/*
          BOTH FORMS ARE RENDERED AND CSS PICKS ONE. Owner decision, 2026-09-05:
          the comic horizontal lockup at 48px on desktop, and the ledger R mark
          beside the name in text on mobile — the lockup's wordmark stops
          reading at that size, which is the same reason the brand set names the
          ledger R as the mark for small sizes.

          A media query, not a render branch: `src/shell/App.tsx` forbids
          branching the tree on the viewport, because the server cannot know it
          and React discards the mismatched subtree — which is the markup the
          claims guards just verified. So both are in the markup at every width
          and `src/index.css` hides one.

          THE LOCKUP IS AN img AND THE MARK IS INLINE, and the difference is
          deliberate. The lockup is a 16 KB traced outline that inherits nothing
          and needs no colour from the page, so it is one cached request rather
          than 16 KB in the head of every page. The mark is 60 bytes of path and
          has to follow the link's colour on hover, which an img cannot do.

          Both are aria-hidden and the link carries the name once, in the
          aria-label: three copies of "Rwally" in one link is two too many.
        */}
        <a className="brand" href="index.html" aria-label={BRAND_NAME}>
          <img
            className="brand-lockup"
            src="/brand/rwally-lockup.svg"
            alt=""
            height={48}
            aria-hidden="true"
          />
          <span className="brand-compact" aria-hidden="true">
            <Mark className="brand-mark" />
            <span className="brand-name">{BRAND_NAME}</span>
          </span>
        </a>
        <nav aria-label="Primary">
          <ul>
            {NAV.map((item) => (
              <li key={item.id}>
                <a href={item.id} aria-current={item.id === page ? 'page' : undefined}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
