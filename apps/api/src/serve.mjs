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
 *   FACILITATOR (stub | http)   FACILITATOR_URL (required when FACILITATOR=http)
 *   CORS (1 to enable — needed for the browser live mode)
 *
 * Run: `PRICE_ASSET=… PRICE_PAYTO=… node apps/api/src/serve.mjs`
 */

import { fileURLToPath } from 'node:url';
import { createApi } from './server.mjs';
import { createHttpFacilitator, createStubFacilitator } from './facilitator.mjs';
import { loadSnapshot } from '../../../packages/indexer/src/store.mjs';

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
  return {
    statePath: env.STATE_PATH || './data/indexer-state.json',
    port: num('PORT', 8402),
    reloadMs: num('RELOAD_MS', 5000),
    cors: env.CORS === '1' || env.CORS === 'true',
    price: {
      asset: env.PRICE_ASSET,
      amount: env.PRICE_AMOUNT || '10000',
      payTo: env.PRICE_PAYTO,
      network: env.PRICE_NETWORK || 'base',
    },
    facilitatorKind: facilitator,
    facilitatorUrl: env.FACILITATOR_URL,
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
 * @param {ReturnType<typeof resolveApiConfig>} cfg
 * @param {{facilitator?:object, log?:(m:string)=>void}} [opts]
 */
export async function buildApiServer(cfg, { facilitator, log = console.log } = {}) {
  const state = await loadSnapshot(cfg.statePath);
  const fac = facilitator ?? facilitatorFromConfig(cfg);
  const api = createApi({ state, facilitator: fac, price: cfg.price, cors: cfg.cors });

  async function reload() {
    try {
      const fresh = await loadSnapshot(cfg.statePath);
      // Replace the Map/scalar fields on the SAME object the API closes over.
      Object.assign(state, fresh);
      return true;
    } catch (err) {
      log(`api: snapshot reload failed, keeping stale state at block ${state.lastBlock}: ${err?.message ?? err}`);
      return false;
    }
  }

  return { api, state, reload };
}

// ── entrypoint ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cfg = resolveApiConfig(process.env);
  buildApiServer(cfg).then(({ api, state, reload }) => {
    if (cfg.facilitatorKind === 'stub') {
      console.warn('⚠ api: FACILITATOR=stub — payments are ACCEPTED WITHOUT on-chain settlement (dev only). Set FACILITATOR=http + FACILITATOR_URL for production.');
    }
    const timer = setInterval(reload, cfg.reloadMs);
    if (typeof timer.unref === 'function') timer.unref();
    api.server.listen(cfg.port, () => {
      console.log(`api: listening on :${cfg.port} — snapshot ${cfg.statePath} (block ${state.lastBlock}), reload ${cfg.reloadMs}ms, facilitator ${cfg.facilitatorKind}${cfg.cors ? ', cors on' : ''}`);
    });
  }).catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
