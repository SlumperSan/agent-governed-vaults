// @ts-check
/**
 * Pure event-projection reducers for the index-vault protocol.
 *
 * The indexer core is intentionally chain-agnostic: it consumes *normalized* events (already
 * decoded from logs) and folds them into queryable state. A thin viem adapter (chain.mjs)
 * produces the normalized events in production; these reducers are what the API reads and what
 * the tests exercise — no chain required.
 *
 * Normalized event shape: { name, vault, blockNumber, logIndex, args }
 * Ordering key is (blockNumber, logIndex) so a replay is deterministic.
 */

/** @typedef {{name:string, vault:string, blockNumber:number, logIndex:number, args:Record<string,any>}} Event */

/**
 * @typedef {Object} VaultState
 * @property {string} vault
 * @property {string} creator
 * @property {string} usdc
 * @property {number} operatorId
 * @property {bigint} totalShares
 * @property {bigint} idleUsdc
 * @property {number} memberCount        // holders with shares > 0
 * @property {number} pendingCount       // deposits in the observation window
 * @property {bigint} capacityCapUsdc
 * @property {string|null} parent        // sub-vault parent, or null for a root
 * @property {number} depth
 */

/**
 * @typedef {Object} OperatorState
 * @property {number} operatorId
 * @property {string} operator
 * @property {bigint} lifetimeGainUsdc
 * @property {bigint} lifetimeLossUsdc
 * @property {bigint} lifetimeFeesUsdc
 * @property {number} vaultCount
 */

export function emptyState() {
  return {
    /** @type {Map<string, VaultState>} */ vaults: new Map(),
    /** @type {Map<number, OperatorState>} */ operators: new Map(),
    /** @type {Map<string, Map<string, bigint>>} */ shares: new Map(), // vault -> member -> shares
    lastBlock: 0,
    lastLogIndex: -1,
  };
}

function big(x) {
  return typeof x === 'bigint' ? x : BigInt(x);
}

function ensureVault(state, vault) {
  let v = state.vaults.get(vault);
  if (!v) {
    v = {
      vault,
      creator: '0x',
      usdc: '0x',
      operatorId: 0,
      totalShares: 0n,
      idleUsdc: 0n,
      memberCount: 0,
      pendingCount: 0,
      capacityCapUsdc: 0n,
      parent: null,
      depth: 0,
    };
    state.vaults.set(vault, v);
  }
  return v;
}

function shareBook(state, vault) {
  let b = state.shares.get(vault);
  if (!b) {
    b = new Map();
    state.shares.set(vault, b);
  }
  return b;
}

function creditShares(state, vault, member, delta) {
  const v = ensureVault(state, vault);
  const book = shareBook(state, vault);
  const prev = book.get(member) ?? 0n;
  const next = prev + delta;
  if (prev === 0n && next > 0n) v.memberCount += 1;
  if (prev > 0n && next <= 0n) v.memberCount -= 1;
  if (next <= 0n) book.delete(member);
  else book.set(member, next);
  v.totalShares += delta;
}

/**
 * Fold one normalized event into state. Idempotent-safe only in strict (block,logIndex) order;
 * callers must sort before applying (see applyAll).
 * @param {ReturnType<typeof emptyState>} state
 * @param {Event} e
 */
export function apply(state, e) {
  const a = e.args ?? {};
  switch (e.name) {
    case 'VaultCreated': {
      const v = ensureVault(state, e.args.vault);
      v.creator = a.creator;
      v.usdc = a.usdc;
      v.capacityCapUsdc = big(a.capacityCapUsdc ?? 0);
      break;
    }
    case 'VaultAttested': {
      ensureVault(state, e.args.vault).operatorId = Number(a.opId);
      break;
    }
    case 'ChildRegistered': {
      const child = ensureVault(state, a.child);
      child.parent = a.parent;
      child.depth = Number(a.depth);
      break;
    }
    case 'OperatorRegistered': {
      const id = Number(a.opId);
      if (!state.operators.has(id)) {
        state.operators.set(id, {
          operatorId: id,
          operator: a.operator,
          lifetimeGainUsdc: 0n,
          lifetimeLossUsdc: 0n,
          lifetimeFeesUsdc: 0n,
          vaultCount: 0,
        });
      }
      break;
    }
    case 'RealizationRecorded': {
      const op = state.operators.get(Number(a.opId));
      if (op) {
        op.lifetimeGainUsdc += big(a.gainUsdc ?? 0);
        op.lifetimeLossUsdc += big(a.lossUsdc ?? 0);
      }
      break;
    }
    case 'FeeRecorded': {
      const op = state.operators.get(Number(a.opId));
      if (op) op.lifetimeFeesUsdc += big(a.amountUsdc ?? 0);
      break;
    }
    case 'DepositPending':
      ensureVault(state, e.vault).pendingCount += 1;
      break;
    case 'PendingCancelled':
      ensureVault(state, e.vault).pendingCount = Math.max(
        0,
        ensureVault(state, e.vault).pendingCount - 1,
      );
      break;
    case 'DepositActivated': {
      const v = ensureVault(state, e.vault);
      if (v.pendingCount > 0) v.pendingCount -= 1; // window path; repeat deposits had none
      creditShares(state, e.vault, a.member, big(a.sharesMinted));
      // idle tracking is approximate off events; authoritative NAV comes from a chain read.
      break;
    }
    case 'ExitSettled':
      creditShares(state, e.vault, a.member, -big(a.sharesBurned));
      break;
    default:
      break; // unrelated events ignored
  }
  state.lastBlock = e.blockNumber;
  state.lastLogIndex = e.logIndex;
}

/**
 * Sort by (blockNumber, logIndex) and fold. Deterministic regardless of input order.
 * @param {Event[]} events
 */
export function applyAll(events, state = emptyState()) {
  const sorted = [...events].sort(
    (x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex,
  );
  for (const e of sorted) apply(state, e);
  return state;
}

/**
 * Operator leaderboard — ALL attested vaults included, no cherry-picking (SF-4/SF-5).
 * Net realized P&L = lifetimeGain - lifetimeLoss. Sorted by net desc; ties by fees desc.
 */
export function leaderboard(state) {
  return [...state.operators.values()]
    .map((o) => ({
      operatorId: o.operatorId,
      operator: o.operator,
      netRealizedUsdc: o.lifetimeGainUsdc - o.lifetimeLossUsdc,
      lifetimeGainUsdc: o.lifetimeGainUsdc,
      lifetimeLossUsdc: o.lifetimeLossUsdc,
      lifetimeFeesUsdc: o.lifetimeFeesUsdc,
      vaultCount: o.vaultCount,
    }))
    .sort(
      (a, b) =>
        (b.netRealizedUsdc > a.netRealizedUsdc ? 1 : b.netRealizedUsdc < a.netRealizedUsdc ? -1 : 0) ||
        (b.lifetimeFeesUsdc > a.lifetimeFeesUsdc ? 1 : -1),
    );
}

export function vaultView(state, vault) {
  const v = state.vaults.get(vault);
  if (!v) return null;
  return { ...v, holders: shareBook(state, vault).size };
}
