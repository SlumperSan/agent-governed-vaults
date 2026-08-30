// @ts-check
/**
 * Mocked chain plumbing shared by the canary tests. NO LIVE RPC ANYWHERE — every test in this
 * package injects one of these readers, which is exactly the interface reader.mjs exposes.
 *
 * A contract is declared as `{ address: { fnName: value | fn(args) | {revert: '0xselector…'} } }`.
 * Returning `{revert}` makes tryRead/read behave the way viem does on a revert, carrying the
 * returndata, so the signals' revert-classification paths are exercised for real.
 */

export const A = (c) => `0x${String(c).repeat(40).slice(0, 40)}`;

// Real 20-byte hex — resolveCanaryConfig validates addresses, so a fixture with a stray
// non-hex character would fail config parsing rather than the behaviour under test.
export const VAULT = `0x${'a1'.repeat(18)}cafe`;
export const CHILD = `0x${'b2'.repeat(18)}beef`;
export const ORACLE = A('1');
export const USDC = A('2');
export const ASSET = A('3');
export const REGISTRY = A('4');
export const CREATOR = A('5');
export const MEMBER = A('6');
export const OPERATOR = A('7');
export const FEE_ENGINE = A('8');
/** The asset's single Chainlink Data Feed, and the L2 sequencer uptime feed (see ChainlinkOracle). */
export const FEED = A('a');
export const SEQ_FEED = A('b');
export const ZERO_ADDR = `0x${'0'.repeat(40)}`;

const lc = (x) => (typeof x === 'string' ? x.toLowerCase() : x);

class MockRevert extends Error {
  constructor(data) {
    super(`execution reverted${data ? ` (${data})` : ''}`);
    this.data = data ?? undefined;
    this.shortMessage = this.message;
  }
}

/**
 * @param {Object} cfg
 * @param {Record<string, Record<string, any>>} cfg.contracts
 * @param {Array<any>} [cfg.logs]           each: {address, eventName, blockNumber, logIndex, args, transactionHash}
 * @param {number} [cfg.head]
 * @param {number} [cfg.nowSec]
 * @param {(ctx:{to:string,from:string,data:string})=>{ok:boolean,data?:string|null}} [cfg.onStaticCall]
 * @param {Set<number>} [cfg.archiveBlocks] heights whose state the mock node can serve (default: all)
 */
export function mockReader({ contracts, logs = [], head = 1000, nowSec = 1_700_000_000, onStaticCall, archiveBlocks }) {
  /** every call the reader made, so tests can assert on read pinning */
  const calls = [];

  function resolve(address, fn, args, opts) {
    const c = contracts[lc(address)];
    if (!c) throw new MockRevert(null);
    if (opts?.blockNumber != null && archiveBlocks && !archiveBlocks.has(Number(opts.blockNumber))) {
      throw new Error(`missing trie node: no state for block ${opts.blockNumber}`);
    }
    if (!(fn in c)) throw new MockRevert(null);
    const entry = c[fn];
    const value = typeof entry === 'function' ? entry(...args) : entry;
    if (value && typeof value === 'object' && 'revert' in value) throw new MockRevert(value.revert);
    return value;
  }

  const reader = {
    async headBlock() { return head; },
    async chainNow() { return nowSec; },
    async read(address, _abi, fn, args = [], opts = {}) {
      calls.push({ kind: 'read', address: lc(address), fn, args, blockNumber: opts.blockNumber ?? null });
      return resolve(address, fn, args, opts);
    },
    async tryRead(address, _abi, fn, args = [], opts = {}) {
      try {
        return { ok: true, value: await reader.read(address, _abi, fn, args, opts) };
      } catch (err) {
        return { ok: false, revertData: err.data ?? null, error: err.message };
      }
    },
    async getLogs({ address, event, args, fromBlock, toBlock }) {
      const addrs = new Set((Array.isArray(address) ? address : [address]).map(lc));
      return logs.filter((l) => addrs.has(lc(l.address))
        && l.eventName === event.name
        && Number(l.blockNumber) >= Number(fromBlock)
        && Number(l.blockNumber) <= Number(toBlock)
        && (!args || Object.entries(args).every(([k, v]) => lc(l.args?.[k]) === lc(v))));
    },
    async staticCall(ctx) {
      calls.push({ kind: 'staticCall', ...ctx });
      return onStaticCall ? onStaticCall(ctx) : { ok: true, data: '0x' };
    },
    calls,
  };
  return reader;
}

