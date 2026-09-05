/**
 * agents-capabilities — "Membership is bought, not granted."
 *
 * WHY THIS PASSAGE IS THE ONE NOT TO TIGHTEN. It is the enumerated form of the
 * claim the claims contract has had to widen its guard for twice. The "Propose"
 * row says proposal rights follow STAKE and names the absence of an operator
 * check in the governance contract; it does not say the operator has no power,
 * which would be false — `FeeEngine.onFeeCollected` credits
 * `claimableFees[operatorAddressOf(opId)]`, so the operator holds a unilateral
 * on-chain right no other member has. Compressing "an operator holding no
 * shares may not" into a blanket negative is the single most likely claims
 * violation available on this page.
 *
 * WHY EVERY BLOCK GOES THROUGH <Pinned>. `renderToString` escapes text
 * children, so `vault's` becomes `vault&#x27;s` in `dist/agents.html` and a
 * guard doing `html.includes(SENTENCE)` fails on a page that looks perfect in
 * the browser. Three of these blocks hold markup — `<code>`, an `<a>` — and
 * one holds an apostrophe, so every one of them is rendered as HTML source
 * bytes rather than as JSX text.
 *
 * THE EXIT ROW NO LONGER CARRIES THE MODE-F TRIGGER CLAUSE. The owner's
 * rewrite states the reveal-start trigger inline, in its own words, ending in
 * a pointer to the Disclaimers rather than spelling out the oracle-freeze
 * consequence on this page. That inline phrasing does not match
 * `MODE_F_TRIGGER` in `src/shell/pinned.ts` byte-for-byte (that constant uses
 * a parenthetical; this page now uses an em dash pair), so this file no longer
 * imports it. `pinned.ts` itself still lists "agents" among the surfaces
 * carrying that clause — that line is now stale and is Shell's to reconcile,
 * not this section's; flagged in the sync report rather than fixed here.
 *
 * THE FACTS, AND THE LINE EACH ONE IS READ FROM. Every statement below is
 * about the contracts, so each is cited to `contracts/src`, read rather than
 * paraphrased from a document that describes it:
 *
 *   deposit gates on amount    VaultCore.sol:404 `require(amountUsdc >=
 *   alone and screens nobody   minDepositUsdc, BelowMinDeposit());` and
 *                              VaultCore.sol:409-411 — the capacity cap, which
 *                              VaultCore.sol:252 makes optional
 *                              (`capacityCapUsdc_ == 0` opts out). Those two
 *                              requires are the whole of the gate: there is no
 *                              allowlist, no registry lookup and no caller
 *                              check anywhere in `deposit`.
 *   proposing follows stake    Governance.sol:306 `require(own * BPS >=
 *                              uint256(cfg.proposalThresholdBps) * total,
 *                              BelowProposalThreshold());` — `own` is the
 *                              caller's stake, and it is the only quantity
 *                              tested.
 *   no operator check in the   `grep -ic operator contracts/src/Governance.sol`
 *   governance contract        answers 0. The word does not occur in the file.
 *   the salt is arbitrary and  Governance.sol:361 `commitVote(uint256 pid,
 *   nothing is stored for you  bytes32 commitment)` stores only the hash;
 *                              Governance.sol:387 re-computes
 *                              `keccak256(abi.encode(pid, msg.sender, support,
 *                              salt))` at reveal. The salt itself is never
 *                              written to storage, so a client that loses it
 *                              between the two phases cannot reveal.
 *   the exit queue opens at    VaultCore.sol:533-536 — the trigger is
 *   REVEAL START, for ANY      `governance.hasPendingExecution`, true from the
 *   proposal type              active proposal's reveal start, for ANY proposal
 *                              type, not only a passed rebalance; the getter is
 *                              the exact predicate `hasPendingExecution(vault)`
 *                              reads on-chain. Governance.sol:27-30 states the
 *                              same from the other side: it turns true at
 *                              reveal start, not at finalize, and false on
 *                              Defeated / Executed / expiry.
 *   four-hour observation      VaultCore.sol:52 `uint256 public constant
 *   window                     OBSERVATION_WINDOW = 4 hours;`, applied at
 *                              VaultCore.sol:425.
 *   skipWindow() is            VaultCore.sol:458-460 — `require(!skipOptIn[
 *   irrevocable                msg.sender], AlreadyOptedIn());` then sets the
 *                              flag. Nothing anywhere clears `skipOptIn`.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { Reveal } from '../../motion/Reveal';
import { DUR, STAGGER } from '../../motion/easings';
import s from './AgentsCapabilities.module.css';

const EYEBROW = 'What an agent can and cannot do';
const HEADING = 'Membership is bought, not granted.';

/* --- the four rows, as HTML source bytes ---------------------------------- */

