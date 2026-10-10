/**
 * Card 45. Red the gate when a note claims a guard covers something it does not.
 *
 * Five vault notes once said `claims-lede-truth.test.mjs` enforced the vote/trade claims. It never
 * has. See `scripts/lib/guard-coverage-claims.mjs` for the parsed shape, why it is this narrow, and
 * why the parsing/checking logic is pure functions the mutation probe below exercises in memory.
 *
 * TWO STORES, ONE OF THEM OPTIONAL, ON THE SAME PATTERN `claims-lede-truth.test.mjs` and
 * `vault-lint.mjs` already use. The repository half (`docs/**`) is walked in every environment,
 * including CI, and NEVER skips — a check that can skip its primary corpus is a check that will,
 * silently, the day someone forgets to fetch it. The vault half
 * (`Findings/`, `Rules/`, `Decisions/` under the Obsidian vault) exists only on the machine this was
 * written on; CI has no vault at all. When it is absent this prints a visible skip line naming the
 * missing path and moves on — it does not fail, and it does not silently return zero findings as if
 * the vault had been read and come back clean.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaims, evaluateClaims, indexTestFiles, resolveSuite } from '../lib/guard-coverage-claims.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');

/**
 * The vault root this repository's other local-only checks already point at
 * (`scripts/vault-lint.mjs`'s `DEFAULT_VAULT`). Absent on any machine other than the one this was
 * written on, and always absent in CI.
 */
const VAULT_ROOT = 'C:/Users/Micha/Desktop/Claude/Obsidian Vault/Agent-Governed Vaults';
const VAULT_SUBDIRS = ['Findings', 'Rules', 'Decisions'];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'lib',
  'out',
  'dist',
  'dist-ssr',
  'cache',
  'broadcast',
  'coverage',
  'artifacts',
]);

/** Every file under `dir`, recursively, enumerated from disk — never a hand-kept list. */
function filesUnder(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out = [];
  (function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(d, entry.name));
      } else {
        out.push(path.join(d, entry.name));
      }
    }
  })(dir);
  return out;
}

/** Every `*.test.mjs` in the repository, the same walk `test-wiring-truth.test.mjs` uses. */
function discoverTestFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.test.mjs')) {
        out.push(rel(path.join(dir, entry.name)));
      }
    }
  })(REPO);
  return out.sort();
}

/**
 * Every corpus to scan for claims, with the label that names it in a failure and the reason a zero
 * count there is loud rather than silent.
 */
function corpora() {
  const groups = [];

  // THE REPOSITORY HALF NEVER SKIPS. `docs/**`, every file, enumerated from disk.
  const docsRoot = path.join(REPO, 'docs');
  groups.push({
    label: 'docs/**',
    files: filesUnder(docsRoot).map((f) => ({ path: rel(f), abs: f })),
    floor: 20,
    fix: 'docs/ is missing or the walk broke — this repository has published over 20 files there for months',
  });

  // THE VAULT HALF IS OPTIONAL, AND SAYS SO OUT LOUD WHEN IT IS ABSENT.
  if (existsSync(VAULT_ROOT)) {
    for (const sub of VAULT_SUBDIRS) {
      const dir = path.join(VAULT_ROOT, sub);
      groups.push({
        label: `vault/${sub}`,
        files: filesUnder(dir).map((f) => ({
          path: `vault/${sub}/${path.relative(dir, f).split(path.sep).join('/')}`,
          abs: f,
        })),
        floor: 0, // an empty vault subfolder is plausible; only its ABSENCE is loud, below
        fix: `${dir} exists but is empty`,
      });
    }
  } else {
    console.log(
      `guard-coverage-claim-truth: SKIP — no vault at ${VAULT_ROOT} in this environment. ` +
        'The repository half above still ran in full; only the vault half is not checked here.',
    );
  }

  return groups;
}

test('the docs/** walk is never skipped and returns a real corpus', () => {
  const docs = corpora().find((g) => g.label === 'docs/**');
  assert.ok(docs, 'the docs/** group did not run at all');
  assert.ok(
    docs.files.length >= docs.floor,
    `docs/** returned ${docs.files.length} file(s), expected at least ${docs.floor}. ${docs.fix}`,
  );
});

