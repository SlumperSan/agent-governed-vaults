// @ts-check
import { keccak256 } from 'viem';
import { DEFAULT_CONFIRMATIONS, DEFAULT_WINDOW_BLOCKS } from './constants.mjs';
import { VAULT_EVENTS, VAULT_READ_ABI } from './abis.mjs';

/**
 * Chain source: pages vault logs in fixed block windows, stamps each with its block timestamp, and
 * answers the few state reads the run needs. All IO goes through a viem-style client that tests
 * inject; `rpcUrl` builds a real one. Nothing here signs or sends anything.
 *
 * Output events are the plain objects ledger.mjs folds. Addresses are lowercase, amounts BigInt.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lc = (a) => a.toLowerCase();

/** @template T,R @param {T[]} items @param {number} n @param {(t:T)=>Promise<R>} fn @returns {Promise<R[]>} */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * @param {object} cfg
 * @param {any} [cfg.client]
 * @param {string} [cfg.rpcUrl]
 * @param {number} cfg.chainId
 * @param {number} [cfg.windowBlocks]
 * @param {number} [cfg.confirmations]
 * @param {number} [cfg.maxTries]  attempts per read when the endpoint says rate limit or times out
 * @param {(ms:number)=>Promise<void>} [cfg.sleep]
 */
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = /rate limit|429|too many requests|timed out|timeout|ECONNRESET|socket hang up/i;

