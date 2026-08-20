// @ts-check
/**
 * Metered read API over indexed vault state. Read routes are gated by the x402 payment gate;
 * a small set of routes is free. Uses only Node built-ins (http) — no framework dependency.
 *
 * Routes (all GET):
 *   /health                     free   — liveness + the block being served
 *   /.well-known/x402           free   — discovery document (pricing + route map)
 *   /metrics                    free   — plain-text counters (see metrics.mjs)
 *   /vaults                     paid   — every indexed vault
 *   /vaults/:addr               paid   — vault view (shares, members, capacity, sub-vault links)
 *   /vaults/:addr/members/:m    paid   — one member's position
 *   /operators/leaderboard      paid   — all-vaults-included operator leaderboard (SF-4)
 *
 * HARDENING. The free routes get a per-IP token bucket; the paid ones do not, because
 * **x402 IS the rate limiter** for them — every metered read costs the caller real USDC through a
 * facilitator settlement, so flooding them is a purchase, not a denial-of-service. Method, URL
 * length and request-body size are capped before any work happens. See ratelimit.mjs.
 */

import { createServer } from 'node:http';
import { gate, HEADERS } from './x402.mjs';
import { createMetrics } from './metrics.mjs';
import { clientIp } from './ratelimit.mjs';
import { leaderboard, vaultView, memberPosition, listVaults } from '../../../packages/indexer/src/projections.mjs';

/** Routes served without payment — and therefore the routes the rate limiter guards. */
export const FREE_ROUTES = ['/health', '/.well-known/x402', '/metrics'];

/**
 * Caps applied before any handler work. Deliberately small: this is a GET-only read API, so a
 * request body is already a sign of something wrong, and no legitimate URL here needs 2KB.
 */
export const DEFAULT_LIMITS = {
  maxUrlLength: 2048,
  maxBodyBytes: 8192,
  /** Node's own header cap. The payment-signature envelope is ~1KB of base64, so 16KB is ample. */
  maxHeaderBytes: 16384,
};

