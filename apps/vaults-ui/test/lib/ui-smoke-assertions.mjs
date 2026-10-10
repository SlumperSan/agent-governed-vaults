// @ts-check
/**
 * Pure checks over a `ui-smoke-provider.mjs` call log — no chain, no vite, no `@chain/*` alias.
 * Each function below is mutation-tested directly against a HAND-BUILT log fixture in
 * `ui-smoke.test.mjs` (never against the real app), the same style `simulate-before-sign.test.mjs`
 * already uses for its own coupling guards: prove the CHECKER discriminates, on fixtures it
 * controls, before trusting it against a live run.
 *
 * The five ABI fragments below are DECODE-ONLY MIRRORS of the real ones `chain-actions.ts` imports
 * from `@chain/act` (packages/reference-agent/src/act.mjs) — copied for signature shape so this
 * file can decode `eth_sendTransaction` calldata without importing anything vite-aliased. They are
 * never used to construct a call, only to read one back.
 */
import { decodeFunctionData } from 'viem';

const DECODE_ABI = /** @type {const} */ ([
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'deposit', inputs: [{ name: 'amountUsdc', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'commitVote', inputs: [{ name: 'pid', type: 'uint256' }, { name: 'commitment', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'revealVote', inputs: [{ name: 'pid', type: 'uint256' }, { name: 'support', type: 'bool' }, { name: 'salt', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'requestExit', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [] },
]);

const MAX_UINT256 = (1n << 256n) - 1n;
const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : s);

/** Every `eth_sendTransaction` entry, decoded where the calldata matches one of the five known
 * functions. Entries this harness cannot decode are DROPPED, never guessed at. */
export function decodedSends(log) {
  const out = [];
  for (const entry of log) {
    if (entry.method !== 'eth_sendTransaction') continue;
    const tx = Array.isArray(entry.params) ? entry.params[0] : null;
    if (!tx?.data) continue;
    try {
      const decoded = decodeFunctionData({ abi: DECODE_ABI, data: tx.data });
      out.push({ to: tx.to, functionName: decoded.functionName, args: decoded.args, entry });
    } catch {
      // Not one of the five — leave undecoded rather than misreporting it as one of them.
    }
  }
  return out;
}

/** The decoded function names of every send, in call order — what the mutation table's happy-path
 * assertion checks against `['approve', 'deposit']` / `['commitVote']` / `['revealVote']` /
 * `['requestExit']`. */
export function sendSequence(log) {
  return decodedSends(log).map((s) => s.functionName);
}

/** Every `eth_sendTransaction` entry, raw — decodable or not. Unlike `sendSequence`, this cannot
 * undercount: `decodedSends` deliberately DROPS a send it cannot decode against its five-function
 * ABI mirror (a drifted mirror, or garbled/no calldata) rather than misreport it, which means
 * `sendSequence` can read back as empty even when a real send reached the chain. The wrong-chain-id
 * MUTATION test's own claim — "no send reached the chain" — is checked against this, not against
 * `sendSequence`, for exactly that reason (found auditing this PR's own PR #373 fix for the same
 * vacuity shape one level down). */
export function rawSends(log) {
  return log.filter((e) => e.method === 'eth_sendTransaction');
}

/**
 * The approval this harness sent must be for the EXACT deposit amount, at the vault as spender —
 * never `type(uint256).max` (an unbounded approval `chain-actions.ts`'s header explicitly rejects:
 * "exact-bounded approvals"). Returns null (ok) or the reason it is not.
 */
export function checkApprovalBounded(log, { vault, amountUsdc }) {
  const approvals = decodedSends(log).filter((s) => s.functionName === 'approve');
  if (approvals.length === 0) return 'no approve(...) send found in the log';
  if (approvals.length > 1) return `expected exactly one approve(...) send, found ${approvals.length}`;
  const [spender, value] = approvals[0].args;
  if (lower(spender) !== lower(vault)) return `approve spender ${spender} != vault ${vault}`;
  if (value === MAX_UINT256) return 'approve amount is type(uint256).max — not exact-bounded';
  if (value !== amountUsdc) return `approve amount ${value} != expected deposit amount ${amountUsdc}`;
  return null;
}

/** A decoded send's `to` must be the address this action was supposed to sign against — catches a
 * write aimed at the wrong contract (e.g. governance instead of the vault, or vice versa). */
export function checkRecipient(log, { functionName, expectedTo }) {
  const matches = decodedSends(log).filter((s) => s.functionName === functionName);
  if (matches.length === 0) return `no ${functionName}(...) send found in the log`;
  const wrong = matches.filter((s) => lower(s.to) !== lower(expectedTo));
  if (wrong.length > 0) {
    return `${functionName} sent to ${wrong.map((w) => w.to).join(', ')}, expected ${expectedTo}`;
  }
  return null;
}

/**
 * `simulateThenWrite` (chain-actions.ts) runs `publicClient.simulateContract` — an `eth_call` —
 * before every `walletClient.writeContract` — an `eth_sendTransaction`. This checks the LOG for
 * that ordering directly: every send must have an `eth_call` to the same `to` address somewhere
 * before it. A send with no preceding call means the flow signed blind.
 */
export function checkEverySendSimulated(log) {
  const unsimulated = [];
  for (let i = 0; i < log.length; i++) {
    const entry = log[i];
    if (entry.method !== 'eth_sendTransaction') continue;
    const to = lower(Array.isArray(entry.params) ? entry.params[0]?.to : undefined);
    const precededByCall = log
      .slice(0, i)
      .some((e) => e.method === 'eth_call' && lower(Array.isArray(e.params) ? e.params[0]?.to : undefined) === to);
    if (!precededByCall) unsimulated.push(to);
  }
  if (unsimulated.length > 0) {
    return `send(s) with no preceding eth_call to the same address (signed blind): ${unsimulated.join(', ')}`;
  }
  return null;
}

/** Every `eth_chainId` this provider answered must be the one chain id the harness intended —
 * catches a run where the mutation hook (`chainIdOverride`) leaked into what should be the happy
 * path, or where the real RPC ever disagreed with the app's own `TARGET_CHAIN`. */
export function checkChainIdConsistent(log, expectedHex) {
  const wrong = log.filter((e) => e.method === 'eth_chainId' && e.result !== undefined && e.result !== expectedHex);
  if (wrong.length > 0) {
    return `eth_chainId answered ${[...new Set(wrong.map((e) => e.result))].join(', ')}, expected ${expectedHex}`;
  }
  return null;
}
