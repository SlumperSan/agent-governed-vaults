// @ts-check
/**
 * The seam that makes `scripts/smoke-test.mjs` executable in a test WITHOUT EDITING IT.
 *
 * Loaded with `node --import`, this registers a synchronous resolve hook (`module.registerHooks`,
 * in-thread since Node 22.15) that rewrites exactly one specifier: `node:child_process`, and only
 * when the importer is the file named by `SMOKE_STUB_TARGET`. That import is the runner's ONLY door
 * to the outside world — every chain interaction shells out through `execFileSync(CAST, …)` — so
 * substituting it is enough to run the whole lifecycle with no RPC, no signer and no funded account,
 * against the unmodified source.
 *
 * SCOPED BY IMPORTER ON PURPOSE. A global redirect of a builtin would also reach `node --test`, the
 * test file's own `spawnSync`, and Node's internals; the failure would look like a harness bug
 * anywhere but here. Nothing is skipped quietly either: a missing or unusable `SMOKE_STUB_TARGET`
 * throws, because a hook that silently declines to substitute would hand the test a green run in
 * which nothing was stubbed and no assertion was reached.
 */
import { registerHooks } from 'node:module';

const TARGET = process.env.SMOKE_STUB_TARGET;
if (!TARGET) {
  throw new Error('cast-stub-hooks: SMOKE_STUB_TARGET (a file: URL of the module under test) is required');
}
if (!TARGET.startsWith('file:')) {
  throw new Error(`cast-stub-hooks: SMOKE_STUB_TARGET must be a file: URL, got ${TARGET}`);
}

const SHIM = new URL('./cast-stub-child-process.mjs', import.meta.url).href;
const CHILD_PROCESS = new Set(['node:child_process', 'child_process']);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (CHILD_PROCESS.has(specifier) && context.parentURL === TARGET) {
      return { url: SHIM, format: 'module', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
