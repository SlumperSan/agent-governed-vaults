/**
 * ops-obligation — "The creator withdrawal gate is 5% of the vault's share supply."
 *
 * The site's quantified statement of what an agent operator has to put at risk.
 * Document order, matching the `The obligation` section of
 * apps/site/operators.html one block at a time:
 *
 * MOTION, AND WHY THERE IS ALMOST NONE. One element animates: a 1px rule in
 * --crit under the note's label, drawn left to right over 0.4s the first time
 * the note enters the viewport. Nothing else. The heading, both paragraphs, the
 * table and the closing line render at rest and are readable the instant they
 * are on screen — this is the page where somebody works out how much of their
 * own capital the gate holds, and copy like that is read rather than watched.
 * `CritHairline` starts nothing when `prefers-reduced-motion` matches and
 * nothing at all when the note is already on screen at load, so the rule is
 * fully drawn in both of those states.
 *
 * NOTHING IN THIS SECTION IS CONDITIONALLY RENDERED. Every sentence a guard
 * reads is unconditional JSX. There is no accordion, no scroll gate and no
 * `<details>`, which matters because five separate checks read this section:
 * `site.test.mjs:413-418` requires `2,500 USDC`, `5%`, `proposal threshold` and
 * `withdrawal gate` on this page and refuses `zero capital cost`; `:641`
 * refuses `must be topped up`; and any page carrying `50,000` must also carry
 * `planned`. All of them are satisfied by strings that reach `dist` whether or
 * not anything ever scrolls.
 *
 * NO SENTENCE HERE WAS WRITTEN FOR THIS BUILD. All of it is carried from
 * apps/site/operators.html; see `copy.ts` for the byte-for-byte constants and
 * the contract line each figure is cited to.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { CritHairline } from './CritHairline';
import { MechanismTable } from './MechanismTable';
import {
  EYEBROW,
  HEADING,
  NOTE_BODY,
  NOTE_LABEL,
  P_FIGURE,
  P_LOCKED,
  P_WATCH,
} from './copy';
import s from './OpsObligation.module.css';

const TITLE_ID = 'obligation-title';

export function OpsObligation(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={TITLE_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        {/* `<Pinned>` takes the id, so the landmark's accessible name comes from
            the heading itself rather than from a wrapper around it. */}
        <Pinned as="h2" id={TITLE_ID} className={s.heading} html={HEADING} />

        <div className={s.prose}>
          <Pinned as="p" html={P_FIGURE} />
          <Pinned as="p" html={P_LOCKED} />
        </div>

        <div className={s.note}>
          <span className={s.noteLabel}>{NOTE_LABEL}</span>
          <CritHairline />
          <Pinned as="p" html={NOTE_BODY} />
        </div>

        <MechanismTable />

        <Pinned as="p" className={s.closing} html={P_WATCH} />
      </div>
    </section>
  );
}

export default OpsObligation;
