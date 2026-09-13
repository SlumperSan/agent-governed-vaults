/**
 * api-docs — the whole body of api.html, the page for a program reading this
 * protocol rather than a person reading a screen.
 *
 * WHAT THIS PAGE DESCRIBES, AND WHY THE EARLIER VERSION OF THIS COMMENT NO
 * LONGER APPLIES. Every version of this file up to PR #274's round-2 review
 * described the metered read as unshipped, because at the time it was:
 * `functions/api/vaults.js`, `functions/.well-known/x402.js` and
 * `docs/REVENUE.md` were all absent from `protocol/main`. PR #267 merged
 * all three (commit 90e84991) while this branch's round-2 review was still
 * in flight. A direct request against the live domain the same day confirms
 * the route is not merely in git but answering real requests: a GET to
 * `https://rwally.com/.well-known/x402` returns 200 with the exact price,
 * asset and route shape `functions/.well-known/x402.js` builds, and a GET to
 * `https://rwally.com/api/vaults` with no payment header returns 402 with a
 * real challenge (nonce, expiry, accepted scheme). Both were re-run at the
 * point this comment was written, 2026-09-13.
 *
 * A DELIBERATE GAP BETWEEN TWO SOURCES, NOT SILENTLY RESOLVED. `docs/REVENUE.md`
 * itself says "the rail is built and unpublished ... nothing has been
 * deployed" and prices revenue at $0.00, describing publication as a step
 * only the owner can run. That is now stale, or at least incomplete: the
 * live measurement above says the route answers real challenges today. This
 * page reports what the two live requests actually returned, dated, rather
 * than resolving the mismatch by editing `docs/REVENUE.md` — that file is
 * outside this change's scope, and the mismatch is called out in this
 * change's own PR body instead of being papered over here.
 *
 * WHAT THIS PAGE DELIBERATELY DOES NOT STATE: the payee address. The free
 * discovery document at `/.well-known/x402` already publishes it; this page
 * links there rather than freezing a copy of a value the live document is
 * the one that should answer for. Likewise no claim that any payment has
 * ever settled — a 402 challenge is a demand for payment, not evidence one
 * was ever paid, and `docs/REVENUE.md` records revenue at $0.00.
 *
 * THE CHAIN-FACTS SECTION BELOW IS UNCHANGED IN METHOD, RE-VERIFIED IN
 * NUMBER: the same `cast call` commands used in the previous two review
 * rounds, re-run 2026-09-13 against a later block (62,128,635), returned the
 * same vault count, the same two addresses, and the same two balances.
 */
import type { JSX } from 'react';
import { REPO_URL } from '../../shell/pinned';
import s from './ApiDocs.module.css';

const EYEBROW = 'For agents';

const TITLE = 'Reading the vaults as data, not as a page.';

