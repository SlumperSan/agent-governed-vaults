import { useMemo, useState } from 'react';
import { Holdings } from './components/Holdings';
import { ProposalPanel } from './components/ProposalPanel';
import { VaultList } from './components/VaultList';
import type { Vault, Wallet } from './lib/atlas';
import { NOW, usdcExact, VAULTS, WALLET, wadExact } from './lib/atlas';

/**
 * Vaults, proposals, votes, holdings — four reads over one vault.
 *
 * IT READS FIXTURES, NOT A CHAIN, AND THE PAGE SAYS SO. `apps/web/src/fixtures.mjs`
 * is the same fixture set the allocator front end's tests run against. Wiring this
 * to a live endpoint is a matter of replacing the two imports below with
 * `live-adapter.mjs`; nothing in the components knows where a vault came from.
 */
export function App() {
  const vaults = VAULTS as unknown as readonly Vault[];
  const wallet = WALLET as unknown as Wallet;
  const nowSec = NOW;

  const [selected, setSelected] = useState<string>(vaults[0]?.address ?? '');
  const vault = useMemo(() => vaults.find((v) => v.address === selected), [vaults, selected]);
  const position = useMemo(
    () => wallet.positions.find((p) => p.vault === selected),
    [wallet, selected],
  );

  return (
    <div className="shell">
      <header className="masthead">
        <h1>Vault Atlas</h1>
        <p className="note">
          An agent-operator proposes a basket. The members whose money it is vote it up or down by
          commit-reveal. Nothing rebalances until a proposal passes.
        </p>
        <p className="note dim">
          Rendering <code>apps/web/src/fixtures.mjs</code> — the allocator front end&rsquo;s test
          fixtures, not a live chain read.
        </p>
      </header>

      <div className="columns">
        <VaultList vaults={vaults} selected={selected} onSelect={setSelected} />

        {vault ? (
          <main className="detail">
            <section className="panel">
              <h2>{vault.name}</h2>
              <dl className="kv">
                <dt>Address</dt>
                <dd className="mono">{vault.address}</dd>
                <dt>Operator</dt>
                <dd>
                  {vault.operatorName} <span className="mono dim">{vault.operatorAddress}</span>
                </dd>
                <dt>NAV</dt>
                <dd>${wadExact(vault.navWad, { maxFrac: 2 })}</dd>
                <dt>NAV per share</dt>
                <dd>{wadExact(vault.navPerShareWad, { maxFrac: 6 })}</dd>
                <dt>Capacity cap</dt>
                <dd>{usdcExact(vault.capacityCapUsdc)}</dd>
                <dt>Holders</dt>
                <dd>{vault.holderCount}</dd>
              </dl>
              <p className="note">
                Operatorship confers no authority to vote, execute, pause, reprice, or move member
                funds.
              </p>
            </section>

            <section className="panel">
              <h2>Your position</h2>
              {position ? (
                <dl className="kv">
                  <dt>Shares</dt>
                  <dd>{wadExact(position.shares, { maxFrac: 6 })}</dd>
                  <dt>Cost basis</dt>
                  <dd>{usdcExact(position.costBasisUsdc)}</dd>
                  <dt>Queued for exit</dt>
                  <dd>{wadExact(position.queuedExitShares, { maxFrac: 6 })}</dd>
                </dl>
              ) : (
                <p className="note">This wallet holds no shares in this vault.</p>
              )}
            </section>

            <ProposalPanel vault={vault} nowSec={nowSec} />
            <Holdings vault={vault} nowSec={nowSec} />
          </main>
        ) : (
          <main className="detail">
            <p className="note">Select a vault.</p>
          </main>
        )}
      </div>
    </div>
  );
}
