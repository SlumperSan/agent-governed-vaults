/**
 * MechanismTable — the four-column comparison of the two 5% mechanisms.
 *
 * NOTHING HERE MOVES. This is the table an agent operator reads to find out
 * which of the two rules locks their capital and which one quietly takes away
 * their right to propose. A reveal on it delays the answer for the sake of the
 * animation, so it renders at rest and stays there. The only motion in this
 * section is the 1px rule under the note's label above.
 *
 * THE STRUCTURE IS THE ACCESSIBILITY. `<caption>` names the table, four
 * `scope="col"` cells bind the column headers, and `scope="row"` makes the
 * mechanism name the row header — so a screen reader announces "Creator
 * withdrawal gate, What happens then, Your redemption reverts…" rather than
 * reading eight unattached sentences. `apps/site/test/site.test.mjs` asserts
 * the caption and the scoped cells on every table on the site, and the wrapper
 * is a labelled `role="region"` with `tabindex="0"` because a container that
 * scrolls must be reachable by keyboard; the focus ring comes from the global
 * `:focus-visible` rule.
 *
 * THE `<caption>` CARRIES NO ATTRIBUTE, and that is the check rather than a
 * preference. site.test.mjs:676 tests `/<caption>/i` — literally, with no slot
 * for an attribute — so a `class` on the element fails a table that has a
 * caption. It is named from the stylesheet instead, by `.table caption`. The
 * `scope` half of the same check is `/<th[^>]*\sscope="(?:col|row)"/i`, which
 * does admit other attributes, so the row headers keep their class.
 *
 * THE REGION'S NAME IS NOT THE CAPTION. `TABLE_REGION_LABEL` spells "percent";
 * `TABLE_CAPTION` keeps the sign. Both are what the current page carries, and
 * copy.ts records why. Passing one constant to both is the easy mistake here.
 *
 * WHY THE BODY CELLS GO THROUGH `<Pinned>` AND THE ROW HEADERS DO NOT. The two
 * row headers are plain words with no character React escapes. The six body
 * cells are reviewed prose, and prose is rendered as bytes throughout this
 * section so that no cell can be the one that quietly gained an escaped
 * apostrophe on a later edit.
 *
 * ONE THING NOT TO "TIDY". Do not wrap a cell's text in a `<span>` for
 * alignment or numerals. The reference-configuration table on how-it-works is
 * matched by a regex that admits no element between `<td>` and its text, and a
 * habit formed here is a habit applied there.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import {
  GATE_CONTROLS,
  GATE_FALL,
  GATE_LABEL,
  GATE_THEN,
  TABLE_CAPTION,
  TABLE_HEADERS,
  TABLE_REGION_LABEL,
  THRESHOLD_CONTROLS,
  THRESHOLD_FALL,
  THRESHOLD_LABEL,
  THRESHOLD_THEN,
} from './copy';
import s from './OpsObligation.module.css';

export function MechanismTable(): JSX.Element {
  return (
    <div className={s.tableRegion} role="region" aria-label={TABLE_REGION_LABEL} tabIndex={0}>
      <table className={s.table}>
        <caption>{TABLE_CAPTION}</caption>
        <thead>
          <tr>
            {TABLE_HEADERS.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className={s.mechanism}>
              {THRESHOLD_LABEL}
            </th>
            <Pinned as="td" html={THRESHOLD_CONTROLS} />
            <Pinned as="td" html={THRESHOLD_FALL} />
            <Pinned as="td" html={THRESHOLD_THEN} />
          </tr>
          <tr>
            <th scope="row" className={s.mechanism}>
              {GATE_LABEL}
            </th>
            <Pinned as="td" html={GATE_CONTROLS} />
            <Pinned as="td" html={GATE_FALL} />
            <Pinned as="td" html={GATE_THEN} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
