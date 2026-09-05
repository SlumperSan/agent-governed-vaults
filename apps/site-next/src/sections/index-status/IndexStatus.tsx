/**
 * index-status — "On Robinhood Chain mainnet. Here is the ledger."
 *
 * REWRITTEN 2026-09-05. This section used to render the NO-GO launch verdict,
 * the three pre-launch status cards and the security-review attestation — all
 * of that content moved off index.html entirely in the owner's 2026-09-05
 * copy deck. status.html is now the neutral address ledger and
 * disclaimers.html carries the launch verdict and the security-review
 * attestation (see risks-review-status for the latter). This section's
 * corpus counterpart is "The record": one eyebrow, one h2, three short
 * paragraphs and one action button pointing at status.html — nothing here
 * counts, verdicts or grades anything, on the same reasoning the old
 * doc-comment gave for the retired verdict chip: a number that performs on
 * this page is a number a reader stops believing.
 *
 * Every string below is lifted byte-for-byte from `apps/site/index.html`'s
 * "The record" section (grep `On Robinhood Chain mainnet. Here is the
 * ledger.`).
 *
 * MOTION. The intro block and the two paragraphs fade and rise on enter,
 * matching every other prose section on this page. Nothing here pins, scrubs
 * or parallaxes. The resting state is the prerendered state, so a reader with
 * motion reduced — and the guards, which read the built file — see the
 * finished section either way.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import s from './IndexStatus.module.css';

/**
 * The brief's figure for this section. It sits inside the 0.24-0.8s band that
 * src/motion/easings.ts defines for UI motion, and it is stated once here
 * rather than at four call sites.
 */
const ENTER_SECONDS = 0.6;

/** The h2 is the section's accessible name. An id, not new copy. */
const HEADING_ID = 'the-record';

const LEDE =
  'The protocol was broadcast to Robinhood Chain mainnet, chain id 4663, on 2026-09-05, from <code>protocol/main</code> at <code>b1cde122</code>. Ten transactions, every receipt status 1, the six singletons in one block.';

const BODY_ONE =
  'Every address, block and wiring readback is on the status page, and every one of them was read back on-chain rather than transcribed from a deploy log. The factory was constructed with <code>allowSubVaults = false</code>, so it deploys root vaults only. The oracle allowlist is enforced, and one oracle is blessed on it. No vault has been created yet: <code>factory.vaultCount()</code> returns 0. The index vault below is not among them: no vault has been created, and the all-stocks index needs its own deployment.';

const BODY_TWO =
  'This page publishes no addresses. The address ledger is <code>contracts/config/deployments/robinhood-mainnet.json</code>, the status page reads it out, and that file rather than either page is the authority.';

export default function IndexStatus(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <Reveal className={s.intro} duration={ENTER_SECONDS}>
          <p className={s.eyebrow}>The record</p>
          <h2 id={HEADING_ID} className={s.heading}>
            On Robinhood Chain mainnet. Here is the ledger.
          </h2>
          <Pinned as="p" className={s.lede} html={LEDE} />
          <Pinned as="p" className={s.body} html={BODY_ONE} />
          <Pinned as="p" className={s.body} html={BODY_TWO} />

          <div className={s.actions}>
            <a className={`${s.btn} ${s.btnLead}`} href="status.html">
              The full ledger
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
