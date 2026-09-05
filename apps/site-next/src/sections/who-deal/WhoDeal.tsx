/**
 * who-deal — "Governance participation is not a feature. It is the product."
 *
 * WHY EVERY BODY GOES THROUGH <Pinned>. `renderToString` escapes text children —
 * `'` becomes `&#x27;`, `"` becomes `&quot;` — and the guards match the raw file
 * with `html.includes(SENTENCE)`, so an escaped character fails a check on a page
 * that is visibly perfect. This passage carries all three hazards: the first body
 * quotes a word in double quotes, the second contains `vault's`, the third
 * carries a real `<a>` element, and the fourth contains `members'`. One rule for
 * all five strings rather than three exceptions.
 *
 * ---------------------------------------------------------------------------
 * THE CLAIMS THIS PASSAGE MAKES, AND WHERE EACH IS READ FROM
 * ---------------------------------------------------------------------------
 * Each statement was checked against `contracts/src/`, not against a document
 * describing it.
 *
 *   "The operator can open a proposal and vote the weight of its own stake."
 *      Governance.sol:305-306 — `require(own > 0, NoWeight());` then
 *      `require(own * BPS >= uint256(cfg.proposalThresholdBps) * total,
 *      BelowProposalThreshold());`. The gate is on STAKE. `Governance.sol`
 *      contains zero occurrences of the word operator (grep -ci: 0), so
 *      proposing and voting follow stake and never operatorship.
 *
 *   "Nothing executes without a member vote."
 *      Governance.sol:596-600 — the execute path requires `p.status ==
 *      Status.Passed`, `block.timestamp >= p.executableAt` and
 *      `block.timestamp <= p.expiresAt`, for every caller without exception.
 *
 *   "Voting is commit then reveal, in two phases with deadlines."
 *      Governance.sol:314-315 — `p.commitDeadline = nowTs + cfg.commitDuration;`
 *      and `p.revealDeadline = nowTs + cfg.commitDuration + cfg.revealDuration;`
 *      are both fixed at creation. `commitVote` (Governance.sol:361-366) is
 *      callable only while `block.timestamp < p.commitDeadline`; `revealVote`
 *      (Governance.sol:377-388) only from `commitDeadline` until
 *      `revealDeadline`.
 *
 *   "A commit you never reveal is forfeit and counts as an abstain. Miss the
 *    reveal window and your vote simply does not exist."
 *      Governance.sol:395-401 — weight is added to `p.forWeight`,
 *      `p.againstWeight` and `p.revealedWeight` inside `revealVote` and nowhere
 *      else. A commitment that is never revealed therefore contributes to no
 *      tally and to no revealed-weight total; it is not counted against the
 *      proposal either.
 *
 *   "Quorum, timelock, exit-fee schedule, minimum deposit, capacity and the
 *    commit and reveal durations are all chosen by whoever created the vault
 *    and frozen when it is funded."
 *      Two halves, in two contracts. The vault-side figures are constructor
 *      immutables — VaultCore.sol:81-84, `capacityCapUsdc`, `minDepositUsdc`,
 *      `exitFeeMaxBps`, `exitFeeDecayPeriod` — with no setter anywhere in the
 *      file. The governance-side figures live in `configOf[vault]`, written
 *      once by `registerVault` (Governance.sol:207-215), which requires
 *      `msg.sender == IVaultSnapshots(vault).creator()` and refuses a second
 *      registration. Governance.sol:203-204 states the residue precisely:
 *      "Config is thereafter immutable except via a full-consensus RuleChange
 *      proposal (CM-8)" — the one path that can move it is a member vote at
 *      full consensus of eligible stake, executed at Governance.sol:602-606.
 *      That is consistent with the sentence above it on this page and with the
 *      unanimity-requirement entry now on `apps/site/disclaimers.html` (grep
 *      for "full-consensus RuleChange"); nothing here is set by any party
 *      acting alone after creation.
 *
 *   "Two vaults built on the same contracts can behave very differently."
 *      Every figure named in that sentence is per-vault: the four VaultCore
 *      immutables above, and `GovConfig` (Governance.sol:104-148) held per
 *      vault in `configOf`. `_validateConfig` (Governance.sol:241-273) bounds
 *      them but does not fix them.
 *
 *   MODE_F_TRIGGER — "From the moment the reveal phase opens on any live
 *   proposal (not from the moment one passes)"
 *      Governance.sol:650-660, `hasPendingExecution`: while a proposal is
 *      `Active` it returns `block.timestamp >= p.commitDeadline`, which is
 *      reveal start; while `Passed` it returns `block.timestamp <= p.expiresAt`.
 *      The contract's own note at Governance.sol:651-653 says the same thing —
 *      true "from REVEAL START of an active proposal … until the proposal is
 *      executed, defeated, or its execution window lapses". This is why the
 *      five misstatements of the clause are asserted absent site-wide: a
 *      proposal that is ultimately defeated still queued exits while it was
 *      live.
 *
 *   "Your exit queues … It settles after the swap executes"
 *      VaultCore.sol:537-557 — a queued exit's shares "stay outstanding but are
 *      locked: no voting eligibility, irrevocable", and VaultCore.sol:582-585,
 *      `settleQueuedExit`, is callable only "once no execution is pending".
 *
 *   "Proposal rights are a percentage of voting-eligible stake, and other
 *    members' deposits move it. Nothing re-checks it for you."
 *      Same stake-percentage mechanism already cited above for the opening
 *      claim: Governance.sol:305-306 gates on `own * BPS >=
 *      uint256(cfg.proposalThresholdBps) * total`, a ratio of the caller's
 *      stake to `total`, which grows as other members deposit. Nothing in
 *      `propose` re-evaluates a member's percentage outside of a fresh call, so
 *      a passive drop below threshold produces no event and no notification —
 *      consistent with `apps/site/operators.html`'s "Passively. Other members
 *      deposit, total shares grow, your percentage falls. Nothing re-checks it
 *      and nothing warns you." for the equivalent mechanism on that page.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { MODE_F_TRIGGER } from '../../shell/pinned';
import { Reveal } from '../../motion/Reveal';
import { DUR, STAGGER } from '../../motion/easings';
import s from './WhoDeal.module.css';

const EYEBROW = 'The deal';
const HEADING = 'Governance participation is not a feature. It is the product.';

/* --- the intro paragraph and the four row bodies, as HTML source bytes ----- */

