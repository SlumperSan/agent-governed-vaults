// @ts-check
/**
 * Signal (c) — SHARE CONSERVATION. "Σ sharesOf != totalShares (indexer vs chain read)."
 *
 * Two comparisons against one chain read of VaultCore.totalShares():
 *   projection.totalShares — the folded running total. A mismatch means the indexer missed or
 *     double-counted a DepositActivated / ExitSettled.
 *   Σ projection share book — the per-member balances summed. A mismatch against the folded
 *     total means the projection is internally inconsistent, which is a different bug.
 * Both are reported; either one alerting alerts the signal.
 *
 * THE HEIGHT PROBLEM. The indexer deliberately lags the head by CONFIRMATIONS blocks (reorg
 * safety), so comparing its state against a `latest` chain read guarantees a false alarm every
 * time a deposit or exit lands in the confirmation window. So the chain read is PINNED to the
 * snapshot's own `lastBlock`, which makes the comparison exact rather than approximate.
 *
 * If the RPC cannot serve state at that height (a pruned, non-archive node), the check falls back
 * to `latest` and marks itself unpinned. An unpinned mismatch is racy by construction, so the
 * runner is told to require repeated observations before paging — see `minConsecutive` in
 * transitions.mjs. That keeps the signal alive on a pruned node instead of silently dead, without
 * paging on ordinary indexer lag.
 */

import { VAULT_VIEWS } from '../abis.mjs';
import { ok, alert, skipped, shortAddr } from '../signal.mjs';

export const SIGNAL = 'share-conservation';

/**
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {bigint} ctx.projectedTotalShares  state.vaults.get(vault).totalShares
 * @param {Map<string,bigint>|Iterable<[string,bigint]>} [ctx.shareBook]  state.shares.get(vault)
 * @param {number} [ctx.atBlock]  the snapshot's lastBlock — pins the chain read to the indexer's height
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkShareConservation({ reader, vault, projectedTotalShares, shareBook, atBlock }) {
  let pinned = atBlock != null;
  let res = pinned
    ? await reader.tryRead(vault, VAULT_VIEWS, 'totalShares', [], { blockNumber: atBlock })
    : await reader.tryRead(vault, VAULT_VIEWS, 'totalShares', []);

  if (!res.ok && pinned) {
    // Almost always "missing trie node" / "state unavailable" on a pruned node, not a real fault.
    // DELIBERATELY NOT GATED ON `kind`. Those strings classify as 'transport' (call-error.mjs is
    // explicit that the word means "not a confirmed revert", not "the node was unreachable"), so
    // a `kind !== 'transport'` guard here would disable the archive fallback this retry exists for.
    pinned = false;
    res = await reader.tryRead(vault, VAULT_VIEWS, 'totalShares', []);
  }
  if (!res.ok) {
    return [skipped({
      signal: SIGNAL, vault,
      message: `share conservation skipped on vault ${shortAddr(vault)}: totalShares() is unreadable: ${res.error}`,
      detail: { vault, kind: res.kind ?? null },
    })];
  }

  const onChain = BigInt(res.value);
  const projected = BigInt(projectedTotalShares ?? 0n);
  let bookSum = 0n;
  let holders = 0;
  for (const [, bal] of shareBook ?? []) { bookSum += BigInt(bal); holders += 1; }

  const detail = {
    vault,
    atBlock: pinned ? atBlock : null,
    pinned,
    onChainTotalShares: onChain.toString(),
    projectedTotalShares: projected.toString(),
    shareBookSum: bookSum.toString(),
    holders,
    // The runner requires two consecutive observations before paging an unpinned mismatch,
    // because an unpinned read races the indexer's confirmation lag.
    minConsecutive: pinned ? 1 : 2,
  };
  const where = pinned ? `at block ${atBlock}` : 'at chain head (UNPINNED — the RPC has no archive state at the indexer height)';

  const projDiff = onChain - projected;
  const bookDiff = onChain - bookSum;
  if (projDiff !== 0n || bookDiff !== 0n) {
    const parts = [];
    if (projDiff !== 0n) parts.push(`indexer totalShares ${projected} vs chain ${onChain} (off by ${abs(projDiff)})`);
    if (bookDiff !== 0n) parts.push(`Σ sharesOf over ${holders} holders = ${bookSum} vs chain ${onChain} (off by ${abs(bookDiff)})`);
    return [alert({
      signal: SIGNAL, vault,
      message: `share conservation broken on vault ${shortAddr(vault)} ${where}: ${parts.join('; ')}`,
      measured: `Δ ${abs(projDiff !== 0n ? projDiff : bookDiff)} shares`, threshold: 'exactly 0', detail,
    })];
  }

  return [ok({
    signal: SIGNAL, vault,
    message: `share conservation on vault ${shortAddr(vault)} ${where}: ${onChain} shares across ${holders} holders`,
    measured: 'Δ 0 shares', threshold: 'exactly 0', detail,
  })];
}

const abs = (x) => (x < 0n ? -x : x);
