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

/**
 * /vaults rows → the record shape `vault-view.mjs` consumes.
 *
 * `mapVaults` above is left exactly as it was (live-adapter.test.mjs pins its output); this is an
 * addition, not a replacement.
 *
 * WHAT IS NULL HERE IS NULL ON PURPOSE. The metered API serves only event-derived projections, so
 * NAV, basket composition, the per-vault exit-fee parameters, oracle freshness and proposal
 * deadlines have no source and are returned as `null` rather than as a plausible number. Every
 * consumer treats null as "unknown" and says so on screen. The one field the projection *could*
 * carry but does not is per-member pending state: `DepositPending(member, amountUsdc, availableAt)`
 * is emitted and indexed, but `projections.mjs` folds it to an aggregate `pendingCount` and drops
 * both the member and the activation time.
 *
 * @param {Array<object>} list  from /vaults
 * @param {Array<object>} board from /operators/leaderboard
 */
export function mapVaultRecords(list, board) {
  const opById = new Map((board ?? []).map((o) => [o.operatorId, o]));
  return (list ?? []).map((v) => {
    const attested = v.attested ?? (v.operatorId !== 0);
    const op = opById.get(v.operatorId);
    return {
      address: v.vault,
      name: `Vault ${shortAddr(v.vault)}`,
      operatorName: attested ? (op ? shortAddr(op.operator) : `Operator #${v.operatorId}`) : null,
      operatorAddress: op?.operator ?? null,
      operatorId: v.operatorId,
      attested,
      depth: v.depth ?? 0,
      parent: v.parent ?? null,

      // Event-derived and real:
      holderCount: v.memberCount ?? 0,
      capacityCapUsdc: v.capacityCapUsdc ?? '0',

      // Chain-read enrichment the API does not expose — unknown, not zero:
      frozen: false,
      chainRead: false,
      totalShares: null,
      navWad: null,
      navPerShareWad: null,
      idleUsdc: null,
      totalPendingUsdc: null,
      minDepositUsdc: null,
      exitFeeMaxBps: null,
      exitFeeDecayPeriodSec: null,
      exitFeeMaxBpsByLevel: [],
      basket: [],
      proposal: null,
      governanceConfig: null,
    };
  });
}

/** The fields `mapVaultRecords` cannot fill, and why — rendered verbatim in the live-mode banner. */
export const MISSING_IN_LIVE = Object.freeze([
  ['NAV, NAV/share, basket composition', 'events carry no post-swap balances or prices; needs a chain read'],
  ['Oracle freshness / frozen state', 'OracleAggregator is read directly, never emitted'],
  ['Proposal deadlines — so exit Mode I vs F', 'Governance.Proposed emits no commitDeadline; the mode turns on it'],
  ['Exit-fee ceiling and decay period', 'immutable VaultCore constructor args, not in any event'],
  ['Your position, pending deposit and queued exit', 'per-member projections do not exist; ExitQueued is not indexed at all'],
]);
