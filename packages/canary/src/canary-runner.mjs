// @ts-check
/**
 * Runnable canary entrypoint. Point it at a deployed testnet and it stays SILENT until something
 * is genuinely wrong: one line per signal TRANSITION (OK→ALERT, ALERT→OK, OK→DEGRADED), nothing
 * at all while every signal is healthy.
 *
 * STRICTLY READ-ONLY. It builds a viem *public* client (see reader.mjs) and issues only
 * eth_blockNumber / eth_getBlockByNumber / eth_call / eth_getLogs. It never sends a transaction,
 * never signs anything, and holds no key — there is no wallet client, no account, and no
 * PRIVATE_KEY read anywhere in packages/canary. It also never writes to the indexer's snapshot;
 * that file is opened read-only, and the canary's own transition state lives at its own path.
 *
 * Required env:
 *   RPC_URL                    Base (or Base Sepolia) HTTP RPC endpoint
 * Vault discovery (one of):
 *   STATE_PATH                 the indexer snapshot to read the vault set from
 *                              (default ./data/indexer-state.json)
 *   VAULTS                     comma-separated vault addresses, to run without an indexer.
 *                              NOTE: signals (c) and (d) need the indexer's projection — with
 *                              VAULTS only, they report DEGRADED rather than a false OK.
 * Optional env:
 *   OPERATOR_REGISTRY_ADDRESS  enables the fee-routing signal (skipped without it)
 *   EXTRA_OPERATOR_ADDRESSES   comma-separated extra operator addresses to treat as prohibited
 *   ALERT_WEBHOOK_URL          POST one JSON body per transition
 *   CANARY_STATE_PATH (./data/canary-state.json)  transition state, so a restart does not re-page
 *   CHAIN_ID (8453)  CHAIN_NAME (base)  CONFIRMATIONS (5)
 *   CANARY_POLL_INTERVAL_MS (30000)  sweep cadence. Named apart from the indexer's
 *                              POLL_INTERVAL_MS because docker-compose feeds both services one
 *                              .env file, and a canary sweep is far heavier than an indexer poll.
 *   NAV_DIVERGENCE_BPS (50)    composition-divergence bar, 50 = 0.5%
 *   ORACLE_MIN_MARGIN (0)      alert when fresh-sources minus quorum <= this
 *   LOG_LOOKBACK_BLOCKS (0)    on a cold start, how far back to scan for events
 *   MAX_LOG_SPAN_BLOCKS (2000) cap on one poll's getLogs range
 *   HEARTBEAT_MS (0)           if set, periodically print a one-line "still watching" summary
 *
 * Run: `RPC_URL=… STATE_PATH=… node packages/canary/src/canary-runner.mjs`
 */

import { fileURLToPath } from 'node:url';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadSnapshot } from '../../indexer/src/store.mjs';
import { createChainReader } from './reader.mjs';
import { createTransitionTracker } from './transitions.mjs';
import { createConsoleSink, createWebhookSink, emitAll } from './sinks.mjs';
import { VAULT_VIEWS } from './abis.mjs';
import { skipped, shortAddr } from './signal.mjs';
import { checkOracleFreshness } from './signals/oracle-freshness.mjs';
import { checkNavBacking } from './signals/nav-backing.mjs';
import { checkShareConservation } from './signals/share-conservation.mjs';
import { checkExitLiveness } from './signals/exit-liveness.mjs';
import { checkModuleEvents } from './signals/module-events.mjs';
import { checkFeeRouting } from './signals/fee-routing.mjs';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a);
const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Parse + validate the canary config from a raw env object. Pure and testable (no I/O).
 * @param {Record<string,string|undefined>} env
 */
export function resolveCanaryConfig(env) {
  if (!env.RPC_URL) throw new Error('canary: missing required env: RPC_URL');

  const num = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
  const vaults = list(env.VAULTS).map(lc);
  for (const v of vaults) {
    if (!ADDRESS_RE.test(v)) throw new Error(`canary: VAULTS contains a non-address entry: ${v}`);
  }
  const extraOperators = list(env.EXTRA_OPERATOR_ADDRESSES).map(lc);
  for (const a of extraOperators) {
    if (!ADDRESS_RE.test(a)) throw new Error(`canary: EXTRA_OPERATOR_ADDRESSES contains a non-address entry: ${a}`);
  }
  const operatorRegistry = env.OPERATOR_REGISTRY_ADDRESS ? lc(env.OPERATOR_REGISTRY_ADDRESS) : null;
  if (operatorRegistry && !ADDRESS_RE.test(operatorRegistry)) {
    throw new Error(`canary: OPERATOR_REGISTRY_ADDRESS is not a 20-byte address: ${operatorRegistry}`);
  }

  return {
    rpcUrl: env.RPC_URL,
    chainId: num('CHAIN_ID', 8453),
    chainName: env.CHAIN_NAME || 'base',
    statePath: env.STATE_PATH || './data/indexer-state.json',
    canaryStatePath: env.CANARY_STATE_PATH || './data/canary-state.json',
    vaults,
    operatorRegistry,
    extraOperators,
    webhookUrl: env.ALERT_WEBHOOK_URL || null,
    confirmations: num('CONFIRMATIONS', 5),
    pollIntervalMs: num('CANARY_POLL_INTERVAL_MS', 30_000),
    navDivergenceBps: num('NAV_DIVERGENCE_BPS', 50),
    oracleMinMargin: num('ORACLE_MIN_MARGIN', 0),
    logLookbackBlocks: num('LOG_LOOKBACK_BLOCKS', 0),
    maxLogSpanBlocks: num('MAX_LOG_SPAN_BLOCKS', 2000),
    heartbeatMs: num('HEARTBEAT_MS', 0),
  };
}

