/**
 * The registry's import ceiling is a per-chain snapshot recorded in
 * contracts/config/agent-registry-create2.json, and the deploy preflight refuses while any entry is
 * missing, a placeholder or malformed.
 *
 * WHY THIS EXISTS. PR 454's security review showed that a ceiling read "as late as possible" lets
 * anyone farm outside ids at gas cost before the read and import them all free, so the ceiling is
 * now a value snapshotted at a recorded block before the deploy is announced. The contract cannot
 * check it (the outside registry has no next-id view), so this file is the check: the real record
 * must be complete, and the preflight must go red on every way an entry can be incomplete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { checkImportCeilings } from '../lib/registry-import-ceilings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CFG = path.join(REPO, 'contracts', 'config', 'agent-registry-create2.json');
const CLI = path.join(REPO, 'scripts', 'registry-deploy-preflight.mjs');
const real = () => JSON.parse(readFileSync(CFG, 'utf8'));

const entry = () => ({
  chainId: 5042,
  outsideRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  block: 26639726,
  nextId: 2537,
  readAt: '2026-10-18T17:40:33Z',
});
const fixture = (/** @type {Record<string, any>} */ over) => ({
  outsideRegistry: { 'arc-mainnet': '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' },
  importCeilings: { chains: { 'arc-mainnet': { ...entry(), ...over } } },
});

/// The salt in this record is mined (cast create2 --starts-with 1337), so it normally has no preimage.
/// A `saltPreimage` field, if one is ever added, must be the true preimage: the stale
/// "RWAllyAgentRegistry/1" survived the mining commit because nothing read the field.
test('a saltPreimage anywhere in the CREATE2 record hashes to the recorded salt', () => {
  const rec = real();
  assert.match(rec.salt, /^0x[0-9a-f]{64}$/i);
  const found = [];
  const walk = (/** @type {any} */ v) => {
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'saltPreimage') found.push(x);
        else walk(x);
      }
    }
  };
  walk(rec);
  for (const p of found) {
    assert.equal(typeof p, 'string', 'saltPreimage must be a string');
    assert.equal(keccak256(toBytes(p)), rec.salt, 'saltPreimage does not hash to the recorded salt');
  }
  assert.equal(typeof rec.saltMethod, 'string', 'a mined salt records how it was mined');
});

test('the recorded import ceilings are complete: no placeholder, every field valid', () => {
  const res = checkImportCeilings(real());
  assert.deepEqual(res.problems, []);
  assert.equal(res.ok, true);
  assert.ok(res.chains.length >= 1, 'non-vacuous: at least one chain is recorded');
  assert.ok(res.chains.includes('arc-mainnet'), 'Arc, the first deploy, has a snapshot');
});

test('every recorded chain pins the same outside registry the config names', () => {
  const cfg = real();
  for (const [key, e] of Object.entries(cfg.importCeilings.chains)) {
    assert.equal(/** @type {any} */ (e).outsideRegistry, cfg.outsideRegistry['arc-mainnet'], key);
  }
});

test('a complete fixture passes', () => {
  assert.equal(checkImportCeilings(fixture({})).ok, true);
});

test('a placeholder entry fails the preflight, however it is spelled', () => {
  for (const over of [
    { placeholder: true },
    { placeholder: false },
    { readAt: 'PLACEHOLDER' },
    { nextId: 'placeholder: snapshot pending' },
  ]) {
    const res = checkImportCeilings(fixture(over));
    assert.equal(res.ok, false, JSON.stringify(over));
    assert.match(res.problems.join('\n'), /placeholder/i, JSON.stringify(over));
  }
});

test('a missing section, an empty chain list or a malformed field fails', () => {
  assert.equal(checkImportCeilings({}).ok, false);
  assert.equal(checkImportCeilings({ importCeilings: { chains: {} } }).ok, false);
  for (const over of [
    { nextId: 0 },
    { nextId: -1 },
    { nextId: '2537' },
    { nextId: 2537.5 },
    { block: 0 },
    { block: '26639726' },
    { chainId: 0 },
    { readAt: '2026-10-18 17:40:33' },
    { readAt: '2026-13-45T00:00:00Z' },
    { readAt: undefined },
    { outsideRegistry: '0x1234' },
    { outsideRegistry: '0x0000000000000000000000000000000000000001' },
  ]) {
    assert.equal(checkImportCeilings(fixture(over)).ok, false, JSON.stringify(over));
  }
});

test('the CLI exits 0 on the real record and 1 on a record that still has a placeholder', () => {
  const ok = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /preflight ok/);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'registry-preflight-'));
  try {
    const bad = path.join(dir, 'cfg.json');
    writeFileSync(bad, JSON.stringify(fixture({ placeholder: true })));
    const red = spawnSync(process.execPath, [CLI, '--config', bad], { encoding: 'utf8' });
    assert.equal(red.status, 1);
    assert.match(red.stderr, /PREFLIGHT FAIL.*placeholder/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI prints the snapshotted ceiling for a chain, and refuses an unrecorded chain', () => {
  const cfg = real();
  const some = Object.keys(cfg.importCeilings.chains)[0];
  const out = spawnSync(process.execPath, [CLI, '--chain', some], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes(`importIdCeiling ${cfg.importCeilings.chains[some].nextId}`));
  const none = spawnSync(process.execPath, [CLI, '--chain', 'no-such-chain'], { encoding: 'utf8' });
  assert.equal(none.status, 1);
});
