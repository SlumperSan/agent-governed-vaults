/**
 * The footer. Three columns, then the legal paragraph.
 *
 * It carries four pinned sentences and one of them is COUNTED rather than
 * merely required: `No token. No points. No airdrop. No presale.` and
 * `Source-available under BUSL-1.1 — not open source.` may appear exactly once
 * per page, except on faq.html where the two answers that quote them make it
 * twice. So this component renders each exactly once and nothing else on the
 * site may render either again — not a hero fact strip, not a badge, not a
 * meta description.
 *
 * The Pages column omits the current page and NOTHING ELSE, with one named
 * exception below. The masthead already marks the current page with
 * aria-current, so repeating it in the footer says nothing; every other page is
 * listed, Overview included. That is what apps/site does —
 * `apps/site/risks.html` and `apps/site/faq.html` both carry
 * `<li><a href="index.html">Overview</a></li>` in the footer's Pages list and
 * `apps/site/index.html` is the only one that does not — and a reader who has
 * scrolled to the bottom of a deep page is exactly the reader who wants the
 * way back to the overview.
 *
 * THE EXCEPTIONS ARE status.html AND disclaimers.html, and it is the whole reason this column now
 * carries eight entries where the masthead carries seven. The owner's decision
 * of 2026-09-04 — "Claims should not be a header page, it should be a link in
 * the footer" — makes this link the ONLY route to the status page, so dropping
 * it on the status page itself would remove the link exactly where a reader is
 * most likely to look for it. It stays, and carries `aria-current="page"`
 * instead. `site.test.mjs` asserts both halves: the link on all eight pages,
 * and `aria-current="page"` on the status page's own copy of it.
 */
import type { JSX } from 'react';
import { Mark } from '../brand/Mark';
import {
  BRAND,
  DISCLAIMERS_PAGE_LABEL,
  FOOTER_DISCLAIMERS_BODY,
  FOOTER_DISCLAIMERS_HEADING,
  FOOTER_PAGES,
  FOOTER_REPO_AUTHORITY,
  FOOTER_REPO_PUBLIC,
  REPO_URL,
  type PageId,
} from './pinned';
import { Pinned } from './PinnedText';

export function Footer({ page }: { page: PageId }): JSX.Element {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-grid">
          <div>
            <h2>Pages</h2>
            <ul>
              {FOOTER_PAGES.filter(
                (item) => item.id !== page || item.id === 'status.html' || item.id === 'disclaimers.html',
              ).map((item) => (
                <li key={item.id}>
                  <a href={item.id} aria-current={item.id === page ? 'page' : undefined}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2>Source</h2>
            <ul>
              <li>
                <a href={REPO_URL}>Contracts, docs and issues</a>
              </li>
            </ul>
            <Pinned as="p" className="small" html={FOOTER_REPO_AUTHORITY} />
            <Pinned as="p" className="small" html={FOOTER_REPO_PUBLIC} />
          </div>

          {/*
            THE THIRD COLUMN POINTS AT THE DISCLAIMERS PAGE, it does not restate
            it. Until 2026-09-05 this column was headed "Standing facts" and
            repeated the no-token and licence sentences on every page; the
            site-copy change consolidated every warning and legal sentence onto
            disclaimers.html, and the corpus footer now carries this gloss and a
            link instead. See the note on FOOTER_DISCLAIMERS_HEADING in
            pinned.ts for the measured counts that establish that.
          */}
          <div>
            <h2>{FOOTER_DISCLAIMERS_HEADING}</h2>
            <p className="small">{FOOTER_DISCLAIMERS_BODY}</p>
          </div>
        </div>

        {/*
          The mark closes the page. It is aria-hidden and carries no title: it
          names nothing the footer has not already said in words, and a titled
          image here would announce a brand name in the middle of the legal
          paragraph's own reading order.
        */}
        <div className="footer-brand">
          <Mark className="footer-mark" />
          {/*
            THE DESCRIPTOR LINE, AND ITS ONLY PLACE ON THE SITE. Owner decision,
            2026-09-05: the site is called Rwally, and "Agent-Governed Vaults"
            survives as the descriptor rather than as the name. It is not a
            heading and it is not a claim, it is the gloss under the mark that
            says what Rwally is, and it renders exactly once per page.
          */}
          <p className="footer-descriptor">{BRAND}</p>
        </div>
        {/*
          The closing line. One sentence with the page name as its only link,
          exactly as the corpus writes it: `Read the <a>Disclaimers</a>.` The
          anchor text is the page's own label, so the link makes sense read out
          of context, which is what a screen reader's link list does to it.
        */}
        <p className="small footer-legal">
          Read the <a href="disclaimers.html">{DISCLAIMERS_PAGE_LABEL}</a>.
        </p>
      </div>
    </footer>
  );
}
