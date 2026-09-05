/**
 * ops-powers — the copy, held as HTML source bytes.
 *
 * WHY BYTES RATHER THAN JSX TEXT. `renderToString` escapes text children, so
 * `vault's` becomes `vault&#x27;s` in `dist/operators.html`. Guards match the
 * raw file with `html.includes(SENTENCE)`, so an escaped apostrophe fails a
 * check on a page that is visibly perfect. Two of the three row bodies carry
 * an apostrophe (`vault's`, `member's`, `holder's`), so all three are rendered
 * through `<Pinned>` for one consistent rule rather than three exceptions.
 *
 * WHY NONE OF THIS IMPORTS FROM shell/pinned.ts. The exit-fee clause inside
 * the "Cannot" row LOOKS like `EXIT_FEE_CORRECTION`, and it is not: the
 * constant reads "But the operator is also a member, and the fee stays in the
 * vault where it raises the value of every share — so an operator holding the
 * 5% …", while this page's Powers row reads "the fee fraction stays in the
 * vault and is never routed to the operator identity, though it reaches the
 * operator's own shares like every other holder's." Two different sentences on
 * two different surfaces, both reviewed as written. Importing the constant
 * here would silently rewrite reviewed copy in order to look tidier, which is
 * the failure the byte-identical rule exists to prevent. The constant's real
 * home on this page is the Economics section, whose "What is not routed to
 * you" row is the passage it was extracted from.
 *
 * THE CLAIMS THIS PASSAGE MAKES, AND WHERE EACH IS READ FROM. Every statement
 * below was checked against the contracts in `contracts/src/`, not against a
 * document describing them:
 *
 *   "provided it holds at least the vault's proposal threshold of
 *    voting-eligible stake"
 *      Governance.sol:306 — `require(own * BPS >= uint256(cfg.proposalThresholdBps) * total,
 *      BelowProposalThreshold());`. The gate is on STAKE. `Governance.sol`
 *      contains no occurrence of the word operator at all, which is the whole
 *      point of the row: proposal rights follow stake, never operatorship.
 *
 *   "and is not inside its proposal cooldown"
 *      Governance.sol:296 — `require(lastAt == 0 || block.timestamp >= lastAt +
 *      cfg.proposalCooldown, Cooldown());`, keyed per proposer.
 *
 *   "Vote with exactly the weight its own stake carries — no more than any
 *    member holding the same stake."
 *      Governance.sol:394-400 — reveal adds `_boundedWeight(p, msg.sender)`,
 *      and Governance.sol:350-351 defines that as the lesser of the snapshot
 *      weight and the current voting-eligible weight. It is a function of the
 *      caller's shares and of nothing else; there is no operator term in it.
 *
 *   "Execute a rebalance the members did not pass … Skip the timelock."
 *      Governance.sol:280-281 and the tally/execute path: execution is gated
 *      on a passed proposal and on the timelock elapsing, for every caller.
 *
 *   "Attested by the registry at vault creation, and immutable for that vault.
 *    There is no rebind. The payout address is permanent"
 *      OperatorRegistry.sol:102-109 — `attestVault` is factory-only and writes
 *      `_vaultOperator[vault]` at deployment; no other function writes that
 *      mapping, so a vault's operator id is fixed at creation.
 *      OperatorRegistry.sol:91-97 — `registerOperator` requires
 *      `operatorIdOf[operator] == 0` and writes `operatorAddressOf[opId]`
 *      once; nothing writes it a second time, so there is no rotation,
 *      replacement or revocation path for a payout address. The contract's own
 *      comment at OperatorRegistry.sol:87 states the same thing: registration
 *      "can never rebind an existing operator (CM-4)".
 *
 * THE ENUMERATION IS THE CLAIM. The "Cannot" row is a LIST of specific
 * capabilities, and it has to stay one. A blanket negative about what an
 * operator holds on-chain is falsifiable in one transaction —
 * `FeeEngine.onFeeCollected` credits `claimableFees[operatorAddressOf(opId)]`,
 * so the operator identity does hold a unilateral on-chain right no other
 * member has. Compressing these seven sentences into one short line is the
 * single most likely claims violation available in this section. Do not.
 */

/** The section's eyebrow. */
export const EYEBROW = 'Powers';

/** The section's heading. */
export const HEADING = 'What an operator can and cannot do.';

/* --- the three row bodies, as HTML source bytes --------------------------- */

const CAN =
  "Propose a rebalance, provided it holds at least the vault's proposal threshold of voting-eligible stake and is not inside its proposal cooldown. Vote with exactly the weight its own stake carries, no more than any member holding the same stake.";

const CANNOT =
  "Execute a rebalance the members did not pass. Pause the vault. Upgrade the contracts. Reprice shares. Move, freeze or seize another member's funds. Skip the timelock. Receive the exit fee as a payment. The fee fraction stays in the vault and is never routed to the operator identity, though it reaches the operator's own shares like every other holder's. The economics section below sets that out.";

const IS =
  'Attested by the registry at vault creation, and immutable for that vault. There is no rebind. The payout address is permanent, which is the whole argument for making it a multisig rather than an EOA.';

export const ROWS: ReadonlyArray<{ term: string; body: string }> = [
  { term: 'Can', body: CAN },
  { term: 'Cannot', body: CANNOT },
  { term: 'Is', body: IS },
];

/* --- the note ---------------------------------------------------------------
   NOTE_BODY carries a real <a> element pointing at the Disclaimers page, so it
   is rendered through <Pinned> like the three row bodies above it. ------- */

export const NOTE_LABEL = 'Is permanent';

export const NOTE_BODY =
  'The operator identity is attested by the registry at vault creation and is immutable for that vault. Choose the payout address as if it is permanent, because it is. There is no rotation path; the <a href="disclaimers.html">Disclaimers</a> set out what that costs a compromised identity.';

