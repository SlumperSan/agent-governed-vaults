// @ts-check
/**
 * Metered read API over indexed vault state. Read routes are gated by the x402 payment gate;
 * a health route is free. Uses only Node built-ins (http) — no framework dependency.
 *
 * Routes (all GET):
 *   /health                     free
 *   /vaults/:addr               paid — vault view (shares, members, capacity, sub-vault links)
 *   /operators/leaderboard      paid — all-vaults-included operator leaderboard (SF-4)
 */

import { createServer } from 'node:http';
import { gate, HEADERS } from './x402.mjs';
import { leaderboard, vaultView, memberPosition, listVaults } from '../../../packages/indexer/src/projections.mjs';

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
 * @param {boolean} [deps.cors]  emit permissive CORS headers + answer preflight (browser live mode)
 */
export function createApi({ state, facilitator, price, now = () => Date.now(), cors = false }) {
  const seenNonces = new Set();

  /** @returns {Promise<{status:number, headers:Record<string,string>, body:string}>} */
  async function handle(method, url, headers) {
    if (method !== 'GET')
      return { status: 405, headers: {}, body: jsonStringify({ error: 'method not allowed' }) };

    const path = url.split('?')[0];
    if (path === '/health')
      return { status: 200, headers: {}, body: jsonStringify({ ok: true, lastBlock: state.lastBlock }) };

    // Free discovery document — agents bootstrap from here (pricing, routes, spec pointer).
    if (path === '/.well-known/x402')
      return {
        status: 200,
        headers: {},
        body: jsonStringify({
          x402Version: 2,
          price: { asset: price.asset, amount: price.amount, payTo: price.payTo, network: price.network },
          routes: {
            free: ['/health', '/.well-known/x402'],
            metered: ['/vaults', '/vaults/{address}', '/vaults/{address}/members/{member}', '/operators/leaderboard'],
          },
          openapi: 'docs/api/openapi.yaml',
          llms: '/llms.txt',
        }),
      };

    // Everything else is metered.
    const lc = {};
    for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = v;
    const verdict = await gate({ headers: lc, price, facilitator, nowMs: now(), seenNonces });
    if (verdict.status === 402)
      return { status: 402, headers: verdict.headers, body: jsonStringify(verdict.body) };

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

  const server = createServer((req, res) => {
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
    handle(req.method ?? 'GET', req.url ?? '/', req.headers)
      .then(({ status, headers, body }) => {
        res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders, ...headers });
        res.end(body);
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json', ...corsHeaders });
        res.end(jsonStringify({ error: 'internal', detail: String(err?.message ?? err) }));
      });
  });

  return { server, handle, HEADERS };
}
