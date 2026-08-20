// @ts-check
/**
 * Signal (e) — MODULE-CALL FAILURES and IN-KIND ESCROW.
 *
 * `ModuleCallFailed(bytes32 module, address member)` is VaultCore telling you a creator-chosen
 * bookkeeping module misbehaved on the exit path (MO-1). The exit itself still settled — that is
 * the mitigation working — but the module's bookkeeping was FORFEITED. For the feeEngine paths
 * that means an operator's fee accounting silently did not happen, and it is also the leading
 * indicator of the H-1 failure the exit-liveness sentinel watches for.
 *
 * `SliceEscrowed(member, asset, amount)` is the EE-6 / MO-2 escrow path: an in-kind transfer
 * failed, so that asset's slice was set aside as `claimable` instead of reverting the whole
 * redemption. Also the mitigation working, and also worth knowing: a token that keeps failing
 * transfers (blacklist, pause, malformed return) leaves members holding claims, not assets.
 *
 * Neither event is folded by the indexer's projection, which is why the canary reads them itself.
 *
 * SHAPE: this is an OCCURRENCE signal over one poll window, not a level. A burst of events
 * therefore produces exactly two lines — OK→ALERT naming the events, then ALERT→OK on the next
 * quiet window. That is bounded and intentional; the recovery line means "no further failures in
 * the following window", not "the earlier failure was resolved".
 */

import { VAULT_WATCH_EVENTS, decodeModuleLabel } from '../abis.mjs';
import { ok, alert, shortAddr } from '../signal.mjs';

export const SIGNAL = 'module-events';

const MODULE_CALL_FAILED = VAULT_WATCH_EVENTS[0];
const SLICE_ESCROWED = VAULT_WATCH_EVENTS[1];

/**
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {number} ctx.fromBlock
 * @param {number} ctx.toBlock
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkModuleEvents({ reader, vault, fromBlock, toBlock }) {
  const [failures, escrows] = await Promise.all([
    reader.getLogs({ address: vault, event: MODULE_CALL_FAILED, fromBlock, toBlock }),
    reader.getLogs({ address: vault, event: SLICE_ESCROWED, fromBlock, toBlock }),
  ]);

  const window = { vault, fromBlock, toBlock };
  if (failures.length === 0 && escrows.length === 0) {
    return [ok({
      signal: SIGNAL, vault,
      message: `no ModuleCallFailed or SliceEscrowed on vault ${shortAddr(vault)} in blocks ${fromBlock}-${toBlock}`,
      measured: '0 events', threshold: '0 events', detail: window,
    })];
  }

  const failed = failures.map((l) => ({
    module: decodeModuleLabel(l.args?.module),
    member: l.args?.member,
    blockNumber: Number(l.blockNumber),
    txHash: l.transactionHash ?? null,
  }));
  const escrowed = escrows.map((l) => ({
    member: l.args?.member,
    asset: l.args?.asset,
    amount: String(l.args?.amount ?? 0),
    blockNumber: Number(l.blockNumber),
    txHash: l.transactionHash ?? null,
  }));

  const parts = [];
  if (failed.length) {
    const modules = [...new Set(failed.map((f) => f.module))].join(', ');
    parts.push(`${failed.length}x ModuleCallFailed (${modules}; first at block ${failed[0].blockNumber} for member ${shortAddr(failed[0].member)})`);
  }
  if (escrowed.length) {
    const assets = [...new Set(escrowed.map((e) => shortAddr(e.asset)))].join(', ');
    parts.push(`${escrowed.length}x SliceEscrowed (assets ${assets}; first at block ${escrowed[0].blockNumber} for member ${shortAddr(escrowed[0].member)})`);
  }

  return [alert({
    signal: SIGNAL, vault,
    message: `module/escrow failures on vault ${shortAddr(vault)} in blocks ${fromBlock}-${toBlock}: ${parts.join('; ')}`,
    measured: `${failed.length + escrowed.length} events`, threshold: '0 events',
    detail: { ...window, moduleCallFailed: failed, sliceEscrowed: escrowed, threatModelRows: ['MO-1', 'MO-2', 'EE-6'] },
  })];
}
