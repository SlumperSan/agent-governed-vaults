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
import { ANSWER_CUSTOM_KEY, assignNumbers, breakStaleLock, movedStatusFor, reconcileAnsweredSuggestions, SUGGESTION_OPTIONS, withDirLock } from '../lib/task-numbers.mjs';

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
    assert.ok(!existsSync(path.join(dir, '_task-numbers.lock')), 'lock released');
  } finally { done(); }
});

test('a stale lock from a crashed process is broken; a fresh one is waited out', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md');
    const lock = path.join(dir, '_task-numbers.lock');
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

const LOCK = '_task-numbers.lock';
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
    assert.ok(!existsSync(path.join(dir, LOCK)), 'released afterwards');
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

test('the holder never removes a lock that another process now holds', () => {
  const { dir, done } = tmpTasks();
  try {
    const lock = path.join(dir, LOCK);
    withDirLock(dir, () => {
      // Simulate: our lock was judged dead and replaced by someone else's while we were still inside.
      writeFileSync(lock, lockText(process.pid, 'someone-elses-token'));
    });
    assert.ok(existsSync(lock), 'the other owner\'s lock must survive our exit');
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'someone-elses-token');
  } finally { done(); }
});

test('the holder removes its own lock, including when the section throws', () => {
  const { dir, done } = tmpTasks();
  try {
    assert.throws(() => withDirLock(dir, () => { throw new Error('boom'); }), /boom/);
    assert.ok(!existsSync(path.join(dir, LOCK)));
  } finally { done(); }
});

// ── Taking over a stale lock: one winner ─────────────────────────────────────────────────────────

test('breakStaleLock removes a dead owner\'s lock, and only that exact lock', () => {
  const { dir, done } = tmpTasks();
  try {
    const lock = path.join(dir, LOCK);
    const dead = lockText(deadPid(), 'dead-token');
    writeFileSync(lock, dead);
    assert.equal(breakStaleLock(lock, dead), true);
    assert.ok(!existsSync(lock), 'stale lock removed');
    assert.ok(!existsSync(`${lock}.break`), 'breaker file released');
  } finally { done(); }
});

test('breakStaleLock never deletes a lock that changed hands since it was judged', () => {
  const { dir, done } = tmpTasks();
  try {
    const lock = path.join(dir, LOCK);
    const judged = lockText(deadPid(), 'dead-token');
    // Another stealer already took over and wrote its own LIVE lock before we got to remove ours.
    const live = lockText(process.pid, 'live-successor');
    writeFileSync(lock, live);
    assert.equal(breakStaleLock(lock, judged), false);
    assert.equal(readFileSync(lock, 'utf8'), live, 'the successor\'s lock is untouched');
    // Same text as judged, but now breakable by no rule (owner alive, young): re-judged, kept.
    writeFileSync(lock, live);
    assert.equal(breakStaleLock(lock, live), false);
    assert.equal(readFileSync(lock, 'utf8'), live);
  } finally { done(); }
});

test('only one breaker at a time: a live breaker file shuts every other process out', () => {
  const { dir, done } = tmpTasks();
  try {
    const lock = path.join(dir, LOCK);
    const dead = lockText(deadPid(), 'dead-token');
    writeFileSync(lock, dead);
    writeFileSync(`${lock}.break`, lockText(process.pid, 'someone-breaking'));
    assert.equal(breakStaleLock(lock, dead), false);
    assert.ok(existsSync(lock), 'lock kept while another process is breaking');
    assert.ok(existsSync(`${lock}.break`), 'the live breaker\'s file is not ours to remove');
  } finally { done(); }
});

test('a breaker file left by a process that died is reaped, then the lock can be taken', () => {
  const { dir, done } = tmpTasks();
  try {
    card(dir, 'a.md');
    const lock = path.join(dir, LOCK);
    writeFileSync(lock, lockText(deadPid(), 'dead-lock'));
    writeFileSync(`${lock}.break`, lockText(deadPid(), 'dead-breaker'));
    assignNumbers(dir, { lockTimeoutMs: 5_000 });
    assert.equal(numOf(dir, 'a.md'), 1);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.break')), [], 'no breaker or tombstone left');
  } finally { done(); }
});

const SECTION_WORKER = (dir, startAt) => `
import(${JSON.stringify('file:///' + MODULE.replace(/\\/g, '/'))}).then((m) => {
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
});`;

test('several processes racing for a dead owner\'s lock: exactly one at a time, no number issued twice', async () => {
  const ROUNDS = 25;
  const WORKERS = 3;
  const bad = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const { dir, done } = tmpTasks();
    try {
      writeFileSync(path.join(dir, LOCK), lockText(deadPid(), `dead-${round}`));
      const startAt = Date.now() + 400;
      const codes = await Promise.all(Array.from({ length: WORKERS }, () => new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ['-e', SECTION_WORKER(dir, startAt)], { stdio: 'ignore' });
        p.on('error', reject);
        p.on('close', resolve);
      })));
      assert.deepEqual(codes, new Array(WORKERS).fill(0));
      const overlaps = existsSync(path.join(dir, '_overlaps')) ? readFileSync(path.join(dir, '_overlaps'), 'utf8').trim().split('\n').length : 0;
      const issued = readFileSync(path.join(dir, '_issued'), 'utf8').trim().split('\n');
      if (overlaps || new Set(issued).size !== WORKERS) bad.push(`round ${round}: ${overlaps} overlaps, issued ${issued.join(',')}`);
      assert.ok(!existsSync(path.join(dir, LOCK)) && !existsSync(`${path.join(dir, LOCK)}.break`), 'lock and breaker released');
    } finally { done(); }
  }
  assert.deepEqual(bad, [], `sections overlapped:\n${bad.join('\n')}`);
});
