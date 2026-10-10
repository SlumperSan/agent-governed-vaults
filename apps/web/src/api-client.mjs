// @ts-check
/**
 * Browser client for the x402-metered API. Implements the 402 → authorize → retry loop:
 *   1. GET the resource.
 *   2. On 402, read the PAYMENT-REQUIRED challenge, ask the injected `signer` to produce an
 *      EIP-3009 authorization envelope for the challenge, base64-encode it.
 *   3. Retry with the PAYMENT-SIGNATURE header; return the resource on 200.
 *
 * The signer is injected (a wallet/agent adapter in prod, a stub in tests) so this module never
 * touches keys directly and stays testable without a wallet.
 *
 * @typedef {(challenge:object) => Promise<object>} Signer  // returns an authorization envelope
 */

/**
 * Decode an x402 header carrying a JSON object, accepting the base64 that
 * `specs/transports-v2/http.md:161-167` requires OR the raw JSON this API emitted before
 * 2026-09-13. Returns null on anything that is neither.
 *
 * THE DISCRIMINATOR IS TOTAL, NOT A HEURISTIC: `{` is not in the base64 alphabet, so a value whose
 * first non-space character is `{` cannot be base64 and IS the legacy raw JSON.
 *
 * This duplicates `packages/agent-sdk/src/header-codec.mjs` on purpose. Everything under
 * `apps/web/src/` is loaded straight into the browser by `apps/web/index.html` and imports nothing
 * outside this directory; a `../../packages/...` specifier would be the one import in this app that
 * depends on where the repository is served from. It also uses `atob`, not `Buffer`, because there
 * is no `Buffer` in a browser — the sibling copy exists precisely because the two runtimes differ.
 * @param {string|null|undefined} header
 */
function decodeHeaderJson(header) {
  if (typeof header !== 'string') return null;
  const raw = header.trim();
  if (raw === '') return null;
  try {
    if (raw.startsWith('{')) return JSON.parse(raw);
    // `atob` gives one byte per char; re-read those bytes as UTF-8 so non-ASCII survives.
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * @param {Object} cfg
 * @param {string} cfg.baseUrl
 * @param {Signer} cfg.signer
 * @param {typeof fetch} [cfg.fetchImpl]
 */
export function createClient({ baseUrl, signer, fetchImpl = fetch }) {
  async function get(path) {
    const url = `${baseUrl}${path}`;
    let res = await fetchImpl(url);
    if (res.status !== 402) return finish(res);

    const challenge = decodeHeaderJson(res.headers.get('payment-required'));
    if (!challenge) throw new Error('402 without a challenge');

    const envelope = await signer(challenge);
    const sig = btoa(JSON.stringify(envelope));
    res = await fetchImpl(url, { headers: { 'payment-signature': sig } });
    return finish(res, res.headers.get('payment-response'));
  }

  async function finish(res, receipt) {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body });
    // Since 2026-09-13 this is a spec §5.3.2 `SettlementResponse` — `{success, transaction,
    // network, payer?}` — carrying `receiptId` and `nonce` alongside, base64-encoded.
    return { data: body, receipt: decodeHeaderJson(receipt) };
  }

  return { get };
}
