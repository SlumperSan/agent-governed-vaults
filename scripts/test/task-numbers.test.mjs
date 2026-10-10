// @ts-check
/**
 * scripts/lib/task-numbers.mjs: numbers are permanent, allocation is safe across processes, and
 * only an explicit button moves a suggestion. Every test runs on a temp folder, never the vault.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assignNumbers, movedStatusFor, reconcileAnsweredSuggestions, SUGGESTION_OPTIONS } from '../lib/task-numbers.mjs';

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
