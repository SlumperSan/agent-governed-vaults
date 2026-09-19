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
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('../gate.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const WIN = process.platform === 'win32';

/**
 * EACH RUN GETS ITS OWN STATE FILE, AND THAT REPLACED A SAVE-AND-RESTORE THAT COULD NOT WORK.
 *
 * These tests used to let the gate write repo-global `.gate-state.json` and put the old contents
 * back afterwards. Restoring is not the problem; SHARING is. The path is repo-global, so a gate
 * spawned by any other test file in the same parallel `node --test` invocation overwrites it, and a
 * test that spawns a gate and then reads the file gets whichever run finished last. It failed
 * exactly that way — `caveats did not say the run checked nothing: ["was --only fmt"]`, another
 * file's run read as if it were its own — intermittently, which is the worst version.
 *
 * So every child here is pointed at its own temp file through `GATE_STATE_PATH`, and nothing in THIS
 * FILE touches the repo's real record — which is why there is nothing to restore.
 *
 * THAT IS A PROPERTY OF THIS FILE, NOT OF "A TEST RUN", and the distinction was a review finding
 * against an earlier draft of this comment. `GATE_STATE_PATH` is opt-in: a third test file that
 * spawns `gate.mjs` without it would write the repo-global record and could be read by this one. What
 * makes the isolation construction rather than convention is the guard in
 * `scripts/test/test-wiring-truth.test.mjs` that fails when a file spawns `gate.mjs` without setting
 * the variable. Concurrent REAL gates — two terminals — still share one record by design, because
 * `npm run cc` has to have one file to read.
 */
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-executed-state-'));
let stateSeq = 0;
after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

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

/**
 * ASSERT THE ENVIRONMENT THESE TESTS ASSUME, in the child's own PATH, before trusting a result from
 * it. Dropping slither's DIRECTORY is coarse: it is `.../Python314/Scripts` on this machine but a
 * shared `/usr/local/bin` or `~/.local/bin` on a pip-installed CI runner, where the same drop could
 * take `forge` with it. The gate's missing-forge preflight also exits 2, so that would turn "the
 * all-skip run exits 2" green FOR THE WRONG REASON -- the single most expensive shape of passing
 * test. Checked, not assumed, and it fails naming the collision rather than skipping itself.
 */
function assertPathShape(env, { forgePresent = true, slitherAbsent = true } = {}) {
  const find = (bin) => {
    const r = spawnSync(WIN ? 'where' : 'which', [bin], { encoding: 'utf8', env });
    return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
  };
  if (forgePresent) {
    assert.ok(find('forge'), 'forge must still be on the child PATH, or the gate exits 2 on its preflight instead');
  }
  if (slitherAbsent) {
    assert.equal(find('slither'), null, 'slither must be absent from the child PATH, or it runs instead of skipping');
  }
}

/** Run the real gate against a state file nobody else writes, and read back all three publishers. */
function runGate(only, env) {
  const statePath = path.join(stateDir, `gate-state-${++stateSeq}.json`);
  const r = spawnSync(process.execPath, [GATE, '--only', only], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...env, GATE_STATE_PATH: statePath },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
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
  const env = envWithPath({ drop: dirOf('slither') });
  assertPathShape(env);
  const { status, out, state } = runGate('slither', env);

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
  const env = envWithPath({ drop: dirOf('slither') });
  assertPathShape(env);
  const { status, out, state } = runGate('slither,syntax', env);

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
  // The shim IS forge here, deliberately: only that the name resolves is asserted.
  const env = envWithPath({ prepend: forgeShimDir() });
  assertPathShape(env, { slitherAbsent: false });
  const { status, out, state } = runGate('fmt,syntax', env);

  assert.equal(status, 1, 'a real failure keeps exit 1; exit 2 means the gate could not run');
  assert.match(out, /GATE FAILED/);
  assert.doesNotMatch(out, /INCONCLUSIVE/);
  assert.equal(state.passed, false);
  assert.equal(state.executed, 1, 'the fmt fail ran; the syntax step never did');
  assert.deepEqual(state.steps.map((s) => [s.id, s.state]), [['fmt', 'fail'], ['syntax', 'notrun']]);
});

