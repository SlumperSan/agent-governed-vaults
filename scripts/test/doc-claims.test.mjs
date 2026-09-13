/**
 * The documents in `docs/` must not assert things about this repository that are false.
 *
 * Two claim shapes are checked; see `scripts/lib/doc-claims.mjs` for why these two and why the
 * assertion is on the enclosing symbol. Both went silently false on `protocol/main` inside a
 * single night, and neither is visible in a diff — the citation text does not change when the
 * line moves, and "#98 is open" reads perfectly after #98 merges.
 *
 * This file lives in `scripts/test/` on purpose: `npm run test:backend` already globs
 * `scripts/test/*.test.mjs` and `gate.mjs` step 6 runs it, so the check is inside `npm run gate`
 * with no new gate step to skip and no new CI wiring to forget. It is pure Node and reads merge
 * state from `git log`, never from `gh`: a merge gate that needs the network is a merge gate
 * somebody switches off.
 *
 * The cases below are not decoration. A guard's own tests have to prove it can FAIL, or it is the
 * thing it was written to catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDocs,
  citationsIn,
  symbolsAt,
  openPrClaimsIn,
  mergedPrNumbers,
  isHistoricalRecord,
  isShallowRepository,
  loadWaivers,
  formatProblems,
  RECORD_MARKER,
} from '../lib/doc-claims.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function markdownUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownUnder(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const DOCS = markdownUnder(path.join(REPO, 'docs')).map((f) =>
  path.relative(REPO, f).split(path.sep).join('/')
);

// ── the actual guard ──────────────────────────────────────────────────────────

test('every live document in docs/ makes only true claims about this repository', () => {
  const { problems, checked, canCheckPrState } = checkDocs(REPO, DOCS);
  assert.ok(checked > 0, 'no claims were resolved at all — the extractor has stopped working');
  // Asserted here rather than inferred from a green run: a shallow checkout or a missing
  // `origin/protocol/main` used to make this test pass having checked only citations. It must be
  // an ERROR that the branch-state half could not run, never a skip.
  assert.ok(
    canCheckPrState,
    'branch state could NOT be read, so half this guard did not run. Fetch the base ref ' +
      '(`git fetch origin protocol/main`) and un-shallow the clone (`fetch-depth: 0` in CI).'
  );
  assert.equal(
    problems.length,
    0,
    `\n${formatProblems(problems)}\n\n` +
      'Each of these is a document asserting something about code that is no longer there. ' +
      'Re-point the citation (naming the symbol, not just the line) rather than deleting the check.'
  );
});

test('the guard is actually looking at something: docs/ still carries live claims', () => {
  const { checked, skipped } = checkDocs(REPO, DOCS);
  assert.ok(checked >= 10, `only ${checked} claims resolved; the citation extractor may have broken`);
  assert.ok(skipped.length > 0, 'no document is marked a historical record — the opt-out marker may have been lost');
  assert.ok(skipped.length < DOCS.length, 'every document is marked a record, so nothing is checked');
});

// ── proof that it can fail: the exact defect it was written for ───────────────

test('a citation whose line has moved out of the symbol it names is caught', () => {
  const src = readFileSync(path.join(REPO, 'contracts', 'src', 'VaultCore.sol'), 'utf8');
  const mint = src.split(/\r?\n/).findIndex((l) => /function _mintShares\b/.test(l)) + 1;
  assert.ok(mint > 0, '_mintShares not found — rewrite this test against a function that exists');

  assert.ok(symbolsAt(src, mint).includes('_mintShares'), 'the declaration line resolves to itself');

  // The historical shape: PR #110 shipped `VaultCore.sol:445` for the `_mintShares` row after a
  // merge moved the function. Any line far outside the function must not resolve to it.
  const far = mint > 200 ? mint - 150 : mint + 150;
  assert.ok(
    !symbolsAt(src, far).includes('_mintShares'),
    'a line 150 away still resolves to _mintShares — the symbol scan is not discriminating'
  );
});

test('an anchor may name the enclosing declaration OR a symbol used on the line, and nothing else', () => {
  const src = 'contract C {\n    function f() public {\n        g(1);\n    }\n}\n';
  const at = symbolsAt(src, 3);
  assert.deepEqual(at, ['C', 'f'], 'enclosing declarations');
  assert.ok(!at.includes('g'), 'a called symbol is not an enclosing declaration');
  assert.match(src.split('\n')[2], /\bg\b/, 'but it is present on the line, which is the other accepted form');
});

test('the anchors are the identifiers NEAREST the citation, not every backtick on the line', () => {
  const wide =
    '| `alpha` | `beta` | `gamma` | `delta` | `epsilon` | `zeta` | `eta` | `theta` | ' +
    'a long stretch of prose that pushes the early cells well outside the window | ' +
    '`VaultCore.sol:100` (`_settleExit`) |';
  const [c] = citationsIn(wide);
  assert.ok(c.anchors.includes('_settleExit'), 'the adjacent symbol is an anchor');
  assert.ok(!c.anchors.includes('alpha'), 'a symbol at the far end of the row is not');
  assert.ok(!c.anchors.includes('beta'), 'nor the second');
  assert.ok(!c.anchors.includes('VaultCore'), "and the citation's own span is not its own anchor");
});

test('a quoted code fragment is ONE anchor group, and keywords in it are not anchors', () => {
  // `allowSubVaults = false` names allowSubVaults. It must not also contribute `false`: `false`
  // occurs on most lines of a deploy script, so a drifted citation would resolve as correct.
  const [c] = citationsIn('confirmed on the deploy path (`allowSubVaults = false`, `Deploy.s.sol:79`)');
  assert.ok(c.anchors.includes('allowSubVaults'), 'the identifier inside the fragment is an anchor');
  assert.ok(!c.anchors.includes('false'), 'the keyword is not');
});

test('bare `:N` continuations are resolved against the preceding citation, not ignored', () => {
  const line = '`_mintShares` (`VaultCore.sol:480`); `deposit` (`:387`)';
  const cites = citationsIn(line);
  assert.equal(cites.length, 2, 'both the full citation and the continuation are claims');
  const cont = cites.find((c) => c.raw === '`:387`');
  assert.equal(cont.file, 'VaultCore.sol', 'the continuation inherits the file');
  assert.equal(cont.start, 387);
  assert.ok(cont.anchors.includes('deposit'), 'and carries its own anchor');
});

test('a code span that wraps across a hard line break still yields its anchors', () => {
  // Scanning line by line inverts backtick pairing after a wrapped span and silently empties the
  // anchor list — which would let any wrapped sentence walk past the guard.
  const doc = 'The aggregator used `try IPriceSource(...).latestPrice() returns (uint256 p)\n{...}` — `_tryLatestPrice` (`OracleAggregator.sol:169`) replaced it.\n';
  const [c] = citationsIn(doc);
  assert.ok(c, 'the citation is found');
  assert.ok(c.anchors.includes('_tryLatestPrice'), `wrapped span broke anchoring: got ${JSON.stringify(c.anchors)}`);
});

test('fenced blocks are pasted output, not claims, and are not checked', () => {
  const doc = 'Real claim: `f` (`Some.sol:1`).\n\n```\n--> test/retired/PythSource.sol:4:1\n```\n';
  const cites = citationsIn(doc);
  assert.equal(cites.length, 1, 'only the prose citation is a claim');
  assert.equal(cites[0].file, 'Some.sol');
});

// ── the branch-state half ─────────────────────────────────────────────────────

test('a present-tense claim that a merged PR is open is caught', () => {
  const merged = mergedPrNumbers(REPO);
  assert.ok(merged, 'origin/protocol/main is not in this checkout — fetch before running the gate');
  assert.ok(merged.size > 5, `only ${merged.size} merged PRs found in git log; the subject parser may have broken`);

  const some = [...merged][0];
  const claims = openPrClaimsIn(`Because #${some} is still open, the premise below holds.`);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].pr, some);
  assert.ok(merged.has(claims[0].pr), 'and it resolves as merged');
});

test('a reference to a PR is not a claim about its state', () => {
  assert.equal(openPrClaimsIn('The fix landed in #92 and is described there.').length, 0);
  assert.equal(openPrClaimsIn('See #107 for the indexer change.').length, 0);
  assert.ok(openPrClaimsIn('#107 has not yet been merged.').length > 0, 'but an explicit state claim is');
  assert.ok(openPrClaimsIn('This depends on open PR #40.').length > 0);
});

// ── the opt-out and the waivers, which are the parts most likely to rot ───────

test('the historical-record marker is opt-OUT and per document', () => {
  assert.ok(isHistoricalRecord(`x\n<!-- ${RECORD_MARKER}. -->\ny`));
  assert.ok(!isHistoricalRecord('an ordinary document'));
});

test('every waiver names an open PR and is actually suppressing something', () => {
  // A waiver that outlives its reason is an allow-list entry nobody re-reads. Both directions are
  // enforced inside checkDocs; this asserts the file itself is well formed so a malformed entry
  // cannot silently suppress nothing.
  const merged = mergedPrNumbers(REPO);
  for (const w of loadWaivers(REPO)) {
    assert.ok(w.doc && w.citation, `waiver missing doc/citation: ${JSON.stringify(w)}`);
    assert.equal(typeof w.ownedByPr, 'number', `waiver must name the PR that removes it: ${w.doc} ${w.citation}`);
    assert.ok(w.why, `waiver must say why: ${w.doc} ${w.citation}`);
    assert.ok(!merged.has(w.ownedByPr), `#${w.ownedByPr} has merged — delete the waiver for ${w.doc} ${w.citation}`);
  }
});

test('an expired or unused waiver is itself reported, so the list cannot go stale quietly', () => {
  const fake = [{ doc: 'docs/NOW.md', citation: 'NoSuchFile.sol:1', ownedByPr: 999999, why: 'test' }];
  const { problems } = checkDocs(REPO, ['docs/NOW.md'], { waivers: fake });
  assert.ok(
    problems.some((p) => p.kind === 'waiver-unused'),
    'a waiver that suppresses nothing must be reported'
  );

  const mergedPr = [...mergedPrNumbers(REPO)][0];
  const expired = [{ doc: 'docs/NOW.md', citation: 'NoSuchFile.sol:1', ownedByPr: mergedPr, why: 'test' }];
  const out = checkDocs(REPO, ['docs/NOW.md'], { waivers: expired });
  assert.ok(
    out.problems.some((p) => p.kind === 'waiver-expired'),
    'a waiver whose PR has merged must be reported'
  );
});

// ── fixtures: one negative case per problem kind ──────────────────────────────
//
// The corpus test above asserts the guard finds NOTHING on a clean tree. That direction alone is
// unfalsifiable: a guard that reports nothing ever also passes it. Measured on this module before
// these fixtures existed — disable the `kind: 'moved'` push, the only path that reports a drifted
// citation, and the suite was still 14/14 green. Half the module (the branch-state half) had no
// negative case at all. So every kind the module can report gets a fixture that makes it report,
// and each fixture is paired with the near-identical input that must stay clean, so a mutation
// cannot pass by reporting everything either.
//
// The fixtures are a throwaway tree in the OS temp dir, not the repo's own files: writing a probe
// into `docs/` races the other sessions sharing this checkout, and a fixture built from real
// source lines rots the moment that source moves — which is the defect under test.

function withFixture(files, run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'doc-claims-fixture-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(dir, ...rel.split('/'));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Two functions, so a citation can drift OUT of the one it names and INTO another. The line
// numbers the cases below use are asserted against this literal rather than trusted, so editing
// it cannot silently aim a fixture somewhere else.
const WIDGET = [
  'contract Widget {', //             1
  '    function alpha() public {', // 2
  '        uint256 x = 1;', //        3
  '    }', //                         4
  '', //                              5
  '    function beta() public {', //  6
  '        uint256 y = 2;', //        7
  '    }', //                         8
  '}', //                             9
  '',
].join('\n');

/** Problem kinds reported for `doc`, with branch state supplied rather than read from git. */
function kindsFor(doc, { merged = new Set(), files = {}, ...opts } = {}) {
  return withFixture({ 'src/Widget.sol': WIDGET, 'docs/f.md': doc, ...files }, (dir) => {
    const { problems } = checkDocs(dir, ['docs/f.md'], { sourceRoots: ['src'], merged, ...opts });
    return problems.map((p) => p.kind);
  });
}