/** Atomic write, same write-temp-then-rename discipline the indexer's snapshot uses. */
async function saveCanaryState(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(obj), 'utf8');
  await rename(tmp, path);
}

async function loadCanaryState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { transitions: {}, lastScannedBlock: null };
    throw err;
  }
}

/**
 * Run every signal over every watched vault ONCE and return the flat result list.
 *
 * Pure over its inputs in the way that matters: it touches the chain only through the injected
 * `reader`, and reads the indexer projection only through the `state` object handed to it. A
 * signal that throws is converted into a `skipped` result rather than aborting the sweep — one
 * broken vault must not blind the operator to the other nine.
 *
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {ReturnType<import('../../indexer/src/projections.mjs').emptyState>|null} ctx.state
 * @param {string[]} ctx.vaults
 * @param {ReturnType<typeof resolveCanaryConfig>} ctx.cfg
 * @param {{fromBlock:number, toBlock:number, nowSec:number}} ctx.window
 * @returns {Promise<import('./signal.mjs').SignalResult[]>}
 */
export async function collectSignals({ reader, state, vaults, cfg, window }) {
  const out = [];
  const { fromBlock, toBlock, nowSec } = window;

  for (const vault of vaults) {
    const projected = state?.vaults?.get(vault) ?? null;
    const shareBook = state?.shares?.get(vault) ?? null;

    /** Run one signal, converting a thrown error into a DEGRADED result instead of losing the sweep. */
    const run = async (name, fn) => {
      try {
        out.push(...(await fn()));
      } catch (err) {
        out.push(skipped({
          signal: name, vault,
          message: `${name} check errored on vault ${shortAddr(vault)}: ${err?.message ?? err}`,
          detail: { vault, error: String(err?.message ?? err) },
        }));
      }
    };

    // One config read per vault, shared by the signals that need it.
    let meta = null;
    try {
      const [oracle, usdc, creator, basketLength] = await Promise.all([
        reader.read(vault, VAULT_VIEWS, 'oracle'),
        reader.read(vault, VAULT_VIEWS, 'usdc'),
        reader.read(vault, VAULT_VIEWS, 'creator'),
        reader.read(vault, VAULT_VIEWS, 'basketLength'),
      ]);
      const assets = [];
      for (let i = 0; i < Number(basketLength); i += 1) {
        assets.push(await reader.read(vault, VAULT_VIEWS, 'basketAssets', [i]));
      }
      meta = { oracle, usdc, creator, assets };
    } catch (err) {
      out.push(skipped({
        signal: 'vault-config', vault,
        message: `vault ${shortAddr(vault)} is unreadable at ${cfg.rpcUrl ? 'the configured RPC' : 'the injected client'}: ${err?.message ?? err} — every signal for this vault is suspended`,
        detail: { vault, error: String(err?.message ?? err) },
      }));
      continue;
    }

    await run('oracle-freshness', () => checkOracleFreshness({
      reader, vault, oracle: meta.oracle, assets: meta.assets, nowSec, minMargin: cfg.oracleMinMargin,
    }));

    await run('nav-backing', () => checkNavBacking({
      reader, vault, atBlock: toBlock, thresholdBps: cfg.navDivergenceBps,
    }));

    if (projected) {
      await run('share-conservation', () => checkShareConservation({
        reader, vault,
        projectedTotalShares: projected.totalShares,
        shareBook,
        atBlock: state?.lastBlock || undefined,
      }));
      await run('exit-liveness', () => checkExitLiveness({
        reader, vault, shareBook, creator: meta.creator,
      }));
    } else {
      // No projection for this vault. Say so — do NOT report these two as healthy.
      for (const name of ['share-conservation', 'exit-liveness']) {
        out.push(skipped({
          signal: name, vault,
          message: `${name} cannot run on vault ${shortAddr(vault)}: it is not in the indexer projection at ${cfg.statePath}. Point STATE_PATH at a caught-up indexer snapshot — this vault is unmonitored for that signal, not healthy`,
          detail: { vault, reason: 'no-projection' },
        }));
      }
    }

    await run('module-events', () => checkModuleEvents({ reader, vault, fromBlock, toBlock }));

    await run('fee-routing', () => checkFeeRouting({
      reader, vault, usdc: meta.usdc,
      operatorRegistry: cfg.operatorRegistry, extraOperators: cfg.extraOperators,
      fromBlock, toBlock,
    }));
  }

  return out;
}

