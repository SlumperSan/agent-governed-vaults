/**
 * hiw-lifecycle — the reviewed copy, held as HTML SOURCE BYTES.
 *
 * WHERE IT CAME FROM. Every string below is lifted byte-for-byte out of the
 * `Lifecycle` section of `apps/site/how-it-works.html` (grep "One rebalance,
 * start to finish."), which is the reviewed source of truth for this passage. Nothing was rewritten,
 * re-punctuated, shortened or re-ordered. This is the longest single passage on
 * the site and it is also the one that carries the most disclosures, so the
 * temptation to tighten it for rhythm is exactly the thing that must not
 * happen.
 *
 * WHY BYTES RATHER THAN TEXT. `renderToString` escapes text children, so an
 * apostrophe rendered as `<p>{"the vault's timelock"}</p>` reaches `dist/` as
 * `the vault&#x27;s timelock`. The guards read the built file as text and match
 * on sentences, so an escaped apostrophe is a failed match on a paragraph that
 * looks perfect in a browser. Everything here is therefore rendered through
 * `<Pinned as="p" html={…} />` (src/shell/PinnedText.tsx), which writes these
 * bytes straight onto the element. Two consequences:
 *   - the `&mdash;` entities in step 6 are kept as entities, because that is
 *     what the source carries;
 *   - the `<strong>` in step 6 is markup, not a wrapper this file may drop —
 *     the reference-configuration sentence is emphasised on the current site
 *     and stays so.
 *
 * ONE DIVERGENCE FROM THE SHARED CONSTANT, DELIBERATE AND FLAGGED. Step 7 opens
 * with the Mode-F trigger clause, and the current site states it here as
 * "From the moment the reveal phase opens (not from the moment a proposal
 * passes)", which is NOT byte-identical to `MODE_F_TRIGGER` in
 * src/shell/pinned.ts ("…opens on any live proposal (not from the moment one
 * passes)"). The two surfaces did not carry it identically before this port,
 * so making them identical here would be a copy edit rather than a port, and
 * the claims contract's rule is the other way round: a passage carried
 * byte-identically before must be carried byte-identically after. The five
 * misstatements the suite asserts absent everywhere — `passed-but-pending`,
 * `passed-but-unexecuted`, `between a vote passing`, `vote passing and execut`,
 * `rebalance has passed but has not yet executed` — are all absent from the
 * source wording, so carrying it verbatim is correct as well as faithful. Raised in
 * the section report: if Shell decides the two should converge, the decision
 * belongs to whoever owns the constant, not to this file.
 *
 * THE NUMBERS, EACH CITED TO THE LINE THAT SETS IT. Read the constant, do not
 * take the sentence's word for it:
 *   - "four-hour observation window", "wait four hours", "four hours earlier"
 *     -> `OBSERVATION_WINDOW = 4 hours`, contracts/src/VaultCore.sol:52
 *   - "Below five members the vault takes a different branch"
 *     -> `SIGNER_REGIME_BELOW = 5`, contracts/src/Governance.sol:87, read at
 *        contracts/src/Governance.sol:541 as `p.memberCount < SIGNER_REGIME_BELOW`
 *   - "The protocol caps any timelock at 30 days"
 *     -> `TIMELOCK_HARD_CAP = 30 days`, contracts/src/Governance.sol:59
 *   - "it expires 72 hours after it is set"
 *     -> `DEFAULT_TTL = 72 hours`, contracts/src/Governance.sol:68
 *   - "a per-delegate cap on how much received weight one delegate may hold"
 *     -> `concentrationCapBps`, contracts/src/Governance.sol:111, enforced at
 *        contracts/src/Governance.sol:438; the protocol ceiling is
 *        `CONCENTRATION_CAP_CEILING_BPS = 5_000`, contracts/src/Governance.sol:233.
 *        The copy names no figure here, which is correct: the cap is a
 *        per-vault parameter, and hiw-invariant is the section that governs how
 *        a per-vault parameter may be described.
 *   - "The reference configuration sets the timelock to zero" — a
 *     launch-configuration fact, not a protocol constant; the reference table
 *     in hiw-reference-config carries the row that sources it from
 *     contracts/config/robinhood-mainnet.json.
 */

export const EYEBROW = 'Lifecycle';

export const HEADING = 'One rebalance, start to finish.';

/** The id the section's <h2> carries, so the landmark can be labelled by it. */
export const HEADING_ID = 'lifecycle';

export type Step = {
  /** Plain text — no markup, no characters `renderToString` would escape. */
  readonly heading: string;
  /** HTML source bytes, one entry per <p>. */
  readonly paragraphs: readonly string[];
};

