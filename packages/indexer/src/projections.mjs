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
 * @property {number} exitQueuedCount    // ExitQueued occurrences (lifetime Mode-F entries)
 * @property {number} exitSettledCount   // ExitSettled occurrences (all settled exits, Mode-F + Mode-I)
 * @property {number} modeFSettledCount  // of those, the ones that resolved a queued Mode-F exit
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
  // Mode-F exit queue, in-kind escrow, module-call failures and rebalance execution counts
  // (data-analytics build-order #1 — packages/indexer/src/abis.mjs is the source of these).
  'ExitQueued', 'SliceEscrowed', 'EscrowClaimed', 'ModuleCallFailed', 'RebalanceExecuted',
  // FeeEngine per-token fee accrual + Governance quorum context / reveal drop-off (build-order #2).
  'FeeAssessed', 'FeeCredited', 'FeesClaimed', 'VaultRegistered', 'Committed',
  // Execution-adapter fills (build-order #3).
  'SwapExecuted',
]);

/**
 * Events tracked only as a count + last-seen marker (§ build-order #1/#2/#3): no bespoke reducer
 * exists for these yet (that is the bigger Postgres-substrate work in the vault note's build order
 * items 4+). Folding them here at least means they are not silently dropped — `state.eventStats`
 * answers "has this event ever fired, how many times, as of which block" for every one of them.
 */
const STAT_ONLY_EVENTS = Object.freeze([
  'ExitQueued', 'SliceEscrowed', 'EscrowClaimed', 'ModuleCallFailed', 'RebalanceExecuted',
  'FeeAssessed', 'FeeCredited', 'FeesClaimed', 'VaultRegistered', 'Committed', 'SwapExecuted',
]);
const STAT_ONLY_EVENT_SET = new Set(STAT_ONLY_EVENTS);

/**
 * Ceiling on the DISCOVERED execution-adapter set — the one learned from chain logs, as opposed to
 * the one an operator names in `ADAPTER_ADDRESSES`.
 *
 * It lives here, in the pure core, because it has to hold in TWO places that would otherwise drift:
 * `state.adapters` below (persisted in every snapshot, and what a restart re-seeds the poller from)
 * and the poll set in rpc.mjs (the `address` array of every `getLogs` call). Bounding only the
 * second, as an earlier revision did, left the first growing without limit while a comment claimed
 * otherwise.
 *
 * Membership is attacker-influenceable: `createVault` is permissionless and `allowedAdapters` is
 * caller-supplied, so anyone can get an address in here for the cost of one vault and one no-op
 * rebalance. 64 is chosen to sit far above any deployment that has not yet needed to configure its
 * adapters explicitly, and far below a set that would degrade a `getLogs` call. It is a
 * LOAD-SHEDDING bound, not a trust boundary — config is the trust boundary — which is why exceeding
 * it is reported rather than silently absorbed, and why configured adapters are exempt.
 */
export const MAX_TRACKED_ADAPTERS = 64;

function bumpEventStat(state, e) {
  const s = state.eventStats.get(e.name) ?? { count: 0, lastBlock: 0, lastLogIndex: -1 };
  s.count += 1;
  s.lastBlock = e.blockNumber;
  s.lastLogIndex = e.logIndex;
  state.eventStats.set(e.name, s);
}

export function emptyState() {
  return {
    /** @type {Map<string, VaultState>} */ vaults: new Map(),
    /** @type {Map<number, OperatorState>} */ operators: new Map(),
    /** @type {Map<string, Map<string, bigint>>} */ shares: new Map(), // vault -> member -> shares
    /** @type {Map<number, ProposalState>} */ proposals: new Map(), // pid -> proposal
    /** @type {Map<string, number>} */ activeProposal: new Map(), // vault -> pid (0 = none)
    /** @type {Map<string, {count:number, lastBlock:number, lastLogIndex:number}>} */
    eventStats: new Map(), // event name -> occurrence count + last-seen cursor (STAT_ONLY_EVENTS)
    /** @type {Set<string>} */ adapters: new Set(), // execution-adapter addresses, learned from RebalanceExecuted
    /** @type {Map<string, Set<string>>} */
    queuedExits: new Map(), // vault -> members with an OUTSTANDING queued Mode-F exit (see `apply`)
    lastBlock: 0,
    lastLogIndex: -1,
  };
}

function big(x) {
  return typeof x === 'bigint' ? x : BigInt(x);
}

/**
 * Every field of a vault record, at its zero value. Exported because `store.deserializeState` uses
 * it as the BASE a resumed record is spread over: a snapshot written before a field existed simply
 * has no key for it, and spreading over this default is what turns that absence into 0 rather than
 * `undefined` (which then poisons `+= 1` into NaN, and the next snapshot write into null). Adding a
 * field here is therefore the whole migration for it — see the note in `deserializeState`.
 * @param {string} vault
 * @returns {VaultState}
 */
export function newVault(vault) {
  return {
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
    exitQueuedCount: 0,
    exitSettledCount: 0,
    modeFSettledCount: 0,
  };
}

