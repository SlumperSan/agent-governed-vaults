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
 * @param {Object} cfg
 * @param {any} [cfg.client]            an injected viem-style client (tests); built from rpcUrl if omitted
 * @param {string} [cfg.rpcUrl]         HTTP RPC endpoint (required when no client is injected)
 * @param {number} [cfg.chainId]        chain id for the viem client (e.g. 8453 Base, 84532 Base Sepolia)
 * @param {string} [cfg.chainName]
 * @param {{factory?:string, operatorRegistry?:string, subvaultRegistry?:string, governance?:string, feeEngine?:string}} cfg.addresses
 * @param {Iterable<string>} [cfg.knownVaults]    vault addresses already known (seed from resumed state)
 * @param {Iterable<string>} [cfg.knownAdapters]  execution-adapter addresses already known (seed from resumed state)
 */
export function createChainSource({ client, rpcUrl, chainId = 8453, chainName = 'base', addresses, knownVaults = [], knownAdapters = [] }) {
  const addr = {};
  for (const label of SINGLETON_LABELS) if (addresses?.[label]) addr[label] = lc(addresses[label]);
  const vaults = new Set([...knownVaults].filter((v) => ADDRESS_RE.test(v)).map(lc));
  const adapters = new Set([...knownAdapters].filter((a) => ADDRESS_RE.test(a)).map(lc));

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

  /** Read + decode logs from one address (or address array) for one contract group's events. */
  async function logsFor(c, address, events, from, to) {
    if (Array.isArray(address) ? address.length === 0 : !address) return [];
    const raw = await c.getLogs({ address, events, fromBlock: BigInt(from), toBlock: BigInt(to) });
    return raw.filter((l) => l && l.eventName).map((l) => normalizeLog(l));
  }

  /**
   * NORMALIZED events for [from, to], globally sorted by (blockNumber, logIndex). Discovers new
   * vaults from VaultCreated in this same range before polling VaultCore events, so a vault
   * created and used within one batch is captured. Adapters are discovered one hop further in:
   * from each VaultCore's own RebalanceExecuted(adapter, orderCount), so an adapter used for the
   * first time in this same range still has its SwapExecuted fills picked up in this batch.
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
        if (e.name === 'RebalanceExecuted' && ADDRESS_RE.test(e.args?.adapter)) adapters.add(lc(e.args.adapter));
      }
      out.push(...vaultEvts);
    }

    if (adapters.size > 0) {
      const adapterEvts = await logsFor(c, [...adapters], CONTRACT_ABIS.adapter, from, to);
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
