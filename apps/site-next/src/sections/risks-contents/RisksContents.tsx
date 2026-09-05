/**
 * risks-contents — the jump list at the top of risks.html.
 *
 * WHAT THIS SECTION OWES THE PAGE. Two things, and both are read by
 * `apps/site/test/site.test.mjs`, test "every named risk has an anchor and a
 * contents entry, including r15":
 *
 *   1. THE HEADING IS COMPUTED, NOT CHOSEN. The guard collects every
 *      `<article class="risk" id="rN">` on the built page, takes the count,
 *      spells it as an English word out of its own NUMBER_WORDS table and then
 *      asserts `html.includes(\`All ${word}.\`)`. Fifteen articles today, so
 *      the heading is `All fifteen.` — LOWERCASE f. Unlike the hero's lede
 *      guard, this one applies no `charAt(0).toUpperCase()`, so title-casing
 *      the word reds the page. If risks-register ever gains or loses an
 *      article, this heading moves with it or the gate goes red here.
 *
 *   2. EVERY ARTICLE ID NEEDS AN ENTRY. The same test loops the parsed ids and
 *      asserts `html.includes(\`href="#${id}"\`)` for each, with `r15` called
 *      out by name because it was the entry that had previously been added to
 *      the register without a contents line. The fifteen hrefs below are that
 *      obligation; they are only satisfied once risks-register renders on the
 *      same page, because the guard reads the whole built file.
 *
 * NO MOTION HERE, AND THAT IS THE SPEC. The build brief's motion line for this
 * section is "None. It is a table of contents." So there is no `Reveal`, no
 * scroll trigger and no enter animation: a reader who has just been told that
 * seven of these have no mitigation should not have to wait for the index of
 * them to fade in. The only movement on this section is the hover and focus
 * transition on a row, and `index.css` already zeroes that under
 * `prefers-reduced-motion: reduce` — that global block is the static branch,
 * rather than a second one written here that could drift from it.
 *
 * NO STICKY RAIL EITHER. The brief permits a sticky desktop variant "only if it
 * renders in the prerendered markup at its resting position", and two facts
 * make it the wrong call regardless: `index.css` sets `overflow-x: hidden` on
 * `body` — which breaks `position: sticky` measured against the viewport for
 * every descendant, as the note in that file says — and a rail that tracked the
 * register would need layout spanning two sections, which is not this
 * directory's to own. The masthead is `position: relative`, not sticky, so a
 * jump link lands on its target heading with nothing overlapping it.
 *
 * NUMBERS. There is no contract-derived figure on this section, so there is no
 * `file:line` citation to give. The ordinals 1-15 are the register's ordering
 * and the word "fifteen" is derived by the guard from the register's article
 * count; both are pinned to risks-register's markup rather than to a contract.
 *
 * COPY PROVENANCE. The eyebrow, the heading, all fifteen entry strings and the
 * closing paragraph are lifted byte-for-byte from the `Contents` section of
 * `apps/site/disclaimers.html` (risks.html's replacement). Nothing was
 * rewritten, renumbered, re-punctuated or shortened, and nothing new was
 * written.
 *
 * THE CLOSING PARAGRAPH MOVED HERE FROM risks-hero ON 2026-09-05. It used to
 * be the old risks.html hero's lede ("Seven of these have no mitigation...");
 * the corpus disclaimers.html keeps the same derived sentence but places it
 * as a `<p class="tight">` immediately after this section's jump list instead
 * of in the hero, and drops "risk" from "a risk page that only lists solved
 * problems" (now "a page that only lists..."). Same derivation as the heading
 * above: `apps/site/test/site.test.mjs`, test "the Disclaimers page states the
 * true number of unmitigated risks", counts `<dt>What is done</dt><dd>…</dd>`
 * cells starting with "Nothing" and asserts `"<Word> of these have no
 * mitigation"` is present. Seven today — r1, r2, r4, r6, r8, r10 and r15.
 */
import type { JSX } from 'react';
import s from './RisksContents.module.css';