test('fixture: the WIDGET fixture is shaped the way the cases below assume', () => {
  const lines = WIDGET.split('\n');
  assert.match(lines[2], /uint256 x/, 'line 3 is inside alpha');
  assert.match(lines[6], /uint256 y/, 'line 7 is inside beta');
  assert.deepEqual(symbolsAt(WIDGET, 3), ['Widget', 'alpha']);
  assert.deepEqual(symbolsAt(WIDGET, 7), ['Widget', 'beta']);
});

test('fixture: a citation that has DRIFTED out of the symbol it names is reported `moved`', () => {
  // The whole point of the module. Disable the `moved` push and this is the case that dies.
  assert.deepEqual(kindsFor('`alpha` is at `Widget.sol:7`.'), ['moved']);
  // ...and the same sentence pointing at the right line must stay silent, so "report everything"
  // is not a way to pass.
  assert.deepEqual(kindsFor('`alpha` is at `Widget.sol:3`.'), []);
});

test('fixture: a citation past the end of the file is reported `out-of-range`', () => {
  assert.deepEqual(kindsFor('`alpha` is at `Widget.sol:900`.'), ['out-of-range']);
  assert.deepEqual(kindsFor('`alpha` is at `Widget.sol:2`.'), [], 'a real line is in range');
});

