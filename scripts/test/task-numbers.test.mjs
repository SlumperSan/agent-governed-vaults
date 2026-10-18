// @ts-check
/**
 * scripts/lib/task-numbers.mjs: numbers are permanent, allocation is safe across processes, and
 * only an explicit button moves a suggestion. Every test runs on a temp folder, never the vault.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ANSWER_CUSTOM_KEY, assignNumbers, movedStatusFor, reconcileAnsweredSuggestions, SUGGESTION_OPTIONS, withDirLock } from '../lib/task-numbers.mjs';

const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'task-numbers.mjs');

function tmpTasks() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tn-test-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const card = (dir, name, extra = '') => writeFileSync(path.join(dir, name), `---\ntitle: ${name}\nstatus: backlog\n${extra}---\nbody\n`);
const numOf = (dir, name) => Number(/^num:\s*(\d+)/m.exec(readFileSync(path.join(dir, name), 'utf8'))?.[1] ?? 0);

/** Delete the way the board does: move into _deleted/. */
function boardDelete(dir, name) {
  mkdirSync(path.join(dir, '_deleted'), { recursive: true });
  renameSync(path.join(dir, name), path.join(dir, '_deleted', name));
}

test('numbers files in name order and leaves numbered files alone', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'b.md');
    card(dir, 'a.md');
    card(dir, 'c.md', 'num: 7\n');
    const r = assignNumbers(dir);
    assert.equal(r.assigned, 2);
    assert.equal(numOf(dir, 'c.md'), 7);
    assert.equal(numOf(dir, 'a.md'), 8);
    assert.equal(numOf(dir, 'b.md'), 9);
    assert.equal(assignNumbers(dir).assigned, 0, 'idempotent');
  } finally { done(); }
});

test('a quoted num is recognised and no second num line is inserted', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md', 'num: "40"\n');
    card(dir, 'b.md');
    assignNumbers(dir);
    assert.equal((readFileSync(path.join(dir, 'a.md'), 'utf8').match(/^num:/gm) ?? []).length, 1);
    assert.equal(numOf(dir, 'b.md'), 41);
  } finally { done(); }
});

test('delete the highest-numbered task, then create one: the number is NOT reused', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md'); card(dir, 'b.md'); card(dir, 'c.md');
    assignNumbers(dir);
    assert.equal(numOf(dir, 'c.md'), 3);
    boardDelete(dir, 'c.md');
    card(dir, 'd.md');
    assignNumbers(dir);
    assert.equal(numOf(dir, 'd.md'), 4);
  } finally { done(); }
});

test('the high-water mark alone prevents reuse, even if the deleted file is gone for good', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md'); card(dir, 'b.md'); card(dir, 'c.md');
    assignNumbers(dir);
    unlinkSync(path.join(dir, 'c.md')); // removed by hand: nothing left on disk to scan
    card(dir, 'd.md');
    assignNumbers(dir);
    assert.equal(numOf(dir, 'd.md'), 4);
  } finally { done(); }
});

test('without a counter file, an archived _deleted number still raises the floor (existing vaults)', () => {
  const { dir, done } = tmpTasks();
  try {
    mkdirSync(path.join(dir, '_deleted'));
    card(path.join(dir, '_deleted'), 'old.md', 'num: 12\n');
    card(dir, 'a.md');
    assignNumbers(dir);
    assert.equal(numOf(dir, 'a.md'), 13);
  } finally { done(); }
});

test('the mark survives a restart: a fresh process continues from it', async () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md'); card(dir, 'b.md');
    assignNumbers(dir);
    unlinkSync(path.join(dir, 'b.md'));
    card(dir, 'c.md');
    const code = await runChild(dir);
    assert.equal(code, 0);
    assert.equal(numOf(dir, 'c.md'), 3);
  } finally { done(); }
});

function runChild(dir) {
  return new Promise((resolve, reject) => {
    const script = `import(${JSON.stringify('file:///' + MODULE.replace(/\\/g, '/'))}).then(m => { m.assignNumbers(${JSON.stringify(dir)}); });`;
    const p = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', resolve);
  });
}

test('concurrent allocation from several processes gives every file a unique number', async () => {
  const { dir, done } = tmpTasks();
  try {
    const N = 30;
    for (let i = 0; i < N; i += 1) card(dir, `t${String(i).padStart(2, '0')}.md`);
    const codes = await Promise.all([1, 2, 3, 4, 5].map(() => runChild(dir)));
    assert.deepEqual(codes, [0, 0, 0, 0, 0]);
    const nums = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => numOf(dir, f));
    assert.equal(nums.length, N);
    assert.equal(new Set(nums).size, N, `duplicate numbers: ${nums.join(',')}`);
    assert.deepEqual([...nums].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i + 1));
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      assert.equal((readFileSync(path.join(dir, f), 'utf8').match(/^num:/gm) ?? []).length, 1, `${f} has one num line`);
    }
    assert.equal(lockHeld(dir), false, 'lock released');
  } finally { done(); }
});

