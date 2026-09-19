// @ts-check
/**
 * A GATE PASS REQUIRES A STEP THAT EXECUTED, not a step that was SELECTED.
 *
 * #309 added a floor that refuses when the step list is empty. It guards the LIST; these tests
 * guard the OUTCOMES, which is the half it does not reach: `passed` was
 * `!results.some(r => r.state === 'fail')`, and **a `skip` is not a `fail`**. The one runtime skip
 * today is slither when it is absent from PATH, so `--only slither` on a machine without slither
 * selected one step, cleared #309's floor, skipped it, and printed GATE PASSED, exited 0 and wrote
 * `{"passed":true}` into `.gate-state.json` -- the file `scripts/lib/project-status.mjs` reads and
 * `npm run cc` presents as live state to a fresh session. A pass over zero executed checks.
 *
 * DRIVEN THROUGH THE REAL SCRIPT, not through an exported predicate. `verdictFor` is not exported
 * and deliberately so: the defect was never in a predicate, it was in the three publishers of the
 * verdict disagreeing -- console line, exit code, state file. A unit test on the predicate would
 * pass while any one of those still read a stale local. So every case below spawns
 * `scripts/gate.mjs` and asserts all three together.
 *
 * NOTHING IS INSTALLED OR UNINSTALLED. The skip is forced by dropping slither's own directory from
 * PATH for one child process, exactly as Product reproduced it; the failure is forced by a `forge`
 * shim earlier on PATH than the real one. The steps chosen (`slither`, `syntax`, `fmt`) never run
 * forge for real and never recurse into this suite, so the whole file stays under a few seconds.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('../gate.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const STATE = path.join(REPO, '.gate-state.json');
const WIN = process.platform === 'win32';

/**
 * `.gate-state.json` is this machine's real last-run record and is gitignored, but it is also what
 * `npm run cc` reads, so these tests must put it back exactly as they found it -- INCLUDING putting
 * back its absence, which a naive restore would turn into a file holding "undefined".
 */
/** @type {string | null} */
let saved = null;
before(() => {
  saved = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : null;
});
after(() => {
  if (saved === null) fs.rmSync(STATE, { force: true });
  else fs.writeFileSync(STATE, saved);
});

/** Directory holding a binary, or null when it is not installed. */
function dirOf(bin) {
  const r = spawnSync(WIN ? 'where' : 'which', [bin], { encoding: 'utf8' });
  const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first ? path.dirname(first) : null;
}

/**
 * An env whose PATH has `drop` removed and `prepend` added. Every case-variant of the key is
 * deleted first: on Windows the real key is `Path`, so setting `PATH` on a spread of `process.env`
 * would hand the child BOTH and leave which one wins to the platform.
 */
function envWithPath({ drop = null, prepend = null } = {}) {
  const env = { .../** @type {Record<string,string>} */ (process.env) };
  const current = env.PATH ?? env.Path ?? '';
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
  const parts = current.split(path.delimiter).filter(Boolean);
  const kept = drop ? parts.filter((d) => path.resolve(d).toLowerCase() !== path.resolve(drop).toLowerCase()) : parts;
  env.PATH = (prepend ? [prepend, ...kept] : kept).join(path.delimiter);
  return env;
}

/** Run the real gate, and read back all three things it publishes. */
function runGate(only, env) {
  fs.rmSync(STATE, { force: true });
  const r = spawnSync(process.execPath, [GATE, '--only', only], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
  return { status: r.status, out, state };
}

/** A `forge` that fails, ahead of the real one on PATH. Nothing is installed: it is a temp file. */
function forgeShimDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-executed-forge-'));
  if (WIN) fs.writeFileSync(path.join(dir, 'forge.cmd'), '@echo off\r\necho shim forge: deliberate failure\r\nexit /b 1\r\n');
  else {
    const f = path.join(dir, 'forge');
    fs.writeFileSync(f, '#!/bin/sh\necho "shim forge: deliberate failure"\nexit 1\n');
    fs.chmodSync(f, 0o755);
  }
  return dir;
}

test('THE DEFECT: every selected step skipped is NOT a pass -- exit 2, passed false, executed 0', () => {
  const { status, out, state } = runGate('slither', envWithPath({ drop: dirOf('slither') }));

  assert.equal(status, 2, 'an all-skip run must not exit 0; 2 is "the gate could not run"');
  assert.match(out, /GATE INCONCLUSIVE/, 'the console must not claim a verdict it does not have');
  assert.doesNotMatch(out, /GATE PASSED/);
  assert.ok(state, '.gate-state.json must still be written -- the board needs to know it ran');
  assert.equal(state.passed, false, 'the state file is what npm run cc reads; it may not say passed');
  assert.equal(state.executed, 0);
  assert.deepEqual(
    state.steps.map((s) => [s.id, s.state]),
    [['slither', 'skip']],
    'one step selected, one step skipped -- #309s floor is cleared and irrelevant here',
  );
});

test('MUTATION: a skip ALONGSIDE an executed step is still a pass -- the rule is zero executed, not any skip', () => {
  // A fix of "refuse whenever anything was skipped" would pass the test above and break every
  // normal run on a machine without slither, which is most of them.
  const { status, out, state } = runGate('slither,syntax', envWithPath({ drop: dirOf('slither') }));

  assert.equal(status, 0, out);
  assert.match(out, /GATE PASSED/);
  assert.doesNotMatch(out, /INCONCLUSIVE/);
  assert.equal(state.passed, true);
  assert.equal(state.executed, 1, 'the skipped step must not be counted as having run');
  // Steps run in STEPS order, not in --only order, so syntax comes before slither.
  assert.deepEqual(state.steps.map((s) => [s.id, s.state]), [['syntax', 'pass'], ['slither', 'skip']]);
});

test('MUTATION: a FAILING run is a failure, never inconclusive -- and `notrun` is not "executed"', () => {
  // The other way to get this wrong: classify by "did everything run" and a fail-fast break, which
  // fills the tail with `notrun`, would be reported as inconclusive instead of as the defect it is.
  const { status, out, state } = runGate('fmt,syntax', envWithPath({ prepend: forgeShimDir() }));

  assert.equal(status, 1, 'a real failure keeps exit 1; exit 2 means the gate could not run');
  assert.match(out, /GATE FAILED/);
  assert.doesNotMatch(out, /INCONCLUSIVE/);
  assert.equal(state.passed, false);
  assert.equal(state.executed, 1, 'the fmt fail ran; the syntax step never did');
  assert.deepEqual(state.steps.map((s) => [s.id, s.state]), [['fmt', 'fail'], ['syntax', 'notrun']]);
});

test('the board is told a run checked nothing, in words, not just as a false', async () => {
  // `passed: false` alone renders as FAILED, which is a different sentence from "checked nothing".
  const { collect } = await import('../lib/project-status.mjs');
  runGate('slither', envWithPath({ drop: dirOf('slither') }));
  const { gate } = collect({ gh: false });
  assert.ok(gate, 'the board must see the state file this run just wrote');
  assert.equal(gate.passed, false);
  assert.ok(
    gate.caveats.some((c) => /checked NOTHING/.test(c)),
    `caveats did not say the run checked nothing: ${JSON.stringify(gate.caveats)}`,
  );
});
