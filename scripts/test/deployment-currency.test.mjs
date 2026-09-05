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
  const r = checkDeploymentCurrency({chainName: 'base-sepolia', sourceCommit: 'abc1234'}, baseDeps);
  assert.equal(r.current, true);
  assert.deepEqual(r.changedPaths, []);
  assert.equal(r.hardFail, false);
  assert.match(formatResultLine(r), /^OK\b/);
});

test('contracts/src changed since sourceCommit -> BEHIND and a hard failure', () => {
  const changed = ['contracts/src/VaultCore.sol', 'contracts/src/VaultFactory.sol'];
  const r = checkDeploymentCurrency(
    {chainName: 'base-sepolia', sourceCommit: 'abc1234'},
    {...baseDeps, changedSourcePaths: () => changed},
  );
  assert.equal(r.current, false);
  assert.deepEqual(r.changedPaths, changed);
  assert.equal(r.hardFail, true);
  assert.match(formatResultLine(r), /^BEHIND\b/);
  assert.match(formatResultLine(r), /VaultCore\.sol/);
});

test('a long changed-path list is elided, and the elision states how many are hidden', () => {
  const changed = Array.from({length: 13}, (_, i) => `contracts/src/F${i}.sol`);
  const r = checkDeploymentCurrency({sourceCommit: 'abc1234'}, {...baseDeps, changedSourcePaths: () => changed});
  const line = formatResultLine(r, 6);
  assert.match(line, /13 contracts\/src path\(s\) changed/);
  assert.match(line, /\+7 more/);
});

test('no sourceCommit recorded -> SKIP, and git is never consulted', () => {
  const r = checkDeploymentCurrency(
    {chainName: 'base-mainnet'},
    {...baseDeps, gitResolves: neverCalled('gitResolves'), changedSourcePaths: neverCalled('changedSourcePaths')},
  );
  assert.equal(r.sourceCommit, '(none)');
  assert.equal(r.current, null);
  assert.equal(r.hardFail, false);
  assert.match(formatResultLine(r), /^SKIP\b/);
});

test('unresolvable sourceCommit -> SKIP with a note, not this script\'s failure', () => {
  // Reproducibility owns that failure; double-reporting it here would make one defect look like two.
  const r = checkDeploymentCurrency(
    {chainName: 'base-sepolia', sourceCommit: 'deadbee'},
    {...baseDeps, gitResolves: () => false, changedSourcePaths: neverCalled('changedSourcePaths')},
  );
  assert.equal(r.current, null);
  assert.equal(r.hardFail, false);
  assert.match(r.notes.join(' '), /does not resolve/);
});

test('missing mainline ref -> refuses to answer rather than defaulting to "current"', () => {
  const r = checkDeploymentCurrency(
    {chainName: 'base-sepolia', sourceCommit: 'abc1234'},
    {...baseDeps, haveMainline: false, changedSourcePaths: neverCalled('changedSourcePaths')},
  );
  assert.equal(r.current, null);
  assert.equal(r.hardFail, false);
  assert.match(r.notes.join(' '), /not present/);
});

test('allowSubVaults=true is an advisory note, never a hard failure on its own', () => {
  const cfg = {
    chainName: 'base-sepolia',
    sourceCommit: 'abc1234',
    verifiedWiring: {'factory.allowSubVaults()': true},
  };
  const r = checkDeploymentCurrency(cfg, baseDeps);
  assert.equal(r.hardFail, false, 'a config divergence must not be laundered into a staleness failure');
  assert.match(r.notes.join(' '), /allowSubVaults\(\) = true/);
  assert.match(r.notes.join(' '), /DIFFERENT configuration/);
});

test('allowSubVaults=false (the launch configuration) produces no note', () => {
  assert.deepEqual(launchConfigNotes({verifiedWiring: {'factory.allowSubVaults()': false}}), []);
});

test('a record with no verifiedWiring produces no note (absent is not false)', () => {
  assert.deepEqual(launchConfigNotes({}), []);
  assert.deepEqual(launchConfigNotes({verifiedWiring: {}}), []);
});

test('notes survive onto a SKIP result -- a divergence is worth saying even when currency is unknown', () => {
  const r = checkDeploymentCurrency(
    {chainName: 'base-sepolia', verifiedWiring: {'factory.allowSubVaults()': true}},
    baseDeps,
  );
  assert.equal(r.current, null);
  assert.match(r.notes.join(' '), /allowSubVaults/);
});

test('compareVaultCoreChunks subtracts one SSTORE2 STOP byte per chunk', () => {
  // Two 100-byte chunks hold 198 bytes of payload, because SSTORE2 prepends 0x00 to each.
  const c = compareVaultCoreChunks([100, 100], 198);
  assert.equal(c.pinnedBytes, 198);
  assert.equal(c.delta, 0);
  assert.equal(c.match, true);
});

test('compareVaultCoreChunks reports the signed delta when the deployed code is larger', () => {
  // The real 2026-09-01 measurement: 13,039 B per chunk pinned vs a 22,391 B local build.
  const c = compareVaultCoreChunks([13039, 13039], 22391);
  assert.equal(c.pinnedBytes, 26076);
  assert.equal(c.delta, 3685);
  assert.equal(c.match, false);
});

test('anyHardFail is true when any single record is behind', () => {
  const ok = checkDeploymentCurrency({sourceCommit: 'a'}, baseDeps);
  const behind = checkDeploymentCurrency(
    {sourceCommit: 'b'},
    {...baseDeps, changedSourcePaths: () => ['contracts/src/VaultCore.sol']},
  );
  assert.equal(anyHardFail([ok, ok]), false);
  assert.equal(anyHardFail([ok, behind]), true);
});

test('the hard-coded chunk selectors still match VaultDeployer\'s getters', () => {
  // The script hard-codes these to stay dependency-free. If either getter is renamed, every
  // on-chain read silently becomes a revert and the --onchain half quietly stops checking
  // anything -- exactly the fail-open shape this project keeps paying for. So pin them.
  // Skipped rather than failed when foundry is absent: the check needs keccak, and a machine
  // without foundry cannot have produced a deployment for this script to read either.
  let castSig;
  try {
    castSig = (sig) => execFileSync('cast', ['sig', sig], {encoding: 'utf8'}).trim().toLowerCase();
    castSig('codeChunkA()');
  } catch {
    return; // foundry not on PATH
  }

  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-deployment-currency.mjs'), 'utf8');
  const found = Object.fromEntries(
    [...src.matchAll(/(codeChunk[AB]):\s*'(0x[0-9a-f]{8})'/g)].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(Object.keys(found).sort(), ['codeChunkA', 'codeChunkB'], 'both selectors must be findable in the script');
  assert.equal(found.codeChunkA, castSig('codeChunkA()'));
  assert.equal(found.codeChunkB, castSig('codeChunkB()'));

  // And the getters must actually exist on the contract the script reads.
  const deployer = fs.readFileSync(path.join(ROOT, 'contracts', 'src', 'VaultDeployer.sol'), 'utf8');
  assert.match(deployer, /address public immutable codeChunkA;/);
  assert.match(deployer, /address public immutable codeChunkB;/);
});
