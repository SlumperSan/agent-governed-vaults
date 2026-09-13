// @ts-check
/**
 * Pure-logic tests for scripts/lib/deployment-currency.mjs -- the "why" is in that module's
 * header. No real git repo and no RPC are touched; `gitResolves`/`changedSourcePaths` are stubbed
 * so the suite exercises every branch of the verdict rather than whatever this checkout's history
 * happens to contain right now.
 *
 * The one test that DOES reach outside is the selector pin, and it self-skips when foundry is
 * absent -- see its own comment for why that skip is safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDeploymentCurrency,
  launchConfigNotes,
  compareVaultCoreChunks,
  formatOnchainLine,
  anyHardFail,
  formatResultLine,
} from '../lib/deployment-currency.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const neverCalled = (name) => () => {
  throw new Error(`${name} must not be called`);
};

const baseDeps = {
  gitResolves: () => true,
  changedSourcePaths: () => [],
  haveMainline: true,
  mainlineRef: 'origin/protocol/main',
  fallbackChainName: 'base-sepolia',
};

test('contracts/src unchanged since sourceCommit -> current, no hard failure', () => {
  const r = checkDeploymentCurrency({ chainName: 'base-sepolia', sourceCommit: 'abc1234' }, baseDeps);
  assert.equal(r.current, true);
  assert.deepEqual(r.changedPaths, []);
  assert.equal(r.hardFail, false);
  assert.match(formatResultLine(r), /^OK\b/);
});

test('contracts/src changed since sourceCommit -> BEHIND and a hard failure', () => {
  const changed = ['contracts/src/VaultCore.sol', 'contracts/src/VaultFactory.sol'];
  const r = checkDeploymentCurrency(
    { chainName: 'base-sepolia', sourceCommit: 'abc1234' },
    { ...baseDeps, changedSourcePaths: () => changed },
  );
  assert.equal(r.current, false);
  assert.deepEqual(r.changedPaths, changed);
  assert.equal(r.hardFail, true);
  assert.match(formatResultLine(r), /^BEHIND\b/);
  assert.match(formatResultLine(r), /VaultCore\.sol/);
});

test('a long changed-path list is elided, and the elision states how many are hidden', () => {
  const changed = Array.from({ length: 13 }, (_, i) => `contracts/src/F${i}.sol`);
  const r = checkDeploymentCurrency({ sourceCommit: 'abc1234' }, { ...baseDeps, changedSourcePaths: () => changed });
  const line = formatResultLine(r, 6);
  assert.match(line, /13 contracts\/src path\(s\) changed/);
  assert.match(line, /\+7 more/);
});

test('no sourceCommit recorded -> SKIP, and git is never consulted', () => {
  const r = checkDeploymentCurrency(
    { chainName: 'base-mainnet' },
    { ...baseDeps, gitResolves: neverCalled('gitResolves'), changedSourcePaths: neverCalled('changedSourcePaths') },
  );
  assert.equal(r.sourceCommit, '(none)');
  assert.equal(r.current, null);
  assert.equal(r.hardFail, false);
  assert.match(formatResultLine(r), /^SKIP\b/);
});

test('unresolvable sourceCommit -> SKIP with a note, not this script\'s failure', () => {
  // Reproducibility owns that failure; double-reporting it here would make one defect look like two.
  const r = checkDeploymentCurrency(
    { chainName: 'base-sepolia', sourceCommit: 'deadbee' },
    { ...baseDeps, gitResolves: () => false, changedSourcePaths: neverCalled('changedSourcePaths') },
  );
  assert.equal(r.current, null);
  assert.equal(r.hardFail, false);
  assert.match(r.notes.join(' '), /does not resolve/);
});

test('missing mainline ref -> refuses to answer rather than defaulting to "current"', () => {
  const r = checkDeploymentCurrency(
    { chainName: 'base-sepolia', sourceCommit: 'abc1234' },
    { ...baseDeps, haveMainline: false, changedSourcePaths: neverCalled('changedSourcePaths') },
  );
  assert.equal(r.current, null);
  assert.equal(r.hardFail, false);
  assert.match(r.notes.join(' '), /not present/);
});

test('allowSubVaults=true is an advisory note, never a hard failure on its own', () => {
  const cfg = {
    chainName: 'base-sepolia',
    sourceCommit: 'abc1234',
    verifiedWiring: { 'factory.allowSubVaults()': true },
  };
  const r = checkDeploymentCurrency(cfg, baseDeps);
  assert.equal(r.hardFail, false, 'a config divergence must not be laundered into a staleness failure');
  assert.match(r.notes.join(' '), /allowSubVaults\(\) = true/);
  assert.match(r.notes.join(' '), /DIFFERENT configuration/);
});

test('allowSubVaults=false (the launch configuration) produces no note', () => {
  assert.deepEqual(launchConfigNotes({ verifiedWiring: { 'factory.allowSubVaults()': false } }), []);
});

test('a record with no verifiedWiring produces no note (absent is not false)', () => {
  assert.deepEqual(launchConfigNotes({}), []);
  assert.deepEqual(launchConfigNotes({ verifiedWiring: {} }), []);
});

test('notes survive onto a SKIP result -- a divergence is worth saying even when currency is unknown', () => {
  const r = checkDeploymentCurrency(
    { chainName: 'base-sepolia', verifiedWiring: { 'factory.allowSubVaults()': true } },
    baseDeps,
  );
  assert.equal(r.current, null);
  assert.match(r.notes.join(' '), /allowSubVaults/);
});

test('anyHardFail is true when any single record is behind', () => {
  const ok = checkDeploymentCurrency({ sourceCommit: 'a' }, baseDeps);
  const behind = checkDeploymentCurrency(
    { sourceCommit: 'b' },
    { ...baseDeps, changedSourcePaths: () => ['contracts/src/VaultCore.sol'] },
  );
  assert.equal(anyHardFail([ok, ok]), false);
  assert.equal(anyHardFail([ok, behind]), true);
});

// ---------------------------------------------------------------------------
// THE ON-CHAIN LEG — and the second false all-clear, which is the live one.
//
// Reading the CHUNKS instead of the singletons fixes the first fail-open shape (#261: a singleton
// codesize cannot see a VaultCore change, because VaultCore's code is not in any singleton). But
// comparing the chunks by LENGTH walks straight into a second one, and it is not hypothetical:
//
//   chain 4663, VaultDeployer 0xc36198FD2c7C62738159ED1FF965679105FAF05a, read 2026-09-13
//   pinned creation code 22,391 B   local build 22,391 B   31 bytes differ, first at offset 22,348
//
// The differing run is solc's CBOR metadata trailer, which is FIXED LENGTH — so the BUSL-1.1 -> MIT
// relicense changed the bytes of every contract and the length of none. A size check reports that
// deployment as consistent. `contracts/config/deployments/robinhood-mainnet.json` makes the same
// point about itself under `bytecodeCurrency.whyThisAndNotCodesize`.
//
// These tests pin the byte comparison AS the verdict and the size as commentary. The measured
// numbers above are used verbatim, so if `compareVaultCoreChunks` is ever reverted to a length
// comparison, the fixture that goes red is the real deployment rather than an invented one.
// ---------------------------------------------------------------------------

/** Build a chunk's deployed code: SSTORE2's leading STOP byte, then the payload. */
const asChunk = (payloadHex) => '0x00' + payloadHex;

