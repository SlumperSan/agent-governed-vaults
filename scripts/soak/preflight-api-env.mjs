#!/usr/bin/env node
// @ts-check
/**
 * API ENV PREFLIGHT — refuse loudly, before anything is spawned, if the environment the api
 * service is about to run under does not satisfy `resolveApiConfig` (apps/api/src/serve.mjs).
 *
 * Measured: `run-soak.ps1` started the api and printed `started api pid 23120`. The process had
 * already crashed — `Error: api: missing required env: PRICE_ASSET, PRICE_PAYTO` at
 * `resolveApiConfig (apps/api/src/serve.mjs:111:29)` — before that line even printed, because
 * launching and reporting were the same code path acting on a pid that was never checked for
 * survival. That half of the defect is fixed in `soak-pidset.psm1`'s `Start-ManagedProcess` (a
 * pid is not evidence the process survived — it now waits a moment and looks). This script is the
 * OTHER half: the env contract belongs before anything launches, in a place an operator actually
 * reads, not in a log nobody opens until a drill fails hours later for an unrelated-looking reason.
 *
 * DELIBERATELY NOT a hand-copied list of `PRICE_ASSET`/`PRICE_PAYTO`/etc. `resolveApiConfig` IS
 * the contract; this script imports and calls the REAL function and reports exactly what it
 * throws. A hand-kept list here would be a third copy of a requirement set that has already
 * drifted twice in this repo (see `SVM_REQUIRED`'s own history note in `serve.mjs`: two separate
 * doc copies both said "three" while the code required four). If `serve.mjs` grows a requirement,
 * this preflight learns it automatically the next time it runs — there is nothing here to update.
 * `resolveApiConfig` is pure (no I/O, no server start) and importing `serve.mjs` from a script
 * other than itself does not boot anything: see its own `isMain` guard at the bottom of the file.
 *
 * Reads `process.env` exactly as the real api process will see it. Run this the SAME way
 * `run-soak.ps1` starts the api — with `--env-file=.env` — so what is checked is what will
 * actually run, not a copy of it.
 *
 * Run:  node --env-file=.env scripts/soak/preflight-api-env.mjs   (from the repo root)
 * Exit: 0 the api would boot cleanly with this environment. 1 it would not — resolveApiConfig's
 *       own message is printed, unedited, so this can never say something resolveApiConfig itself
 *       does not also say.
 */
import { fileURLToPath } from 'node:url';
import { resolveApiConfig } from '../../apps/api/src/serve.mjs';

export function checkApiEnv(env = process.env) {
  try {
    resolveApiConfig(env);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: /** @type {Error} */ (e).message };
  }
}

function main() {
  const result = checkApiEnv(process.env);
  if (result.ok) {
    console.log('[soak] api env preflight OK — the api would boot with this environment');
    process.exit(0);
  }
  console.error('\n[soak] API ENV PREFLIGHT REFUSED\n');
  console.error(result.message);
  console.error('\nFix .env (or whatever environment run-soak.ps1 launches the api with), then re-run.\n');
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