test('the board is told a run checked nothing, in words, not just as a false', async () => {
  // `passed: false` alone renders as FAILED, which is a different sentence from "checked nothing".
  //
  // ASSERTED ON THE SNAPSHOT THIS RUN PRODUCED, NOT BY RE-READING THE FILE. The earlier version
  // called `collect()`, which re-reads repo-global `.gate-state.json` — and any other process
  // running a gate rewrites it. A gate spawned by `gate-logged.test.mjs` in the same parallel
  // `node --test` invocation did exactly that, and this test failed with
  // `caveats did not say the run checked nothing: ["was --only fmt"]`: another file's run, read as
  // if it were its own. The state object is captured by `runGate` the moment the child exits and
  // `gateCaveats` is pure, so there is no window left to race.
  const { gateCaveats } = await import('../lib/project-status.mjs');
  const env = envWithPath({ drop: dirOf('slither') });
  assertPathShape(env);
  const { state } = runGate('slither', env);
  assert.ok(state, 'the run must have written a state file for the board to read');
  assert.equal(state.passed, false);
  // THE HEAD IS READ, NOT BORROWED FROM THE RECORD. An earlier draft passed `state.commit` as the
  // head, which makes `sameCommit` true by construction and the DIFFERENT-commit assertion below
  // tautological -- a review mutation set `sameCommit = true` unconditionally and this test stayed
  // green. Both directions are asserted against a real sha and a deliberately wrong one.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  assert.match(head, /^[0-9a-f]{40}$/, 'could not read a real HEAD to compare the record against');

  const onHead = gateCaveats(state, head);
  assert.ok(
    onHead.caveats.some((c) => /checked NOTHING/.test(c)),
    `caveats did not say the run checked nothing: ${JSON.stringify(onHead.caveats)}`,
  );
  assert.equal(state.commit, head, 'the run recorded a different commit than HEAD; the tree moved mid-test');
  assert.ok(!onHead.caveats.some((c) => /DIFFERENT commit/.test(c)), 'the shas agree, so that caveat must be absent');
  assert.equal(onHead.sameCommit, true);

  const elsewhere = gateCaveats(state, '0'.repeat(40));
  assert.ok(
    elsewhere.caveats.some((c) => /DIFFERENT commit/.test(c)),
    'a record from another commit must say so, or a board green means nothing about this tree',
  );
  assert.equal(elsewhere.sameCommit, false);
});

test('F2: the board WIRES gateCaveats in, not merely defines it', async () => {
  // `gate()` is what the board calls, and the caveats reach it through one `Object.assign`. A review
  // mutation deleted that line and every test still passed: the pure function was covered and its
  // only caller was not. This drives the real reader, through the same `GATE_STATE_PATH` the writer
  // honours, so the wiring is what is under test rather than the arithmetic.
  const { collect } = await import('../lib/project-status.mjs');
  const statePath = path.join(stateDir, 'wiring-state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      at: new Date().toISOString(),
      commit: '0'.repeat(40),
      treeDirty: false,
      totalMs: 1,
      mode: { quick: false, runAll: false, only: null },
      passed: false,
      executed: 0,
      steps: [{ id: 'slither', state: 'skip', ms: 0 }],
    }),
  );
  const before = process.env.GATE_STATE_PATH;
  process.env.GATE_STATE_PATH = statePath;
  try {
    const { gate } = collect({ gh: false });
    assert.ok(gate, 'the board must read the record at GATE_STATE_PATH');
    assert.ok(Array.isArray(gate.caveats), 'gate() must attach caveats; nothing else in the board computes them');
    assert.ok(gate.caveats.some((c) => /checked NOTHING/.test(c)), JSON.stringify(gate.caveats));
    assert.ok(gate.caveats.some((c) => /DIFFERENT commit/.test(c)), JSON.stringify(gate.caveats));
    assert.equal(gate.sameCommit, false);
  } finally {
    if (before === undefined) delete process.env.GATE_STATE_PATH;
    else process.env.GATE_STATE_PATH = before;
  }
});
