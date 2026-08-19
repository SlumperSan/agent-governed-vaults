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
 *
 * @typedef {Object} ProposalState
 * @property {number} pid
 * @property {string} vault
 * @property {number} ptype        // 0 Rebalance, 1 RuleChange, 2 ChildAllocation
 * @property {string} proposer
 * @property {string} status       // Active | Passed | Defeated | Executed | Expired
 * @property {bigint} forWeight
 * @property {bigint} againstWeight
 * @property {bigint} revealedWeight
 * @property {number} revealedVoters
 */

/**
 * Event names the projection folds. Kept in sync with the apply() switch and asserted against
 * the compiled contract ABIs by test/event-coverage.test.mjs, so a Solidity event rename can
 * never silently drift from the indexer (the class of bug the consumer-UX review caught).
 */
export const HANDLED_EVENTS = Object.freeze([
  'VaultCreated', 'VaultAttested', 'ChildRegistered', 'OperatorRegistered',
  'RealizationRecorded', 'FeeRecorded', 'DepositPending', 'PendingCancelled',
  'DepositActivated', 'ExitSettled', 'Proposed', 'Revealed', 'DefaultApplied',
  'DelegatedRevealed', 'Finalized', 'Executed', 'ProposalExpired',
]);

export function emptyState() {
  return {
    /** @type {Map<string, VaultState>} */ vaults: new Map(),
    /** @type {Map<number, OperatorState>} */ operators: new Map(),
    /** @type {Map<string, Map<string, bigint>>} */ shares: new Map(), // vault -> member -> shares
    /** @type {Map<number, ProposalState>} */ proposals: new Map(), // pid -> proposal
    /** @type {Map<string, number>} */ activeProposal: new Map(), // vault -> pid (0 = none)
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
      const opId = Number(a.opId);
      ensureVault(state, e.args.vault).operatorId = opId;
      const op = state.operators.get(opId);
      if (op) op.vaultCount += 1; // was never incremented — leaderboard showed 0 (UX-spec bug)
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
    case 'Proposed': {
      const pid = Number(a.pid);
      state.proposals.set(pid, {
        pid,
        vault: a.vault,
        ptype: Number(a.ptype),
        proposer: a.proposer,
        status: 'Active',
        forWeight: 0n,
        againstWeight: 0n,
        revealedWeight: 0n,
        revealedVoters: 0,
      });
      state.activeProposal.set(a.vault, pid);
      break;
    }
    case 'Revealed': {
      const p = state.proposals.get(Number(a.pid));
      if (p) {
        const w = big(a.weight ?? 0);
        if (a.support) p.forWeight += w;
        else p.againstWeight += w;
        p.revealedWeight += w;
        p.revealedVoters += 1;
      }
      break;
    }
    case 'DefaultApplied':
    case 'DelegatedRevealed': {
      const p = state.proposals.get(Number(a.pid));
      if (p) {
        const w = big(a.weight ?? 0);
        if (a.support) p.forWeight += w;
        else p.againstWeight += w;
        if (e.name === 'DelegatedRevealed') p.revealedWeight += w; // defaults never count in quorum
      }
      break;
    }
    case 'Finalized': {
      const p = state.proposals.get(Number(a.pid));
      if (p) {
        // Governance.Status enum: 2 Passed, 3 Defeated
        p.status = Number(a.status) === 2 ? 'Passed' : 'Defeated';
        if (p.status === 'Defeated') state.activeProposal.set(p.vault, 0);
      }
      break;
    }
    case 'Executed': {
      const p = state.proposals.get(Number(a.pid));
      if (p) { p.status = 'Executed'; state.activeProposal.set(p.vault, 0); }
      break;
    }
    case 'ProposalExpired': {
      const p = state.proposals.get(Number(a.pid));
      if (p) { p.status = 'Expired'; state.activeProposal.set(p.vault, 0); }
      break;
    }
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
  const pid = state.activeProposal.get(vault) ?? 0;
  const proposal = pid ? state.proposals.get(pid) ?? null : null;
  // NAV, live basket balances, and proposal phase deadlines are chain-read enrichment (events
  // don't carry post-swap balances or prices) — the daemon merges those in. Everything here is
  // event-derived and deterministic.
  return { ...v, holders: shareBook(state, vault).size, activeProposal: proposal };
}

/** Summary list of all known vaults — the discovery surface for agents. */
export function listVaults(state) {
  return [...state.vaults.values()].map((v) => ({
    vault: v.vault,
    operatorId: v.operatorId,
    memberCount: v.memberCount,
    depth: v.depth,
    parent: v.parent,
    capacityCapUsdc: v.capacityCapUsdc,
    attested: v.operatorId !== 0, // operatorId 0 = unattested (scam-quarantine signal)
  }));
}

/** A member's share position in a vault (0 if none). */
export function memberPosition(state, vault, member) {
  const shares = shareBook(state, vault).get(member) ?? 0n;
  const v = state.vaults.get(vault);
  const totalShares = v ? v.totalShares : 0n;
  return {
    vault,
    member,
    shares,
    // fraction in basis points (integer) — NAV-denominated value is chain-read enrichment.
    shareOfVaultBps: totalShares > 0n ? Number((shares * 10000n) / totalShares) : 0,
  };
}
