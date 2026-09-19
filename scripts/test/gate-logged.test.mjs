// @ts-check
/**
 * `npm run gate:log` must keep the bytes that explain a red.
 *
 * THE FAILURE THIS CLOSES, precisely. On 2026-09-19 a gate run on a head under review reported
 * `GATE FAILED on backend`, and the six runs after it were clean. The failing test's name was never
 * captured — the only record of a gate run was what happened to be on screen, and the reviewer had
 * grepped the tail. The red could then neither be attributed nor dismissed, and a gate that reds at
 * random is this repository's own stated reason not to trust red. `.gate-state.json` records each
 * step's VERDICT and has never recorded its OUTPUT, which is the half you need when a step fails once.
 *
 * SO THE ASSERTION THAT MATTERS IS THE FAILING CASE, and it is the one a happy-path test would miss:
 * the log must contain the failing CHILD's own output, not merely the gate's summary line. A wrapper
 * that captured the verdict and dropped the child's stream would have left this week exactly where it
 * was.
 *
 * NOTHING IS INSTALLED OR UNINSTALLED. The failure is forced by putting a `forge` shim earlier on
 * PATH for one child process, and the steps used (`fmt`, `syntax`) never run forge for real and never
 * recurse into this suite.
 *
 * ONE DIRECTION THESE TESTS DO NOT COVER, SAID HERE RATHER THAN LEFT TO BE ASSUMED. The wrapper exits
 * from inside `log.end()`'s callback so a failing run cannot lose the bytes that explain it. Replacing
 * that with a bare `process.exit(code)` does NOT red below: at these output sizes the write has
 * already drained, so the truncation the flush prevents does not reproduce on demand. The measurement
 * is 0 of 4 failing under that mutation — the guard is the code's shape, not this file. Do not read
 * the green as coverage, and do not "simplify" the callback away because the tests stay green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const WRAPPER = path.join(REPO, 'scripts', 'gate-logged.mjs');
const LOG_DIR = path.join(REPO, '.gate-logs');
const WIN = process.platform === 'win32';

/** An env whose PATH has `prepend` in front. Every case-variant of the key is deleted first: on
 *  Windows the real key is `Path`, so setting `PATH` on a spread of process.env hands the child both. */
function envWith(prepend) {
  const env = { .../** @type {Record<string,string>} */ (process.env) };
  const current = env.PATH ?? env.Path ?? '';
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
  env.PATH = prepend ? `${prepend}${path.delimiter}${current}` : current;
  return env;
}

/** A `forge` that fails, ahead of the real one. A temp file: nothing is installed. */
function forgeShimDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-logged-forge-'));
  if (WIN) fs.writeFileSync(path.join(dir, 'forge.cmd'), '@echo off\r\necho SHIM_FORGE_MARKER\r\nexit /b 1\r\n');
  else {
    const f = path.join(dir, 'forge');
    fs.writeFileSync(f, '#!/bin/sh\necho SHIM_FORGE_MARKER\nexit 1\n');
    fs.chmodSync(f, 0o755);
  }
  return dir;
}

/** Run the wrapper, and return its status plus the log file it created. */
function runWrapper(args, env) {
  const before = new Set(fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : []);
  const r = spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 180_000,
    // Its own state file: the gates this spawns must not overwrite the repo's record, and must not
    // be read by another test file as if they were that file's own run. See GATE_STATE_PATH in
    // scripts/gate.mjs for the failure that forced this.
    env: { ...env, GATE_STATE_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-logged-state-')), 'state.json') },
  });
  const created = (fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : []).filter((f) => !before.has(f));
  assert.equal(created.length, 1, `expected exactly one new log file, got ${created.length}`);
  const logFile = path.join(LOG_DIR, created[0]);
  const log = fs.readFileSync(logFile, 'utf8');
  fs.rmSync(logFile, { force: true });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, log };
}

test('THE CASE THAT WAS MISSING: a failing step leaves the CHILD output on disk, not just the verdict', () => {
  const { status, out, log } = runWrapper(['--only', 'fmt'], envWith(forgeShimDir()));

  assert.equal(status, 1, 'the wrapper must exit with the gate own code, or CI reads a red as green');
  assert.match(log, /SHIM_FORGE_MARKER/, 'the failing child own output is the half that was lost; it must be in the log');
  assert.match(log, /GATE FAILED on fmt/, 'the verdict line too');
  assert.match(log, /# exit 1 at \d{4}-/, 'the log must record the exit code, so a truncated run is visible as truncated');
  assert.match(out, /full output: \.gate-logs\//, 'the console must say where the log is, or nobody reads it');
});

test('a passing run is captured too — the run BEFORE the re-run is the one you want to read', () => {
  const { status, log } = runWrapper(['--only', 'syntax'], envWith(null));
  assert.equal(status, 0);
  assert.match(log, /GATE PASSED/);
  assert.match(log, /# exit 0 at \d{4}-/);
  assert.match(log, /^# npm run gate --only syntax/m, 'the log must record which invocation produced it');
});

test('MUTATION-SHAPED: the log is the raw stream, so a filter cannot drop the line you needed', () => {
  // The defect being prevented is a wrapper that summarises. Both streams must survive verbatim, so
  // the gate's own per-step lines are present alongside the child's, in the same file.
  const { log } = runWrapper(['--only', 'syntax'], envWith(null));
  assert.match(log, /node --check \(entrypoints\)/, "the gate's step title");
  assert.ok(log.split('\n').length > 4, 'a one-line summary is not a capture');
});

test('the wrapper does not change what the gate decides — same exit code as the gate alone', () => {
  // If the wrapper could alter the verdict it would be worse than no capture at all.
  const env = envWith(forgeShimDir());
  const direct = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'gate.mjs'), '--only', 'fmt'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 180_000,
    env,
  });
  const wrapped = runWrapper(['--only', 'fmt'], env);
  assert.equal(wrapped.status, direct.status, 'wrapped and direct runs must agree on the exit code');
});
