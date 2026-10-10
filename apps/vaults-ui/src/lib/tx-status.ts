/**
 * What a signed write's hash does and does not prove. `walletClient.writeContract` resolves the
 * moment the wallet has BROADCAST the transaction; it says nothing about whether it was mined, and
 * nothing about whether it succeeded. A transaction can pass `simulateThenWrite`'s pre-flight and
 * still revert on chain (state moved between the simulation and the block), and a mined revert
 * still pays gas. So a member-facing success line must wait for a receipt and read its `status`.
 *
 * `confirmTx` is the one place that decides it. It has no imports beyond types, so
 * `test/tx-status.test.mjs` runs it directly under `node --test` against a fake client.
 *
 * Four outcomes, and `unconfirmed` is deliberately not `reverted`: a receipt wait that threw
 * (RPC down, wait timed out) is evidence of nothing about the transaction itself, so it must not
 * render as a failure any more than as a success.
 *
 * `replaced` is the wallet's cancel or speed-up. viem's `waitForTransactionReceipt` follows a
 * same-nonce replacement and resolves with the REPLACEMENT's receipt, so a receipt in hand is not
 * proof it belongs to the hash that was waited on. `confirmTx` therefore compares
 * `receipt.transactionHash` to `hash`. A different hash counts as the member's own action only
 * when viem reported `repriced` AND the replacement is demonstrably the same call (same sender,
 * `to`, `value` and `input` as the replaced transaction) AND its hash is the receipt's. A
 * `cancelled` or `replaced` transaction, or a mismatch nothing explains, is `replaced`: the
 * original did not run as sent, so nothing is confirmed.
 */
export type TxOutcome =
  | { readonly state: 'confirmed'; readonly hash: `0x${string}` }
  | { readonly state: 'reverted'; readonly hash: `0x${string}` }
  | { readonly state: 'replaced'; readonly reason: string }
  | { readonly state: 'unconfirmed'; readonly detail: string };

interface TxLike {
  readonly hash: string;
  readonly from?: string;
  readonly to?: string | null;
  readonly value?: bigint;
  readonly input?: string;
}

interface Replacement {
  readonly reason: string;
  readonly replacedTransaction: TxLike;
  readonly transaction: TxLike;
}

interface ReceiptWaiter {
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
    onReplaced?: (r: Replacement) => void;
  }): Promise<{ readonly status: string; readonly transactionHash: string }>;
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** True only when the replacement is the same call re-sent at a higher price. Not taken from
 * viem's `reason` alone: the fields are compared here. */
function isSameCall(r: Replacement): boolean {
  const o = r.replacedTransaction;
  const n = r.transaction;
  return (
    r.reason === 'repriced' &&
    same(o.from, n.from) &&
    same(o.to, n.to) &&
    o.value === n.value &&
    same(o.input, n.input)
  );
}

export async function confirmTx(client: ReceiptWaiter, hash: `0x${string}`): Promise<TxOutcome> {
  let replacement: Replacement | undefined;
  let receipt: { readonly status: string; readonly transactionHash: string };
  try {
    receipt = await client.waitForTransactionReceipt({ hash, onReplaced: (r) => { replacement = r; } });
  } catch (e) {
    return { state: 'unconfirmed', detail: e instanceof Error ? e.message : String(e) };
  }
  let mined = hash;
  if (!same(receipt.transactionHash, hash)) {
    if (!replacement || !isSameCall(replacement) || !same(replacement.transaction.hash, receipt.transactionHash)) {
      return { state: 'replaced', reason: replacement?.reason ?? 'unknown' };
    }
    mined = receipt.transactionHash as `0x${string}`;
  }
  if (receipt.status === 'success') return { state: 'confirmed', hash: mined };
  if (receipt.status === 'reverted') return { state: 'reverted', hash: mined };
  return { state: 'unconfirmed', detail: `unexpected receipt status '${receipt.status}'` };
}

/** The line shown between "broadcast" and "mined". `label` names the contract call; the pending
 * line never uses the confirmed line's wording. */
export function submittedLine(label: string, hash: string): string {
  return `Submitted, waiting for confirmation. ${label} ${hash}`;
}

/** The line when the wallet replaced the transaction (cancel, or a speed-up that changed the call).
 * The replacement's receipt is not the member's action, so nothing is claimed either way. */
export function replacedLine(label: string, hash: string): string {
  return `The original transaction was replaced from your wallet, so nothing is confirmed for ${label} ${hash}. Check your balance before retrying.`;
}

/** The line for a receipt wait that could not settle. Not a failure claim: the transaction may
 * still be mined, so the member is pointed at the hash rather than told it failed. */
export function unconfirmedLine(label: string, hash: string, detail: string): string {
  return `Could not confirm yet (${detail}). The transaction may still be mined; check ${label} ${hash} before retrying.`;
}
