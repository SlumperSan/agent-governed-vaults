// @ts-check
/**
 * Production chain adapter: turns on-chain logs into the normalized events that projections.mjs
 * folds. This is the ONLY chain-coupled file; it is not unit-tested (it needs a live RPC).
 * Kept deliberately thin so the tested core (projections) carries the logic.
 *
 * Uses viem when installed; falls back to a clear error otherwise. Wire it from a runner that
 * polls `getLogs` from the factory + known vault addresses and feeds `apply()`.
 *
 * Event → normalized-name mapping (matches the Solidity event names the API relies on):
 *   VaultFactory.VaultCreated, OperatorRegistry.OperatorRegistered / VaultAttested /
 *   RealizationRecorded / FeeRecorded, SubVaultRegistry.ChildRegistered,
 *   VaultCore.DepositPending / DepositActivated / PendingCancelled / ExitSettled.
 */

/**
 * Decode a viem-style log (already matched to an ABI event) into a normalized event.
 * @param {{eventName:string, address:string, blockNumber:bigint, logIndex:number, args:Record<string,any>}} log
 * @param {string} [vaultAddress] the emitting vault, when the event is vault-scoped
 */
export function normalizeLog(log, vaultAddress) {
  const args = {};
  for (const [k, v] of Object.entries(log.args ?? {})) {
    args[k] = typeof v === 'bigint' ? v : v;
  }
  return {
    name: log.eventName,
    vault: vaultAddress ?? args.vault ?? log.address,
    blockNumber: Number(log.blockNumber),
    logIndex: log.logIndex,
    args,
  };
}

/**
 * Create a poller that reads new logs and applies them to `state`. `client` is a viem
 * PublicClient; `contracts` maps a label to { address, abi }. Caller supplies the apply fn.
 *
 * Returns an async `poll(fromBlock, toBlock)` — schedule it however you like (setInterval, a
 * cron, or the harness). Left as a factory so tests can drive it with a fake client.
 *
 * @param {Object} cfg
 * @param {any} cfg.client
 * @param {Array<{address:string, abi:any[]}>} cfg.sources
 * @param {(evt:import('./projections.mjs').Event) => void} cfg.onEvent
 */
export function createPoller({ client, sources, onEvent }) {
  return async function poll(fromBlock, toBlock) {
    for (const src of sources) {
      const logs = await client.getLogs({
        address: src.address,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      });
      for (const log of logs) {
        // Assumes the caller passed an ABI-aware client that populates eventName/args.
        if (!log.eventName) continue;
        onEvent(normalizeLog(log));
      }
    }
  };
}
