// @ts-check
/**
 * Signal (f) — FEE ROUTING. "Any USDC leaving a vault to an operator address outside the
 * FeeEngine claim flow."
 *
 * The invariant (EE-9 / MO-4): performance fees route to the operator ONLY through the FeeEngine —
 * the vault transfers to the engine, the engine credits `claimableFees[operator]`, and the
 * operator calls `claimFees`. Exit fees never route to the operator at all; they accrue to
 * remaining members through the share price. So a USDC transfer straight from a vault to a
 * registered operator address is the shape of a fee leak.
 *
 * WHY THIS IS THE NARROW CHECK. An inverse allowlist — alert on any destination that is not the
 * engine, a member, a child, or an adapter — would fire on ordinary exit payouts to members the
 * indexer has not projected yet, on rebalance transfers to adapters, and on cancelPending
 * refunds. That signal cries wolf and gets muted, which is worse than not having it. This one
 * alerts on the specific destination the threat model prohibits. The broad sweep is available as
 * `informational: true` results, which the runner logs but never pages on.
 *
 * OPERATOR-AS-MEMBER IS LEGITIMATE. EE-9 says so explicitly: an operator who is also a member
 * receives their pro-rata share like anyone else, and the prohibition is on ROUTING, not identity.
 * So a transfer to the operator address is only a leak if it is NOT an exit settlement or a
 * pending-deposit refund. The discriminator is same-block `ExitSettled(member=operator)` or
 * `PendingCancelled(member=operator)` on that vault — cheap, and without it this signal would
 * page every time an honest operator exits their own position.
 */

import { ERC20_TRANSFER_EVENT, EXIT_SETTLED_EVENT, OPERATOR_REGISTRY_VIEWS } from '../abis.mjs';
import { ok, alert, skipped, shortAddr } from '../signal.mjs';

export const SIGNAL = 'fee-routing';

/** PendingCancelled — the other legitimate vault→member USDC outflow (deposit refund). */
const PENDING_CANCELLED = Object.freeze({
  type: 'event', name: 'PendingCancelled', anonymous: false,
  inputs: [
    { name: 'member', type: 'address', indexed: true },
    { name: 'amountUsdc', type: 'uint256', indexed: false },
  ],
});

const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a);

/**
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {string} ctx.usdc                the vault's settlement token
 * @param {string} [ctx.operatorRegistry]  used to resolve this vault's operator address
 * @param {string[]} [ctx.extraOperators]  additional operator addresses to treat as prohibited
 * @param {number} ctx.fromBlock
 * @param {number} ctx.toBlock
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkFeeRouting({ reader, vault, usdc, operatorRegistry, extraOperators = [], fromBlock, toBlock }) {
  const prohibited = new Set(extraOperators.map(lc).filter(Boolean));

  if (operatorRegistry) {
    const idRes = await reader.tryRead(operatorRegistry, OPERATOR_REGISTRY_VIEWS, 'operatorOf', [vault]);
    if (!idRes.ok) {
      return [skipped({
        signal: SIGNAL, vault,
        message: `fee routing skipped on vault ${shortAddr(vault)}: operatorOf() is unreadable on the registry: ${idRes.error}`,
        detail: { vault, operatorRegistry },
      })];
    }
    const opId = BigInt(idRes.value ?? 0);
    if (opId !== 0n) {
      const addrRes = await reader.tryRead(operatorRegistry, OPERATOR_REGISTRY_VIEWS, 'operatorAddressOf', [opId]);
      if (addrRes.ok && addrRes.value) prohibited.add(lc(addrRes.value));
    }
  }

  if (prohibited.size === 0) {
    // An unattested vault (operatorId 0) has no operator to leak to. PX-3 quarantine, not a fee risk.
    return [ok({
      signal: SIGNAL, vault,
      message: `fee routing on vault ${shortAddr(vault)}: no registered operator address to check against (unattested vault)`,
      measured: '0 prohibited destinations', threshold: '0 direct operator transfers', detail: { vault, fromBlock, toBlock },
    })];
  }

  const outflows = await reader.getLogs({
    address: usdc, event: ERC20_TRANSFER_EVENT, args: { from: vault }, fromBlock, toBlock,
  });
  const toOperator = outflows.filter((l) => prohibited.has(lc(l.args?.to)));

  const window = { vault, usdc, fromBlock, toBlock, operatorAddresses: [...prohibited] };
  if (toOperator.length === 0) {
    return [ok({
      signal: SIGNAL, vault,
      message: `fee routing on vault ${shortAddr(vault)}: ${outflows.length} USDC outflow(s) in blocks ${fromBlock}-${toBlock}, none to an operator address`,
      measured: '0 direct operator transfers', threshold: '0 direct operator transfers', detail: window,
    })];
  }

  // EE-9: an operator exiting or cancelling their own member position is legitimate. Only a
  // transfer with no settlement event behind it in the same block is a routing violation.
  const [exits, cancels] = await Promise.all([
    reader.getLogs({ address: vault, event: EXIT_SETTLED_EVENT, fromBlock, toBlock }),
    reader.getLogs({ address: vault, event: PENDING_CANCELLED, fromBlock, toBlock }),
  ]);
  const settled = new Set([...exits, ...cancels].map((l) => `${Number(l.blockNumber)}|${lc(l.args?.member)}`));

  const leaks = toOperator.filter((l) => !settled.has(`${Number(l.blockNumber)}|${lc(l.args?.to)}`));
  const excused = toOperator.length - leaks.length;

  if (leaks.length === 0) {
    return [ok({
      signal: SIGNAL, vault,
      message: `fee routing on vault ${shortAddr(vault)}: ${excused} USDC transfer(s) to the operator address, all matched to an ExitSettled/PendingCancelled in the same block (operator-as-member, EE-9)`,
      measured: '0 direct operator transfers', threshold: '0 direct operator transfers',
      detail: { ...window, excusedAsMemberSettlement: excused },
    })];
  }

  const total = leaks.reduce((s, l) => s + BigInt(l.args?.value ?? 0), 0n);
  const first = leaks[0];
  return [alert({
    signal: SIGNAL, vault,
    message: `FEE ROUTING VIOLATION on vault ${shortAddr(vault)}: ${leaks.length} USDC transfer(s) totalling ${total} base units went directly to operator address ${shortAddr(first.args?.to)} with no ExitSettled/PendingCancelled behind them (first at block ${Number(first.blockNumber)}, tx ${first.transactionHash ?? 'unknown'}) — fees must reach the operator only via FeeEngine.claimFees`,
    measured: `${leaks.length} transfer(s), ${total} USDC base units`, threshold: '0 direct operator transfers',
    detail: {
      ...window,
      excusedAsMemberSettlement: excused,
      transfers: leaks.map((l) => ({
        to: l.args?.to, value: String(l.args?.value ?? 0),
        blockNumber: Number(l.blockNumber), txHash: l.transactionHash ?? null,
      })),
      threatModelRows: ['EE-9', 'MO-4'],
    },
  })];
}
