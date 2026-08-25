#!/usr/bin/env node
// @ts-check
/**
 * The remote settling facilitator, as an HTTP service.
 *
 * This is the piece that was missing between the two halves the repo already had:
 * `createHttpFacilitator` (API side — POSTs a challenge + envelope to a URL, stays keyless) and
 * `createSettlingFacilitator` (chain side — recovers the payer and broadcasts
 * `transferWithAuthorization`). Nothing spoke the wire protocol between them. This does.
 *
 *   API server ──POST {x402Version, challenge, envelope}──► facilitator-server ──► USDC on chain
 *              ◄──────── {ok, receiptId} | {ok:false, reason} ────────
 *
 * ## Why this is a separate process
 *
 * It is the only component in the system that holds a key. The API server and the indexer stay
 * keyless and non-custodial (docs/RUNTIME.md §7); putting the settler behind an HTTP boundary is
 * what makes that true rather than aspirational. Run it isolated, on a host you control, and
 * expose it only to your API.
 *
 * ## What it refuses to do
 *
 * - **Start without consent.** Mirrors the reference agent's execute gate (`config.mjs gateMode`):
 *   an injected account AND `FACILITATOR_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes`. Missing either is a
 *   hard refusal, never a downgrade to a dry-run mode — a silent fallback teaches an operator that
 *   the env var is optional, and the one time it mattered they would be wrong.
 * - **Start with a domain it cannot prove.** `assertUsdcDomain` reads the token's real
 *   `name()`/`version()` and checks the recomputed EIP-712 separator against the token's own
 *   `DOMAIN_SEPARATOR()`. A mismatch means no signature will ever recover; that is a startup
 *   failure, not a per-request mystery.
 * - **Take a private key.** It accepts a viem *account object*, injected by the operator's own
 *   runner. It does not read a key from env, does not read a keystore, and never logs one.
 * - **Trust the caller's price.** See `checkChallengePrice` below.
 *
 * ## Wire contract
 *
 * Request  `POST /settle` (also accepted at `/`) — `{ x402Version: 2, challenge, envelope }`
 * Response `200 {ok:true, receiptId}` on settlement; `200 {ok:false, reason}` for a payment that
 *          was understood and rejected; `4xx {ok:false, reason}` for a malformed request. The
 *          distinction matters: `createHttpFacilitator` maps a non-2xx to `facilitator-http-<n>`
 *          and loses the reason, so anything the payer could fix must come back as a 200.
 * Also     `GET /health` — liveness plus the settler address and the verified domain.
 *
 * Run it from a runner you own (see scripts/live-x402-run.mjs), not from this file directly:
 * this module exports `startFacilitatorServer` and never builds an account itself.
 */

import { createServer } from 'node:http';
import { createSettlingFacilitator, assertUsdcDomain } from './facilitator.mjs';

export const CONSENT_ENV_VAR = 'FACILITATOR_I_UNDERSTAND_THIS_SPENDS_FUNDS';
export const CONSENT_ENV_VALUE = 'yes';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_BODY_BYTES = 64 * 1024;

/** Thrown for operator-facing misconfiguration; carries no request data. */
export class FacilitatorConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FacilitatorConfigError';
  }
}

/**
 * The consent gate. Deliberately identical in spirit to the reference agent's `gateMode`: both
 * conditions or nothing, and the failure names every problem at once so an operator fixes them in
 * one pass instead of discovering them one restart at a time.
 *
 * @param {{account?:any, env?:Record<string,string|undefined>}} p
 */
export function gateSettlement({ account = null, env = {} }) {
  const problems = [];
  if (!account || typeof account.address !== 'string')
    problems.push('no viem account was injected (the facilitator signs transactions — pass `account`, an account object, never a private key)');
  if (env[CONSENT_ENV_VAR] !== CONSENT_ENV_VALUE)
    problems.push(`${CONSENT_ENV_VAR} is not set to "${CONSENT_ENV_VALUE}"`);

  if (problems.length)
    throw new FacilitatorConfigError(
      'refusing to start the settling facilitator:\n  - ' +
        problems.join('\n  - ') +
        '\nThis process broadcasts USDC transfers and pays gas from a real account. Fix every ' +
        'condition above; there is no reduced mode to fall back to.',
    );
  return { consented: true, settler: account.address };
}

