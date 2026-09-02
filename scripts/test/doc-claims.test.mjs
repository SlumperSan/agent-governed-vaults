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
import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDocs,
  citationsIn,
  symbolsAt,
  openPrClaimsIn,
  mergedPrNumbers,
  isHistoricalRecord,
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
  const { problems, checked } = checkDocs(REPO, DOCS);
  assert.ok(checked > 0, 'no claims were resolved at all — the extractor has stopped working');
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
  assert.ok(c.anchors.length <= 3, 'anchors are capped, so a crowded row cannot match by luck');
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
