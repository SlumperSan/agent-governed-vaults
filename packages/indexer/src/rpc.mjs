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
import { MAX_TRACKED_ADAPTERS } from './projections.mjs';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a);

/**
 * Ceiling on the DISCOVERED execution-adapter set. Defined in projections.mjs (the pure core)
 * because the SAME bound has to hold on `state.adapters`, which is the set that is persisted; a
 * ceiling here alone would bound the poll while the snapshot grew without limit.
 *
 * Adapters named in config (`ADAPTER_ADDRESSES`) are NOT subject to it — see `configuredAdapters`.
 */
export { MAX_TRACKED_ADAPTERS };

/**
 * @param {Object} cfg
 * @param {any} [cfg.client]            an injected viem-style client (tests); built from rpcUrl if omitted
 * @param {string} [cfg.rpcUrl]         HTTP RPC endpoint (required when no client is injected)
 * @param {number} [cfg.chainId]        chain id for the viem client (e.g. 8453 Base, 84532 Base Sepolia)
 * @param {string} [cfg.chainName]
 * @param {{factory?:string, operatorRegistry?:string, subvaultRegistry?:string, governance?:string, feeEngine?:string}} cfg.addresses
 * @param {Iterable<string>} [cfg.knownVaults]    vault addresses already known (seed from resumed state)
 * @param {Iterable<string>} [cfg.knownAdapters]  execution-adapter addresses already known (seed from resumed state)
 * @param {Iterable<string>} [cfg.configuredAdapters]  adapters named in config (ADAPTER_ADDRESSES).
 *   Polled unconditionally, exempt from MAX_TRACKED_ADAPTERS, never displaced by discovery.
 * @param {(info:{dropped:string[], cap:number, tracked:number, phase:'resume'|'discovery'}) => void} [cfg.onAdapterCap]
 *   called at most ONCE per resume and once per fetched batch, with every adapter that batch
 *   declined to poll (the runner turns it into one warn line, not one per adapter)
 */
export function createChainSource({
  client, rpcUrl, chainId = 8453, chainName = 'base', addresses,
  knownVaults = [], knownAdapters = [], configuredAdapters = [], onAdapterCap = () => {},
}) {
  const addr = {};
  for (const label of SINGLETON_LABELS) if (addresses?.[label]) addr[label] = lc(addresses[label]);
  const vaults = new Set([...knownVaults].filter((v) => ADDRESS_RE.test(v)).map(lc));

  // Two sets, deliberately. `configured` is trust established off-chain by the operator, so it is
  // exempt from the ceiling and can never be crowded out by anything an attacker emits. `discovered`
  // is trust-free convenience, learned from chain logs, and is what the ceiling bounds.
  const configured = new Set([...configuredAdapters].filter((a) => ADDRESS_RE.test(a)).map(lc));
  const discovered = new Set();
  // Seeded from the snapshot. Sliced so a hand-edited or pre-cap snapshot cannot reintroduce an
  // unbounded set — but REPORTED when it drops anything, because silently discarding adapters an
  // earlier run was indexing is the same defect as silently declining to discover them.
  {
    const seed = [...knownAdapters].filter((a) => ADDRESS_RE.test(a)).map(lc).filter((a) => !configured.has(a));
    for (const a of seed.slice(0, MAX_TRACKED_ADAPTERS)) discovered.add(a);
    const dropped = seed.slice(MAX_TRACKED_ADAPTERS);
    if (dropped.length) {
      onAdapterCap({ dropped, cap: MAX_TRACKED_ADAPTERS, tracked: configured.size + discovered.size, phase: 'resume' });
    }
  }
  /** Every adapter actually polled: config first, so its membership is never in question. */
  const pollSet = () => [...configured, ...discovered];

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
   * Adapter discovery is the one hop that crosses a TRUST BOUNDARY. `createVault` is permissionless
   * and takes a caller-supplied `allowedAdapters`, so an attacker can stand up their own vault,
   * allowlist their own contract, pass a rebalance through their own governance
   * (`executeRebalance` accepts an empty order array) and get that contract discovered. Nothing
   * here can tell that vault apart from an honest one — the factory deployed both — so an
   * `isAllowedAdapter` read would not help: `executeRebalance` already requires it on-chain
   * (VaultCore.executeRebalance), so it returns true for every genuine `RebalanceExecuted` by
   * construction. Three defences, in order of how much they buy:
   *   1. CONFIG. `ADAPTER_ADDRESSES` names the adapters this deployment actually uses, exactly as
   *      the singleton addresses are named. It never consults the chain for trust, so no
   *      permissionless on-chain action can add to it, remove from it, or push an entry out of it.
   *      This is the only mechanism here that establishes trust rather than merely limiting damage.
   *   2. ATTRIBUTION. Adapter logs are normalized with `attributed:false`, so a hostile
   *      `SwapExecuted(vault: <victim>)` can never be folded against the victim's record.
   *   3. A CEILING on DISCOVERED adapters only. The polled set is the `address` array of every
   *      `getLogs` call, so an unbounded one degrades and eventually fails the poll — i.e. it stops
   *      the indexer indexing anything, which is worse than not indexing one adapter.
   *
   * The ceiling is deliberately NOT applied to `configured`, and that is the whole answer to
   * "a bound added for a hostile case must not break the honest case": adapters are per-vault and
   * caller-supplied (VaultCore's constructor takes `allowedAdapters`; docs/DEPLOYMENT.md
   * "Execution adapters (per-vault)"), so the distinct count scales with CREATORS, not with the
   * protocol, and an honest deployment can exceed any fixed number. An operator who needs a
   * specific adapter indexed names it and is immune; discovery beyond the ceiling is declined
   * out loud (`onAdapterCap`), never silently, on both the discovery and the resume path.
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
      /** Collected, not reported one at a time: one hostile batch produced 436 warn lines. */
      const dropped = [];
      for (const e of vaultEvts) {
        if (e.name !== 'RebalanceExecuted' || !ADDRESS_RE.test(e.args?.adapter)) continue;
        const adapter = lc(e.args.adapter);
        if (configured.has(adapter) || discovered.has(adapter)) continue;
        if (discovered.size >= MAX_TRACKED_ADAPTERS) {
          dropped.push(adapter);
          continue;
        }
        discovered.add(adapter);
      }
      if (dropped.length) {
        onAdapterCap({
          dropped, cap: MAX_TRACKED_ADAPTERS, tracked: configured.size + discovered.size, phase: 'discovery',
        });
      }
      out.push(...vaultEvts);
    }

    const poll = pollSet();
    if (poll.length > 0) {
      // attributed:false — adapter code is arbitrary (see the trust-boundary note above). This
      // holds for CONFIGURED adapters too: config says which address to poll, not that the
      // `vault` argument inside its logs is true.
      const adapterEvts = await logsFor(c, poll, CONTRACT_ABIS.adapter, from, to, { attributed: false });
      out.push(...adapterEvts);
    }

    return sortEvents(out);
  }

  return {
    headBlock,
    fetchEvents,
    /** The live known-vault set (grows as VaultCreated logs are seen). */
    get knownVaults() { return new Set(vaults); },
    /** Every adapter polled: the configured ones plus the discovered ones. */
    get knownAdapters() { return new Set(pollSet()); },
    /** The config-named adapters alone — exempt from the ceiling. */
    get configuredAdapters() { return new Set(configured); },
    /** The chain-learned adapters alone — this is the set MAX_TRACKED_ADAPTERS bounds. */
    get discoveredAdapters() { return new Set(discovered); },
  };
}