const INTRO =
  'The operator can open a proposal and vote the weight of its own stake. Nothing executes without a member vote. So the work does not stop at the deposit, and the protocol will not chase anyone for it.';

const SHOW_UP =
  'Voting is commit then reveal: two phases with deadlines. A commit you never reveal is forfeit and counts as an abstain. Miss the reveal window and your vote simply does not exist — not as a "no", not as anything.';

const READ_THE_VAULT =
  'Quorum, timelock, exit-fee schedule, minimum deposit, capacity and the commit and reveal durations are all chosen by whoever created the vault and frozen when it is funded. Two vaults built on the same contracts can behave very differently. Nothing on this page tells you what a particular vault\'s rules are.';

/**
 * This page states the clause MID-SENTENCE, after `Your exit queues `, so the
 * pinned constant is lowered at its initial letter exactly as every other
 * surface that quotes `MODE_F_TRIGGER` mid-sentence lowers it (grep
 * `src/shell/pinned.ts` for the constant's own note on where it travels).
 * Derived from the one constant rather than forked into a second literal: a
 * fork is a sentence that diverges on the next edit, and the divergence lands
 * on a page other than the one edited.
 */
const MODE_F_TRIGGER_MID = MODE_F_TRIGGER.charAt(0).toLowerCase() + MODE_F_TRIGGER.slice(1);

/**
 * The opening of the outvoted body and the remainder that follows the clause.
 * The pinned clause ends in a closing parenthesis and this page's sentence ends
 * with it, so the remainder opens with the full stop — no space between the two
 * halves, which is what keeps the join byte-identical to the current page.
 */
const OUTVOTED_OPENING = 'Your exit queues ';

const OUTVOTED_REMAINDER =
  '. It settles after the swap executes. That is the cost of closing the free option of leaving at pre-vote prices while already knowing the result, and what it means for you is in the <a href="disclaimers.html">Disclaimers</a>.';

const OUTVOTED = OUTVOTED_OPENING + MODE_F_TRIGGER_MID + OUTVOTED_REMAINDER;

const WATCH_SHARE =
  "Proposal rights are a percentage of voting-eligible stake, and other members' deposits move it. Nothing re-checks it for you.";

const ROWS: ReadonlyArray<{ term: string; body: string }> = [
  { term: 'You have to show up', body: SHOW_UP },
  { term: 'You have to read the vault', body: READ_THE_VAULT },
  { term: 'You have to accept being outvoted', body: OUTVOTED },
  { term: 'You have to watch your own share', body: WATCH_SHARE },
];

/**
 * Motion: the four rows enter in sequence, 0.5s each, 60ms apart — `DUR.mid`
 * and `STAGGER.tight`, read from `motion/easings.ts` rather than typed here, so
 * this section moves on the same two numbers as every other one.
 *
 * The eyebrow, heading and intro paragraph are deliberately not revealed. They
 * are the reader's entry into the section, and text that fades in as it is being
 * read is text the reader is being asked to watch instead.
 *
 * Everything above renders at its resting position in `dist/who-its-for.html`,
 * so the passage is complete in the prerendered file whether or not anything
 * ever scrolls and whether or not the motion chunk ever arrives.
 */
export function WhoDeal(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby="who-deal-heading">
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id="who-deal-heading" className={s.heading}>
          {HEADING}
        </h2>

        <Pinned as="p" className={s.intro} html={INTRO} />

        <Reveal as="dl" className={s.rows} duration={DUR.mid} stagger={STAGGER.tight}>
          {ROWS.map((row) => (
            <div key={row.term} className={s.row}>
              <dt className={s.term}>{row.term}</dt>
              <Pinned as="dd" className={s.body} html={row.body} />
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

export default WhoDeal;
