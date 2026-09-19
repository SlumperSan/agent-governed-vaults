import type { Vault } from '../lib/atlas';
import { shortAddress, usdcCompact, wadExact } from '../lib/atlas';

interface Props {
  readonly vaults: readonly Vault[];
  readonly selected: string;
  readonly onSelect: (address: string) => void;
}

/**
 * The vault list. NAV is printed from `navWad`, which the vault computes from
 * its own oracle reads — this component does no valuation of its own.
 *
 * A FROZEN VAULT'S NAV IS NOT PRINTED AS A NUMBER. `navWad`/`navPerShareWad` are `0n` on a frozen
 * vault (`chain-reader.mjs`'s own convention — the number is a stand-in, `frozen` is the fact), so
 * rendering them unconditionally would print "$0.00 NAV" on a vault that is very much not worth
 * nothing. Branch on `frozen` before either is shown as currency.
 */
export function VaultList({ vaults, selected, onSelect }: Props) {
  return (
    <nav className="panel" aria-label="Vaults">
      <h2>Vaults</h2>
      <ul className="vault-list">
        {vaults.map((v) => {
          const isSel = v.address === selected;
          return (
            <li key={v.address}>
              <button
                type="button"
                className={isSel ? 'vault-row is-selected' : 'vault-row'}
                aria-current={isSel ? 'true' : undefined}
                onClick={() => onSelect(v.address)}
              >
                <span className="vault-row-name">{v.name || shortAddress(v.address)}</span>
                <span className="vault-row-meta">
                  {v.frozen ? 'NAV unavailable' : `${usdcCompact(v.navWad / 10n ** 12n)} NAV`} ·{' '}
                  {v.holderCount} holders
                </span>
                <span className="vault-row-meta dim">
                  operator {v.operatorName || shortAddress(v.operatorAddress)} ·{' '}
                  {v.frozen ? '—' : wadExact(v.navPerShareWad, { maxFrac: 4 })} per share
                </span>
                {v.frozen ? <span className="tag tag-warn">frozen</span> : null}
                {!v.attested ? <span className="tag tag-warn">unattested</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
