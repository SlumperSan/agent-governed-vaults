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
 * the total-loss paragraph. FOOTER_LICENCE is imported from pinned.ts rather
 * than retyped, for the byte-identity reason that file's header gives.
 *
 * THE NO-TOKEN SENTENCE IS GONE FROM THIS FILE, 2026-09-05. This hero rendered
 * FOOTER_TOKEN, which opened `No token.`, and that clause stopped being true
 * when RWLY was created that evening. The constant is retired in pinned.ts, its
 * per-page count in `test/site.test.mjs` is zero everywhere, and what stands in
 * its place is the four-paragraph token block below. One consequence is worth
 * stating because it constrains the replacement copy rather than merely
 * recording it: with that sentence gone from the build there is no exemption
 * left anywhere on this site for the two negated words it carried, so the new
 * paragraphs say what the launch was not without reaching for either of them.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { Reveal } from '../../motion/Reveal';
import { RISE_HERO_PX, STAGGER } from '../../motion/easings';
import { BANNER_OFFER, DEPLOYED_LINE, FOOTER_LICENCE } from '../../shell/pinned';
import s from './RisksHero.module.css';

const EYEBROW = 'Disclaimers';

const TITLE = 'Everything that can go wrong, in one place.';

/**
 * CORRECTED 2026-09-05: the count read "The other seven pages". The site has
 * nine pages, so excluding this one there are eight; the seven was stale from
 * before vision.html was added. `apps/site/disclaimers.html:51` says eight,
 * risks-scope-additions says eight in its own heading on this same page, and
 * this sentence disagreed with both.
 */
const LEDE =
  'Every warning, limit and unresolved question on this site is on this page. The rest of this site describes mechanism. This one describes what that mechanism costs you when it does not go your way.';

/** The deployment paragraph. Opens with DEPLOYED_LINE, verbatim from pinned.ts. */
const DEPLOYMENT_PARAGRAPH = `${DEPLOYED_LINE} The address ledger is <code>contracts/config/deployments/robinhood-mainnet.json</code>, and the <a href="index.html#live">live reads</a> on the homepage fetch the factory's own answers from the chain in your browser.`;

/* ---------------------------------------------------------------------------
 * THE TOKEN BLOCK, WHICH REPLACED THE NO-TOKEN BLOCK ON 2026-09-05.
 *
 * WHAT WENT, AND WHY IT COULD NOT BE KEPT. This hero carried two sentences
 * here: `No token. No points. No airdrop. No presale.` (FOOTER_TOKEN in
 * `src/shell/pinned.ts`) and `The next iteration, RWLY, is designed to accrue
 * the protocol's fees into official Robinhood Stock Tokens. RWLY does not exist
 * yet, so there is nothing here to buy, claim or hold.` Both were
 * corpus-verbatim. RWLY was created at 2026-09-05T21:51:57Z, which is the
 * timestamp of its creation block, so the first sentence opens on a false
 * clause and the second closes on one. A sentence being pinned is a reason not
 * to reword it for rhythm; it is not a reason to keep publishing it after the
 * fact underneath it has changed.
 *
 * WHAT REPLACED IT is four paragraphs, and the order is the argument:
 *
 *   1. WHAT IT IS. The address first, because it is the only thing here a
 *      reader can check without believing anything else on this page.
 *   2. HOW IT TRADES. The curve's fee terms, where the creator fee rights sit,
 *      and the shape of the instrument, because a bonding curve is not an order
 *      book and a reader who thinks it is will misprice their own exit.
 *   3. WHAT THE DEPLOYER TOOK. This paragraph is the reason the block exists in
 *      this order rather than in the flattering one. The transaction is public
 *      and the arithmetic is four lines, so the only question was whether this
 *      site said it first.
 *   4. WHAT IS STILL ONLY DESIGNED, which is everything the vision rests on.
 *
 * EVERY FIGURE IS AN ON-CHAIN READ from `rwly-flip-facts.md` and its companion
 * `rwly-robinhood-mainnet.json`, which carry the reproduction commands. The
 * negatives in paragraph 1 rest on call probes with positive controls rather
 * than on a bytecode scan, and `no upgrade path` rests on the runtime carrying
 * zero DELEGATECALL and zero CALLCODE opcodes, which is a stronger fact than
 * any absence of function names.
 *
 * NUMBERS THAT MOVE ARE NOT HERE. The curve shifted roughly 45% of supply in
 * the two minutes after launch, so no holder count, no price, no market
 * capitalisation and no unsold-supply share appears in this block. The 7.3% in
 * paragraph 3 is the launch-transaction amount, a historical fact; the
 * paragraph narrates where the position went afterward.
 * ------------------------------------------------------------------------ */

const TOKEN_LIVE_PARAGRAPH =
  'RWLY is live on Robinhood Chain at <code>0x2eed8ae78AE1aa6824e1C378F46d5C51b6B7FDF9</code>: an ERC-20 named RWAlly, with a fixed supply of 1,000,000,000, no owner, no mint function, no pause and no upgrade path. Any holder can destroy their own tokens, and nobody can destroy anyone else&rsquo;s beyond an allowance. It was launched on 2026-09-05 on Pons, a third-party launchpad this project did not write, and it launched on a bonding curve at <code>0x0032fEc43109AD0F24bbaae9A92562DC96ba2BB5</code> quoted in native ETH rather than in a stock token; the curve graduated the same day.';

const CURVE_PARAGRAPH =
  'The curve charges 100 basis points plus an 8 basis point creator tax on every trade into it. Pons takes 30% of the base fee; the rest, together with the whole creator tax, is the creator side, and the creator fee rights on this launch belong to a multisig this project controls at <code>0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c</code>. The launch graduates into a permanently locked Uniswap v4 position once the curve raises 4.2 ETH, and this curve did so on 2026-09-05, locking 81,632,653 RWLY, about 8.2% of the fixed supply, with the launchpad and retiring the curve as a venue. A bonding curve is a formula and not a market maker of last resort: a large sale moves the price against you and there is no floor under it.';

const CREATOR_POSITION_PARAGRAPH =
  'In the launch transaction the protocol&rsquo;s own deployer address took 72,978,672 RWLY, about 7.3% of the fixed supply, for 0.1337 ETH at the curve&rsquo;s opening price. The whole position later moved to the project&rsquo;s multisig, which placed part of it as liquidity in Uniswap v4 pools and holds the rest. It paid no snipe tax, because the launchpad exempts the creator automatically while every other address in that block faced a tax decaying from 99% over three seconds. Nothing was minted aside from the one fixed supply and nothing was reserved before trading opened, and both halves of that belong together rather than only the flattering one.';

const RWLY_PARAGRAPH =
  'RWLY is designed to accrue the protocol&rsquo;s fees into official Robinhood Stock Tokens, and that mechanism is design intent rather than code: no contract this protocol deployed references RWLY, there is no staking contract, no stRWLY, no epoch and no reward accrual on chain, and none of it can be pointed at the token without a new deployment.';

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
          <Pinned as="p" className="standing-fact" html={TOKEN_LIVE_PARAGRAPH} />
          <Pinned as="p" html={CURVE_PARAGRAPH} />
          <Pinned as="p" html={CREATOR_POSITION_PARAGRAPH} />
          <Pinned as="p" html={RWLY_PARAGRAPH} />
          <Pinned as="p" className="standing-fact" html={FOOTER_LICENCE} />
          <Pinned as="p" html={JURISDICTION_PARAGRAPH} />
          <Pinned as="p" html={TOTAL_LOSS_PARAGRAPH} />
        </Reveal>
      </div>
    </section>
  );
}
