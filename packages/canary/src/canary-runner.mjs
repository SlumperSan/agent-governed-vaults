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
 *   CANARY_STATE_PATH (./data/canary-state.json)  transition state, so a restart does not re-page.
 *                              It also holds the aggregator identities `feed-identity` pinned on
 *                              first sight. Deleting it re-pins from whatever is live, so a swap
 *                              that happened while the canary was down is not narrated — the
 *                              decimals and denomination checks in that signal need no pin and
 *                              cover the harm either way.
 *   CHAIN_ID (8453)  CHAIN_NAME (base)  CONFIRMATIONS (5)
 *   CANARY_POLL_INTERVAL_MS (30000)  sweep cadence. Named apart from the indexer's
 *                              POLL_INTERVAL_MS because docker-compose feeds both services one
 *                              .env file, and a canary sweep is far heavier than an indexer poll.
 *   NAV_DIVERGENCE_BPS (50)    composition-divergence bar, 50 = 0.5%
 *   ORACLE_MIN_MARGIN (0)      RETIRED-ORACLE deployments only: alert when fresh-sources minus
 *                              quorum <= this. Inert against a ChainlinkOracle, which has no quorum.
 *   ORACLE_FEED_CADENCE_SECONDS (none)  ChainlinkOracle deployments only: comma-separated
 *                              address:seconds pairs giving each feed's OWN publish cadence — e.g.
 *                              0x4200…0006:1200,0xcbB7…33Bf:1200. No oracle exposes this on-chain
 *                              (it is Chainlink's off-chain publishing config, not contract state),
 *                              so it must be told; copy it from contracts/config/*.json's
 *                              chainlinkOracle.assets[].feedCadenceSeconds. Drives the early-warning
 *                              bar below — an asset left out of this map gets no derived warning.
 *   ORACLE_STALENESS_WARN_PCT (unset = derived)  ChainlinkOracle deployments only: MANUAL override
 *                              of the early-warning bar (% of heartbeat), which otherwise alerts
 *                              once a feed's answer has aged past the bar, BEFORE the breaker trips.
 *                              Left unset, the bar is DERIVED per asset from
 *                              ORACLE_FEED_CADENCE_SECONDS — on by default wherever the configured
 *                              heartbeat is comfortably wider than the feed's own cadence, off
 *                              (named why, in `detail.warnDisabledReason`) where it is not or where
 *                              no cadence is configured. A flat bar cannot be calibrated once for
 *                              every feed: a feed that updates only on its heartbeat sits near 100%
 *                              of it just before every scheduled publish, so a low flat bar pages on
 *                              healthy behaviour and gets the canary muted. Set this to override the
 *                              derivation either way, including `0` to force the warning off.
 *   LOG_LOOKBACK_BLOCKS (0)    on a cold start, how far back to scan for events
 *   MAX_LOG_SPAN_BLOCKS (2000) cap on one poll's getLogs range
 *   HEARTBEAT_MS (0)           if set, periodically print a one-line "still watching" summary
 *
 * Run: `RPC_URL=… STATE_PATH=… node packages/canary/src/canary-runner.mjs`
 */

import { fileURLToPath } from 'node:url';
import { loadSnapshot } from '../../indexer/src/store.mjs';
import { createCanaryStateWriter, loadCanaryState, verifyCanaryState, formatCanaryStateReport } from './state-file.mjs';
import { loggerFromEnv } from '../../oplog/src/logger.mjs';
import { createHeartbeat, defaultHeartbeatDir } from '../../oplog/src/heartbeat.mjs';
import { createShutdown } from '../../oplog/src/shutdown.mjs';
import { resolveDurabilityOptions } from '../../oplog/src/durable.mjs';
import { createChainReader } from './reader.mjs';
import { createTransitionTracker } from './transitions.mjs';
import { createConsoleSink, createWebhookSink, emitAll } from './sinks.mjs';
import { VAULT_VIEWS } from './abis.mjs';
import { skipped, detectorBroken, shortAddr } from './signal.mjs';
import { checkOracleSignals } from './signals/oracle-health.mjs';
import { checkFeedIdentity, applyIdentityObservations } from './signals/feed-identity.mjs';
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

  // address:seconds pairs — the one fact no oracle exposes on-chain, so the derived early-warning
  // bar in signals/oracle-health.mjs has to be told it. An asset left out simply gets no derived
  // bar (reported, not silent — see `warnDisabledReason` on that signal).
  const oracleFeedCadenceSeconds = {};
  for (const entry of list(env.ORACLE_FEED_CADENCE_SECONDS)) {
    const [rawAddr, rawSec] = entry.split(':');
    if (!rawAddr || !ADDRESS_RE.test(rawAddr)) {
      throw new Error(`canary: ORACLE_FEED_CADENCE_SECONDS contains a non-address entry: ${entry}`);
    }
    const sec = Number(rawSec);
    if (!Number.isFinite(sec) || sec <= 0) {
      throw new Error(`canary: ORACLE_FEED_CADENCE_SECONDS has a non-positive/invalid cadence for ${rawAddr}: ${rawSec ?? ''}`);
    }
    oracleFeedCadenceSeconds[lc(rawAddr)] = sec;
  }

  const statePath = env.STATE_PATH || './data/indexer-state.json';
  const pollIntervalMs = num('CANARY_POLL_INTERVAL_MS', 30_000);
  return {
    rpcUrl: env.RPC_URL,
    chainId: num('CHAIN_ID', 8453),
    chainName: env.CHAIN_NAME || 'base',
    statePath,
    canaryStatePath: env.CANARY_STATE_PATH || './data/canary-state.json',
    ...resolveDurabilityOptions(env),
    heartbeatDir: defaultHeartbeatDir({ ...env, STATE_PATH: statePath }),
    // Three missed sweeps, floored at 60s. A canary sweep is many RPC round-trips, so its
    // tolerance is looser than the indexer's on purpose.
    heartbeatStaleMs: Math.max(60_000, pollIntervalMs * 3),
    vaults,
    operatorRegistry,
    extraOperators,
    webhookUrl: env.ALERT_WEBHOOK_URL || null,
    confirmations: num('CONFIRMATIONS', 5),
    pollIntervalMs,
    navDivergenceBps: num('NAV_DIVERGENCE_BPS', 50),
    oracleMinMargin: num('ORACLE_MIN_MARGIN', 0),
    oracleStalenessWarnPct: num('ORACLE_STALENESS_WARN_PCT', 0),
    // Distinguishes "unset" from "explicitly 0" without changing oracleStalenessWarnPct's type —
    // the derived default must apply when nothing was set, and must NOT apply (even to 0) when an
    // operator explicitly chose a value, including choosing to force it off.
    oracleStalenessWarnPctSet: env.ORACLE_STALENESS_WARN_PCT != null && env.ORACLE_STALENESS_WARN_PCT !== '',
    oracleFeedCadenceSeconds,
    logLookbackBlocks: num('LOG_LOOKBACK_BLOCKS', 0),
    maxLogSpanBlocks: num('MAX_LOG_SPAN_BLOCKS', 2000),
    heartbeatMs: num('HEARTBEAT_MS', 0),
  };
}

