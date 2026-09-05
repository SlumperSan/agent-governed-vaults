/**
 * who-hero — the restrained deep-page hero of who-its-for.html, and that page's
 * one <h1>.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SECTION OWES THE PAGE
 * ---------------------------------------------------------------------------
 *   - the page's ONE <h1>. `PageShell` deliberately renders none, so until this
 *     is composed into src/pages/WhoItsForPage.tsx, dist/who-its-for.html fails
 *     the exactly-one-h1 check;
 *   - the eyebrow and the lede, in that order, above "The deal", which
 *     who-deal owns.
 *
 * The sentence this page is separately asserted to contain — "the seven where
 * the honest answer is that nothing is done", which apps/site/test/site.test.mjs
 * COMPUTES from the number of risks-register "What is done" cells opening with
 * "Nothing" — is not here. It lives in the closing "Before you decide" passage
 * and belongs to who-decide. Nothing in this hero is derived from anything, so
 * nothing in it can go stale when the register changes.
 *
 * ---------------------------------------------------------------------------
 * COPY PROVENANCE — ALL THREE LINES VERBATIM
 * ---------------------------------------------------------------------------
 * Every string below is the bytes of the `.hero--plain` block of
 * `apps/site/who-its-for.html`, extracted from that file rather than retyped.
 * Retyping is how a straight quote becomes a curly one, and that is not visible
 * in review:
 *
 *     <p class="eyebrow">Assumptions</p>
 *     <h1>What this design assumes about the people who use it.</h1>
 *     <p class="lede">It assumes self-custody on Robinhood Chain, by someone who has been
 *     rugged, paused or frozen out of a position before and now weighs "nobody
 *     can pause, upgrade or seize this" above almost everything else. Every
 *     trade-off on this site follows from that assumption. It is written down
 *     here so it can be checked against those trade-offs. It is not a test
 *     anyone passes.</p>
 *
 * Nothing was rewritten, tightened, re-punctuated or composed. No sentence on
 * this page originates here.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE LINE GOES THROUGH <Pinned> AND TWO DO NOT — CHECKED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * renderToString escapes five characters in text children: `&`, `<`, `>`, `"`
 * and `'`. The whole block was inspected byte by byte (`cat -A`, which would
 * have shown any multi-byte sequence as `M-…`): it is plain ASCII throughout.
 *
 *   - The eyebrow and the headline contain none of those five characters, so
 *     plain JSX children reach dist/who-its-for.html as the same bytes the
 *     current site publishes. A wrapper element for them would buy nothing.
 *   - The lede contains a straight double-quote pair around the member's own
 *     words — `weighs "nobody can pause, upgrade or seize this" above` — and
 *     React would emit each as `&quot;`. The sentence would look perfect in a
 *     browser and fail any `html.includes(…)` check against the raw file, which
 *     is the worst failure available here because the page is visibly correct.
 *     So it is held as HTML source bytes and rendered through <Pinned>, per the
 *     rule in src/shell/PinnedText.tsx.
 *
 * The asymmetry is therefore load-bearing rather than an oversight. If a later
 * edit puts an apostrophe, an ampersand or a curly quote into either of the
 * other two lines, that line moves to <Pinned> in the same edit.
 *
 * THE QUOTATION MARKS ARE THE POINT OF THE SENTENCE. They scope the clause to
 * something a reader is imagined to have said to themselves, rather than
 * stating it as a property of the system. Removing them, or promoting them to
 * curly quotes and losing the byte match, changes what the sentence claims.
 *
 * ---------------------------------------------------------------------------
 * NO CANVAS, AND THAT IS THE SPEC RATHER THAN A SHORTFALL
 * ---------------------------------------------------------------------------
 * The per-section instruction sheet carries a generic "use React Three Fiber,
 * one canvas" line that fits index-hero. Three narrower sources override it for
 * this page, and the two sibling deep-page heroes already resolved the same
 * conflict the same way:
 *   - the build brief's IA gives index.html "one WebGL hero" and calls it "the
 *     only page carrying a canvas", handing the six deep pages "a restrained
 *     typographic hero (no canvas, no pin, no parallax)";
 *   - this section's own motion line reads "Text enter only";
 *   - the design system says "R3F for the hero and nothing else. One canvas."
 *
 * Both reasons bite if it is ignored. A field on the page that states what the
 * design assumes about a reader would be depicting vault state this page never
 * reads — invented rather than fetched — which is a claims violation wearing a
 * design decision's clothes. And the six deep pages must not carry the hero
 * chunk's weight against an initial budget of 180 KB gzip of which React is
 * already 60.6 KB. Nothing on this page is illustrative data, so there is
 * nothing here to label as such.
 *
 * ---------------------------------------------------------------------------
 * NO NUMBERS
 * ---------------------------------------------------------------------------
 * This section states no figure, so there is no value to cite to a contract
 * line. Every quantity on who-its-for.html — the planned 50,000 USDG capacity
 * cap, the 250,000 USDG second vault, the 30 incident-free days — is stated
 * further down the page and belongs to who-not-for and who-cap.
 *
 * ---------------------------------------------------------------------------
 * MOTION
 * ---------------------------------------------------------------------------
 * Opacity and an eight-pixel rise, 0.6s on the shared enter curve, staggered
 * 80ms — expressed entirely in WhoHero.module.css. Deliberately not <Reveal>:
 * src/motion/Reveal.tsx returns early for any element already inside the
 * viewport (`if (isOnScreen(el)) return;`), and a hero is above the fold by
 * definition, so the shared primitive is structurally a no-op here and the
 * enter this section is specified to have would never run. faq-hero reached the
 * same conclusion and is built the same way; risks-hero uses <Reveal> and
 * accepts painting at rest. A reviewer sweeping the three should read the split
 * as two answers to one question, not as a stray. The stylesheet header records
 * why CSS is the right tool and how the reduced-motion branch is authored
 * rather than inherited.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import s from './WhoHero.module.css';

const EYEBROW = 'Assumptions';

const TITLE = 'What this design assumes about the people who use it.';

/**
 * HTML source bytes, not text. See the escaping note above: the two straight
 * double-quotes are why this constant exists in this form.
 */
const LEDE =
  'It assumes self-custody on Robinhood Chain, by someone who has been rugged, paused or frozen out of a position before and now weighs "nobody can pause, upgrade or seize this" above almost everything else. Every trade-off on this site follows from that assumption. It is written down here so it can be checked against those trade-offs. It is not a test anyone passes.';

export function WhoHero(): JSX.Element {
  return (
    // A <div>, not a <section>: this is the page's header rather than a titled
    // region, it is the shape the source markup already uses, and an unlabelled
    // <section> would add a landmark that announces nothing to a screen-reader
    // user moving by region.
    <div className={s.hero}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h1 className={s.title}>{TITLE}</h1>
        <Pinned as="p" className={s.lede} html={LEDE} />
      </div>
    </div>
  );
}

export default WhoHero;