test('fixture: a basename matching two files is reported `ambiguous`, never guessed at', () => {
  const two = { 'src/a/Dup.sol': WIDGET, 'src/b/Dup.sol': WIDGET };
  assert.deepEqual(kindsFor('`alpha` is at `Dup.sol:3`.', { files: two }), ['ambiguous']);
  assert.deepEqual(
    kindsFor('`alpha` is at `src/a/Dup.sol:3`.', { files: two }),
    [],
    'a citation that gives a path is not ambiguous'
  );
});

test('fixture: a citation naming no symbol is reported `unanchored`, and only in strict mode', () => {
  assert.deepEqual(kindsFor('The relevant line is Widget.sol:3 in the deploy path.'), ['unanchored']);
  assert.deepEqual(
    kindsFor('The relevant line is Widget.sol:3 in the deploy path.', { requireAnchor: false }),
    [],
    '--no-anchor reports only citations that MOVED'
  );
});

test('fixture: a present-tense claim that a MERGED pr is open is reported', () => {
  const merged = new Set([4242]);
  assert.deepEqual(kindsFor('#4242 is still open, so the premise holds.', { merged }), [
    'merged-pr-claimed-open',
  ]);
  assert.deepEqual(
    kindsFor('#4243 is still open, so the premise holds.', { merged }),
    [],
    'a claim about a PR that really is open is not a problem'
  );
});