/**
 * Run every signal over every watched vault ONCE and return the flat result list.
 *
 * Pure over its inputs in the way that matters: it touches the chain only through the injected
 * `reader`, and reads the indexer projection only through the `state` object handed to it. A
 * signal that throws is converted into a DETECTOR BROKEN result rather than aborting the sweep —
 * one broken vault must not blind the operator to the other nine, and a check that threw must not
 * go quiet after a single line.
 *
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {ReturnType<import('../../indexer/src/projections.mjs').emptyState>|null} ctx.state
 * @param {string[]} ctx.vaults
 * @param {ReturnType<typeof resolveCanaryConfig>} ctx.cfg
 * @param {{fromBlock:number, toBlock:number, nowSec:number}} ctx.window
 * @param {Record<string, any>} [ctx.identityPins] remembered aggregator identities, from the canary
 *        state file. Read-only in here; the caller folds this sweep's observations back in with
 *        `applyIdentityObservations` and persists the result.
 * @returns {Promise<import('./signal.mjs').SignalResult[]>}
 */
export async function collectSignals({ reader, state, vaults, cfg, window, identityPins = {} }) {
  const out = [];
  const { fromBlock, toBlock, nowSec } = window;

  for (const vault of vaults) {
    const projected = state?.vaults?.get(vault) ?? null;
    const shareBook = state?.shares?.get(vault) ?? null;

    /**
     * Run one signal, converting a thrown error into a result instead of losing the sweep.
     *
     * A check that THREW is a broken detector, not a degraded observation: nothing was measured and
     * nobody knows what is being missed. It is therefore marked `detectorBroken`, which the
     * transition tracker re-asserts on a backoff rather than reporting once and going quiet. That
     * quiet-after-one-line behaviour is precisely how the pre-C-6 oracle signal stayed dead through
     * an entire pivot.
     */
    const run = async (name, fn) => {
      try {
        out.push(...(await fn()));
      } catch (err) {
        out.push(detectorBroken({
          signal: name, vault,
          message: `${name} check ERRORED on vault ${shortAddr(vault)} and measured nothing: ${err?.message ?? err} — this vault is unmonitored for that signal, not healthy`,
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
      out.push(detectorBroken({
        signal: 'vault-config', vault,
        message: `vault ${shortAddr(vault)} is unreadable at ${cfg.rpcUrl ? 'the configured RPC' : 'the injected client'}: ${err?.message ?? err} — EVERY signal for this vault is suspended, so it is entirely unmonitored`,
        detail: { vault, error: String(err?.message ?? err) },
      }));
      continue;
    }

    // Flavor-dispatched: ChainlinkOracle (the live post-C-6 stack) or the retired OracleAggregator.
    // An oracle that answers neither returns a DETECTOR BROKEN result rather than a silent skip.
    await run('oracle-freshness', () => checkOracleSignals({
      reader, vault, oracle: meta.oracle, assets: meta.assets, nowSec,
      minMargin: cfg.oracleMinMargin,
      // undefined (not cfg.oracleStalenessWarnPct's always-a-number default) when the operator
      // never set ORACLE_STALENESS_WARN_PCT, so the signal's derived default can apply — see
      // resolveWarnBar in signals/oracle-health.mjs.
      stalenessWarnPct: cfg.oracleStalenessWarnPctSet ? cfg.oracleStalenessWarnPct : undefined,
      cadenceByAsset: cfg.oracleFeedCadenceSeconds,
    }));

    // The other half of the oracle: not "is the price fresh" but "is it still the same feed, and
    // is it still scaled the way the immutable config assumed". Silent on a retired-aggregator
    // deployment, where no Chainlink proxy exists to drift.
    await run('feed-identity', () => checkFeedIdentity({
      reader, vault, oracle: meta.oracle, assets: meta.assets, pins: identityPins,
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
export async function buildCanary(cfg, { log, error, logger = loggerFromEnv('canary'), client, fetchImpl, now = () => new Date() } = {}) {
  // The transition lines ARE the product here, so they keep their own stdout/stderr split (`2>`
  // gives a pure alert feed). Left uninjected they now flow through the structured logger like
  // everything else; the tests inject plain string sinks and are unaffected.
  const line = log ?? logger.text('canary.transition');
  const errLine = error ?? logger.text('canary.transition', 'error');

  const reader = createChainReader({
    client, rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, chainName: cfg.chainName,
  });

  const persisted = await loadCanaryState(cfg.canaryStatePath);
  const tracker = createTransitionTracker({ initial: persisted.transitions });
  let lastScannedBlock = persisted.lastScannedBlock ?? null;
  // Defaulted, not assumed: a state file written before this key existed is a legitimate input.
  let identityPins = persisted.feedIdentity ?? {};
  let poll = 0;

  const stateWriter = createCanaryStateWriter({
    path: cfg.canaryStatePath, backups: cfg.backups ?? 0, backupIntervalMs: cfg.backupIntervalMs ?? 0,
  });
  const heartbeat = createHeartbeat({
    dir: cfg.heartbeatDir ?? './data', service: 'canary',
    staleAfterMs: cfg.heartbeatStaleMs ?? 120_000,
    onError: (err) => logger.warn?.('heartbeat.failed', { error: String(err?.message ?? err) }),
  });

  const sinks = [createConsoleSink({ log: line, error: errLine })];
  if (cfg.webhookUrl) sinks.push(createWebhookSink({ url: cfg.webhookUrl, fetchImpl, onError: errLine }));

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
      errLine(`canary: could not read the indexer snapshot at ${cfg.statePath}: ${err?.message ?? err}`);
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
    // After downtime the backlog can exceed one window. We scan the most recent MAX_LOG_SPAN_BLOCKS
    // and move on, which SKIPS the older blocks — the event signals (module-events, fee-routing)
    // never see them. Say so: a silent coverage gap is precisely what this package exists to
    // prevent, and an operator who sees this line can widen MAX_LOG_SPAN_BLOCKS or sweep the gap
    // by hand before it scrolls away.
    if (windowFrom > fromBlock) {
      errLine(`canary: event scan gap — blocks ${fromBlock}-${windowFrom - 1} (${windowFrom - fromBlock} blocks) were NOT scanned for ModuleCallFailed/SliceEscrowed/fee outflows. The backlog exceeded MAX_LOG_SPAN_BLOCKS=${cfg.maxLogSpanBlocks}; raise it or scan that range manually.`);
    }
    const nowSec = await reader.chainNow();

    const { vaults, state } = await resolveVaults();
    if (vaults.length === 0) {
      errLine(`canary: no vaults to watch — set VAULTS, or point STATE_PATH at an indexer snapshot that has seen a VaultCreated (currently ${cfg.statePath})`);
      return { transitions: [], results: [], vaults: [] };
    }

    const results = await collectSignals({
      reader, state, vaults, cfg, identityPins,
      window: { fromBlock: windowFrom, toBlock, nowSec },
    });

    const transitions = tracker.observe(results, { poll, timestamp: now().toISOString() });
    // AFTER the transition is computed, never before: the alert for a swap is the comparison
    // against the OLD pin, and re-pinning first would compare the new identity against itself and
    // report nothing. Re-pinning here is also what makes a benign swap self-clear next sweep.
    identityPins = applyIdentityObservations(identityPins, results);
    await emitAll(sinks, transitions, { onError: errLine });

    lastScannedBlock = toBlock;
    await flush();
    return { transitions, results, vaults };
  }

  /** Persist what the tracker knows right now. Called after every sweep, and on shutdown. */
  async function flush() {
    await stateWriter.save({ transitions: tracker.snapshot(), lastScannedBlock, feedIdentity: identityPins });
    return { tracked: tracker.size, lastScannedBlock, feedsPinned: Object.keys(identityPins).length };
  }

  const ac = new AbortController();
  /** @type {Promise<void>|null} */
  let running = null;

  async function loop(signal) {
    let lastHeartbeatLine = 0;
    for (;;) {
      if (signal.aborted) return;
      try {
        const { vaults } = await runOnce();
        // Only a SUCCESSFUL sweep counts as watching. A canary that cannot reach the RPC is not
        // monitoring anything and must not keep telling ops-check that it is.
        await heartbeat.beat({ vaults: vaults.length, tracked: tracker.size, notOk: tracker.unhealthy().length, lastScannedBlock });
        if (cfg.heartbeatMs > 0 && Date.now() - lastHeartbeatLine >= cfg.heartbeatMs) {
          lastHeartbeatLine = Date.now();
          const bad = tracker.unhealthy();
          line(`canary heartbeat: ${vaults.length} vault(s), ${tracker.size} signal(s) tracked, ${bad.length} not OK${bad.length ? `: ${bad.map((b) => b.id).join(', ')}` : ''}`);
        }
      } catch (err) {
        // A poll failure is an RPC problem, not a protocol problem. Say so and keep watching.
        logger.warn?.('sweep.failed', { error: String(err?.message ?? err) });
        errLine(`canary poll error (will retry): ${err?.message ?? err}`);
      }
      await sleep(cfg.pollIntervalMs, signal);
    }
  }

  async function start({ signal } = {}) {
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    logger.info?.('starting', {
      chainId: cfg.chainId, pollIntervalMs: cfg.pollIntervalMs, statePath: cfg.statePath,
      canaryStatePath: cfg.canaryStatePath, tracked: tracker.size, readOnly: true,
    });
    line(`canary up: chain ${cfg.chainId}, read-only, polling every ${cfg.pollIntervalMs}ms. Silence means healthy.`);
    running = loop(ac.signal);
    return running;
  }

  /**
   * Stop cleanly: abort the sweep loop, wait for the in-flight sweep, then FLUSH the transition
   * state. Losing that file is not fatal but costs one duplicate page per still-firing signal on
   * the next start — precisely the noise an operator restarting a service does not need.
   */
  async function stop() {
    ac.abort();
    if (running) await running.catch(() => {});
    const flushed = await flush();
    logger.info?.('stopped', { ...flushed, canaryStatePath: cfg.canaryStatePath });
    return flushed;
  }

  return { reader, tracker, runOnce, start, stop, flush, heartbeat, logger };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(finish, ms);
    function finish() {
      clearTimeout(t);
      // Removed explicitly: this sleeps once per sweep against a signal that lives as long as the
      // process, so leaving listeners attached would leak one per sweep forever.
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
  // `verify` runs BEFORE config resolution, so it works with no RPC_URL and no env at all —
  // which is the state of the shell you are in when you need it.
  if (argv[0] === 'verify') {
    const path = argv[1] || process.env.CANARY_STATE_PATH || './data/canary-state.json';
    const report = await verifyCanaryState(path);
    (report.ok ? console.log : console.error)(formatCanaryStateReport(report));
    process.exit(report.ok ? 0 : 1);
  } else {
    const logger = loggerFromEnv('canary');
    try {
      const cfg = resolveCanaryConfig(process.env);
      const { start, stop } = await buildCanary(cfg, { logger });
      createShutdown({ log: logger })
        .onShutdown('canary.flush-transitions', stop)
        .install();
      await start();
    } catch (err) {
      logger.error('startup.failed', { error: String(err?.message ?? err) });
      process.exit(1);
    }
  }
}