export const STEPS: readonly Step[] = [
  {
    heading: 'Deposit, then wait four hours',
    paragraphs: [
      "A first deposit into a vault enters a four-hour observation window. During it the money is escrowed: excluded from NAV, zero shares, no voting rights, no proposal rights. You can cancel and take it back. You may also irrevocably opt out of the window for that vault, and that opt-out cannot be undone. Think hard before you do. Un-activated pending capital is the only capital that stays reclaimable during an oracle freeze. Opting out means every later deposit into this vault mints immediately, so you permanently give up the one exit that works when the oracle does not, and you cannot get it back. Repeat deposits by an existing member mint immediately.",
      "Shares mint at the NAV of the activation transaction, not the NAV you saw when you deposited. Deposits are forward-priced so that nobody can mint against a valuation they observed four hours earlier. After the four hours, anyone can send the activation transaction. You do not control the block your shares are priced in.",
      "A repeat deposit can name a minimum number of shares out. A first deposit cannot: it prices at activation and ignores any bound you set.",
    ],
  },
  {
    heading: 'The operator proposes',
    paragraphs: [
      "A proposal requires the proposer to hold at least the vault's proposal threshold of voting-eligible stake. A per-proposer cooldown rate-limits repeat proposals from the same address, and only from that address. A second address is outside it.",
      "What is on-chain when a proposal opens is a 32-byte hash of the intended action, not the action. The swap target, amounts and route appear only in the execution transaction: after the vote, after finalization, after the timelock. That is deliberate: publishing the route up front would let anyone front-run the rebalance. The cost is that you vote on a commitment rather than a description. Any explanation an operator publishes is off-chain, and the contracts never check it against what finally executes.",
    ],
  },
  {
    heading: 'Commit phase',
    paragraphs: [
      "Members submit a hash of their vote and a salt. Nothing about the tally is visible while it forms, so nobody votes by watching the count.",
    ],
  },
  {
    heading: 'Reveal phase',
    paragraphs: [
      "Members reveal the vote and salt behind their hash. An unrevealed commit is forfeit and counts as an abstain. If you commit and then go offline, your vote is gone.",
      "The tally is readable during the reveal phase: a public getter plus cleartext reveal events. Your commit binds your direction so you cannot switch after seeing it, but late revealers do see partial counts, and someone holding stake across several addresses can reveal one and then decide the rest. Tally gating was specified and was not built.",
    ],
  },
  {
    heading: 'Quorum',
    paragraphs: [
      "Measured against voting-eligible stake as at the proposal snapshot. Pending deposits still inside the observation window are excluded from the denominator, and so are shares locked by a queued forward-settlement exit. Below five members the vault takes a different branch: a proposal passes on either a majority of the members-at-creation revealing in favour while the favouring stake still clears the quorum, or an outright favouring stake majority. Both branches weigh stake.",
    ],
  },
  {
    heading: 'Timelock, then an execution window',
    paragraphs: [
      "A passed proposal waits out the vault's timelock, then becomes executable for a bounded window. The protocol caps any timelock at 30 days. The adapter performs the swap when it executes.",
      "<strong>The reference configuration sets the timelock to zero.</strong> A proposal that passes is executable immediately, so there is no delay in which to leave after seeing an outcome you dislike. Do not read forward settlement as a substitute: requesting an exit from the moment reveals open does not get you out ahead of the swap. It queues you and prices you after it. The protection you have is the vote itself and the commit-phase window. Exits stop settling instantly the moment reveals open, so the last point at which you can still leave at a known price is before the commit deadline, not after passage. This is a deliberate choice by the operator, recorded here rather than buried.",
    ],
  },
  {
    heading: 'Exits queue from the moment reveals open',
    paragraphs: [
      "From the moment the reveal phase opens (not from the moment a proposal passes), redemption requests are queued rather than settled, and they price after the swap. The window closes when the proposal executes, is defeated, or its execution window lapses. A proposal that is ultimately defeated still forced your exit into the queue while it was live. That is forward settlement, described below.",
    ],
  },
];

/** The `note note--flat` that closes the section. */
export const NOTE_LABEL = 'Delegation and standing defaults';

export const NOTE_BODY =
  'You can delegate your voting weight, subject to a per-delegate cap on how much received weight one delegate may hold. You can also set a standing default for routine rebalances: it counts toward the tally but never toward quorum, and it expires 72 hours after it is set. Neither mechanism lets anyone vote weight they were not given.';
