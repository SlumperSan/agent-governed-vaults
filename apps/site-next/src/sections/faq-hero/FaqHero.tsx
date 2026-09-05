/**
 * faq-hero — the restrained deep-page hero of faq.html, and that page's one <h1>.
 *
 * WHAT THIS SECTION OWES THE PAGE
 *   - the page's ONE <h1>. `PageShell` renders none, so until this is composed
 *     into src/pages/FaqPage.tsx, dist/faq.html fails the exactly-one-h1 check;
 *   - the eyebrow and the lede, in that order, above the seventeen question
 *     articles that faq-questions owns.
 *
 * COPY PROVENANCE. All three strings are lifted byte-for-byte from the
 * `.hero--plain` block of apps/site/faq.html:
 *
 *     <p class="eyebrow">Questions</p>
 *     <h1>The questions people ask when they have been burned before.</h1>
 *     <p class="lede">Answered the way they were asked. Where the answer is no, it says no.</p>
 *
 * Nothing was rewritten, re-punctuated, shortened or composed. No sentence on
 * this page originates here.
 *
 * NO ESCAPING HAZARD, CHECKED RATHER THAN ASSUMED. renderToString escapes `'`,
 * `&`, `<`, `>` and `"` in text children, which is why pinned prose elsewhere
 * goes through <Pinned>. The source block was inspected byte by byte (`cat -A`,
 * and an `od -c` sweep for multi-byte sequences): it is plain ASCII and none of
 * those five characters appears in it, so plain JSX children reach
 * dist/faq.html as the same bytes the current site publishes. A reviewer
 * sweeping sibling heroes should not read the absence of <Pinned> here as an
 * oversight — it would add an element wrapper for nothing. If a future edit
 * introduces an apostrophe, a curly quote or an ampersand into any of these
 * three lines, that line moves to <Pinned> in the same edit.
 *
 * NO CANVAS, AND THAT IS THE SPEC RATHER THAN A SHORTFALL. The per-section
 * instruction sheet carries a generic "use React Three Fiber, one canvas" line
 * that fits index-hero; three narrower sources override it for this page. The
 * build brief's IA gives index.html "one WebGL hero" and calls it "the only
 * page carrying a canvas", handing the six deep pages "a restrained
 * typographic hero (no canvas, no pin, no parallax)". This section's own motion
 * line reads "Text enter only". The design system says "R3F for the hero and
 * nothing else. One canvas." Both reasons bite if it is ignored: a field on a
 * page about what the protocol cannot do would depict vault state that does not
 * exist, which is a claims violation wearing a design decision's clothes; and
 * the six deep pages must not carry the hero chunk's weight, against an initial
 * budget of 180 KB gzip of which React is already 60.6 KB. Nothing on this page
 * is illustrative data, so there is nothing here to label as such.
 *
 * NO NUMBERS. This section states no figure, so there is no value to cite to a
 * contract line. Every quantity on faq.html is stated inside an answer body and
 * belongs to faq-questions.
 *
 * MOTION. Opacity and an eight-pixel rise, 0.6s on the shared enter curve,
 * staggered 80ms — expressed entirely in FaqHero.module.css. Deliberately not
 * <Reveal>: src/motion/Reveal.tsx returns early for any element already inside
 * the viewport (`if (isOnScreen(el)) return;`, line 95), and a hero is above
 * the fold by definition, so the primitive is structurally a no-op here and the
 * specified enter would never run. The stylesheet header records why CSS is the
 * right tool and how the reduced-motion branch is authored rather than
 * inherited.
 */
import type { JSX } from 'react';
import s from './FaqHero.module.css';

export function FaqHero(): JSX.Element {
  return (
    // A <div>, not a <section>: this is the page's header rather than a
    // titled region, and an unlabelled <section> would add a landmark that
    // announces nothing to a screen-reader user moving by region.
    <div className={s.hero}>
      <div className="wrap">
        <p className={s.eyebrow}>Questions</p>
        <h1 className={s.title}>The questions people ask when they have been burned before.</h1>
        <p className={s.lede}>
          Answered the way they were asked. Where the answer is no, it says no.
        </p>
      </div>
    </div>
  );
}

export default FaqHero;
