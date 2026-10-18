// @ts-check
/**
 * An in-memory stand-in for a viem public client, serving the reads chain-only discovery makes:
 * the factory's vault array, the operator registry, and one vault's own views. It behaves like the
 * chain where it matters here: `allVaults(i)` REVERTS past the end of the array (an off-by-one
 * therefore shows up as a missing vault, not as a quiet zero), and every call is recorded so a test
 * can count reads and observe how many were in flight at once.
 */
const USDC = 10n ** 6n;
const WAD = 10n ** 18n;

export const FACTORY = '0x' + 'f0'.repeat(20);
export const REGISTRY = '0x' + 'e1'.repeat(20);
export const SUBVAULT_REGISTRY = '0x' + 'd2'.repeat(20);
export const GOVERNANCE = '0x' + 'c3'.repeat(20);
export const ZERO_HASH = '0x' + '0'.repeat(64);

/**
 * The sixteen-field tuple `Governance.proposals(pid)` returns, positionally, as viem decodes it.
 * @param {Object} f
 */
export const proposalTuple = ({ vault, ptype = 0, proposer = '0x' + 'a1'.repeat(20), createdAt = 0, commitDeadline = 0, revealDeadline = 0, executableAt = 0, expiresAt = 0, status = 1, actionHash = ZERO_HASH, snapshotTotal = 0n, memberCount = 5n }) => [
  vault, ptype, proposer, BigInt(createdAt), BigInt(commitDeadline), BigInt(revealDeadline), BigInt(executableAt), BigInt(expiresAt), status, actionHash, snapshotTotal, memberCount, 0n, 0n, 0n, 0n,
];

export const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
export const OPERATOR_ADDR = (id) => '0x' + (0xa0 + id).toString(16).repeat(20);

/**
 * @param {Object} spec
 * @param {Array<{address:string, shares?:bigint, operatorId?:number, realOperatorId?:number, holders?:number, depth?:number, creator?:string, capUsdc?:bigint, registry?:string}>} spec.vaults  in factory order (index 0 first).
 *   `registry` is the registry the VAULT claims to use; when it is not REGISTRY, that address answers `operatorOf`
 *   with `operatorId` (a spoofed attestation) while REGISTRY answers with `realOperatorId ?? operatorId`.
 * @param {Record<number, {gain?:bigint, loss?:bigint, fees?:bigint, vaultCount?:number, operator?:string}>} [spec.operators]
 * @param {Set<string>} [spec.failing]  `${functionName}` or `${functionName}:${arg}` to make revert
 * @param {Record<string, {pid:bigint, tuple:any[], pending?:boolean}>} [spec.governance]  vault => its latest proposal. Read LIVE on every call, so a test can mutate `tuple` (for example its status) between ticks.
 * @param {number|null|(() => number|null)} [spec.blockTimestamp]  what `getBlock` reports as the latest timestamp (a function is read on every call); null makes `getBlock` throw
 * @param {(call:any)=>void} [spec.onSimulate]  called with each `simulateContract` request; throw from it to simulate a revert
 */
