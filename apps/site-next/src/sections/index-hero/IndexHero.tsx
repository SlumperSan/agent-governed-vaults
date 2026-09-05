/**
 * index-hero — the page's one <h1>, the hero field, and the three-fact strip.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE COPY CAME FROM
 * ---------------------------------------------------------------------------
 * The eyebrow, the h1, the lede (now two paragraphs, matching the corpus) and
 * the three action labels are lifted byte-for-byte from the `.hero` block of
 * `apps/site/index.html` as of the 2026-09-05 owner copy deck (commit
 * 3a3e3eaf). Nothing here was rewritten, tightened or re-punctuated. The
 * funnel verbs a redesign reaches for first are banned outright by the claims
 * suite, a hero is exactly where someone reaches for one, and matching the
 * labels the current site already uses is what makes that unable to happen by
 * accident. The banned list is in the guard; it is not repeated here, because
 * the day this file is one of the surfaces the guard walks, a comment quoting
 * it reds the gate exactly as prose would.
 *
 * One string on this page is NOT on the current corpus site, and it is
 * permitted by the build brief as an adaptation rather than as a new claim:
 *   - the field's `Illustrative.` caption, which does for the canvas what the
 *     reference-configuration table's "a worked example" does for its numbers.
 * The three fact-strip lines (see FactStrip.tsx) are likewise an addition with
 * no corpus counterpart, each a shortened form of a sentence that IS on this
 * site or in its footer, kept in sync with those sources as they change.
 * Everything else a reader sees here already exists in the reviewed source.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TEXT IS PLAIN JSX AND NOT <Pinned>
 * ---------------------------------------------------------------------------
 * `renderToString` escapes `'`, `&`, `<`, `>` and `"` in text children, and a
 * guard checking `html.includes(SENTENCE)` fails on an escaped apostrophe that
 * looks perfect in the browser. EYEBROW carries a literal `&middot;` entity
 * and LEDE_CLOSE carries the corpus's typographic apostrophe (’, U+2019, from
 * the source `&rsquo;`) in "the protocol's fees" plus an inline `<a>` — both
 * are rendered through `<Pinned html={…}>` rather than as text children. LEDE
 * itself contains none of the five React-escaped characters, so it is a plain
 * text child. Add a sentence carrying an apostrophe, ampersand, angle bracket
 * or an entity and it must move to `<Pinned html={…}>` instead.
 *
 * ---------------------------------------------------------------------------
 * THE MOTION BEHIND THE HEADLINE IS THE BRAND'S OWN CLIP
 * ---------------------------------------------------------------------------
 * Owner decision, 2026-09-05: keep the strict CSP, put the brand's autoplaying
 * loop in the hero, and drop the scroll-scrub journey for good. The last of
 * those is not a deferral. The Higgsfield prototype's own audit records why —
 * a scroll-scrubbed film needs about 21 KB of JavaScript, Blob URLs, video
 * decode and `media-src blob:`, and under `default-src 'none'` it cannot exist
 * — so the choice was between relaxing the policy this site's main claim about
 * itself rests on and shipping a plain looping clip. The clip won.
 *
 * WHAT THAT REPLACED, recorded because it was a large thing to remove. Until
 * this change the hero drew a WebGL particle field: a lazily imported
 * `hero3d/HeroCanvas` behind an error boundary, mounted only past 52rem and
 * only after `requestIdleCallback`, with a 96-degree gradient scrim whose
 * coverage arithmetic ran to some four hundred lines of this section's
 * stylesheet and had been re-measured three times. The clip is 301,702 B
 * against that chunk's 894,420 B, it needs no boundary because a `<video>` that
 * fails to load leaves its poster on screen, and the contrast floor behind the
 * copy is the one bound in `src/assets/backdrop.module.css` — which holds for
 * any picture, moving or still, rather than for one field's behaviour.
 *
 * `MotionBackdrop` renders the poster in the server markup and adds the
 * `<video>` after hydration, and only for a reader who has not asked for
 * reduced motion; that reader never downloads the clip at all. See
 * `src/assets/Backdrop.tsx` for why it is written that way rather than as a
 * media query.
 *
 * The caption below is rendered text in the prerendered markup, outside the
 * backdrop entirely, so a reader who never sees the clip — no JavaScript, a
 * text browser, reduced motion — still reads what the picture would otherwise
 * be claiming, and so does a guard.
 *
 * ---------------------------------------------------------------------------
 * MOTION
 * ---------------------------------------------------------------------------
 * The enter animation is CSS, declared in IndexHero.module.css and running
 * without JavaScript. `src/motion/Reveal.tsx` cannot do this job: it skips any
 * element already on screen at load, deliberately, and every element in a hero
 * is. Doing it in CSS also removes the flash that a JS-driven hero enter has by
 * construction — the animation library arrives in a later chunk, and hiding
 * above-fold copy until it lands blanks the top of the page for however long
 * the network takes.
 */
