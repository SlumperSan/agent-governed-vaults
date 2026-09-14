// @ts-check
/**
 * Base64 JSON decoder for the x402 headers this repository READS.
 *
 * `specs/transports-v2/http.md:161-167` ("Header Summary") specifies `PAYMENT-REQUIRED`,
 * `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` as base64-encoded JSON objects. This API emitted the
 * two outbound ones as raw JSON until 2026-09-13, so every reader in this repository parsed them
 * that way, and a reader that only understands the new encoding cannot talk to a server that has
 * not taken that change yet. `decodeHeaderJson` therefore accepts BOTH, and the four Node-side
 * readers share this one copy of it:
 *
 *   - `./index.mjs` (`createProtocolClient`), for PAYMENT-REQUIRED and PAYMENT-RESPONSE
 *   - `scripts/live-x402-run.mjs`
 *   - `scripts/live-x402-svm-run.mjs`
 *   - `scripts/soak/api-client.mjs`
 *
 * Two sibling copies exist and are deliberate, because neither caller can import this file:
 * `apps/api/src/x402.mjs` is the server and must not depend on the client SDK, and
 * `apps/web/src/api-client.mjs` is browser code loaded directly by `apps/web/index.html`, which
 * imports nothing outside `apps/web/src/`. Both cite this module and this spec line range.
 *
 * Environment-agnostic, like the rest of this package: `atob` where the runtime has it (browsers,
 * and Node since 16), `Buffer` otherwise. Decode only — the one header this package WRITES,
 * `PAYMENT-SIGNATURE`, has always been base64 and `index.mjs` already has its own encoder for it.
 */

/**
 * Decode an x402 header carrying a JSON object, accepting the spec's base64 OR the raw JSON this
 * repo emitted before 2026-09-13. Returns null on anything that is neither.
 *
 * THE DISCRIMINATOR IS TOTAL, NOT A HEURISTIC. `{` is not in the base64 alphabet, so a value whose
 * first non-space character is `{` cannot be base64 and IS the legacy raw JSON; everything else
 * takes the base64 branch. These headers have only ever carried a JSON *object*, so the two cases
 * are exhaustive. Sniffing the other way round does not work in Node: its base64 decoder silently
 * DROPS characters outside the alphabet rather than throwing, so `Buffer.from('{"a":1}','base64')`
 * yields garbage instead of failing and a "try base64, fall back on throw" reader never reaches
 * its fallback.
 *
 * @param {string|null|undefined} header
 * @returns {any|null}
 */
export function decodeHeaderJson(header) {
  if (typeof header !== 'string') return null;
  const raw = header.trim();
  if (raw === '') return null;
  try {
    return JSON.parse(raw.startsWith('{') ? raw : b64ToUtf8(raw));
  } catch {
    return null;
  }
}

/** base64 -> UTF-8 text. `atob` yields one byte per char, so the bytes are re-decoded as UTF-8. */
function b64ToUtf8(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  return Buffer.from(b64, 'base64').toString('utf8');
}
