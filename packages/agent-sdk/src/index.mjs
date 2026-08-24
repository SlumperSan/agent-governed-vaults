// @ts-check
/**
 * Agent SDK for the index-vault protocol's x402-metered API.
 *
 * Environment-agnostic (Node or browser). Give it a `wallet` (address + EIP-712 signer) and a
 * `domain` describing USDC on your chain; the SDK handles the full x402 loop:
 *   request → 402 challenge → EIP-3009 authorization (via your signer) → retry → data.
 *
 * Typed methods mirror the API routes so an agent gets structured data, not raw JSON.
 *
 * @example
 *   import { createProtocolClient } from '@x402-vaults/agent-sdk';
 *   const client = createProtocolClient({
 *     baseUrl: 'https://api.example.xyz',
 *     wallet: { address: '0x…', sign: (td) => walletSignTypedData(td) },
 *     domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
 *   });
 *   const board = await client.leaderboard();     // pays $0.01 over x402 automatically
 */

import { authorizeFromChallenge } from './eip3009.mjs';

const b64 = (obj) => {
  const s = JSON.stringify(obj);
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'utf8').toString('base64');
};

/**
 * @typedef {Object} Wallet
 * @property {string} address
 * @property {(typedData:object) => Promise<string>} sign  EIP-712 signer
 *
 * @typedef {Object} VaultView
 * @property {string} vault
 * @property {string} creator
 * @property {number} operatorId
 * @property {string} totalShares
 * @property {number} memberCount
 * @property {number} pendingCount
 * @property {string|null} parent
 * @property {number} depth
 *
 * @typedef {Object} LeaderboardRow
 * @property {number} operatorId
 * @property {string} operator
 * @property {string} netRealizedUsdc
 * @property {string} lifetimeFeesUsdc
 * @property {number} vaultCount
 */

/**
 * @param {Object} cfg
 * @param {string} cfg.baseUrl
 * @param {Wallet} cfg.wallet
 * @param {{name:string, version:string, chainId:number, verifyingContract:string}} cfg.domain
 * @param {typeof fetch} [cfg.fetchImpl]
 * @param {() => number} [cfg.nowSec]
 * @param {number} [cfg.skewSec]  backdating applied to `validAfter` (see eip3009.authorizeFromChallenge)
 * @param {(payment:{path:string, challenge:object, envelope:object}) => void} [cfg.onPayment]
 *   Observability hook, fired after an authorization is signed and BEFORE the paid retry. Exists
 *   so a caller can record exactly what it paid with — a receipt id alone cannot be replayed,
 *   audited, or re-verified against the chain, but the envelope can. Purely passive: the return
 *   value is ignored and a throw is not caught, so a buggy hook fails loudly rather than silently
 *   dropping a payment that has already been signed.
 */
export function createProtocolClient({ baseUrl, wallet, domain, fetchImpl = fetch, nowSec = () => Math.floor(Date.now() / 1000), skewSec, onPayment }) {
  async function request(path) {
    const url = `${baseUrl}${path}`;
    let res = await fetchImpl(url);
    if (res.status === 402) {
      const challenge = JSON.parse(res.headers.get('payment-required') ?? 'null');
      if (!challenge) throw new ProtocolError('402 without a challenge', 402);
      const envelope = await authorizeFromChallenge({
        challenge,
        walletAddress: wallet.address,
        domain,
        sign: wallet.sign,
        nowSec: nowSec(),
        ...(skewSec === undefined ? {} : { skewSec }),
      });
      onPayment?.({ path, challenge, envelope });
      res = await fetchImpl(url, { headers: { 'payment-signature': b64(envelope) } });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProtocolError(body.error ?? `HTTP ${res.status}`, res.status, body);
    const receipt = res.headers.get('payment-response');
    return { data: body, receipt: receipt ? JSON.parse(receipt) : null };
  }

  return {
    /** Liveness + last indexed block. Free (no payment). */
    async health() {
      return (await request('/health')).data;
    },
    /** @param {string} address @returns {Promise<{data:VaultView, receipt:object|null}>} */
    async getVault(address) {
      return request(`/vaults/${address}`);
    },
    /** @returns {Promise<{data:{leaderboard:LeaderboardRow[]}, receipt:object|null}>} */
    async leaderboard() {
      return request('/operators/leaderboard');
    },
    /** List all known vaults (metered) — the discovery surface. */
    async listVaults() {
      return request('/vaults');
    },
    /** A member's position in a vault (metered). */
    async memberPosition(vault, member) {
      return request(`/vaults/${vault}/members/${member}`);
    },
    /** Free discovery document: pricing, routes, spec pointers. No payment. */
    async discovery() {
      return (await request('/.well-known/x402')).data;
    },
    /** Escape hatch for routes the typed methods don't cover yet. */
    request,
  };
}

export class ProtocolError extends Error {
  /** @param {string} message @param {number} status @param {object} [body] */
  constructor(message, status, body) {
    super(message);
    this.name = 'ProtocolError';
    this.status = status;
    this.body = body;
  }
}

export { authorizeFromChallenge, buildTypedData, buildEnvelope } from './eip3009.mjs';
