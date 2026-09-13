/**
 * api-docs — the whole body of api.html, the page for a program reading this
 * protocol rather than a person reading a screen.
 *
 * WHY THIS PAGE EXISTS AND WHY IT SHIPS WITH NO ENDPOINT BEHIND IT YET. The
 * project's goal is a metered HTTP read of this protocol's on-chain state,
 * priced per call and paid for over the x402 protocol. `apps/site/agents.html`
 * (the retired nine-page site's precedent, PR #154) did this once already for
 * a different surface; this is that page's equivalent for the redesign, for a
 * different reason than the redesign collapsed everything else to two pages.
 *
 * WHAT THIS PAGE DOES NOT DO: describe a payload shape, a price, or a header
 * name it cannot point at in `protocol/main`, AND IT DOES NOT ENUMERATE PR
 * STATE IN ITS OWN SHIPPED COPY, because a PR's open/merged status goes stale
 * on someone else's schedule and this file's own first version got that stale
 * before it ever reached a reader: it said "four open pull requests ... none
 * is merged" while #272 had already merged, 18 minutes before the commit that
 * shipped that sentence (#272 merged 2026-09-13T14:06:34Z; that commit landed
 * 14:24Z, and later merges from `protocol/main` pulled #272 into this
 * branch's own history, so the claim was false when written, not merely
 * stale by the time it was read). Caught in review on PR #274. The fix is not
 * a bigger number, it is not naming a count at all: the shipped paragraph
 * below states the dated absence of the three files and the live-vs-snapshot
 * ambiguity as a design question, and leaves PR bookkeeping out of it.
 *
 * FOR A CONTRIBUTOR READING THIS COMMENT RATHER THAN THE RENDERED PAGE,
 * re-checked 2026-09-13 after merging `protocol/main` into this branch:
 * `apps/site-next/functions/api/vaults.js`, `functions/.well-known/x402.js`
 * and `docs/REVENUE.md` are still absent from `protocol/main`. Three pull
 * requests remain open toward them — #267 (a pinned snapshot), #270 (a buyer
 * client and integration doc), #271 (replaces #267's snapshot with a live
 * chain read) — and #272 (a standards-track facilitator) merged
 * 2026-09-13T14:06:34Z; `git merge-base --is-ancestor` confirms it is an
 * ancestor of this branch's head, and it does not touch any of the three
 * files above. This paragraph will ALSO go stale; re-derive it with
 * `gh pr list --state open --base protocol/main` and `gh pr view <n> --json
 * state,mergedAt` rather than trusting the numbers above past the date on
 * them.
 *
 * WHAT IT DOES INSTEAD: state what already exists on chain 4663, verified
 * directly against the chain with `cast call` on 2026-09-13 (commands
 * reproduced in `Facts` below, copy-pasteable), because that half of the
 * claim does not depend on which PR merges. The two facts sections read from
 * `contracts/config/deployments/robinhood-mainnet.json`'s own recorded
 * values, cross-checked live rather than quoted from that file uncrossed.
 */
import type { JSX } from 'react';
import { REPO_URL } from '../../shell/pinned';
import s from './ApiDocs.module.css';

const EYEBROW = 'For agents';

const TITLE = 'Reading the vaults as data, not as a page.';

const LEDE =
  'This page is for a program calling this protocol over HTTP, not a person reading a screen. It states three things: what is on chain 4663 right now, what a metered read is designed to answer once it ships, and what it will not answer.';

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY = '0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1';
const VAULT_1 = '0x9b0229FF0613EaD59e41Eec556e03b5ED228e2b4';
const VAULT_2 = '0x03E121e18c68B48B84a60D8F93BcD7D5be31ee38';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

