// @ts-check
/**
 * Minimal x402 client for reading the soak API's METERED endpoints.
 *
 * IMPORTANT — what this does and does not prove. The soak API runs FACILITATOR=stub, which
 * accepts a well-formed payment envelope WITHOUT settling anything on-chain. So every "paid"
 * read below exercises the 402 challenge → envelope → gate → resource path, and nothing about
 * real settlement. Live x402 settlement is Sprint 14's job (issue #23) and is explicitly out of
 * scope here. The report must say so wherever it quotes an API response, or a reader would
 * reasonably conclude the payment rail was tested end to end. It was not.
 *
 * No key is involved: the stub facilitator never verifies the signature, so the envelope
 * carries a placeholder. Against a real facilitator this would be an EIP-3009 authorization
 * signed by the payer, and this client would not be the right tool.
 */

const BASE = process.env.SOAK_API ?? 'http://localhost:8402';

/**
 * Build a payment envelope that satisfies `checkEnvelopeAgainstPrice` for a given challenge.
 * Mirrors the server's own validation: same asset, recipient and network, value >= amount,
 * and an unexpired authorization.
 * @param {any} challenge the JSON challenge from the 402 response
 */
export function envelopeFor(challenge) {
  return {
    x402Version: 2,
    network: challenge.network,
    // The stub facilitator does not verify this. A real facilitator would require a genuine
    // EIP-3009 signature from the payer, which this read-only client cannot produce.
    signature: '0x' + '00'.repeat(65),
    authorization: {
      asset: challenge.asset,
      to: challenge.payTo,
      value: challenge.amount,
      nonce: challenge.nonce,
      validBefore: Math.floor(Date.now() / 1000) + 300,
    },
  };
}

/**
 * GET a (possibly metered) API path, paying the 402 challenge if one is issued.
 * @param {string} path e.g. '/operators/leaderboard'
 * @returns {Promise<{status:number, body:any, paid:boolean, receipt:string|null}>}
 */
export async function apiGet(path) {
  const url = `${BASE}${path}`;
  const first = await fetch(url);
  if (first.status !== 402) {
    return { status: first.status, body: await first.json().catch(() => null), paid: false, receipt: null };
  }
  const challenge = JSON.parse(first.headers.get('payment-required') ?? (await first.clone().json()).challenge ?? '{}');
  const ch = challenge.scheme ? challenge : (await first.json()).challenge;
  const header = Buffer.from(JSON.stringify(envelopeFor(ch)), 'utf8').toString('base64');
  const paid = await fetch(url, { headers: { 'payment-signature': header } });
  return {
    status: paid.status,
    body: await paid.json().catch(() => null),
    paid: true,
    receipt: paid.headers.get('payment-response'),
  };
}