/**
 * Build a wired (but not started) canary. Returns `runOnce()` for a single sweep and `start()`
 * for the forever loop.
 */
export async function buildCanary(cfg, { log = console.log, error = console.error, client, fetchImpl, now = () => new Date() } = {}) {
  const reader = createChainReader({
    client, rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, chainName: cfg.chainName,
  });

  const persisted = await loadCanaryState(cfg.canaryStatePath);
  const tracker = createTransitionTracker({ initial: persisted.transitions });
  let lastScannedBlock = persisted.lastScannedBlock ?? null;
  let poll = 0;

  const sinks = [createConsoleSink({ log, error })];
  if (cfg.webhookUrl) sinks.push(createWebhookSink({ url: cfg.webhookUrl, fetchImpl, onError: error }));

  /** The vault set: explicit VAULTS if given, else every vault the indexer has projected. */
  async function resolveVaults() {
    if (cfg.vaults.length > 0) return { vaults: cfg.vaults, state: await tryLoadState() };
    const state = await tryLoadState();
    return { vaults: [...(state?.vaults?.keys() ?? [])], state };
  }

  async function tryLoadState() {
    try {
      return await loadSnapshot(cfg.statePath);
    } catch (err) {
      error(`canary: could not read the indexer snapshot at ${cfg.statePath}: ${err?.message ?? err}`);
      return null;
    }
  }

  /** One sweep: resolve the window, collect signals, emit only what changed, persist. */
  async function runOnce() {
    poll += 1;
    const head = await reader.headBlock();
    const toBlock = Math.max(0, head - cfg.confirmations);
    const fromBlock = lastScannedBlock != null
      ? Math.max(0, Math.min(lastScannedBlock + 1, toBlock))
      : Math.max(0, toBlock - cfg.logLookbackBlocks);
    const span = Math.min(toBlock - fromBlock, cfg.maxLogSpanBlocks);
    const windowFrom = toBlock - span;
    const nowSec = await reader.chainNow();

    const { vaults, state } = await resolveVaults();
    if (vaults.length === 0) {
      error(`canary: no vaults to watch — set VAULTS, or point STATE_PATH at an indexer snapshot that has seen a VaultCreated (currently ${cfg.statePath})`);
      return { transitions: [], results: [], vaults: [] };
    }

    const results = await collectSignals({
      reader, state, vaults, cfg,
      window: { fromBlock: windowFrom, toBlock, nowSec },
    });

    const transitions = tracker.observe(results, { poll, timestamp: now().toISOString() });
    await emitAll(sinks, transitions, { onError: error });

    lastScannedBlock = toBlock;
    await saveCanaryState(cfg.canaryStatePath, { transitions: tracker.snapshot(), lastScannedBlock });
    return { transitions, results, vaults };
  }

  async function start({ signal } = {}) {
    log(`canary up: chain ${cfg.chainId}, read-only, polling every ${cfg.pollIntervalMs}ms. Silence means healthy.`);
    let lastHeartbeat = 0;
    for (;;) {
      if (signal?.aborted) return;
      try {
        const { vaults } = await runOnce();
        if (cfg.heartbeatMs > 0 && Date.now() - lastHeartbeat >= cfg.heartbeatMs) {
          lastHeartbeat = Date.now();
          const bad = tracker.unhealthy();
          log(`canary heartbeat: ${vaults.length} vault(s), ${tracker.size} signal(s) tracked, ${bad.length} not OK${bad.length ? `: ${bad.map((b) => b.id).join(', ')}` : ''}`);
        }
      } catch (err) {
        // A poll failure is an RPC problem, not a protocol problem. Say so and keep watching.
        error(`canary poll error (will retry): ${err?.message ?? err}`);
      }
      await sleep(cfg.pollIntervalMs, signal);
    }
  }

  return { reader, tracker, runOnce, start };
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
  const cfg = resolveCanaryConfig(process.env);
  buildCanary(cfg).then(({ start }) => start()).catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
