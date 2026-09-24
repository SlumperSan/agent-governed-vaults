// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageBucket, bucketOpenPrs, verdictsInWindow, rulesMissingFromIndex, worktreeCount,
  staleCardsAgainstResolvedPrs,
} from '../lib/chairman-scorecard.mjs';

const NOW = new Date('2026-09-19T18:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

// ── ageBucket / bucketOpenPrs ──

test('ageBucket places PRs into the right side of each boundary', () => {
  assert.equal(ageBucket(hoursAgo(0.5), NOW), '0-1d');
  assert.equal(ageBucket(hoursAgo(24), NOW), '0-1d');
  assert.equal(ageBucket(hoursAgo(24.01), NOW), '1-3d');
  assert.equal(ageBucket(hoursAgo(72), NOW), '1-3d');
  assert.equal(ageBucket(hoursAgo(72.01), NOW), '3-7d');
  assert.equal(ageBucket(hoursAgo(168), NOW), '3-7d');
  assert.equal(ageBucket(hoursAgo(168.01), NOW), '7d+ (zombie candidate)');
});

test('ageBucket throws on a createdAt in the future -- a clock skew must be visible, not silently 0', () => {
  assert.throws(() => ageBucket(hoursAgo(-1), NOW), /future/);
});

test('bucketOpenPrs groups PR numbers, non-vacuous over a mixed set', () => {
  const prs = [
    { number: 1, createdAt: hoursAgo(2) },
    { number: 2, createdAt: hoursAgo(2) },
    { number: 3, createdAt: hoursAgo(50) },
    { number: 4, createdAt: hoursAgo(300) },
  ];
  const b = bucketOpenPrs(prs, NOW);
  assert.deepEqual(b['0-1d'], [1, 2]);
  assert.deepEqual(b['1-3d'], [3]);
  assert.deepEqual(b['7d+ (zombie candidate)'], [4]);
  assert.equal(b['3-7d'], undefined, 'a bucket with nothing in it must not appear at all');
});

// ── verdictsInWindow: the CEO flag is the whole point of this one ──

test('verdictsInWindow keeps only the last N hours and flags every CEO verdict', () => {
  const perPr = [
    { pr: 100, verdicts: [{ reviewer: 'Security', verdict: 'ACCEPT', at: hoursAgo(1) }] },
    { pr: 101, verdicts: [{ reviewer: 'CEO', verdict: 'ACCEPT', at: hoursAgo(2) }] },
    { pr: 102, verdicts: [{ reviewer: 'Security', verdict: 'REJECT', at: hoursAgo(30) }] }, // outside window
  ];
  const { rows, ceoFlags } = verdictsInWindow(perPr, NOW, 24);
  assert.equal(rows.length, 2, 'the 30h-old verdict must be excluded');
  assert.equal(ceoFlags, 1);
  assert.ok(rows.some((r) => r.pr === 101 && r.reviewer === 'CEO'));
});

test('MUTATION: a CEO verdict inside the window is caught; the same verdict moved outside it is not', () => {
  const inWindow = verdictsInWindow(
    [{ pr: 1, verdicts: [{ reviewer: 'CEO', verdict: 'ACCEPT', at: hoursAgo(1) }] }], NOW, 24,
  );
  assert.equal(inWindow.ceoFlags, 1, 'RED -- must be caught');
  const outOfWindow = verdictsInWindow(
    [{ pr: 1, verdicts: [{ reviewer: 'CEO', verdict: 'ACCEPT', at: hoursAgo(25) }] }], NOW, 24,
  );
  assert.equal(outOfWindow.ceoFlags, 0, 'GREEN -- outside the window is legitimately excluded, not lost');
});

test('non-vacuity: a window with zero verdicts is a real result, not a crash', () => {
  assert.deepEqual(verdictsInWindow([], NOW, 24), { rows: [], ceoFlags: 0 });
});

// ── rulesMissingFromIndex ──

test('a rule basename absent from every [[wikilink]] in the index is reported', () => {
  const index = '- [[rule-one]] — the first rule.\n- [[rule-two]] — the second.\n';
  assert.deepEqual(
    rulesMissingFromIndex(['rule-one', 'rule-two', 'rule-three'], index),
    ['rule-three'],
  );
});

test('a wikilink with a pipe alias or an anchor still resolves by its basename', () => {
  const index = '- [[rule-one|the first rule]]\n- [[rule-two#section]]\n';
  assert.deepEqual(rulesMissingFromIndex(['rule-one', 'rule-two'], index), []);
});

test('non-vacuity: every rule missing produces the full list, not a truncated one', () => {
  assert.deepEqual(rulesMissingFromIndex(['a', 'b', 'c'], 'nothing linked here'), ['a', 'b', 'c']);
});

// ── worktreeCount ──

test('worktreeCount counts non-blank lines only', () => {
  const output = [
    'C:/repo                 abcd123 [main]',
    'C:/scratch/wt-a         ef01234 [feat/a]',
    '',
    'C:/scratch/wt-b         56789ab [feat/b]',
    '',
  ].join('\n');
  assert.equal(worktreeCount(output), 3);
});

test('non-vacuity: an empty worktree list is 0, not 1', () => {
  assert.equal(worktreeCount(''), 0);
  assert.equal(worktreeCount('\n\n\n'), 0);
});

// ── staleCardsAgainstResolvedPrs ──

test('a non-done card citing a merged PR is flagged; a done card citing the same PR is not', () => {
  const resolved = new Map([[330, /** @type {const} */ ('merged')]]);
  const cards = [
    { file: 'card-a.md', status: 'doing', text: 'status: doing\n\nBlocked on #330 landing.' },
    { file: 'card-b.md', status: 'done', text: 'status: done\n\nClosed by #330.' },
    { file: 'card-c.md', status: 'backlog', text: 'status: backlog\n\nUnrelated, cites #999.' },
  ];
  const stale = staleCardsAgainstResolvedPrs(cards, resolved);
  assert.deepEqual(stale.map((s) => s.file), ['card-a.md']);
  assert.equal(stale[0].pr, 330);
  assert.equal(stale[0].state, 'merged');
});

test('non-vacuity: a card citing no PR number at all produces nothing', () => {
  const resolved = new Map([[330, /** @type {const} */ ('merged')]]);
  const cards = [{ file: 'x.md', status: 'doing', text: 'no reference here' }];
  assert.deepEqual(staleCardsAgainstResolvedPrs(cards, resolved), []);
});

test('MUTATION: a closed (not merged) PR is caught the same way as a merged one', () => {
  const resolved = new Map([[500, /** @type {const} */ ('closed')]]);
  const cards = [{ file: 'y.md', status: 'backlog', text: 'superseded, see #500' }];
  const stale = staleCardsAgainstResolvedPrs(cards, resolved);
  assert.equal(stale.length, 1, 'RED -- must be caught');
  assert.equal(stale[0].state, 'closed');
});
