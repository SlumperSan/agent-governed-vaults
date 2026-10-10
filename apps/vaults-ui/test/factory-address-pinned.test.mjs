// @ts-check
/**
 * Security review, PR #409 (card 211, A2). `VITE_FACTORY_ADDRESS` is the address the manifest
 * check (`assembleManifestCheck`, `apps/web/src/chain-reader.mjs`) trusts as "the real
 * `VaultFactory`" — get that address wrong and the check verifies a vault against the WRONG
 * factory, which can still resolve to `'verified'` if the wrong factory happens to know the
 * configured vault address (or, worse, silently proves nothing while looking like a real check).
 *
 * `.env.example`'s `VITE_FACTORY_ADDRESS` was set BY HAND from `contracts/config/deployments/
 * arc-mainnet.json`'s `singletons.VaultFactory` when A2 was built, the same way `VITE_RPC_URL`/
 * `VITE_CHAIN_ID`/`VITE_VAULT_ADDRESSES` were — nothing forces the two to stay equal. This pins
 * `.env.example`'s value to the COMMITTED deployment record with a test, the same convention
 * `test/vault-name.test.mjs` and `test/testnet-masthead.test.mjs` already use for the sibling
 * `VITE_*` values (a static cross-workspace import was considered and rejected: `contracts/` is
 * outside `apps/vaults-ui`'s Vite root and aliasing a JSON file in just for a test is more moving
 * parts than reading it directly here).
 *
 * WHAT THIS DOES NOT COVER: the Cloudflare Pages PRODUCTION build environment is a separate,
 * unpinned source of truth for this value (same as every other `VITE_*` here) — flagged in this
 * PR's body as an ops follow-up, not something a repo-local test can reach.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ENV_EXAMPLE = join(APP, '.env.example');
const DEPLOYMENT_JSON = join(ROOT, 'contracts/config/deployments/arc-mainnet.json');

/** `VITE_FACTORY_ADDRESS=0x...` out of `.env.example`, exactly as `readLiveConfig` would read it
 * from a real build env (no quoting, no surrounding whitespace stripped beyond the trim Node's
 * own dotenv-equivalent parsing would do). */
function envFactoryAddress() {
  const env = readFileSync(ENV_EXAMPLE, 'utf8');
  const m = /^VITE_FACTORY_ADDRESS\s*=\s*(0x[0-9a-fA-F]{40})\s*$/m.exec(env);
  assert.ok(m, 'VITE_FACTORY_ADDRESS is not set to a well-formed address in .env.example');
  return m[1];
}

/** The committed, chain-read `VaultFactory` address — see that file's own `singletonsNote`. */
function deployedFactoryAddress() {
  const json = JSON.parse(readFileSync(DEPLOYMENT_JSON, 'utf8'));
  const addr = json?.singletons?.VaultFactory;
  assert.ok(
    typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr),
    'contracts/config/deployments/arc-mainnet.json has no well-formed singletons.VaultFactory',
  );
  return addr;
}

test('.env.example VITE_FACTORY_ADDRESS equals the committed VaultFactory deployment record', () => {
  const fromEnv = envFactoryAddress();
  const fromDeployment = deployedFactoryAddress();
  assert.equal(
    fromEnv.toLowerCase(),
    fromDeployment.toLowerCase(),
    `.env.example's VITE_FACTORY_ADDRESS (${fromEnv}) does not match contracts/config/deployments/` +
      `arc-mainnet.json's singletons.VaultFactory (${fromDeployment}) — the manifest check would be ` +
      `pinned against the wrong factory`,
  );
});

test('MUTATION: a one-character drift between the two values reds the real equality check', () => {
  const fromDeployment = deployedFactoryAddress();
  const drifted = '0x' + fromDeployment.slice(2, -1) + (fromDeployment.at(-1) === '0' ? '1' : '0');
  assert.notEqual(drifted.toLowerCase(), fromDeployment.toLowerCase(), 'sanity: the drift must be real');
  // The EXACT assertion the primary test runs, against the drifted value in place of the real
  // `.env.example` read — must throw, proving the primary test is not vacuously true.
  assert.throws(
    () => assert.equal(drifted.toLowerCase(), fromDeployment.toLowerCase()),
    'a one-character drift did not red the equality check — the pin is not load-bearing',
  );
});

test('non-vacuity: both files are actually read, not defaulted past a missing/malformed value', () => {
  assert.throws(() => {
    const bad = '{"singletons":{}}';
    const parsed = JSON.parse(bad);
    assert.ok(
      typeof parsed?.singletons?.VaultFactory === 'string' &&
        /^0x[0-9a-fA-F]{40}$/.test(parsed.singletons.VaultFactory),
    );
  }, 'a deployment record with no VaultFactory address must fail deployedFactoryAddress()\'s own assertion, not silently return undefined');
});
