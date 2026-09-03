// @ts-check
/**
 * Direct chain reads — the half of perception the metered API cannot serve.
 *
 * The API is an event projection: it knows share books, member counts, and the leaderboard, but
 * events do not carry post-swap balances or oracle prices, so NAV, fee schedules, pending-deposit
 * timers, and governance phase deadlines are only knowable by calling the contracts. The indexer
 * does no `readContract` today, so this reader is new: minimal embedded ABI fragments (the
 * convention from packages/indexer/src/abis.mjs) plus a viem public client.
 *
 * Read set, and why each one is load-bearing:
 *
 *   VaultCore.navPerShareWad()        drawdown policy, and the oracle liveness probe (below)
 *   VaultCore.exitFeeBpsOf(member)    join gate — the fee THIS agent would actually pay
 *   VaultCore.pendingDeposit(member)  → (amount, availableAt): schedule activate at the REAL
 *                                       window end, not a guessed now+4h
 *   VaultCore.sharesOf/queuedExitShares/windowCleared/skipOptIn/capacityCapUsdc/totalAssets
 *   Governance.hasPendingExecution(vault)   Mode I vs Mode F — forward pricing (ARCHITECTURE §4.4)
 *   Governance.activeProposalOf(vault) / proposals(pid)   commit & reveal deadlines
 *   Governance.commitOf(pid, voter) / revealedOf(pid, voter)
 *                                     the STATELESS-RESTART pair: an outstanding commit is
 *                                     detected from chain state, never from local storage, so a
 *                                     restarted agent rediscovers every vote it owes (S-4)
 *   OperatorRegistry.operatorOf(vault)      attestation verified at the registry, not from the
 *                                       API's branding metadata (AGENT-QUICKSTART §4)
 *
 * **Oracle-freeze detection is a proxy, and it is a warning only in the loosest sense.**
 * `navPerShareWad()` reverts with `StaleOracle` when any basket asset's price is stale
 * (VaultCore.sol:256) — so a failed NAV read means the vault is ALREADY frozen, at which point
 * exits are frozen too (ARCHITECTURE §11) and there is nothing to act on. OracleAggregator exposes
 * no per-source timestamp, so a genuine early warning is not readable on-chain. The agent treats
 * repeated NAV-read failure as its degradation signal and the docs say plainly that this is
 * detection after the fact, not prevention.
 */

const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a);

const fn = (name, inputs, outputs, stateMutability = 'view') => ({
  type: 'function',
  name,
  inputs,
  outputs,
  stateMutability,
});
const A = (name = '') => ({ name, type: 'address' });
const U = (name = '') => ({ name, type: 'uint256' });

/** Minimal read fragments. test/chain.test.mjs cross-checks every one against contracts/out. */
export const VAULT_READ_ABI = Object.freeze([
  fn('navPerShareWad', [], [U()]),
  fn('totalAssets', [], [U()]),
  fn('totalShares', [], [U()]),
  fn('idleUsdc', [], [U()]),
  fn('totalPendingUsdc', [], [U()]),
  fn('capacityCapUsdc', [], [U()]),
  fn('isCapped', [], [{ name: '', type: 'bool' }]),
  fn('minDepositUsdc', [], [U()]),
  fn('exitFeeBpsOf', [A('member')], [U()]),
  fn('sharesOf', [A()], [U()]),
  // Voting weight is NOT sharesOf: pending deposits and Mode-F-locked shares hold no vote, and a
  // proposal measures stake at its snapshot timestamp — the same measure quorum uses
  // (AGENT-QUICKSTART §3). Committing on sharesOf would cast votes that can never count.
  fn('votingEligibleShares', [A('member')], [U()]),
  fn('pastVotingEligibleShares', [A('member'), { name: 'ts', type: 'uint64' }], [U()]),
  fn('queuedExitShares', [A()], [U()]),
  fn('windowCleared', [A()], [{ name: '', type: 'bool' }]),
  fn('skipOptIn', [A()], [{ name: '', type: 'bool' }]),
  fn('pendingDeposit', [A()], [U(), { name: '', type: 'uint64' }]),
  fn('operatorRegistry', [], [A()]),
  fn('OBSERVATION_WINDOW', [], [U()]),
]);

