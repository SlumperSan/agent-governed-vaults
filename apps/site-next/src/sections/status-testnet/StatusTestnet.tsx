/**
 * status-testnet — two consecutive corpus sections: "Wiring, read back" and
 * "The oracle". See copy.ts for why this file carries two `<section>`
 * elements rather than one, and how the corpus's three post-address-book
 * sections were split between this file and status-pins.
 *
 * NO MOTION, for the reason status-board gives: these are figures a reader
 * came to check.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import {
  CAPTION,
  CLOSING,
  EYEBROW,
  HEADING,
  HEADING_ID,
  LEDE,
  ROWS,
  TABLE_ARIA_LABEL,
  WIRING_EYEBROW,
  WIRING_HEADING,
  WIRING_HEADING_ID,
  WIRING_ITEMS,
} from './copy';
import s from './StatusTestnet.module.css';

export default function StatusTestnet(): JSX.Element {
  return (
    <>
      <section className={s.section} aria-labelledby={WIRING_HEADING_ID}>
        <div className="wrap">
          <p className={s.eyebrow}>{WIRING_EYEBROW}</p>
          <h2 id={WIRING_HEADING_ID} className={s.heading}>
            {WIRING_HEADING}
          </h2>
          <ul className={s.list}>
            {WIRING_ITEMS.map((item, i) => (
              <Pinned key={i} as="li" className={s.listItem} html={item} />
            ))}
          </ul>
        </div>
      </section>

      <section className={s.section} aria-labelledby={HEADING_ID}>
        <div className="wrap">
          <p className={s.eyebrow}>{EYEBROW}</p>
          <h2 id={HEADING_ID} className={s.heading}>
            {HEADING}
          </h2>
          <Pinned as="p" className={s.lede} html={LEDE} />

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
    </>
  );
}
