import { useMemo, useState } from 'react';
import { Page } from './Shell';
import { Holdings } from './components/Holdings';
import { MemberActions } from './components/MemberActions';
import { ProposalPanel } from './components/ProposalPanel';
import { VaultList } from './components/VaultList';
import { WalletConnect } from './components/WalletConnect';
import { shortAddress, wadExact } from './lib/atlas';
import { useLiveVaults } from './lib/live-vaults';
import { WalletProvider } from './lib/wallet';

/**
 * Vaults, proposals, votes, holdings — four reads over one vault, plus deposit/vote/exit for a
 * connected wallet.
 *
 * LIVE CHAIN READS, NOT FIXTURES. Plan item 0.7. `useLiveVaults` (`src/lib/live-vaults.ts`) is the
 * only place this component gets a `Vault` from — no `apps/web/src/fixtures.mjs` import exists
 * anywhere in this workspace's `src/`, and `test/csp.test.mjs` fails the build if one reaches
 * `dist/`.
 *
 * THE FOUR STATES `Fetched` NAMES ARE ALL RENDERED BELOW, on purpose: `loading` and `error` render
 * their own screens rather than falling through to a `Vault` shape with a field left `undefined` —
 * an unresolved read must never look like a `0`, which is the false claim plan item 0.7 exists to
 * close.
 *
 * `<MemberActions>` (deposit/vote/exit, plan item 0.2) signs against whatever chain the connected
 * wallet is on — via its own `publicClient`/`walletClient` in `lib/wallet.tsx`, independent of the
 * read-only client `useLiveVaults` builds — but the `vault` it receives is now the SAME live
 * object this page renders everywhere else, not a fixture: `MemberActions`'s own fixture-address
 * guard (`vault.address` must look like a real address) is no longer reachable with a fixture
 * `vault.address` in play, because there is no fixture `vault.address` left to reach it with.
 */
export function App() {
  return (
    <WalletProvider>
      <AppShell />
    </WalletProvider>
  );
}

function AppShell() {
  const fetched = useLiveVaults();
  const nowSec = Math.floor(Date.now() / 1000);

  const vaults = fetched.kind === 'ready' ? fetched.data : [];
  const [selected, setSelected] = useState<string>('');
  const activeSelection = selected || (vaults[0]?.address ?? '');
  const vault = useMemo(
    () => vaults.find((v) => v.address === activeSelection),
    [vaults, activeSelection],
  );

  return (
    <Page current="/">
      <header className="masthead">
        <h1>RWAlly</h1>
        {/* Chairman directive, cutover condition: this line gates app.rwally.com going live on
         * Base Sepolia. UNCONDITIONAL on purpose — not gated on `fetched.kind`, freshness, or any
         * other read, because a read that can fail is a disclosure that can vanish, and its
         * absence here would read as "this is mainnet". Verbatim text, do not paraphrase. */}
        <p className="note tag-warn">Reading Base Sepolia testnet. No vault holds real funds yet.</p>
        <p className="note">
          An agent-operator proposes a basket. The members whose money it is vote it up or down by
          commit-reveal. Nothing rebalances until a proposal passes.
        </p>
        <p className="note faint">
          {fetched.kind === 'ready' && fetched.freshness['rpcUrl']
            ? `Live chain read via ${String(fetched.freshness['rpcUrl'])} — nothing on this page is a bundled sample.`
            : 'Every figure on this page is a direct chain read — nothing here is a bundled sample.'}
        </p>
        <WalletConnect />
      </header>

      {fetched.kind === 'loading' ? (
        <div className="columns">
          <div className="detail">
            <p className="note" role="status" aria-live="polite">
              Reading the chain…
            </p>
          </div>
        </div>
      ) : fetched.kind === 'empty' ? (
        <div className="columns">
          <div className="detail">
            <p className="note">{fetched.message}</p>
          </div>
        </div>
      ) : fetched.kind === 'error' ? (
        <div className="columns">
          <div className="detail">
            <p className="note tag-warn">{fetched.message}</p>
            {fetched.detail ? <p className="note dim">{fetched.detail}</p> : null}
          </div>
        </div>
      ) : (
        <div className="columns">
          <VaultList vaults={vaults} selected={activeSelection} onSelect={setSelected} />

          {vault ? (
            <div className="detail">
              <section className="panel">
                <h2>{vault.name || shortAddress(vault.address)}</h2>
                <dl className="kv">
                  <dt>Address</dt>
                  <dd className="mono">{vault.address}</dd>
                  <dt>Operator</dt>
                  <dd>
                    {vault.operatorName || 'Unnamed'}{' '}
                    <span className="mono dim">{vault.operatorAddress}</span>
                  </dd>
                  <dt>NAV</dt>
                  <dd>
                    {vault.frozen ? (
                      <span className="tag tag-warn">frozen — NAV unavailable</span>
                    ) : (
                      `$${wadExact(vault.navWad, { maxFrac: 2 })}`
                    )}
                  </dd>
                  <dt>NAV per share</dt>
                  <dd>{vault.frozen ? '—' : wadExact(vault.navPerShareWad, { maxFrac: 6 })}</dd>
                  <dt>Holders</dt>
                  <dd>{vault.holderCount}</dd>
                </dl>
                <p className="note">
                  Operatorship confers no authority to vote, execute, pause, reprice, or move member
                  funds.
                </p>
              </section>

              <ProposalPanel vault={vault} nowSec={nowSec} />
              <Holdings vault={vault} nowSec={nowSec} />
              <MemberActions vault={vault} />
            </div>
          ) : (
            <div className="detail">
              <p className="note">Select a vault.</p>
            </div>
          )}
        </div>
      )}
    </Page>
  );
}
