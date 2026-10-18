// @ts-check
/**
 * The reducer. Pure: events in, per-address cost-basis USDC-seconds out. No clock, no network.
 *
 * Per (vault, member) it keeps exactly what the contract keeps:
 *   - `shares`: set to the third field of `DepositActivated` (a balance after the deposit, not an
 *     amount minted; see abis.mjs), reduced by `sharesBurned` on `ExitSettled`.
 *   - `basis`: `+ amountUsdc` on a deposit; on an exit `- basis * sharesBurned / sharesBefore`, floored,
 *     which is the contract's own rule (`basisRemoved = costBasisUsdc[member] * burnShares / memberShares`).
 *     So `basis` equals the contract's public `costBasisUsdc(member)` at every block, and the
 *     head-state check in consistency.mjs compares them.
 *
 * Measurement: the integral of `basis` over time, clipped to the window [windowStart, windowEnd).
 * Accumulated as a BigInt in raw-USDC-seconds and divided exactly once, at render time, so how the
 * logs were chunked or ordered cannot change a digit. A balance change stamped at time t applies from
 * t onward; two changes in one block integrate over zero seconds.
 */

/**
 * @typedef {object} LedgerEvent
 * @property {'deposit' | 'exit'} type
 * @property {string} vault          lowercase address
 * @property {string} member         lowercase address
 * @property {bigint} [amountUsdc]   deposit: raw USDC put in
 * @property {bigint} [sharesAfter]  deposit: the member's share balance after the deposit
 * @property {bigint} [sharesBurned] exit
 * @property {number} blockNumber
 * @property {number} logIndex
 * @property {number} timestamp      block timestamp, unix seconds
 */

/**
 * @typedef {object} PositionState
 * @property {string} vault
 * @property {string} member
 * @property {bigint} shares
 * @property {bigint} basis
 */

/**
 * @param {readonly LedgerEvent[]} events any order; sorted here by (blockNumber, logIndex)
 * @param {{windowStart: number, windowEnd: number}} window integrate over [windowStart, windowEnd)
 * @returns {{usdcSeconds: Map<string, bigint>, positions: Map<string, PositionState>}}
 *   `usdcSeconds` by member address (summed over vaults, only members with a positive total);
 *   `positions` is the state after EVERY event, including those after windowEnd, for the head check.
 */
export function reduce(events, { windowStart, windowEnd }) {
  if (!Number.isSafeInteger(windowStart) || !Number.isSafeInteger(windowEnd) || windowEnd < windowStart) {
    throw new Error(`ledger: bad window [${windowStart}, ${windowEnd})`);
  }
  const ordered = [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  /** @type {Map<string, PositionState & {lastTs: number}>} */
  const state = new Map();
  /** @type {Map<string, bigint>} */
  const acc = new Map();
  let prev = null;

  /** Add basis * (overlap of [from, to) with the window) for one position. */
  const integrateTo = (pos, to) => {
    const lo = Math.max(pos.lastTs, windowStart);
    const hi = Math.min(to, windowEnd);
    if (hi > lo && pos.basis > 0n) {
      acc.set(pos.member, (acc.get(pos.member) ?? 0n) + pos.basis * BigInt(hi - lo));
    }
    pos.lastTs = to;
  };

  for (const e of ordered) {
    if (prev && prev.blockNumber === e.blockNumber && prev.logIndex === e.logIndex) {
      throw new Error(`ledger: two events share block ${e.blockNumber} log ${e.logIndex}`);
    }
    if (prev && e.timestamp < prev.timestamp) {
      throw new Error(`ledger: timestamp goes backwards between block ${prev.blockNumber} and ${e.blockNumber}`);
    }
    prev = e;
    const key = `${e.vault}|${e.member}`;
    let pos = state.get(key);
    if (!pos) {
      pos = { vault: e.vault, member: e.member, shares: 0n, basis: 0n, lastTs: e.timestamp };
      state.set(key, pos);
    }
    integrateTo(pos, e.timestamp);

    if (e.type === 'deposit') {
      if (e.amountUsdc === undefined || e.sharesAfter === undefined) throw new Error('ledger: deposit without amountUsdc/sharesAfter');
      if (e.sharesAfter <= pos.shares) {
        throw new Error(`ledger: deposit at block ${e.blockNumber} does not raise the share balance (${pos.shares} -> ${e.sharesAfter}); a log is missing or the field is misread`);
      }
      pos.shares = e.sharesAfter;
      pos.basis += e.amountUsdc;
    } else if (e.type === 'exit') {
      const burned = e.sharesBurned;
      if (burned === undefined) throw new Error('ledger: exit without sharesBurned');
      if (burned <= 0n || burned > pos.shares) {
        throw new Error(`ledger: exit at block ${e.blockNumber} burns ${burned} of ${pos.shares} shares; a log is missing`);
      }
      const removed = (pos.basis * burned) / pos.shares;
      pos.basis -= removed;
      pos.shares -= burned;
    } else {
      throw new Error(`ledger: unknown event type ${String(/** @type {any} */ (e).type)}`);
    }
  }

  for (const pos of state.values()) integrateTo(pos, windowEnd);

  const positions = new Map();
  for (const [k, p] of state) positions.set(k, { vault: p.vault, member: p.member, shares: p.shares, basis: p.basis });
  for (const [m, v] of acc) if (v === 0n) acc.delete(m);
  return { usdcSeconds: acc, positions };
}
