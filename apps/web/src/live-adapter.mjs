// @ts-check
/**
 * Map the API's event-derived projection shapes into the display shapes the Vault Atlas UI renders.
 *
 * Honesty boundary: the metered API serves ONLY event-derived data (addresses, share counts,
 * operator P&L, sub-vault links, capacity). NAV/share, live basket weights, and proposal-phase
 * deadlines are chain-read enrichment the daemon does not yet expose over HTTP — so live mode fills
 * those with neutral placeholders and the UI shows a "live · structure only" banner rather than
 * inventing numbers. Pure functions, unit-tested; the browser hook lives in index.html.
 */

/** USDC base units (6dp) string → whole-dollar Number for display. */
export function usdFromBase(s) {
  try { return Number(BigInt(s ?? '0')) / 1e6; } catch { return 0; }
}

export function shortAddr(a) {
  return typeof a === 'string' && a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || '?');
}

/** /operators/leaderboard rows → UI operator rows (base units → dollars, address → short label). */
export function mapLeaderboard(rows) {
  return (rows ?? []).map((o, idx) => ({
    rank: idx + 1,
    operator: shortAddr(o.operator),
    operatorId: o.operatorId,
    net: usdFromBase(o.netRealizedUsdc),
    gain: usdFromBase(o.lifetimeGainUsdc),
    loss: usdFromBase(o.lifetimeLossUsdc),
    fees: usdFromBase(o.lifetimeFeesUsdc),
    vaultCount: o.vaultCount ?? 0,
  }));
}

/**
 * /vaults list (+ the leaderboard, to resolve operatorId → operator address) → UI vault cards.
 * @param {Array<object>} list       from /vaults
 * @param {Array<object>} board      from /operators/leaderboard (may be empty)
 * @param {number|string} lastBlock  from /health, for the "as of" line
 */
export function mapVaults(list, board, lastBlock) {
  const opById = new Map((board ?? []).map((o) => [o.operatorId, o]));
  return (list ?? []).map((v, i) => {
    const attested = v.attested ?? (v.operatorId !== 0);
    const op = opById.get(v.operatorId);
    return {
      i,
      vault: v.vault,
      name: `Vault ${shortAddr(v.vault)}`,
      operator: attested ? (op ? shortAddr(op.operator) : `operator #${v.operatorId}`) : 'unattested',
      operatorId: v.operatorId,
      verified: attested,
      unattested: !attested,
      // Chain-read enrichment not exposed over HTTP yet — neutral placeholders (see banner).
      navPs: 1.0,
      entryPs: 1.0,
      navUsd: 0,
      asOf: `block ${lastBlock ?? '—'}`,
      members: v.memberCount ?? 0,
      capUsd: usdFromBase(v.capacityCapUsdc),
      depth: v.depth ?? 0,
      parent: v.parent ?? null,
      exitFee: [0],
      basket: [],
      hist: [1],
      frozen: false,
      proposal: null,
      live: true,
    };
  });
}
