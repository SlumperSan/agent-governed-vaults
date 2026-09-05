/**
 * index-losses — the reviewed copy, held as HTML SOURCE BYTES.
 *
 * WHERE IT CAME FROM, AND WHERE IT NOW LIVES. Every string below was
 * originally lifted byte-for-byte out of the `Before you read anything else`
 * section of `apps/site/index.html`. That section no longer exists on
 * index.html as of the 2026-09-05 copy deck (see IndexLosses.tsx's file
 * comment); `PERMANENT_BUG` remains byte-identical to disclaimers.html's r1
 * entry, and `ORACLE_FREEZE`/`USDC_DEPEG` are the longer forms of what is now
 * a condensed sentence in that same entry. Nothing was rewritten,
 * re-punctuated or tightened in this pass. This section composes no prose of
 * its own; the one thing it adds to the document is an `id` on the heading so
 * the landmark can be labelled by it.
 *
 * WHY BYTES RATHER THAN TEXT CHILDREN. `renderToString` HTML-escapes text
 * children, so `a vault's oracle` reaches `dist/index.html` as
 * `a vault&#x27;s oracle` — visually identical in a browser and NOT a literal
 * match for the sentence as the current site carries it. The guards read the
 * built file as text. So these constants are rendered through
 * `<Pinned>` (src/shell/PinnedText.tsx), which writes them straight onto the
 * semantic element, and the built page carries the same bytes the reviewed
 * page does.
 *
 * All four are written for that path uniformly, not only the one that
 * currently contains an apostrophe: the next editor who adds one to any of the
 * others should not have to rediscover this.
 *
 * NOTHING HERE IS PINNED ACROSS PAGES. The nearest thing is the oracle-freeze
 * passage, which the build brief lists as travelling — but it is NOT
 * byte-identical between surfaces on the current site
 * (`apps/site/index.html`, `how-it-works.html` and `risks.html`, grep each heading below
 * each state it at a different length), so it is not a shell constant and this
 * file carries the index wording only. If it is ever unified, it moves to
 * `src/shell/pinned.ts` and this file imports it.
 *
 * WHAT IS ASSERTED ABOUT THIS COPY. `TOTAL_LOSS` carries the fragment
 * `no guarantee of any outcome`, which is one of the claims suite's PERMITTED
 * negations, and every PERMITTED entry is separately asserted to be in actual
 * use somewhere on the site (`apps/site/test/site.test.mjs:118`). Shortening
 * that sentence reds the suite from the exemption list rather than from here.
 */

/** `A permanent bug` — apps/site/index.html, grep `A permanent bug`. */
export const PERMANENT_BUG =
  'Nothing can be patched. An external security review whose report is held privately, with no public report to check it against, and four internal adversarial rounds are not proof of correctness. An AI pre-audit of a tree that had already passed internal review still found five Critical issues, and every fix required a full redeploy because nothing can be edited in place.';

/**
 * `An oracle freeze` — apps/site/index.html, grep `An oracle freeze`.
 *
 * Sourced from the contracts, not from another document:
 *   - every failure path in `ChainlinkOracle.priceWad` reverts `StaleOracle`,
 *     including a stamp older than the per-asset heartbeat —
 *     contracts/src/oracle/ChainlinkOracle.sol:294, and the fail-closed
 *     statement of the whole function at :31-33;
 *   - NAV reaches that function on every valuation —
 *     `contracts/src/VaultCore.sol:980` calls `oracle.priceWad(asset)`, so a
 *     revert there propagates to every caller that values the vault;
 *   - the feed map is constructor config on an immutable contract
 *     (contracts/src/oracle/ChainlinkOracle.sol:120-151), which is why a
 *     retired feed is permanent rather than merely late.
 */
export const ORACLE_FREEZE =
  "If a price feed goes stale, every function that reads NAV reverts. That includes exits. There is no escape hatch and none will be added, because any escape hatch is exactly the stale-price exit the breaker exists to prevent. Active capital stays in the vault for as long as the feed is stale. If the feed is retired rather than merely late, that is permanent, because a vault's oracle cannot be replaced.";

/**
 * `A USDG depeg` — apps/site/index.html, grep `A USDG depeg`.
 *
 * The $1.00 figure is the contract's, not an illustration:
 * `ChainlinkOracle` pins the settlement token at 1e18 WAD and documents that a
 * sustained depeg is therefore mispriced —
 * contracts/src/oracle/ChainlinkOracle.sol:66-69, constructor parameter at
 * :127. The `no median and no second source` clause is the constructor
 * refusing to hold both a pin and a feed for the same asset, at :151.
 */
export const USDC_DEPEG =
  'The oracle pins the settlement token, USDG on the stated target chain, at $1.00. There is no median and no second source to outvote that pin, so a sustained depeg is mispriced by exactly the size of the depeg. This is accepted, not solved.';

/**
 * The unhedged total-loss sentence — apps/site/index.html, grep `No mainnet deployment exists`.
 */
export const TOTAL_LOSS =
  'Spot crypto assets fall. Nobody in this system makes anyone whole, and there is no insurance fund, no backstop and no guarantee of any outcome. Do not deposit anything you cannot afford to lose entirely.';

/**
 */
