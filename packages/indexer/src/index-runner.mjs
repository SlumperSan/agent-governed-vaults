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
 *   FEE_ENGINE_ADDRESS  FeeEngine — enables FeeAssessed/FeeCredited/FeesClaimed indexing when set;
 *                        omitted deployments simply skip that singleton group (SINGLETON_LABELS
 *                        loop in rpc.mjs already treats every label as optional).
 *   CHAIN_ID (8453)  CHAIN_NAME (base)  START_BLOCK (0)  STATE_PATH (./data/indexer-state.json)
 *   CONFIRMATIONS (5)  BATCH_BLOCKS (2000)  POLL_INTERVAL_MS (12000)
 *   SNAPSHOT_BACKUPS (3)  SNAPSHOT_BACKUP_INTERVAL_MS (300000)
 *   HEARTBEAT_DIR (dirname of STATE_PATH)  LOG_FORMAT (json|pretty)  LOG_LEVEL (info)
 *
 * Run:    `RPC_URL=… FACTORY_ADDRESS=… … node packages/indexer/src/index-runner.mjs`
 * Verify: `node packages/indexer/src/index-runner.mjs verify [path]`
 *         Reads a snapshot and reports its cursor, counts and backups. Needs NO env at all and
 *         starts no poller — see the entrypoint at the bottom.
 */

import { fileURLToPath } from 'node:url';
import { createChainSource } from './rpc.mjs';
import { createIndexerDaemon } from './daemon.mjs';
import { loadSnapshot, resumeCursor, createSnapshotWriter, verifySnapshot, formatSnapshotReport } from './store.mjs';
import { loggerFromEnv } from '../../oplog/src/logger.mjs';
import { createHeartbeat, defaultHeartbeatDir } from '../../oplog/src/heartbeat.mjs';
import { createShutdown } from '../../oplog/src/shutdown.mjs';
import { resolveDurabilityOptions } from '../../oplog/src/durable.mjs';

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
  // Optional: unset means "don't index FeeEngine events yet", not a config error.
  if (env.FEE_ENGINE_ADDRESS) {
    if (!isAddr(env.FEE_ENGINE_ADDRESS)) throw new Error(`indexer: feeEngine is not a 20-byte address: ${env.FEE_ENGINE_ADDRESS}`);
    addresses.feeEngine = env.FEE_ENGINE_ADDRESS;
  }
  const statePath = env.STATE_PATH || './data/indexer-state.json';
  const pollIntervalMs = num('POLL_INTERVAL_MS', 12_000);
  return {
    rpcUrl: env.RPC_URL,
    chainId: num('CHAIN_ID', 8453),
    chainName: env.CHAIN_NAME || 'base',
    addresses,
    startBlock: num('START_BLOCK', 0),
    statePath,
    confirmations: num('CONFIRMATIONS', 5),
    batchBlocks: num('BATCH_BLOCKS', 2000),
    pollIntervalMs,
    ...resolveDurabilityOptions(env),
    heartbeatDir: defaultHeartbeatDir({ ...env, STATE_PATH: statePath }),
    // Three missed polls, floored at 30s so a fast poll interval does not produce a hair-trigger
    // that pages on one slow RPC round-trip.
    heartbeatStaleMs: Math.max(30_000, pollIntervalMs * 3),
  };
}

/**
 * Build a wired (but not yet started) indexer from a resolved config. Seeds the chain source's
 * known-vault set from the resumed snapshot so VaultCore events keep indexing across restarts.
 * Returns the daemon plus a `start()` that polls forever and a `stop()` that ends it cleanly.
 */
