// @ts-check
/**
 * Runnable API server entrypoint. Serves the x402-metered read API over the indexer's snapshot.
 * Env-driven and NON-CUSTODIAL: it holds no key and settles nothing itself — payment verification
 * and settlement are delegated to a facilitator (a remote HTTP facilitator in production; an
 * accept-all stub for local dev). It shares state with the indexer through the snapshot file: it
 * loads the snapshot on boot and reloads it periodically, so indexer and API run as separate
 * processes.
 *
 * Required env:
 *   PRICE_ASSET     USDC contract address (what payments are denominated in)
 *   PRICE_PAYTO     recipient address for metered-read payments
 * Optional env:
 *   STATE_PATH (./data/indexer-state.json)  PORT (8402)  RELOAD_MS (5000)
 *   PRICE_AMOUNT (10000 = $0.01)  PRICE_NETWORK (base)
 *   CHAIN_ID   the chain this API serves. Its ONLY effect is to resolve the x402 capability from
 *              `contracts/config/*.json` (see packages/chain-config/src/x402.mjs): a config whose
 *              `x402.enabled` is false — chain 4663 — makes this server answer the metered routes
 *              without a 402 gate and bucket every route instead. Unset, or a chain with no config
 *              or no `x402` block, leaves metering ON, which is what it has always been.
 *   FACILITATOR (stub | http)   FACILITATOR_URL (required when FACILITATOR=http)
 *   CORS (1 to enable — needed for the browser live mode)
 *   RATE_LIMIT_BURST (60)  RATE_LIMIT_PER_SEC (5, 0 disables)  RATE_LIMIT_MAX_IPS (10000)
 *   TRUST_PROXY (1 iff a reverse proxy in front of this process sets x-forwarded-for)
 *   MAX_URL_BYTES (2048)  MAX_BODY_BYTES (8192)  MAX_HEADER_BYTES (16384)
 *   HEARTBEAT_DIR (dirname of STATE_PATH)  LOG_FORMAT (json|pretty)  LOG_LEVEL (info)
 *
 * Run: `PRICE_ASSET=… PRICE_PAYTO=… node apps/api/src/serve.mjs`
 */

import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { createApi, DEFAULT_LIMITS } from './server.mjs';
import { createHttpFacilitator, createStubFacilitator } from './facilitator.mjs';
import { createRateLimiter } from './ratelimit.mjs';
import { createMetrics } from './metrics.mjs';
import { loadSnapshot } from '../../../packages/indexer/src/store.mjs';
import { loggerFromEnv } from '../../../packages/oplog/src/logger.mjs';
import { createHeartbeat, defaultHeartbeatDir } from '../../../packages/oplog/src/heartbeat.mjs';
import { createShutdown } from '../../../packages/oplog/src/shutdown.mjs';
import { x402Capability } from '../../../packages/chain-config/src/x402.mjs';

/**
 * Parse + validate the API config from a raw env object. Pure and testable.
 * @param {Record<string,string|undefined>} env
 */
