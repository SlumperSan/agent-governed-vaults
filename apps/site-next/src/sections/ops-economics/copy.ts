/**
 * ops-economics — the copy, held as HTML source bytes.
 *
 * WHY BYTES RATHER THAN JSX TEXT. `renderToString` escapes text children, so
 * an apostrophe would reach `dist/operators.html` as `&#x27;` and a guard
 * matching `html.includes(SENTENCE)` would fail on a page that looks perfect.
 * None of these four bodies happens to contain an apostrophe today, which is
 * exactly the kind of fact that changes under a one-word edit — so all four go
 * through `<Pinned>`, one rule rather than four exceptions.
 *
 * ---------------------------------------------------------------------------
 * NO IMPORT FROM shell/pinned.ts FOR "WHAT IS EARNED"
 * ---------------------------------------------------------------------------
 * An earlier version of this row continued past "which may never happen" with
 * the `HIGH_WATER_MARK_RESET` shell constant (the abandon-and-reregister
 * sentence also carried on how-it-works.html). The corpus for operators.html
 * no longer carries that continuation — "What is earned" now ends at "which
 * may never happen." — so `EARNED` is the row's own literal string and
 * `HIGH_WATER_MARK_RESET` is not imported here. The fact it states is not
 * false; it simply is not on this page's card any more, and this row must not
 * silently reattach it on a later edit.
 *
 * NOT IMPORTED: `EXIT_FEE_CORRECTION`. It looks like the second half of the
 * "What is not routed to you" row and it is a different sentence. The constant
 * reads
 *
 *   "… operator identity. But the operator is also a member, and the fee stays
 *    in the vault where it raises the value of every share — so an operator …"
 *
 * and this page reads
 *
 *   "… operator identity — but you are also a member, and the fee stays in the
 *    vault where it raises the value of every share, so an operator …"
 *
 * Second person, an em-dash where the constant has a full stop, a comma where
 * the constant has an em-dash. Grepped across the current site: the constant's
 * wording is `faq.html:111`; this wording is `operators.html:152`. The two
 * pages have never carried it identically, so the byte-identical rule does not
 * reach across them — and importing the constant here would silently replace a
 * reviewed sentence with a different reviewed sentence in order to look tidy.
 * Nothing in `apps/site/test/site.test.mjs` asserts either form on this page
 * (checked: no match for `also a member` or `raises the value of every share`);
 * what it does assert, at line 639, is that `no share of the exit fee` appears
 * nowhere, which the row satisfies because it states the opposite.
 *
 * `ops-powers/copy.ts` records the belief that this row is where the constant
 * was extracted from. The grep above says otherwise. That is a comment to
 * correct in that file, not a reason to change this one.
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER IN THIS PASSAGE, READ FROM THE CONTRACT
 * ---------------------------------------------------------------------------
 *   "10% of realized profit"
 *      contracts/src/FeeEngine.sol:35 — `uint256 public constant PERF_FEE_BPS
 *      = 1_000; // 10%`, over a BPS base of 10_000. Clamped a second time by
 *      the caller at contracts/src/VaultCore.sol:702 — `uint256 cap = gain /
 *      10; if (perfFee > cap) perfFee = cap;` — so the module cannot return
 *      more than a tenth of the realized gain even if it tried.
 *
 *   "crystallized when a member redeems — never accrued on paper gains"
 *      contracts/src/VaultCore.sol:694-704, inside `_settleExit`: the fee is
 *      computed only on the branch where `payoutValueUsdc > basisRemoved`, on
 *      that difference, at redemption. `FeeEngine`'s only two crediting entry
 *      points are `onFeeCollected` (FeeEngine.sol:94-107) and
 *      `onFeeCollectedAsset` (FeeEngine.sol:110-121), both reached from an
 *      exit settlement. There is no time-triggered path into either.
 *
 *   "A high-water mark is kept per member and per operator, and it follows
 *    that operator identity across vaults"
 *      contracts/src/OperatorRegistry.sol:30-31 — `mapping(address =>
 *      mapping(uint256 => uint256)) public carryOf`, the USDC loss
 *      carryforward keyed by (member, operatorId). The key is the operator id,
 *      never the vault, which is what makes it portable.
 *      OperatorRegistry.sol:122-136 — `recordRealization` adds a realized loss
 *      to the carry and consumes it with a realized gain.
 *
 *   "No management fee. No deposit fee. No spread. Nothing accrues while a
 *    member simply holds."
 *      The two crediting entry points cited above are the whole of the fee
 *      surface, and both are exit-settlement calls. Nothing in `FeeEngine`
 *      reads `block.timestamp`, and no deposit path calls it.
 *
 *   "the fee stays in the vault where it raises the value of every share"
 *      contracts/src/VaultCore.sol:610-616 — `keepBps = BPS - feeBps` is
 *      applied to every payout slice, and the comment on the invariant at
 *      :615-616 records the consequence: "the exit-fee fraction of every slice
 *      STAYS in the vault, so NAVps for remaining members is non-decreasing
 *      across any redemption". It is retained, not transferred; there is no
 *      recipient to route it to.
 *
 *   "the 5% the creator gate requires"
 *      contracts/src/VaultCore.sol:53 — `uint256 public constant
 *      CREATOR_MIN_STAKE_BPS = 500; // 5%`, enforced at VaultCore.sol:589-593
 *      on creator redemption while any non-creator member remains.
 *
 *   "the planned 50,000 USDG cap"
 *      docs/vault/go-to-market-plan.md:13 — "First `capacityCapUsdc`: 50,000
 *      USDC." — that document's own wording still says USDC and is not changed
 *      by this file. It is a recorded plan for a vault that has not been
 *      created, not a value read back from a deployment, which is why the word
 *      `planned` sits beside it. The site prints USDG here because
 *      `apps/site/operators.html` does: the stated target chain's settlement
 *      token is USDG, not Circle USDC, and the underlying figure is unchanged
 *      (see risks-scope-additions/groups.ts for the same rename traced to
 *      `contracts/config/robinhood-mainnet.json`). That word `planned` is also
 *      load-bearing for the build: site.test.mjs:648-651 fails any page
 *      containing `50,000` that does not also contain `planned`. This row is
 *      NOT the only place `50,000` appears on operators.html — ops-obligation's
 *      `P_FIGURE` carries an independent 50,000/planned pairing of its own — so
 *      removing either half here reds this row's own pairing rather than the
 *      page's only one.
 */