test('fixture: a claim placing work AFTER a merged pr is reported `merged-pr-claimed-pending`', () => {
  // The under-claim direction: it reads as appropriately cautious and goes on reading that way
  // forever. Nothing challenges a sentence that says the thing is not done yet.
  const merged = new Set([4242]);
  assert.deepEqual(kindsFor('The invariant is enforced once #4242 lands.', { merged }), [
    'merged-pr-claimed-pending',
  ]);
  assert.deepEqual(kindsFor('The invariant is enforced once #4243 lands.', { merged }), []);
});

// ── the check that could not run must FAIL, not skip ──────────────────────────

test('branch state that cannot be read is a reported FAILURE, not a silent skip', () => {
  // F1, as an executable case. Before the fix, `merged === null` skipped the branch-state half and
  // recorded that in `canCheckPrState`, which nothing read — so in CI, where
  // `origin/protocol/main` is absent, the corpus test passed having checked only citations.
  const out = withFixture({ 'src/Widget.sol': WIDGET, 'docs/f.md': '#4242 is still open.\n' }, (dir) =>
    checkDocs(dir, ['docs/f.md'], { sourceRoots: ['src'], merged: null })
  );
  assert.equal(out.canCheckPrState, false, 'the module knows it could not check');
  assert.ok(
    out.problems.some((p) => p.kind === 'pr-state-uncheckable'),
    `and says so where the exit code sees it; got ${JSON.stringify(out.problems.map((p) => p.kind))}`
  );
  // A waiver is permission to leave ONE known-false claim in place, not permission to stop
  // checking — so it must not be able to swallow this.
  const waived = withFixture({ 'src/Widget.sol': WIDGET, 'docs/f.md': 'nothing to see\n' }, (dir) =>
    checkDocs(dir, ['docs/f.md'], {
      sourceRoots: ['src'],
      merged: null,
      waivers: [{ doc: '(repository)', citation: 'origin/protocol/main', ownedByPr: 1, why: 'test' }],
    })
  );
  assert.ok(
    waived.problems.some((p) => p.kind === 'pr-state-uncheckable'),
    'a waiver must not be able to suppress "the check did not run"'
  );
});