const DEPOSIT =
  'Permissionless. The contracts gate on amount alone &mdash; a minimum deposit and a capacity cap &mdash; and screen nobody. Any address meeting those can join.';

/**
 * The enumerated form. `an operator holding no shares may not` is a statement
 * about one address's stake, not a universal about what operatorship holds —
 * and the sentence after it names the mechanism rather than asserting the
 * conclusion. Both halves are load-bearing; neither survives being tightened.
 */
const PROPOSE =
  "Follows stake, not identity. A member holding at least the vault's proposal threshold may open a proposal; an operator holding no shares may not. There is no operator check in the governance contract at all.";

const VOTE =
  'Commit, then reveal. The contract takes an arbitrary salt and stores nothing for you, so an agent that loses its memory between the two phases cannot reveal and its vote is lost. The reference client derives the salt from a signature it can reproduce rather than storing it. That is a client technique, not a protocol property; an integrator writing their own client gets it only by implementing it.';

const EXIT =
  'Pro-rata and in kind. From the moment the reveal phase opens on any live proposal &mdash; not from the moment one passes &mdash; the request is queued and settles at post-execution NAV. <code>Governance.hasPendingExecution(vault)</code> is the exact predicate. What that costs you, and what an oracle freeze does to it, is in the <a href="disclaimers.html">Disclaimers</a>.';

const ROWS: ReadonlyArray<{ term: string; body: string }> = [
  { term: 'Deposit', body: DEPOSIT },
  { term: 'Propose', body: PROPOSE },
  { term: 'Vote', body: VOTE },
  { term: 'Exit', body: EXIT },
];

/* --- the warn note -------------------------------------------------------- */

const NOTE_LABEL = 'The gate that will surprise an integrator first';

const NOTE_WINDOW =
  'A first deposit sits in a four-hour observation window before it becomes shares. During that window it has no vote and no share price, and it is fully reclaimable. An agent that deposits and immediately reads its balance will read zero. That is correct, not a failure.';

const NOTE_SKIP =
  '<code>skipWindow()</code> opts out and activates a pending deposit immediately. It is irrevocable, and what it forfeits is set out in the <a href="disclaimers.html">Disclaimers</a>.';

/**
 * MOTION. One animated element: the four rows enter in sequence, 0.5s each,
 * 60ms apart — `DUR.mid` and `STAGGER.tight`, the same grammar every other row
 * list on the site uses, so the four ledgers a reader meets on agents.html and
 * operators.html move identically.
 *
 * `Reveal` animates FROM the resting state, which is what the prerendered
 * markup already holds, and it starts nothing at all when
 * `prefers-reduced-motion` matches or when the element is already on screen at
 * load. The static branch is therefore the default rather than a fallback: a
 * reader with motion reduced, or one whose JavaScript never arrives, gets this
 * section finished rather than empty.
 *
 * The eyebrow, the heading and the warn note are deliberately not revealed. The
 * note is the section's disclosure — the four-hour window an integrator will
 * hit first, and the irrevocable call that trades it away — and a disclosure
 * that animates on arrival is the site performing its own warning.
 *
 * NOTHING HERE IS CONDITIONALLY RENDERED. Every sentence above is unconditional
 * JSX: no accordion, no scroll gate, no observer, no React state. So the
 * enumerated Propose row and both note paragraphs are in `dist/agents.html`
 * whether or not anything ever scrolls — which is the whole point, because
 * that file is what the guards read.
 */
export function AgentsCapabilities(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby="capabilities-heading">
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id="capabilities-heading" className={s.heading}>
          {HEADING}
        </h2>

        <Reveal as="dl" className={s.rows} duration={DUR.mid} stagger={STAGGER.tight}>
          {ROWS.map((row) => (
            <div key={row.term} className={s.row}>
              <dt className={s.term}>{row.term}</dt>
              <Pinned as="dd" className={s.body} html={row.body} />
            </div>
          ))}
        </Reveal>

        <div className={s.note}>
          <span className={s.noteLabel}>{NOTE_LABEL}</span>
          <Pinned as="p" html={NOTE_WINDOW} />
          <Pinned as="p" html={NOTE_SKIP} />
        </div>
      </div>
    </section>
  );
}

export default AgentsCapabilities;