/**
 * Defense in depth: re-check the payment against the challenge the *caller* posted, server-side.
 *
 * The API already runs `checkEnvelopeAgainstPrice` before it ever calls us. This repeats the check
 * on the settling side on purpose, because the two checks defend different things. The API's check
 * protects the API from a lying payer. This one protects the *funded account* from a lying API —
 * or from a compromised one, a misrouted request, or simply a second tenant pointed at the same
 * facilitator by mistake. The facilitator is the only party here that spends gas, and it is the
 * last place that can still say no.
 *
 * Concretely it stops a settlement whose recipient or amount does not match what the caller says
 * it charged for. Without it, this service is an open relay: anyone who can reach it can have it
 * broadcast any signed authorization they have obtained, to any recipient, at the operator's gas
 * expense. Flagged in review on PR #6.
 *
 * Note the shape: `x402.mjs gate()` invokes `verifyAndSettle({ price }, envelope)`, so the
 * `challenge` on the wire is `{ price: {asset, amount, payTo, network} }` — not the PAYMENT-REQUIRED
 * challenge document. We read `challenge.price`, tolerate a flattened challenge for robustness, and
 * skip only when no price was supplied at all.
 *
 * @param {object|undefined} challenge  the posted challenge (`{price}` per x402.mjs)
 * @param {object} envelope
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkChallengePrice(challenge, envelope) {
  const price = challenge?.price ?? (challenge?.payTo || challenge?.amount ? challenge : null);
  // FAIL CLOSED. This used to return ok when no challenge was posted ("nothing asserted →
  // nothing to contradict"), which made the re-check opt-out by omission: POST /settle with the
  // challenge field simply absent skipped the only server-side price/recipient binding and went
  // straight to broadcast at the operator's gas expense — the open relay this check exists to
  // prevent. The API always posts a challenge, so the only caller this refuses is one bypassing
  // the API. Flagged in PR #27's review; closed here for launch.
  if (!price) return { ok: false, reason: 'no-challenge' };
  const auth = envelope?.authorization ?? {};

  if (price.payTo != null) {
    if (!ADDR_RE.test(String(price.payTo))) return { ok: false, reason: 'challenge-bad-payTo' };
    if (String(auth.to ?? '').toLowerCase() !== String(price.payTo).toLowerCase())
      return { ok: false, reason: 'recipient-mismatch' };
  }
  if (price.asset != null && String(auth.asset ?? '').toLowerCase() !== String(price.asset).toLowerCase())
    return { ok: false, reason: 'asset-mismatch' };
  if (price.network != null && String(envelope?.network ?? '').toLowerCase() !== String(price.network).toLowerCase())
    return { ok: false, reason: 'network-mismatch' };
  if (price.amount != null) {
    let want, got;
    try {
      want = BigInt(price.amount);
      got = BigInt(auth.value ?? '');
    } catch {
      return { ok: false, reason: 'bad-value' };
    }
    // Underpaid is the attack; overpaid is the payer's own choice and the API already allowed it.
    if (got < want) return { ok: false, reason: 'underpaid' };
  }
  return { ok: true };
}

/**
 * Validate the POST body shape before anything touches a chain client.
 * @param {any} body
 * @returns {{ok:true, challenge:object|undefined, envelope:object}|{ok:false, reason:string}}
 */
export function parseSettleRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'bad-request-body' };
  if (body.x402Version !== 2) return { ok: false, reason: 'unsupported-x402-version' };
  if (!body.envelope || typeof body.envelope !== 'object') return { ok: false, reason: 'no-envelope' };
  return { ok: true, challenge: body.challenge, envelope: body.envelope };
}

/**
 * The request handler, independent of node:http so it is directly unit-testable.
 * @param {{facilitator:{verifyAndSettle:Function}, log?:(m:string)=>void, health?:() => object}} deps
 */
