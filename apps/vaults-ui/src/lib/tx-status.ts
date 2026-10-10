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
 * Three outcomes, and `unconfirmed` is deliberately not `reverted`: a receipt wait that threw
 * (RPC down, wait timed out) is evidence of nothing about the transaction itself, so it must not
 * render as a failure any more than as a success.
 */
export type TxOutcome =
  | { readonly state: 'confirmed' }
  | { readonly state: 'reverted' }
  | { readonly state: 'unconfirmed'; readonly detail: string };

interface ReceiptWaiter {
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ readonly status: string }>;
}

export async function confirmTx(client: ReceiptWaiter, hash: `0x${string}`): Promise<TxOutcome> {
  let status: string;
  try {
    ({ status } = await client.waitForTransactionReceipt({ hash }));
  } catch (e) {
    return { state: 'unconfirmed', detail: e instanceof Error ? e.message : String(e) };
  }
  if (status === 'success') return { state: 'confirmed' };
  if (status === 'reverted') return { state: 'reverted' };
  return { state: 'unconfirmed', detail: `unexpected receipt status '${status}'` };
}

/** The line shown between "broadcast" and "mined". `what` is the past-tense word the confirmed
 * line will use, so the pending line never reads as that word itself. */
export function submittedLine(label: string, hash: string): string {
  return `Submitted, waiting for confirmation. ${label} ${hash}`;
}

/** The line for a receipt wait that could not settle. Not a failure claim: the transaction may
 * still be mined, so the member is pointed at the hash rather than told it failed. */
export function unconfirmedLine(label: string, hash: string, detail: string): string {
  return `Could not confirm yet (${detail}). The transaction may still be mined; check ${label} ${hash} before retrying.`;
}