export function resolveApiConfig(env) {
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? '');
  const missing = ['PRICE_ASSET', 'PRICE_PAYTO'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`api: missing required env: ${missing.join(', ')}`);
  if (!isAddr(env.PRICE_ASSET)) throw new Error(`api: PRICE_ASSET is not an address: ${env.PRICE_ASSET}`);
  if (!isAddr(env.PRICE_PAYTO)) throw new Error(`api: PRICE_PAYTO is not an address: ${env.PRICE_PAYTO}`);

  const facilitator = (env.FACILITATOR || 'stub').toLowerCase();
  if (facilitator !== 'stub' && facilitator !== 'http')
    throw new Error(`api: FACILITATOR must be 'stub' or 'http', got '${facilitator}'`);
  if (facilitator === 'http' && !env.FACILITATOR_URL)
    throw new Error('api: FACILITATOR=http requires FACILITATOR_URL');

  const num = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
  const flag = (k) => env[k] === '1' || env[k] === 'true';

  const refillPerSec = num('RATE_LIMIT_PER_SEC', 5);
  const capacity = num('RATE_LIMIT_BURST', 60);
  if (!Number.isFinite(refillPerSec) || refillPerSec < 0) throw new Error(`api: RATE_LIMIT_PER_SEC must be >= 0, got '${env.RATE_LIMIT_PER_SEC}'`);
  if (!Number.isFinite(capacity) || capacity <= 0) throw new Error(`api: RATE_LIMIT_BURST must be > 0, got '${env.RATE_LIMIT_BURST}'`);

  // Kept a plain parsed value here rather than a resolved capability, because this function is
  // pure by contract (see the header) and resolving reads the config directory off disk.
  // buildApiServer does the lookup. An unparseable CHAIN_ID is a typo worth failing on, not a
  // silent fall back to "no chain" — that would quietly leave a payment gate in the wrong state.
  if (env.CHAIN_ID != null && env.CHAIN_ID !== '' && !Number.isInteger(Number(env.CHAIN_ID)))
    throw new Error(`api: CHAIN_ID must be an integer chain id, got '${env.CHAIN_ID}'`);
  const chainId = env.CHAIN_ID != null && env.CHAIN_ID !== '' ? Number(env.CHAIN_ID) : null;

  const statePath = env.STATE_PATH || './data/indexer-state.json';
  return {
    statePath,
    chainId,
    port: num('PORT', 8402),
    reloadMs: num('RELOAD_MS', 5000),
    cors: flag('CORS'),
    price: {
      asset: env.PRICE_ASSET,
      amount: env.PRICE_AMOUNT || '10000',
      payTo: env.PRICE_PAYTO,
      network: env.PRICE_NETWORK || 'base',
    },
    facilitatorKind: facilitator,
    facilitatorUrl: env.FACILITATOR_URL,
    // RATE_LIMIT_PER_SEC=0 turns the limiter off entirely — for a private deployment where the
    // only client is your own front end and an accidental 429 is worse than an unbounded scrape.
    rateLimit: { enabled: refillPerSec > 0, capacity, refillPerSec, maxKeys: num('RATE_LIMIT_MAX_IPS', 10_000) },
    // Off by default and it must stay that way: x-forwarded-for is client-spoofable, so trusting
    // it without a proxy that overwrites it lets one attacker mint a fresh bucket per request.
    trustProxy: flag('TRUST_PROXY'),
    limits: {
      maxUrlLength: num('MAX_URL_BYTES', DEFAULT_LIMITS.maxUrlLength),
      maxBodyBytes: num('MAX_BODY_BYTES', DEFAULT_LIMITS.maxBodyBytes),
      maxHeaderBytes: num('MAX_HEADER_BYTES', DEFAULT_LIMITS.maxHeaderBytes),
    },
    heartbeatDir: defaultHeartbeatDir({ ...env, STATE_PATH: statePath }),
  };
}

/** Build the facilitator a config asks for. */
export function facilitatorFromConfig(cfg, { fetchImpl } = {}) {
  return cfg.facilitatorKind === 'http'
    ? createHttpFacilitator({ url: cfg.facilitatorUrl, fetchImpl })
    : createStubFacilitator();
}

/**
 * Build the API server from config. Loads the initial snapshot and exposes a `reload()` that
 * refreshes state IN PLACE (so createApi's closure stays valid) — fault-tolerant: a malformed or
 * version-mismatched snapshot is logged and the previous good state is kept serving.
 *
 * `reload()` also drives the two operational signals the API is uniquely placed to report: the
 * snapshot's age (the indexer-lag metric — see metrics.mjs on why age, not blocks-behind) and the
 * API's own heartbeat, which is written on a SUCCESSFUL reload so a process that is up but has
 * lost its snapshot does not look healthy to ops-check.
 *
 * @param {ReturnType<typeof resolveApiConfig>} cfg
 * @param {{facilitator?:object, log?:any, now?:() => number, x402?:object}} [opts]
 */