test('a shallow or absent checkout yields null merged state rather than a truncated set', () => {
  // A TRUNCATED merged-set is the dangerous shape: it is non-null, so nothing reports it, and
  // every merge commit the clone lacks reads as "that PR is still open". `mergedPrNumbers` must
  // refuse rather than answer partially, so both shallowness and an absent ref return null. A
  // directory that is not a git repo stands in for the absent ref.
  const nowhere = withFixture({ 'src/Widget.sol': WIDGET }, (dir) => mergedPrNumbers(dir));
  assert.equal(nowhere, null, 'no git history means "cannot check", never an empty merged set');
  assert.equal(isShallowRepository(REPO), false, 'this checkout is complete');
  assert.notEqual(mergedPrNumbers(REPO), null, 'and readable, so CI has no excuse either');
});

test('a SHALLOW checkout is refused, because a truncated merged set is a false-negative machine', () => {
  // The dangerous shape is not the absent ref — that one is at least visible. It is the shallow
  // clone: `git log` answers, so `merged` is non-null and nothing reports it, but every merge
  // commit the clone does not have reads as "that PR is still open". This builds a real repo,
  // clones it at depth 1, and asserts the truncation is genuine before asserting the refusal —
  // otherwise the case would pass against a `.git/shallow` file that meant nothing.
  const dir = mkdtempSync(path.join(tmpdir(), 'doc-claims-shallow-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const origin = path.join(dir, 'origin');
    mkdirSync(path.join(origin, 'src'), { recursive: true });
    git(dir, 'init', '-q', 'origin');
    git(origin, 'config', 'user.email', 'fixture@example.invalid');
    git(origin, 'config', 'user.name', 'fixture');
    git(origin, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(origin, 'src', 'Widget.sol'), WIDGET);
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'feat: the squash shape (#4242)');
    writeFileSync(path.join(origin, 'src', 'Widget.sol'), `${WIDGET}\n`);
    git(origin, 'commit', '-qam', 'Merge pull request #4243 from x/y');
    writeFileSync(path.join(origin, 'src', 'Widget.sol'), `${WIDGET}\n\n`);
    git(origin, 'commit', '-qam', 'chore: an ordinary commit on top');

    const deep = mergedPrNumbers(origin, 'HEAD');
    assert.ok(deep.has(4242) && deep.has(4243), 'the complete history sees both merge shapes');

    const shallow = path.join(dir, 'shallow');
    git(dir, 'clone', '-q', '--depth', '1', `file:///${origin.split(path.sep).join('/')}`, 'shallow');

    // The truncation is real, and this is exactly what makes it dangerous: the two merges are
    // simply not there, so without the refusal below they would both read as still open.
    assert.equal(git(shallow, 'log', '--format=%s').trim(), 'chore: an ordinary commit on top');
    assert.equal(isShallowRepository(shallow), true, 'and git says so');
    assert.equal(
      mergedPrNumbers(shallow, 'HEAD'),
      null,
      'a shallow history must refuse rather than answer with the PRs it happens to have'
    );

    writeFileSync(path.join(shallow, 'f.md'), '#4242 is still open, so the premise holds.\n');
    const { problems, canCheckPrState } = checkDocs(shallow, ['f.md'], {
      ref: 'HEAD',
      sourceRoots: ['src'],
    });
    assert.equal(canCheckPrState, false);
    assert.ok(
      problems.some((p) => p.kind === 'pr-state-uncheckable'),
      `the shallow run must FAIL loudly, not pass this stale claim; got ${JSON.stringify(problems.map((p) => p.kind))}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
