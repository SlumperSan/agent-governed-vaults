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
export const GOVERNANCE = A('9');
export const SRC1 = A('a');
export const SRC2 = A('b');
export const SRC3 = A('c');

/**
 * Chainlink USDC/USD reference feed — `signals/depeg-reference.mjs` (G4). resolveCanaryConfig
 * defaults `usdcUsdFeed` to this SAME address on chainId 8453 (the default `baseCfg` in
 * runner.test.mjs never sets CHAIN_ID), so every fixture below carries a healthy $1.00 entry for
 * it — otherwise every full sweep in this package would report a DETECTOR BROKEN depeg leg.
 */
export const USDC_USD_FEED = '0x7e860098f58bbfc8648a4311b374b1d669a2bc6b';

// ChainlinkOracle fixtures (the LIVE oracle). Deliberately not built from A(), so they can never
// collide with the `0x9999…`-style throwaway addresses the existing tests use inline.
export const FEED = `0x${'fe'.repeat(18)}0001`;
export const SEQ_FEED = `0x${'5e'.repeat(18)}0002`;
export const ZERO_ADDR = `0x${'0'.repeat(40)}`;

/** The aggregator currently behind FEED, and the one Chainlink swaps in. */
export const AGGREGATOR = `0x${'a9'.repeat(18)}0003`;
export const AGGREGATOR_2 = `0x${'a9'.repeat(18)}0004`;

/** 8-decimal feed answer of $3.00 — × the 1e10 scale it is the 3e18 the NAV fixture expects. */
export const FEED_ANSWER_3USD = 300_000_000n;
export const FEED_SCALE_8DP = 10_000_000_000n;

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
 */
