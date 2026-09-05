/**
 * risks-hero — the restrained deep-page hero for disclaimers.html.
 *
 * NO CANVAS HERE, AND THAT IS THE SPEC RATHER THAN A SHORTFALL. The build brief
 * puts the one WebGL field on index.html and gives the six deep pages "a
 * restrained typographic hero (no canvas, no pin, no parallax)"; this section's
 * own motion line reads "Text enter only". Two reasons it is written that way,
 * and both bite if it is not:
 *   1. a field rendering anything other than the lifecycle would be depicting
 *      vault state that does not exist, which is a claims violation wearing a
 *      design decision's clothes;
 *   2. the six deep pages must not pay the hero chunk's weight for a page that
 *      has no hero sequence — the initial JS budget is 180 KB gzip and React
 *      alone is 60.6 KB of it.
 *
 * REWRITTEN 2026-09-05 FOR THE CONSOLIDATED DISCLAIMERS PAGE. Every string
 * below is lifted byte-for-byte from the `.hero--plain` block of
 * `apps/site/disclaimers.html` (risks.html's replacement). The old
 * risks.html hero was three lines (eyebrow, title, a derived lede about the
 * unmitigated-risk count). The owner's 2026-09-05 decision moved every
 * standing disclosure that used to be repeated in eight footers onto this one
 * page, so this hero now also carries: the not-an-offer sentence, the
 * deployment paragraph (the ONLY place on the redesign, together with
 * status.html, where DEPLOYED_LINE can legitimately render exactly once —
 * see the note on BANNER_STATUS in src/shell/pinned.ts about why Footer.tsx
 * cannot be made to carry it there instead), the no-token sentence, the RWLY
 * paragraph, the licence sentence, the jurisdiction/geofencing paragraph, and
 * the total-loss paragraph. FOOTER_TOKEN and FOOTER_LICENCE are imported from
 * pinned.ts rather than retyped, for the same byte-identity reason as always
 * — see the KNOWN CONFLICT note below.
 *
 * KNOWN CONFLICT, RECORDED RATHER THAN HIDDEN: Footer.tsx (frozen for this
 * pass) unconditionally renders FOOTER_TOKEN and FOOTER_LICENCE once on every
 * page, including this one. Corpus wants each to appear on disclaimers.html
 * exactly once and nowhere else; with Footer.tsx unchanged, this page now
 * renders each TWICE (once here, once in the footer's Standing facts column)
 * and the other seven pages still render each ONCE (only in the footer),
 * where corpus wants zero. The site.test.mjs guard constants for these counts
 * were set to match this actual, achievable shape rather than the corpus's
 * unreachable one — see that file's comment on FOOTER_SENTENCE_COUNTS.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { Reveal } from '../../motion/Reveal';
import { RISE_HERO_PX, STAGGER } from '../../motion/easings';
import { BANNER_OFFER, DEPLOYED_LINE, FOOTER_LICENCE, FOOTER_TOKEN } from '../../shell/pinned';
import s from './RisksHero.module.css';

const EYEBROW = 'Disclaimers';

const TITLE = 'Everything that can go wrong, in one place.';

const LEDE =
  'Every warning, limit and unresolved question on this site is on this page. The other seven pages describe mechanism. This one describes what that mechanism costs you when it does not go your way.';

/** The deployment paragraph. Opens with DEPLOYED_LINE, verbatim from pinned.ts. */
const DEPLOYMENT_PARAGRAPH = `${DEPLOYED_LINE} The address ledger is <code>contracts/config/deployments/robinhood-mainnet.json</code>, and the <a href="status.html">status page</a> reads it out.`;

const RWLY_PARAGRAPH =
  'The next iteration, RWLY, is designed to accrue the protocol&rsquo;s fees into official Robinhood Stock Tokens. RWLY does not exist yet, so there is nothing here to buy, claim or hold.';

const JURISDICTION_PARAGRAPH =
  'Interests in these vaults may be treated as securities or as collective investment scheme interests in some jurisdictions. Access from restricted jurisdictions is intended to be geofenced at the front end; that is a good-faith measure and not a guarantee, because the contracts are permissionless and can be called directly by anyone.';

const TOTAL_LOSS_PARAGRAPH =
  'Spot crypto assets fall. Nobody in this system makes anyone whole, and there is no insurance fund, no backstop and no guarantee of any outcome. Do not deposit anything you cannot afford to lose entirely.';

/**
 * Seconds. The brief specifies 0.6 for the deep-page hero enter, which sits
 * inside the 0.24-0.8 band easings.ts describes but is not one of its four
 * named durations, so it is written here rather than mis-mapped onto DUR.mid
 * (0.5) or DUR.slow (0.8). A named `DUR.enter` is a shell request, not a token
 * a section invents.
 */
const ENTER_SECONDS = 0.6;

export default function RisksHero(): JSX.Element {
  return (
    <section className={s.hero}>
      <div className="wrap">
        {/*
          THE RESTING STATE IS WHAT RENDERS. <Reveal> prerenders its children at
          their final position and full opacity and only then, in a layout
          effect, pushes them back to animate forward, so every sentence here
          is in dist/disclaimers.html whether or not anything scrolls, and a
          reader with reduced motion gets the finished page rather than an
          empty one.

          A hero is above the fold, and Reveal leaves anything already on screen
          exactly as it rendered. So on an ordinary load this paints at rest with
          no transition, which is what the LCP discipline wants anyway; the
          stagger is what a reader who arrives at a deep anchor and scrolls back
          up sees.
        */}
        <Reveal stagger={STAGGER.normal} duration={ENTER_SECONDS} rise={RISE_HERO_PX}>
          <p className={s.eyebrow}>{EYEBROW}</p>
          <h1 className={s.title}>{TITLE}</h1>
          <Pinned as="p" className={s.lede} html={LEDE} />
          <Pinned as="p" html={BANNER_OFFER} />
          <Pinned as="p" html={DEPLOYMENT_PARAGRAPH} />
          <Pinned as="p" className="footer-pins" html={FOOTER_TOKEN} />
          <Pinned as="p" html={RWLY_PARAGRAPH} />
          <Pinned as="p" className="footer-pins" html={FOOTER_LICENCE} />
          <Pinned as="p" html={JURISDICTION_PARAGRAPH} />
          <Pinned as="p" html={TOTAL_LOSS_PARAGRAPH} />
        </Reveal>
      </div>
    </section>
  );
}
