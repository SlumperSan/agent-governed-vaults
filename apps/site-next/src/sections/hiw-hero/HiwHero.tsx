/**
 * hiw-hero — the hero of how-it-works.html, and that page's one <h1>.
 *
 * THE CLAUSE THAT MUST STAY WHOLE. The noun this clause turns on is banned
 * outright by apps/site/test/site.test.mjs, with a short list of exact clauses
 * stripped before the ban runs. The lede's closing clause —
 *
 *     treating a parameter as a guarantee is how people get hurt
 *
 * — is one of them, and every entry on that list is separately asserted to be
 * in actual use somewhere on the site, so this hero owes it. It has to reach
 * dist/how-it-works.html as one unbroken run of text: a <span> inserted for
 * typographic effect, a line break element, or any shortening leaves that noun
 * standing alone, where the exemption no longer covers it, and the failure
 * message points at the exemption list rather than at the edit that caused it.
 *
 * NO ESCAPING HAZARD, DELIBERATELY CHECKED. renderToString escapes `'`, `&`,
 * `<`, `>` and `"` in text children, which is why pinned prose elsewhere goes
 * through <Pinned>. None of those five characters appears in any of these three
 * strings, so plain JSX children are byte-identical to the source and <Pinned>
 * would add an element wrapper for nothing. A reviewer sweeping sibling heroes
 * should not read its absence here as an oversight.
 *
 * NO NUMBERS. This section states no figure, so there is no value to cite to a
 * contract line. The parameters this page describes are quantified in
 * hiw-reference-config, against contracts/config/robinhood-mainnet.json.
 *
 * NO CANVAS. Deep-page heroes are text only — no canvas, no pin, no parallax.
 * The one canvas and the one scroll timeline on the site both belong to
 * index.html; a WebGL chunk mounted here would be paid for on a page whose
 * whole job is to be read.
 *
 * MOTION. Opacity and an eight-pixel rise, 0.6s on the shared enter curve,
 * staggered 80ms, expressed entirely in HiwHero.module.css. Not <Reveal>: that
 * primitive returns early for anything already on screen, which a hero always
 * is. See the stylesheet header for why that early return is correct and why it
 * makes CSS the right tool here.
 */
import type { JSX } from 'react';
import { Backdrop } from '../../assets/Backdrop';
import s from './HiwHero.module.css';

export function HiwHero(): JSX.Element {
  return (
    <div className={s.hero}>
      <Backdrop slot="howItWorks" />
      <div className="wrap">
        <p className={s.eyebrow}>Mechanism</p>
        <h1 className={s.title}>Deposit, observe, propose, commit, reveal, wait, execute.</h1>
        <p className={s.lede}>
          Every rule below is either a protocol invariant, true of every vault ever created, or a
          per-vault parameter chosen at creation and frozen at funding. The two are labelled
          separately on this page, because treating a parameter as a guarantee is how people get
          hurt.
        </p>
      </div>
    </div>
  );
}

export default HiwHero;
