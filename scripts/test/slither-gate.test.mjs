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
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
// The Windows fake is a ~92 MB node.exe; leaving this directory behind leaked it on every run. It is
// removed even when a test fails, and the hook itself asserts it is gone.
after(() => {
  rmSync(dir, { recursive: true, force: true });
  assert.ok(!existsSync(dir), `temp dir ${dir} was not removed`);
});
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

// ---- behavioural: the gate itself, with a fake slither first on PATH ------------------------------
// The text assertions above cannot see whether gate.mjs CALLS runSlitherStep: deleting the dispatch
// branch left them green while the step exited 0 on any tree. This runs the real gate end to end.
// The fake is node itself (a shell script on POSIX; a hard link (or copy) of node.exe named slither.exe plus a
// preload on Windows, because a .cmd wrapper cannot take the filter regex's "|" through cmd.exe).
const FAKE = path.join(dir, 'fake-slither.cjs');
writeFileSync(
  FAKE,
  `const fs = require('node:fs'), path = require('node:path');
const shim = /^slither([.]exe)?$/i.test(path.basename(process.argv0));
if (shim || require.main === module) {
  const i = process.argv.indexOf('--json');
  if (i < 0) { console.error('fake slither: no --json argument'); process.exit(3); }
  fs.copyFileSync(process.env.FAKE_SLITHER_REPORT, process.argv[i + 1]);
  process.exit(0);
}
`,
);
const binDir = path.join(dir, 'bin');
mkdirSync(binDir);
const fakeEnv = { NODE_OPTIONS: '' };
if (process.platform === 'win32') {
  // Hard link where the volume allows it (no 92 MB copy); copy otherwise. Removing the link leaves node.exe alone.
  try {
    linkSync(process.execPath, path.join(binDir, 'slither.exe'));
  } catch {
    copyFileSync(process.execPath, path.join(binDir, 'slither.exe'));
  }
  fakeEnv.NODE_OPTIONS = `--require "${FAKE.split(path.sep).join('/')}"`;
} else {
  const sh = path.join(binDir, 'slither');
  writeFileSync(sh, `#!/bin/sh
exec "${process.execPath}" "${FAKE}" "$@"
`);
  chmodSync(sh, 0o755);
}
const gateWith = (reportFile) =>
  spawnSync(process.execPath, [path.join(REPO, 'scripts', 'gate.mjs'), '--only', 'slither'], {
    encoding: 'utf8',
    cwd: REPO,
    env: {
      ...process.env,
      ...fakeEnv,
      PATH: binDir + path.delimiter + process.env.PATH,
      FAKE_SLITHER_REPORT: reportFile,
      GATE_STATE_PATH: path.join(dir, 'gate-state.json'),
    },
  });
// A report with exactly the committed baseline's findings, rebuilt from contracts/slither-baseline.json.
const baselineReport = () => {
  const entries = JSON.parse(read('contracts/slither-baseline.json')).entries;
  const detectors = [];
  for (const [key, { count }] of Object.entries(entries)) {
    const [chk, rest] = key.split('::');
    const dot = rest.indexOf('.');
    for (let n = 0; n < count; n++) {
      detectors.push(
        dot < 0
          ? { check: chk, elements: [{ type: 'contract', name: rest, type_specific_fields: {} }] }
          : finding(chk, rest.slice(0, dot), rest.slice(dot + 1)),
      );
    }
  }
  return { success: true, results: { detectors } };
};

test('gate --only slither: a successful report with zero findings FAILS the gate (dispatch + baseline + floor, end to end)', () => {
  const r = gateWith(writeJson('gate-empty.json', { success: true, results: { detectors: [] } }));
  assert.equal(r.status, 1, 'an empty slither report must fail the gate: ' + r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /ZERO findings/);
});

test('gate --only slither: a report matching the committed baseline exactly PASSES the gate (control)', () => {
  const r = gateWith(writeJson('gate-baseline.json', baselineReport()));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /GATE PASSED/);
});

test('DEFAULT_ROSTER in verdicts.mjs equals defaultRoster.reviewers in merge-policy.json', () => {
  const policy = JSON.parse(read('scripts/lib/merge-policy.json'));
  assert.ok(Array.isArray(policy.defaultRoster?.reviewers), 'merge-policy.json has no defaultRoster.reviewers array');
  assert.ok(DEFAULT_ROSTER.length > 0, 'DEFAULT_ROSTER is empty');
  assert.deepEqual([...DEFAULT_ROSTER], policy.defaultRoster.reviewers);
});