/** The section's eyebrow. */
export const EYEBROW = 'Economics';

/** The section's heading. */
export const HEADING = 'The fee is small by design, and we will not project it for you.';

/* --- the four row bodies, as HTML source bytes ----------------------------
   Extracted from the "Economics" section of apps/site/operators.html (grep
   for "The fee is small by design, and we will not project it for you"). */

/** "What is earned", verbatim from the corpus row. */
const EARNED =
  '10% of realized profit, crystallized when a member redeems. Never accrued on paper gains. A high-water mark is kept per member and per operator, and it follows that operator identity across vaults instead of resetting with each new one. If a member realized a loss under you, you earn no performance fee from that member unless and until that loss is recovered, which may never happen.';

const NOT_ROUTED =
  'No management fee. No deposit fee. No spread. Nothing accrues while a member simply holds. The exit fee is never routed to the operator identity, but you are also a member, and the fee stays in the vault where it raises the value of every share. So an operator holding the 5% the creator gate requires collects at least 5% of every exit fee, exactly as any other holder of that stake would.';

// REPOINTED 2026-09-05, copy deck v2: the planned-50,000-USDG-cap clause is
// gone. Owner: "I haven't created the safe vault yet. I want the pivot to the
// all-stocks index." There is no vault to size an example against any more,
// so the sentence states the fee rate alone. ops-obligation's P_FIGURE now
// carries this page's only 50,000/"planned" co-occurrence.
const ADDS_UP = '10% of realized profit. This page will not model it, illustrate it, or put a number on it.';

const ON_OFFER =
  'A public, attributable, on-chain record of your decisions. Every proposal you opened, every vote you cast and every execution that followed is permanently attached to an identity that cannot be rotated away from a bad quarter. That record is the point. It is worth exactly as much as your decisions turn out to be worth, and no more.';

export const ROWS: ReadonlyArray<{ term: string; body: string }> = [
  { term: 'What is earned', body: EARNED },
  { term: 'What is not routed to you', body: NOT_ROUTED },
  { term: 'What that adds up to', body: ADDS_UP },
  { term: 'What is actually on offer', body: ON_OFFER },
];
