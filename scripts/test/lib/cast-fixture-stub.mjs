/**
 * What `node:child_process` resolves to inside the child process running the UNMODIFIED
 * scripts/smoke-test.mjs, once cast-fixture-hooks.mjs has redirected that specifier here (see
 * that file for how the redirect happens). smoke-test.mjs imports exactly one thing from
 * `node:child_process` — `execFileSync` (scripts/smoke-test.mjs:33) — so that is the only export
 * this stub needs to provide for the script's own logic to run unmodified.
 *
 * This module never spawns a process. Every call is answered in-process by cast-fixture-chain.mjs
 * and logged to SMOKE_FIXTURE_LOG. That log, plus the fact this file is the only thing standing
 * between smoke-test.mjs and a real `cast` binary, is the proof nothing was ever broadcast.
 */
import { createFakeChain } from './cast-fixture-chain.mjs';

// Built lazily, on the FIRST real cast() call, not at module-evaluation time. smoke-test.mjs's own
// `loadDeployment()` and `JSON.parse(readFileSync(SMOKE_CONFIG))` (scripts/smoke-test.mjs:165-196)
// run at its own module scope, straight off fs, before its first `cast` invocation (the module-
// level `keccakOf(...)` event-topic constants). Reading those same files here eagerly would let a
// fixture-parsing error pre-empt the real script's OWN existsSync/assert checks — which is exactly
// what the 'wrong path' negative control needs to observe firing, not a stand-in error from this
// stub.
let chain;
function getChain() {
  if (!chain) {
    chain = createFakeChain({
      configPath: process.env.SMOKE_CONFIG,
      deployJsonPath: process.env.DEPLOY_JSON,
      logPath: process.env.SMOKE_FIXTURE_LOG,
      scenario: process.env.SMOKE_FIXTURE_SCENARIO ?? 'happy',
    });
  }
  return chain;
}

export function execFileSync(_cmd, args) {
  return getChain().handle(args);
}
