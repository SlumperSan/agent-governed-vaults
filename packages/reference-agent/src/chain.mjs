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
 *   VaultCore.exitFeeBpsOf(member)    join gate — the TENURE-DECAYED fee, which is NOT always the
 *                                       fee this agent would pay. The sole-holder waiver is applied
 *                                       at settlement (`_settleExit` zeroes it when the member holds
 *                                       every share) and this view does not model it, as its own
 *                                       NatSpec says: "before any sole-holder waiver applied at
 *                                       settlement". A sole holder reading this view is told it owes
 *                                       a fee it does not owe. Treat it as a ceiling on the join
 *                                       decision, never as the amount
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
 * Chain-only discovery (no API at all) adds four more, all plain views:
 *
 *   VaultFactory.vaultCount() / allVaults(i)   the vault set, straight from the factory's array.
 *                                       Bounded: a window of the newest `maxVaults` entries, read in
 *                                       pages, so a chain with thousands of vaults cannot stall a tick
 *   OperatorRegistry.leaderboardEntry(opId)    the operator's record: address and the lifetime
 *                                       gain / loss / fee / vault-count accumulators
 *   VaultCore.holderCount()             addresses holding shares (creator included): the chain's
 *                                       member count, which is NOT the API's event-derived one
 *   VaultCore.creator()                 who deployed it; the 5% withdrawal gate binds to this address
 *
 * Crank support (finalize, execute, markExpired):
 *
 *   Block.timestamp                     `readBlockTimestamp()`: all three Governance gates compare
 *                                       `block.timestamp`, never the agent's own clock, so the
 *                                       crank decision is taken on chain time
 *   eth_call of an exact write          `simulateCall()`: the one shared simulation used before a
 *                                       crank write is sent. Read-only: it signs and sends nothing
 *
 * Realization logs (the outside-member track record) add three more calls, all read-only:
 *
 *   getBlockNumber(), getCode(vault, block)   find the block the vault was created in by bisection
 *   getLogs(OperatorRegistry, RealizationRecorded, opId)   every realization of the operator, in
 *                                       pages, from that block to the head
 *
 * **Log-range limits, measured 2026-10-18 with raw `eth_getLogs` on the OperatorRegistry** (the
 * block span is `to - from`; a page of 10,000 blocks is `to - from = 9,999`):
 *
 *   rpc.mainnet.arc.io       accepts a span up to 9,999 (10,000 blocks); a wider one answers
 *                            `-32012 "requested range too large"`
 *   arc.gateway.tenderly.co  accepts a span up to 100,000; a wider one answers
 *                            `-32602 "query exceeds max block range 100000"`
 *   both                     `-32005 "rate limit exceeded"` on back-to-back requests, whatever the
 *                            span: 40 pages at 250 ms spacing all passed, 40 with no spacing threw
 *                            it on 31 (arc.io) and 11 (tenderly). Neither pruned the vault's creation
 *                            block: `VaultCreated` and `VaultAttested` came back from block 22,443,745
 *                            on both, and `eth_getCode` answered at that block on both.
 *
 * A burst is not a sustained rate, and the first measurement was a burst. Sustained, 160 sequential
 * pages of 10,000 blocks on arc.io: at 250 ms spacing 44 were refused, the first at request 59; at
 * 500 ms 43, the first at request 60; at 1,000 ms none. tenderly served a full 420-page scan at 250
 * ms. So the default pause is 1,000 ms, and a rate limit widens it for the rest of the session.
 *
 * So the page defaults to 10,000 blocks (the smaller limit), requests are spaced, a rate limit is
 * retried with backoff, and a range refusal halves the page. Whatever cannot be read is a NAMED GAP
 * on the returned record. It is never folded into "zero realizations": a pruning RPC answers `[]`
 * with confidence (docs/TESTNET-CHECKLIST.md section 2), so the creation block is confirmed by a
 * positive control (the registry's own `VaultAttested` for the vault, in exactly that block) before
 * any log is believed.
 *
 * `OperatorRegistry.recordRealization` emits `RealizationRecorded` on every call, but the registry's
 * accumulators move only for a gain or a loss above zero, so the reader sums gain and loss and does
 * not count events.
 *
 * **Oracle-freeze detection is a proxy, and it is a warning only in the loosest sense.**
 * `navPerShareWad()` reverts with `StaleOracle` when any basket asset's price is stale
 * (VaultCore.sol:256) — so a failed NAV read means the vault is ALREADY frozen, at which point
 * exits are frozen too (ARCHITECTURE §11) and there is nothing to act on. OracleAggregator exposes
 * no per-source timestamp, so a genuine early warning is not readable on-chain. The agent treats
 * repeated NAV-read failure as its degradation signal and the docs say plainly that this is
 * detection after the fact, not prevention.
 */

import { assertChainBinding } from '../../chain-config/src/chain-binding.mjs';

/** No `node:assert`: this package is bundled for the browser by apps/vaults-ui. */
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

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
  fn('holderCount', [], [U()]),
  fn('creator', [], [A()]),
]);