/** Verbatim from apps/site/risks.html: `<p class="eyebrow">Contents</p>`. */
const EYEBROW = 'Contents';

/**
 * Verbatim from apps/site/risks.html: `<h2>All fifteen.</h2>`.
 *
 * Held as a constant so the one string the guard computes is greppable in one
 * place. See note 1 in the file header before editing it: the lowercase "f" is
 * what the assertion builds, not a style choice.
 */
const HEADING = 'All fifteen.';

/**
 * The fifteen `<li><a href="#rN">` entries, verbatim, in source order.
 *
 * `id` is the anchor fragment and must match risks-register's
 * `<article class="risk" id="rN">` exactly; `text` is the anchor's whole text
 * node, ordinal included. The ordinal is NOT split out of the string into its
 * own element, however much a designer would like to set it in mono: the copy
 * rule is byte-identical carriage, and a `<span>` around "1." changes the bytes
 * of a line whose bytes the copy rule pins. `font-variant-numeric:
 * tabular-nums` on the whole row gets the same alignment without touching them.
 *
 * None of the fifteen contains a character React escapes — no apostrophe, no
 * ampersand, no angle bracket, no quote — so plain JSX text children render the
 * source bytes exactly and `<Pinned>` is unnecessary here. The verify runner
 * asserts both halves of that: each string present verbatim in the rendered
 * markup, and no HTML entity anywhere in the output. An edit that introduces an
 * apostrophe therefore fails loudly instead of silently emitting `&#x27;`.
 */
/**
 * The derived sentence, moved here from risks-hero — see the file comment.
 * None of its characters are React-escaped, so a plain text child renders the
 * source bytes exactly.
 */
const UNMITIGATED_NOTE =
  'Seven of these have no mitigation and are simply accepted. They are marked as accepted rather than buried, because a page that only lists solved problems is a marketing page wearing a warning label.';

const ENTRIES: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'r1', text: '1. Immutability itself' },
  { id: 'r2', text: '2. Oracle freeze traps exits' },
  { id: 'r3', text: '3. A single price provider' },
  { id: 'r4', text: '4. USDG is pinned at $1.00' },
  { id: 'r5', text: '5. Sequencer downtime' },
  { id: 'r6', text: '6. Forward-settled exits are irrevocable' },
  { id: 'r7', text: '7. Governance capture and thin electorates' },
  { id: 'r8', text: '8. The rules can freeze permanently' },
  { id: 'r9', text: '9. Operator identity cannot be rotated' },
  { id: 'r10', text: '10. Total loss is possible' },
  { id: 'r11', text: '11. Securities and scheme recharacterization' },
  { id: 'r12', text: '12. The reference agent is beta code' },
  { id: 'r13', text: '13. An open licensing question' },
  { id: 'r14', text: '14. This is experimental software' },
  { id: 'r15', text: '15. There is no oracle rotation path' },
];

/**
 * The heading's id, used by `aria-labelledby` so the landmark announces itself
 * as "All fifteen." rather than as an unnamed region. It is an attribute value
 * and a heading id, not published prose, and it disturbs no `includes` check —
 * the guard matches the heading's text, which is untouched.
 */
const HEADING_ID = 'risks-contents-heading';

export default function RisksContents(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id={HEADING_ID} className={s.heading}>
          {HEADING}
        </h2>
        {/*
          NOT conditionally rendered, and not collapsible. The build prerenders
          and the guards read the prerendered file, so every one of these
          fifteen hrefs has to be in dist/risks.html whether or not anything has
          scrolled, been clicked or been hydrated. That rules out an
          IntersectionObserver, a React-state disclosure and a virtualised list;
          a `<details>` would be legal only left open, and fifteen short lines
          do not need one.
        */}
        <ul className={s.list}>
          {ENTRIES.map((entry) => (
            <li key={entry.id} className={s.item}>
              <a className={s.link} href={`#${entry.id}`}>
                {entry.text}
              </a>
            </li>
          ))}
        </ul>

        <p className={s.tight}>{UNMITIGATED_NOTE}</p>
      </div>
    </section>
  );
}
