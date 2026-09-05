/**
 * status-pins — "The first vault": no vault has been created yet.
 *
 * See copy.ts for the 2026-09-05 corpus sync note: this section used to be
 * "Four sentences the guard pins", a standing-fact note box quoting
 * `FOOTER_TOKEN`. The corpus replaced it, in the same document position, with
 * four plain paragraphs about the (not yet created) first vault.
 *
 * NO MOTION, matching the rest of this page.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { EYEBROW, HEADING, PARAGRAPHS } from './copy';
import s from './StatusPins.module.css';

const HEADING_ID = 'status-pins-heading';

export default function StatusPins(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id={HEADING_ID} className={s.heading}>
          {HEADING}
        </h2>

        {PARAGRAPHS.map((html, i) => (
          <Pinned key={i} as="p" className={s.tight} html={html} />
        ))}
      </div>
    </section>
  );
}