/** The factory is the vault list: `allVaults` is its public array and `vaultCount` its length. */
export const FACTORY_READ_ABI = Object.freeze([fn('vaultCount', [], [U()]), fn('allVaults', [U('index')], [A()])]);

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

export const OPERATOR_REGISTRY_READ_ABI = Object.freeze([
  fn('operatorOf', [A('vault')], [U()]),
  // OperatorRegistry.OperatorStats, in declaration order. The monotone accumulators behind the
  // leaderboard: nothing is ever removed or restated (SF-4), so the net is gain minus loss.
  fn('leaderboardEntry', [U('opId')], [
    A('operator'),
    {
      name: 'stats',
      type: 'tuple',
      components: [
        U('lifetimeGainUsdc'),
        U('lifetimeLossUsdc'),
        U('lifetimeFeesUsdc'),
        U('vaultCount'),
      ],
    },
  ]),
]);

/**
 * OperatorRegistry.RealizationRecorded, emitted by the registry (not the vault) on every
 * `recordRealization`. `vault`, `opId` and `member` are indexed, so a log query filters on the
 * operator id. test/chain.test.mjs cross-checks it against contracts/out.
 */
export const REALIZATION_EVENT = Object.freeze({
  type: 'event',
  name: 'RealizationRecorded',
  inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'opId', type: 'uint256', indexed: true },
    { name: 'member', type: 'address', indexed: true },
    { name: 'gainUsdc', type: 'uint256', indexed: false },
    { name: 'lossUsdc', type: 'uint256', indexed: false },
    { name: 'carryAfter', type: 'uint256', indexed: false },
  ],
});

/** OperatorRegistry.VaultAttested, emitted by `attestVault` inside the vault's creating transaction. */
export const VAULT_ATTESTED_EVENT = Object.freeze({
  type: 'event',
  name: 'VaultAttested',
  inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'opId', type: 'uint256', indexed: true },
  ],
});

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

/** The longest pause a rate limit can teach the reader. */
export const MAX_LEARNED_PACE_MS = 8000;

/** The narrowest getLogs page the reader will fall back to when a provider refuses its range. */
export const MIN_LOG_PAGE_BLOCKS = 500;

/**
 * Sort an RPC failure into what to do about it. A rate limit is retried; a range refusal narrows
 * the page; anything else is a gap. The match is on the provider's own words and codes because
 * viem wraps them differently per transport (measured: arc.io says -32005 "rate limit exceeded" and
 * -32012 "requested range too large"; tenderly says -32602 "query exceeds max block range 100000").
 * @param {any} err @returns {'throttled'|'range'|'other'}
 */
export function classifyRpcError(err) {
  const text = [err?.shortMessage, err?.message, err?.details, err?.code, err?.cause?.message, err?.cause?.details, err?.cause?.code, err?.cause?.cause?.message, err?.cause?.cause?.code]
    .filter((x) => x !== undefined && x !== null)
    .join(' ');
  if (/rate.?limit|-32005|\b429\b|too many requests|limit exceeded/i.test(text)) return 'throttled';
  if (/range|too large|max block|exceeds|-32012|-32602|limited to|10,?000|too many results|response size/i.test(text)) return 'range';
  return 'other';
}

/**
 * The block a vault was created in: the first block where it has code, found by bisection on
 * `eth_getCode` (VaultCore stores no creation block).
 *
 * A pruning RPC can answer `0x` for state it no longer holds, which would make the bisection land
 * LATE and hide every realization before that block behind a confident empty result. So the answer
 * is confirmed against a positive control that does not depend on state: the registry's own
 * `VaultAttested` log for this vault, which the factory triggers inside the creating transaction, must
 * be in exactly that block. If it is not, the creation block is unconfirmed and the scan does not start.
 */
