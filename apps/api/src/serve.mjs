// @ts-check
/**
 * Runnable API server entrypoint. Serves the x402-metered read API over the indexer's snapshot.
 * Env-driven and, in every mode but one, NON-CUSTODIAL: it holds no key and settles nothing itself
 * — payment verification
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
 *   NETWORK    the payment network this API serves, when it has no EVM chain id -- `solana-mainnet`
 *              and its siblings in `config/networks/*.json`. Same single effect as CHAIN_ID and
 *              the same default: an unknown network, or one whose file declares no `x402` block,
 *              leaves metering ON. Set NETWORK or CHAIN_ID, never both: they answer the same
 *              question from two different directories, and a process that has been told both has
 *              been told something contradictory about a payment gate. It refuses to start.
 *   CHAIN_ID   the chain this API serves. Its ONLY effect is to resolve the x402 capability from
 *              `contracts/config/*.json` (see packages/chain-config/src/x402.mjs): a config whose
 *              `x402.enabled` is false — chain 4663 — makes this server answer the metered routes
 *              without a 402 gate and bucket every route instead. Unset, or a chain with no config
 *              or no `x402` block, leaves metering ON, which is what it has always been.
 *   FACILITATOR (stub | http | svm)   FACILITATOR_URL (required when FACILITATOR=http)
 *   FACILITATOR=svm REFUSES TO BOOT without SVM_I_UNDERSTAND_SETTLEMENT_IS_NOT_WIRED=yes. The
 *              facilitator is complete and tested; the 402 challenge and the envelope check are
 *              still EVM-shaped, so every payment would be refused before it was reached. The
 *              refusal comes out with the change that finishes the path.
 *   SVM_RPC_URL, SVM_KEYPAIR, SVM_DESTINATION_TOKEN_ACCOUNT   required when FACILITATOR=svm.
 *              The Solana path settles an SPL TransferChecked the CLIENT built, so this process
 *              signs as fee payer and needs a funded keypair -- unlike the EVM path, which can be
 *              keyless behind an HTTP delegate. SVM_KEYPAIR is the 64-byte secret key as a JSON
 *              array or base58; it is never read from a file in this repository and never logged.
 *              SVM_DESTINATION_TOKEN_ACCOUNT is stated by the operator rather than derived from
 *              PRICE_PAYTO, so a mismatch is a rejection and never a redirect.
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
import { createSvmFacilitator, keypairFromEnv, Connection } from './facilitator-svm.mjs';
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
  if (facilitator !== 'stub' && facilitator !== 'http' && facilitator !== 'svm')
    throw new Error(`api: FACILITATOR must be 'stub', 'http' or 'svm', got '${facilitator}'`);
  if (facilitator === 'http' && !env.FACILITATOR_URL)
    throw new Error('api: FACILITATOR=http requires FACILITATOR_URL');
  // Every one of these is required rather than defaulted, and that is the point: a Solana
  // facilitator with a missing destination would verify against `undefined` and refuse every
  // payment, which looks like a client problem for as long as it takes somebody to read this file.
  if (facilitator === 'svm')
    for (const k of ['SVM_RPC_URL', 'SVM_KEYPAIR', 'SVM_DESTINATION_TOKEN_ACCOUNT'])
      if (!env[k]) throw new Error(`api: FACILITATOR=svm requires ${k}`);

  // AND THE MODE REFUSES TO START, BECAUSE THE PATH THROUGH IT IS NOT FINISHED.
  //
  // A review of the facilitator asked the question one level up from the paragraph above and got a
  // worse answer: with `FACILITATOR=svm` the server BOOTS, advertises metered routes, and rejects
  // every payment — `PRICE_ASSET` is an EVM address by the check twelve lines up, so the mint never
  // matches; and `checkEnvelopeAgainstPrice` in x402.mjs reads `envelope.authorization`, which an
  // SVM envelope does not have, so it fails at `asset-mismatch` before the facilitator is called at
  // all. An operator selecting this mode would see a working server refusing every client.
  //
  // That is exactly the failure the comment above describes, so it gets the same answer: fail at
  // boot, loudly, naming what is missing. The facilitator itself is complete and tested — what is
  // missing is the challenge and envelope shape for a non-EVM network, which is the next change.
  // Lifting this refusal is one line, and it belongs in the commit that makes the path work.
  if (facilitator === 'svm' && env.SVM_I_UNDERSTAND_SETTLEMENT_IS_NOT_WIRED !== 'yes')
    throw new Error(
      'api: FACILITATOR=svm is not reachable end to end yet. The facilitator verifies and settles '
      + 'correctly, but the 402 challenge and the envelope check are still EVM-shaped: PRICE_ASSET '
      + 'must be an 0x address, and checkEnvelopeAgainstPrice reads envelope.authorization, which an '
      + 'SVM envelope has no equivalent of. Every payment would be refused as asset-mismatch before '
      + 'this facilitator saw it. Set SVM_I_UNDERSTAND_SETTLEMENT_IS_NOT_WIRED=yes to boot anyway '
      + 'for testing.',
    );

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

  // NETWORK is the same question asked of a chain that has no chain id to ask it with. Both set is
  // refused rather than resolved by precedence: whichever way a precedence rule fell, half the
  // readers of this file would assume the other, and the thing being decided is whether a payment
  // gate is on. A boot that fails with both names printed is the cheapest possible version of that
  // argument. A numeric NETWORK is refused for the same reason -- it would resolve out of
  // contracts/config and make NETWORK silently mean CHAIN_ID.
  const network = env.NETWORK != null && env.NETWORK.trim() !== '' ? env.NETWORK.trim() : null;
  if (network != null && chainId != null)
    throw new Error(`api: set NETWORK or CHAIN_ID, not both — got NETWORK='${network}' and CHAIN_ID='${env.CHAIN_ID}'. They resolve the same x402 capability from different directories.`);
  if (network != null && Number.isFinite(Number(network)))
    throw new Error(`api: NETWORK must be a network NAME, not a number, got '${network}'. A numeric value belongs in CHAIN_ID.`);

  const statePath = env.STATE_PATH || './data/indexer-state.json';
  return {
    statePath,
    chainId,
    network,
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
    // The keypair is carried on the config object and NEVER logged. `resolveApiConfig` is pure and
    // does not parse it -- `facilitatorFromConfig` does, so a bad key fails where the facilitator
    // is built rather than where the config is read.
    svm: facilitator === 'svm'
      ? { rpcUrl: env.SVM_RPC_URL, keypair: env.SVM_KEYPAIR, destinationTokenAccount: env.SVM_DESTINATION_TOKEN_ACCOUNT }
      : null,
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

/**
 * Build the facilitator a config asks for.
 *
 * `svm` is a THIRD IMPLEMENTATION, not a change to the payment path. `apps/api/src/x402.mjs` takes
 * whatever satisfies `verifyAndSettle(challenge, envelope)`, and it has taken an injected one since
 * it was written, so adding Solana costs the gate nothing. `connection` is injectable for the same
 * reason the EVM clients are: the whole facilitator is testable with no network and no key.
 */
