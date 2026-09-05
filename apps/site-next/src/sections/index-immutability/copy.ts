/**
 * index-immutability — the reviewed copy, held as HTML source bytes.
 *
 * WHERE IT CAME FROM. Every card string below is lifted byte-for-byte from the
 * `Immutability` section of `apps/site/index.html` (grep `Four powers nobody
 * holds` for the heading, `Cannot be paused or upgraded` for the first card).
 * Nothing here was rewritten, re-punctuated or tightened, and nothing in the
 * four cards is new: this section writes no card sentence the current site
 * does not already carry. The NOTE_LABEL/NOTE_PARAGRAPH_* block below the
 * cards is the one exception — it has no corpus counterpart at all; see its
 * own comment.
 *
 * WHY BYTES RATHER THAN TEXT. `renderToString` escapes text children, so an
 * apostrophe reaches `dist/index.html` as `&#x27;` and a byte-comparison
 * against the reviewed original fails on markup that looks perfect in a
 * browser. These are rendered through `<Pinned>` (src/shell/PinnedText.tsx),
 * which writes them straight onto the semantic element. Three of the strings
 * below carry an apostrophe or an em-dash for exactly that reason; the rest are
 * held the same way so the section has one rule rather than two.
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

/* --- the warn note ---------------------------------------------------------
   The reversal. Every card above is restated as a limitation, and the second
   paragraph scopes all four to SOURCE rather than to anything running. */

export const NOTE_LABEL = 'The same fact, read the other way';

export const NOTE_PARAGRAPH_1 =
  'Every line above is also a limitation. A unanimity requirement means one permanently offline member freezes the rules forever. No pause means no circuit breaker if something is wrong. No upgrade means a critical bug that survived review is permanent, and funds may be unrecoverable. We are not going to pretend those are features.';

/**
 * CORRECTED 2026-09-05: was "Nothing is deployed to mainnet, so none of it can
 * be checked against mainnet bytecode today." That is now false — the core
 * contracts are on Robinhood Chain mainnet (see status.html) — so the claim is
 * rescoped to what is actually still true: no vault exists yet to exercise any
 * of these four rules against. This whole note has no corpus counterpart (see
 * the file-level comment); flagged as such rather than silently carried over
 * with a stale claim inside it.
 */
export const NOTE_PARAGRAPH_2 =
  'All four describe source. The core contracts are on Robinhood Chain mainnet, but no vault has been created yet, so none of this has been exercised by a live vault.';