async function findCreationBlock({ c, retrying, sleep, paceMs, registry, vault, head }) {
  const codeAt = async (block) => {
    const code = await retrying(() => c.getCode({ address: vault, blockNumber: BigInt(block) }));
    return typeof code === 'string' && code.length > 2;
  };
  try {
    if (!(await codeAt(head))) return { ok: false, gap: `the vault has no code at the head (block ${head})` };
    let lo = 0;
    let hi = head;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (paceMs() > 0) await sleep(paceMs());
      if (await codeAt(mid)) hi = mid;
      else lo = mid + 1;
    }
    const control = await retrying(() => c.getLogs({ address: registry, event: VAULT_ATTESTED_EVENT, args: { vault }, fromBlock: BigInt(lo), toBlock: BigInt(lo) }));
    if (!Array.isArray(control) || control.length === 0)
      return {
        ok: false,
        gap: `creation block ${lo} is unconfirmed: the registry's VaultAttested for this vault is not in that block, so the RPC may be pruning state or logs`,
      };
    return { ok: true, block: lo };
  } catch (err) {
    return { ok: false, gap: `the creation block could not be found: ${String(err?.shortMessage ?? err?.message ?? err)}` };
  }
}

/**
 * The viem chain object a reader builds for its RPC. The gas asset comes from the caller (the
 * config's `chain.nativeCurrency`) rather than being fixed to Ether, because Arc pays gas in USDC.
 * @param {{chainId:number, chainName:string, nativeCurrency:{name:string,symbol:string,decimals:number}, rpcUrl:string}} p
 */
export const viemChainFor = ({ chainId, chainName, nativeCurrency, rpcUrl }) => ({
  id: chainId,
  name: chainName,
  nativeCurrency,
  rpcUrls: { default: { http: [rpcUrl] } },
});

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
 * @param {{name:string,symbol:string,decimals:number}} [cfg.nativeCurrency] the chain's gas asset (config.chain.nativeCurrency)
 * @param {string|null} [cfg.governance]
 * @param {(e:{level:string,msg:string,detail?:any})=>void} [cfg.onEvent]
 * @param {(ms:number)=>Promise<void>} [cfg.sleep]  injected so tests do not wait on the pacing and backoff
 */
