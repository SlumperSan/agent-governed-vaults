// @ts-check
/**
 * Merge-preflight tests.
 *
 * The four fixtures below are the four PRs that merged across their own review verdicts on
 * 2026-09-01 — #92, #98, #107 and #109 — each reconstructed as it stood **at its own merge
 * instant**: only the comments that existed then, and the workflow runs that existed then.
 * Timestamps and comment headings are the real ones, read from `gh pr view --json mergedAt,comments`.
 * The suite's central claim is that every one of the four would have been BLOCKED, and — because a
 * defence against one mode is useless against another — that they are blocked for *different*
 * reasons.
 *
 * No network: `evaluate()` is pure, so `npm run gate` needs neither `gh` nor authentication.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, parseLegacyRejects, latestPerReviewer, LEGACY_REJECT_PATTERN } from '../lib/verdicts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POLICY = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'lib', 'merge-policy.json'), 'utf8'));

/** A green CI run on the PR's own head — so CI is never the reason a fixture blocks. */
const greenOn = (sha) => [{ headSha: sha, status: 'completed', conclusion: 'success', name: 'CI' }];

/** @param {import('../lib/verdicts.mjs').Blocker[]} bs */
const ruleIds = (bs) => [...new Set(bs.map((b) => b.ruleId))].sort();

// ---------------------------------------------------------------------------------------------
// The four real merges
// ---------------------------------------------------------------------------------------------

test('#107 at its merge instant: Mode A — a REJECT standing 8 minutes, in writing, on the PR', () => {
  const d = evaluate({
    pr: { number: 107, state: 'OPEN', headRefOid: 'aaaa1111', headRefName: 'feat/indexer-exit-fee-governance-abis' },
    comments: [{ createdAt: '2026-09-01T22:35:29Z', body: '## Adversarial review — **REJECT**\n\nF1 HIGH: deserializeState spreads legacy vault records.' }],
    runs: greenOn('aaaa1111'),
    mode: 'strict',
  });
  assert.equal(d.clear, false);
  assert.ok(ruleIds(d.blockers).includes('no-standing-reject'), 'the standing REJECT must block on its own');
  // And it blocks in advisory mode too — Mode A needs no convention adoption to be caught.
  const adv = evaluate({
    pr: { number: 107, state: 'OPEN', headRefOid: 'aaaa1111', headRefName: 'b' },
    comments: [{ createdAt: '2026-09-01T22:35:29Z', body: '## Adversarial review — **REJECT**\n\nbody' }],
    runs: greenOn('aaaa1111'),
    mode: 'advisory',
  });
  assert.deepEqual(ruleIds(adv.blockers), ['no-standing-reject']);
});

test('#92 at its merge instant: Mode A, and the fixer comment that quotes REJECT is not a verdict', () => {
  const comments = [
    { createdAt: '2026-08-30T02:56:26Z', body: '## Adversarial review 1 of 2 — **REJECT**\n\nthe operational lane' },
    { createdAt: '2026-09-01T18:19:00Z', body: '## Fixer pass — all eight findings addressed\n\nGate green.' },
    { createdAt: '2026-09-01T22:16:21Z', body: '## Adversarial review — fresh, post-#103 — **REJECT**\n\nHIGH 1, HIGH 2.' },
  ];
  const d = evaluate({
    pr: { number: 92, state: 'OPEN', headRefOid: 'bbbb2222', headRefName: 'fix/aggregator-swap-drift-rebased' },
    comments,
    runs: greenOn('bbbb2222'),
    mode: 'strict',
  });
  assert.equal(d.clear, false);
  assert.equal(parseLegacyRejects(comments).length, 2, 'two verdicts, not three — the fixer pass is not one');
});

test('#98 at its merge instant: Mode B — one ACCEPT, one reviewer still out, REJECT 25 s later', () => {
  // At 22:30:54Z exactly one verdict existed and it was an ACCEPT from reviewer 1 of 2.
  const atMerge = [
    { createdAt: '2026-09-01T20:05:45Z', body: '## Adversarial review 1 of 2 — **ACCEPT**, plus a finding bigger than the PR\n\n<!-- REVIEW-VERDICT reviewer=Review98a verdict=ACCEPT -->' },
    { createdAt: '2026-09-01T20:05:45Z', body: '<!-- REVIEW-ROSTER reviewers=Review98a,Review98b -->' },
  ];
  const pr = { number: 98, state: 'OPEN', headRefOid: 'cccc3333', headRefName: 'test/guard-depth' };

  // THE DISCRIMINATING PAIR. A rule of "a verdict exists and it is not REJECT" — the brief's own
  // first formulation — clears #98 and lands its finding. Only the roster rule blocks it.
  const advisory = evaluate({ pr, comments: atMerge, runs: greenOn('cccc3333'), mode: 'advisory' });
  assert.equal(advisory.clear, true, 'advisory mode genuinely clears #98 — this is why Mode B needs the roster');

  const strict = evaluate({ pr, comments: atMerge, runs: greenOn('cccc3333'), mode: 'strict' });
  assert.equal(strict.clear, false);
  assert.deepEqual(ruleIds(strict.blockers), ['roster-resolved']);
  assert.match(strict.blockers[0].detail, /Review98b/, 'it must name the reviewer who has not reported');

  // Precision about the fixture: the ROSTER token above is reconstructed, not historical — #98 had
  // no such token, because the protocol did not exist. In the state #98 was actually in, strict
  // blocks on roster-declared instead. Either way it does not merge; only the rule id differs.
  const asItWas = [{ createdAt: '2026-09-01T20:05:45Z', body: '## Adversarial review 1 of 2 — **ACCEPT**, plus a finding bigger than the PR' }];
  assert.deepEqual(ruleIds(evaluate({ pr, comments: asItWas, runs: greenOn('cccc3333'), mode: 'strict' }).blockers), ['roster-declared']);
});

