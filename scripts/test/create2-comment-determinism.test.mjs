/**
 * A comment-only edit must not move a contract's bytes, because under CREATE2 a moved byte is a moved
 * address on every chain. This is the guard for `bytecode_hash = "none"` and `cbor_metadata = false`
 * in contracts/foundry.toml.
 *
 * It compiles a real contract from contracts/src (OperatorRegistry with its imports)
 * in scratch projects that use the repo's own foundry.toml, edits only comments and whitespace, and
 * compares creation code byte for byte. A control arm removes the two settings and runs the same edit:
 * there the bytes MUST move. Without the control arm a build that ignored foundry.toml would pass the
 * test for the wrong reason.
 *
 * It runs `forge build`, as scripts/gate.mjs and the CI backend job both have it available. A missing
 * forge fails the test; it does not skip.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/create2-manifest.mjs';

const SRC = path.join(ROOT, 'contracts', 'src');
// One real singleton keeps the four scratch builds cheap. The property is a build-setting property, not
// a per-contract one, and the manifest tests cover every singleton's bytes.
const FILES = ['OperatorRegistry.sol', 'interfaces/IOperatorRegistry.sol', 'lib/ProtocolInitializer.sol'];
const CONTRACTS = ['OperatorRegistry'];

/** @param {string} dir @param {string} toml */
function project(dir, toml) {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const f of FILES) {
    mkdirSync(path.dirname(path.join(dir, 'src', f)), { recursive: true });
    cpSync(path.join(SRC, f), path.join(dir, 'src', f));
  }
  writeFileSync(path.join(dir, 'foundry.toml'), toml);
}

/** Comment-only edit: a line comment after the pragma, a NatSpec line before the contract, trailing whitespace. */
function editComments(dir) {
  for (const f of FILES) {
    const p = path.join(dir, 'src', f);
    let s = readFileSync(p, 'utf8');
    s = s.replace('pragma solidity 0.8.26;', 'pragma solidity 0.8.26; // comment-only edit, line numbers shift');
    s = s.replace(/\n(\/\/\/ @title|contract |interface )/, '\n/// A NatSpec line added by the determinism test.\n$1');
    s += '\n// trailing comment\n';
    writeFileSync(p, s);
  }
}

/** @param {string} dir */
function build(dir) {
  execFileSync('forge', ['build', '--root', dir], { cwd: dir, stdio: 'pipe', timeout: 480_000, windowsHide: true });
  /** @type {Record<string, string>} */
  const out = {};
  for (const c of CONTRACTS) {
    out[c] = JSON.parse(readFileSync(path.join(dir, 'out', `${c}.sol`, `${c}.json`), 'utf8')).bytecode.object;
  }
  return out;
}

const repoToml = readFileSync(path.join(ROOT, 'contracts', 'foundry.toml'), 'utf8');
const tomlWithoutMetadataSettings = repoToml
  .split('\n')
  .filter((l) => !/^(bytecode_hash|cbor_metadata)\b/.test(l))
  .join('\n');

/** @param {string} toml @param {boolean} edit */
function buildVariant(toml, edit) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'create2-det-'));
  try {
    project(dir, toml);
    if (edit) editComments(dir);
    return build(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('control: WITHOUT the metadata settings a comment-only edit moves the bytes', { timeout: 900_000 }, () => {
  assert.notEqual(tomlWithoutMetadataSettings, repoToml, 'the control arm did not remove anything from foundry.toml');
  const before = buildVariant(tomlWithoutMetadataSettings, false);
  const after = buildVariant(tomlWithoutMetadataSettings, true);
  for (const c of CONTRACTS) {
    assert.notEqual(before[c], after[c], `${c}: bytes did not move under default metadata, so this test cannot detect the regression it guards`);
  }
});

test('WITH the repo settings a comment-only edit leaves every byte unchanged', { timeout: 900_000 }, () => {
  const before = buildVariant(repoToml, false);
  const after = buildVariant(repoToml, true);
  for (const c of CONTRACTS) {
    assert.ok(before[c].length > 100, `${c}: no creation code built`);
    assert.equal(after[c], before[c], `${c}: a comment-only edit moved the creation code, so it would move the CREATE2 address`);
  }
});
