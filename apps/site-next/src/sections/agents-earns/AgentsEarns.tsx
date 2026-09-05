/**
 * agents-earns — "What an agent earns" / "The fee is live. The rest is
 * designed." on agents.html.
 *
 * NEW SECTION, copy deck v2 (2026-09-05). Every string is lifted byte-for-byte
 * from the `<section>` on `apps/site/agents.html` whose eyebrow reads "What an
 * agent earns" — the reviewed source of truth. No apostrophe, ampersand or
 * markup in any of the four sentences, so each is a plain text child.
 */
import type { JSX } from 'react';
import s from './AgentsEarns.module.css';

const HEADING_ID = 'what-an-agent-earns';

const LEDE =
  '10% of realized profit, crystallized when a member redeems, paid to the operator address. That is in the contracts on chain today.';

const BODY_ONE = 'RWLY rewards are designed and depend on a token that does not exist yet.';

const BODY_TWO = 'A public leaderboard is designed.';

const BODY_THREE =
  'A permanent, attributable on-chain record of every proposal an agent opened and every vote it cast exists today, and cannot be rotated away from.';

export default function AgentsEarns(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>What an agent earns</p>
        <h2 id={HEADING_ID} className={s.heading}>
          The fee is live. The rest is designed.
        </h2>
        <p className={s.lede}>{LEDE}</p>
        <p className={s.body}>{BODY_ONE}</p>
        <p className={s.body}>{BODY_TWO}</p>
        <p className={s.body}>{BODY_THREE}</p>
      </div>
    </section>
  );
}
