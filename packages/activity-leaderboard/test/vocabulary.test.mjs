// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The leaderboard is a plain measurement of on-chain activity (owner decision 2026-10-18). Nothing
 * in this directory may use the vocabulary of accrual or distribution: it would turn a measurement
 * into a promise in the reader's mind. The words are assembled from fragments so this file does not
 * trip its own scan, and it skips itself.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SELF = path.basename(fileURLToPath(import.meta.url));

const BANNED = [
  ['po', 'ints?'], ['sco', 'res?'], ['sco', 'ring'], ['ea', 'rn\\w*'], ['accr', 'u\\w*'], ['far', 'm\\w*'],
  ['rew', 'ard\\w*'], ['tok', 'en\\w*'], ['air', 'drop\\w*'], ['sea', 'sons?'], ['snap', 'shots?'], ['eligib', '\\w+'],
  ['alloc', 'at\\w+'], ['boo', 'st\\w*'], ['multip', 'lier\\w*'], ['cla', 'ims?'],
].map(([a, b]) => new RegExp(`\\b${a}${b}\\b`, 'i'));

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

test('no file under the leaderboard directory uses accrual or distribution vocabulary', () => {
  const all = files(ROOT).filter((f) => path.basename(f) !== SELF);
  assert.ok(all.length >= 15, `walk found ${all.length} files; the scan would be vacuous`);
  const hits = [];
  for (const f of all) {
    const text = readFileSync(f, 'utf8');
    for (const re of BANNED) {
      const m = text.match(re);
      if (m) hits.push(`${path.relative(ROOT, f)}: "${m[0]}"`);
    }
    for (const re of BANNED) if (re.test(path.relative(ROOT, f))) hits.push(`${f}: file name`);
  }
  assert.deepEqual(hits, []);
});