test('compareVaultCoreChunks strips one SSTORE2 STOP byte per chunk and matches byte for byte', () => {
  const a = 'aa'.repeat(100);
  const b = 'bb'.repeat(98);
  const c = compareVaultCoreChunks([asChunk(a), asChunk(b)], '0x' + a + b);
  assert.equal(c.pinnedBytes, 198, 'two chunks of 101 deployed bytes hold 198 bytes of payload');
  assert.equal(c.byteMatch, true);
  assert.equal(c.sizeMatch, true);
  assert.equal(c.differingBytes, 0);
});

test('SAME LENGTH, DIFFERENT BYTES is a MISMATCH — the size leg alone would pass it', () => {
  // The shape of the live chain-4663 drift, reduced: identical length, a differing trailer.
  const pinnedTail = '6f213debf6daff41';
  const localTail = '35a83f24dcdea084';
  const head = 'ab'.repeat(64);
  const c = compareVaultCoreChunks([asChunk(head), asChunk(pinnedTail)], '0x' + head + localTail);

  assert.equal(c.sizeMatch, true, 'the two builds are the same length — this is exactly the false all-clear');
  assert.equal(c.delta, 0, 'and the delta a size check reports is zero');
  assert.equal(c.byteMatch, false, 'but the bytes differ, so the deployed VaultCore is NOT this build');
  assert.equal(c.differingBytes, 8);
  assert.equal(c.firstDifferenceAt, 64);

  // The verdict an operator actually reads must say so, and must name the trap by name.
  const line = formatOnchainLine('robinhood-mainnet', c);
  assert.match(line, /MISMATCH/);
  assert.match(line, /SAME LENGTH, DIFFERENT BYTES/);
  assert.match(line, /codesize comparison would have passed this/);
});

