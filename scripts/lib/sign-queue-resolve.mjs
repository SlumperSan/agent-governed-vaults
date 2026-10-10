// @ts-check
/**
 * Resolves a queue item's `data` when it was built as a `dataTemplate` recipe rather than a
 * literal hex string — the ONE shape the Sign queue currently needs this for: a Safe
 * `execTransaction` whose inner call embeds a value (a vault address from a prior item's
 * `VaultCreated` log) that cannot be known until that prior item is actually mined. Encoding is
 * always via `cast calldata`/`cast abi-encode` — never hand-rolled ABI, per the project's own
 * standing rule (this file's sibling `scripts/lib/safe-exec.mjs`, `proposal-decode.mjs`).
 *
 * `castFn` is injected (never a bare `execFileSync` here) so `scripts/test/sign-queue.test.mjs`
 * can drive this with a stub and assert on exactly what it would have shelled out to, with no
 * `cast` binary required to run the unit tests.
 */
import { buildPlan, execTransactionArgs, preValidatedSignature, SAFE_EXEC_TRANSACTION_SIG } from './safe-exec.mjs';
import { resolveTemplates } from './sign-queue.mjs';

/**
 * @param {import('./sign-queue.mjs').QueueItem} item
 * @param {Map<string, import('./sign-queue.mjs').QueueItem>} itemsById
 * @param {(args: string[]) => string} castFn
 * @returns {{ok:true, resolved:string}|{ok:false, reason:string}}
 */
export function resolveItemData(item, itemsById, castFn) {
  if (typeof item.data === 'string') return { ok: true, resolved: item.data };
  const t = item.dataTemplate;
  if (!t || typeof t !== 'object') return { ok: false, reason: 'item has neither a resolved data nor a dataTemplate' };
  if (t.kind !== 'safe-exec') return { ok: false, reason: `unknown dataTemplate kind ${JSON.stringify(t.kind)}` };

  const resolvedArgs = [];
  for (const argTemplate of t.innerArgsTemplate) {
    const r = resolveTemplates(argTemplate, itemsById);
    if (!r.ok) return r;
    resolvedArgs.push(r.resolved);
  }
  let innerData;
  try {
    innerData = castFn(['calldata', t.innerSig, ...resolvedArgs]);
  } catch (e) {
    return { ok: false, reason: `cast calldata for the inner call failed: ${/** @type {Error} */ (e).message}` };
  }
  const plan = buildPlan({ safe: t.safe, to: t.to, data: innerData, nonce: BigInt(t.safeNonce) });
  const sig = preValidatedSignature(t.safeOwner);
  let outer;
  try {
    outer = castFn(['calldata', SAFE_EXEC_TRANSACTION_SIG, ...execTransactionArgs(plan, sig)]);
  } catch (e) {
    return { ok: false, reason: `cast calldata for the outer execTransaction failed: ${/** @type {Error} */ (e).message}` };
  }
  return { ok: true, resolved: outer };
}
