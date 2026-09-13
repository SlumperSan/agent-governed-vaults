// @ts-check
/**
 * Is a failed read EVIDENCE ABOUT THE CONTRACT, or missing evidence?
 *
 * A leaf module with NO imports, because two callers that must never disagree live on opposite
 * sides of the repo: `packages/canary` (viem, deployed) and `scripts/soak` (`cast`, dev-only).
 * It lives under `packages/` rather than under `scripts/` because the Dockerfile copies only
 * `packages` and `apps` into the runtime image — a canary that imported `scripts/soak/lib.mjs`
 * would resolve fine on a developer's checkout and fail with MODULE_NOT_FOUND in production.
 * `scripts/soak/lib.mjs` imports and re-exports it, the same way `scripts/soak/oracle-sampler.mjs`
 * already re-exports from `lib.mjs`, so there is exactly one definition.
 *
 * This exists because a soak drill asserted `!result.ok` to prove a call was REFUSED, and
 * `ok:false` is also what a rate limit produces — so a 429 satisfied a security assertion
 * (PR #173). The canary had the same shape in more places: a transport failure reached the pager
 * as "EXIT LIVENESS BROKEN … (H-1 regression)".
 *
 * ── What 'transport' does and does not mean ──
 * It means ONLY "this is not a confirmed contract-level revert". It is deliberately the default
 * for unrecognized wording, so a failure nobody has seen before is treated as missing evidence
 * rather than as a finding. It does NOT mean "the chain was unreachable": `missing trie node`,
 * which a pruned node returns for a read pinned below its history window, classifies 'transport'
 * — the node answered, it just could not answer THAT question. `share-conservation.mjs` relies on
 * that string reaching its unpinned-retry path, which is why that retry is not gated on `kind`.
 */

// REDUNDANT WITH THE TERNARY BELOW, and kept only as documentation of what "transport" means in
// practice. Trace it: if REVERTED matches, this cannot fire; if it does not, both paths already
// return 'transport'. Deleting it changes no behaviour and no test. It is labelled rather than
// removed because in a file whose whole subject is that this classification is security-relevant,
// a decorative regex reading as load-bearing logic is its own hazard.
const TRANSPORT_ERR = /429|rate.?limit|max retries exceeded|timed out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|connection|dns|502|503|504|521/i;
/** The wording for a contract-level revert, in the JSON-RPC, local-decode and viem spellings. */
const REVERTED = /execution reverted|revert(ed)?:/i;

/**
 * Classify a failed call. ONLY a recognised revert is evidence about the contract; anything else
 * is missing evidence and must be recorded as such.
 *
 * Takes the flattened error TEXT, not an Error object, so one implementation serves both callers:
 * `cast` hands it stderr, and the canary's reader hands it `shortMessage ?? message ?? String(err)`.
 * Measured against viem 2.x wording: a genuine revert reaches this as "Execution reverted for an
 * unknown reason." (matches), an HTTP 429 as "HTTP request failed." and a JSON-RPC rate limit as
 * "Request exceeds defined limit." (neither matches).
 *
 * @param {string} err
 * @returns {'revert'|'transport'}
 */
export function classifyCallError(err) {
  if (TRANSPORT_ERR.test(err) && !REVERTED.test(err)) return 'transport';
  return REVERTED.test(err) ? 'revert' : 'transport';
}