test('a stale lock from a crashed process is broken; a fresh one is waited out', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md');
    const lock = path.join(dir, '_task-numbers.lock.1');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    assignNumbers(dir);
    assert.equal(numOf(dir, 'a.md'), 1);
  } finally { done(); }
});

test('a missing Tasks folder is reported, not swallowed', () => {
  const r = assignNumbers(path.join(tmpdir(), 'tn-does-not-exist-' + process.pid));
  assert.ok(r.problem);
});

test('movedStatusFor: only an exact option label moves a card', () => {
  assert.equal(movedStatusFor('Approve - move to To do', SUGGESTION_OPTIONS), 'backlog');
  assert.equal(movedStatusFor('Decline', SUGGESTION_OPTIONS), 'done');
  assert.equal(movedStatusFor('Decline for now, revisit after launch', SUGGESTION_OPTIONS), '');
  assert.equal(movedStatusFor('Approve, but only the first half', SUGGESTION_OPTIONS), '');
  assert.equal(movedStatusFor('Approve the plan', ['Approve the plan', 'Hold']), 'backlog');
});

test('reconcile moves a button answer but leaves a free-text answer where it is', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'btn.md', 'answer: Approve - move to To do\n'); // status line is backlog; rewrite below
    for (const [name, answer] of [
      ['btn.md', 'Approve - move to To do'],
      ['free.md', 'Decline for now, revisit after launch'],
      ['free2.md', 'Approve in principle, but wait'],
    ]) {
      writeFileSync(path.join(dir, name), `---\ntitle: ${name}\nstatus: suggestion\nanswer: ${answer}\n---\n`);
    }
    const r = reconcileAnsweredSuggestions(dir);
    assert.deepEqual(r.moved, ['btn.md -> backlog']);
    assert.match(readFileSync(path.join(dir, 'free.md'), 'utf8'), /^status: suggestion$/m);
    assert.match(readFileSync(path.join(dir, 'free2.md'), 'utf8'), /^status: suggestion$/m);
  } finally { done(); }
});

// ── Typed answers ────────────────────────────────────────────────────────────────────────────────

test('reconcile leaves a TYPED answer that spells a button exactly; the same text without the mark moves', () => {
  const { dir, done } = tmpTasks();
  try {
    const write = (name, extra) => writeFileSync(path.join(dir, name), `---\ntitle: ${name}\nstatus: suggestion\nanswer: Decline\n${extra}---\n`);
    write('typed.md', `${ANSWER_CUSTOM_KEY}: true\n`);
    write('clicked.md', '');
    const r = reconcileAnsweredSuggestions(dir);
    assert.deepEqual(r.moved, ['clicked.md -> done']);
    assert.match(readFileSync(path.join(dir, 'typed.md'), 'utf8'), /^status: suggestion$/m);
    // idempotent: a second pass moves nothing
    assert.deepEqual(reconcileAnsweredSuggestions(dir).moved, []);
  } finally { done(); }
});

test('the custom mark in a BODY line does not shield a button answer', () => {
  const { dir, done } = tmpTasks();
  try {
    writeFileSync(path.join(dir, 'b.md'), `---\ntitle: b\nstatus: suggestion\nanswer: Decline\n---\n${ANSWER_CUSTOM_KEY}: true\n`);
    assert.deepEqual(reconcileAnsweredSuggestions(dir).moved, ['b.md -> done']);
  } finally { done(); }
});

// ── Lock ownership ───────────────────────────────────────────────────────────────────────────────

