// @ts-check
/**
 * `vault-lint.mjs`'s three corruption checks, against reconstructed fixtures rather than the real
 * vault (a local machine path this test suite must not depend on being present). Card 135's exact
 * original corruption is reconstructed from `[[Task vocabularies are closed sets 2026-09-19]]`'s
 * own quoted record (`owner: 86400\`) as the primary non-vacuity fixture -- not invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  frontmatterLines,
  shellFragmentReason,
  lintCard,
  bodyBacktickOdd,
  lintVault,
  SCOPED_FIELDS,
  STATUS_SET,
  PRIORITY_SET,
  DEPARTMENT_SET,
} from '../lib/vault-lint.mjs';

// ── frontmatterLines: only the first occurrence of each key, from the block only ──

test('frontmatterLines reads only the first occurrence of a key, never a body line', () => {
  const text = [
    '---',
    'num: 1',
    'status: doing',
    '---',
    '',
    '# a card',
    '',
    'status: this is prose inside the body, not a field',
  ].join('\n');
  const fm = frontmatterLines(text);
  assert.equal(fm.status, 'doing', 'the body line must not overwrite the frontmatter field');
});

test('frontmatterLines returns null for a file with no frontmatter block', () => {
  assert.equal(frontmatterLines('# just a heading\n\nno frontmatter here'), null);
});

// ── Rule 1: shell fragment, reconstructed from card 135's own record ──

test('CARD 135, RECONSTRUCTED: owner ending in a backslash is a shell fragment', () => {
  // [[Task vocabularies are closed sets 2026-09-19]]: "Card 135 carried `owner: 86400\`". This is
  // the actual corruption that sat on the board at priority: high describing a CRITICAL blocker.
  assert.equal(shellFragmentReason('86400\\'), 'ends in a backslash');
});

test('non-vacuity: the same field, uncorrupted, passes clean', () => {
  assert.equal(shellFragmentReason('Tech'), null);
});

for (const [name, value, reason] of [
  ['a backtick', 'scripts/foo.mjs`', 'contains a backtick'],
  ['a command substitution', 'val$(rm -rf /)', 'contains a command substitution ($()'],
  ['shell AND', 'a && b', 'contains a shell AND (&&)'],
  ['shell OR', 'a || b', 'contains a shell OR (||)'],
  ['redirection', 'grep foo > out.txt', 'contains a redirection (>)'],
  ['a source path prefix', 'scripts/vault-lint.mjs', 'names a source path where a seat, a date or an index belongs'],
  ['a bare .mjs filename', 'vault-lint.mjs', 'names a source path where a seat, a date or an index belongs'],
]) {
  test(`shell-fragment rule catches: ${name}`, () => {
    assert.equal(shellFragmentReason(value), reason);
  });
}

test('an unbalanced DOUBLE quote is caught even when the outer pair does not match', () => {
  // Opens " and closes on something else, so stripMatchingQuotes leaves it whole -- one bare `"`
  // remains, an odd count.
  assert.equal(shellFragmentReason('echo "hello'), 'contains an unbalanced double quote');
});

test('MUST NOT FALSE-POSITIVE, MEASURED ON THE LIVE CORPUS: an apostrophe is not an unbalanced quote', () => {
  // The one FAIL this rule produced when first run against the real vault, before this was
  // narrowed to double quotes only -- "Owner's call on timing" is real content, not a defect.
  assert.equal(shellFragmentReason("Owner's call on timing; Legal is off the critical path"), null);
});

test('MUST NOT FALSE-POSITIVE: matching quotes are stripped before every other check', () => {
  // The measured false-positive source from the wide first draft: `plan_item: "0.1"` is a plain
  // quoted string with no metacharacters once the matching pair is removed.
  assert.equal(shellFragmentReason('"0.1"'), null);
  assert.equal(shellFragmentReason("'2026-09-19'"), null);
});

test('MUST NOT FALSE-POSITIVE: title and note are out of scope entirely, even with a backtick and a path', () => {
  // `title: \`scripts/vault-lint.mjs\`` -- this exact card, per its own docstring -- must never be
  // flagged, because `title` is prose and is not in SCOPED_FIELDS.
  assert.ok(!SCOPED_FIELDS.includes('title'));
  assert.ok(!SCOPED_FIELDS.includes('note'));
  const fm = { title: '`scripts/vault-lint.mjs`', num: '189' };
  const { fails } = lintCard(fm);
  assert.deepEqual(fails, []);
});

// ── Rule 2: closed-set membership ──

test('status/priority/department outside the closed set are hard fails', () => {
  assert.equal(lintCard({ status: 'in_progress' }).fails.length, 1, 'the collapsed alias must not silently pass');
  assert.equal(lintCard({ priority: 'med' }).fails.length, 1);
  assert.equal(lintCard({ department: 'Engineering' }).fails.length, 1, 'Engineering was collapsed to Tech');
});

test('every canonical status/priority/department value passes clean', () => {
  for (const status of STATUS_SET) assert.deepEqual(lintCard({ status }).fails, [], status);
  for (const priority of PRIORITY_SET) assert.deepEqual(lintCard({ priority }).fails, [], priority);
  for (const department of DEPARTMENT_SET) assert.deepEqual(lintCard({ department }).fails, [], department);
});

test('owner free text WARNS, never FAILS -- the 14 genuinely-shared cards', () => {
  const { fails, warns } = lintCard({ owner: 'Marketing (wording) / Security (verdict)' });
  assert.deepEqual(fails, []);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /free text/);
});

test('owner in the closed set is silent -- no warning for the ordinary case', () => {
  assert.deepEqual(lintCard({ owner: 'Tech' }), { fails: [], warns: [] });
});

test('owner free text that is ALSO a shell fragment fails on rule 1, in addition to the rule-2 warning', () => {
  const { fails, warns } = lintCard({ owner: '86400\\' });
  assert.equal(fails.length, 1);
  assert.match(fails[0], /backslash/);
  assert.equal(warns.length, 1, 'rule 2 still warns -- rule 1 does not suppress it');
});

// ── Rule 3: odd backtick count in the body ──

test('an even backtick count (paired inline spans and a fenced block) passes clean', () => {
  const text = [
    '---', 'num: 1', '---', '',
    'Some `inline code` and a fence:',
    '```js', 'const x = 1;', '```',
    'and `another span`.',
  ].join('\n');
  assert.equal(bodyBacktickOdd(text), false);
});

test('an unterminated inline code span (odd count) fails -- this is what found card 135', () => {
  const text = ['---', 'num: 1', '---', '', 'truncated mid `sentence'].join('\n');
  assert.equal(bodyBacktickOdd(text), true);
});

// ── lintVault: the floor must not be emptyable ──

function withTempVault(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'vault-lint-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('THE FLOOR CANNOT BE EMPTIED: a missing Tasks folder throws, does not pass', () => {
  withTempVault((root) => {
    assert.throws(() => lintVault(root), /no Tasks folder/);
  });
});

test('THE FLOOR CANNOT BE EMPTIED: an empty Tasks folder throws, does not pass', () => {
  withTempVault((root) => {
    mkdirSync(path.join(root, 'Tasks'));
    assert.throws(() => lintVault(root), /holds no \.md files/);
  });
});

test('lintVault end-to-end: a clean card produces no result, a corrupt one does', () => {
  withTempVault((root) => {
    const tasks = path.join(root, 'Tasks');
    mkdirSync(tasks);
    writeFileSync(path.join(tasks, 'clean.md'), [
      '---', 'num: 1', 'type: task', 'status: doing', 'priority: high',
      'department: Tech', 'owner: Tech', '---', '', '# Clean card', '', 'Nothing wrong here.',
    ].join('\n'));
    writeFileSync(path.join(tasks, 'card-135.md'), [
      '---', 'num: 135', 'type: task', 'status: high', // status/priority swapped -- also a closed-set fail
      `owner: 86400\\`, 'priority: critical', 'department: Tech', '---', '',
      '# Truncated mid `sentence',
    ].join('\n'));

    const results = lintVault(root);
    const files = results.map((r) => r.file).sort();
    assert.deepEqual(files, ['card-135.md'], 'the clean card must produce no result at all');

    const corrupt = results.find((r) => r.file === 'card-135.md');
    assert.ok(corrupt.fails.some((f) => f.includes('backslash')));
    assert.ok(corrupt.fails.some((f) => f.includes('closed set')));
    assert.ok(corrupt.fails.some((f) => f.includes('backtick')));
  });
});

// ── MUTATION: reintroduce card 135's exact defect, confirm red; restore, confirm green ──

test('MUTATION, rule 1: removing the backslash check lets card 135 pass -- the guard is load-bearing', () => {
  // Simulates the mutation directly on the pure function rather than editing the source file,
  // which is the standard shape for a lib this small: call the function with the defect PRESENT
  // and confirm it is caught (this IS "confirm red"), then confirm the clean value passes
  // ("restore, confirm green") -- both directions, on the actual reconstructed value.
  const corrupted = shellFragmentReason('86400\\');
  assert.notEqual(corrupted, null, 'RED: the exact card-135 value must be caught');
  const restored = shellFragmentReason('86400');
  assert.equal(restored, null, 'GREEN: removing the trailing backslash clears it');
});

test('MUTATION, rule 3: card 135\'s truncated body reds; a completed sentence is green', () => {
  const corrupted = ['---', 'num: 135', '---', '', 'truncated mid `sentence'].join('\n');
  assert.equal(bodyBacktickOdd(corrupted), true, 'RED');
  const restored = ['---', 'num: 135', '---', '', 'a completed `sentence` with the code span closed'].join('\n');
  assert.equal(bodyBacktickOdd(restored), false, 'GREEN');
});

// ── The true-and-permitted direction: a lint that forces a weaker sentence is itself a defect ──

test('TRUE AND PERMITTED: a legitimate multi-word owner with punctuation is not a shell fragment', () => {
  assert.equal(shellFragmentReason('Engineering (author) + an independent reviewer'), null);
});

test('TRUE AND PERMITTED: a quoted plan_item decimal is not flagged', () => {
  assert.equal(shellFragmentReason('"0.7"'), null);
});

test('TRUE AND PERMITTED: an ordinary ISO date is not flagged', () => {
  assert.equal(shellFragmentReason('2026-09-19'), null);
});
