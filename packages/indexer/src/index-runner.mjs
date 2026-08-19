// @ts-check
/**
 * Runnable indexer entrypoint. Env-driven: point it at a Base RPC and the deployed singleton
 * addresses, and it resumes from the snapshot, polls new logs via the viem chain source, folds
 * them, and snapshots — forever. Non-custodial and read-only: it never signs or sends anything.
 *
 * Required env:
 *   RPC_URL                    Base (or Base Sepolia) HTTP RPC endpoint
 *   FACTORY_ADDRESS            VaultFactory
 *   OPERATOR_REGISTRY_ADDRESS  OperatorRegistry
 *   SUBVAULT_REGISTRY_ADDRESS  SubVaultRegistry
 *   GOVERNANCE_ADDRESS         Governance
 * Optional env:
 *   CHAIN_ID (8453)  CHAIN_NAME (base)  START_BLOCK (0)  STATE_PATH (./data/indexer-state.json)
 *   CONFIRMATIONS (5)  BATCH_BLOCKS (2000)  POLL_INTERVAL_MS (12000)
 *
 * Run: `RPC_URL=… FACTORY_ADDRESS=… … node packages/indexer/src/index-runner.mjs`
 */

import { fileURLToPath } from 'node:url';
import { createChainSource } from './rpc.mjs';
import { createIndexerDaemon } from './daemon.mjs';
import { loadSnapshot, resumeCursor } from './store.mjs';

/**
 * Parse + validate the indexer config from a raw env object. Pure and testable (no I/O).
 * Throws with a precise message listing every missing required var.
 * @param {Record<string,string|undefined>} env
 */
export function resolveIndexerConfig(env) {
  const required = ['RPC_URL', 'FACTORY_ADDRESS', 'OPERATOR_REGISTRY_ADDRESS', 'SUBVAULT_REGISTRY_ADDRESS', 'GOVERNANCE_ADDRESS'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`indexer: missing required env: ${missing.join(', ')}`);

  const num = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
  const addresses = {
    factory: env.FACTORY_ADDRESS,
    operatorRegistry: env.OPERATOR_REGISTRY_ADDRESS,
    subvaultRegistry: env.SUBVAULT_REGISTRY_ADDRESS,
    governance: env.GOVERNANCE_ADDRESS,
  };
  for (const [label, a] of Object.entries(addresses)) {
    if (!isAddr(a)) throw new Error(`indexer: ${label} is not a 20-byte address: ${a}`);
  }
  return {
    rpcUrl: env.RPC_URL,
    chainId: num('CHAIN_ID', 8453),
    chainName: env.CHAIN_NAME || 'base',
    addresses,
    startBlock: num('START_BLOCK', 0),
    statePath: env.STATE_PATH || './data/indexer-state.json',
    confirmations: num('CONFIRMATIONS', 5),
    batchBlocks: num('BATCH_BLOCKS', 2000),
    pollIntervalMs: num('POLL_INTERVAL_MS', 12_000),
  };
}

/**
 * Build a wired (but not yet started) indexer from a resolved config. Seeds the chain source's
 * known-vault set from the resumed snapshot so VaultCore events keep indexing across restarts.
 * Returns the daemon plus a `start()` that polls forever.
 */
export async function buildIndexer(cfg, { log = console.log, client } = {}) {
  // Load once to discover already-known vaults, so VaultCore events keep indexing across restarts.
  const resumed = await loadSnapshot(cfg.statePath);
  const knownVaults = [...resumed.vaults.keys()];

  const source = createChainSource({
    client, // tests inject a fake viem client; production builds one from rpcUrl
    rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, chainName: cfg.chainName,
    addresses: cfg.addresses, knownVaults,
  });

  const daemon = createIndexerDaemon({
    statePath: cfg.statePath,
    fetchEvents: source.fetchEvents,
    headBlock: source.headBlock,
    confirmations: cfg.confirmations,
    batchBlocks: cfg.batchBlocks,
    log,
  });
  await daemon.init(); // loads the same snapshot into the daemon's own state

  // Fresh state (no snapshot) honors START_BLOCK; a resumed state keeps its own cursor.
  const st = daemon.getState();
  const fresh = st.lastBlock === 0 && st.lastLogIndex === -1;
  if (fresh && cfg.startBlock > 0) {
    st.lastBlock = cfg.startBlock - 1; // resumeCursor → startBlock
    // Vaults are discovered from VaultCreated within polled ranges; any vault created BEFORE
    // START_BLOCK will never be discovered (its VaultCore events go unindexed). Set START_BLOCK
    // to the deploy block, not later. Warn so this is never silent.
    log(`⚠ indexer: START_BLOCK=${cfg.startBlock} on a fresh snapshot — vaults created before block ${cfg.startBlock} will NOT be discovered. Use the factory deploy block.`);
  }

  async function start({ signal } = {}) {
    log(`indexer up: chain ${cfg.chainId}, ${knownVaults.length} known vaults, resume block ${resumeCursor(daemon.getState()).fromBlock}`);
    for (;;) {
      if (signal?.aborted) return;
      try {
        await daemon.catchUp();
      } catch (err) {
        log(`indexer poll error (will retry): ${err?.message ?? err}`);
      }
      await sleep(cfg.pollIntervalMs, signal);
    }
  }

  return { daemon, source, start };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(undefined); }, { once: true });
  });
}

// ── entrypoint ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cfg = resolveIndexerConfig(process.env);
  buildIndexer(cfg).then(({ start }) => start()).catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