export function healthyVault(overrides = {}) {
  const oracleSources = [SRC1, SRC2, SRC3];
  const fresh = { latestPrice: [3_000000000000000000n, BigInt(1_699_999_000)] };

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
      // CREATOR holds 100e18 of the 500e18 total (20%, matching healthyState()'s share book below)
      // — comfortably above the 750 bps WARN bar at the launch 500 bps threshold, so the default
      // fixture reads OK on signals/operator-power.mjs (G1). Everyone else holds nothing, matching
      // the pre-existing behaviour every other signal's fixture already assumed.
      sharesOf: (a) => (lc(a) === lc(CREATOR) ? 100_000000000000000000n : 0n),
      governance: () => GOVERNANCE,
      capacityCapUsdc: () => 0n, // uncapped by default
      nonCreatorMemberCount: () => 1n, // MEMBER, per healthyState()'s share book
      CREATOR_MIN_STAKE_BPS: () => 500n,
    },
    [ORACLE]: {
      priceWad: () => 3_000000000000000000n,
      assetConfig: () => [oracleSources, 3600, 2],
    },
    [SRC1]: fresh,
    [SRC2]: fresh,
    [SRC3]: fresh,
    [USDC]: { balanceOf: () => 1_000_000n },
    [ASSET]: { balanceOf: () => 2_000000000000000000n },
    [REGISTRY]: {
      operatorOf: () => 7n,
      operatorAddressOf: () => OPERATOR,
    },
    // Governance smoke defaults from contracts/config/base-mainnet.json's `smoke.gov` block —
    // 500 bps proposalThresholdBps, the same "500 bps at launch" figure CREATOR_MIN_STAKE_BPS
    // carries, so the default fixture's two operator-power legs agree (thresholdsDiffer: false).
    [GOVERNANCE]: {
      vaultRegistered: () => true,
      configOf: () => [3600, 3600, 86400, 86400, 2500, 500, 4000, 21600],
    },
    // A healthy $1.00 reading, 8 decimals, comfortably inside the 0.995..1.005 band — so
    // signals/depeg-reference.mjs (G4) reads OK by default across every fixture in this package.
    [USDC_USD_FEED]: {
      latestRoundData: () => [1n, 100_000000n, 1_699_999_990n, 1_699_999_990n, 1n],
      decimals: () => 8,
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

/**
 * The same healthy vault, priced by a **ChainlinkOracle** instead of the retired aggregator.
 *
 * The oracle entry is REPLACED rather than merged, because the flavor probe in
 * `signals/oracle-health.mjs` distinguishes the two by exactly which functions are absent — leaving
 * a stray `assetConfig` behind would silently route the test down the retired path and prove
 * nothing. Every knob below maps to one branch of `ChainlinkOracle.priceWad`.
 *
 * `priceWad` is a knob, not a derivation, on purpose: the signal treats the contract's own verdict
 * as ground truth and uses the feed fields only to ATTRIBUTE it, so a test must be able to set the
 * verdict and the fields independently — including setting them to disagree.
 */
export function chainlinkVault({
  nowSec = 1_700_000_000,
  heartbeat = 3600,
  ageSec = 10,
  answer = FEED_ANSWER_3USD,
  scale = FEED_SCALE_8DP,
  minPriceWad = 0n,
  maxPriceWad = 0n,
  feed = FEED,
  feedReverts = false,
  // The proxy's self-description, which `signals/feed-identity.mjs` re-checks every sweep. The
  // defaults are the healthy launch shape: 8 decimals (so 10**(18-8) == the 1e10 default `scale`),
  // a USD-quoted description, and a stable aggregator/phaseId pair.
  feedDecimals = 8,
  feedDescription = 'ETH / USD',
  feedAggregator = AGGREGATOR,
  feedPhaseId = 4,
  feedDecimalsReverts = false,
  feedDescriptionReverts = false,
  feedAggregatorReverts = false,
  feedPhaseIdReverts = false,
  priceWadReverts = false,
  priceWadRevertData = '0xa2671f4b', // StaleOracle(address)
  usdcPin = ZERO_ADDR,
  sequencerUptimeFeed = ZERO_ADDR,
  sequencerAnswer = 0n,
  sequencerUpForSec = 7200,
  sequencerReverts = false,
  gracePeriod = 3600n,
  overrides = {},
} = {}) {
  const contracts = { ...healthyVault() };

  contracts[lc(ORACLE)] = {
    // Asset-aware, like the contract: an unlisted asset is the breaker (StaleOracle), not a zero.
    priceWad: (a) => {
      if (priceWadReverts) return { revert: priceWadRevertData };
      if (lc(usdcPin) !== lc(ZERO_ADDR) && lc(a) === lc(usdcPin)) return 1_000000000000000000n;
      if (lc(a) !== lc(ASSET)) return { revert: '0xa2671f4b' };
      return answer * scale;
    },
    feedOf: (a) => (lc(a) === lc(ASSET)
      ? [feed, heartbeat, scale, minPriceWad, maxPriceWad]
      : [ZERO_ADDR, 0, 1n, 0n, 0n]),
    usdc: () => usdcPin,
    sequencerUptimeFeed: () => sequencerUptimeFeed,
    GRACE_PERIOD: () => gracePeriod,
  };

  const stamp = BigInt(nowSec - ageSec);
  const RV = { revert: '0xdeadbeef' };
  contracts[lc(feed)] = {
    latestRoundData: () => (feedReverts ? RV : [1n, answer, stamp, stamp, 1n]),
    decimals: () => (feedDecimalsReverts ? RV : feedDecimals),
    description: () => (feedDescriptionReverts ? RV : feedDescription),
    aggregator: () => (feedAggregatorReverts ? RV : feedAggregator),
    phaseId: () => (feedPhaseIdReverts ? RV : feedPhaseId),
  };

  if (lc(sequencerUptimeFeed) !== lc(ZERO_ADDR)) {
    const started = BigInt(nowSec - sequencerUpForSec);
    contracts[lc(sequencerUptimeFeed)] = {
      latestRoundData: () => (sequencerReverts
        ? { revert: '0xdeadbeef' }
        // updatedAt is deliberately ANCIENT relative to startedAt: the uptime feed only writes on a
        // transition, so a healthy fixture must have a long-unchanged stamp. A detector that
        // staleness-checks this field fails here, which is the point.
        : [1n, sequencerAnswer, started, 1n, 1n]),
    };
  }

  for (const [addr, patch] of Object.entries(overrides)) {
    contracts[lc(addr)] = { ...(contracts[lc(addr)] ?? {}), ...patch };
  }
  return contracts;
}
