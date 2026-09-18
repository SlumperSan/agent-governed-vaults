import type { Vault } from '../lib/atlas';
import { legValueWad, usdcExact, wadExact } from '../lib/atlas';

interface Props {
  readonly vault: Vault;
  readonly nowSec: number;
}

/**
 * What the vault holds right now.
 *
 * `weightBps` is the TARGET the passed proposal set, and the share of NAV
 * beside it is what the position is actually worth at the current oracle
 * price. They drift apart between rebalances by design — nothing rebalances
 * until a proposal passes — so both are shown rather than one.
 */
export function Holdings({ vault, nowSec }: Props) {
  const legs = vault.basket;
  const basketWad = legs.reduce((acc, l) => acc + legValueWad(l), 0n);
  const idleWad = vault.idleUsdc * 10n ** 12n;
  const totalWad = basketWad + idleWad;

  const pct = (part: bigint): string =>
    totalWad === 0n ? '—' : `${(Number((part * 10000n) / totalWad) / 100).toFixed(2)}%`;

  return (
    <section className="panel">
      <h2>Holdings</h2>
      <table className="grid">
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col">Balance</th>
            <th scope="col">Oracle price</th>
            <th scope="col">Value</th>
            <th scope="col">Share of NAV</th>
            <th scope="col">Target</th>
            <th scope="col">Oracle age</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((leg) => {
            const value = legValueWad(leg);
            const age = nowSec - leg.oracleUpdatedAt;
            const stale = age > leg.maxStalenessSec;
            return (
              <tr key={leg.address}>
                <th scope="row">{leg.symbol}</th>
                <td className="num">{wadExact(leg.balance * 10n ** BigInt(18 - leg.decimals), { maxFrac: 6 })}</td>
                <td className="num">${wadExact(leg.priceWad, { maxFrac: 2 })}</td>
                <td className="num">${wadExact(value, { maxFrac: 2 })}</td>
                <td className="num">{pct(value)}</td>
                <td className="num dim">{(leg.weightBps / 100).toFixed(2)}%</td>
                <td className={stale ? 'num tag-warn' : 'num dim'}>
                  {age}s{stale ? ' · stale' : ''}
                </td>
              </tr>
            );
          })}
          <tr>
            <th scope="row">Idle USDC</th>
            <td className="num">{usdcExact(vault.idleUsdc, { unit: false })}</td>
            <td className="num dim">$1.00</td>
            <td className="num">${wadExact(idleWad, { maxFrac: 2 })}</td>
            <td className="num">{pct(idleWad)}</td>
            <td className="num dim">—</td>
            <td className="num dim">—</td>
          </tr>
        </tbody>
      </table>
      <p className="note">
        Values are the vault&rsquo;s own oracle reads. A stale leg is marked rather than hidden:
        every NAV-reading path freezes on staleness, including exits.
      </p>
    </section>
  );
}