/** A log in the shape viem's getLogs returns (bigint blockNumber, decoded args). */
export function log(address, eventName, blockNumber, args, { logIndex = 0, transactionHash = '0xtx' } = {}) {
  return { address, eventName, blockNumber: BigInt(blockNumber), logIndex, args, transactionHash };
}

/**
 * A single-vault fixture that is HEALTHY on every signal, so each test can perturb exactly one
 * thing and prove the signal reacts to that and nothing else.
 *
 * NAV arithmetic (mirrors VaultCore.navWad):
 *   idleUsdc 1_000_000 (1 USDC, 6dp) * usdcScalar 1e12                       = 1e18
 *   assetBalance[ASSET] 2e18 * priceWad 3e18 / assetUnit 1e18                = 6e18
 *   navWad                                                                   = 7e18
 *
 * THE ORACLE IS THE DEPLOYED ONE. It answers the {ChainlinkOracle} surface — `feedOf`, `usdc`,
 * `sequencerUptimeFeed`, `GRACE_PERIOD` — with the shape the C-6 pivot actually put on Base Sepolia:
 * one Chainlink feed per asset, an 86,400 s heartbeat, USDC pinned, and NO sequencer uptime feed
 * (address(0), deliberate off Base mainnet). The freshness signal used to be fixtured against the
 * RETIRED aggregator's `assetConfig`, which is why its tests passed while the live signal was blind.
 * A fixture that models a contract the launch tree does not deploy proves nothing.
 *
 * Feed arithmetic: answer 3e8 (8 decimals, $3.00) * scale 1e10 = priceWad 3e18, matching the NAV
 * above; last update 1,000 s into the 86,400 s heartbeat, i.e. ~98.8% headroom.
 */
export function healthyVault(overrides = {}) {
  const FEED_UPDATED_AT = 1_699_999_000n; // 1,000 s before the tests' NOW
  const feedRound = { latestRoundData: () => [1n, 300_000_000n, FEED_UPDATED_AT, FEED_UPDATED_AT, 1n] };

  const contracts = {
    [VAULT]: {
      navWad: 7_000000000000000000n,
      totalShares: 500_000000000000000000n,
      idleUsdc: 1_000_000n,
      totalPendingUsdc: 0n,
      usdcScalar: 1_000000000000n,
      usdc: USDC,
      oracle: ORACLE,
      feeEngine: FEE_ENGINE,
      creator: CREATOR,
      operatorRegistry: REGISTRY,
      basketLength: 1n,
      basketAssets: () => ASSET,
      assetUnit: (a) => (lc(a) === lc(ASSET) ? 1_000000000000000000n : 0n),
      assetBalance: (a) => (lc(a) === lc(ASSET) ? 2_000000000000000000n : 0n),
      childVaultCount: 0n,
      childVaults: () => { throw new Error('no children'); },
      sharesOf: () => 0n,
    },
    [ORACLE]: {
      priceWad: () => 3_000000000000000000n,
      // (feed, heartbeat, scale, minPriceWad, maxPriceWad) — the public `feedOf` mapping getter.
      // Sane-price band $1..$100 (WAD); the fixture's $3.00 sits inside it.
      feedOf: (a) => (lc(a) === lc(ASSET)
        ? [FEED, 86_400, 10_000_000_000n, 1_000000000000000000n, 100_000000000000000000n]
        : [ZERO_ADDR, 0, 0n, 0n, 0n]),
      usdc: () => USDC,
      sequencerUptimeFeed: () => ZERO_ADDR, // off a sequencer L2: ChainlinkOracle skips the gate
      GRACE_PERIOD: () => 3600n,
    },
    [FEED]: feedRound,
    [USDC]: { balanceOf: () => 1_000_000n },
    [ASSET]: { balanceOf: () => 2_000000000000000000n },
    [REGISTRY]: {
      operatorOf: () => 7n,
      operatorAddressOf: () => OPERATOR,
    },
  };

  for (const [addr, patch] of Object.entries(overrides)) {
    contracts[lc(addr)] = { ...(contracts[lc(addr)] ?? {}), ...patch };
  }
  return contracts;
}

/** The indexer projection state the canary reads, matching the healthy fixture. */
export function healthyState({ totalShares = 500_000000000000000000n, book, lastBlock = 995 } = {}) {
  return {
    vaults: new Map([[VAULT, { vault: VAULT, totalShares, creator: CREATOR }]]),
    shares: new Map([[VAULT, book ?? new Map([[MEMBER, 400_000000000000000000n], [CREATOR, 100_000000000000000000n]])]]),
    operators: new Map(),
    proposals: new Map(),
    activeProposal: new Map(),
    lastBlock,
    lastLogIndex: 0,
  };
}
