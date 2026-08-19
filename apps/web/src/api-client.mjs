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

    const challengeHeader = res.headers.get('payment-required');
    const challenge = challengeHeader ? JSON.parse(challengeHeader) : null;
    if (!challenge) throw new Error('402 without a challenge');

    const envelope = await signer(challenge);
    const sig = btoa(JSON.stringify(envelope));
    res = await fetchImpl(url, { headers: { 'payment-signature': sig } });
    return finish(res, res.headers.get('payment-response'));
  }

  async function finish(res, receipt) {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body });
    return { data: body, receipt: receipt ? JSON.parse(receipt) : null };
  }

  return { get };
}
