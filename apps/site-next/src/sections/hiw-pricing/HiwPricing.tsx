/**
 * hiw-pricing — "One Chainlink feed per asset, and a breaker that fails closed."
 *
 * WHY THE PROSE IS HELD AS HTML SOURCE BYTES. `renderToString` escapes text
 * children: `Each vault's oracle` becomes `Each vault&#x27;s oracle` in
 * `dist/how-it-works.html`, and every guard in `apps/site/test/site.test.mjs`
 * matches against the raw file. Three of the five bodies below carry an
 * apostrophe and one carries an `&mdash;` entity, so they are stored as bytes
 * and written onto the semantic element by `<Pinned>` rather than passed as
 * children. See src/shell/PinnedText.tsx.
 *
 * TWO GUARDS READ THIS SECTION'S NUMBERS, so they are pinned to the config
 * rather than typed from memory:
 *   - "the sane-price bands on the site match the config" asserts that `$100`,
 *     `$100,000`, `$1,000` and `$1,000,000` all appear on how-it-works.html.
 *     They are in the Sane-price band body and nowhere else on this page.
 *   - the sequencer body's `3,600-second grace period` is
 *     `ChainlinkOracle.GRACE_PERIOD`, a contract constant.
 *
 * WHERE EACH FIGURE COMES FROM (read, not assumed):
 *   - 3,600-second grace period ......... contracts/src/oracle/ChainlinkOracle.sol:79
 *                                         `uint256 public constant GRACE_PERIOD = 3600;`
 *   - the gate is a no-op on a zero feed . contracts/src/oracle/ChainlinkOracle.sol:312-314
 *                                         `_requireSequencerUp` returns early on address(0),
 *                                         which is why the enforcement is described as sitting
 *                                         at deploy time rather than in the oracle.
 *   - USDC pinned to $1.00 .............. contracts/src/oracle/ChainlinkOracle.sol:282
 *                                         `if (usdc != address(0) && asset == usdc) return 1e18;`
 *   - the band rejects out-of-range ..... contracts/src/oracle/ChainlinkOracle.sol:299
 *   - $100 / $100,000 (WETH) ............ contracts/config/robinhood-mainnet.json,
 *     $1,000 / $1,000,000 (cbBTC)         chainlinkOracle.assets[].minPriceWad / maxPriceWad
 *   - the heartbeat bound ............... contracts/config/robinhood-mainnet.json,
 *                                         chainlinkOracle.assets[].heartbeatSeconds = 86400
 *   - the factory allowlist has no add,   contracts/src/VaultFactory.sol:82 and :116 —
 *     no remove and no owner ...........  `bool public immutable oracleAllowlistEnforced;`
 *                                         set once in the constructor from `allowedOracles_`.
 *
 * MOTION. The five rows reveal on enter at 0.5s with a 60ms stagger, and
 * nothing else on this section moves. Deliberately: the one thing an animation
 * here could depict is the breaker firing, and a freeze rendered as a satisfying
 * transition reads as a feature rather than as the loss of access it is. The
 * heading and the lede therefore render static.
 */
import type { JSX } from 'react';
import { DUR, STAGGER } from '../../motion/easings';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import s from './HiwPricing.module.css';

const EYEBROW = 'Pricing';

const HEADING = 'One Chainlink feed per asset, and a breaker that fails closed.';

/**
 * The section landmark is named BY the heading rather than by an `aria-label`.
 * An aria-label would override the h2 as the region's accessible name, so a
 * screen reader would announce the eyebrow — "Pricing, region" — in place of the
 * sentence that was actually reviewed. It also keeps this component free of any
 * string that is not lifted from apps/site.
 */
const HEADING_ID = 'hiw-pricing';

/** The `p.tight` that opens the section. */
const LEDE =
  'The vault prices each asset from a single genuine Chainlink Data Feed: the ETH it holds through ETH/USD and the BTC it holds through CBBTC/USD, both eight-decimal feeds. The <a href="status.html">status page</a> names the two ERC-20 tokens those words stand for, with their addresses. USDG, the settlement token, is pinned to $1.00 in the oracle. The basket is limited to those two assets because they are the only ones the reference configuration prices from a genuine Chainlink USD feed on Robinhood Chain.';

/** The `p.tight` that closes the section, after the dl. Points what used to be
 * two further dl rows ("What stands behind those three" and "There is no
 * rotation path") at the Disclaimers page instead. */
const CLOSING =
  'What stands behind those three, what happens when a feed is retired, and why there is no rotation path are set out in the <a href="disclaimers.html">Disclaimers</a>.';

/**
 * The Staleness breaker body carries the ORACLE-FREEZE PASSAGE, which the build
 * brief lists among the passages that travel between pages and must stay
 * byte-identical wherever they land: hiw-pricing, disclaimers, faq, who-its-for
 * and agents-capabilities all state it. index-losses used to be a sixth; it was
 * deleted on 2026-09-05 when the home page's caveat blocks moved to
 * disclaimers.html.
 *
 * `src/shell/pinned.ts` exports no constant for it, and Shell owns that file, so
 * this section holds its own reviewed bytes here. Raised as a Shell request: the
 * passage wants one exported constant, or the other four surfaces will each
 * retype it and the first edit will split them.
 */
const ROWS: ReadonlyArray<{ term: string; body: string }> = [
  {
    term: 'Sequencer gate',
    body: 'A Chainlink L2 Sequencer Uptime Feed is mandatory on every chain Chainlink publishes one for. The enforcement sits at deploy time rather than in the oracle: the deploy script refuses to deploy on any chain but a local node, Base Sepolia and Robinhood Chain mainnet (chain id 4663) unless the feed address is supplied, and a pre-deploy configuration check fails without it. Robinhood Chain joined that short list by an owner-approved weakening of 2026-09-04: Chainlink publishes no L2 Sequencer Uptime Feed for it and is no longer expanding that feed set to additional networks, so there is no address an operator could supply. The price is that on Robinhood Chain the sequencer guard never runs at price time, and the per-feed heartbeat and the sane-price band below are the only guards left standing. The oracle contract itself does not re-check. Handed a zero address, it skips the gate and prices as though the chain had no sequencer at all. After the sequencer comes back up the oracle enforces a 3,600-second grace period before it will price anything again. This path has never executed against a real sequencer feed. Testnet leaves the feed address at zero by design, and Robinhood Chain has no feed to supply, so on Robinhood Chain it never executes at all.',
  },
  {
    term: 'Staleness breaker',
    body: 'Each asset carries a heartbeat bound. Past the bound, the oracle refuses to answer and every function that reads NAV reverts &mdash; deposits, rebalance execution and redemptions alike. Un-activated observation-window capital stays reclaimable, because cancelling a pending deposit reads no oracle. Active share capital does not.',
  },
  {
    term: 'Sane-price band',
    body: 'Each asset has a plausibility band. In the reference configuration that is $100 to $100,000 for WETH and $1,000 to $1,000,000 for cbBTC. It rejects gross errors. It does not reject an adverse but plausible price.',
  },
];

export default function HiwPricing(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 className={s.heading} id={HEADING_ID}>
          {HEADING}
        </h2>
        <Pinned as="p" className={s.lede} html={LEDE} />

        <Reveal as="dl" className={s.rows} duration={DUR.mid} stagger={STAGGER.tight}>
          {ROWS.map((row) => (
            <div className={s.row} key={row.term}>
              <dt className={s.term}>{row.term}</dt>
              <Pinned as="dd" className={s.body} html={row.body} />
            </div>
          ))}
        </Reveal>

        <Pinned as="p" className={s.lede} html={CLOSING} />

      </div>
    </section>
  );
}