test('every "<suite>.test.mjs (enforces|covers|pins|guards) `token`" claim resolves against the real suite', () => {
  const testFiles = discoverTestFiles();
  assert.ok(
    testFiles.length >= 30,
    `walked ${testFiles.length} test file(s) in the repository, expected at least 30 — the suite-file ` +
      'walk broke, and a check resolved against zero suites would pass over nothing.',
  );
  const bySuffix = indexTestFiles(testFiles);
  const readSuite = (p) => readFileSync(path.join(REPO, p), 'utf8');

  const groups = corpora();
  let scannedFiles = 0;
  const allProblems = [];

  for (const group of groups) {
    for (const f of group.files) {
      let text;
      try {
        text = readFileSync(f.abs, 'utf8');
      } catch {
        continue; // not a text file — nothing this guard's shape can appear in
      }
      scannedFiles++;
      const claims = parseClaims(text);
      if (!claims.length) continue;
      for (const problem of evaluateClaims(claims, bySuffix, readSuite)) {
        allProblems.push({ doc: f.path, ...problem });
      }
    }
  }

  console.log(`\n  guard-coverage-claim-truth: ${scannedFiles} file(s) scanned across ${groups.length} corpus group(s)\n`);
  assert.ok(scannedFiles > 0, 'every corpus group read zero files; the walk is reading the wrong place');

  assert.deepEqual(
    allProblems.map((p) => `${p.doc}:${p.claim.line}`),
    [],
    'A claim about a guard does not hold.\n' +
      'Fix the false sentence itself (see `Rules/fix-the-source-not-only-the-consumer.md`) — never\n' +
      'annotate it with a correction beside the false claim.\n\n' +
      allProblems
        .map(
          (p) =>
            `  ${p.doc}:${p.claim.line}  ${p.claim.raw}\n` +
            `      [${p.kind}] ${p.detail}`,
        )
        .join('\n'),
  );
});

// ---------------------------------------------------------------------------------------------
// MUTATION BAR. Pure-function probes, entirely in memory — no real suite file is touched to prove
// this. `parseClaims`/`evaluateClaims`/`resolveSuite` take their inputs as arguments, so a synthetic
// suite index stands in for the filesystem.
// ---------------------------------------------------------------------------------------------

test('probe: parses only the explicit "<file>.test.mjs verb `token`" shape', () => {
  const caught = (text) => parseClaims(text).length > 0;

  for (const bad of [
    '`claims-lede-truth.test.mjs` enforces `weighted vote`.',
    'claims-lede-truth.test.mjs covers "weighted vote".',
    '`verify-chainlink-oracle.test.mjs` pins `MIN_HEARTBEAT`/`MAX_HEARTBEAT`.',
    'scripts/test/claims-lede-truth.test.mjs guards `operator power`.',
  ]) {
    assert.equal(caught(bad), true, `the parser no longer catches the explicit shape: ${bad}`);
  }

  // The five real notes' actual phrasing — paraphrases with no quoted token right after the verb.
  // This guard is deliberately narrower than a shape-matcher; widening it to catch these is
  // claims-lede-truth.test.mjs's job, not this file's. See the header.
  for (const notThisShape of [
    'claims-lede-truth.test.mjs enforces the vote/trade claims.',
    '`claims-lede-truth.test.mjs` covers none of the three.',
    '`claims-lede-truth.test.mjs` covers who-does-what, weighting, the stake-blind regime.',
    'The suite that enforces this is claims-lede-truth.test.mjs.',
  ]) {
    assert.equal(caught(notThisShape), false, `the parser now catches prose outside its scope: ${notThisShape}`);
  }
});

test('probe: a token absent from its suite reds, adding the token greens', () => {
  const bySuffix = indexTestFiles(['scripts/test/example.test.mjs']);
  const claims = parseClaims('`example.test.mjs` enforces `THE_TOKEN`.');
  assert.equal(claims.length, 1, 'fixture claim did not parse');

  const before = evaluateClaims(claims, bySuffix, () => "test('something else', () => {});");
  assert.equal(before.length, 1, 'a token absent from the suite did not red');
  assert.equal(before[0].kind, 'missing-token');

  const after = evaluateClaims(claims, bySuffix, () => "test('THE_TOKEN is enforced', () => {});");
  assert.deepEqual(after, [], 'adding the token to the suite did not clear the red');
});

test('probe: a claim naming a suite that does not exist reds', () => {
  const bySuffix = indexTestFiles(['scripts/test/example.test.mjs']); // deliberately not the claimed suite
  const claims = parseClaims('`nonexistent-suite.test.mjs` enforces `ANY_TOKEN`.');
  assert.equal(claims.length, 1, 'fixture claim did not parse');

  const problems = evaluateClaims(claims, bySuffix, () => {
    throw new Error('readSuite must not be called for an unresolved suite');
  });
  assert.equal(problems.length, 1, 'a claim naming a nonexistent suite did not red');
  assert.equal(problems[0].kind, 'missing-suite');
});

test('probe: an ambiguous basename reds rather than guessing', () => {
  const bySuffix = indexTestFiles(['scripts/test/dup.test.mjs', 'apps/api/test/dup.test.mjs']);
  const resolved = resolveSuite('dup.test.mjs', bySuffix);
  assert.equal(resolved.ok, false, 'an ambiguous basename resolved instead of failing closed');
});

test('probe: a full path claim resolves to exactly that suite, not a same-named one elsewhere', () => {
  const bySuffix = indexTestFiles(['scripts/test/dup.test.mjs', 'apps/api/test/dup.test.mjs']);
  const resolved = resolveSuite('scripts/test/dup.test.mjs', bySuffix);
  assert.equal(resolved.ok, true, 'a fully-qualified path failed to resolve');
  assert.equal(resolved.path, 'scripts/test/dup.test.mjs');
});
