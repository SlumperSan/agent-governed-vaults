/**
 * Node module-customization hook (registered via `node:module`'s `register()`, see
 * cast-fixture-preload.mjs). Redirects the ONE specifier scripts/smoke-test.mjs imports from
 * `node:child_process` — nothing else — to cast-fixture-stub.mjs, before smoke-test.mjs's own
 * `import { execFileSync } from 'node:child_process'` (scripts/smoke-test.mjs:33) resolves.
 *
 * This is a `resolve` hook only. It never touches `load`: once the specifier is redirected to a
 * real file on disk (cast-fixture-stub.mjs), Node's default loader reads and runs it exactly as
 * it would any other module — there is no synthetic source string to keep in sync here.
 *
 * scripts/smoke-test.mjs's own transitive imports (lib/proposal-decode.mjs, proposal-recovery.mjs,
 * smoke-preflight.mjs, packages/canary/src/call-error.mjs) import nothing from child_process, so
 * this redirect touches exactly the one seam the brief asked for and nothing else in the graph.
 */
const STUB_URL = new URL('./cast-fixture-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process' || specifier === 'child_process') {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
