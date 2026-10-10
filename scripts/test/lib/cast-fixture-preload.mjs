/**
 * `node --import ./cast-fixture-preload.mjs scripts/smoke-test.mjs` — registers the resolve hook
 * (cast-fixture-hooks.mjs) before smoke-test.mjs itself is loaded, so its `node:child_process`
 * import is already redirected by the time that import statement executes.
 */
import { register } from 'node:module';

register('./cast-fixture-hooks.mjs', import.meta.url);