function ensureVault(state, vault) {
  let v = state.vaults.get(vault);
  if (!v) {
    v = newVault(vault);
    state.vaults.set(vault, v);
  }
  return v;
}

/** The set of members with an outstanding queued Mode-F exit in `vault` (created on demand). */
function queuedExitSet(state, vault) {
  let q = state.queuedExits.get(vault);
  if (!q) {
    q = new Set();
    state.queuedExits.set(vault, q);
  }
  return q;
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
  if (STAT_ONLY_EVENT_SET.has(e.name)) bumpEventStat(state, e);
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
    case 'ExitQueued':
      // VaultCore.requestExit allows ONE queued exit per member at a time
      // (`queuedExitShares[msg.sender] == 0`, ExitAlreadyQueued) and a queued exit is
      // irrevocable, so this set holds at most one entry per member and never needs a size.
      ensureVault(state, e.vault).exitQueuedCount += 1;
      queuedExitSet(state, e.vault).add(a.member);
      break;
    case 'ExitSettled': {
      const v = ensureVault(state, e.vault);
      v.exitSettledCount += 1;
      // The EXACT Mode-F discriminator, not an approximation. While a member sits in the queued
      // set, `requestExit` reverts for them (ExitAlreadyQueued) and `settleQueuedExit` is the only
      // path that clears `queuedExitShares` — so the next ExitSettled for a queued member is
      // necessarily the settlement of that queued exit, and every other ExitSettled is Mode I.
      if (queuedExitSet(state, e.vault).delete(a.member)) v.modeFSettledCount += 1;
      creditShares(state, e.vault, a.member, -big(a.sharesBurned));
      break;
    }
    case 'RebalanceExecuted':
      // Learns the adapter's address so the chain source can poll it for SwapExecuted the same
      // way it learns a vault's address from VaultCreated (see rpc.mjs). Bounded, because unlike
      // the vault set this one is reachable by anybody (permissionless `createVault` +
      // caller-supplied `allowedAdapters`) and it is PERSISTED in every snapshot — an unbounded
      // one grows the state file and the resume cost without limit. An operator who needs a
      // specific adapter indexed names it in ADAPTER_ADDRESSES, which never consults this set.
      if (a.adapter && state.adapters.size < MAX_TRACKED_ADAPTERS) state.adapters.add(a.adapter);
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
  //
  // `exitQueuedOutstanding` is the §3.6 stranded-queue signal, computed from `state.queuedExits`
  // rather than stored on the record (a Set on the record would spread onto this response as `{}`).
  // It is deliberately NOT named `queuedExitBacklog` on the wire: on a response that already
  // carries `exitQueuedCount`, a near-anagram of it with a different meaning is a trap. The
  // "outstanding" / "count" pairing says which is a level and which is a lifetime total.
  return {
    ...v,
    holders: shareBook(state, vault).size,
    exitQueuedOutstanding: queuedExitBacklog(state, vault),
    activeProposal: proposal,
  };
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

/**
 * The vault note's `mode_f_exit_rate_bps` (§4.2): what share of a vault's SETTLED exits went
 * through the Mode-F queue rather than settling instantly (Mode I). Integer basis points of a
 * counts-over-counts fraction — the shape §4.4's public-field lint permits `_bps` for, and the
 * same convention as `shareOfVaultBps` in `memberPosition` below. Counts, not value, matching the
 * note's "exits, NOT value" framing.
 *
 * This is the note's EXACT discriminator, computed in the fold, not an approximation of it. The
 * rule the note states — "an ExitSettled is Mode-F iff that (vault, member) has an ExitQueued with
 * no intervening ExitSettled" — is decidable from the event stream alone and needs no per-member
 * `exit_event` table on a Postgres substrate: VaultCore permits one queued exit per member
 * (`requestExit` requires `queuedExitShares[msg.sender] == 0`) and `settleQueuedExit` is the only
 * way a queued exit ever resolves, so `state.queuedExits` — a per-vault set of members with an
 * outstanding queue entry — is a complete and exact ledger. See the `ExitSettled` case in `apply`.
 *
 * Because Mode-F settlements are a subset of all settlements, the result is a genuine partition
 * and is bounded by 10000 (100%). The unsettled backlog it deliberately does NOT fold in — the
 * stranded-queue signal of §3.6 — is a different quantity with its own accessor,
 * `queuedExitBacklog`; conflating the two is what makes a "rate" exceed 100%.
 *
 * Returns null when the vault is unknown or has no settled exits yet (undefined rate, not zero).
 */
export function modeFExitRateBps(state, vault) {
  const v = state.vaults.get(vault);
  if (!v || v.exitSettledCount === 0) return null;
  return Math.round((v.modeFSettledCount * 10000) / v.exitSettledCount);
}

/**
 * Members with an outstanding queued Mode-F exit in `vault` — the stranded-queue backlog (§3.6).
 * A count, not a rate: it has no denominator, so it is deliberately not expressed in bps.
 */
export function queuedExitBacklog(state, vault) {
  return state.queuedExits.get(vault)?.size ?? 0;
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
