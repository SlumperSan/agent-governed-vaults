/**
 * hiw-fees — "Two fees, and a slippage bound that is not a fee."
 *
 * Source passage: `apps/site/how-it-works.html`, the section whose eyebrow is
 * "What leaves the vault" (grep "Two fees, and a slippage bound that is not a
 * fee."). Every sentence below is carried over byte-for-byte; nothing here was
 * written for this build. The performance-fee body on this page stops short of
 * the pinned high-water-mark-reset passage (`HIGH_WATER_MARK_RESET` in
 * pinned.ts) — that sentence is not part of this page's dd — so it is not
 * imported here.
 *
 * WHY EVERY BODY GOES THROUGH <Pinned>. `renderToString` escapes text children,
 * so `vault's` becomes `vault&#x27;s` in `dist/how-it-works.html` and a guard
 * doing `html.includes(SENTENCE)` fails on a page that looks perfect. Four of
 * these bodies contain an apostrophe and one contains a `<code>` element, so
 * all four are rendered as HTML source bytes rather than as JSX text.
 *
 * NUMBERS, AND WHERE EACH ONE IS READ FROM. The prose states four figures and
 * each is a constant in the contracts, not a value from a document about them:
 *
 *   1%, 100 basis points   contracts/src/VaultCore.sol:54
 *                          `uint256 public constant EXIT_FEE_CAP_BPS = 100;`
 *   decays with tenure     contracts/src/VaultCore.sol:1010-1017 `_exitFeeBps`
 *                          returns `maxBps * (period - tenure) / period`, and 0
 *                          once `tenure >= period`.
 *   waived for the last    contracts/src/VaultCore.sol:617
 *   member out             `if (memberShares == ts) feeBps = 0;`
 *   the fee fraction       contracts/src/VaultCore.sol:621-622 — the exit-fee
 *   stays in the vault     fraction of every slice is simply not paid out.
 *   10% of realized        contracts/src/FeeEngine.sol:35
 *   profit                 `uint256 public constant PERF_FEE_BPS = 1_000;`
 *   crystallized at        contracts/src/FeeEngine.sol:25-28, 83-90 — `onRealize`
 *   redemption, netted     nets the gain against `registry.carryOf(member, opId)`
 *   against the carry      before taking the fee.
 *   2%                     contracts/src/VaultCore.sol:68
 *                          `uint256 public constant MAX_REBALANCE_SLIPPAGE_BPS = 200;`
 *                          enforced at VaultCore.sol:910 per rebalance leg.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { Reveal } from '../../motion/Reveal';
import { DUR, STAGGER } from '../../motion/easings';
import s from './HiwFees.module.css';

const EYEBROW = 'What leaves the vault';
const HEADING = 'Two fees, and a slippage bound that is not a fee.';

/* --- the four row bodies, as HTML source bytes ---------------------------- */

const EXIT_FEE =
  'Capped by the protocol at 1%, or 100 basis points. It decays toward zero the longer you have been a member, and it is waived entirely when the redeemer is the last member in the vault. The fee fraction stays in the vault rather than being paid out, so it remains with the vault\'s share value. It is not routed to the operator identity, though the operator holds shares like any other member, and its shares carry the fee up exactly as everyone else\'s do. It exists to price the cost that a departure imposes on the people who stay, not to earn anyone a fee.';

const PERFORMANCE_FEE =
  '10% of realized profit, crystallized when you redeem, not accrued on paper gains. A high-water mark is kept per member and per operator, and it follows that operator identity across vaults rather than resetting with each new one. If you realized a loss under an operator, you pay that operator no performance fee unless and until that loss is recovered, which may never happen.';

const REBALANCE_COST =
  'Not a fee, but it leaves the vault. Every rebalance leg is checked against the vault\'s own oracle and must land within 2% of it (<code>MAX_REBALANCE_SLIPPAGE_BPS</code>, a protocol constant, not a per-vault setting). Up to that 2%, plus the pool\'s own fee and gas, leaves the vault on every executed rebalance and is borne by every member pro-rata.';

const NOT_CHARGED =
  'There is no management fee, no deposit fee, no subscription, no spread taken by the protocol, and no fee charged on unrealized gains.';

const ROWS: ReadonlyArray<{ term: string; body: string }> = [
  { term: 'Exit fee', body: EXIT_FEE },
  { term: 'Performance fee', body: PERFORMANCE_FEE },
  { term: 'What a rebalance costs you', body: REBALANCE_COST },
  { term: 'What is not charged', body: NOT_CHARGED },
];

/**
 * Motion: the four rows enter in sequence, 0.5s each, 60ms apart. `Reveal` with
 * a `stagger` animates the direct children of the element it renders — here the
 * four row groups — and it does so from the resting state, which is what the
 * prerendered markup already contains. A reader with reduced motion, or one
 * whose JavaScript never arrives, gets the finished list.
 *
 * The heading block is deliberately not revealed. It sits directly under the
 * previous section's last paragraph, so on most screens it is already in view
 * when the list below it starts to move, and animating a heading that is
 * already being read is motion for its own sake.
 */
export function HiwFees(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby="fees-heading">
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id="fees-heading" className={s.heading}>
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

      </div>
    </section>
  );
}

export default HiwFees;