export const GOVERNANCE_READ_ABI = Object.freeze([
  fn('hasPendingExecution', [A('vault')], [{ name: '', type: 'bool' }]),
  fn('activeProposalOf', [A()], [U()]),
  fn('commitOf', [U(), A()], [{ name: '', type: 'bytes32' }]),
  fn('revealedOf', [U(), A()], [{ name: '', type: 'bool' }]),
  fn('proposals', [U()], [
    A('vault'),
    { name: 'ptype', type: 'uint8' },
    A('proposer'),
    { name: 'createdAt', type: 'uint64' },
    { name: 'commitDeadline', type: 'uint64' },
    { name: 'revealDeadline', type: 'uint64' },
    { name: 'executableAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'status', type: 'uint8' },
    { name: 'actionHash', type: 'bytes32' },
    U('snapshotTotal'),
    U('memberCount'),
    U('forWeight'),
    U('againstWeight'),
    U('revealedWeight'),
    U('revealedVoterCount'),
  ]),
]);

export const OPERATOR_REGISTRY_READ_ABI = Object.freeze([fn('operatorOf', [A('vault')], [U()])]);

/** Sub-vaults STACK fees up the parent chain — the headline 10% is a floor, not the number the
 *  agent pays (AGENT-QUICKSTART §4). Read the stacked figures, never assume the base. */
export const SUBVAULT_REGISTRY_READ_ABI = Object.freeze([
  fn('stackedPerfFeeBps', [A('vault')], [U()]),
  fn('stackedExitFeeCapBps', [A('vault')], [U()]),
  fn('depthOf', [A()], [U()]),
]);

/** Governance.Status, in declaration order (Governance.sol:68). */
export const PROPOSAL_STATUS = Object.freeze(['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Expired']);
/** Governance.ProposalType (Governance.sol:62). */
export const PROPOSAL_TYPE = Object.freeze(['Rebalance', 'RuleChange', 'ChildAllocation']);

/**
 * `proposals(pid)` has SIXTEEN unnamed-in-storage fields. viem hands back a positional array for
 * a multi-output function, and an off-by-one here would silently shift `revealDeadline` — the
 * agent would schedule its reveal against the wrong timestamp and forfeit the vote without ever
 * throwing. So the mapping is explicit, and test/chain.test.mjs pins each index.
 *
 * @param {any} raw  array (or object) as returned by readContract
 */
export function decodeProposal(raw) {
  const at = (i, name) => (Array.isArray(raw) ? raw[i] : raw?.[name]);
  const n = (v) => (v === undefined || v === null ? 0 : Number(v));
  const b = (v) => (v === undefined || v === null ? 0n : BigInt(v));
  return {
    vault: lc(at(0, 'vault')),
    ptype: n(at(1, 'ptype')),
    ptypeName: PROPOSAL_TYPE[n(at(1, 'ptype'))] ?? 'Unknown',
    proposer: lc(at(2, 'proposer')),
    createdAt: n(at(3, 'createdAt')),
    commitDeadline: n(at(4, 'commitDeadline')),
    revealDeadline: n(at(5, 'revealDeadline')),
    executableAt: n(at(6, 'executableAt')),
    expiresAt: n(at(7, 'expiresAt')),
    status: n(at(8, 'status')),
    statusName: PROPOSAL_STATUS[n(at(8, 'status'))] ?? 'Unknown',
    actionHash: at(9, 'actionHash'),
    snapshotTotal: b(at(10, 'snapshotTotal')),
    memberCount: n(at(11, 'memberCount')),
    forWeight: b(at(12, 'forWeight')),
    againstWeight: b(at(13, 'againstWeight')),
    revealedWeight: b(at(14, 'revealedWeight')),
    revealedVoterCount: b(at(15, 'revealedVoterCount')),
  };
}

export const ZERO_BYTES32 = '0x' + '0'.repeat(64);

/**
 * A chain reader over a viem-style public client. Tests inject `client`; production passes
 * `rpcUrl` (the lazy-viem pattern from packages/indexer/src/rpc.mjs).
 *
 * Every read is fault-tolerant by design: an RPC hiccup must degrade one field, not crash the
 * loop. Failures surface as `null` plus a recorded reason, and the policy layer decides what a
 * missing value means — which for NAV is "possible oracle freeze", not "assume fine".
 *
 * @param {Object} cfg
 * @param {any} [cfg.client]
 * @param {string} [cfg.rpcUrl]
 * @param {number} [cfg.chainId]
 * @param {string} [cfg.chainName]
 * @param {string|null} [cfg.governance]
 * @param {(e:{level:string,msg:string,detail?:any})=>void} [cfg.onEvent]
 */
export function createChainReader({ client, rpcUrl, chainId = 84532, chainName = 'base-sepolia', governance = null, onEvent = () => {} }) {
  let _client = client ?? null;
  const failures = new Map(); // vault ⇒ consecutive NAV read failures

  async function getClient() {
    if (_client) return _client;
    if (!rpcUrl) throw new Error('chain: no client injected and no rpcUrl provided');
    const { createPublicClient, http } = await import('viem').catch(() => {
      throw new Error('chain: viem is not installed — run `npm install viem` at the repo root');
    });
    _client = createPublicClient({
      chain: {
        id: chainId,
        name: chainName,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      },
      transport: http(rpcUrl),
    });
    return _client;
  }

  /** One read, never throwing. @returns {Promise<{ok:true,value:any}|{ok:false,error:string}>} */
  async function read(address, abi, functionName, args = []) {
    try {
      const c = await getClient();
      const value = await c.readContract({ address, abi, functionName, args });
      return { ok: true, value };
    } catch (err) {
      const error = String(err?.shortMessage ?? err?.message ?? err);
      onEvent({ level: 'warn', msg: `chain read failed: ${functionName}`, detail: { address, error } });
      return { ok: false, error };
    }
  }

  return {
    read,

    /**
     * Everything about one vault the agent needs, from the agent's own point of view.
     * @param {string} vault @param {string|null} member
     */
    async readVault(vault, member) {
      const v = lc(vault);
      const [nav, totalAssets, totalShares, idle, totalPending, capacityCap, capped, minDeposit, obsWindow, registry] =
        await Promise.all([
          read(v, VAULT_READ_ABI, 'navPerShareWad'),
          read(v, VAULT_READ_ABI, 'totalAssets'),
          read(v, VAULT_READ_ABI, 'totalShares'),
          read(v, VAULT_READ_ABI, 'idleUsdc'),
          read(v, VAULT_READ_ABI, 'totalPendingUsdc'),
          read(v, VAULT_READ_ABI, 'capacityCapUsdc'),
          read(v, VAULT_READ_ABI, 'isCapped'),
          read(v, VAULT_READ_ABI, 'minDepositUsdc'),
          read(v, VAULT_READ_ABI, 'OBSERVATION_WINDOW'),
          read(v, VAULT_READ_ABI, 'operatorRegistry'),
        ]);

      // navPerShareWad reverts on a stale oracle — that failure IS the freeze signal.
      const prior = failures.get(v) ?? 0;
      const navFailures = nav.ok ? 0 : prior + 1;
      failures.set(v, navFailures);

      const self =
        member == null
          ? {}
          : await (async () => {
              const [shares, exitFeeBps, queued, cleared, skip, pending] = await Promise.all([
                read(v, VAULT_READ_ABI, 'sharesOf', [member]),
                read(v, VAULT_READ_ABI, 'exitFeeBpsOf', [member]),
                read(v, VAULT_READ_ABI, 'queuedExitShares', [member]),
                read(v, VAULT_READ_ABI, 'windowCleared', [member]),
                read(v, VAULT_READ_ABI, 'skipOptIn', [member]),
                read(v, VAULT_READ_ABI, 'pendingDeposit', [member]),
              ]);
              const p = pending.ok ? pending.value : null;
              return {
                shares: shares.ok ? BigInt(shares.value) : null,
                exitFeeBps: exitFeeBps.ok ? Number(exitFeeBps.value) : null,
                queuedExitShares: queued.ok ? BigInt(queued.value) : null,
                windowCleared: cleared.ok ? Boolean(cleared.value) : null,
                skipOptIn: skip.ok ? Boolean(skip.value) : null,
                pendingAmount: p ? BigInt(Array.isArray(p) ? p[0] : p.amount ?? 0) : null,
                pendingAvailableAt: p ? Number(Array.isArray(p) ? p[1] : p.availableAt ?? 0) : null,
              };
            })();

      return {
        vault: v,
        navPerShareWad: nav.ok ? BigInt(nav.value) : null,
        navReadable: nav.ok,
        navError: nav.ok ? null : nav.error,
        navConsecutiveFailures: navFailures,
        totalAssetsUsdc: totalAssets.ok ? BigInt(totalAssets.value) : null,
        totalShares: totalShares.ok ? BigInt(totalShares.value) : null,
        idleUsdc: idle.ok ? BigInt(idle.value) : null,
        totalPendingUsdc: totalPending.ok ? BigInt(totalPending.value) : null,
        // capacityCapUsdc == 0 means UNCAPPED (ARCHITECTURE §6) — never read it as "no room".
        capacityCapUsdc: capacityCap.ok ? BigInt(capacityCap.value) : null,
        isCapped: capped.ok ? Boolean(capped.value) : null,
        minDepositUsdc: minDeposit.ok ? BigInt(minDeposit.value) : null,
        observationWindowSec: obsWindow.ok ? Number(obsWindow.value) : null,
        operatorRegistry: registry.ok ? lc(registry.value) : null,
        self,
      };
    },

    /** Verify attestation at the registry, not from API branding metadata. */
    async readOperatorId(registryAddress, vault) {
      if (!registryAddress) return null;
      const r = await read(lc(registryAddress), OPERATOR_REGISTRY_READ_ABI, 'operatorOf', [lc(vault)]);
      return r.ok ? Number(r.value) : null;
    },

    /**
     * The agent's VOTING-ELIGIBLE stake — not its share balance.
     *
     * At a proposal's snapshot timestamp when one is given, because that is the measure the
     * contract counts (and the same one quorum uses). Reading `sharesOf` instead would let the
     * agent commit a vote with zero snapshot weight — deposited after the proposal opened, or
     * locked behind a Mode-F exit — which can never count.
     *
     * @param {string} vault @param {string|null} member @param {number|null} [ts]
     */
    async readVotingWeight(vault, member, ts = null) {
      if (!member) return null;
      const r = ts
        ? await read(lc(vault), VAULT_READ_ABI, 'pastVotingEligibleShares', [member, BigInt(ts)])
        : await read(lc(vault), VAULT_READ_ABI, 'votingEligibleShares', [member]);
      return r.ok ? BigInt(r.value) : null;
    },

    /** Stacked fees for a (possibly nested) vault. Null when no registry address is known. */
    async readStackedFees(subvaultRegistry, vault) {
      if (!subvaultRegistry) return { stackedPerfFeeBps: null, stackedExitFeeCapBps: null, depth: null };
      const v = lc(vault);
      const [perf, exitCap, depth] = await Promise.all([
        read(lc(subvaultRegistry), SUBVAULT_REGISTRY_READ_ABI, 'stackedPerfFeeBps', [v]),
        read(lc(subvaultRegistry), SUBVAULT_REGISTRY_READ_ABI, 'stackedExitFeeCapBps', [v]),
        read(lc(subvaultRegistry), SUBVAULT_REGISTRY_READ_ABI, 'depthOf', [v]),
      ]);
      return {
        stackedPerfFeeBps: perf.ok ? Number(perf.value) : null,
        stackedExitFeeCapBps: exitCap.ok ? Number(exitCap.value) : null,
        depth: depth.ok ? Number(depth.value) : null,
      };
    },

    /**
     * Governance state for one vault from this agent's point of view, including any commit it
     * owes a reveal on. `commitment !== ZERO_BYTES32 && !revealed` is the restart-safe way to
     * discover an outstanding vote — no local state involved.
     *
     * @param {string} vault @param {string|null} voter
     */
    async readGovernance(vault, voter) {
      if (!governance) return { available: false, reason: 'no governance address configured' };
      const v = lc(vault);
      const [pendingExec, activePid] = await Promise.all([
        read(governance, GOVERNANCE_READ_ABI, 'hasPendingExecution', [v]),
        read(governance, GOVERNANCE_READ_ABI, 'activeProposalOf', [v]),
      ]);
      const pid = activePid.ok ? BigInt(activePid.value) : 0n;

      let proposal = null;
      let commitment = null;
      let revealed = null;
      let proposalUnknown = false;
      let commitUnknown = false;
      if (pid > 0n) {
        const p = await read(governance, GOVERNANCE_READ_ABI, 'proposals', [pid]);
        if (p.ok) proposal = { pid, ...decodeProposal(p.value) };
        else proposalUnknown = true;
        if (voter) {
          const [c, r] = await Promise.all([
            read(governance, GOVERNANCE_READ_ABI, 'commitOf', [pid, voter]),
            read(governance, GOVERNANCE_READ_ABI, 'revealedOf', [pid, voter]),
          ]);
          commitment = c.ok ? String(c.value) : null;
          revealed = r.ok ? Boolean(r.value) : null;
          commitUnknown = !c.ok;
        }
      }

      return {
        available: true,
        // A pending execution turns an exit into Mode F: forward-priced at POST-execution NAV
        // (ARCHITECTURE §4.4). This is true from any active proposal's reveal start, for any
        // proposal type — not only a passed rebalance. Never plan an exit without checking it.
        hasPendingExecution: pendingExec.ok ? Boolean(pendingExec.value) : null,
        activePid: pid,
        proposal,
        commitment,
        // `revealed !== true`, NOT `revealed === false`. A failed `revealedOf` read yields null,
        // and treating null as "already revealed" would silently drop a reveal obligation because
        // one RPC call hiccuped — forfeiting the vote (S-4). An unnecessary reveal attempt costs
        // gas and reverts harmlessly; a skipped one costs the vote. Fail toward revealing.
        hasOutstandingCommit: commitment != null && commitment !== ZERO_BYTES32 && revealed !== true,
        revealed,
        // Read failures are reported as UNKNOWN, never folded into "nothing to do" — see decideVote.
        proposalUnknown,
        commitUnknown,
      };
    },
  };
}

/**
 * A chain reader with no chain behind it. Used by the demo run and the tests: it answers from a
 * fixture and marks every value it produces so the narrative cannot be mistaken for live data.
 * The protocol has no deployment yet (issue #10, EIP-170), so the demo run uses this by default.
 *
 * @param {Record<string, any>} fixture  vault ⇒ partial readVault result
 * @param {Record<string, any>} [govFixture]  vault ⇒ partial readGovernance result
 */
export function createStubChainReader(fixture = {}, govFixture = {}) {
  const base = {
    navPerShareWad: 10n ** 18n,
    navReadable: true,
    navError: null,
    navConsecutiveFailures: 0,
    totalAssetsUsdc: 0n,
    totalShares: 0n,
    idleUsdc: 0n,
    totalPendingUsdc: 0n,
    capacityCapUsdc: 0n,
    isCapped: false,
    minDepositUsdc: 0n,
    observationWindowSec: 4 * 3600,
    operatorRegistry: null,
    self: {},
  };
  return {
    stub: true,
    async read() {
      return { ok: false, error: 'stub reader: no chain' };
    },
    async readVault(vault, member) {
      const v = lc(vault);
      const f = fixture[v] ?? {};
      return { ...base, ...f, vault: v, stub: true, self: { ...(f.self ?? {}), member } };
    },
    async readOperatorId(_registry, vault) {
      return fixture[lc(vault)]?.operatorId ?? null;
    },
    async readVotingWeight(vault, member, _ts = null) {
      if (!member) return null;
      const f = fixture[lc(vault)] ?? {};
      // Fixtures may state voting weight explicitly; otherwise fall back to the share balance,
      // which is what a settled, window-cleared position looks like.
      return f.votingEligibleShares ?? f.self?.shares ?? 0n;
    },
    async readStackedFees(_registry, vault) {
      const f = fixture[lc(vault)] ?? {};
      return {
        stackedPerfFeeBps: f.stackedPerfFeeBps ?? 1000,
        stackedExitFeeCapBps: f.stackedExitFeeCapBps ?? 100,
        depth: f.depth ?? 0,
      };
    },
    async readGovernance(vault, voter) {
      const g = govFixture[lc(vault)];
      if (!g) return { available: true, stub: true, hasPendingExecution: false, activePid: 0n, proposal: null, commitment: null, hasOutstandingCommit: false, revealed: null };
      return { available: true, stub: true, hasPendingExecution: false, activePid: 0n, proposal: null, commitment: null, hasOutstandingCommit: false, revealed: null, voter, ...g };
    },
  };
}