test('#109 at its merge instant: Mode B at its worst — the PR merged before any verdict existed', () => {
  const pr = { number: 109, state: 'OPEN', headRefOid: 'dddd4444', headRefName: 'feat/canary-tiered-sinks-deadman' };
  // No verdict, and no interval to measure from: the REJECT arrived 5.5 minutes AFTER the merge.
  const roster = [{ createdAt: '2026-09-01T22:10:00Z', body: '<!-- REVIEW-ROSTER reviewers=Review109 -->' }];
  const strict = evaluate({ pr, comments: roster, runs: greenOn('dddd4444'), mode: 'strict' });
  assert.equal(strict.clear, false);
  assert.deepEqual(ruleIds(strict.blockers), ['roster-resolved']);

  // With no roster at all — the state #109 was actually in — strict still blocks, on roster-declared.
  const noRoster = evaluate({ pr, comments: [], runs: greenOn('dddd4444'), mode: 'strict' });
  assert.deepEqual(ruleIds(noRoster.blockers), ['roster-declared']);

  // And the honest limit, asserted rather than claimed: advisory mode CANNOT catch #109.
  const adv = evaluate({ pr, comments: [], runs: greenOn('dddd4444'), mode: 'advisory' });
  assert.equal(adv.clear, true, 'advisory mode cannot see a review that does not exist yet — Mode B needs the roster convention');
});

// ---------------------------------------------------------------------------------------------
// Mode C, and CI that belongs to somebody else's commit
// ---------------------------------------------------------------------------------------------

test('Mode C: a MERGED PR blocks, and the message says open a new PR rather than push', () => {
  const d = evaluate({
    pr: { number: 107, state: 'MERGED', headRefOid: 'eeee5555', headRefName: 'feat/indexer-exit-fee-governance-abis' },
    comments: [{ createdAt: '2026-09-01T22:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->\n<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->' }],
    runs: greenOn('eeee5555'),
    mode: 'strict',
  });
  assert.deepEqual(ruleIds(d.blockers), ['pr-open']);
  assert.match(d.blockers[0].detail, /NEW PR/);
});

test('green CI belonging to the previous head does not count as green', () => {
  const base = {
    pr: { number: 107, state: 'OPEN', headRefOid: 'newhead0', headRefName: 'b' },
    comments: [{ createdAt: '2026-09-01T22:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->\n<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->' }],
    mode: /** @type {'strict'} */ ('strict'),
  };
  const stale = evaluate({ ...base, runs: [{ headSha: 'oldhead0', status: 'completed', conclusion: 'success', name: 'CI' }] });
  assert.deepEqual(ruleIds(stale.blockers), ['ci-matches-head']);
  assert.match(stale.blockers[0].detail, /belongs to another commit/);

  // Boundary: the same run, moved onto this head, clears — so the SHA comparison is load-bearing.
  const fresh = evaluate({ ...base, runs: [{ headSha: 'newhead0', status: 'completed', conclusion: 'success', name: 'CI' }] });
  assert.equal(fresh.clear, true);

  // A run on this head that has not finished is not green either — and it must say so, because
  // "still running" and "no conclusive run" call for different actions from whoever reads it.
  const running = evaluate({ ...base, runs: [{ headSha: 'newhead0', status: 'in_progress', conclusion: '', name: 'CI' }] });
  assert.deepEqual(ruleIds(running.blockers), ['ci-matches-head']);
  assert.match(running.blockers[0].detail, /in_progress/);
});

