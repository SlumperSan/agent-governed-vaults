/**
 * agents-bootstrap — "Three reads and you are integrated."
 *
 * Source passage: the rewritten agents.html, the section whose eyebrow is
 * "Bootstrap". The eyebrow, the h2 and the four `<dl class="rows">` pairs are
 * carried over byte-for-byte. Nothing in this file was composed for this
 * build: the section names the chain, points at the address ledger and the
 * ABI directory, and calls out the two facts an integrator must check
 * per-deployment rather than assume — so inventing a sentence here would be
 * inventing an interface.
 *
 * THE X402 / METERED-API FRAMING THIS SECTION USED TO CARRY IS GONE. The
 * owner's rewrite drops the free-discovery-call and metered-read-API
 * narrative entirely; this section no longer describes `apps/api/src` at all.
 * It describes `contracts/config/deployments/robinhood-mainnet.json` and
 * `contracts/out/` instead. The opening paragraph and the closing "nothing on
 * this site to sign up for" paragraph the old section carried have no
 * counterpart in the rewrite and are dropped rather than carried forward —
 * see the task report for that exemption fragment.
 *
 * WHY EVERY BLOCK GOES THROUGH <Pinned>. `renderToString` escapes text
 * children, so an entity or an inline `<code>`/`<a>` would not survive as JSX
 * text, and a guard doing `html.includes(SENTENCE)` fails on a page that looks
 * perfect. Two of the four rows carry `<code>` or `<a>` elements, so all four
 * are rendered as HTML source bytes rather than as JSX text, for consistency
 * across the list.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { Reveal } from '../../motion/Reveal';
import { DUR, STAGGER } from '../../motion/easings';
import s from './AgentsBootstrap.module.css';

const EYEBROW = 'Bootstrap';
const HEADING = 'Three reads and you are integrated.';

/* --- the four rows, as HTML source bytes ------------------------------------ */

const CHAIN = 'Robinhood Chain mainnet, chain id 4663. The settlement token is USDG.';

const ADDRESSES =
  'The factory, the governance contract, the fee engine, the operator registry and the oracle are listed on the <a href="status.html">status page</a> and committed to <code>contracts/config/deployments/robinhood-mainnet.json</code>, each read back on-chain.';

const ABIS =
  'Build the contracts and read them out of <code>contracts/out/</code>: VaultCore, Governance, FeeEngine, OperatorRegistry, ChainlinkOracle, AggregationRouterAdapter, SubVaultRegistry, VaultFactory.';

const WIRING =
  'Read <code>VaultFactory.allowSubVaults()</code> on the factory you integrate against; it is a per-deployment immutable, not a protocol property. Read <code>OperatorRegistry.operatorOf(vault)</code> rather than a display name: vault creation is permissionless, so verify the operator, not the label.';

const ROWS: ReadonlyArray<{ term: string; body: string }> = [
  { term: 'The chain', body: CHAIN },
  { term: 'The addresses', body: ADDRESSES },
  { term: 'The ABIs', body: ABIS },
  { term: 'The wiring you must check yourself', body: WIRING },
];

/**
 * Motion: the four rows enter in sequence, 0.5s each, 60ms apart — the same
 * grammar every other row list on this site uses. `Reveal` with a `stagger`
 * animates the direct children of the element it renders, and it animates them
 * FROM the resting state, which is what the prerendered markup already holds.
 * A reader with motion reduced, or one whose JavaScript never arrives, gets
 * the finished list; nothing here is gated on scroll, on an observer or on
 * React state, so every sentence above is in `dist/agents.html` unconditionally.
 *
 * The eyebrow and the heading are deliberately not revealed. On this page they
 * sit immediately under the hero's own enter sequence and are usually on
 * screen while it is still running, and a second animation stacked on the
 * first reads as the page still loading.
 */
export function AgentsBootstrap(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby="bootstrap-heading">
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id="bootstrap-heading" className={s.heading}>
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

export default AgentsBootstrap;