import type { JSX } from 'react';
import { MotionBackdrop } from '../../assets/Backdrop';
import { CTA, REPO_URL } from '../../shell/pinned';
import { Pinned } from '../../shell/PinnedText';
import { FactStrip } from './FactStrip';
import s from './IndexHero.module.css';


/* --- copy, verbatim from apps/site/index.html .hero ------------------------
 * The corpus splits the lede into TWO <p class="lede"> paragraphs; LEDE and
 * LEDE_CLOSE below are exactly that split, not a stylistic choice. The second
 * paragraph carries an inline link, so it is rendered through <Pinned> rather
 * than as a text child. */

const EYEBROW = 'Robinhood Chain mainnet &middot; chain id 4663';

const HEADLINE = 'What you read is what runs.';

const LEDE =
  'Rwally is the AI agent trading index on Robinhood Chain. Members deposit USDG into a shared vault holding a spot basket of ETH and BTC. An agent-operator proposes each rebalance. Members ratify it by commit-reveal vote, on-chain, before anything executes. The contracts carry no proxy, no upgrade path, no pause function and no admin key.';

const LEDE_CLOSE =
  'The next iteration, RWLY, is designed to accrue the protocol&rsquo;s fees into official Robinhood Stock Tokens. RWLY does not exist yet. <a href="disclaimers.html">Read the Disclaimers.</a>';

/* --- the field caption ---------------------------------------------------- */

/**
 * Rendered text, never a code comment. The graphic behind the headline could be
 * read as a holding by someone who did not read the lede, and it is not one:
 * the field carries no weights, no balances, no prices and no member count.
 * This sentence is the same move the reference-configuration table makes when
 * it calls itself a worked example.
 *
 * SCOPED TO THE VAULT, NOT TO THE PROTOCOL. The protocol is on Robinhood Chain
 * mainnet (see status.html); what does not exist is a VAULT — `no vault has
 * been created yet: factory.vaultCount() returns 0`, per
 * `contracts/config/deployments/robinhood-mainnet.json`. An unscoped "nothing
 * is deployed to mainnet" would be false now that the factory is live; this
 * caption says only what is still true.
 */
const FIELD_CAPTION = 'Illustrative. It shows the lifecycle, not a holding — no vault has been created yet.';

export default function IndexHero(): JSX.Element {
  return (
    <section className={s.hero} aria-labelledby="hero-headline">
      <MotionBackdrop />

      <div className={`wrap ${s.inner}`}>
        <Pinned as="p" className={s.eyebrow} html={EYEBROW} />
        <h1 className={s.headline} id="hero-headline">
          {HEADLINE}
        </h1>
        <p className={s.lede}>{LEDE}</p>
        <Pinned as="p" className={s.lede} html={LEDE_CLOSE} />

        <div className={s.actions}>
          <a className={`${s.btn} ${s.btnLead}`} href="how-it-works.html">
            {CTA.howItWorks}
          </a>
          <a className={s.btn} href="status.html">
            {CTA.record}
          </a>
          <a className={s.btn} href={REPO_URL}>
            {CTA.source}
          </a>
        </div>

        <p className={s.caption}>{FIELD_CAPTION}</p>

        <FactStrip />
      </div>
    </section>
  );
}
