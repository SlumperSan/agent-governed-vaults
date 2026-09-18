import type { Vault } from '../lib/atlas';
import { usdcCompact, wadExact } from '../lib/atlas';

interface Props {
  readonly vaults: readonly Vault[];
  readonly selected: string;
  readonly onSelect: (address: string) => void;
}

/**
 * The vault list. NAV is printed from `navWad`, which the vault computes from
 * its own oracle reads — this component does no valuation of its own.
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
                <span className="vault-row-name">{v.name}</span>
                <span className="vault-row-meta">
                  {usdcCompact(v.navWad / 10n ** 12n)} NAV · {v.holderCount} holders
                </span>
                <span className="vault-row-meta dim">
                  operator {v.operatorName} · {wadExact(v.navPerShareWad, { maxFrac: 4 })} per share
                </span>
                {v.frozen ? <span className="tag tag-warn">frozen</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
