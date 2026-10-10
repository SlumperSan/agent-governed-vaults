import { shortAddress } from '../lib/atlas';
import { TARGET_CHAIN } from '../lib/chains';
import { useWallet } from '../lib/wallet';
import { SANCTIONS_REFUSAL_MESSAGE, SANCTIONS_LIST_STALE_MESSAGE, sdnListAgeDays, SDN_LIST_MAX_AGE_DAYS } from '../lib/sanctions';

/**
 * Connect / account / network banner. Lives in the header, independent of which vault is
 * selected — a wallet connects to a CHAIN, not to a vault.
 */
export function WalletConnect() {
  const { status, address, providers, error, sanctioned, connect, disconnect, switchToTarget } = useWallet();
  // Card 217: the same runtime freshness guard `assertNotSanctioned` enforces on every write,
  // surfaced here so a stale list is visible BEFORE a member tries a write and hits the refusal
  // cold. Computed at render, not stored in `wallet.tsx`'s state — unlike `sanctioned`, staleness
  // does not depend on which address is connected, only on the vendored list's own age.
  const listStale = sdnListAgeDays() > SDN_LIST_MAX_AGE_DAYS;

  if (status === 'disconnected' || (status === 'connecting' && !address)) {
    return (
      <div className="wallet-connect">
        {providers.length > 1 ? (
          <div className="wallet-picker">
            {providers.map((p) => (
              <button key={p.uuid} type="button" className="btn" onClick={() => void connect(p.uuid)}>
                Connect {p.name}
              </button>
            ))}
          </div>
        ) : (
          <button type="button" className="btn" onClick={() => void connect()} disabled={status === 'connecting'}>
            {status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
          </button>
        )}
        {error ? <p className="note tag-warn">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="wallet-connect">
      <span className="mono">{shortAddress(address)}</span>
      {status === 'wrong-network' ? (
        <>
          <span className="tag tag-warn">wrong network</span>
          <button type="button" className="btn" onClick={() => void switchToTarget()}>
            Switch to {TARGET_CHAIN.name}
          </button>
        </>
      ) : status === 'switching' ? (
        <span className="dim">switching…</span>
      ) : (
        <span className="tag">{TARGET_CHAIN.name}</span>
      )}
      <button type="button" className="btn btn-ghost" onClick={disconnect}>
        Disconnect
      </button>
      {error ? <p className="note tag-warn">{error}</p> : null}
      {sanctioned ? <p className="note tag-warn">{SANCTIONS_REFUSAL_MESSAGE}</p> : null}
      {listStale ? <p className="note tag-warn">{SANCTIONS_LIST_STALE_MESSAGE}</p> : null}
    </div>
  );
}
