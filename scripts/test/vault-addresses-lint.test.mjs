// @ts-check
/**
 * `vault-addresses-lint.mjs` (card A2), against fixture files built here rather than only against
 * the real repo state — the real-repo check at the bottom is one more test, not the whole suite.
 *
 * MUTATION-TESTED, PER THIS REPOSITORY'S OWN WORKING AGREEMENT ("a guard that can skip is a guard
 * that will"): the "real CLI, real fixtures" block below runs `scripts/vault-addresses-lint.mjs` as
 * an actual subprocess — not just the pure functions in-process — plants a wrong address, captures
 * the real RED output and exit code, restores a correct one, and captures real GREEN. The pure-unit
 * tests above it cover the individual decisions (unknown vs. chain-mismatch vs. malformed) more
 * cheaply; the subprocess block is what proves the CLI itself, not just its library, actually fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADDRESS_RE,
  parseEnvText,
  extractLooseVar,
  findEnvFiles,
  findDeployConfigCandidates,
  readDeploymentManifests,
  collectManifestVaultAddresses,
  buildVaultAddressIndex,
  evaluateAddresses,
  checkEnvFile,
  checkDeployConfigFile,
  formatIssue,
  lintVaultAddresses,
} from '../lib/vault-addresses-lint.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'scripts', 'vault-addresses-lint.mjs');

// A real deployed vault + its manifest, reused across fixtures below.
const SMOKE_ADDRESS = '0xb940d71b0d695e2ba2b5853bf565c69daa3e3c98';
const SMOKE_CHAIN_ID = 84532;
const smokeManifest = () => ({
  chainName: 'base-sepolia',
  chainId: SMOKE_CHAIN_ID,
  singletons: {
    VaultFactory: '0xc1cb782471e506c71ae91feb91adcefc34a99743',
    VaultDeployer: '0x5bfc2b9af09cc4c727321735a0f0fbd6fd09a81a',
  },
  smokeVault: { address: SMOKE_ADDRESS },
});

// ── parseEnvText ──────────────────────────────────────────────────────────────────────────────

test('parseEnvText: comments and blank lines are skipped, matching quotes stripped', () => {
  const text = [
    '# a comment',
    '',
    'VITE_RPC_URL=https://sepolia.base.org',
    'VITE_CHAIN_ID=84532',
    'QUOTED="hello world"',
    "SINGLE='also fine'",
  ].join('\n');
  const vars = parseEnvText(text);
  assert.equal(vars.VITE_RPC_URL, 'https://sepolia.base.org');
  assert.equal(vars.VITE_CHAIN_ID, '84532');
  assert.equal(vars.QUOTED, 'hello world');
  assert.equal(vars.SINGLE, 'also fine');
});

test('parseEnvText: a later assignment of the same key wins', () => {
  const vars = parseEnvText('A=first\nA=second\n');
  assert.equal(vars.A, 'second');
});

test('parseEnvText: a line that is not KEY=value is ignored, not thrown on', () => {
  const vars = parseEnvText('not a valid line\nA=1\n');
  assert.deepEqual(vars, { A: '1' });
});

// ── extractLooseVar ───────────────────────────────────────────────────────────────────────────

test('extractLooseVar: reads a YAML-style `KEY: value` assignment', () => {
  assert.equal(extractLooseVar('env:\n  VITE_VAULT_ADDRESSES: 0xabc\n', 'VITE_VAULT_ADDRESSES'), '0xabc');
});

test('extractLooseVar: reads a shell-style `export KEY=value` assignment', () => {
  assert.equal(extractLooseVar('export VITE_VAULT_ADDRESSES=0xabc\n', 'VITE_VAULT_ADDRESSES'), '0xabc');
});

test('extractLooseVar: returns undefined when the name is absent', () => {
  assert.equal(extractLooseVar('VITE_CHAIN_ID: 84532\n', 'VITE_VAULT_ADDRESSES'), undefined);
});

// ── findEnvFiles / findDeployConfigCandidates ────────────────────────────────────────────────

test('findEnvFiles: only top-level dotfiles starting with .env, sorted, unrelated files excluded', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'val-envdir-'));
  try {
    writeFileSync(path.join(dir, '.env.example'), 'X=1');
    writeFileSync(path.join(dir, '.env.production'), 'X=1');
    writeFileSync(path.join(dir, 'README.md'), '# not an env file');
    writeFileSync(path.join(dir, 'package.json'), '{}');
    mkdirSync(path.join(dir, '.envish-dir')); // a directory, not a file -- must not be returned
    const found = findEnvFiles(dir).map((f) => path.basename(f));
    assert.deepEqual(found, ['.env.example', '.env.production']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findEnvFiles: a missing directory returns an empty list rather than throwing', () => {
  assert.deepEqual(findEnvFiles(path.join(tmpdir(), 'definitely-does-not-exist-val-lint')), []);
});

test('findDeployConfigCandidates: workflows plus the vaults-ui workspace wrangler.toml only', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'val-deploycfg-'));
  try {
    const wf = path.join(dir, '.github', 'workflows');
    mkdirSync(wf, { recursive: true });
    writeFileSync(path.join(wf, 'ci.yml'), 'name: CI\n');
    writeFileSync(path.join(wf, 'notes.txt'), 'not yaml, must be excluded');
    const vaultsUiDir = path.join(dir, 'apps', 'vaults-ui');
    mkdirSync(vaultsUiDir, { recursive: true });
    writeFileSync(path.join(vaultsUiDir, 'wrangler.toml'), 'name = "rwally-app"\n');
    const otherWrangler = path.join(dir, 'apps', 'site');
    mkdirSync(otherWrangler, { recursive: true });
    writeFileSync(path.join(otherWrangler, 'wrangler.toml'), 'name = "site"\n');

    const found = findDeployConfigCandidates({ repoRoot: dir, vaultsUiDir }).map((f) => path.relative(dir, f));
    assert.deepEqual(found.sort(), [path.join('.github', 'workflows', 'ci.yml'), path.join('apps', 'vaults-ui', 'wrangler.toml')].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── collectManifestVaultAddresses: the shape rule, including the false-positive it must avoid ──

test('collectManifestVaultAddresses: picks up smokeVault.address (the shape today)', () => {
  const found = collectManifestVaultAddresses(smokeManifest(), 'base-sepolia.json');
  assert.deepEqual(
    found.map((f) => f.address),
    [SMOKE_ADDRESS.toLowerCase()],
  );
});

test('collectManifestVaultAddresses: MUST NOT pick up VaultFactory/VaultDeployer singleton addresses', () => {
  // These are infrastructure, not deployed vault instances -- a bare /vault/i regex would wrongly
  // catch them (see the module header). This is the false-positive this rule is shaped to avoid.
  const found = collectManifestVaultAddresses(smokeManifest(), 'base-sepolia.json');
  const addresses = found.map((f) => f.address);
  assert.ok(!addresses.includes('0xc1cb782471e506c71ae91feb91adcefc34a99743'), 'VaultFactory address leaked in as a vault');
  assert.ok(!addresses.includes('0x5bfc2b9af09cc4c727321735a0f0fbd6fd09a81a'), 'VaultDeployer address leaked in as a vault');
});

const MANY_A = `0x${'1'.repeat(39)}a`; // 0x + 40 hex chars, verified with node -e
const MANY_B = `0x${'2'.repeat(39)}b`;
const MANY_C = `0x${'3'.repeat(39)}c`;

test('collectManifestVaultAddresses: a future `vaults` array of objects is picked up (many-vaults shape)', () => {
  const manifest = { chainId: 5042, vaults: [{ address: MANY_A }, { address: MANY_B }] };
  const found = collectManifestVaultAddresses(manifest, 'arc-mainnet.json').map((f) => f.address);
  assert.deepEqual(found.sort(), [MANY_A, MANY_B].sort());
});

test('collectManifestVaultAddresses: a `vaults` array of bare address strings is also picked up', () => {
  const manifest = { chainId: 5042, vaults: [MANY_A] };
  const found = collectManifestVaultAddresses(manifest, 'arc-mainnet.json').map((f) => f.address);
  assert.deepEqual(found, [MANY_A]);
});

test('collectManifestVaultAddresses: a nested memberVault (suffix match, not top-level-only) is picked up', () => {
  const manifest = { chainId: 5042, group: { memberVault: { address: MANY_C } } };
  const found = collectManifestVaultAddresses(manifest, 'x.json').map((f) => f.address);
  assert.deepEqual(found, [MANY_C]);
});

test('collectManifestVaultAddresses: junk / non-address values are silently dropped, not thrown on', () => {
  const manifest = { smokeVault: { address: 'not-an-address' }, other: { vaults: [null, 42, { no: 'address field' }] } };
  assert.deepEqual(collectManifestVaultAddresses(manifest, 'x.json'), []);
});

// ── evaluateAddresses: ok / unknown / chain-mismatch / malformed, kept distinct ─────────────────

test('evaluateAddresses: a known address on its declared chain is ok, zero issues', () => {
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const r = evaluateAddresses('env-file', SMOKE_ADDRESS, String(SMOKE_CHAIN_ID), index);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.addresses, [{ address: SMOKE_ADDRESS, status: 'ok' }]);
});

test('evaluateAddresses: an address absent from every manifest is "unknown", not "chain-mismatch"', () => {
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const typo = '0xb940d71b0d695e2ba2b5853bf565c69daa3e3c99'; // last hex digit flipped
  const r = evaluateAddresses('env-file', typo, String(SMOKE_CHAIN_ID), index);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].status, 'unknown');
  assert.match(r.issues[0].reason, /unknown address/);
});

test('evaluateAddresses: a real vault address declared under the WRONG chain id is "chain-mismatch", not "unknown"', () => {
  // Card A2's worst-case example: a Base Sepolia address pointed at Arc mainnet's chain id.
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const r = evaluateAddresses('env-file', SMOKE_ADDRESS, '5042', index);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].status, 'chain-mismatch');
  assert.match(r.issues[0].reason, /base-sepolia/);
  assert.match(r.issues[0].reason, /VITE_CHAIN_ID=5042/);
});

test('evaluateAddresses: chain-mismatch and unknown produce genuinely different messages', () => {
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const unknown = evaluateAddresses('f', '0xb940d71b0d695e2ba2b5853bf565c69daa3e3c99', String(SMOKE_CHAIN_ID), index).issues[0];
  const mismatch = evaluateAddresses('f', SMOKE_ADDRESS, '5042', index).issues[0];
  assert.notEqual(unknown.status, mismatch.status);
  assert.notEqual(formatIssue(unknown), formatIssue(mismatch));
});

test('evaluateAddresses: a missing VITE_CHAIN_ID in the same file is treated as chain-mismatch, not a pass', () => {
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const r = evaluateAddresses('env-file', SMOKE_ADDRESS, undefined, index);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].status, 'chain-mismatch');
  assert.match(r.issues[0].reason, /\(unset\)/);
});

test('evaluateAddresses: a malformed address fails without ever reaching the manifest lookup', () => {
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const r = evaluateAddresses('env-file', '0xnothex', String(SMOKE_CHAIN_ID), index);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].status, 'malformed');
});

test('evaluateAddresses: comma-separated addresses are trimmed and checked independently', () => {
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const r = evaluateAddresses('env-file', ` ${SMOKE_ADDRESS} , 0xb940d71b0d695e2ba2b5853bf565c69daa3e3c99 `, String(SMOKE_CHAIN_ID), index);
  assert.equal(r.addresses.length, 2);
  assert.equal(r.addresses[0].status, 'ok');
  assert.equal(r.addresses[1].status, 'unknown');
});

test('evaluateAddresses: an empty VITE_VAULT_ADDRESSES (set but blank) is its own failure', () => {
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const r = evaluateAddresses('env-file', '   ', String(SMOKE_CHAIN_ID), index);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].status, 'empty');
});

test('ADDRESS_RE sanity: case-insensitive hex, exactly 40 chars, 0x-prefixed', () => {
  assert.ok(ADDRESS_RE.test(SMOKE_ADDRESS));
  // EIP-55 checksums the hex digits, never the "0x" itself -- a real checksummed address never
  // uppercases the prefix, so only the hex portion is uppercased here.
  assert.ok(ADDRESS_RE.test('0x' + SMOKE_ADDRESS.slice(2).toUpperCase()));
  assert.ok(!ADDRESS_RE.test(SMOKE_ADDRESS.slice(0, -1))); // 39 hex chars
  assert.ok(!ADDRESS_RE.test(SMOKE_ADDRESS + '0')); // 41 hex chars
});

// ── checkEnvFile / checkDeployConfigFile: skip vs. check ────────────────────────────────────────

test('checkEnvFile: a file that does not set VITE_VAULT_ADDRESSES is skipped, not failed', () => {
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const r = checkEnvFile('some-file', 'VITE_RPC_URL=https://x\n', index);
  assert.equal(r.skipped, true);
});

test('checkDeployConfigFile: a workflow with no VITE_VAULT_ADDRESSES line is skipped', () => {
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const r = checkDeployConfigFile('ci.yml', 'name: CI\non: [push]\n', index);
  assert.equal(r.skipped, true);
});

test('checkDeployConfigFile: a workflow that DOES set it inline is checked the same as an env file', () => {
  const index = buildVaultAddressIndex([{ file: 'base-sepolia.json', manifest: smokeManifest() }]);
  const yaml = `env:\n  VITE_CHAIN_ID: "5042"\n  VITE_VAULT_ADDRESSES: ${SMOKE_ADDRESS}\n`;
  const r = checkDeployConfigFile('ci.yml', yaml, index);
  assert.equal(r.skipped, undefined);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].status, 'chain-mismatch');
});

// ── readDeploymentManifests ───────────────────────────────────────────────────────────────────

test('readDeploymentManifests: reads every *.json under the deployments dir', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'val-manifests-'));
  try {
    writeFileSync(path.join(dir, 'base-sepolia.json'), JSON.stringify(smokeManifest()));
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored, not .json');
    const records = readDeploymentManifests(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].basename, 'base-sepolia');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── lintVaultAddresses: the zero-coverage traps, in-process ─────────────────────────────────────

test('lintVaultAddresses: hard error when no .env-shaped file exists at all (trap 1)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'val-e2e-'));
  try {
    const vaultsUiDir = path.join(dir, 'apps', 'vaults-ui'); // never created
    const deploymentsDir = path.join(dir, 'deployments');
    mkdirSync(deploymentsDir, { recursive: true });
    writeFileSync(path.join(deploymentsDir, 'base-sepolia.json'), JSON.stringify(smokeManifest()));

    const outcome = lintVaultAddresses({ vaultsUiDir, deploymentsDir });
    assert.match(outcome.hardError ?? '', /no \.env-shaped file/);
    assert.deepEqual(outcome.results, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lintVaultAddresses: hard error when no deployment manifest exists at all (trap 2)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'val-e2e-'));
  try {
    const vaultsUiDir = path.join(dir, 'apps', 'vaults-ui');
    mkdirSync(vaultsUiDir, { recursive: true });
    writeFileSync(path.join(vaultsUiDir, '.env.example'), `VITE_CHAIN_ID=${SMOKE_CHAIN_ID}\nVITE_VAULT_ADDRESSES=${SMOKE_ADDRESS}\n`);
    const deploymentsDir = path.join(dir, 'deployments'); // never created

    const outcome = lintVaultAddresses({ vaultsUiDir, deploymentsDir });
    assert.match(outcome.hardError ?? '', /no deployment manifest/);
    assert.deepEqual(outcome.results, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lintVaultAddresses: hard error when .env files exist but none set VITE_VAULT_ADDRESSES (trap 3)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'val-e2e-'));
  try {
    const vaultsUiDir = path.join(dir, 'apps', 'vaults-ui');
    mkdirSync(vaultsUiDir, { recursive: true });
    writeFileSync(path.join(vaultsUiDir, '.env.example'), 'VITE_RPC_URL=https://x\n'); // no VITE_VAULT_ADDRESSES
    const deploymentsDir = path.join(dir, 'deployments');
    mkdirSync(deploymentsDir, { recursive: true });
    writeFileSync(path.join(deploymentsDir, 'base-sepolia.json'), JSON.stringify(smokeManifest()));

    const outcome = lintVaultAddresses({ vaultsUiDir, deploymentsDir, repoRoot: dir });
    assert.match(outcome.hardError ?? '', /none set VITE_VAULT_ADDRESSES/);
    assert.deepEqual(outcome.results, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lintVaultAddresses: a clean fixture (env matches manifest, right chain) reports zero issues', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'val-e2e-'));
  try {
    const vaultsUiDir = path.join(dir, 'apps', 'vaults-ui');
    mkdirSync(vaultsUiDir, { recursive: true });
    writeFileSync(path.join(vaultsUiDir, '.env.example'), `VITE_CHAIN_ID=${SMOKE_CHAIN_ID}\nVITE_VAULT_ADDRESSES=${SMOKE_ADDRESS}\n`);
    const deploymentsDir = path.join(dir, 'deployments');
    mkdirSync(deploymentsDir, { recursive: true });
    writeFileSync(path.join(deploymentsDir, 'base-sepolia.json'), JSON.stringify(smokeManifest()));

    const outcome = lintVaultAddresses({ vaultsUiDir, deploymentsDir, repoRoot: dir });
    assert.equal(outcome.hardError, null);
    const totalIssues = outcome.results.reduce((n, r) => n + r.issues.length, 0);
    assert.equal(totalIssues, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── real CLI, real fixtures: mutation-test the guard by actually running the subprocess ─────────
//
// This is the block the working agreement asks for by name: plant a wrong address, capture REAL
// command output and a REAL non-zero exit code; fix it, capture REAL clean output and exit 0. Not
// a call into the pure functions -- the actual `node scripts/vault-addresses-lint.mjs` CLI.

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('CLI mutation test: RED on a typo in an address, GREEN once fixed, same fixture files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'val-cli-'));
  try {
    const vaultsUiDir = path.join(dir, 'apps', 'vaults-ui');
    mkdirSync(vaultsUiDir, { recursive: true });
    const deploymentsDir = path.join(dir, 'deployments');
    mkdirSync(deploymentsDir, { recursive: true });
    writeFileSync(path.join(deploymentsDir, 'base-sepolia.json'), JSON.stringify(smokeManifest()));
    const envPath = path.join(vaultsUiDir, '.env.example');

    const cliArgs = ['--vaults-ui-dir', vaultsUiDir, '--deployments-dir', deploymentsDir, '--repo-root', dir];

    // Plant the defect: last hex digit of a real, deployed address flipped.
    writeFileSync(envPath, `VITE_CHAIN_ID=${SMOKE_CHAIN_ID}\nVITE_VAULT_ADDRESSES=0xb940d71b0d695e2ba2b5853bf565c69daa3e3c99\n`);
    const red = runCli(cliArgs);
    assert.equal(red.status, 1, `expected exit 1 on a planted bad address, got ${red.status}\nstdout: ${red.stdout}\nstderr: ${red.stderr}`);
    assert.match(red.stderr, /FAIL/);
    assert.match(red.stderr, /unknown address/);

    // Fix it: the real, correct smoke vault address.
    writeFileSync(envPath, `VITE_CHAIN_ID=${SMOKE_CHAIN_ID}\nVITE_VAULT_ADDRESSES=${SMOKE_ADDRESS}\n`);
    const green = runCli(cliArgs);
    assert.equal(green.status, 0, `expected exit 0 after the fix, got ${green.status}\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);
    assert.match(green.stdout, /0 failing address/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI mutation test: RED on a chain-mismatch (right address, wrong VITE_CHAIN_ID), GREEN once fixed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'val-cli-'));
  try {
    const vaultsUiDir = path.join(dir, 'apps', 'vaults-ui');
    mkdirSync(vaultsUiDir, { recursive: true });
    const deploymentsDir = path.join(dir, 'deployments');
    mkdirSync(deploymentsDir, { recursive: true });
    writeFileSync(path.join(deploymentsDir, 'base-sepolia.json'), JSON.stringify(smokeManifest()));
    const envPath = path.join(vaultsUiDir, '.env.example');
    const cliArgs = ['--vaults-ui-dir', vaultsUiDir, '--deployments-dir', deploymentsDir, '--repo-root', dir];

    // Plant the worse defect: a real Base Sepolia vault address, declared under Arc mainnet's chain id.
    writeFileSync(envPath, `VITE_CHAIN_ID=5042\nVITE_VAULT_ADDRESSES=${SMOKE_ADDRESS}\n`);
    const red = runCli(cliArgs);
    assert.equal(red.status, 1, `expected exit 1 on a chain mismatch, got ${red.status}\nstderr: ${red.stderr}`);
    assert.match(red.stderr, /chain/i);
    assert.doesNotMatch(red.stderr, /unknown address/, 'a chain mismatch must not be reported as an unknown address');

    writeFileSync(envPath, `VITE_CHAIN_ID=${SMOKE_CHAIN_ID}\nVITE_VAULT_ADDRESSES=${SMOKE_ADDRESS}\n`);
    const green = runCli(cliArgs);
    assert.equal(green.status, 0, `expected exit 0 after the fix, got ${green.status}\nstderr: ${green.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI mutation test: the zero-coverage trap fails loud through the real CLI (exit 2, not 0)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'val-cli-'));
  try {
    const vaultsUiDir = path.join(dir, 'apps', 'vaults-ui'); // deliberately never created
    const deploymentsDir = path.join(dir, 'deployments');
    mkdirSync(deploymentsDir, { recursive: true });
    writeFileSync(path.join(deploymentsDir, 'base-sepolia.json'), JSON.stringify(smokeManifest()));

    const result = runCli(['--vaults-ui-dir', vaultsUiDir, '--deployments-dir', deploymentsDir, '--repo-root', dir]);
    assert.equal(result.status, 2, `expected exit 2 (could not run), got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.notEqual(result.status, 0, 'zero .env files must never read as a pass');
    assert.match(result.stderr, /no \.env-shaped file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── against the real repo, not only fixtures ────────────────────────────────────────────────────

test('REAL REPO: apps/vaults-ui/.env.example currently cross-checks clean against contracts/config/deployments', () => {
  // Not a fixture: this is the actual CLI, no path overrides, against the actual checked-in files.
  // Today VITE_VAULT_ADDRESSES matches base-sepolia.json's smokeVault "by coincidence, not by any
  // check" (card A2's own framing) -- this test is that check, applied to the real state.
  const result = runCli([]);
  assert.equal(result.status, 0, `real repo state should be clean; got exit ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /0 failing address/);
});
