// @ts-check
/**
 * The narrow JSON-RPC surface the Sign queue's server-side preconditions and receipt
 * verification need: `eth_call`, `eth_getCode`, `eth_chainId`, `eth_getTransactionCount`,
 * `eth_getTransactionByHash`, `eth_getTransactionReceipt`. Every function is read-only — nothing
 * here signs or broadcasts anything, the same discipline `scripts/lib/launch-checks.mjs` already
 * documents at its own header, and this file's `rpcCall` is deliberately the same shape as that
 * one's (fetch, a hard timeout, never throws) so the two cannot disagree about what a failed read
 * looks like.
 *
 * `fetchImpl` is always a parameter, never the bare global — the test suite drives every
 * function here with a stub, so a precondition or a receipt check can be tested without a
 * network.
 */

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * One JSON-RPC call over HTTP. Never throws: every failure — network error, timeout, non-2xx, an
 * unparsable body, a JSON-RPC `error` object, a missing `result` — resolves to `{ok:false,...}`.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} method
 * @param {unknown[]} params
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok:true, result:any}|{ok:false, reason:string}>}
 */
export async function rpcCall(fetchImpl, url, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `${method}: request failed — ${/** @type {Error} */ (e).message}` };
  }
  if (!res.ok) return { ok: false, reason: `${method}: HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, reason: `${method}: response was not JSON — ${/** @type {Error} */ (e).message}` };
  }
  if (body && typeof body === 'object' && body.error) {
    return { ok: false, reason: `${method}: RPC error — ${body.error.message ?? JSON.stringify(body.error)}` };
  }
  if (!body || body.result === undefined) {
    return { ok: false, reason: `${method}: no result in response` };
  }
  return { ok: true, result: body.result };
}

/** `eth_call`. @param {typeof fetch} fetchImpl @param {string} rpcUrl @param {string} to @param {string} data */
export const ethCall = (fetchImpl, rpcUrl, to, data) =>
  rpcCall(fetchImpl, rpcUrl, 'eth_call', [{ to, data }, 'latest']);

/** @param {typeof fetch} fetchImpl @param {string} rpcUrl @param {string} address */
export const ethGetCode = (fetchImpl, rpcUrl, address) =>
  rpcCall(fetchImpl, rpcUrl, 'eth_getCode', [address, 'latest']);

/** @param {typeof fetch} fetchImpl @param {string} rpcUrl */
export const ethChainId = (fetchImpl, rpcUrl) => rpcCall(fetchImpl, rpcUrl, 'eth_chainId', []);

/** The PENDING count — includes a tx still in the mempool, which is the property the nonce gate
 * (`scripts/lib/sign-queue.mjs`'s `nonceGateRefusal`) needs: MetaMask itself also queues off the
 * pending count, so this is the same number it will use to pick the next nonce.
 * @param {typeof fetch} fetchImpl @param {string} rpcUrl @param {string} address */
export const ethGetTransactionCountPending = (fetchImpl, rpcUrl, address) =>
  rpcCall(fetchImpl, rpcUrl, 'eth_getTransactionCount', [address, 'pending']);

/** @param {typeof fetch} fetchImpl @param {string} rpcUrl @param {string} hash */
export const ethGetTransactionByHash = (fetchImpl, rpcUrl, hash) =>
  rpcCall(fetchImpl, rpcUrl, 'eth_getTransactionByHash', [hash]);

/** @param {typeof fetch} fetchImpl @param {string} rpcUrl @param {string} hash */
export const ethGetTransactionReceipt = (fetchImpl, rpcUrl, hash) =>
  rpcCall(fetchImpl, rpcUrl, 'eth_getTransactionReceipt', [hash]);
