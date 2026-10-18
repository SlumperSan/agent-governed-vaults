// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish, filesFor, PUBLISH_BRANCH, PUBLISH_FLAG } from '../src/publish.mjs';
import { boardFileText } from '../src/board.mjs';

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lb-publish-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.name', 'test');
  g('config', 'user.email', 'test@example.invalid');
  return { dir, g, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const refs = (g) => g('for-each-ref', '--format=%(refname)', 'refs/heads');
const board = (n, status, tag = 'x') => ({ epoch: { number: n, status }, contentSha256: tag, rows: [] });

test('off by default: with the flag unset or not exactly yes, nothing is written', () => {
  const { dir, g, done } = tempRepo();
  try {
    const files = filesFor(board(1, 'closed'));
    for (const env of [{}, { [PUBLISH_FLAG]: 'no' }, { [PUBLISH_FLAG]: 'true' }, { [PUBLISH_FLAG]: '1' }, { [PUBLISH_FLAG]: 'YES' }, { [PUBLISH_FLAG]: '' }]) {
      const r = publish({ repoDir: dir, files, message: 'm', env });
      assert.equal(r.published, false);
      assert.equal(r.dryRun, true);
      assert.deepEqual(r.plan.map((p) => p.path), ['epochs/0001.json', 'latest.json']);
    }
    assert.equal(refs(g), '');
    assert.equal(readdirSync(dir).filter((f) => f !== '.git').length, 0, 'working tree untouched');
  } finally { done(); }
});

test('with the flag on it writes an orphan local branch by plumbing, and never touches the working tree', () => {
  const { dir, g, done } = tempRepo();
  try {
    const env = { [PUBLISH_FLAG]: 'yes' };
    const r = publish({ repoDir: dir, files: filesFor(board(1, 'closed', 'one')), message: 'first', env });
    assert.equal(r.published, true);
    assert.equal(refs(g), `refs/heads/${PUBLISH_BRANCH}`);
    assert.equal(g('rev-list', '--max-parents=0', PUBLISH_BRANCH), r.commit, 'first commit has no parent');
    assert.equal(g('show', `${PUBLISH_BRANCH}:latest.json`) + '\n', boardFileText(board(1, 'closed', 'one')));
    assert.equal(g('ls-tree', '-r', '--name-only', PUBLISH_BRANCH), 'epochs/0001.json\nlatest.json');
    assert.equal(readdirSync(dir).filter((f) => f !== '.git').length, 0);

    // a provisional board only replaces latest.json; a later closed epoch adds a file and keeps the old one
    publish({ repoDir: dir, files: filesFor(board(2, 'provisional', 'two')), message: 'second', env });
    assert.equal(g('ls-tree', '-r', '--name-only', PUBLISH_BRANCH), 'epochs/0001.json\nlatest.json');
    publish({ repoDir: dir, files: filesFor(board(2, 'closed', 'two')), message: 'third', env });
    assert.equal(g('ls-tree', '-r', '--name-only', PUBLISH_BRANCH), 'epochs/0001.json\nepochs/0002.json\nlatest.json');
    assert.equal(g('rev-list', '--count', PUBLISH_BRANCH), '3');
  } finally { done(); }
});

test('a closed epoch file is immutable: different bytes for an existing epoch are refused', () => {
  const { dir, g, done } = tempRepo();
  try {
    const env = { [PUBLISH_FLAG]: 'yes' };
    publish({ repoDir: dir, files: filesFor(board(1, 'closed', 'one')), message: 'a', env });
    const before = g('rev-parse', PUBLISH_BRANCH);
    assert.throws(() => publish({ repoDir: dir, files: filesFor(board(1, 'closed', 'changed')), message: 'b', env }), /immutable/);
    assert.equal(g('rev-parse', PUBLISH_BRANCH), before);
    // the same bytes again are accepted (a re-run)
    publish({ repoDir: dir, files: filesFor(board(1, 'closed', 'one')), message: 'c', env });
  } finally { done(); }
});

test('only the files the board implies are written', () => {
  assert.deepEqual(Object.keys(filesFor(board(7, 'closed'))).sort(), ['epochs/0007.json', 'latest.json']);
  assert.deepEqual(Object.keys(filesFor(board(7, 'provisional'))), ['latest.json']);
});
