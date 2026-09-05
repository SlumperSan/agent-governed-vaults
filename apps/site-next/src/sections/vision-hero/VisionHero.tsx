/**
 * vision-hero — the hero of vision.html, and that page's one <h1>.
 *
 * REPOINTED 2026-09-05, copy deck v2. The placeholder this file used to
 * render said "This page is not written yet" — the deck has now landed, so it
 * does not apply any more. Every string below is lifted byte-for-byte from
 * the `.hero.hero--plain` block of `apps/site/vision.html`, the reviewed
 * source of truth.
 *
 * THE H1 IS "Where Rwally is going.", NOT "The AI's S&P 500." — the deck's own
 * proposed heading. Owner override, round 5: "The AI's S&P 500" is structural
 * only and is never printed anywhere on the site. `apps/site/vision.html`
 * already carries that override; this section matches it rather than the
 * deck's superseded literal suggestion.
 *
 * THE ANCHOR PARAGRAPH carries an apostrophe (as `&rsquo;`) and an em-dash (as
 * `&mdash;`) as HTML source bytes, hence <Pinned>. It is the single sentence
 * the whole page's honesty rests on: every "designed, not built" claim that
 * follows is downstream of this one being true today.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import s from './VisionHero.module.css';

const HEADING_ID = 'vision-h1';

const HEADING = 'Where Rwally is going.';

const LEDE =
  'An index of the stock tokens on Robinhood Chain, decided every hour by a hive of agents and by the people who stake alongside them.';

const ANCHOR =
  'None of what follows is built. The contracts on chain today price two assets, and the factory&rsquo;s oracle allowlist is fixed in its constructor with no add, no remove and no owner &mdash; so this index needs its own deployment on Robinhood Chain. That is a fact about the code, not a caveat about the plan.';

export default function VisionHero(): JSX.Element {
  return (
    <div className={s.hero}>
      <div className="wrap">
        <p className={s.eyebrow}>Vision</p>
        <h1 className={s.title} id={HEADING_ID}>
          {HEADING}
        </h1>
        <p className={s.lede}>{LEDE}</p>
        <Pinned as="p" className={s.anchor} html={ANCHOR} />
      </div>
    </div>
  );
}
