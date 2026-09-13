// @ts-check
/**
 * Does the RPC that answered belong to the chain something in this process DECLARED?
 *
 * Issue #204: a component that resolves an RPC by chain and never asks the RPC which chain it
 * actually is prints a verdict, or indexes a projection, computed against a chain nobody named.
 * A result about the wrong chain is worse than no result — it looks authoritative.
 *
 * ## Why this module lives under `packages/` and not under `scripts/`
 *
 * `scripts/lib/chain-binding.mjs` held the first copy of this decision (#278). The indexer, the
 * canary and the reference agent cannot import it: `Dockerfile` copies `packages` and `apps` and
 * does NOT copy `scripts`, so a `../../../scripts/...` import resolves on a developer's checkout
 * and throws MODULE_NOT_FOUND inside the container — the worst possible place to discover it.
 * So the decision moved here, next to `x402.mjs` (already imported cross-package by
 * `apps/api/src/serve.mjs` by relative path), and `scripts/lib/chain-binding.mjs` now re-exports
 * from this file. One implementation, reachable from both sides; two copies of one rule drift, and
 * then neither can be trusted.
 *
 * ## The declared/actual distinction this exists to enforce
 *
 * The defect shape is `createPublicClient({ chain: { id: declaredChainId, ... } }, transport:
 * http(rpcUrl) })`. That asserts the declared id ONTO whatever URL arrived; it never checks it
 * AGAINST the chain the URL answers for. Point `--rpc` at one chain, leave `--chain-id` at its
 * default, and the client — and everything downstream that reads an address through it — believes
 * it is somewhere it is not.
 */

/**
 * Thrown by `assertChainBinding`. A distinct class ON PURPOSE: the indexer's and the canary's
 * per-read error handling is deliberately fault-tolerant ("an RPC hiccup must degrade one field,
 * not crash the loop"), so a plain `Error` thrown from inside a read would be caught, logged as a
 * warning, and the daemon would go on polling the wrong chain — the fix reintroducing the bug it
 * fixes. Callers that catch broadly must re-throw this one.
 */
export class ChainBindingError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ChainBindingError';
  }
}

/**
 * PURE — no RPC call, no file read — so the decision table is unit-testable with no network and no
 * `cast`/`viem` stub.
 *
 * An unreadable chain id (`rpcChainId === null`) refuses exactly like a mismatch: "I could not
 * tell" is not "they match," and every caller of this function is about to read something —
 * an address, a domain separator, a log topic — that means nothing on the wrong chain.
 *
 * @param {{declaredChainId:number|string, rpcChainId:number|null, rpc:string, declaredBy:string}} a
 * @returns {{ok:boolean, message:string}}
 */
export function chainBindingVerdict({ declaredChainId, rpcChainId, rpc, declaredBy }) {
  const want = Number(declaredChainId);
  if (!Number.isInteger(want) || want <= 0) {
    return {
      ok: false,
      message:
        `${declaredBy} declares no usable chain id (${JSON.stringify(declaredChainId)}), so there is ` +
        'nothing to bind the RPC to.',
    };
  }
  if (rpcChainId === null) {
    return {
      ok: false,
      message:
        `could not read the chain id of ${rpc}, so it is UNPROVEN that it is chain ${want} ` +
        `(${declaredBy}). Refusing rather than proceeding: an unproven binding is not a binding.`,
    };
  }
  if (Number(rpcChainId) !== want) {
    return {
      ok: false,
      message:
        `WRONG CHAIN: ${rpc} reports chain id ${rpcChainId}, but ${declaredBy} declares chain ${want}. ` +
        'Refusing rather than proceeding — whatever this run is about to read next is chain-specific, ' +
        'and a result computed against the wrong chain is not a partial answer, it is a meaningless one.',
    };
  }
  return { ok: true, message: `${rpc} is chain ${rpcChainId}, matching ${declaredBy}` };
}

/**
 * Read the chain id through `client` and refuse unless it equals `declaredChainId`.
 *
 * Call this EAGERLY, at startup, before the first poll — not lazily from inside a read. The whole
 * value of the check is that nothing chain-specific happens before it answers.
 *
 * A read that throws is an unreadable id, which refuses; it is never treated as agreement.
 *
 * @param {{client:{getChainId:() => Promise<number|bigint>}, declaredChainId:number|string,
 *          rpc:string, declaredBy:string}} a
 * @returns {Promise<{ok:true, message:string}>} resolves only when bound; throws otherwise
 */
export async function assertChainBinding({ client, declaredChainId, rpc, declaredBy }) {
  /** @type {number|null} */
  let rpcChainId = null;
  try {
    const id = await client.getChainId();
    const n = Number(id);
    rpcChainId = Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    rpcChainId = null; // unreadable — refuses below, exactly like a mismatch
  }
  const verdict = chainBindingVerdict({ declaredChainId, rpcChainId, rpc, declaredBy });
  if (!verdict.ok) throw new ChainBindingError(verdict.message);
  return { ok: true, message: verdict.message };
}