export async function buildIndexer(cfg, { log, logger = loggerFromEnv('indexer'), client } = {}) {
  const line = log ?? logger.text('indexer.progress');

  // Load once to discover already-known vaults (and adapters), so VaultCore / adapter events keep
  // indexing across restarts without re-seeing their discovery event.
  const resumed = await loadSnapshot(cfg.statePath);
  const knownVaults = [...resumed.vaults.keys()];
  const knownAdapters = [...resumed.adapters];

  const source = createChainSource({
    client, // tests inject a fake viem client; production builds one from rpcUrl
    rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, chainName: cfg.chainName,
    addresses: cfg.addresses, knownVaults, knownAdapters,
  });

  const writer = createSnapshotWriter({
    path: cfg.statePath, backups: cfg.backups ?? 0, backupIntervalMs: cfg.backupIntervalMs ?? 0,
  });

  const daemon = createIndexerDaemon({
    statePath: cfg.statePath,
    fetchEvents: source.fetchEvents,
    headBlock: source.headBlock,
    confirmations: cfg.confirmations,
    batchBlocks: cfg.batchBlocks,
    log: line,
    save: (st) => writer.save(st),
  });
  await daemon.init(); // loads the same snapshot into the daemon's own state

  const heartbeat = createHeartbeat({
    dir: cfg.heartbeatDir ?? './data', service: 'indexer',
    staleAfterMs: cfg.heartbeatStaleMs ?? 60_000,
    // A cold-start catch-up ticks far faster than the poll interval; one heartbeat per second of
    // wall clock is plenty to prove liveness and keeps the write off the hot path.
    minIntervalMs: 1000,
    onError: (err) => logger.warn?.('heartbeat.failed', { error: String(err?.message ?? err) }),
  });

  // Fresh state (no snapshot) honors START_BLOCK; a resumed state keeps its own cursor.
  const st = daemon.getState();
  const fresh = st.lastBlock === 0 && st.lastLogIndex === -1;
  if (fresh && cfg.startBlock > 0) {
    st.lastBlock = cfg.startBlock - 1; // resumeCursor → startBlock
    // Vaults are discovered from VaultCreated within polled ranges; any vault created BEFORE
    // START_BLOCK will never be discovered (its VaultCore events go unindexed). Set START_BLOCK
    // to the deploy block, not later. Warn so this is never silent.
    line(`⚠ indexer: START_BLOCK=${cfg.startBlock} on a fresh snapshot — vaults created before block ${cfg.startBlock} will NOT be discovered. Use the factory deploy block.`);
  }

  const ac = new AbortController();
  /** @type {Promise<void>|null} */
  let running = null;

  async function loop(signal) {
    for (;;) {
      if (signal.aborted) return;
      try {
        await daemon.catchUp({ signal });
      } catch (err) {
        logger.warn?.('poll.failed', { error: String(err?.message ?? err), lastBlock: daemon.getState().lastBlock });
        line(`indexer poll error (will retry): ${err?.message ?? err}`);
      }
      const s = daemon.getState();
      await heartbeat.beat({ lastBlock: s.lastBlock, vaults: s.vaults.size });
      await sleep(cfg.pollIntervalMs, signal);
    }
  }

  async function start({ signal } = {}) {
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    logger.info?.('starting', {
      chainId: cfg.chainId, knownVaults: knownVaults.length,
      resumeBlock: resumeCursor(daemon.getState()).fromBlock, statePath: cfg.statePath,
      pollIntervalMs: cfg.pollIntervalMs, backups: cfg.backups ?? 0,
    });
    await heartbeat.beat({ lastBlock: daemon.getState().lastBlock, vaults: daemon.getState().vaults.size }, { force: true });
    running = loop(ac.signal);
    return running;
  }

  /**
   * Stop cleanly: abort so the batch loop exits at the next batch boundary, wait for it, then take
   * one final snapshot. The final write is belt-and-braces — `tick()` already persisted the batch
   * it finished — but it costs one atomic write and removes any doubt about what is on disk.
   */
  async function stop() {
    ac.abort();
    if (running) await running.catch(() => {});
    await writer.save(daemon.getState());
    const s = daemon.getState();
    logger.info?.('stopped', { lastBlock: s.lastBlock, vaults: s.vaults.size, statePath: cfg.statePath });
    return s.lastBlock;
  }

  return { daemon, source, start, stop, heartbeat, writer, logger };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(finish, ms);
    function finish() {
      clearTimeout(t);
      // Removing the listener matters: this sleeps once per poll against a signal that lives for
      // the whole process, so leaving them attached would leak one listener per poll forever.
      signal?.removeEventListener?.('abort', finish);
      resolve(undefined);
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

// ── entrypoint ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  // `verify` runs BEFORE config resolution on purpose. Whoever is verifying a snapshot after a
  // crash has an RPC URL and four contract addresses set exactly never; demanding them would make
  // the tool useless at the only moment it is needed.
  if (argv[0] === 'verify') {
    const path = argv[1] || process.env.STATE_PATH || './data/indexer-state.json';
    const report = await verifySnapshot(path);
    (report.ok ? console.log : console.error)(formatSnapshotReport(report));
    process.exit(report.ok ? 0 : 1);
  } else {
    const logger = loggerFromEnv('indexer');
    try {
      const cfg = resolveIndexerConfig(process.env);
      const { start, stop } = await buildIndexer(cfg, { logger });
      createShutdown({ log: logger })
        .onShutdown('indexer.finish-batch-and-snapshot', stop)
        .install();
      await start();
    } catch (err) {
      logger.error('startup.failed', { error: String(err?.message ?? err) });
      process.exit(1);
    }
  }
}