/** Generation 1 of the lock series; a takeover creates generation 2 and leaves this file in place. */
const LOCK = '_task-numbers.lock.1';
const lockFiles = (dir) => readdirSync(dir).filter((f) => f.startsWith('_task-numbers.lock')).sort();
/** Whether the highest-generation lock file is an owner record (held) rather than a release record. */
function lockHeld(dir) {
  const files = lockFiles(dir).sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop()));
  if (!files.length) return false;
  return JSON.parse(readFileSync(path.join(dir, files[files.length - 1]), 'utf8')).released !== true;
}
const age = (file, ms) => { const t = new Date(Date.now() - ms); utimesSync(file, t, t); };
const lockText = (pid, token = 'other-owner-token', host = hostname()) => JSON.stringify({ pid, host, token });
/** A pid that belonged to a process that has exited. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

test('a lock whose owner is ALIVE is not stolen at 31 s, however old by the old 30 s rule', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md');
    const lock = path.join(dir, LOCK);
    writeFileSync(lock, lockText(process.pid));
    age(lock, 31_000);
    assert.throws(() => assignNumbers(dir, { lockTimeoutMs: 300 }), /could not take/);
    assert.equal(numOf(dir, 'a.md'), 0, 'the section must not have run');
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'other-owner-token', 'the owner\'s lock is untouched');
  } finally { done(); }
});

test('a lock whose owner process is GONE is taken at once, though it is seconds old', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md');
    writeFileSync(path.join(dir, LOCK), lockText(deadPid()));
    const t0 = Date.now();
    assignNumbers(dir, { lockTimeoutMs: 5_000 });
    assert.ok(Date.now() - t0 < 2_000, 'a dead owner is not waited out');
    assert.equal(numOf(dir, 'a.md'), 1);
    assert.deepEqual(lockFiles(dir), [LOCK, `${LOCK.slice(0, -1)}2`, `${LOCK.slice(0, -1)}3`], 'nothing deleted: dead owner, the taker, its release record');
    assert.equal(JSON.parse(readFileSync(path.join(dir, LOCK), 'utf8')).token, 'other-owner-token', 'the dead owner record is untouched');
    assert.equal(lockHeld(dir), false);
  } finally { done(); }
});

test('a lock whose owner is alive IS broken once it is far older than any real section (recycled pid)', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md');
    const lock = path.join(dir, LOCK);
    writeFileSync(lock, lockText(process.pid));
    age(lock, 11 * 60_000);
    assignNumbers(dir, { lockTimeoutMs: 300 });
    assert.equal(numOf(dir, 'a.md'), 1);
  } finally { done(); }
});

test('a lock written on another host is not probed by pid: only the long margin breaks it', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md');
    const lock = path.join(dir, LOCK);
    writeFileSync(lock, lockText(deadPid(), 'tok', 'some-other-machine'));
    age(lock, 60_000);
    assert.throws(() => assignNumbers(dir, { lockTimeoutMs: 300 }), /could not take/);
    age(lock, 11 * 60_000);
    assignNumbers(dir, { lockTimeoutMs: 300 });
    assert.equal(numOf(dir, 'a.md'), 1);
  } finally { done(); }
});

test('an ownerless (empty) lock is waited out when fresh and broken after 30 s', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md');
    const lock = path.join(dir, LOCK);
    writeFileSync(lock, '');
    assert.throws(() => assignNumbers(dir, { lockTimeoutMs: 300 }), /could not take/);
    age(lock, 31_000);
    assignNumbers(dir, { lockTimeoutMs: 300 });
    assert.equal(numOf(dir, 'a.md'), 1);
  } finally { done(); }
});

test('the holder never overwrites a lock that another process now holds', () => {
  const { dir, done } = tmpTasks();
  try {
    const successor = path.join(dir, '_task-numbers.lock.2');
    withDirLock(dir, () => {
      // Simulate: our generation was judged dead and the next one taken by someone else while we were still inside.
      writeFileSync(successor, lockText(process.pid, 'someone-elses-token'));
    });
    assert.deepEqual(lockFiles(dir), ['_task-numbers.lock.1', '_task-numbers.lock.2']);
    assert.equal(JSON.parse(readFileSync(successor, 'utf8')).token, 'someone-elses-token', 'the successor record is untouched by our release');
  } finally { done(); }
});

test('the holder frees the lock on exit, including when the section throws, and no file name is ever reused', () => {
  const { dir, done } = tmpTasks();
  try {
    assert.throws(() => withDirLock(dir, () => { throw new Error('boom'); }), /boom/);
    assert.equal(lockHeld(dir), false);
    withDirLock(dir, () => assert.equal(lockHeld(dir), true), 50);
    assert.equal(lockHeld(dir), false);
    assert.deepEqual(lockFiles(dir), ['_task-numbers.lock.1', '_task-numbers.lock.2', '_task-numbers.lock.3', '_task-numbers.lock.4']);
  } finally { done(); }
});

// ── Taking over a stale lock: one winner, nothing deleted ─────────────────────────────────────────

// The scenario the round-2 review reproduced: a dead holder's lock AND a dead breaker file left
// behind, many processes released at the same instant. Under the old read-judge-rename takeover
// this issued duplicate numbers (1,1,2,2) at 8 processes. Leftovers are seeded in EVERY shape any
// version has used (the legacy single lock, its `.break` file, and a generation file), so the test
// is also red against a takeover that deletes or renames a file it only judged.
const STRESS_WORKERS = 8;
const STRESS_ROUNDS = Number(process.env.TN_STRESS_ROUNDS ?? 15);
const MODULE_URL = JSON.stringify('file:///' + MODULE.replace(/\\/g, '/'));

function seedDeadLeftovers(dir, round) {
  writeFileSync(path.join(dir, '_task-numbers.lock'), lockText(deadPid(), `dead-legacy-${round}`));
  writeFileSync(path.join(dir, '_task-numbers.lock.break'), lockText(deadPid(), `dead-breaker-${round}`));
  writeFileSync(path.join(dir, LOCK), lockText(deadPid(), `dead-gen-${round}`));
}

/** Run `script` in WORKERS fresh node processes, released together by a spin barrier. */
async function runWorkers(script, dir, startAt) {
  const codes = await Promise.all(Array.from({ length: STRESS_WORKERS }, (_, i) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', script(dir, startAt, i)], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', resolve);
  })));
  assert.deepEqual(codes, new Array(STRESS_WORKERS).fill(0));
}

