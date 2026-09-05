/**
 * index-what — "A protocol, not a product that someone runs for you."
 *
 * Five definition rows carried verbatim out of `apps/site/index.html`, the
 * reviewed source of truth for this passage: Who decides, What it holds, Who
 * can create one, How you leave, What we hold. Nothing here was rewritten,
 * re-punctuated or tightened, and nothing here is new prose.
 *
 * THE ROW BODIES ARE HTML SOURCE BYTES, rendered through <Pinned>, because two
 * of them carry an inline `<a>` (the "What it holds" and "What we hold" rows
 * link to status.html and operators.html respectively) and every claims check
 * is an `includes()` against the built bytes — a `<span>` or an escaped
 * apostrophe inserted by `renderToString` would split or mangle a pinned
 * sentence invisibly. Writing them as bytes also keeps a byte-for-byte diff
 * against `apps/site/index.html` possible, which is how this passage is
 * checked rather than asserted.
 *
 * THE ONE NUMBER IN THIS SECTION, cited rather than repeated from a document:
 * the 10% performance fee in the last row is `PERF_FEE_BPS = 1_000` at
 * `contracts/src/FeeEngine.sol:35`, applied as `netGain * PERF_FEE_BPS / BPS`
 * at `:88`.
 *
 * THE BASKET IS WRITTEN SHORT-FORM HERE, DELIBERATELY. Owner decision,
 * 2026-09-05: "users dont say WETH or cbBTC, they say ETH/Ethereum or
 * BTC/Bitcoin." The "What it holds" row therefore says "ETH and BTC" and
 * points at status.html, which is one of the two pages (with disclaimers.html)
 * that names the actual ERC-20 symbols and addresses those words stand for —
 * `contracts/config/robinhood-mainnet.json`'s oracle assets, WETH and cbBTC,
 * plus USDG as the settlement asset. Do not write "WETH and cbBTC" directly
 * into this row; the short form is only honest because status.html anchors it.
 */
import type { JSX } from 'react';
import { Backdrop } from '../../assets/Backdrop';
import { DUR, STAGGER } from '../../motion/easings';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import s from './IndexWhat.module.css';

/** The h2's id, so the landmark is labelled by the heading rather than by new prose. */
const HEADING_ID = 'what-this-is';

/**
 * The five rows, in document order, out of the `dl` on `apps/site/index.html`
 * whose first `dt` is `Who decides`. Cited by phrase rather than by line:
 * the corpus grew a paragraph on 2026-09-04 and every line number into it moved.
 * `term` is a plain text child; `detail` is HTML source bytes for <Pinned>.
 */
const ROWS: ReadonlyArray<{ term: string; detail: string }> = [
  {
    term: 'Who decides',
    detail:
      'The members do. An operator can open a proposal and vote the weight of its own stake. Nothing executes without a member vote.',
  },
  {
    term: 'What it holds',
    detail:
      'The contracts on chain price two assets, ETH and BTC. The <a href="status.html">status page</a> names the two ERC-20 tokens those words stand for, with their addresses. The all-stocks index is designed, not deployed. Spot only: no leverage, no derivatives, no perpetuals.',
  },
  {
    term: 'Who can create one',
    detail:
      'Anyone. Vault creation is permissionless, and the parameters that matter &mdash; quorum, timelock, exit-fee schedule, capacity, minimum deposit &mdash; are chosen by the creator and frozen when the vault is funded. Read the vault, not the description of it.',
  },
  {
    term: 'How you leave',
    detail:
      'Pro-rata, in kind. You take your share of every basket asset plus your share of the idle USDG, minus the exit fee. Shares burn at settlement, never at request.',
  },
  {
    term: 'What we hold',
    detail:
      'No custody of your funds and no control over them. The contracts are non-custodial: no address in the system can seize, freeze or reassign your shares. The operator identity does receive the 10% performance fee; the <a href="operators.html">operators page</a> sets that out.',
  },
];

/**
 * MOTION. The five rows enter in sequence, 0.5s each, 60ms apart — `<Reveal>`
 * staggers its direct children, and the direct children of this `<dl>` are the
 * five row wrappers. The heading does not animate: it is at its final position
 * in the prerendered markup and stays there, so the section reads as a
 * reference block that fills in rather than as a slide.
 *
 * Everything renders at rest. `<Reveal>` pushes the rows back and animates them
 * forward only after hydration, only when the reader has not asked for reduced
 * motion, and only for rows that are not already on screen. With motion reduced
 * — which is also what the server and the hydration render see — the five rows
 * are simply where they belong, with no transition to sit through.
 */
export default function IndexWhat(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <Backdrop slot="lifecycle" />
      <div className="wrap">
        <div className={s.head}>
          <p className={s.eyebrow}>What this is</p>
          <h2 className={s.title} id={HEADING_ID}>
            A protocol, not a product that someone runs for you.
          </h2>
        </div>

        <Reveal as="dl" className={s.rows} duration={DUR.mid} stagger={STAGGER.tight}>
          {ROWS.map((row) => (
            <div className={s.row} key={row.term}>
              <dt className={s.term}>{row.term}</dt>
              <Pinned as="dd" className={s.detail} html={row.detail} />
            </div>
          ))}
        </Reveal>

      </div>
    </section>
  );
}
