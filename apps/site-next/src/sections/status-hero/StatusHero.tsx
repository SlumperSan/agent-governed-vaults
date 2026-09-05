/**
 * status-hero — the top of status.html, and that page's one <h1>.
 *
 * IT RENDERS THE RECORD BAND, AND THAT IS THE POINT OF THE PAGE. A band
 * stood above the <nav> on all seven pages until the owner's decision of
 * 2026-09-04 — "Claims should not be a header page, it should be a link in
 * the footer." PageShell no longer renders one; this section does, once, as
 * the first thing inside `<main>`.
 *
 * 2026-09-05 CORPUS SYNC — WHY THIS NO LONGER RENDERS `<PreLaunchBanner>`.
 * That shared component (src/shell/PreLaunchBanner.tsx) renders
 * `BANNER_TAG`/`BANNER_PARAGRAPH` from src/shell/pinned.ts, which still say
 * "Pre-launch" / "Not deployed to mainnet…". status.html is no longer a
 * pre-launch page: the corpus's band is titled "The record" and states the
 * Robinhood Chain mainnet deployment fact instead. Rather than repoint the
 * shared component and its pinned constants — owned elsewhere, and still
 * accurate for whatever page(s) the pre-launch disclosure belongs on — this
 * section renders the band inline, reusing the same sitewide `.banner` /
 * `.banner-tag` rules from src/index.css (unedited) with its own two literal
 * strings from ./copy.ts. See copy.ts for the full note.
 *
 * NO MOTION. The band is factual copy and the page is a page of verifiable
 * figures; both read better arriving finished. There is no `Reveal` here, so
 * the prerendered markup is the finished section for every reader, and the
 * reduced-motion state and the JavaScript-unavailable state are the ordinary
 * state.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { BAND_TAG, BAND_TEXT, EYEBROW, LEDE, TITLE } from './copy';
import s from './StatusHero.module.css';

export default function StatusHero(): JSX.Element {
  return (
    <>
      <div className="banner">
        <div className="wrap">
          <span className="banner-tag">{BAND_TAG}</span>
          <Pinned as="p" html={BAND_TEXT} />
        </div>
      </div>
      <div className={s.hero}>
        <div className="wrap">
          <p className={s.eyebrow}>{EYEBROW}</p>
          <h1 className={s.title}>{TITLE}</h1>
          <p className={s.lede}>{LEDE}</p>
        </div>
      </div>
    </>
  );
}
