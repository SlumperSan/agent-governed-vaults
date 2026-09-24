import { shortAddress } from '../lib/atlas';
import { TARGET_CHAIN } from '../lib/chains';
import { useWallet } from '../lib/wallet';
import { SANCTIONS_REFUSAL_MESSAGE } from '../lib/sanctions';

/**
 * Connect / account / network banner. Lives in the header, independent of which vault is
 * selected — a wallet connects to a CHAIN, not to a vault.
 */
export function WalletConnect() {
  const { status, address, providers, error, sanctioned, connect, disconnect, switchToTarget } = useWallet();

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
    </div>
  );
}
