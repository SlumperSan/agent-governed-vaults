// @ts-check
/**
 * The Slither gate must be able to fail, locally and in CI, and the review roster default must not
 * drift between the code and the policy file.
 *
 * Follow-ups from the independent review of #436 and #437 (2026-10-09):
 *   - the baseline check passed a SUCCESSFUL report with ZERO findings, so a `--filter-paths` typo
 *     would have silently disarmed the gate (a floor);
 *   - `scripts/gate.mjs` still described Slither as advisory and no longer mirrored CI's job;
 *   - nothing stopped `continue-on-error` returning to the slither job;
 *   - `DEFAULT_ROSTER` in verdicts.mjs and `defaultRoster` in merge-policy.json were not pinned to
 *     each other by any test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROSTER } from '../lib/verdicts.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = path.join(REPO, 'contracts', 'scripts', 'slither_baseline_check.py');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

// A guard that can skip is a guard that will: no Python is a failure here, not a skip. CI's backend
// job runs on ubuntu-latest, which ships python3.
const PYTHON = (() => {
  for (const bin of ['python3', 'python']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  throw new Error('neither python3 nor python runs; the slither baseline check cannot be exercised');
})();

const dir = mkdtempSync(path.join(os.tmpdir(), 'slither-gate-test-'));
const writeJson = (name, value) => {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
};
const finding = (check, contract, fn) => ({
  check,
  elements: [
    {
      type: 'function',
      name: fn,
      type_specific_fields: { parent: { type: 'contract', name: contract } },
    },
  ],
});
const baseline = writeJson('baseline.json', {
  entries: { 'reentrancy-events::Vault.withdraw': { count: 1, reason: 'test' } },
});
const check = (report) => spawnSync(PYTHON, [CHECK, report, baseline], { encoding: 'utf8' });

test('baseline check: a report whose findings are all in the baseline passes (control)', () => {
  const r = check(writeJson('ok.json', { success: true, results: { detectors: [finding('reentrancy-events', 'Vault', 'withdraw')] } }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('baseline check: a finding the baseline does not cover fails', () => {
  const r = check(
    writeJson('new.json', {
      success: true,
      results: { detectors: [finding('reentrancy-events', 'Vault', 'withdraw'), finding('timestamp', 'Vault', 'deposit')] },
    }),
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test('baseline check: a failed Slither report fails', () => {
  const r = check(writeJson('failed.json', { success: false, error: 'boom', results: {} }));
  assert.notEqual(r.status, 0);
});

test('baseline check: a successful report with ZERO findings fails (the floor)', () => {
  for (const [name, results] of [
    ['empty-detectors.json', { detectors: [] }],
    ['no-detectors-key.json', {}],
  ]) {
    const r = check(writeJson(name, { success: true, results }));
    assert.notEqual(r.status, 0, `${name}: an empty successful report must not pass`);
    assert.match(r.stderr, /ZERO findings/, name);
  }
});

test('gate.mjs mirrors the slither job in ci.yml and is not advisory', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = ci.slice(ci.indexOf('\n  slither:\n'), ci.indexOf('\n  backend:\n'));
  assert.ok(job.length > 100, 'could not isolate the slither job in ci.yml');
  const live = job.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  // Tripwire: the required slither check must never become unable to fail again.
  assert.doesNotMatch(live, /continue-on-error/, 'the slither job in ci.yml must not carry continue-on-error');
  assert.match(live, /slither_baseline_check\.py/, 'the slither job must grade its report with the baseline check');

  const ciFilter = live.match(/--filter-paths\s+"([^"]+)"/)?.[1];
  assert.ok(ciFilter, 'no --filter-paths in the ci.yml slither job');

  const gate = read('scripts/gate.mjs');
  const start = gate.indexOf("id: 'slither'");
  assert.ok(start > 0, "no slither step in scripts/gate.mjs");
  const step = gate.slice(start, gate.indexOf('\n  },', start));
  assert.ok(step.includes(`'${ciFilter}'`), `gate.mjs must use CI's filter ${ciFilter}`);
  assert.ok(step.includes("'--fail-none'"), 'gate.mjs must pass --fail-none as CI does');
  assert.ok(step.includes("'--json'"), 'gate.mjs must write the JSON report the baseline check reads');
  assert.doesNotMatch(step, /advisory:\s*true/, 'the slither step must not be advisory');
  const fn = gate.slice(gate.indexOf('async function runSlitherStep'), gate.indexOf('async function runSyntaxStep'));
  assert.ok(fn.includes("'scripts/slither_baseline_check.py'"), 'runSlitherStep must run the baseline check');
  assert.doesNotMatch(gate, /Advisory in CI too|advisory in CI too/, 'stale advisory text in gate.mjs');
});

test('DEFAULT_ROSTER in verdicts.mjs equals defaultRoster.reviewers in merge-policy.json', () => {
  const policy = JSON.parse(read('scripts/lib/merge-policy.json'));
  assert.ok(Array.isArray(policy.defaultRoster?.reviewers), 'merge-policy.json has no defaultRoster.reviewers array');
  assert.ok(DEFAULT_ROSTER.length > 0, 'DEFAULT_ROSTER is empty');
  assert.deepEqual([...DEFAULT_ROSTER], policy.defaultRoster.reviewers);
});
