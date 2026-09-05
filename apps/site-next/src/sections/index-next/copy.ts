/**
 * The last beat: the token, what it is, and what around it is still only drawn.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REWRITTEN 2026-09-05 BECAUSE THE PAGE WENT FALSE WHILE IT WAS BEING BUILT.
 * ═══════════════════════════════════════════════════════════════════════════
 * This section used to read `There is nothing to claim here.` over `The next
 * iteration, RWLY, is designed to accrue the protocol's fees into official
 * Robinhood Stock Tokens. RWLY does not exist yet.` Both sentences were
 * corpus-verbatim and both had been read against the contracts. The second one
 * stopped being true at 2026-09-05T21:51:57Z, which is the timestamp of the
 * block that created RWLY, and a false sentence does not get to stay on a page
 * because it was checked before the fact changed.
 *
 * EVERY SENTENCE BELOW IS AN ON-CHAIN READ, not a paraphrase of a launch
 * announcement. The record is `rwly-flip-facts.md` and its companion
 * `rwly-robinhood-mainnet.json`, which carry the reproduction commands. What
 * each clause rests on:
 *
 *   `Launched 2026-09-05`   the creation block's own timestamp, which equals
 *                           the curve's `launchedAt()` exactly.
 *   `on Pons`               the curve's `factory()` is the Pons v2 factory. It
 *                           is named as a THIRD-PARTY launchpad because it is
 *                           one: nobody here wrote it, and a reader who thinks
 *                           the launch mechanics are ours will read the fee
 *                           split wrongly.
 *   `quoted in ETH`         `pairToken()` is the zero address and
 *                           `isNativeQuote()` is true. Say this early: the
 *                           standing design documents point at a stock-quoted
 *                           pool, and this launch is not one.
 *   `Fixed supply`          `totalSupply()` is 1e27, minted once to the curve
 *                           in the creation transaction, and
 *                           `mint(address,uint256)` reverts as a non-existent
 *                           function with `totalSupply()` returning on the same
 *                           address as the positive control.
 *   `no owner`              `owner()`, `admin()`, `transferOwnership(address)`
 *                           and `renounceOwnership()` all revert, against the
 *                           same control. On the probes, NOT on a bytecode
 *                           scan: extracting PUSH4 immediates from the runtime
 *                           yields 25 selectors and the token demonstrably
 *                           reverts with one that is not among them, so absence
 *                           from that list proves nothing.
 *   `no upgrade path`       the 3,248-byte runtime contains zero DELEGATECALL
 *                           and zero CALLCODE opcodes, counted by walking the
 *                           bytecode and skipping PUSH immediates. A contract
 *                           that never delegatecalls cannot forward execution
 *                           to an implementation. All three EIP-1967 slots read
 *                           zero as corroboration.
 *   `No contract this       `git grep -i 2eed8ae7` returns nothing on the
 *   protocol deployed        default branch, and the deployment record's seven
 *   references it`           runtimes were certified byte-for-byte against
 *                           commit b1cde122 thirteen hours before the token
 *                           existed. Bytecode fixed before a thing existed
 *                           cannot contain its address.
 *
 * WHAT IS DELIBERATELY NOT ON THIS PAGE, and is on the Disclaimers instead: the
 * curve's fee terms, the graduation threshold, and the disclosure that the
 * protocol's own deployer address took about 7.3% of supply in the launch
 * transaction at the curve's opening price. That last one is the single most
 * important sentence of the whole flip and it is NOT being buried: the
 * homepage is capped at 150 to 250 visible words by the same brief that made it
 * one scroll, this beat spends 49 of them, and the disclosure needs more room
 * than the cap has left. It leads the token block on `disclaimers.html`, which
 * this section links to, and `test/site.test.mjs` pins it there.
 *
 * THE HEDGE IN THE LAST SENTENCE IS STRUCTURAL, NOT POLITENESS.
 * `scripts/test/claims-lede-truth.test.mjs` bans saying that the protocol, the
 * contracts, the vault, Governance or FeeEngine routes, pays, distributes,
 * accrues, credits, sends or allocates anything TO RWLY, and bans RWLY as a
 * governance or entitlement subject. `grep -ci rwly` still returns 0 in
 * Governance.sol, FeeEngine.sol and VaultCore.sol, which is why the staking,
 * the epochs and the fee accrual are named as design intent rather than as
 * things that happen. The token existing changes none of that.
 */

/**
 * The heading. Three words, and it is the flip.
 *
 * IT REPLACED `There is nothing to claim here.`, which was the page's punchline
 * and the sentence that made the loudness above it legitimate: a page that
 * shouts and then offers an allocation is a presale page; a page that shouts
 * and then says there is nothing to take is a different kind of thing. That
 * counterweight has not been dropped, it has moved into the body, which says
 * in four clauses that no contract here references the token and that
 * everything designed around it is still only designed. The counterweight is
 * now a fact rather than a promise, which is a better one.
 */
export const HEADING = 'RWLY is live.';

/**
 * The body. Four facts, one hedge, and no verb whose subject is this protocol.
 *
 * DO NOT ADD A LINK TO A TRADING VENUE HERE, and do not add a price, a market
 * capitalisation or a holder count. The curve moved roughly 45% of supply in
 * the two minutes after launch; any figure of that kind is true at a block and
 * false by the time it is read, and this site publishes numbers it can stand
 * behind without a timestamp beside them or reads them live in the reader's
 * own browser. The four facts below are the ones that do not move.
 */
export const BODY =
  'Launched 2026-09-05 on Pons, a third-party launchpad, it trades on a bonding curve quoted in ETH. Fixed supply 1,000,000,000, no owner, no mint function, no upgrade path. No contract this protocol deployed references it, and the staking, the epochs and the fee accrual into stock tokens are design intent.';