export async function buildApiServer(cfg, { facilitator, log = loggerFromEnv('api'), now = () => Date.now(), x402 } = {}) {
  // The chain's x402 capability, read from contracts/config once at boot. Injectable so a test can
  // supply one without a config directory; absent CHAIN_ID resolves to enabled, as it always was.
  const cap = x402 ?? x402Capability(cfg.chainId);
  const state = await loadSnapshot(cfg.statePath);
  const fac = facilitator ?? facilitatorFromConfig(cfg);
  const metrics = createMetrics();
  const rateLimit = cfg.rateLimit?.enabled
    ? createRateLimiter({ capacity: cfg.rateLimit.capacity, refillPerSec: cfg.rateLimit.refillPerSec, maxKeys: cfg.rateLimit.maxKeys, now })
    : null;

  const startedAt = now();
  let snapshotMtimeMs = await mtimeOrNull(cfg.statePath);
  metrics.gauge('vault_api_uptime_seconds', () => Math.round((now() - startedAt) / 1000));
  metrics.gauge('vault_indexer_snapshot_age_seconds', () => (snapshotMtimeMs == null ? -1 : Math.round((now() - snapshotMtimeMs) / 1000)));

  const heartbeat = createHeartbeat({
    dir: cfg.heartbeatDir, service: 'api',
    // Three reload cycles of silence is a dead API, with room for one slow disk read.
    staleAfterMs: Math.max(30_000, cfg.reloadMs * 3),
    onError: (err) => log.warn?.('heartbeat.failed', { error: String(err?.message ?? err) }),
  });

  const api = createApi({
    state, facilitator: fac, price: cfg.price, cors: cfg.cors,
    rateLimit, metrics, limits: cfg.limits, trustProxy: cfg.trustProxy, x402: cap, log,
  });

  async function reload() {
    try {
      const fresh = await loadSnapshot(cfg.statePath);
      // Replace the Map/scalar fields on the SAME object the API closes over.
      Object.assign(state, fresh);
      snapshotMtimeMs = await mtimeOrNull(cfg.statePath);
      await heartbeat.beat({ lastBlock: state.lastBlock, vaults: state.vaults.size });
      return true;
    } catch (err) {
      metrics.inc('vault_api_snapshot_reload_failures_total');
      log.warn?.('snapshot.reload_failed', { path: cfg.statePath, lastBlock: state.lastBlock, error: String(err?.message ?? err) });
      return false;
    }
  }

  return { api, state, reload, metrics, rateLimit, heartbeat, x402: cap, log };
}

async function mtimeOrNull(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

// ── entrypoint ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const log = loggerFromEnv('api');
  const cfg = resolveApiConfig(process.env);
  buildApiServer(cfg, { log }).then(async ({ api, state, reload, metrics, heartbeat, x402 }) => {
    if (!x402.enabled) {
      log.warn('x402.disabled', {
        chainId: x402.chainId, chain: x402.chainName, why: x402.source,
        msg: 'metered routes are served WITHOUT a payment gate on this chain; the per-IP rate limiter covers every route instead.',
      });
    } else if (cfg.chainId != null && x402.chainName == null) {
      // A CHAIN_ID was set and no config matched it. Metering stays on, which is the safe default,
      // but on a chain that means to switch it OFF this is the shape of the failure: the config
      // directory did not ship (see .dockerignore / the Dockerfile COPY). Say so loudly rather
      // than letting a packaging mistake look like a deliberate "still metered".
      log.warn('x402.capability_unresolved', {
        chainId: cfg.chainId, why: x402.source,
        msg: 'no chain config matched CHAIN_ID, so x402 metering is left ON by default. If this chain is meant to have it off, contracts/config did not reach this runtime.',
      });
    }
    if (cfg.facilitatorKind === 'stub') {
      log.warn('facilitator.stub', { msg: 'payments are ACCEPTED WITHOUT on-chain settlement (dev only). Set FACILITATOR=http + FACILITATOR_URL for production.' });
    }
    const timer = setInterval(reload, cfg.reloadMs);
    if (typeof timer.unref === 'function') timer.unref();
    await heartbeat.beat({ lastBlock: state.lastBlock, vaults: state.vaults.size }, { force: true });

    // SIGTERM: stop reloading, stop accepting, let in-flight responses finish, then close.
    // `closeIdleConnections` is what makes this bounded — keep-alive sockets with no request in
    // flight would otherwise hold the server open for their full timeout.
    createShutdown({ log })
      .onShutdown('api.stop-reload', () => clearInterval(timer))
      .onShutdown('api.drain', () => new Promise((resolve) => {
        api.server.close(() => resolve(undefined));
        api.server.closeIdleConnections?.();
      }))
      .onShutdown('api.final-metrics', () => log.info('metrics.final', metrics.snapshot()))
      .install();

    api.server.listen(cfg.port, () => {
      log.info('listening', {
        port: cfg.port, snapshot: cfg.statePath, lastBlock: state.lastBlock, reloadMs: cfg.reloadMs,
        chainId: x402.chainId, x402: x402.enabled ? 'metered' : 'off',
        facilitator: cfg.facilitatorKind, cors: cfg.cors, trustProxy: cfg.trustProxy,
        rateLimit: cfg.rateLimit.enabled ? `${cfg.rateLimit.refillPerSec}/s burst ${cfg.rateLimit.capacity}` : 'off',
      });
    });
  }).catch((err) => {
    log.error('startup.failed', { error: String(err?.message ?? err) });
    process.exit(1);
  });
}
