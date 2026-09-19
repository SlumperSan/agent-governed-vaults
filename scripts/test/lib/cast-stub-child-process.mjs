// @ts-check
/**
 * What `node:child_process` resolves to INSIDE the file under test, and only inside it.
 *
 * `cast-stub-hooks.mjs` redirects the specifier for one parent module; everything else in the
 * process — `node --test`, the harness's own `spawnSync` — keeps the real builtin. The real one is
 * re-exported here so a runner that later reaches for `spawn` or `execSync` gets working code
 * rather than `undefined`, and only `execFileSync` (the single seam `smoke-test.mjs` uses for every
 * chain interaction) is replaced.
 *
 * `createRequire` is how the real builtin is reached without re-entering the resolve hook: the hook
 * keys on the importer, and this file is not the file under test.
 */
import { createRequire } from 'node:module';
import { execFileSync as stubbedExecFileSync } from './cast-stub.mjs';

const real = createRequire(import.meta.url)('child_process');

export const execFileSync = stubbedExecFileSync;
export const {
  ChildProcess, exec, execFile, execSync, fork, spawn, spawnSync,
} = real;
export default { ...real, execFileSync: stubbedExecFileSync };
