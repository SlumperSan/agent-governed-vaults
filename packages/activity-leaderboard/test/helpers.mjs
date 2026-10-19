// @ts-check
/**
 * Test helpers: plain ledger events, and a fake chain that behaves like VaultCore for the two
 * events the reducer reads (same share and cost-basis rules as contracts/src/VaultCore.sol) and
 * exposes a viem-shaped client. No network anywhere.
 */

export const DAY = 86_400;
export const USDC = 1_000_000n;
export const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
export const VAULT = addr(0xaa01);
export const A = addr(0x1001);
export const B = addr(0x1002);
export const C = addr(0x1003);

let seq = 0;
/** A deposit event for the reducer. `sharesAfter` is the balance after the deposit. */
export const dep = (member, amountUsdc, sharesAfter, timestamp, extra = {}) => ({
  type: 'deposit', vault: VAULT, member, amountUsdc, sharesAfter,
  blockNumber: extra.blockNumber ?? ++seq + 1000, logIndex: extra.logIndex ?? 0, timestamp,
});
export const exit = (member, sharesBurned, timestamp, extra = {}) => ({
  type: 'exit', vault: VAULT, member, sharesBurned,
  blockNumber: extra.blockNumber ?? ++seq + 1000, logIndex: extra.logIndex ?? 0, timestamp,
});

/** Re-number blocks in timestamp order (stable), the way a chain would have produced them. */
export const chrono = (events) =>
  events.map((e, i) => ({ e, i })).sort((x, y) => x.e.timestamp - y.e.timestamp || x.i - y.i).map(({ e }, k) => ({ ...e, blockNumber: 5000 + k, logIndex: 0 }));

/** Deterministic PRNG so property tests replay. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function shuffled(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A fake chain with one vault. Each operation lands in its own block, `blockSeconds` after the
 * previous unless a timestamp is given. Share price is fixed at `sharesPerUsdc` raw shares per raw
 * USDC unit, so the split property is about the reducer and not about NAV.
 */
export function fakeChain({ chainId = 5042, vault = VAULT, creator = addr(0xc0de), startBlock = 100, startTs = 1_000_000, sharesPerUsdc = 10n ** 12n } = {}) {
  const shares = new Map();
  const basis = new Map();
  const logs = [];
  const stamped = [[startBlock, startTs]];
  let block = startBlock;
  let ts = startTs;
  const stamp = (t) => { const nt = t ?? ts + 2; block += Math.max(1, Math.floor((nt - ts) / 2)); ts = nt; stamped.push([block, ts]); return block; };
  const tsAt = (n) => {
    if (n <= startBlock) return Math.max(0, startTs - 2 * (startBlock - n));
    let p = stamped[0];
    let q = null;
    for (const e of stamped) { if (e[0] <= n) p = e; else { q = e; break; } }
    return q ? p[1] + Math.floor(((q[1] - p[1]) * (n - p[0])) / (q[0] - p[0])) : p[1] + 2 * (n - p[0]);
  };
  const codes = new Map();

  const api = {
    deposit(member, amount, t) {
      const b = stamp(t);
      const minted = amount * sharesPerUsdc;
      shares.set(member, (shares.get(member) ?? 0n) + minted);
      basis.set(member, (basis.get(member) ?? 0n) + amount);
      logs.push({ address: vault, eventName: 'DepositActivated', blockNumber: BigInt(b), logIndex: 0, args: { member, amountUsdc: amount, sharesAfter: shares.get(member) } });
      return b;
    },
    exit(member, burn, t) {
      const b = stamp(t);
      const held = shares.get(member) ?? 0n;
      const removed = (basis.get(member) ?? 0n) * burn / held;
      shares.set(member, held - burn);
      basis.set(member, (basis.get(member) ?? 0n) - removed);
      logs.push({ address: vault, eventName: 'ExitSettled', blockNumber: BigInt(b), logIndex: 0, args: { member, sharesBurned: burn, usdcPaid: removed, exitFeeBps: 0n, perfFeeUsdc: 0n } });
      return b;
    },
    advanceTo(t) { stamp(t); },
    setCode(address, code) { codes.set(address.toLowerCase(), code); },
    get head() { return block; },
    get ts() { return ts; },
    sharesOf: (m) => shares.get(m) ?? 0n,
    basisOf: (m) => basis.get(m) ?? 0n,
    /** Optional lie injected into readContract, to prove the head check aborts. */
    lie: null,
    getLogsCalls: [],
    client: null,
  };

  api.client = {
    async getChainId() { return chainId; },
    async getBlockNumber() { return BigInt(block); },
    async getBlock({ blockNumber }) {
      const n = Number(blockNumber);
      return { number: BigInt(n), hash: `0x${n.toString(16).padStart(64, '0')}`, timestamp: BigInt(tsAt(n)) };
    },
    async getLogs({ address, fromBlock, toBlock }) {
      api.getLogsCalls.push([Number(fromBlock), Number(toBlock)]);
      if (Number(toBlock) - Number(fromBlock) + 1 > 10_000) throw new Error('range too large');
      return logs.filter((l) => l.address.toLowerCase() === String(address).toLowerCase() && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    async readContract({ functionName, args }) {
      if (functionName === 'creator') return creator;
      if (functionName === 'totalShares') {
        const total = [...shares.values()].reduce((a, b) => a + b, 0n);
        return api.lie ? api.lie('totalShares', undefined, total) : total;
      }
      const m = args[0];
      const v = functionName === 'sharesOf' ? api.sharesOf(m) : api.basisOf(m);
      return api.lie ? api.lie(functionName, m, v) : v;
    },
    async getCode({ address }) { return codes.get(address.toLowerCase()) ?? '0x'; },
  };
  return api;
}