export default function ApiDocs(): JSX.Element {
  return (
    <>
      <section className={s.hero}>
        <div className="wrap">
          <p className={s.eyebrow}>{EYEBROW}</p>
          <h1 className={s.title}>{TITLE}</h1>
          <p className={s.lede}>{LEDE}</p>
        </div>
      </section>

      <section className={s.body}>
        <div className="wrap">
          <h2>What exists on chain 4663 today</h2>
          <p>
            Two vaults exist, both created by VaultFactory <code className="mono">{FACTORY}</code>.
            Read directly from the chain on 2026-09-13, at block 62,072,887:
            <code className="mono"> factory.vaultCount()</code> returns 2, and{' '}
            <code className="mono">allVaults(0)</code> /<code className="mono"> allVaults(1)</code>{' '}
            return the two addresses below.
          </p>
          <dl className={s.facts}>
            <div className={s.fact}>
              <dt>{VAULT_1}</dt>
              <dd>
                Created 2026-09-10. Holds 20,000,000 units of USDG
                (<code className="mono">{USDG}</code>, 6 decimals, <code className="mono">symbol()</code> reads
                &quot;USDG&quot;, <code className="mono">name()</code> reads &quot;Global Dollar&quot; — this is not
                Circle&apos;s USDC, despite filling that role in the configuration) — 20 USDG, idle.
              </dd>
            </div>
            <div className={s.fact}>
              <dt>{VAULT_2}</dt>
              <dd>
                Created 2026-09-12. Holds 0 USDG and 1,980,483,895,862,031 wei of WETH
                (<code className="mono">{WETH}</code>, 18 decimals) — about 0.00198 WETH, a traded
                position rather than cash, from a proposal that moved its whole balance.
              </dd>
            </div>
          </dl>
          <p className="small">Reproduce either figure yourself:</p>
          <code className={s.command}>
            {`cast call ${USDG} "balanceOf(address)(uint256)" ${VAULT_1} --rpc-url ${RPC_URL}`}
          </code>
        </div>
      </section>

      <section className={s.body}>
        <div className="wrap">
          <h2>The metered read (not shipped yet)</h2>
          <p>
            A second way to reach the same state is designed: an HTTP endpoint that answers a
            vault&apos;s on-chain state as JSON, priced per call and paid for over the x402 protocol
            in USDC on Base mainnet — a different chain from the one the data comes from. A free
            discovery document is meant to state the exact price and payment details before any USDC
            moves; once it exists, it publishes at <code className="mono">/.well-known/x402</code> on
            this domain.
          </p>
          <p>
            Read on 2026-09-13 against <code className="mono">origin/protocol/main</code>: none of
            these three files exists in this repository&apos;s default branch. No{' '}
            <code className="mono">functions/api/vaults.js</code>, no{' '}
            <code className="mono">functions/.well-known/x402.js</code>, no{' '}
            <code className="mono">docs/REVENUE.md</code>. Work toward the endpoint is in progress,
            and which design lands — a live call to the chain each time, or a periodically refreshed
            snapshot — is not decided by this page or fixed by anything merged as of this date. Read{' '}
            <code className="mono">/.well-known/x402</code> yourself once it exists, and treat that
            document as the source of truth this page is not.
          </p>
          <p>
            The price is not published here for the same reason: nothing merged as of this date fixes
            a number. The discovery document states the price that is actually charged.
          </p>
        </div>
      </section>

      <section className={s.body}>
        <div className="wrap">
          <h2>What it will not include</h2>
          <ul className={s.list}>
            <li>
              No history. A call answers what is true at the moment it is served, not a time series —
              anyone who wants a history has to poll and store their own reads.
            </li>
            <li>
              No Base-chain data. Payment is designed to happen on Base; the data it buys is read from
              chain 4663 only, and the two are not the same chain.
            </li>
            <li>
              No governance state beyond a vault&apos;s own balances and position — proposals, votes
              and the reveal-phase clock live in the separate Governance contract, and a read of one
              vault&apos;s state does not describe them.
            </li>
            <li>
              No claim about whether a position is a good one to hold. The response states what a
              vault holds, not what happens to its value next.
            </li>
          </ul>
        </div>
      </section>

      <section className={s.body}>
        <div className="wrap">
          <h2>Why call the endpoint instead of the chain yourself</h2>
          <p>
            The chain is the source either way. The endpoint is designed to read the same
            VaultFactory and vault contracts a client can call directly, for nothing, from any RPC
            node against chain 4663. What a metered read is for is doing that assembly over plain
            HTTP, for a caller that would rather not hold an RPC endpoint, a client library and the
            contracts&apos; ABIs. That convenience is what is being sold; nothing about a vault&apos;s
            own state changes because a read of it was purchased.
          </p>
        </div>
      </section>

      <section className={s.body}>
        <div className="wrap">
          <h2>Verify any of this yourself</h2>
          <p>
            Every number above came from <code className="mono">cast call</code> against{' '}
            <code className="mono">{RPC_URL}</code>, run on 2026-09-13. Re-run it, or read{' '}
            <code className="mono">contracts/config/deployments/robinhood-mainnet.json</code> in the
            repository for the same figures with their own block heights and read-back method.
          </p>
          <p>
            <a className="quiet" href={REPO_URL} rel="noopener">
              Source and docs
            </a>
          </p>
        </div>
      </section>
    </>
  );
}