const SECTION_WORKER = (dir, startAt) => `
import(${MODULE_URL}).then((m) => {
  const fs = require('node:fs');
  while (Date.now() < ${startAt}) { /* barrier: every worker hits the dead lock together */ }
  m.withDirLock(${JSON.stringify(dir)}, () => {
    const marker = ${JSON.stringify(path.join(dir, '_in-section'))};
    try { fs.closeSync(fs.openSync(marker, 'wx')); } catch { fs.appendFileSync(${JSON.stringify(path.join(dir, '_overlaps'))}, process.pid + '\\n'); }
    // A read-modify-write that hands out numbers, like allocate(): overlap shows as a repeated number.
    const seq = ${JSON.stringify(path.join(dir, '_seq'))};
    const n = fs.existsSync(seq) ? Number(fs.readFileSync(seq, 'utf8')) : 0;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4);
    fs.writeFileSync(seq, String(n + 1));
    fs.appendFileSync(${JSON.stringify(path.join(dir, '_issued'))}, (n + 1) + '\\n');
    try { fs.unlinkSync(marker); } catch {}
  });
}).catch((e) => { console.error(e); process.exit(1); });`;

test('8 processes racing for a dead owner\'s lock with a dead breaker beside it: one at a time, no overlap', async () => {
  const bad = [];
  for (let round = 0; round < STRESS_ROUNDS; round += 1) {
    const { dir, done } = tmpTasks();
    try {
      seedDeadLeftovers(dir, round);
      await runWorkers(SECTION_WORKER, dir, Date.now() + 600);
      const overlaps = existsSync(path.join(dir, '_overlaps')) ? readFileSync(path.join(dir, '_overlaps'), 'utf8').trim().split('\n').length : 0;
      const issued = readFileSync(path.join(dir, '_issued'), 'utf8').trim().split('\n');
      if (overlaps || new Set(issued).size !== STRESS_WORKERS) bad.push(`round ${round}: ${overlaps} overlaps, issued ${issued.join(',')}`);
    } finally { done(); }
  }
  assert.deepEqual(bad, [], `sections overlapped:\n${bad.join('\n')}`);
});

const ASSIGN_WORKER = (dir, startAt, i) => `
import(${MODULE_URL}).then((m) => {
  const fs = require('node:fs');
  fs.writeFileSync(${JSON.stringify(dir)} + '/w${i}.md', '---\\ntitle: w${i}\\nstatus: backlog\\n---\\nbody\\n');
  while (Date.now() < ${startAt}) { /* barrier */ }
  m.assignNumbers(${JSON.stringify(dir)}, { lockTimeoutMs: 20000 });
}).catch((e) => { console.error(e); process.exit(1); });`;

test('8 processes calling the real assignNumbers over dead leftovers never issue a task number twice', async () => {
  const bad = [];
  for (let round = 0; round < STRESS_ROUNDS; round += 1) {
    const { dir, done } = tmpTasks();
    try {
      seedDeadLeftovers(dir, round);
      await runWorkers(ASSIGN_WORKER, dir, Date.now() + 600);
      const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
      const nums = files.map((f) => numOf(dir, f)).sort((a, b) => a - b);
      const lines = files.map((f) => (readFileSync(path.join(dir, f), 'utf8').match(/^num:/gm) ?? []).length);
      if (files.length !== STRESS_WORKERS || new Set(nums).size !== STRESS_WORKERS || nums[0] < 1 || lines.some((n) => n !== 1)) {
        bad.push(`round ${round}: ${nums.join(',')}`);
      }
    } finally { done(); }
  }
  assert.deepEqual(bad, [], `duplicate or missing numbers:\n${bad.join('\n')}`);
});
