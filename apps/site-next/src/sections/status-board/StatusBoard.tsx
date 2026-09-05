/**
 * status-board — "The address book": what is on Robinhood Chain mainnet,
 * chain id 4663.
 *
 * 2026-09-05 CORPUS SYNC. Rewritten from the launch-verdict / gate board to a
 * neutral address book — see copy.ts for the full provenance note and why
 * every value here is a pure text sync against the corpus rather than an
 * independently re-derived figure.
 *
 * NO MOTION. The section states figures a reader came to check. Nothing here
 * reveals, scrubs or pins, so the prerendered markup is the finished section.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { CAPTION, CLOSING, EYEBROW, HEADING, ROWS, TABLE_ARIA_LABEL } from './copy';
import s from './StatusBoard.module.css';

const HEADING_ID = 'status-board-heading';

export default function StatusBoard(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id={HEADING_ID} className={s.heading}>
          {HEADING}
        </h2>

        {/* An overflow-x container needs a name and a tab stop, or its content
            is unreachable by keyboard on a narrow viewport. */}
        <div className={s.tablewrap} role="region" aria-label={TABLE_ARIA_LABEL} tabIndex={0}>
          <table>
            <caption>{CAPTION}</caption>
            <thead>
              <tr>
                <th scope="col">Record</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.record}>
                  <th scope="row">{row.record}</th>
                  <Pinned as="td" html={row.valueHtml} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pinned as="p" className={s.closing} html={CLOSING} />
      </div>
    </section>
  );
}