export function createFakeChainClient({ vaults, operators = {}, failing = new Set(), governance = {}, blockTimestamp = 1_700_000_000, onSimulate = () => {} }) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const byAddress = new Map(vaults.map((v) => [v.address.toLowerCase(), v]));

  async function readContract({ address, functionName, args = [] }) {
    calls.push({ address: address.toLowerCase(), functionName, args });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setImmediate(r)); // let concurrent calls overlap
      if (failing.has(functionName) || failing.has(`${functionName}:${args[0]}`)) throw new Error(`reverted: ${functionName}`);
      const a = address.toLowerCase();

      if (a === FACTORY.toLowerCase()) {
        if (functionName === 'vaultCount') return BigInt(vaults.length);
        if (functionName === 'allVaults') {
          const i = Number(args[0]);
          if (i < 0 || i >= vaults.length) throw new Error('reverted: array out of bounds');
          return vaults[i].address;
        }
      }
      if (a === REGISTRY.toLowerCase()) {
        if (functionName === 'operatorOf') {
          const v = byAddress.get(String(args[0]).toLowerCase());
          return BigInt(v?.realOperatorId ?? v?.operatorId ?? 0);
        }
        if (functionName === 'leaderboardEntry') {
          const o = operators[Number(args[0])];
          if (!o) return ['0x' + '0'.repeat(40), { lifetimeGainUsdc: 0n, lifetimeLossUsdc: 0n, lifetimeFeesUsdc: 0n, vaultCount: 0n }];
          return [
            o.operator ?? OPERATOR_ADDR(Number(args[0])),
            { lifetimeGainUsdc: o.gain ?? 0n, lifetimeLossUsdc: o.loss ?? 0n, lifetimeFeesUsdc: o.fees ?? 0n, vaultCount: BigInt(o.vaultCount ?? 1) },
          ];
        }
      }
      const spoofed = vaults.find((v) => v.registry && v.registry.toLowerCase() === a);
      if (spoofed && functionName === 'operatorOf') return BigInt(spoofed.operatorId ?? 0);
      if (a === SUBVAULT_REGISTRY.toLowerCase()) {
        if (functionName === 'stackedPerfFeeBps') return 1000n;
        if (functionName === 'stackedExitFeeCapBps') return 50n;
        if (functionName === 'depthOf') return BigInt(byAddress.get(String(args[0]).toLowerCase())?.depth ?? 0);
      }
      if (a === GOVERNANCE.toLowerCase()) {
        const g = governance[String(args[0]).toLowerCase()];
        if (functionName === 'hasPendingExecution') return g?.pending ?? false;
        if (functionName === 'activeProposalOf') return g?.pid ?? 0n;
        const byPid = Object.values(governance).find((x) => x.pid === args[0]);
        if (functionName === 'proposals' && byPid) return byPid.tuple;
        if (functionName === 'commitOf') return ZERO_HASH;
        if (functionName === 'revealedOf') return false;
      }
      const v = byAddress.get(a);
      if (v) {
        switch (functionName) {
          case 'holderCount': return BigInt(v.holders ?? 0);
          case 'creator': return v.creator ?? addr(0xc0ffee);
          case 'operatorRegistry': return v.registry ?? REGISTRY;
          case 'navPerShareWad': return WAD;
          case 'totalAssets': case 'totalShares': case 'idleUsdc': case 'totalPendingUsdc': return 0n;
          case 'capacityCapUsdc': return v.capUsdc ?? 0n;
          case 'isCapped': return (v.capUsdc ?? 0n) !== 0n;
          case 'minDepositUsdc': return 100n * USDC;
          case 'OBSERVATION_WINDOW': return 4n * 3600n;
          case 'sharesOf': case 'votingEligibleShares': case 'pastVotingEligibleShares': return v.shares ?? 0n;
          case 'exitFeeBpsOf': return 0n;
          case 'queuedExitShares': return 0n;
          case 'windowCleared': return true;
          case 'skipOptIn': return false;
          case 'pendingDeposit': return [0n, 0n];
        }
      }
      throw new Error(`fake chain: unhandled ${functionName} on ${a}`);
    } finally {
      inFlight--;
    }
  }

  async function getBlock({ blockTag } = {}) {
    calls.push({ address: null, functionName: 'getBlock', args: [blockTag] });
    const ts = typeof blockTimestamp === 'function' ? blockTimestamp() : blockTimestamp;
    if (ts === null) throw new Error('fake chain: getBlock failed');
    return { timestamp: BigInt(ts) };
  }

  async function simulateContract(request) {
    calls.push({ address: String(request.address).toLowerCase(), functionName: `simulate:${request.functionName}`, args: request.args });
    onSimulate(request);
    return { result: undefined, request };
  }

  return {
    readContract,
    getBlock,
    simulateContract,
    calls,
    get maxInFlight() { return maxInFlight; },
    resetPeak() { maxInFlight = 0; },
    count: (fn) => calls.filter((c) => c.functionName === fn).length,
  };
}
