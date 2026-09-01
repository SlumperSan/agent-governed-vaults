// @ts-check
/**
 * Production chain source: reads real logs from a Base RPC via viem and yields the NORMALIZED
 * events daemon.mjs folds. viem is a lazy, OPTIONAL dependency — imported only when no `client`
 * is injected — so this module (and anything importing it) stays loadable in a zero-dependency
 * test environment. Tests inject a fake `client`; production passes an `rpcUrl`.
 *
 * Dynamic vault discovery: the factory / operator-registry / sub-vault-registry / governance
 * addresses are singletons (fixed), but each vault (VaultCore) is deployed by the factory, so its
 * address is not known up front. We poll the singletons, learn new vault addresses from
 * VaultCreated logs, and poll VaultCore events across the accumulated vault set. On restart the
 * runner seeds the known-vault set from the resumed snapshot (see index-runner.mjs).
 */

import { CONTRACT_ABIS, SINGLETON_LABELS } from './abis.mjs';
import { normalizeLog, sortEvents } from './chain.mjs';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a);

/**
 * Ceiling on the DISCOVERED execution-adapter set (see the trust-boundary note on `fetchEvents`).
 * Every member is an address in every `getLogs` call and is persisted in the snapshot forever, and
 * membership is attacker-influenceable, so the set needs a bound. Honest deployments share one
 * adapter; 64 is far above any real count and far below a set that would degrade polling.
 */
export const MAX_TRACKED_ADAPTERS = 64;

/**
 * @param {Object} cfg
 * @param {any} [cfg.client]            an injected viem-style client (tests); built from rpcUrl if omitted
 * @param {string} [cfg.rpcUrl]         HTTP RPC endpoint (required when no client is injected)
 * @param {number} [cfg.chainId]        chain id for the viem client (e.g. 8453 Base, 84532 Base Sepolia)
 * @param {string} [cfg.chainName]
 * @param {{factory?:string, operatorRegistry?:string, subvaultRegistry?:string, governance?:string, feeEngine?:string}} cfg.addresses
 * @param {Iterable<string>} [cfg.knownVaults]    vault addresses already known (seed from resumed state)
 * @param {Iterable<string>} [cfg.knownAdapters]  execution-adapter addresses already known (seed from resumed state)
 * @param {(adapter:string) => void} [cfg.onAdapterCap]  called when MAX_TRACKED_ADAPTERS is hit and
 *   a newly seen adapter is therefore NOT polled (the runner turns this into a warn line)
 */