test('a red run on this head blocks, and names the conclusion', () => {
  const d = evaluate({
    pr: { number: 1, state: 'OPEN', headRefOid: 'newhead0', headRefName: 'b' },
    comments: [{ createdAt: '2026-09-01T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->\n<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->' }],
    runs: [{ headSha: 'newhead0', status: 'completed', conclusion: 'failure', name: 'CI' }],
    mode: 'strict',
  });
  assert.deepEqual(ruleIds(d.blockers), ['ci-matches-head']);
  assert.match(d.blockers[0].detail, /concluded failure/);
  // A skipped run is neither a pass nor a failure: it must not be reported as red.
  const skipped = evaluate({
    pr: { number: 1, state: 'OPEN', headRefOid: 'newhead0', headRefName: 'b' },
    comments: [{ createdAt: '2026-09-01T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->\n<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->' }],
    runs: [{ headSha: 'newhead0', status: 'completed', conclusion: 'skipped', name: 'CI' }],
    mode: 'strict',
  });
  assert.equal(skipped.clear, false, 'a skipped run is not a green run either');
  assert.doesNotMatch(skipped.blockers[0].detail, /concluded/);
});

test('a draft PR is not mergeable, whatever its verdicts say', () => {
  const d = evaluate({
    pr: { number: 1, state: 'OPEN', isDraft: true, headRefOid: 'abc', headRefName: 'b' },
    comments: [{ createdAt: '2026-09-01T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->\n<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->' }],
    runs: greenOn('abc'),
    mode: 'strict',
  });
  assert.deepEqual(ruleIds(d.blockers), ['pr-open']);
});

// ---------------------------------------------------------------------------------------------
// The anti-theatre property: prose may block, only tokens may clear
// ---------------------------------------------------------------------------------------------

test('writing the word ACCEPT in prose cannot clear anything', () => {
  const pr = { number: 1, state: 'OPEN', headRefOid: 'abc', headRefName: 'b' };
  const d = evaluate({
    pr,
    runs: greenOn('abc'),
    mode: 'strict',
    comments: [
      { createdAt: '2026-09-01T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->' },
      { createdAt: '2026-09-01T11:00:00Z', body: '## Adversarial review — **REJECT**\n\nreal finding' },
      { createdAt: '2026-09-01T12:00:00Z', body: '## Adversarial review — **ACCEPT**\n\nlooks fine to me now' },
    ],
  });
  assert.equal(d.clear, false, 'a prose ACCEPT must not clear a prose REJECT');
  assert.ok(ruleIds(d.blockers).includes('no-standing-reject'));
  assert.ok(ruleIds(d.blockers).includes('roster-resolved'), 'and prose is not a verdict for roster purposes either');
});

test('a token REJECT is not cleared by prose, and is cleared by a later token', () => {
  const pr = { number: 1, state: 'OPEN', headRefOid: 'abc', headRefName: 'b' };
  const roster = { createdAt: '2026-09-01T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->' };
  const rejected = { createdAt: '2026-09-01T11:00:00Z', body: 'findings\n<!-- REVIEW-VERDICT reviewer=R verdict=REJECT -->' };
  const prose = { createdAt: '2026-09-01T12:00:00Z', body: 'I think this is fine now, ACCEPT.' };

  assert.equal(evaluate({ pr, comments: [roster, rejected, prose], runs: greenOn('abc'), mode: 'strict' }).clear, false);

  const token = { createdAt: '2026-09-01T13:00:00Z', body: 'fixes verified\n<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->' };
  assert.equal(evaluate({ pr, comments: [roster, rejected, prose, token], runs: greenOn('abc'), mode: 'strict' }).clear, true);
});

test('latest verdict per reviewer wins, in both directions', () => {
  const a = { reviewer: 'R', verdict: /** @type {const} */ ('ACCEPT'), at: '2026-09-01T10:00:00Z' };
  const r = { reviewer: 'R', verdict: /** @type {const} */ ('REJECT'), at: '2026-09-01T11:00:00Z' };
  assert.equal(latestPerReviewer([a, r]).R.verdict, 'REJECT');
  assert.equal(latestPerReviewer([r, a]).R.verdict, 'REJECT', 'order of the array must not matter — time does');
  assert.equal(latestPerReviewer([r, { ...a, at: '2026-09-01T12:00:00Z' }]).R.verdict, 'ACCEPT');
});

test('a prose REJECT is cleared only by a STRICTLY later token — asserted at the boundary', () => {
  const pr = { number: 1, state: 'OPEN', headRefOid: 'abc', headRefName: 'b' };
  const at = '2026-09-01T11:00:00Z';
  const legacy = { createdAt: at, body: '## Adversarial review — **REJECT**\n\nfinding' };
  const run = (tokenAt) =>
    evaluate({
      pr,
      runs: greenOn('abc'),
      mode: 'advisory',
      comments: [legacy, { createdAt: tokenAt, body: `<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->` }],
    }).clear;

  assert.equal(run('2026-09-01T10:59:59Z'), false, 'one second before: still blocked');
  assert.equal(run(at), false, 'exactly equal: still blocked — a token in the same comment-second is not a response to it');
  assert.equal(run('2026-09-01T11:00:01Z'), true, 'one second after: cleared');
});