test('a byte-identical deployment reports identical, and does not cry MISMATCH', () => {
  const head = 'ab'.repeat(64);
  const c = compareVaultCoreChunks([asChunk(head), asChunk('cd'.repeat(8))], '0x' + head + 'cd'.repeat(8));
  assert.equal(c.byteMatch, true);
  const line = formatOnchainLine('base-sepolia', c);
  assert.match(line, /byte-for-byte identical/);
  assert.doesNotMatch(line, /MISMATCH/);
});

test('a length difference is counted and reported, not silently truncated to the common prefix', () => {
  const c = compareVaultCoreChunks([asChunk('ab'.repeat(10)), asChunk('')], '0x' + 'ab'.repeat(7));
  assert.equal(c.sizeMatch, false);
  assert.equal(c.delta, 3);
  assert.equal(c.byteMatch, false);
  assert.equal(c.differingBytes, 3);
  assert.equal(c.firstDifferenceAt, 7);
  assert.doesNotMatch(formatOnchainLine('x', c), /SAME LENGTH/);
});

test('hex comparison is case- and 0x-insensitive (cast and solc disagree on both)', () => {
  const c = compareVaultCoreChunks(['0x00ABCDEF', '00abcdef'], 'ABCDEFabcdef');
  assert.equal(c.byteMatch, true, 'a case difference in hex is not a bytecode difference');
});

test('an unreadable on-chain leg reports SKIP — it never reports a match it did not make', () => {
  const line = formatOnchainLine('robinhood-mainnet', /** @type {any} */ ({ skipped: 'rpc read failed: timeout' }));
  assert.match(line, /SKIP/);
  assert.doesNotMatch(line, /identical|consistent/, 'a read that did not happen must not read as a pass');
});

test('the hard-coded chunk selectors still match VaultDeployer\'s getters', () => {
  // The script hard-codes these to stay dependency-free. If either getter is renamed, every
  // on-chain read silently becomes a revert and the --onchain half quietly stops checking
  // anything -- exactly the fail-open shape this project keeps paying for. So pin them.
  // Skipped rather than failed when foundry is absent: the check needs keccak, and a machine
  // without foundry cannot have produced a deployment for this script to read either.
  let castSig;
  try {
    castSig = (sig) => execFileSync('cast', ['sig', sig], { encoding: 'utf8' }).trim().toLowerCase();
    castSig('codeChunkA()');
  } catch {
    return; // foundry not on PATH
  }

  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-deployment-currency.mjs'), 'utf8');
  const found = Object.fromEntries(
    [...src.matchAll(/(codeChunk[AB]):\s*'(0x[0-9a-f]{8})'/g)].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(
    Object.keys(found).sort(),
    ['codeChunkA', 'codeChunkB'],
    'both selectors must be findable in the script',
  );
  assert.equal(found.codeChunkA, castSig('codeChunkA()'));
  assert.equal(found.codeChunkB, castSig('codeChunkB()'));

  // And the getters must actually exist on the contract the script reads.
  const deployer = fs.readFileSync(path.join(ROOT, 'contracts', 'src', 'VaultDeployer.sol'), 'utf8');
  assert.match(deployer, /address public immutable codeChunkA;/);
  assert.match(deployer, /address public immutable codeChunkB;/);
});
