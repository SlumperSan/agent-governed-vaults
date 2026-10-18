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
export const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
export const OPERATOR_ADDR = (id) => '0x' + (0xa0 + id).toString(16).repeat(20);

/**
 * @param {Object} spec
 * @param {Array<{address:string, operatorId?:number, realOperatorId?:number, holders?:number, depth?:number, creator?:string, capUsdc?:bigint, registry?:string}>} spec.vaults  in factory order (index 0 first).
 *   `registry` is the registry the VAULT claims to use; when it is not REGISTRY, that address answers `operatorOf`
 *   with `operatorId` (a spoofed attestation) while REGISTRY answers with `realOperatorId ?? operatorId`.
 * @param {Record<number, {gain?:bigint, loss?:bigint, fees?:bigint, vaultCount?:number, operator?:string}>} [spec.operators]
 * @param {Set<string>} [spec.failing]  `${functionName}` or `${functionName}:${arg}` to make revert
 */
export function createFakeChainClient({ vaults, operators = {}, failing = new Set() }) {
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
        if (functionName === 'hasPendingExecution') return false;
        if (functionName === 'activeProposalOf') return 0n;
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
        }
      }
      throw new Error(`fake chain: unhandled ${functionName} on ${a}`);
    } finally {
      inFlight--;
    }
  }

  return {
    readContract,
    calls,
    get maxInFlight() { return maxInFlight; },
    resetPeak() { maxInFlight = 0; },
    count: (fn) => calls.filter((c) => c.functionName === fn).length,
  };
}
