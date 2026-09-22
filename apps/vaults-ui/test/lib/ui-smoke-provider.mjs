// @ts-check
/**
 * A generic EIP-1193 provider for card 176's UI smoke harness — NOT a reimplementation of
 * deposit/vote/exit. This file knows nothing about VaultCore, Governance, or what a "deposit" is;
 * it only knows the standard wallet RPC methods (`eth_requestAccounts`, `eth_sendTransaction`,
 * `personal_sign`, ...), which is exactly the surface a real MetaMask/Rabby extension exposes to
 * `apps/vaults-ui/src/lib/wallet.tsx`'s `custom()` transport. `chain-actions.ts` and the viem
 * `walletClient`/`publicClient` built from this provider are the REAL app code — this file plays
 * the role the browser extension plays, nothing more.
 *
 * Every request is logged (method, params, and the result once it resolves) BEFORE being
 * dispatched, so `ui-smoke-assertions.mjs` can verify call ORDER (e.g. "an eth_call preceded every
 * eth_sendTransaction") and content (exact args, not a max-uint approval) after the fact.
 *
 * SENDS AND SIGNATURES ARE REAL. `eth_sendTransaction` is signed and broadcast by a real viem
 * `WalletClient` over `account` (a throwaway private key generated for this test run — never the
 * owner's, never funded beyond what `ui-smoke-chain.mjs` gives it on a local anvil) against the
 * anvil RPC this provider forwards everything else to. Nothing here signs against, or sends to,
 * any chain other than the `rpcUrl` passed in.
 */
import { createWalletClient, http, isHex } from 'viem';

/** @typedef {{ method: string, params: unknown, at: number, result?: unknown, error?: string }} LogEntry */

/** Minimal JSON-RPC POST — no client library needed for a pass-through read.
 *
 * ON ERROR, THE SHAPE MATTERS. `simulateThenWrite`'s revert decoding (`describeRevert` in
 * chain-actions.ts) walks the thrown error looking for a `data` field holding the raw revert bytes
 * to match against `KNOWN_ERRORS_ABI` — that is how it turns a bare selector into "PendingExists"
 * instead of an opaque hex string. A plain `Error(message)` loses that field even though the RPC
 * response carried it, which would make every real revert this harness triggers come back
 * UNNAMED — silently defeating the one property `simulate-before-sign.test.mjs` and this harness
 * both exist to prove. So the JSON-RPC error's `code`/`data` are preserved on the thrown error,
 * the same shape a real EIP-1193 provider error carries.
 */
async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
  });
  const body = await res.json();
  if (body.error) {
    const err = new Error(body.error.message);
    err.code = body.error.code;
    if (body.error.data !== undefined) err.data = body.error.data;
    throw err;
  }
  return body.result;
}

/** True for a 0x-hex string of typical tx-data/message length; false for a 20-byte address. Used
 * to order-independently split `personal_sign`'s two params (wallets disagree on the order). */
const looksLikeAddress = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

/**
 * @param {object} opts
 * @param {string} opts.rpcUrl
 * @param {import('viem').Account} opts.account
 * @param {number} [opts.chainIdOverride] MUTATION HOOK: report a chain id other than the real one
 *   from `eth_chainId`, without touching a single line of `wallet.tsx`/`chain-actions.ts`. Proves
 *   `simulateThenWrite`'s `chain: TARGET_CHAIN` viem argument actually rejects a mismatched wallet
 *   rather than trusting it.
 * @returns {{ provider: import('viem').EIP1193Provider, log: LogEntry[] }}
 */
export function createRecordingProvider({ rpcUrl, account, chainIdOverride }) {
  /** @type {LogEntry[]} */
  const log = [];
  const signer = createWalletClient({ account, transport: http(rpcUrl) });

  async function request({ method, params }) {
    /** @type {LogEntry} */
    const entry = { method, params: params ?? null, at: Date.now() };
    log.push(entry);
    try {
      const result = await dispatch(method, params);
      entry.result = result;
      return result;
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address];

      case 'eth_chainId': {
        if (chainIdOverride !== undefined) return `0x${chainIdOverride.toString(16)}`;
        return rpcCall(rpcUrl, 'eth_chainId', []);
      }

      case 'eth_sendTransaction': {
        const tx = /** @type {{to?: `0x${string}`, data?: `0x${string}`, value?: `0x${string}`, from?: string}} */ (
          Array.isArray(params) ? params[0] : undefined
        );
        if (!tx) throw new Error('eth_sendTransaction: no transaction object in params');
        return signer.sendTransaction({
          account,
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
        });
      }

      case 'personal_sign':
      case 'eth_sign': {
        const arr = Array.isArray(params) ? params : [];
        const data = arr.find((p) => isHex(p) && !looksLikeAddress(p));
        if (!isHex(data)) throw new Error(`${method}: could not find hex message data in params ${JSON.stringify(params)}`);
        return account.signMessage({ message: { raw: data } });
      }

      // Every plain read (eth_call, eth_getTransactionReceipt, eth_blockNumber,
      // eth_getTransactionCount, eth_estimateGas, eth_gasPrice, eth_getCode, ...) is a pure
      // pass-through — this provider never answers a read on its own, so a viem `simulateContract`
      // eth_call always reaches the real anvil node and real deployed bytecode.
      default:
        return rpcCall(rpcUrl, method, params);
    }
  }

  return { provider: { request, on() {}, removeListener() {} }, log };
}
