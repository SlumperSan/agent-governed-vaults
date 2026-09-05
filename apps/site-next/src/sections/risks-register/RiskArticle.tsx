/**
 * One entry of the register: a chip, a heading, and three labelled cells.
 *
 * ---------------------------------------------------------------------------
 * THE MARKUP IS THE CONTRACT HERE, MORE THAN ANYWHERE ELSE ON THE SITE
 * ---------------------------------------------------------------------------
 * Three shapes below look like ordinary JSX and are really regex literals in
 * `apps/site/test/site.test.mjs` written the other way round. Each has a blast
 * radius outside this directory, which is what makes them worth stating:
 *
 * 1. `<article class="risk" id="rN">` — matched by
 *    /<article class="risk" id="(r\d+)">/g, which closes on a literal `>`. The
 *    element may therefore carry `class` and `id`, in that order, and NOTHING
 *    else: no `aria-labelledby` pointing at the heading, no CSS-module class
 *    beside `risk`, no data attribute. React emits attributes in prop order,
 *    so the order is the order they are written below, and __probe.mjs asserts
 *    the emitted opening tag rather than trusting that.
 *      If one article stops matching, the parsed id count drops from fifteen
 *    and the failure surfaces two sections away, as risks-contents' heading
 *    check ("All fifteen.") going red.
 *
 * 2. `<dt>What is done</dt><dd>` — matched with NO attributes on either
 *    element and NO whitespace between them. So the cells are styled through
 *    parent selectors and never carry a class, and `<Pinned>` is called
 *    without `className` so it emits a bare tag. JSX drops the newline between
 *    two sibling elements, which is what produces the adjacency; a `{' '}` or
 *    a wrapper element between them would not.
 *
 * 3. NOTHING MAY PRECEDE THE WORD "Nothing" INSIDE A "What is done" CELL. The
 *    guard strips tags, trims, and counts the cells that START with it. Seven
 *    do. That seven is what risks-hero spells out as "Seven of these have no
 *    mitigation" and what who-its-for spells as "the seven where the honest
 *    answer is that nothing is done" — so a visually-hidden label, a lead-in
 *    span, or an icon carrying text inside one of those cells reds two other
 *    sections and names neither this file nor the person who edited it.
 *
 * ---------------------------------------------------------------------------
 * MOTION
 * ---------------------------------------------------------------------------
 * The chip and the heading fade in as one block, 0.4s, no rise and no stagger
 * inside an article. THE THREE CELLS DO NOT ANIMATE AT ALL. That is the
 * section's whole motion budget, and it is deliberate: nothing here scrubs,
 * pins or parallaxes, because a register of fifteen ways this hurts you that
 * performs on scroll is a register nobody believes. `Reveal` renders the
 * finished state on the server and on the client's first render and only then
 * animates from it, so the prerendered markup the guards read is the finished
 * page whether or not anything ever scrolls.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { Reveal } from '../../motion/Reveal';
import type { RiskEntry } from './entries';
import s from './RisksRegister.module.css';

/**
 * Seconds. The brief specifies 0.4 for this fade, which sits inside the
 * 0.24-0.8 band easings.ts describes but is not one of its four named
 * durations — so it is written here rather than mis-mapped onto DUR.fast
 * (0.24) or DUR.mid (0.5). A named token is a shell request, not a value a
 * section invents.
 */
const CHIP_AND_HEADING_SECONDS = 0.4;

export function RiskArticle({ entry }: { entry: RiskEntry }): JSX.Element {
  return (
    // class first, id second, nothing else. See note 1 above.
    <article className="risk" id={entry.id}>
      <Reveal className={s.head} duration={CHIP_AND_HEADING_SECONDS} rise={0}>
        {/*
          The chip carries the source's own global class string, `severity`,
          or `severity severity--accepted`, rather than a hashed module class,
          because the guard that keeps r5 honest looks for `severity--mitigated`
          in the page text between `id="r5"` and `id="r6"`. Keeping the class
          names the ones the reviewed page uses means that check reads the same
          bytes it always did. `severity--mitigated` is defined nowhere, in
          neither the data nor the stylesheet.
        */}
        <Pinned as="span" className={entry.severityClass} html={entry.severityLabel} />
        <Pinned as="h2" className={s.heading} html={entry.heading} />
      </Reveal>

      <dl className={s.rows}>
        {entry.rows.map((row) => (
          <div className={s.row} key={row.dt}>
            <Pinned as="dt" html={row.dt} />
            <Pinned as="dd" html={row.dd} />
          </div>
        ))}
      </dl>
    </article>
  );
}
