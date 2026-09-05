/**
 * status-verify — "Verification": how to check every line above.
 *
 * See copy.ts for the 2026-09-05 corpus sync note: the six entries below are
 * now github.com links into the deployment record and the guard suites that
 * check it, rather than bare file paths at `protocol/main`.
 *
 * NO MOTION. The section's whole subject is that a reader should go and check
 * for themselves; nothing here reveals, scrubs or pins.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { ACTIONS, CLOSING, EYEBROW, HEADING, REFERENCES } from './copy';
import s from './StatusVerify.module.css';

const HEADING_ID = 'status-verify-heading';

export default function StatusVerify(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id={HEADING_ID} className={s.heading}>
          {HEADING}
        </h2>

        <dl className={s.rows}>
          {REFERENCES.map((ref) => (
            <div key={ref.key} className={s.row}>
              <Pinned as="dt" className={s.term} html={ref.termHtml} />
              {ref.bodyHtml ? <Pinned as="dd" className={s.body} html={ref.bodyHtml} /> : null}
            </div>
          ))}
        </dl>

        <p className={s.closing}>{CLOSING}</p>

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