// ---------------------------------------------------------------------------------------------
// The prose heuristic, pinned to the corpus it was validated against
// ---------------------------------------------------------------------------------------------

test('the block-only prose heuristic classifies the real 2026-09-01 corpus exactly', () => {
  // Every comment heading on PRs #90-#120 that contains the word REJECT anywhere in its body.
  const verdicts = [
    '## Adversarial review 1 of 2 — **REJECT**',
    '## Adversarial review — fresh, post-#103 — **REJECT**',
    '## Adversarial review 2 of 2 — **REJECT**',
    '## Adversarial review — REJECT',
  ];
  const notVerdicts = [
    '## Fixer pass — Review92-B findings',
    '## Fixer pass — Review109 findings',
    '## Adversarial review 1 of 2 — **ACCEPT**, plus a finding bigger than the PR',
    '## Adversarial review — ACCEPT',
    '### Follow-up to the review above — the F1 fix is safe against the *deployed* bytecode',
    'Conflict with `main` resolved (snapshot regenerated, not merged textually)',
  ];
  for (const h of verdicts) {
    assert.equal(parseLegacyRejects([{ createdAt: 't', body: `${h}\n\nbody` }]).length, 1, h);
  }
  for (const h of notVerdicts) {
    // Body deliberately quotes the word, as the two real fixer passes do.
    assert.equal(
      parseLegacyRejects([{ createdAt: 't', body: `${h}\n\nThis PR merged 29 minutes after the REJECT above.` }]).length,
      0,
      h,
    );
  }
});

test('the heuristic reads the first NON-EMPTY line, not the raw body — GitHub bodies often start blank', () => {
  // Mutation-found gap: with the regex applied to the whole body the ^ anchor fails on a leading
  // newline, so a real REJECT posted with a blank first line would be silently missed — a false
  // NEGATIVE in the one direction this design cannot afford.
  const withBlank = [{ createdAt: 't', body: ['', '## Adversarial review — **REJECT**', '', 'finding'].join('\n') }];
  assert.equal(parseLegacyRejects(withBlank).length, 1);
  const withIndent = [{ createdAt: 't', body: ['   ', '  ## Adversarial review — REJECT', ''].join('\n') }];
  assert.equal(parseLegacyRejects(withIndent).length, 1);
});

test('two verdicts from one reviewer at the SAME timestamp: the later one in the comment wins', () => {
  // A reviewer correcting itself inside one comment, or two comments in the same second. Document
  // order is the only tie-break available, and it must be the LAST token — otherwise a correction
  // posted underneath the mistake it corrects is ignored.
  const at = '2026-09-01T11:00:00Z';
  assert.equal(latestPerReviewer([
    { reviewer: 'R', verdict: 'REJECT', at },
    { reviewer: 'R', verdict: 'ACCEPT', at },
  ]).R.verdict, 'ACCEPT');
  assert.equal(latestPerReviewer([
    { reviewer: 'R', verdict: 'ACCEPT', at },
    { reviewer: 'R', verdict: 'REJECT', at },
  ]).R.verdict, 'REJECT');
});

// ---------------------------------------------------------------------------------------------
// One source of truth: code, policy and doc cannot drift
// ---------------------------------------------------------------------------------------------

test('the heuristic in verdicts.mjs is byte-identical to the one merge-policy.json publishes', () => {
  assert.equal(LEGACY_REJECT_PATTERN, POLICY.legacyProseHeuristic.pattern);
});

test('every rule the evaluator can emit is declared in merge-policy.json, and vice versa', () => {
  const declared = POLICY.rules.map((/** @type {any} */ r) => r.id).sort();
  const emitted = ['ci-matches-head', 'no-standing-reject', 'pr-open', 'roster-declared', 'roster-resolved'];
  assert.deepEqual(declared, emitted, 'a rule with no policy entry has no stated reason, and a policy entry with no rule is a promise nothing keeps');
});

test('MERGE-POLICY.md embeds merge-policy.json verbatim', () => {
  const doc = readFileSync(path.join(ROOT, 'docs', 'reviews', 'MERGE-POLICY.md'), 'utf8');
  const raw = readFileSync(path.join(ROOT, 'scripts', 'lib', 'merge-policy.json'), 'utf8');
  const m = doc.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, 'MERGE-POLICY.md must contain a ```json block holding the policy');
  assert.equal(
    m[1].replace(/\r\n/g, '\n').trimEnd(),
    raw.replace(/\r\n/g, '\n').trimEnd(),
    'the doc humans read has drifted from the rules the program enforces — regenerate it',
  );
});
