/**
 * who-decide — "Read the Disclaimers in full, then decide."
 *
 * Source passage: `apps/site/who-its-for.html`, the last `<section>` on the
 * page, whose eyebrow is "Before you decide" (grep for that phrase). Three
 * strings and three link labels, all carried byte-for-byte. Nothing here was
 * written for this build, nothing was tightened, and nothing was
 * re-punctuated. The strings below were extracted from that file
 * programmatically rather than retyped, because the one thing this section
 * cannot survive is a copy that looks right.
 *
 * WHAT THIS SECTION IS FOR. who-its-for spends earlier sections saying who the
 * design is wrong for, and then closes by refusing to be the last word: the
 * disclaimers page answers more than this page does, so the page hands the
 * reader to it. There is no field here, no control that submits, and nothing
 * that asks the reader for anything — the closing block of a page about
 * exclusions is precisely where a redesign reaches for a funnel, and this one
 * has none.
 *
 * THE SENTENCE THIS SECTION USED TO CARRY, AND WHY IT IS GONE. Earlier drafts
 * of this file carried a guard-derived count phrase — "including the seven
 * where the honest answer is that nothing is done" — computed from the number
 * of risks-register "What is done" cells opening with "Nothing". The corpus
 * dropped that clause outright: `LEDE` below ends at "what is actually done
 * about it" and never restates a count. That is deliberate rather than a
 * regression — this page does not own the risk register's entry count, and
 * repeating a number computed elsewhere is exactly the kind of restatement
 * that drifts the day the register changes. If a future edit needs that count
 * again, compute and state it on the page that owns the register, not here.
 *
 * The one number this section does still carry, `Fifteen`, is the register's
 * entry count, carried rather than restated. It is not a contract parameter,
 * so it is not cited to a contract line: there is no figure in this passage
 * that a contract could contradict.
 *
 * NO MOTION, AND THAT IS THE STRONGEST STATIC BRANCH RATHER THAN AN EXEMPTION.
 * The brief's motion line for this section is "None." — so there is no
 * `Reveal`, no effect, and no `useReducedMotion` call in this file. The
 * prerendered markup is the finished section for every reader, which makes the
 * reduced-motion state, the JavaScript-unavailable state and the ordinary
 * state one state. A closing block that performed under a sentence conceding
 * that another page is more useful than this one would be the design arguing
 * with the copy.
 *
 * WHY EVERY STRING GOES THROUGH <Pinned>. `renderToString` escapes text
 * children, so an apostrophe would reach `dist/who-its-for.html` as `&#x27;`
 * and a guard matching the raw file would fail on bytes that look perfect in
 * the browser. No string here needs an entity today; rendering them as HTML
 * source bytes anyway means none starts needing one silently on a later edit.
 *
 * OWNERSHIP. This file and its stylesheet are the whole of
 * `src/sections/who-decide/`. `wrap` is the shell's shared reading column,
 * used as-is; every other class is module-scoped. This section composes itself
 * into no page — `src/pages/WhoItsForPage.tsx` belongs to Integrate.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import s from './WhoDecide.module.css';

/** `apps/site/who-its-for.html`, `<p class="eyebrow">Before you decide</p>`. */
const EYEBROW = 'Before you decide';

/**
 * The closing heading, verbatim, terminal full stop included. It is an
 * instruction about how to read this site, not a claim about the contracts, so
 * there is no contract line to cite against it.
 */
const HEADING = 'Read the Disclaimers in full, then decide.';

/**
 * The one paragraph. No longer carries a guard-derived count — see the header
 * note above for why that clause was dropped rather than merely shortened.
 */
const LEDE =
  'Fifteen named risks, each with its worst case and what is actually done about it. That page is the most useful thing on this site.';

/**
 * The three ways out, in the order and with the labels
 * `apps/site/who-its-for.html` already carries. Labels are carried over, never
 * composed: the three phrases a closing block reaches for first — the begin
 * imperative, the registration verb and the wallet imperative — are banned
 * outright, and this is exactly the block a redesign puts one of them in.
 *
 * All three labels are held here rather than read from the shell's `CTA` map,
 * although `CTA.faq` is today the identical string. They are one list from one
 * source passage: splitting them across two files would let a later edit to
 * the shell-owned map diverge this section from the page it was carried from,
 * on a page whose closing sentence is a promise about where the reader is
 * being sent.
 *
 * The hrefs also do double duty as navigation pins. Every page must literally
 * contain `href="disclaimers.html"`, `href="faq.html"` and
 * `href="how-it-works.html"` among the eight; the masthead carries seven and
 * the footer carries all eight, and these three repeat exactly as the current
 * page repeats them. The `.html` suffix stays — the site suite matches on it,
 * and Pages already redirects the extension-less form.
 *
 * The primary label is "Disclaimers", not a shared `CTA.*` value — the shell's
 * `CTA` map (src/shell/pinned.ts) has no entry matching it, so it is inlined
 * here as page-local copy rather than forced into a near-synonym from that map.
 */
const ACTIONS: ReadonlyArray<{ href: string; label: string; primary?: boolean }> = [
  { href: 'disclaimers.html', label: 'Disclaimers', primary: true },
  { href: 'faq.html', label: 'The awkward questions' },
  { href: 'how-it-works.html', label: 'The mechanism in detail' },
];

/**
 * The heading's id, used to name the section landmark. A `<section>` with no
 * accessible name is a generic container rather than a landmark, and naming it
 * from the heading already on the page means the landmark carries no sentence
 * that was not reviewed.
 */
const HEADING_ID = 'before-you-decide';

export function WhoDecide(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <Pinned as="p" className={s.eyebrow} html={EYEBROW} />
        <Pinned as="h2" id={HEADING_ID} className={s.heading} html={HEADING} />
        <Pinned as="p" className={s.lede} html={LEDE} />

        <div className={s.actions}>
          {ACTIONS.map((a) => (
            <a
              key={a.href}
              className={a.primary ? `${s.action} ${s.actionPrimary}` : s.action}
              href={a.href}
            >
              {a.label}
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

export default WhoDecide;