/** JSON with bigint support (as decimal strings). */
function jsonStringify(obj) {
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/**
 * @param {Object} deps
 * @param {ReturnType<import('../../../packages/indexer/src/projections.mjs').emptyState>} deps.state
 * @param {import('./x402.mjs').Facilitator} deps.facilitator
 * @param {import('./x402.mjs').PriceSpec} deps.price
 * @param {() => number} [deps.now]
 * @param {boolean} [deps.cors]        emit permissive CORS headers + answer preflight (browser live mode)
 * @param {{take:Function, size?:number}} [deps.rateLimit]
 *        per-IP bucket for the free routes; omitted = no limiting (the default, so existing
 *        in-process callers and tests are unchanged)
 * @param {ReturnType<typeof createMetrics>} [deps.metrics]
 * @param {typeof DEFAULT_LIMITS} [deps.limits]
 * @param {boolean} [deps.trustProxy]  honour x-forwarded-for (only true behind a proxy that sets it)
 * @param {{debug?:Function, info?:Function, warn?:Function, error?:Function}} [deps.log]
 */
export function createApi({ state, facilitator, price, now = () => Date.now(), cors = false, rateLimit = null, metrics = createMetrics(), limits = DEFAULT_LIMITS, trustProxy = false, log = {} }) {
  const seenNonces = new Set();
  const lim = { ...DEFAULT_LIMITS, ...limits };

  metrics.gauge('vault_indexer_last_block', () => state.lastBlock);
  metrics.gauge('vault_api_seen_nonces', () => seenNonces.size);
  if (rateLimit) metrics.gauge('vault_api_rate_limit_buckets', () => rateLimit.size ?? 0);

  const json = (status, headers, body) => ({ status, headers, body: jsonStringify(body) });

  /**
   * @param {string} method
   * @param {string} url
   * @param {Record<string,any>} headers
   * @param {{ip?:string}} [ctx]  request context; positional-compatible with the 3-arg callers
   * @returns {Promise<{status:number, headers:Record<string,string>, body:string}>}
   */
  async function handle(method, url, headers, ctx = {}) {
    metrics.inc('vault_api_requests_total');

    if (method !== 'GET') {
      metrics.inc('vault_api_rejected_total');
      return json(405, {}, { error: 'method not allowed' });
    }
    if (url.length > lim.maxUrlLength) {
      metrics.inc('vault_api_rejected_total');
      return json(414, {}, { error: 'uri too long', limit: lim.maxUrlLength });
    }

    const path = url.split('?')[0];

    // Free routes are cheap and unpriced, which makes them the only thing worth flooding. Bucket
    // them per IP. The metered routes below are NOT bucketed: see the module header.
    if (rateLimit && FREE_ROUTES.includes(path)) {
      const verdict = rateLimit.take(ctx.ip || 'unknown');
      if (!verdict.allowed) {
        metrics.inc('vault_api_rate_limited_total');
        log.warn?.('http.rate_limited', { path, ip: ctx.ip, retryAfterSec: verdict.retryAfterSec });
        return json(429, {
          'retry-after': String(verdict.retryAfterSec),
          'x-ratelimit-limit': String(verdict.limit),
          'x-ratelimit-remaining': '0',
        }, { error: 'rate limit exceeded', retryAfterSec: verdict.retryAfterSec });
      }
    }

    if (path === '/health')
      return json(200, {}, { ok: true, lastBlock: state.lastBlock });

    // Free but rate-limited: an operator scraping this must not be starved of it by a stranger,
    // and a stranger must not find it the cheapest way to load the process.
    if (path === '/metrics')
      return { status: 200, headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }, body: metrics.render() };

    // Free discovery document — agents bootstrap from here (pricing, routes, spec pointer).
    if (path === '/.well-known/x402')
      return json(200, {}, {
        x402Version: 2,
        price: { asset: price.asset, amount: price.amount, payTo: price.payTo, network: price.network },
        routes: {
          free: FREE_ROUTES,
          metered: ['/vaults', '/vaults/{address}', '/vaults/{address}/members/{member}', '/operators/leaderboard'],
        },
        openapi: 'docs/api/openapi.yaml',
        llms: '/llms.txt',
      });

    // Everything else is metered.
    const lc = {};
    for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = v;
    const verdict = await gate({ headers: lc, price, facilitator, nowMs: now(), seenNonces });
    if (verdict.status === 402) {
      metrics.inc('vault_api_payment_required_total');
      return { status: 402, headers: verdict.headers, body: jsonStringify(verdict.body) };
    }
    metrics.inc('vault_api_settlements_total');

    // Paid — resolve the resource.
    const paidHeaders = verdict.headers;
    if (path === '/operators/leaderboard')
      return { status: 200, headers: paidHeaders, body: jsonStringify({ leaderboard: leaderboard(state) }) };

    if (path === '/vaults')
      return { status: 200, headers: paidHeaders, body: jsonStringify({ vaults: listVaults(state) }) };

    const mp = path.match(/^\/vaults\/(0x[0-9a-fA-F]{40})\/members\/(0x[0-9a-fA-F]{40})$/);
    if (mp) {
      // Projection keys are canonical lowercase (see chain.normalizeLog); match the lookup.
      return { status: 200, headers: paidHeaders, body: jsonStringify(memberPosition(state, mp[1].toLowerCase(), mp[2].toLowerCase())) };
    }

    const m = path.match(/^\/vaults\/(0x[0-9a-fA-F]{40})$/);
    if (m) {
      const v = vaultView(state, m[1].toLowerCase());
      if (!v) return { status: 404, headers: paidHeaders, body: jsonStringify({ error: 'unknown vault' }) };
      return { status: 200, headers: paidHeaders, body: jsonStringify(v) };
    }

    return { status: 404, headers: paidHeaders, body: jsonStringify({ error: 'not found' }) };
  }

  // CORS is required for the browser live mode (apps/web ?api=…): a cross-origin fetch cannot see
  // the payment-required/response headers without Expose-Headers, and the paid retry's custom
  // payment-signature header triggers a preflight OPTIONS that must be answered before the method
  // check. Off by default so existing same-process tests are unaffected.
  const corsHeaders = cors
    ? {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': `${HEADERS.REQUIRED}, ${HEADERS.RESPONSE}`,
      }
    : {};

  const server = createServer({ maxHeaderSize: lim.maxHeaderBytes }, (req, res) => {
    if (cors && req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders,
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': `${HEADERS.SIGNATURE}, content-type`,
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    // Body cap, both ways a body can arrive: a declared content-length is refused outright, and an
    // undeclared (chunked) one is cut off at the same ceiling. A GET-only read API has no use for
    // a request body at all, so this only fires on something malformed or hostile.
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > lim.maxBodyBytes) {
      metrics.inc('vault_api_rejected_total');
      res.writeHead(413, { 'content-type': 'application/json', ...corsHeaders });
      res.end(jsonStringify({ error: 'payload too large', limit: lim.maxBodyBytes }));
      return;
    }
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > lim.maxBodyBytes) {
        metrics.inc('vault_api_rejected_total');
        req.destroy();
      }
    });

    handle(req.method ?? 'GET', req.url ?? '/', req.headers, { ip: clientIp(req, { trustProxy }) })
      .then(({ status, headers, body }) => {
        if (res.writableEnded) return;
        res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders, ...headers });
        res.end(body);
      })
      .catch((err) => {
        metrics.inc('vault_api_errors_total');
        log.error?.('http.error', { url: req.url, error: String(err?.message ?? err) });
        if (res.writableEnded) return;
        res.writeHead(500, { 'content-type': 'application/json', ...corsHeaders });
        res.end(jsonStringify({ error: 'internal', detail: String(err?.message ?? err) }));
      });
  });

  return { server, handle, metrics, HEADERS };
}
