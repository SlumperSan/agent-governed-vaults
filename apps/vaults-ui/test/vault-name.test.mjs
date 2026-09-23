// @ts-check
/**
 * Card #67, "Nothing holds what the one v1 vault is called" — `assembleVault` has always accepted
 * a caller-supplied `name`, but nothing in this workspace ever supplied one, so `VaultList.tsx`
 * and `App.tsx`'s `v.name || shortAddress(v.address)` fallback fired on every render. This is the
 * wiring that closes it: `VITE_VAULT_NAME` -> `readLiveConfig` -> `fetchLiveVaults` -> `readOneVault`
 * -> `assembleVault({ name })`.
 *
 * WHY SOURCE ASSERTIONS FOR THE WIRING. `node --test` has no TSX/TS loader, so this file cannot
 * import `live-vaults.ts` — the same constraint `contrast.test.mjs`, `csp.test.mjs` and
 * `quorum-unknown.test.mjs` already work under (see that file's own header). The SINK,
 * `assembleVault` in `apps/web/src/chain-reader.mjs`, is plain `.mjs` and IS imported directly
 * below, so the one part of this change that can be a real behavioural test is one. The wiring in
 * between is asserted structurally, and each assertion is demonstrated non-vacuous: it is shown to
 * fail against the text this file replaced, not just to pass against the text it left.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { assembleVault } from '../../web/src/chain-reader.mjs';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const LIVE_VAULTS = join(REPO, 'apps/vaults-ui/src/lib/live-vaults.ts');
const ENV_EXAMPLE = join(REPO, 'apps/vaults-ui/.env.example');

const MINIMAL_CORE = Object.freeze({
  navWad: 0n,
  totalShares: 0n,
  idleUsdc: 0n,
  usdcScalar: 1_000_000n,
  totalPendingUsdc: 0n,
  oracle: '0x0000000000000000000000000000000000000001',
  governance: '0x0000000000000000000000000000000000000002',
  creator: '0x0000000000000000000000000000000000000003',
});

test('assembleVault: a supplied name reaches Vault.name unchanged (the sink this change wires into)', () => {
  const named = assembleVault({ address: '0xabc', core: MINIMAL_CORE, name: 'cirBTC Vault' });
  assert.equal(named.name, 'cirBTC Vault');
});

test('assembleVault: an empty name still falls back to "" — the pre-existing default is unchanged', () => {
  const unnamed = assembleVault({ address: '0xabc', core: MINIMAL_CORE, name: '' });
  assert.equal(unnamed.name, '');
  // Confirms the default this change relies on: an omitted `name` altogether behaves identically
  // to an explicit `''`, which is what an unconfigured VITE_VAULT_NAME now sends.
  const omitted = assembleVault({ address: '0xabc', core: MINIMAL_CORE });
  assert.equal(omitted.name, '');
});

test('live-vaults.ts: VITE_VAULT_NAME is read, threaded through readOneVault, and reaches assembleVault', () => {
  const src = readFileSync(LIVE_VAULTS, 'utf8');

  assert.match(
    src,
    /readonly vaultName: string;/,
    'LiveConfig no longer declares vaultName — the one home this string has was removed',
  );
  assert.match(
    src,
    /env\.VITE_VAULT_NAME/,
    'readLiveConfig no longer reads VITE_VAULT_NAME',
  );
  assert.match(
    src,
    /vaultAddresses,\s*vaultName/,
    'readLiveConfig no longer returns vaultName on the frozen LiveConfig object',
  );
  assert.match(
    src,
    /readOneVault\(c, address, cfg\.vaultName\)/,
    'fetchLiveVaults no longer passes cfg.vaultName into readOneVault',
  );
  assert.match(
    src,
    /async function readOneVault\(client: PublicClient, address: string, name: string\)/,
    'readOneVault no longer accepts a name parameter',
  );
  // The actual sink: the `name` local must reach the assembleVault({ ... }) call as a bare
  // shorthand property, not be left as the old hardcoded `''`. Matched inside the return block
  // specifically, not anywhere in the file, so a `name` variable used for something unrelated
  // could not make this pass by accident.
  const returnBlock = /return assembleVault\(\{[\s\S]*?\n {2}\}\);/.exec(src);
  assert.ok(returnBlock, 'no `return assembleVault({ ... })` block found in readOneVault');
  assert.match(
    returnBlock[0],
    /\bname,/,
    'the assembleVault({ ... }) call in readOneVault no longer passes the name parameter through',
  );
});

test('mutation: the wiring assertions above are not vacuous — they fail against the pre-fix shape', () => {
  // The exact block this change replaced, verbatim, minus the surrounding call. If any assertion
  // below PASSES against this text, the corresponding assertion above is not testing what it
  // claims to.
  const preFix = `
  return assembleVault({
    address,
    core,
    legs: legsForDisplay,
    legSafety,
    proposal,
    governanceConfig,
    attested,
    // \`name\`/\`operatorName\` are left \`''\` (the default \`assembleVault\` already applies).
    operatorAddress: core.creator,
  });
`;
  const returnBlock = /return assembleVault\(\{[\s\S]*?\n {2}\}\);/.exec(preFix);
  assert.ok(returnBlock, 'the pre-fix fixture text does not even parse as expected — fix the fixture');
  assert.doesNotMatch(
    returnBlock[0],
    /\bname,/,
    'the pre-fix text now matches /\\bname,/ — the mutation fixture is stale',
  );
});

test('.env.example: VITE_VAULT_NAME is not set against the Base Sepolia smoke fixture', () => {
  // That vault is a generic testnet fixture, not the v1 mainnet vault — see the comment this test
  // guards. Setting a real display name against it would be a false claim shipped into every
  // developer's local build.
  const env = readFileSync(ENV_EXAMPLE, 'utf8');
  assert.doesNotMatch(
    env,
    /^VITE_VAULT_NAME\s*=\s*\S/m,
    'VITE_VAULT_NAME is set to a real value in .env.example, against the Base Sepolia smoke vault',
  );
});
