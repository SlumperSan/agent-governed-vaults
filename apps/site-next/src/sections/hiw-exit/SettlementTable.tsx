/**
 * SettlementTable — the two settlement modes, Mode I and Mode F.
 *
 * NOTHING HERE MOVES, and that is a design decision rather than an omission.
 * This is the table a member reads to find out whether their exit settles now
 * or is queued for as long as somebody else's proposal takes. A reveal on it
 * delays the answer for the sake of the animation, so it renders at rest and
 * stays there. The only motion in this section is the warn note below it.
 *
 * THE STRUCTURE IS THE ACCESSIBILITY. `<caption>` names the table, `scope="col"`
 * binds the three column headers, and `scope="row"` makes the mode name the row
 * header — so a screen reader announces "Mode F: forward, When it applies, …"
 * rather than reading a grid of unattached sentences. `apps/site/test/site.test.mjs`
 * asserts both the caption and the scoped cells on every table on the site, and
 * the wrapper is a labelled `role="region"` with `tabindex="0"` because a
 * container that scrolls must be reachable by keyboard.
 *
 * THE `<caption>` CARRIES NO ATTRIBUTE, and that is the check rather than a
 * preference. site.test.mjs:676 tests `/<caption>/i` — literally, with no slot
 * for an attribute — so a `class` on the element fails a table that has a
 * caption. It is named from the stylesheet instead, by `.table caption`. The
 * `scope` half of the same check is `/<th[^>]*\sscope="(?:col|row)"/i`, which
 * does admit other attributes, so the row headers keep their class.
 *
 * WHY THE CELLS GO THROUGH `<Pinned>`. Three of the four carry an apostrophe or
 * sit downstream of one, and the Mode-F "When it applies" cell is composed from
 * `MODE_F_TRIGGER` — the clause five guards check for on six surfaces. Rendered
 * as a text child, `renderToString` would escape it and the guard would fail on
 * a cell that looks perfect in a browser. The two row headers are plain text
 * children: `Mode I: instant` and `Mode F: forward` carry a colon and nothing
 * else that `renderToString` would touch, so they reach the page unchanged.
 *
 * ONE THING NOT TO "TIDY". Do not wrap a cell's text in a `<span>` for
 * alignment or numerals. The reference-configuration table further down this
 * page is matched by a regex that admits no element between `<td>` and its
 * text, and a habit formed here is a habit applied there.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import {
  MODE_F_LABEL,
  MODE_F_MEANS,
  MODE_F_WHEN,
  MODE_I_LABEL,
  MODE_I_MEANS,
  MODE_I_WHEN,
  TABLE_CAPTION,
  TABLE_HEADERS,
} from './copy';
import s from './HiwExit.module.css';

export function SettlementTable(): JSX.Element {
  return (
    <div className={s.tableRegion} role="region" aria-label={TABLE_CAPTION} tabIndex={0}>
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
            <th scope="row" className={s.mode}>
              {MODE_I_LABEL}
            </th>
            <Pinned as="td" html={MODE_I_WHEN} />
            <Pinned as="td" html={MODE_I_MEANS} />
          </tr>
          <tr>
            <th scope="row" className={s.mode}>
              {MODE_F_LABEL}
            </th>
            <Pinned as="td" html={MODE_F_WHEN} />
            <Pinned as="td" html={MODE_F_MEANS} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