export function createChainReader({ client, rpcUrl, chainId = 84532, chainName = 'base-sepolia', nativeCurrency = { name: 'Ether', symbol: 'ETH', decimals: 18 }, governance = null, onEvent = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let _client = client ?? null;
  const failures = new Map(); // vault ⇒ consecutive NAV read failures
  /**
   * `${registry}:${opId}:${vault}` ⇒ the realization scan so far. Session-scoped and in memory, the
   * same pattern as the agent's entry marks: the logs are append-only, so a later tick resumes at
   * the watermark instead of reading the range again, and a restarted agent simply scans again.
   * @type {Map<string, {creationBlock:number|null, scanFrom:number, scannedTo:number, windowGap:string|null, pageBlocks:number, byMember:Map<string,{gain:bigint,loss:bigint,events:number}>, pages:number}>}
   */
  const realizationScans = new Map();
  /** The pause a rate limit has taught this reader, ms. Only ever widened, and kept across calls. */
  let learnedPaceMs = 0;

  async function getClient() {
    if (_client) return _client;
    if (!rpcUrl) throw new Error('chain: no client injected and no rpcUrl provided');
    const { createPublicClient, http } = await import('viem').catch(() => {
      throw new Error('chain: viem is not installed — run `npm install viem` at the repo root');
    });
    _client = createPublicClient({
      chain: viemChainFor({ chainId, chainName, nativeCurrency, rpcUrl }),
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
     * Refuse unless the RPC actually answers for `chainId` (#204). `run.mjs` calls this right after
     * building the reader, before the first read.
     *
     * `chainId` here DEFAULTS to 84532, and `run.mjs`'s `TESTNET_CHAIN_IDS` gate tests that declared
     * value rather than one read from the RPC — so `--rpc <some mainnet>` with `--chain-id` left
     * alone passes the testnet gate and then reads mainnet addresses believing it is on Base
     * Sepolia. This closes that: the declared id is checked AGAINST the connection instead of being
     * asserted onto it.
     *
     * Only the `rpcUrl` path is bound; an injected client (tests) came from this same process.
     * Throws `ChainBindingError` rather than degrading a field — every `read` below is deliberately
     * fault-tolerant, and "one field came back null" is not how a wrong chain should present.
     */
    async assertBoundToDeclaredChain() {
      if (client) return { ok: true, message: 'client injected — no RPC was resolved by this module' };
      return assertChainBinding({
        client: await getClient(),
        declaredChainId: chainId,
        rpc: rpcUrl ?? '(no rpcUrl)',
        declaredBy: `the agent --chain-id (${chainName})`,
      });
    },

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
     * The vault set, read from the factory instead of an API.
     *
     * Newest first, and bounded twice: at most `maxVaults` entries are looked at (the NEWEST ones,
     * since a vault with no history is where a new opportunity appears), and they are read
     * `pageSize` at a time, so one tick costs at most `maxVaults` indexed reads however many vaults
     * the factory holds. `total` is reported either way so the caller can say the list is a window.
     *
     * A failed `vaultCount` returns `total: null` and no addresses; a failed `allVaults(i)` is
     * counted in `failedIndexes` and skipped. Neither throws, and neither is read as "no vaults".
     *
     * @param {string|null} factory  VaultFactory address (config.chain.factory)
     * @param {{maxVaults?:number, pageSize?:number}} [opts]
     * @returns {Promise<{total:number|null, addresses:string[], truncated:boolean, failedIndexes:number[]}>}
     */
    async listFactoryVaults(factory, { maxVaults = 25, pageSize = 10 } = {}) {
      if (!factory) return { total: null, addresses: [], truncated: false, failedIndexes: [] };
      assert(Number.isInteger(maxVaults) && maxVaults > 0, 'chain: maxVaults must be a positive integer');
      assert(Number.isInteger(pageSize) && pageSize > 0, 'chain: pageSize must be a positive integer');
      const count = await read(lc(factory), FACTORY_READ_ABI, 'vaultCount');
      if (!count.ok) return { total: null, addresses: [], truncated: false, failedIndexes: [] };
      const total = Number(count.value);
      const newest = total - 1; // allVaults is zero-indexed: the last entry is vaultCount - 1
      const oldest = Math.max(0, total - maxVaults);
      const addresses = [];
      const failedIndexes = [];
      for (let top = newest; top >= oldest; top -= pageSize) {
        const bottom = Math.max(oldest, top - pageSize + 1);
        const indexes = [];
        for (let i = top; i >= bottom; i--) indexes.push(i);
        const page = await Promise.all(indexes.map((i) => read(lc(factory), FACTORY_READ_ABI, 'allVaults', [BigInt(i)])));
        page.forEach((r, k) => {
          if (r.ok) addresses.push(lc(r.value));
          else failedIndexes.push(indexes[k]);
        });
      }
      return { total, addresses, truncated: total > maxVaults, failedIndexes };
    },

    /**
     * The per-vault facts the vault list needs that `readVault` does not already carry:
     * `holderCount` (addresses with shares, creator included), `creator`, and the registry the
     * vault itself points at (to compare with the one the config trusts). Null on a failed read.
     * @param {string} vault
     */
    async readVaultIdentity(vault) {
      const v = lc(vault);
      const [holders, creator, registry] = await Promise.all([
        read(v, VAULT_READ_ABI, 'holderCount'),
        read(v, VAULT_READ_ABI, 'creator'),
        read(v, VAULT_READ_ABI, 'operatorRegistry'),
      ]);
      return {
        holderCount: holders.ok ? Number(holders.value) : null,
        creator: creator.ok ? lc(creator.value) : null,
        operatorRegistry: registry.ok ? lc(registry.value) : null,
      };
    },

    /**
     * An operator's record as a leaderboard row, in the shape the indexer projection serves, so
     * `decideJoin` and `decideExit` read it unchanged. The registry holds a row for every
     * registered operator, zeros included, which is also what the indexer's leaderboard lists.
     * Null when `opId` is 0 (unattested), when the registry cannot be read, or when the id has no
     * operator address: an unknown operator is a missing row, never a row of zeros.
     * @param {string|null} registryAddress @param {number} opId
     */
    async readOperatorRecord(registryAddress, opId) {
      if (!registryAddress || !Number.isInteger(opId) || opId <= 0) return null;
      const r = await read(lc(registryAddress), OPERATOR_REGISTRY_READ_ABI, 'leaderboardEntry', [BigInt(opId)]);
      if (!r.ok) return null;
      const operator = Array.isArray(r.value) ? r.value[0] : r.value?.operator;
      const stats = Array.isArray(r.value) ? r.value[1] : r.value?.stats;
      if (!operator || /^0x0{40}$/i.test(operator) || !stats) return null;
      // A stat the decode did not return is an unreadable record, not a zero: a zero net would
      // pass the floor when requireProvenOperator is off.
      const raw = (i, name) => (Array.isArray(stats) ? stats[i] : stats[name]);
      if ([0, 1, 2, 3].some((i) => raw(i, ['lifetimeGainUsdc', 'lifetimeLossUsdc', 'lifetimeFeesUsdc', 'vaultCount'][i]) == null)) return null;
      const field = (i, name) => BigInt(raw(i, name));
      const gain = field(0, 'lifetimeGainUsdc');
      const loss = field(1, 'lifetimeLossUsdc');
      return {
        operatorId: opId,
        operator: lc(operator),
        netRealizedUsdc: (gain - loss).toString(),
        lifetimeGainUsdc: gain.toString(),
        lifetimeLossUsdc: loss.toString(),
        lifetimeFeesUsdc: field(2, 'lifetimeFeesUsdc').toString(),
        vaultCount: Number(field(3, 'vaultCount')),
      };
    },

    /**
     * Every realization the operator's vaults recorded, per member, read from the registry's
     * `RealizationRecorded` logs from this vault's creation block to the head.
     *
     * The scan is bounded three ways and each bound is a NAMED gap, never an empty result:
     * `budget.pages` caps the log requests this tick (the scan resumes from its watermark on the next
     * call), `maxBlocks` caps how far behind the head a scan will start, and a request that fails is
     * reported with the provider's own error. `complete` is true only when every block from the
     * vault's creation to the head was read. Never throws.
     *
     * Filtered on the OPERATOR id, not the vault, so the sum is comparable to the registry's
     * accumulators (`statsOf` adds up every vault of the operator). Blocks before this vault's
     * creation are not read, so an operator with an older vault can have a larger registry total
     * than the window shows; `outsideTrackRecord` (policy.mjs) reports that.
     *
     * @param {Object} p
     * @param {string} p.registry @param {string} p.vault @param {number} p.opId
     * @param {number} [p.pageBlocks]  blocks per getLogs request (the smaller measured limit is 10,000)
     * @param {number} [p.maxBlocks]   never start a scan more than this many blocks behind the head
     * @param {number} [p.pacingMs]    least pause between requests; a rate limit widens it (to 8 s at most) for the session
     * @param {{pages:number}} [p.budget]  mutable: log requests left this tick, decremented here
     * @returns {Promise<{complete:boolean, gap:string|null, creationBlock:number|null, scannedFrom:number|null, scannedTo:number|null, head:number|null, pageBlocks:number, members:Array<{member:string,gain:bigint,loss:bigint,events:number}>}>}
     */
    async readRealizations({ registry, vault, opId, pageBlocks = 10_000, maxBlocks = 20_000_000, pacingMs = 1000, budget = { pages: Infinity } }) {
      assert(Number.isInteger(pageBlocks) && pageBlocks > 0, 'chain: pageBlocks must be a positive integer');
      assert(Number.isInteger(opId) && opId > 0, 'chain: readRealizations needs an attested operator id');
      const reg = lc(registry);
      const v = lc(vault);
      const key = `${reg}:${opId}:${v}`;
      let st = realizationScans.get(key);
      if (!st) {
        st = { creationBlock: null, scanFrom: 0, scannedTo: -1, windowGap: null, pageBlocks, byMember: new Map(), pages: 0 };
        realizationScans.set(key, st);
      }
      /** @type {number|null} */
      let head = null;
      /** @type {string|null} */
      let gap = null;
      const snapshot = () => {
        const done = gap === null && st.windowGap === null && st.creationBlock !== null && head !== null && st.scannedTo >= head;
        return {
          complete: done,
          gap: gap ?? st.windowGap ?? (done ? null : 'the scan has not reached the head yet'),
          creationBlock: st.creationBlock,
          scannedFrom: st.creationBlock === null ? null : st.scanFrom,
          scannedTo: st.creationBlock === null ? null : st.scannedTo,
          head,
          pageBlocks: st.pageBlocks,
          members: [...st.byMember].map(([member, t]) => ({ member, ...t })),
        };
      };
      const describe = (err) => String(err?.shortMessage ?? err?.message ?? err);
      const paceMs = () => Math.max(pacingMs, learnedPaceMs);
      /**
       * Retry a rate-limited call with backoff (1, 2, 4, 8 s); anything else, or the last failure, is
       * rethrown. Each rate limit also doubles the pause between requests for the rest of the session,
       * because a sustained scan that keeps hitting the limit only spends its retries.
       */
      const retrying = async (call) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await call();
          } catch (err) {
            if (classifyRpcError(err) !== 'throttled' || attempt >= 4) throw err;
            learnedPaceMs = Math.min(MAX_LEARNED_PACE_MS, Math.max(paceMs(), 500) * 2);
            await sleep(1000 * 2 ** attempt);
          }
        }
      };

      try {
        const c = await getClient();
        head = Number(await retrying(() => c.getBlockNumber()));

        if (st.creationBlock === null) {
          const found = await findCreationBlock({ c, retrying, sleep, paceMs, registry: reg, vault: v, head });
          if (!found.ok) {
            gap = found.gap;
            return snapshot();
          }
          st.creationBlock = found.block;
          st.scanFrom = Math.max(found.block, head - maxBlocks + 1);
          st.scannedTo = st.scanFrom - 1;
          st.windowGap =
            st.scanFrom > found.block
              ? `the vault was created at block ${found.block}, more than discovery.logs.maxBlocks (${maxBlocks}) behind the head; blocks ${found.block} to ${st.scanFrom - 1} are not read`
              : null;
        }

        while (st.scannedTo < head) {
          if (budget.pages <= 0) {
            gap = `this tick's log-request budget is spent at block ${st.scannedTo} of ${head}; the scan resumes next tick`;
            break;
          }
          const from = st.scannedTo + 1;
          let to = Math.min(head, from + st.pageBlocks - 1);
          /** @type {any[]|null} */
          let logs = null;
          for (;;) {
            try {
              logs = await retrying(() =>
                c.getLogs({ address: reg, event: REALIZATION_EVENT, args: { opId: BigInt(opId) }, fromBlock: BigInt(from), toBlock: BigInt(to) }),
              );
              break;
            } catch (err) {
              const kind = classifyRpcError(err);
              if (kind === 'range' && st.pageBlocks > MIN_LOG_PAGE_BLOCKS) {
                // The provider's limit is below the configured page: narrow it for the rest of the scan.
                st.pageBlocks = Math.max(MIN_LOG_PAGE_BLOCKS, Math.floor(st.pageBlocks / 2));
                to = Math.min(head, from + st.pageBlocks - 1);
                continue;
              }
              gap = `eth_getLogs ${from} to ${to} failed (${kind === 'throttled' ? 'rate limited after retries' : kind === 'range' ? 'range refused even at the smallest page' : 'error'}): ${describe(err)}`;
              break;
            }
          }
          if (logs === null) break;
          budget.pages -= 1;
          st.pages += 1;
          for (const log of logs) {
            const a = log.args ?? {};
            if (a.member == null || a.gainUsdc == null || a.lossUsdc == null)
              throw new Error(`RealizationRecorded log without decoded args at block ${log.blockNumber}`);
            const member = lc(a.member);
            const t = st.byMember.get(member) ?? { gain: 0n, loss: 0n, events: 0 };
            t.gain += BigInt(a.gainUsdc);
            t.loss += BigInt(a.lossUsdc);
            t.events += 1;
            st.byMember.set(member, t);
          }
          st.scannedTo = to;
          if (st.scannedTo < head && paceMs() > 0) await sleep(paceMs());
        }
      } catch (err) {
        gap = `realization logs unreadable: ${describe(err)}`;
        onEvent({ level: 'warn', msg: 'chain read failed: RealizationRecorded logs', detail: { vault: v, error: gap } });
      }
      return snapshot();
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

    /**
     * The latest block's timestamp, in seconds. `Governance.finalize`, `execute` and `markExpired`
     * all gate on `block.timestamp`, so the crank decides on this and not on the agent's clock.
     * Null on a failed read (the planner then falls back to the local clock with a margin).
     * @returns {Promise<number|null>}
     */
    async readBlockTimestamp() {
      try {
        const c = await getClient();
        const block = await c.getBlock({ blockTag: 'latest' });
        const ts = Number(block?.timestamp);
        return Number.isSafeInteger(ts) && ts > 0 ? ts : null;
      } catch (err) {
        onEvent({ level: 'warn', msg: 'chain read failed: latest block timestamp', detail: { error: String(err?.shortMessage ?? err?.message ?? err) } });
        return null;
      }
    },

    /**
     * Simulate one write: an `eth_call` of the exact calldata, from `from` when given. Read-only,
     * so it runs in dry-run too. Never throws.
     *
     * `{ ok: true }` means the call did not revert against the latest block. `{ ok: false,
     * reverted: true, error }` means the contract rejected it (a lost `finalize` race reverts
     * `WrongPhase`); `{ ok: false, reverted: false, error }` means the simulation itself could not
     * run (the RPC failed), which the caller treats the same way: do not send what was not checked.
     *
     * Pass an ABI that includes the contract's `error` fragments to get the error NAME back.
     *
     * @param {{to:string, abi:any[], functionName:string, args:any[]}} call
     * @param {{from?:string|null}} [opts]
     * @returns {Promise<{ok:true}|{ok:false, reverted:boolean, error:string}>}
     */
    async simulateCall({ to, abi, functionName, args }, { from = null } = {}) {
      try {
        const c = await getClient();
        await c.simulateContract({ address: to, abi, functionName, args, ...(from ? { account: from } : {}) });
        return { ok: true };
      } catch (err) {
        const revert = typeof err?.walk === 'function' ? err.walk((e) => e?.name === 'ContractFunctionRevertedError') : null;
        const error = revert
          ? String(revert.data?.errorName ?? revert.reason ?? revert.shortMessage ?? 'reverted')
          : String(err?.shortMessage ?? err?.message ?? err);
        return { ok: false, reverted: Boolean(revert), error };
      }
    },
  };
}

/**
 * A chain reader with no chain behind it. Used by the demo run and the tests: it answers from a
 * fixture and marks every value it produces so the narrative cannot be mistaken for live data.
 * The demo run uses this whenever no RPC is configured: `config.mjs` defaults `chain.rpcUrl` to
 * null, and `run.mjs` builds the real reader only when that value is set.
 *
 * @param {Record<string, any>} fixture  vault ⇒ partial readVault result
 * @param {Record<string, any>} [govFixture]  vault ⇒ partial readGovernance result
 * @param {Object} [opts]
 * @param {number|null} [opts.blockTimestamp]  what `readBlockTimestamp` answers (null: unreadable)
 * @param {(call:any, opts:any)=>{ok:boolean, reverted?:boolean, error?:string}} [opts.simulate]  what `simulateCall` answers
 */
export function createStubChainReader(fixture = {}, govFixture = {}, { blockTimestamp = null, simulate = () => ({ ok: true }) } = {}) {
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
    async listFactoryVaults(_factory, { maxVaults = 25 } = {}) {
      const all = Object.keys(fixture);
      return { total: all.length, addresses: all.slice(-maxVaults).reverse(), truncated: all.length > maxVaults, failedIndexes: [] };
    },
    async readVaultIdentity(vault) {
      const f = fixture[lc(vault)] ?? {};
      return { holderCount: f.holderCount ?? 0, creator: f.creator ?? null, operatorRegistry: f.operatorRegistry ?? null };
    },
    async readOperatorRecord(_registry, opId) {
      return opId > 0 ? { operatorId: opId, operator: '0x' + '0'.repeat(39) + '1', netRealizedUsdc: '0', lifetimeGainUsdc: '0', lifetimeLossUsdc: '0', lifetimeFeesUsdc: '0', vaultCount: 1 } : null;
    },
    async readRealizations({ vault }) {
      // A fixture may state the vault's realizations; otherwise the stub says it read none, as a gap.
      const r = fixture[lc(vault)]?.realizations;
      if (r) return r;
      return { complete: false, gap: 'stub reader: no chain, no logs', creationBlock: null, scannedFrom: null, scannedTo: null, head: null, pageBlocks: 0, members: [] };
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
    async readBlockTimestamp() {
      return blockTimestamp;
    },
    async simulateCall(call, o = {}) {
      return simulate(call, o);
    },
  };
}