export function createChainReader({
  client, rpcUrl, chainId, windowBlocks = DEFAULT_WINDOW_BLOCKS, confirmations = DEFAULT_CONFIRMATIONS,
  maxTries = 8, sleep = sleepMs,
}) {
  if (!Number.isSafeInteger(windowBlocks) || windowBlocks < 1) throw new Error('source: windowBlocks must be a positive integer');
  let _client = client ?? null;
  async function getClient() {
    if (_client) return _client;
    if (!rpcUrl) throw new Error('source: no client injected and no rpcUrl given');
    const { createPublicClient, http } = await import('viem');
    _client = createPublicClient({
      chain: { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'Native', symbol: 'N', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
      transport: http(rpcUrl, { retryCount: 3, retryDelay: 400 }),
    });
    return _client;
  }

  /**
   * Retry only the failures that are about load (rate limit, timeout), with doubling back-off.
   * Anything else, a wrong answer included, throws at once.
   * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  async function retrying(fn) {
    for (let attempt = 1; ; attempt += 1) {
      try { return await fn(); } catch (e) {
        const msg = e instanceof Error ? `${e.message} ${/** @type {any} */ (e).details ?? ''}` : String(e);
        if (attempt >= maxTries || !TRANSIENT.test(msg)) throw e;
        await sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)));
      }
    }
  }

  /** @type {Map<number, {number:number, hash:string, timestamp:number}>} */
  const blocks = new Map();
  /** @param {number} n */
  async function blockInfo(n) {
    const hit = blocks.get(n);
    if (hit) return hit;
    const c = await getClient();
    const b = await retrying(() => c.getBlock({ blockNumber: BigInt(n) }));
    if (!b || b.number === null || b.hash === null) throw new Error(`source: block ${n} not returned`);
    const info = { number: Number(b.number), hash: String(b.hash), timestamp: Number(b.timestamp) };
    if (info.number !== n) throw new Error(`source: asked for block ${n}, got ${info.number}`);
    blocks.set(n, info);
    return info;
  }

  /** Refuse unless the endpoint answers for the chain the config says it is. */
  async function assertChainId() {
    const c = await getClient();
    const got = Number(await c.getChainId());
    if (got !== chainId) throw new Error(`source: endpoint answers for chain ${got}, config says ${chainId}`);
  }

  /** The newest block that is `confirmations` behind the head. */
  async function confirmedHead() {
    const c = await getClient();
    const latest = Number(await c.getBlockNumber());
    return blockInfo(Math.max(0, latest - confirmations));
  }

  /**
   * Largest block whose timestamp is strictly before `ts`, searching [0, hi]. Throws if even block 0
   * is not before `ts`. Returns `hi` when `hi` itself is before `ts`.
   * @param {number} ts
   * @param {number} hi
   */
  async function lastBlockBefore(ts, hi) {
    if ((await blockInfo(hi)).timestamp < ts) return blockInfo(hi);
    let lo = 0;
    if ((await blockInfo(0)).timestamp >= ts) throw new Error(`source: no block before ${ts}`);
    let top = hi; // invariant: ts(lo) < ts <= ts(top)
    while (top - lo > 1) {
      const mid = Math.floor((lo + top) / 2);
      if ((await blockInfo(mid)).timestamp < ts) lo = mid; else top = mid;
    }
    return blockInfo(lo);
  }

  /**
   * Every DepositActivated / ExitSettled log of the given vaults in [fromBlock, toBlock], paged in
   * windows, deduplicated by (block, log index), timestamped.
   * @param {Array<{address:string, fromBlock:number}>} vaults
   * @param {number} toBlock
   * @returns {Promise<import('./ledger.mjs').LedgerEvent[]>}
   */
  async function vaultEvents(vaults, toBlock) {
    const c = await getClient();
    /** @type {Map<string, any>} */
    const seen = new Map();
    for (const v of vaults) {
      if (!ADDRESS_RE.test(v.address)) throw new Error(`source: bad vault address ${v.address}`);
      const vault = lc(v.address);
      for (let from = v.fromBlock; from <= toBlock; from += windowBlocks) {
        const to = Math.min(from + windowBlocks - 1, toBlock);
        const logs = await retrying(() => c.getLogs({ address: vault, events: VAULT_EVENTS, fromBlock: BigInt(from), toBlock: BigInt(to) }));
        for (const l of logs) {
          if (lc(l.address) !== vault) throw new Error(`source: log from ${l.address} returned for ${vault}`);
          const bn = Number(l.blockNumber);
          if (bn < from || bn > to) throw new Error(`source: log at block ${bn} outside window [${from}, ${to}]`);
          seen.set(`${bn}:${Number(l.logIndex)}`, { vault, l });
        }
      }
    }
    const entries = [...seen.values()];
    const distinct = [...new Set(entries.map((e) => Number(e.l.blockNumber)))];
    await mapLimit(distinct, 8, blockInfo);
    const events = entries.map(({ vault, l }) => {
      const a = l.args;
      const base = { vault, member: lc(a.member), blockNumber: Number(l.blockNumber), logIndex: Number(l.logIndex), timestamp: /** @type {any} */ (blocks.get(Number(l.blockNumber))).timestamp };
      if (l.eventName === 'DepositActivated') return { ...base, type: /** @type {const} */ ('deposit'), amountUsdc: BigInt(a.amountUsdc), sharesAfter: BigInt(a.sharesAfter) };
      if (l.eventName === 'ExitSettled') return { ...base, type: /** @type {const} */ ('exit'), sharesBurned: BigInt(a.sharesBurned) };
      throw new Error(`source: unexpected event ${l.eventName}`);
    });
    return events.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  }

  /** @returns {Promise<{shares:bigint, basis:bigint}>} */
  async function readPosition(vault, member, blockNumber) {
    const c = await getClient();
    const args = { address: vault, abi: VAULT_READ_ABI, blockNumber: BigInt(blockNumber) };
    const [shares, basis] = await Promise.all([
      c.readContract({ ...args, functionName: 'sharesOf', args: [member] }),
      c.readContract({ ...args, functionName: 'costBasisUsdc', args: [member] }),
    ]);
    return { shares: BigInt(shares), basis: BigInt(basis) };
  }

  /** @returns {Promise<string>} */
  async function creatorOf(vault) {
    const c = await getClient();
    return lc(String(await c.readContract({ address: vault, abi: VAULT_READ_ABI, functionName: 'creator' })));
  }

  /** keccak256 of the deployed code; an externally owned address hashes the empty code. */
  async function codeHash(address) {
    const c = await getClient();
    const code = await c.getCode({ address });
    return keccak256(code ?? '0x');
  }

  return { chainId, assertChainId, confirmedHead, blockInfo, lastBlockBefore, vaultEvents, readPosition, creatorOf, codeHash };
}
