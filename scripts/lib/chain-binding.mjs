// @ts-check
/**
 * Shared pure decision: does the RPC that answered belong to the chain something in THIS run
 * declared? PURE — no RPC call, no file read — so the decision table is unit-testable with no
 * network and no `cast`/`viem` stub.
 *
 * Reused by `scripts/verify-mainnet-config.mjs` and `scripts/live-x402-run.mjs` (issue #204: a
 * script that resolves an RPC by chain and never asks the RPC which chain it actually is prints a
 * verdict computed against a chain nobody named. A verdict about the wrong chain is worse than no
 * verdict — it looks authoritative).
 *
 * ## Same shape as `chainBindingVerdict` in `scripts/verify-chainlink-oracle.mjs` (#205) —
 * deliberately NOT imported from there
 *
 * That file is a script, not a library: its top level reads a config path off `process.env.CONFIG`
 * (default `contracts/config/base-mainnet.json`) and can `process.exit(1)` on `import` alone if no
 * default RPC resolves for THAT config's `chainId`. Importing it just to reach one pure function
 * would run side effects neither caller here wants, and a `CONFIG` left set in a shell from an
 * oracle-verification session would silently change which file the import reads. It is also a file
 * this change does not own — open PR #185 is mid-flight on it. A future cleanup that extracts one
 * shared module and points `verify-chainlink-oracle.mjs` at it too is left as a follow-up rather
 * than done here, since it would require editing that file.
 *
 * An unreadable chain id (`rpcChainId === null`) refuses exactly like a mismatch: "I could not
 * tell" is not "they match," and every caller of this function is about to read something —
 * an address, a domain separator — that means nothing on the wrong chain.
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
