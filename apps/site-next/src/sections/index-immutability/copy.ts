/**
 * index-immutability — the reviewed copy, held as HTML source bytes.
 *
 * WHERE IT CAME FROM. Every card string below is lifted byte-for-byte from the
 * `Immutability` section of `apps/site/index.html` (grep `Four powers nobody
 * holds` for the heading, `Cannot be paused or upgraded` for the first card).
 * Nothing here was rewritten, re-punctuated or tightened, and nothing in the
 * four cards is new: this section writes no card sentence the current site
 * does not already carry. Since 2026-09-05 the four cards are the whole of it;
 * the warn note that used to sit below them is gone, and the note at the foot
 * of this file records where it went and why.
 *
 * WHY BYTES RATHER THAN TEXT. `renderToString` escapes text children, so an
 * apostrophe reaches `dist/index.html` as `&#x27;` and a byte-comparison
 * against the reviewed original fails on markup that looks perfect in a
 * browser. These are rendered through `<Pinned>` (src/shell/PinnedText.tsx),
 * which writes them straight onto the semantic element. One of the strings
 * below carries an apostrophe for exactly that reason; the rest are held the
 * same way so the section has one rule rather than two.
 *
 * WHAT IS NOT HERE. The `Cannot take your funds` body is `OPERATOR_ENUMERATED`
 * in `src/shell/pinned.ts` and is imported from there, not retyped. It is the
 * enumerated operator sentence, and the enumeration is the reason it passes:
 * a blanket negative about what the operator holds is falsifiable in one
 * transaction, because `FeeEngine.onFeeCollected` credits
 * `claimableFees[operatorAddressOf(opId)]`
 * (contracts/src/FeeEngine.sol:104). Do not compress it.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBERS, EACH READ OUT OF THE CONTRACT RATHER THAN OUT OF A DOCUMENT
 * ---------------------------------------------------------------------------
 *   10% performance fee to the operator identity
 *     contracts/src/FeeEngine.sol:35   `uint256 public constant PERF_FEE_BPS = 1_000; // 10%`
 *     contracts/src/FeeEngine.sol:88   `feeUsdc = netGain * PERF_FEE_BPS / BPS;`
 *     contracts/src/FeeEngine.sol:104  credited to `operatorAddressOf(opId)`
 *
 *   exit fee capped at 1% by the protocol
 *     contracts/src/VaultCore.sol:54   `uint256 public constant EXIT_FEE_CAP_BPS = 100; // 1% protocol cap`
 *     contracts/src/VaultCore.sol:251  `require(exitFeeMaxBps_ <= EXIT_FEE_CAP_BPS, BadConfig());`
 *
 *   decays to zero with tenure
 *     contracts/src/VaultCore.sol:1010-1016  `_exitFeeBps` returns 0 once tenure >= decay period
 *
 *   waived entirely for the last member out
 *     contracts/src/VaultCore.sol:617  `if (memberShares == ts) feeBps = 0;`
 *
 *   the fee fraction stays in the vault
 *     contracts/src/VaultCore.sol:621-622  the exit-fee fraction of every slice stays in the vault
 *
 *   full consensus of voting-eligible stake plus a timelock
 *     contracts/src/Governance.sol:203-204  config is immutable except via a RuleChange proposal
 *     contracts/src/Governance.sol:538-541  RuleChange passes only on
 *       `p.revealedWeight == p.snapshotTotal && p.forWeight >= p.snapshotTotal` (i.e. 100%)
 *     contracts/src/Governance.sol:531      passing starts the timelock and execution window
 *
 * CHANGED 2026-09-05: CARD_4_BODY's public-facing wording was "100% of
 * voting-eligible stake"; the corpus now says "full consensus of
 * voting-eligible stake" — same mechanism, cited above, carried across
 * verbatim as the corpus phrases it.
 */

/* --- the four card headings ------------------------------------------------
   No apostrophes and no ampersands, so these survive text rendering unescaped
   — but they are held here beside their bodies so one file is the whole
   passage. */

export const CARD_1_TITLE = 'Cannot be paused or upgraded';
export const CARD_2_TITLE = 'Cannot take your funds';
export const CARD_3_TITLE = 'Cannot route the exit fee to the operator';
export const CARD_4_TITLE = 'Cannot change the rules behind you';

/* --- the four card bodies -------------------------------------------------- */

export const CARD_1_BODY =
  'The contracts carry no proxy, no upgrade path, no pause function and no admin key. What shipped is what runs, for as long as Robinhood Chain runs.';

/** CARD_2_BODY is OPERATOR_ENUMERATED, imported from src/shell/pinned.ts. */

export const CARD_3_BODY =
  "The protocol caps the exit fee at 1%. It decays to zero with tenure, and is waived entirely for the last member out. The fee fraction stays in the vault rather than being paid out, so it remains with the vault's share value. It is never routed to the operator identity, and the operator is also a member, so its shares carry the fee up like anyone else's.";

export const CARD_4_BODY =
  'Once a vault is funded its rules are immutable, except by full consensus of voting-eligible stake plus a timelock. Nobody can raise a fee or shorten a delay after you deposit.';

/* --- the warn note, DELETED 2026-09-05 -------------------------------------
   `NOTE_LABEL` ("The same fact, read the other way"), `NOTE_PARAGRAPH_1` (the
   reversal of all four cards) and `NOTE_PARAGRAPH_2` (the source-versus-live
   scoping) are gone, with the markup that rendered them.

   WHY. The owner's 2026-09-05 decision puts every risk, warning, caveat and
   negative statement on disclaimers.html and leaves page bodies positive and
   factual. `apps/site/index.html` carries no note under this section, and the
   reversal is on the Disclaimers page in the corpus's own words, as the row
   headed `Immutability, read the other way` in
   src/sections/risks-scope-additions/RisksScopeAdditions.tsx.

   NOTE_PARAGRAPH_2 had already been corrected once, on 2026-09-05, because its
   original form asserted that nothing was deployed to mainnet and the seven
   contracts on Robinhood Chain had falsified that. It is deleted rather than
   carried: index-status states the deployment and the empty factory on this
   same page, so nothing true is lost with it.

   Do not restore a note to this section. The four cards state what nobody can
   do; the Disclaimers page states what that costs a reader. */
