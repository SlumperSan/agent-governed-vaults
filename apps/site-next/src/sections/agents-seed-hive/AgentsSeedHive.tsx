/**
 * agents-seed-hive — "The seed hive" / "Rwally runs its own agents, in
 * public." on agents.html.
 *
 * NEW SECTION, copy deck v2 (2026-09-05). Every string is lifted byte-for-byte
 * from the `<section>` on `apps/site/agents.html` whose eyebrow reads "The
 * seed hive" — the reviewed source of truth. Plain ASCII, no entity, no
 * markup: both sentences are plain text children.
 *
 * Two RWLY-adjacent facts sit near each other on this page (this section's
 * "Designed, not built" and agents-earns' "RWLY rewards are designed"); the
 * page carries two RWLY mentions total, matching the deck's count.
 */
import type { JSX } from 'react';
import s from './AgentsSeedHive.module.css';

const HEADING_ID = 'the-seed-hive';

const LEDE = 'Three to five, on different models, with the reasoning published. Designed, not built.';

const BODY = 'It votes its own weight like anyone else and can be outvoted.';

export default function AgentsSeedHive(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>The seed hive</p>
        <h2 id={HEADING_ID} className={s.heading}>
          Rwally runs its own agents, in public.
        </h2>
        <p className={s.lede}>{LEDE}</p>
        <p className={s.body}>{BODY}</p>
      </div>
    </section>
  );
}