export function createChainSource({
  client, rpcUrl, chainId = 8453, chainName = 'base', addresses,
  knownVaults = [], knownAdapters = [], onAdapterCap = () => {},
}) {
  const addr = {};
  for (const label of SINGLETON_LABELS) if (addresses?.[label]) addr[label] = lc(addresses[label]);
  const vaults = new Set([...knownVaults].filter((v) => ADDRESS_RE.test(v)).map(lc));
  // Seeded from the snapshot, which was itself written under the cap — sliced anyway so a
  // hand-edited or pre-cap snapshot cannot reintroduce an unbounded set.
  const adapters = new Set([...knownAdapters].filter((a) => ADDRESS_RE.test(a)).map(lc).slice(0, MAX_TRACKED_ADAPTERS));

  let _client = client ?? null;
  async function getClient() {
    if (_client) return _client;
    if (!rpcUrl) throw new Error('rpc: no client injected and no rpcUrl provided');
    const { createPublicClient, http } = await import('viem').catch(() => {
      throw new Error('rpc: viem is not installed — run `npm install viem` (it is an optional runtime dependency)');
    });
    const chain = {
      id: chainId,
      name: chainName,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    };
    _client = createPublicClient({ chain, transport: http(rpcUrl) });
    return _client;
  }

  /** Current chain head (block number as a Number). */
  async function headBlock() {
    const c = await getClient();
    return Number(await c.getBlockNumber());
  }

  /**
   * Read + decode logs from one address (or address array) for one contract group's events.
   * `attributed` is forwarded to `normalizeLog`: false for groups whose code is not ours, so a
   * `vault` ARGUMENT from an untrusted emitter never becomes a projection key (see the adapter
   * group below and the note in chain.mjs).
   */
  async function logsFor(c, address, events, from, to, { attributed = true } = {}) {
    if (Array.isArray(address) ? address.length === 0 : !address) return [];
    const raw = await c.getLogs({ address, events, fromBlock: BigInt(from), toBlock: BigInt(to) });
    return raw.filter((l) => l && l.eventName).map((l) => normalizeLog(l, undefined, { attributed }));
  }

  /**
   * NORMALIZED events for [from, to], globally sorted by (blockNumber, logIndex). Discovers new
   * vaults from VaultCreated in this same range before polling VaultCore events, so a vault
   * created and used within one batch is captured. Adapters are discovered one hop further in:
   * from each VaultCore's own RebalanceExecuted(adapter, orderCount), so an adapter used for the
   * first time in this same range still has its SwapExecuted fills picked up in this batch.
   *
   * Adapter discovery is the one hop that crosses a TRUST BOUNDARY, and it is bounded on both
   * sides. `createVault` is permissionless and takes a caller-supplied `allowedAdapters`, so an
   * attacker can stand up their own vault, allowlist their own contract, pass a rebalance through
   * their own governance (`executeRebalance` accepts an empty order array) and get that contract
   * into this set. Nothing here can tell that vault apart from an honest one — the factory
   * deployed both — so an `isAllowedAdapter` read would not help: `executeRebalance` already
   * requires it on-chain (VaultCore.sol:838), so it returns true for every genuine
   * `RebalanceExecuted` by construction. The two defences that do bite:
   *   1. attribution — adapter logs are normalized with `attributed:false`, so a hostile
   *      `SwapExecuted(vault: <victim>)` can never be folded against the victim's record; and
   *   2. this cap — the set is an argument to every `getLogs` call and is persisted forever, so
   *      an unbounded one is a griefing vector against the indexer itself. Honest deployments
   *      share a single AggregationRouterAdapter (see contracts/config/deployments), so the
   *      realistic count is one or two and the cap is never approached in practice.
   * @returns {Promise<import('./projections.mjs').Event[]>}
   */
  async function fetchEvents(from, to) {
    const c = await getClient();
    const out = [];

    for (const label of SINGLETON_LABELS) {
      if (!addr[label]) continue;
      const evts = await logsFor(c, addr[label], CONTRACT_ABIS[label], from, to);
      for (const e of evts) {
        if (e.name === 'VaultCreated' && ADDRESS_RE.test(e.vault)) vaults.add(e.vault);
        out.push(e);
      }
    }

    if (vaults.size > 0) {
      const vaultEvts = await logsFor(c, [...vaults], CONTRACT_ABIS.vault, from, to);
      for (const e of vaultEvts) {
        if (e.name !== 'RebalanceExecuted' || !ADDRESS_RE.test(e.args?.adapter)) continue;
        const adapter = lc(e.args.adapter);
        if (adapters.has(adapter)) continue;
        if (adapters.size >= MAX_TRACKED_ADAPTERS) {
          onAdapterCap(adapter);
          continue;
        }
        adapters.add(adapter);
      }
      out.push(...vaultEvts);
    }

    if (adapters.size > 0) {
      // attributed:false — adapter code is arbitrary (see the trust-boundary note above).
      const adapterEvts = await logsFor(c, [...adapters], CONTRACT_ABIS.adapter, from, to, { attributed: false });
      out.push(...adapterEvts);
    }

    return sortEvents(out);
  }

  return {
    headBlock,
    fetchEvents,
    /** The live known-vault set (grows as VaultCreated logs are seen). */
    get knownVaults() { return new Set(vaults); },
    /** The live known-adapter set (grows as RebalanceExecuted logs are seen). */
    get knownAdapters() { return new Set(adapters); },
  };
}
