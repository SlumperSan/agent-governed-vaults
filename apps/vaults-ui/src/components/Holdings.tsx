import type { BasketLeg, Vault } from '../lib/atlas';
import { usdcExact, wadExact } from '../lib/atlas';

interface Props {
  readonly vault: Vault;
  readonly nowSec: number;
}

/** WAD-scaled balance for display — `assetUnit`, never `decimals`: see `atlas.ts`'s `BasketLeg`. */
function balanceWad(leg: BasketLeg): bigint {
  return leg.assetUnit === 0n ? 0n : (leg.balance * 10n ** 18n) / leg.assetUnit;
}

/**
 * What the vault holds right now.
 *
 * `weightBps` is the TARGET the passed proposal set, and the share of NAV
 * beside it is what the position is actually worth at the current oracle
 * price. They drift apart between rebalances by design — nothing rebalances
 * until a proposal passes — so both are shown rather than one.
 *
 * A LEG WHOSE PRICE COULD NOT BE READ SHOWS "—", NOT "$0.00". `leg.priceWad`/`leg.valueWad` are
 * `null` when `priceWad()` reverted (see `live-vaults.ts`) — the same freeze condition that zeros
 * `vault.navWad`, one basket asset at a time. A null leg contributes nothing to `basketWad`'s sum
 * (there is no other honest number to add), so the weight percentages below are computed over
 * what could actually be priced, not over an assumed zero.
 */
export function Holdings({ vault, nowSec }: Props) {
  const legs = vault.basket;
  const basketWad = legs.reduce((acc, l) => acc + (l.valueWad ?? 0n), 0n);
  const idleWad = vault.idleUsdc * 10n ** 12n;
  const totalWad = basketWad + idleWad;

  const pct = (part: bigint | null): string =>
    part === null || totalWad === 0n ? '—' : `${(Number((part * 10000n) / totalWad) / 100).toFixed(2)}%`;

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
            const age = nowSec - leg.oracleUpdatedAt;
            const stale = age > leg.maxStalenessSec;
            return (
              <tr key={leg.address}>
                <th scope="row">{leg.symbol || `${leg.address.slice(0, 6)}…${leg.address.slice(-4)}`}</th>
                <td className="num">{wadExact(balanceWad(leg), { maxFrac: 6 })}</td>
                <td className="num">{leg.priceWad === null ? '—' : `$${wadExact(leg.priceWad, { maxFrac: 2 })}`}</td>
                <td className="num">{leg.valueWad === null ? '—' : `$${wadExact(leg.valueWad, { maxFrac: 2 })}`}</td>
                <td className="num">{pct(leg.valueWad)}</td>
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
        Values are the vault&rsquo;s own oracle reads. A stale leg is marked rather than hidden, and
        a leg whose price could not be read shows &ldquo;—&rdquo; rather than a fabricated $0: every
        NAV-reading path freezes on staleness, including exits.
      </p>
    </section>
  );
}