export function createSettleHandler({ facilitator, log = () => {}, health = () => ({}) }) {
  /**
   * @param {string} method
   * @param {string} url
   * @param {any} body  already-parsed JSON (or undefined)
   * @returns {Promise<{status:number, body:object}>}
   */
  return async function handle(method, url, body) {
    const path = (url || '/').split('?')[0];

    if (method === 'GET' && path === '/health')
      return { status: 200, body: { ok: true, ...health() } };

    if (method !== 'POST') return { status: 405, body: { ok: false, reason: 'method-not-allowed' } };
    if (path !== '/' && path !== '/settle')
      return { status: 404, body: { ok: false, reason: 'not-found' } };

    const parsed = parseSettleRequest(body);
    if (!parsed.ok) return { status: 400, body: { ok: false, reason: parsed.reason } };

    // Server-side price re-check BEFORE we spend anything (see checkChallengePrice). A rejection
    // here is a 200 with ok:false: the request was well-formed, the payment was not acceptable.
    const priceCheck = checkChallengePrice(parsed.challenge, parsed.envelope);
    if (!priceCheck.ok) {
      log(`facilitator: rejected settlement — ${priceCheck.reason}`);
      return { status: 200, body: { ok: false, reason: priceCheck.reason } };
    }

    try {
      const result = await facilitator.verifyAndSettle(parsed.challenge ?? {}, parsed.envelope);
      if (result?.ok) {
        log(`facilitator: settled — ${result.receiptId}`);
        return { status: 200, body: { ok: true, receiptId: result.receiptId } };
      }
      log(`facilitator: not settled — ${result?.reason ?? 'unknown'}`);
      return { status: 200, body: { ok: false, reason: result?.reason ?? 'unknown' } };
    } catch (err) {
      // An unexpected throw is ours, not the payer's. Surface a generic reason and log the detail:
      // the caller is a payer, and errors from a signing process are a disclosure surface.
      log(`facilitator: settle threw — ${err?.stack ?? err?.message ?? err}`);
      return { status: 500, body: { ok: false, reason: 'facilitator-internal-error' } };
    }
  };
}

/** Read a request body with a hard size cap, then JSON.parse. Resolves `undefined` on bad JSON. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * Build (and optionally listen on) the facilitator service.
 *
 * The operator injects `account`, `publicClient` and `walletClient` — this function creates no key
 * material and reads none from the environment. Startup order is deliberate: consent gate first
 * (cheapest, and the one an operator most often trips), then the on-chain domain proof, then
 * listen. Nothing binds a port until both hold.
 *
 * @param {Object} cfg
 * @param {any} cfg.account          viem account (the settler; pays gas)
 * @param {any} cfg.publicClient     viem PublicClient
 * @param {any} cfg.walletClient     viem WalletClient
 * @param {string} cfg.usdcAddress
 * @param {number} cfg.chainId
 * @param {number} [cfg.port]
 * @param {string} [cfg.host]        default 127.0.0.1 — do NOT bind 0.0.0.0 without a firewall
 * @param {Record<string,string|undefined>} [cfg.env]
 * @param {(m:string)=>void} [cfg.log]
 * @param {boolean} [cfg.listen]     default true
 */
export async function startFacilitatorServer({
  account, publicClient, walletClient, usdcAddress, chainId,
  port = 8403, host = '127.0.0.1', env = process.env, log = console.log, listen = true,
}) {
  gateSettlement({ account, env });
  if (!ADDR_RE.test(usdcAddress ?? '')) throw new FacilitatorConfigError('facilitator-server: usdcAddress required');
  if (!Number.isInteger(chainId)) throw new FacilitatorConfigError('facilitator-server: chainId required');

  // Prove the EIP-712 domain against the token itself before accepting a single request.
  const domain = await assertUsdcDomain({ publicClient, usdcAddress, chainId });
  log(
    `facilitator: USDC domain verified on-chain — name=${JSON.stringify(domain.name)} ` +
      `version=${JSON.stringify(domain.version)} separator=${domain.onChainSeparator}`,
  );

  const facilitator = createSettlingFacilitator({
    publicClient, walletClient, usdcAddress, chainId,
    usdcName: domain.name, usdcVersion: domain.version,
  });

  const health = () => ({
    settler: account.address,
    chainId,
    usdc: usdcAddress,
    domain: { name: domain.name, version: domain.version, separator: domain.onChainSeparator },
  });
  const handle = createSettleHandler({ facilitator, log, health });

  const server = createServer((req, res) => {
    readJsonBody(req)
      .then((body) => handle(req.method ?? 'GET', req.url ?? '/', body))
      .catch((err) => ({
        status: err?.message === 'body-too-large' ? 413 : 400,
        body: { ok: false, reason: err?.message === 'body-too-large' ? 'body-too-large' : 'bad-request' },
      }))
      .then(({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
  });

  if (listen) {
    await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
    log(`facilitator: listening on http://${host}:${port} — settler ${account.address}, chain ${chainId}`);
  }

  return {
    server,
    handle,
    facilitator,
    domain,
    settler: account.address,
    url: `http://${host}:${port}/settle`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
