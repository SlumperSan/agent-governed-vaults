// @ts-check
/**
 * Log normalization: turn an ABI-decoded viem log into the normalized event that projections.mjs
 * folds. This and rpc.mjs are the only chain-coupled files; the tested projection core carries the
 * logic. `normalizeLog` is pure and unit-tested; the RPC wiring lives in rpc.mjs.
 *
 * Event → normalized-name mapping (matches the Solidity event names the projection relies on):
 *   VaultFactory.VaultCreated; OperatorRegistry.OperatorRegistered / VaultAttested /
 *   RealizationRecorded / FeeRecorded; SubVaultRegistry.ChildRegistered; Governance.Proposed /
 *   Revealed / DefaultApplied / DelegatedRevealed / Finalized / Executed / ProposalExpired;
 *   VaultCore.DepositPending / DepositActivated / PendingCancelled / ExitSettled.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Lowercase anything that is a 20-byte hex address; leave bytes32/nonces/values untouched. */
function canon(v) {
  return typeof v === 'string' && ADDRESS_RE.test(v) ? v.toLowerCase() : v;
}

/**
 * Decode a viem-style log (already matched to an ABI event) into a normalized event.
 *
 * Address canonicalization is load-bearing: viem returns `log.address` lowercased but decoded
 * address ARGS EIP-55 checksummed, so a vault seen via `args.vault` (VaultCreated) and via
 * `log.address` (its own DepositActivated) would key two different Map entries and split the
 * projection. We lowercase every address-shaped value — the emitting `vault` and each arg — so a
 * vault has exactly one canonical key everywhere.
 *
 * `emitter` is always `log.address` — the contract that actually produced the log, the only
 * attribution the RPC itself vouches for. `vault` is the projection key, and the `args.vault`
 * fallback below is only sound for contracts whose code we trust to name a vault truthfully (the
 * factory, the registries, governance, the fee engine, and every VaultCore, all deployed by
 * contracts we control). It is NOT sound for an execution adapter: adapter code is arbitrary —
 * `VaultFactory.createVault` is permissionless and takes a caller-supplied `allowedAdapters`, so
 * anyone can get an adapter of their own into the indexer's polled set and have it emit
 * `SwapExecuted(vault: <someone else's vault>, …)`. Callers polling untrusted code pass
 * `{ attributed: false }`, which leaves `vault` null: the claim survives in `args.vault` for a
 * consumer that wants to VERIFY it, and never silently becomes a projection key.
 *
 * @param {{eventName:string, address:string, blockNumber:bigint|number, logIndex:number, args:Record<string,any>}} log
 * @param {string} [vaultAddress] the emitting vault, when the event is vault-scoped
 * @param {{attributed?:boolean}} [opts] `attributed:false` for logs from untrusted code — `vault`
 *   is left null rather than taken from the emitter's own `vault` argument.
 */
export function normalizeLog(log, vaultAddress, { attributed = true } = {}) {
  const args = {};
  for (const [k, v] of Object.entries(log.args ?? {})) args[k] = canon(v);
  const emitter = canon(log.address);
  const vault = attributed ? canon(vaultAddress ?? args.vault ?? emitter) : null;
  return {
    name: log.eventName,
    vault,
    emitter,
    blockNumber: Number(log.blockNumber),
    logIndex: Number(log.logIndex),
    args,
  };
}

/** Deterministic fold order: (blockNumber, logIndex). daemon.tick applies in returned order. */
export function sortEvents(events) {
  return [...events].sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
}
