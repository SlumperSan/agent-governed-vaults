/**
 * index-losses — "Three ways this loses your money."
 *
 * NO LONGER ON index.html IN THE CORPUS, as of the 2026-09-05 copy deck. The
 * "Before you read anything else" section this was ported from is gone from
 * `apps/site/index.html` entirely; the page now closes its Immutability
 * section straight into "The record" (see index-status). This section has no
 * corpus counterpart on index.html any more and is kept as a redesign-only
 * addition rather than removed, per the build brief for unpaired content. Its
 * individual sentences are not invented, though: `PERMANENT_BUG` in `./copy.ts`
 * is still byte-identical to disclaimers.html's r1 entry (grep `Nothing can be
 * patched`), and `ORACLE_FREEZE`/`USDC_DEPEG` are longer standing variants of
 * the condensed forms disclaimers.html now carries in the same risk entry —
 * checked for staleness against that page rather than left to drift.
 *
 * NOTHING HERE IS CONDITIONALLY RENDERED. Every sentence is in the prerendered
 * markup at its resting position, which is what the claims guards read, and it
 * is also what a reader sees before any script arrives. The section's one
 * animation is a 0.4s opacity fade added afterwards by `<Reveal>`; with
 * reduced motion, or if the motion chunk never lands, the resting state IS the
 * finished state and nothing has to be undone.
 *
 * NO STAGGER AND NO RISE, deliberately — see the stylesheet. A staggered
 * entrance would reveal the three mechanisms one at a time, which is a
 * dramatic device applied to a disclosure.
 *
 * THIS SECTION WRITES NO PROSE OF ITS OWN. The only string here that is not on
 * the current site is the heading's `id`, which exists so the landmark is
 * labelled by its own heading rather than by a written label.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { CTA } from '../../shell/pinned';
import { Reveal } from '../../motion/Reveal';
import { ORACLE_FREEZE, PERMANENT_BUG, TOTAL_LOSS, USDC_DEPEG } from './copy';
import s from './IndexLosses.module.css';

/** The landmark is labelled by its own heading; no label is written for it. */
const HEADING_ID = 'index-losses';

/**
 * Seconds. The build brief pins this section at 0.4 — below `DUR.mid` and
 * above `DUR.fast`, so it is stated here rather than taken from the shared
 * scale, and stated once.
 */
const FADE_SECONDS = 0.4;

/** The three mechanisms, in the order the reviewed page carries them. */
const MECHANISMS: ReadonlyArray<{ label: string; body: string }> = [
  { label: 'A permanent bug', body: PERMANENT_BUG },
  { label: 'An oracle freeze', body: ORACLE_FREEZE },
  { label: 'A USDG depeg', body: USDC_DEPEG },
];

export default function IndexLosses(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      {/* `rise={0}` is a pure fade: no transform, nothing that could read as
          the copy arriving from somewhere. */}
      <Reveal className="wrap" duration={FADE_SECONDS} rise={0}>
        <p className={s.eyebrow}>Before you read anything else</p>
        <h2 id={HEADING_ID}>Three ways this loses your money.</h2>

        <dl className={s.rows}>
          {MECHANISMS.map((m) => (
            <div key={m.label}>
              <dt>{m.label}</dt>
              {/* Rendered as source bytes so the apostrophe in the oracle row
                  reaches dist/ as an apostrophe rather than as &#x27;. */}
              <Pinned as="dd" html={m.body} />
            </div>
          ))}
        </dl>

        {/* The unhedged disclosure, between the rows and the link. */}
        <Pinned as="p" className={s.tight} html={TOTAL_LOSS} />

        <div className={s.actions}>
          {/* risks.html was retired 2026-09-05; disclaimers.html is its
              replacement and every page is asserted to link to it with the
              label "Disclaimers" exactly. The label comes from the shared CTA
              table rather than being written here, the banned conversion
              phrases are exactly what a freshly written button label reaches
              for, and the ones already in use are known to pass. */}
          <a className={`${s.btn} ${s.btnPrimary}`} href="disclaimers.html">
            {CTA.allRisks}
          </a>
        </div>
      </Reveal>
    </section>
  );
}
