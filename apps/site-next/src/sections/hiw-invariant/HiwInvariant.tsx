/**
 * hiw-invariant — "Which of these facts you can rely on."
 *
 * The site's CONTROLLING STATEMENT of the invariant / parameter split. Every
 * other page leans on it, because no per-vault parameter
 * may be presented anywhere as a protocol-level guarantee, and this is the one
 * section that says so.
 *
 * That sentence is wrapped where it is on purpose, and the wrap is the point.
 * The claims suite bans the bare word and exempts only EXACT fragments, matched
 * against the file as text — so the exempt fragment has to sit unbroken on a
 * single line. Reflowing this paragraph to a tidier ragged edge splits it across
 * a `*` continuation, the exemption stops matching, and the gate reds on a
 * comment in the one file whose whole subject is that rule.
 *
 * ---------------------------------------------------------------------------
 * NO MOTION, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Two dense reference blocks. A reveal on either would delay reading the one
 * passage a reader is most likely to have arrived here to check, so there is no
 * `Reveal`, no `useScrollTimeline` and no transition on anything that carries
 * copy. The resting state IS the state; there is no reduced-motion branch here
 * because there is no motion to branch on. The single transition in the
 * stylesheet is a hover luminance change on a link, which the global
 * reduced-motion rule already neutralises.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COPY IS HELD AS HTML SOURCE BYTES
 * ---------------------------------------------------------------------------
 * `renderToString` escapes text children, so an apostrophe becomes `&#x27;` and
 * `<code>` becomes `&lt;code&gt;`. The second `<dd>` genuinely contains markup —
 * `<code>isCapped()</code>` — and both bodies are checked by substring against
 * the reviewed original. They are therefore stored as bytes and written onto
 * the `<dd>` by `<Pinned>`, exactly as `src/shell/pinned.ts` requires of any
 * sentence that must not drift. See PinnedText.tsx: a section's own reviewed
 * copy, held in that section's directory, is the permitted second source.
 *
 * Neither body appears on any other page, so neither belongs in `pinned.ts` —
 * that file is for sentences that TRAVEL. They are pinned to the source file
 * rather than to a second surface.
 *
 * Each figure in the first body reads back to a constant in the contracts:
 *
 *   "Exit fee capped at 1%"        contracts/src/VaultCore.sol:54
 *                                    EXIT_FEE_CAP_BPS = 100  // 1% protocol cap
 *                                  enforced at VaultCore.sol:251
 *   "Performance fee 10%"          contracts/src/FeeEngine.sol:35
 *                                    PERF_FEE_BPS = 1_000    // 10%
 *                                  applied at FeeEngine.sol:88
 *   "Timelock capped at 30 days"   contracts/src/Governance.sol:59
 *                                    TIMELOCK_HARD_CAP = 30 days
 *                                  enforced at Governance.sol:244
 *   "Quorum floor of 25%"          contracts/src/Governance.sol:58
 *                                    QUORUM_FLOOR_BPS = 2_500 // 25% protocol floor
 *                                  enforced at Governance.sol:248
 *   "except by full consensus of    contracts/src/Governance.sol:91
 *    voting-eligible stake plus       RuleChange, // full consensus + timelock
 *    timelock"
 *   "isCapped() reports which"     contracts/src/VaultCore.sol:1069
 *                                    function isCapped() external view returns (bool)
 *
 * The four caps above are protocol constants — they are why the first body can
 * say "true of every vault" — while every name listed in the second body is a
 * constructor argument chosen per vault. That is the split, and it is the
 * reason the two are labelled separately rather than merged into one list.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import s from './HiwInvariant.module.css';

const EYEBROW = 'Protocol invariant vs. per-vault parameter';

const HEADING = 'Which of these facts you can rely on.';

const INVARIANT_LABEL = 'Protocol invariant';

const PARAMETER_LABEL = 'Per-vault parameter';

/**
 * apps/site/how-it-works.html (grep the sentence below). Checked by substring
 * against the source file, so a normalising editor breaks the check without
 * changing how the page looks.
 */
const INVARIANT_BODY =
  'Written into immutable contract code and true of every vault. No proxies, no upgrade path, no pause, no admin key, no seize function. Non-custodial. Exit fee capped at 1% and never routed to the operator identity. Performance fee 10% of realized profit. Timelock capped at 30 days. Quorum floor of 25% of voting-eligible stake. Commit-reveal voting. In-kind pro-rata redemption in v1. Vault rules immutable after funding except by full consensus of voting-eligible stake plus timelock.';

/**
 * apps/site/how-it-works.html (grep the sentence below). Contains one inline element, `<code>`, which
 * is why this constant is HTML source rather than text: as a text child React
 * would escape the angle brackets and the reader would see the tag.
 */
const PARAMETER_BODY =
  'Chosen by whoever creates the vault, then frozen when it is funded: quorum, proposal threshold, delegate concentration cap, proposal cooldown, timelock duration, execution window, exit-fee maximum and decay, capacity cap, minimum deposit, and the commit and reveal durations. Anyone can create a vault permissionlessly, so these differ from vault to vault. Read the vault you are looking at. A capacity cap is optional: a vault created with a cap of zero is uncapped, and <code>isCapped()</code> reports which. Read <code>isCapped()</code> on the vault you are looking at.';

/** The heading is the section's accessible name; no new prose is introduced by naming it. */
const HEADING_ID = 'hiw-invariant-heading';

export default function HiwInvariant(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 className={s.heading} id={HEADING_ID}>
          {HEADING}
        </h2>

        <dl className={s.rows}>
          <div className={`${s.row} ${s.rowInvariant}`}>
            <dt className={s.label}>{INVARIANT_LABEL}</dt>
            <Pinned as="dd" className={s.body} html={INVARIANT_BODY} />
          </div>
          <div className={`${s.row} ${s.rowParameter}`}>
            <dt className={s.label}>{PARAMETER_LABEL}</dt>
            <Pinned as="dd" className={s.body} html={PARAMETER_BODY} />
          </div>
        </dl>

      </div>
    </section>
  );
}