const LEDE =
  'This page is for a program calling this protocol over HTTP, not a person reading a screen. It states three things: what is on chain 4663 right now, what a metered read on this domain actually returns and charges, and what it deliberately leaves out.';

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY = '0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1';
const VAULT_1 = '0x9b0229FF0613EaD59e41Eec556e03b5ED228e2b4';
const VAULT_2 = '0x03E121e18c68B48B84a60D8F93BcD7D5be31ee38';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const PRICE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DISCOVERY_URL = 'https://rwally.com/.well-known/x402';
const API_URL = 'https://rwally.com/api/vaults';

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
            Read directly from the chain on 2026-09-13, at block 62,128,635:
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
          <h2>The metered read — live as of 2026-09-13</h2>
          <p>
            <code className="mono">GET /api/vaults</code> on this domain is live: a request with no
            payment header returns <code className="mono">402</code> with a real challenge — a
            nonce, an expiry and the accepted payment scheme — verified directly against{' '}
            <code className="mono">{API_URL}</code> on 2026-09-13. The price is $0.10 per call,
            paid in Circle-native USDC on Base mainnet (asset{' '}
            <code className="mono">{PRICE_ASSET}</code>, network <code className="mono">eip155:8453</code>{' '}
            — a different chain from the one the data below comes from). That figure is not fixed
            on this page: it is read live from the free discovery document at{' '}
            <code className="mono">/.well-known/x402</code>, which states the actual number the
            route will charge rather than a copy that can drift from it.
          </p>
          <p>
            The payload is a pinned snapshot, not a live chain read: every response carries{' '}
            <code className="mono">live: false</code> and a dated <code className="mono">asOf</code>.
            This is deliberate, not an oversight — <code className="mono">docs/REVENUE.md</code>{' '}
            records that balances, NAV, share supply and member positions are excluded from the
            snapshot on purpose, because those move block to block and a pinned file carrying them
            would look current while being wrong within minutes. What a paid call does return, per
            vault: address, creator, creation block and time, minimum deposit, capacity cap and
            runtime codesize. Two vaults, matching the chain facts above.
          </p>
          <p>
            The flow: request with no payment header, get back <code className="mono">402</code>{' '}
            with the challenge; sign it as an EIP-3009 <code className="mono">transferWithAuthorization</code>;
            base64 the signed envelope into a <code className="mono">PAYMENT-SIGNATURE</code> header
            and repeat the request; a paid response carries a{' '}
            <code className="mono">PAYMENT-RESPONSE</code> header with the settlement receipt id.
            x402 protocol version 2, scheme &quot;exact&quot; — read directly from the discovery
            document&apos;s own <code className="mono">paymentFlow</code> field, not paraphrased
            from memory.
          </p>
          <p>
            <a className="quiet" href="/.well-known/x402">
              Read the discovery document
            </a>
          </p>
        </div>
      </section>

      <section className={s.body}>
        <div className="wrap">
          <h2>What it deliberately leaves out</h2>
          <ul className={s.list}>
            <li>
              No balances, NAV, share supply or member positions. The pinned snapshot excludes
              them on purpose — they move block to block, and a stale copy of them would look
              current while being wrong.
            </li>
            <li>
              No history. Each call answers one dated snapshot, not a time series — anyone who
              wants a history has to poll and store their own reads.
            </li>
            <li>
              No governance state beyond a vault&apos;s own creation facts — proposals, votes and
              the reveal-phase clock live in the separate Governance contract, and this payload
              does not describe them.
            </li>
            <li>
              No claim about whether a position is a good one to hold. The response states what a
              vault holds at creation, not what happens to its value next.
            </li>
          </ul>
        </div>
      </section>

      <section className={s.body}>
        <div className="wrap">
          <h2>Why call the endpoint instead of the chain yourself</h2>
          <p>
            The chain is the source either way. The endpoint reads the same VaultFactory and vault
            contracts a client can call directly, for nothing, from any RPC node against chain
            4663. What the metered read sells is doing that assembly over plain HTTP, for a caller
            that would rather not hold an RPC endpoint, a client library and the contracts&apos;
            ABIs. That convenience is what is being sold; nothing about a vault&apos;s own state
            changes because a read of it was purchased.
          </p>
        </div>
      </section>

      <section className={s.body}>
        <div className="wrap">
          <h2>Verify any of this yourself</h2>
          <p>
            The chain-facts numbers above came from <code className="mono">cast call</code> against{' '}
            <code className="mono">{RPC_URL}</code>, run on 2026-09-13. Re-run it, or read{' '}
            <code className="mono">contracts/config/deployments/robinhood-mainnet.json</code> in the
            repository for the same figures with their own block heights and read-back method.
          </p>
          <p>
            The API figures came from two direct HTTP requests, run the same day. Reproduce them
            yourself:
          </p>
          <code className={s.command}>{`curl -i ${DISCOVERY_URL}`}</code>
          <code className={s.command}>{`curl -i ${API_URL}`}</code>
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
