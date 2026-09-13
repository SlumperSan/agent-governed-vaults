/**
 * not-found — the body of `404.html`, the document Cloudflare Pages serves with
 * a 404 status for a path that matches no asset and no `_redirects` rule.
 *
 * WHY THE FILE EXISTS AT ALL is written where the id is declared, in
 * `src/shell/pinned.ts` under `NOT_FOUND_ID`: without a top-level `404.html`
 * the Pages asset server falls back to serving `/index.html` with a 200, so
 * every mistyped or stale path was a 200 duplicate of the homepage. Read that
 * note before changing anything here.
 *
 * TWO CONSTRAINTS THIS COPY IS WRITTEN UNDER, and neither is a style
 * preference:
 *
 *   IT MUST NOT GUESS. This component is rendered for `/nonsense.html` and for
 *   `/assets/typo.js` alike, and it has no way to know which. So it states what
 *   is true of every one of them — the address is not a document of this site —
 *   and never speculates about what the reader meant.
 *
 *   IT IS WALKED BY THE CLAIMS SUITE. `scripts/test/claims-lede-truth.test.mjs`
 *   deliberately does not skip `dist`, and `claims-token-absence.test.mjs`
 *   reads every `.html` under `apps/site-next/dist`. So the sentences below are
 *   public surface with the same standing as the homepage's, and a sentence
 *   about the protocol written here has to be as true as one written there.
 *   The safest copy for this page is copy that describes only this page, which
 *   is what it does.
 *
 * THE TWO ACTIONS ARE ROOT-ABSOLUTE, and that is not decoration. Pages renders
 * this document at whatever path was asked for rather than redirecting, so a
 * relative `index.html` here resolves against the failed path's directory and
 * lands on a second 404. `siteHref` is what makes them absolute, and the
 * chrome's own links go through it for the same reason.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { RISE_HERO_PX, STAGGER } from '../../motion/easings';
import { DISCLAIMERS_PAGE_LABEL, NOT_FOUND_ID, siteHref } from '../../shell/pinned';
import s from './NotFound.module.css';

const EYEBROW = '404';

const TITLE = 'This page is not here.';

const LEDE =
  'The address you asked for is not a document on this site. It was either retired, or the link that sent you here is wrong. This site has two documents, and both are one click away.';

/**
 * The primary action. Written as an instruction rather than as a noun, which is
 * the rule the rest of this site's button labels follow — `APP_NAV.label` is
 * "Open the app" for the same reason. It names the same document the footer
 * lists as "Overview"; the two are worded differently on purpose, because one
 * is a nav entry and this is a button.
 */
const HOME_LABEL = 'Go to the overview';

/**
 * Seconds. The same enter the deep-page hero uses. It sits inside the 0.24-0.8
 * band easings.ts describes but is not one of its four named durations, so it
 * is written here rather than mis-mapped onto DUR.mid or DUR.slow.
 */
const ENTER_SECONDS = 0.6;

export default function NotFound(): JSX.Element {
  return (
    <section className={s.notFound}>
      <div className="wrap">
        {/*
          THE RESTING STATE IS WHAT RENDERS. <Reveal> prerenders its children at
          their final position and full opacity and only then, in a layout
          effect, pushes them back to animate forward — so every sentence here
          is in dist/404.html whether or not anything scrolls, and a reader with
          reduced motion, or with the module script blocked, gets the finished
          page rather than an empty one. On a document that exists to tell
          somebody their link is broken, that is the only acceptable failure
          mode.
        */}
        <Reveal stagger={STAGGER.normal} duration={ENTER_SECONDS} rise={RISE_HERO_PX}>
          <p className={s.eyebrow}>{EYEBROW}</p>
          <h1 className={s.title}>{TITLE}</h1>
          <p className={s.lede}>{LEDE}</p>
          <div className={s.actions}>
            <a className="door" href={siteHref(NOT_FOUND_ID, 'index.html')}>
              {HOME_LABEL}
            </a>
            <a className="quiet" href={siteHref(NOT_FOUND_ID, 'disclaimers.html')}>
              {DISCLAIMERS_PAGE_LABEL}
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
