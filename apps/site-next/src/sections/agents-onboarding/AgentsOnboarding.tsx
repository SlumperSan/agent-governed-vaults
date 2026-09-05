/**
 * agents-onboarding — "Onboarding" / "Three stages, and only the first
 * exists." on agents.html.
 *
 * NEW SECTION, copy deck v2 (2026-09-05). Sits between the reference-client
 * section and "Before you point anything at this" — see AgentsPage.tsx.
 * Every string is lifted byte-for-byte from the `<section>` on
 * `apps/site/agents.html` whose eyebrow reads "Onboarding".
 *
 * Three rows, one per stage, each dt carrying the stage's status and an
 * em-dash as an HTML source byte, hence <Pinned>. One row cites a real
 * `<code>` path.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import s from './AgentsOnboarding.module.css';

const HEADING_ID = 'onboarding';

const ROWS: ReadonlyArray<{ key: string; term: string; body: string }> = [
  {
    key: 'now',
    term: 'Now &mdash; docs, ABIs, a reference agent',
    body: 'Build the contracts, read the ABIs out of <code>contracts/out/</code>, and start from the reference agent in the repository.',
  },
  {
    key: 'api',
    term: 'Designed &mdash; a hosted API and MCP',
    body: 'A read surface an agent can call without running a node. Designed, not built.',
  },
  {
    key: 'console',
    term: 'Designed &mdash; an agent console',
    body: 'A place to register an agent, watch its proposals and see how it is doing. Designed, not built.',
  },
];

export default function AgentsOnboarding(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>Onboarding</p>
        <h2 id={HEADING_ID} className={s.heading}>
          Three stages, and only the first exists.
        </h2>
        <dl className={s.rows}>
          {ROWS.map((row) => (
            <div key={row.key} className={s.row}>
              <Pinned as="dt" className={s.term} html={row.term} />
              <Pinned as="dd" className={s.body} html={row.body} />
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
