// @ts-check
/**
 * Script helpers with no direct test of their own: `parseVerdicts` (scripts/lib/verdicts.mjs),
 * `parseList` (scripts/lib/task-numbers.mjs), and `retractedLines`, `commitsBehind` and
 * `prStateBlocker` (scripts/lib/doc-claims.mjs). The git-reading ones run against throwaway
 * repositories under the OS temp directory, never against this checkout.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseVerdicts } from '../lib/verdicts.mjs';
import { parseList } from '../lib/task-numbers.mjs';
import { commitsBehind, prStateBlocker, retractedLines } from '../lib/doc-claims.mjs';

// ── parseVerdicts ─────────────────────────────────────────────────────────────

test('parseVerdicts reads every well-formed token, in comment then body order', () => {
  const comments = [
    { body: 'intro\n<!-- REVIEW-VERDICT reviewer=sec-1 verdict=REJECT -->', createdAt: '2026-01-01T00:00:00Z' },
    {
      body: '<!--REVIEW-VERDICT reviewer=a.b_c-d verdict=ACCEPT-->\ntext\n<!-- REVIEW-VERDICT reviewer=x verdict=ACCEPT -->',
      createdAt: '2026-01-02T00:00:00Z',
    },
  ];
  assert.deepEqual(parseVerdicts(/** @type {any} */ (comments)), [
    { reviewer: 'sec-1', verdict: 'REJECT', at: '2026-01-01T00:00:00Z' },
    { reviewer: 'a.b_c-d', verdict: 'ACCEPT', at: '2026-01-02T00:00:00Z' },
    { reviewer: 'x', verdict: 'ACCEPT', at: '2026-01-02T00:00:00Z' },
  ]);
});

test('parseVerdicts ignores malformed tokens and prose', () => {
  const comments = [
    { body: '<!-- REVIEW-VERDICT reviewer=a verdict=Accept -->', createdAt: 't' },
    { body: '<!-- REVIEW-VERDICT reviewer=a verdict=APPROVE -->', createdAt: 't' },
    { body: 'REVIEW-VERDICT reviewer=a verdict=ACCEPT', createdAt: 't' },
    { body: '## Review: ACCEPT', createdAt: 't' },
  ];
  assert.deepEqual(parseVerdicts(/** @type {any} */ (comments)), []);
  assert.deepEqual(parseVerdicts([]), []);
});

test('parseVerdicts is stable across repeated calls (the global regex is reset)', () => {
  const c = /** @type {any} */ ([{ body: '<!-- REVIEW-VERDICT reviewer=a verdict=ACCEPT -->', createdAt: 't' }]);
  assert.equal(parseVerdicts(c).length, 1);
  assert.equal(parseVerdicts(c).length, 1);
});

// ── parseList ─────────────────────────────────────────────────────────────────

test('parseList reads bracketed and bare frontmatter lists', () => {
  assert.deepEqual(parseList('["a", "b"]'), ['a', 'b']);
  assert.deepEqual(parseList("['a','b']"), ['a', 'b']);
  assert.deepEqual(parseList('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseList('  [ x ]  '), ['x']);
});

test('parseList drops empties', () => {
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList('   '), []);
  assert.deepEqual(parseList('[]'), []);
  assert.deepEqual(parseList('a,,b,'), ['a', 'b']);
  assert.deepEqual(parseList('["", "b"]'), ['b']);
});

// ── retractedLines ────────────────────────────────────────────────────────────

test('retractedLines: a dated mark covers itself and the 14 lines above it, not below', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  lines[19] = 'CORRECTED 2026-09-02: the sentence above was wrong'; // line 20
  const covered = retractedLines(lines.join('\n'));
  assert.equal(covered(20), true);
  assert.equal(covered(6), true); // 20 - 14
  assert.equal(covered(5), false);
  assert.equal(covered(21), false);
});

test('retractedLines: an undated status word is not a retraction', () => {
  const covered = retractedLines('| 2 | lifecycle | **STALE** |\nclaim');
  assert.equal(covered(1), false);
  assert.equal(covered(2), false);
});

test('retractedLines: a blockquote holding a dated mark is covered end to end', () => {
  const text = [
    'intro',
    '> The vault does X.',
    '> more of the false sentence',
    '> SUPERSEDED 2026-08-29 by the review',
    '> trailing quote line',
    'after',
  ].join('\r\n');
  const covered = retractedLines(text);
  for (const n of [2, 3, 4, 5]) assert.equal(covered(n), true, `line ${n}`);
  assert.equal(covered(6), false);
  // line 1 is within the 14 lines above the mark on line 4.
  assert.equal(covered(1), true);
});

test('retractedLines: an undated blockquote is not covered', () => {
  const covered = retractedLines(['> withdrawn', '> still says it'].join('\n'));
  assert.equal(covered(1), false);
  assert.equal(covered(2), false);
});

// ── commitsBehind and prStateBlocker ──────────────────────────────────────────

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function commit(repo, msg) {
  writeFileSync(path.join(repo, 'f.txt'), msg);
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-q', '-m', msg);
}

/** A repo with `main` two commits ahead of the checked-out `work` branch. */
function fixtureRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'doc-claims-git-'));
  roots.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'first (#1)');
  git(repo, 'branch', 'work');
  commit(repo, 'second (#2)');
  commit(repo, 'Merge pull request #3 from x/y');
  git(repo, 'checkout', '-q', 'work');
  return repo;
}

test('commitsBehind counts HEAD..ref, and is null for a missing ref or a non-repo', () => {
  const repo = fixtureRepo();
  assert.equal(commitsBehind(repo, 'main'), 2);
  assert.equal(commitsBehind(repo, 'work'), 0);
  assert.equal(commitsBehind(repo, 'origin/protocol/main'), null);
  const notRepo = mkdtempSync(path.join(tmpdir(), 'doc-claims-norepo-'));
  roots.push(notRepo);
  assert.equal(commitsBehind(notRepo, 'main'), null);
});

test('prStateBlocker: null when the ref is readable, a fetch hint when it is absent', () => {
  const repo = fixtureRepo();
  assert.equal(prStateBlocker(repo, 'main'), null);
  assert.equal(
    prStateBlocker(repo, 'origin/protocol/main'),
    '`origin/protocol/main` is not in this checkout — run `git fetch origin protocol/main`',
  );
});

test('prStateBlocker: a shallow clone cannot be trusted and says so', () => {
  const src = fixtureRepo();
  const shallow = mkdtempSync(path.join(tmpdir(), 'doc-claims-shallow-'));
  roots.push(shallow);
  execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${src}`, shallow], { env: GIT_ENV, stdio: 'ignore' });
  assert.match(String(prStateBlocker(shallow, 'main')), /this checkout is SHALLOW/);
});