export function facilitatorFromConfig(cfg, { fetchImpl, connection } = {}) {
  if (cfg.facilitatorKind === 'http') return createHttpFacilitator({ url: cfg.facilitatorUrl, fetchImpl });
  if (cfg.facilitatorKind === 'svm') {
    const parsed = keypairFromEnv(cfg.svm?.keypair);
    // Throwing here and not at config time is deliberate: this is the first moment the key is
    // actually needed, and the message says which env var is wrong without ever printing its value.
    if (!parsed.ok) throw new Error(`api: SVM_KEYPAIR could not be read (${parsed.reason})`);
    return createSvmFacilitator({
      connection: connection ?? new Connection(cfg.svm.rpcUrl, 'confirmed'),
      keypair: parsed.keypair,
      destinationTokenAccount: cfg.svm.destinationTokenAccount,
    });
  }
  return createStubFacilitator();
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
  const cap = x402 ?? x402Capability(cfg.network ?? cfg.chainId);
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
        chainId: x402.chainId, network: x402.network, chain: x402.chainName, why: x402.source,
        msg: 'metered routes are served WITHOUT a payment gate on this chain; the per-IP rate limiter covers every route instead.',
      });
      // THE SENTINEL IS `source`, NOT `chainName`. It was `x402.chainName == null`, and `chainName`
      // is OPTIONAL in the network schema -- so a config that matched, parsed and set the capability
      // but happened to omit its display name fired this warn saying no config had matched, while
      // its own `why:` field on the same line quoted the file that did. The two phrases matched here
      // are produced only when an entry was actually read from a file.
    } else if ((cfg.chainId ?? cfg.network) != null && !/sets x402\.enabled|declares no x402 block/.test(x402.source)) {
      // A CHAIN_ID was set and no config matched it. Metering stays on, which is the safe default,
      // but on a chain that means to switch it OFF this is the shape of the failure: the config
      // directory did not ship (see .dockerignore / the Dockerfile COPY). Say so loudly rather
      // than letting a packaging mistake look like a deliberate "still metered".
      log.warn('x402.capability_unresolved', {
        chainId: cfg.chainId, network: cfg.network, why: x402.source,
        msg: 'no config matched CHAIN_ID/NETWORK, so x402 metering is left ON by default. If this chain or network is meant to have it off, contracts/config or config/networks did not reach this runtime.',
      });
    }
    // PRICE_NETWORK AND NETWORK ARE ONE WORD APART AND MEAN DIFFERENT THINGS. `NETWORK` decides
    // whether this server meters at all; `PRICE_NETWORK` is the string the 402 challenge quotes to
    // the client, and the facilitator-server validates the envelope against it. Nothing compared
    // them, so `NETWORK=solana-mainnet` with the shipped `PRICE_NETWORK=base-sepolia` served a
    // Solana-configured API issuing challenges that quoted an EVM network and an EVM USDC address.
    // The gate is correctly ON either way, so this is a warning and not a refusal -- and the same
    // divergence was always reachable through CHAIN_ID, so refusing would break a deployment that
    // has been running.
    if (cfg.network != null && cfg.price.network !== cfg.network) {
      log.warn('x402.network_mismatch', {
        network: cfg.network, priceNetwork: cfg.price.network,
        msg: 'NETWORK and PRICE_NETWORK disagree: the capability was resolved for one network and the 402 challenge quotes another. Clients will be asked to pay on the network PRICE_NETWORK names.',
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
        chainId: x402.chainId, network: x402.network, x402: x402.enabled ? 'metered' : 'off',
        facilitator: cfg.facilitatorKind, cors: cfg.cors, trustProxy: cfg.trustProxy,
        rateLimit: cfg.rateLimit.enabled ? `${cfg.rateLimit.refillPerSec}/s burst ${cfg.rateLimit.capacity}` : 'off',
      });
    });
  }).catch((err) => {
    log.error('startup.failed', { error: String(err?.message ?? err) });
    process.exit(1);
  });
}
