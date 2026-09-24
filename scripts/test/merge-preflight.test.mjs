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
import {
  evaluate, parseLegacyRejects, parseLegacyVerdicts, latestPerReviewer, parseRoster, runsForHead,
  parseUnparseableVerdicts, unreadableLatestVerdicts, reviewObjectVerdicts,
  LEGACY_REJECT_PATTERN, LEGACY_VERDICT_PATTERN, SELF_WORKFLOW_NAME,
} from '../lib/verdicts.mjs';
// Importing the adapter is safe: its bottom guard runs `main()` only when it is `process.argv[1]`.
import {
  PR_FIELDS, RUN_FIELDS, TRUSTED_ASSOCIATIONS, missingFields, trustedComments, validateGhPayloads,
} from '../merge-preflight.mjs';
import { BBB_SECTIONS, extractSection, isBlankSection, gradeSections } from '../lib/pr-body-sections.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POLICY = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'lib', 'merge-policy.json'), 'utf8'));

/** A green CI run on the PR's own head — so CI is never the reason a fixture blocks. */
const greenOn = (sha) => [{ headSha: sha, status: 'completed', conclusion: 'success', name: 'CI' }];

/** @param {import('../lib/verdicts.mjs').Blocker[]} bs */
const ruleIds = (bs) => [...new Set(bs.map((b) => b.ruleId))].sort();

/**
 * A PR body that satisfies `buy-borrow-build-declared` (card 190), for `feat/` fixtures built to
 * exercise an unrelated rule — without this, adding that rule would incidentally block every
 * pre-existing `feat/` fixture below and break its `ruleIds`/`clear` assertions for a reason that
 * has nothing to do with what each test is about.
 */
const BBB_OK_BODY = '## Buy / borrow / build\nNone found.\n\n## Standards\nNone applies.\n';

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
  // still blocks on roster-resolved (card 167: no token posted means the roster defaults to
  // DEFAULT_ROSTER = ['Security'], not that nobody needs to review). Either way it does not merge.
  const asItWas = [{ createdAt: '2026-09-01T20:05:45Z', body: '## Adversarial review 1 of 2 — **ACCEPT**, plus a finding bigger than the PR' }];
  const asItWasDecision = evaluate({ pr, comments: asItWas, runs: greenOn('cccc3333'), mode: 'strict' });
  assert.deepEqual(ruleIds(asItWasDecision.blockers), ['roster-resolved']);
  assert.equal(asItWasDecision.rosterDefaulted, true);
  assert.deepEqual(asItWasDecision.roster, ['Security']);
  assert.match(asItWasDecision.blockers[0].detail, /Security/);
});

test('#109 at its merge instant: Mode B at its worst — the PR merged before any verdict existed', () => {
  const pr = { number: 109, state: 'OPEN', headRefOid: 'dddd4444', headRefName: 'feat/canary-tiered-sinks-deadman', body: BBB_OK_BODY };
  // No verdict, and no interval to measure from: the REJECT arrived 5.5 minutes AFTER the merge.
  const roster = [{ createdAt: '2026-09-01T22:10:00Z', body: '<!-- REVIEW-ROSTER reviewers=Review109 -->' }];
  const strict = evaluate({ pr, comments: roster, runs: greenOn('dddd4444'), mode: 'strict' });
  assert.equal(strict.clear, false);
  assert.deepEqual(ruleIds(strict.blockers), ['roster-resolved']);

  // With no roster at all — the state #109 was actually in — strict still blocks: card 167 defaults
  // the roster to Security rather than treating an absent token as "nobody needs to review", so
  // roster-resolved is what fires (roster-declared can no longer block on its own).
  const noRoster = evaluate({ pr, comments: [], runs: greenOn('dddd4444'), mode: 'strict' });
  assert.deepEqual(ruleIds(noRoster.blockers), ['roster-resolved']);
  assert.equal(noRoster.rosterDefaulted, true);
  assert.deepEqual(noRoster.roster, ['Security']);

  // And the honest limit, asserted rather than claimed: advisory mode CANNOT catch #109.
  const adv = evaluate({ pr, comments: [], runs: greenOn('dddd4444'), mode: 'advisory' });
  assert.equal(adv.clear, true, 'advisory mode cannot see a review that does not exist yet — Mode B needs the roster convention');
});

// ---------------------------------------------------------------------------------------------
// Mode C, and CI that belongs to somebody else's commit
// ---------------------------------------------------------------------------------------------

test('Mode C: a MERGED PR blocks, and the message says open a new PR rather than push', () => {
  const d = evaluate({
    pr: { number: 107, state: 'MERGED', headRefOid: 'eeee5555', headRefName: 'feat/indexer-exit-fee-governance-abis', body: BBB_OK_BODY },
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

test('Mode D: a head commit newer than the verdict invalidates it', () => {
  // #121/#117, live on 2026-09-01: a keep-ours conflict resolution would have re-introduced the
  // hand-maintained signal list that #121 exists to abolish, inside a PR whose subject was
  // unrelated -- under a verdict that was correct when it was written. A PR diff shows the merged
  // RESULT and never the CHOICE, so no review of the diff can see it.
  const base = {
    comments: [
      { createdAt: '2026-09-01T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->' },
      { createdAt: '2026-09-01T11:00:00Z', body: ['verified', '<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->'].join('\n') },
    ],
    runs: greenOn('abc'),
    mode: /** @type {'strict'} */ ('strict'),
  };
  const prAt = (headCommittedDate) => ({ number: 1, state: 'OPEN', headRefOid: 'abc', headRefName: 'b', headCommittedDate });

  // Boundary, asserted on all three sides: the merge commit lands one second before the verdict,
  // in the same second, and one second after.
  assert.equal(evaluate({ ...base, pr: prAt('2026-09-01T10:59:59Z') }).clear, true, 'reviewed content is the head: clear');
  assert.equal(evaluate({ ...base, pr: prAt('2026-09-01T11:00:00Z') }).clear, true, 'same second: the verdict covers it');
  const stale = evaluate({ ...base, pr: prAt('2026-09-01T11:00:01Z') });
  assert.equal(stale.clear, false, 'one second later: what would merge is not what was reviewed');
  assert.deepEqual(ruleIds(stale.blockers), ['verdict-covers-head']);
  assert.match(stale.blockers[0].detail, /conflict resolution/);

  // Re-confirming after the resolution clears it -- the action the message asks for must work.
  const reconfirmed = evaluate({
    ...base,
    pr: prAt('2026-09-01T11:00:01Z'),
    comments: [...base.comments, { createdAt: '2026-09-01T12:00:00Z', body: ['resolution re-read', '<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->'].join('\n') }],
  });
  assert.equal(reconfirmed.clear, true);

  // And the honest limit: with no commit date available the rule cannot fire at all.
  assert.equal(evaluate({ ...base, pr: prAt(undefined) }).clear, true, 'no commit date: Mode D is not checked, not silently passed as checked');

  // Mode D runs in ADVISORY too, unlike the roster rules — it needs only a verdict token, which is
  // the reviewer's own act rather than an orchestrator convention.
  const adv = evaluate({ ...base, pr: prAt('2026-09-01T11:00:01Z'), mode: 'advisory' });
  assert.deepEqual(ruleIds(adv.blockers), ['verdict-covers-head']);
});

test('Mode E: a valid, unstale verdict on an UNMOVED head is still stale if the base moved', () => {
  // #119, live on 2026-09-01: a valid ACCEPT against d9293c23, then #121 merged and inverted the
  // canary tier semantics, falsifying two sentences #119 ADDS. merge-tree clean (different files),
  // CI green on the reviewed head, verdict untouched, branch head NEVER MOVED.
  const comments = [
    { createdAt: '2026-09-01T22:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->' },
    { createdAt: '2026-09-01T23:00:00Z', body: ['reviewed', '<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->'].join('\n') },
  ];
  const pr = (behindBy) => ({
    number: 119, state: 'OPEN', headRefOid: 'd9293c23', headRefName: 'fix/aggregator-drift-review-repairs',
    baseRefName: 'protocol/main',
    // The head is OLDER than the verdict, so verdict-covers-head is satisfied — deliberately, to
    // prove base-current is doing the work here and not Mode D leaking in.
    headCommittedDate: '2026-09-01T21:00:00Z',
    behindBy,
  });
  const base = { comments, runs: greenOn('d9293c23'), mode: /** @type {'strict'} */ ('strict') };

  assert.equal(evaluate({ ...base, pr: pr(0) }).clear, true, 'up to date: clear');
  const stale = evaluate({ ...base, pr: pr(1) });
  assert.equal(stale.clear, false, 'one commit behind: the verdict was computed against a base that moved');
  assert.deepEqual(ruleIds(stale.blockers), ['base-current']);
  assert.match(stale.blockers[0].detail, /1 commit\(s\) behind protocol\/main/);

  // Both modes, like Mode D — it needs only a verdict token.
  assert.deepEqual(ruleIds(evaluate({ ...base, pr: pr(43), mode: 'advisory' }).blockers), ['base-current']);

  // Gated on a verdict EXISTING. With none, roster-resolved already blocks (card 167: the roster
  // defaults to Security rather than leaving "no roster" unresolved) and base drift is noise.
  const noVerdict = evaluate({ pr: pr(43), comments: [], runs: greenOn('d9293c23'), mode: 'strict' });
  assert.deepEqual(ruleIds(noVerdict.blockers), ['roster-resolved'], 'no verdict: base drift is not reported as its own blocker');

  // And the honest limit: with no behindBy available the rule cannot fire at all.
  assert.equal(evaluate({ ...base, pr: pr(undefined) }).clear, true, 'no behindBy: Mode E is not checked, not silently passed as checked');
});

test('#112: a PROSE ACCEPT counts as "reviewed" for Mode E, or the rule misses its own case', () => {
  // Found by running the tool, not by reasoning about it. #112 is ACCEPTed, 43 commits behind main
  // and on the owner's desk to merge — and the first version of base-current reported CLEAR,
  // because #112's ACCEPT is prose and the gate required a TOKEN. Reading a prose ACCEPT to RAISE a
  // blocker keeps the asymmetry: prose still never clears anything.
  const prose = [{ createdAt: '2026-09-01T23:30:46Z', body: ['## Adversarial review — ACCEPT', '', 'all four SHAs re-resolved'].join('\n') }];
  assert.equal(parseLegacyVerdicts(prose).length, 1, 'a prose ACCEPT is a review, even though it is not a clearance');
  assert.equal(parseLegacyRejects(prose).length, 0, 'and it is still not a REJECT');

  const pr = { number: 112, state: 'OPEN', headRefOid: '6c534f0a', headRefName: 'chore/supply-chain-pins', baseRefName: 'protocol/main', behindBy: 43 };
  const d = evaluate({ pr, comments: prose, runs: greenOn('6c534f0a'), mode: 'advisory' });
  assert.deepEqual(ruleIds(d.blockers), ['base-current']);
  assert.match(d.blockers[0].detail, /43 commit/);

  // Up to date, same prose ACCEPT: clear. So it is the base drift doing the work, not the heading.
  assert.equal(evaluate({ pr: { ...pr, behindBy: 0 }, comments: prose, runs: greenOn('6c534f0a'), mode: 'advisory' }).clear, true);

  // A comment that is not a verdict at all does not make a stale base blockable on its own.
  const notAReview = [{ createdAt: '2026-09-01T23:30:46Z', body: ['## Fixer pass — addressed', '', 'quotes the word ACCEPT'].join('\n') }];
  assert.equal(evaluate({ pr, comments: notAReview, runs: greenOn('6c534f0a'), mode: 'advisory' }).clear, true);
});

// ---------------------------------------------------------------------------------------------
// One source of truth: code, policy and doc cannot drift
// ---------------------------------------------------------------------------------------------

test('the heuristics in verdicts.mjs are byte-identical to the ones merge-policy.json publishes', () => {
  assert.equal(LEGACY_REJECT_PATTERN, POLICY.legacyProseHeuristic.pattern);
  assert.equal(LEGACY_VERDICT_PATTERN, POLICY.legacyProseHeuristic.verdictPattern);
});

test('every rule the evaluator can emit is declared in merge-policy.json, and vice versa', () => {
  const declared = POLICY.rules.map((/** @type {any} */ r) => r.id).sort();
  const emitted = ['base-current', 'buy-borrow-build-declared', 'ci-matches-head', 'no-standing-reject', 'pr-open', 'roster-resolved', 'verdict-covers-head'];
  assert.deepEqual(declared.sort(), emitted.sort(), 'a rule with no policy entry has no stated reason, and a policy entry with no rule is a promise nothing keeps');
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

// ---------------------------------------------------------------------------------------------
// The gate must not evaluate its own runs
// ---------------------------------------------------------------------------------------------
//
// `merge-preflight.mjs` lists runs with `--branch <headRefName>` and no `--workflow` filter, so the
// preflight's OWN runs come back inside the set it is about to judge. One root cause, three
// symptoms, and the third is permissive:
//
//   1. SELF-BLOCK. A `pull_request`-triggered run is on the PR head and `in_progress` while it
//      evaluates, so it lands in `pending` and pushes a blocker against itself.
//   2. MISCOUNTING. A *completed* preflight run lands in `succeeded`, because `conclusion` is the
//      RUN's conclusion -- a run that succeeded at posting a `failure` commit status has
//      `conclusion: 'success'`. The gate commits inside itself the artifact-substitution error that
//      four sessions committed reading it.
//   3. A HEAD WITH NO CI PASSES `ci-matches-head`. One completed preflight run makes
//      `mine.length === 0` false and `succeeded.length === 1` true, which defeats the
//      `succeeded===0 && failed===0 && pending===0` catch-all. LATENT today only because `ci.yml`
//      has a bare `pull_request:` trigger with no `paths:` filter, so CI and the preflight always
//      appear together -- one routine "skip CI for docs-only changes" arms it.
//
// Every fixture here reuses the shape of the stale-CI test above: roster + ACCEPT token, no
// `headCommittedDate`, no `behindBy`, so `ci-matches-head` is the only rule that can fire and the
// assertions isolate it.

/** Roster + ACCEPT, so nothing but `ci-matches-head` can block. */
const cleared = [{ createdAt: '2026-09-01T22:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->\n<!-- REVIEW-VERDICT reviewer=R verdict=ACCEPT -->' }];
const onHead = { number: 1, state: 'OPEN', headRefOid: 'newhead0', headRefName: 'b' };

test('symptom 1 — the gate own in-progress run does not block the head it is judging', () => {
  const d = evaluate({
    pr: onHead,
    comments: cleared,
    runs: [
      ...greenOn('newhead0'),
      // The preflight looking at itself: same head, still running, because it IS the run asking.
      { headSha: 'newhead0', status: 'in_progress', conclusion: null, name: SELF_WORKFLOW_NAME },
    ],
    mode: 'strict',
  });
  assert.equal(d.clear, true, 'a green CI on this head is green; the gate own run is not evidence about the head');
});

test('symptom 1 — a real CI run still in progress DOES block, so the exclusion is not a blanket mute', () => {
  const d = evaluate({
    pr: onHead,
    comments: cleared,
    runs: [
      { headSha: 'newhead0', status: 'in_progress', conclusion: null, name: 'CI' },
      { headSha: 'newhead0', status: 'in_progress', conclusion: null, name: SELF_WORKFLOW_NAME },
    ],
    mode: 'strict',
  });
  assert.deepEqual(ruleIds(d.blockers), ['ci-matches-head']);
  assert.equal(d.blockers.length, 1, 'exactly one blocker: CI. The gate must not also report itself.');
  assert.match(d.blockers[0].detail, /run CI on head/);
  assert.doesNotMatch(d.blockers[0].detail, /merge-preflight/);
});

test('symptom 2 — a COMPLETED preflight run is not a green: its conclusion is the run, not the status it posted', () => {
  // This run concluded `success`. What it posted may have been `merge-preflight = failure`; the run
  // succeeded at posting it. Counting it as CI green is reading the wrong artifact.
  const d = evaluate({
    pr: onHead,
    comments: cleared,
    runs: [{ headSha: 'newhead0', status: 'completed', conclusion: 'success', name: SELF_WORKFLOW_NAME }],
    mode: 'strict',
  });
  assert.equal(d.clear, false, 'the only run on this head is the gate own run — that is not CI');
  assert.deepEqual(ruleIds(d.blockers), ['ci-matches-head']);
  assert.match(d.blockers[0].detail, /no workflow run exists for head/);
});

test('symptom 2 — the preflight is excluded from the tally even when a genuine red is present', () => {
  const d = evaluate({
    pr: onHead,
    comments: cleared,
    runs: [
      { headSha: 'newhead0', status: 'completed', conclusion: 'failure', name: 'CI' },
      { headSha: 'newhead0', status: 'completed', conclusion: 'success', name: SELF_WORKFLOW_NAME },
    ],
    mode: 'strict',
  });
  assert.deepEqual(ruleIds(d.blockers), ['ci-matches-head']);
  assert.equal(d.blockers.length, 1, 'one red, one blocker — the gate own success must not offset it');
  assert.match(d.blockers[0].detail, /run CI on head newhead0 concluded failure/);
});

test('symptom 3 (LATENT) — a head whose CI was SKIPPED must not be greened by the preflight own run', () => {
  // The world one `paths-ignore: ['docs/**']` away: a docs-only PR skips CI, the preflight still
  // runs. Pre-fix the completed preflight run sits in `succeeded`, defeating the catch-all that
  // exists for exactly this case, and `ci-matches-head` — the rule NAMED for matching CI to the
  // head — reports clear on a head that has no CI.
  const d = evaluate({
    pr: onHead,
    comments: cleared,
    runs: [
      { headSha: 'newhead0', status: 'completed', conclusion: 'skipped', name: 'CI' },
      { headSha: 'newhead0', status: 'completed', conclusion: 'success', name: SELF_WORKFLOW_NAME },
    ],
    mode: 'strict',
  });
  assert.equal(d.clear, false, 'a skipped CI plus the gate own run is not a green head');
  assert.deepEqual(ruleIds(d.blockers), ['ci-matches-head']);
  assert.match(d.blockers[0].detail, /none conclusive/);
});

test('symptom 3 (LATENT) — a head with NO CI at all blocks, and the message says the gate runs are excluded', () => {
  const d = evaluate({
    pr: onHead,
    comments: cleared,
    // Both of the preflight's own triggers can land on the PR branch; neither is CI.
    runs: [
      { headSha: 'newhead0', status: 'completed', conclusion: 'success', name: SELF_WORKFLOW_NAME },
      { headSha: 'newhead0', status: 'in_progress', conclusion: null, name: SELF_WORKFLOW_NAME },
    ],
    mode: 'strict',
  });
  assert.equal(d.clear, false);
  assert.deepEqual(ruleIds(d.blockers), ['ci-matches-head']);
  // `gh run list` plainly shows two runs on this head, so the message must say why it counted none —
  // or the next reader spends a night deciding the gate is lying to them.
  assert.match(d.blockers[0].detail, /no workflow run exists for head/);
  assert.match(d.blockers[0].detail, new RegExp(`own '${SELF_WORKFLOW_NAME}' runs are excluded`));
});

test('the exclusion is exact-match, so it cannot silently swallow another workflow', () => {
  // A future `merge-preflight-lint` is a real workflow whose result is real evidence. A
  // `startsWith`/`includes` filter would eat it and nobody would notice.
  const neighbour = `${SELF_WORKFLOW_NAME}-lint`;
  const d = evaluate({
    pr: onHead,
    comments: cleared,
    runs: [
      ...greenOn('newhead0'),
      { headSha: 'newhead0', status: 'completed', conclusion: 'failure', name: neighbour },
    ],
    mode: 'strict',
  });
  assert.deepEqual(ruleIds(d.blockers), ['ci-matches-head']);
  assert.match(d.blockers[0].detail, new RegExp(`run ${neighbour} on head`));
});

test('runsForHead excludes the gate own runs at the unit level, on either head-SHA casing', () => {
  const runs = [
    { headSha: 'NEWHEAD0', status: 'completed', conclusion: 'success', name: 'CI' },
    { headSha: 'newhead0', status: 'in_progress', conclusion: null, name: SELF_WORKFLOW_NAME },
    { headSha: 'oldhead0', status: 'completed', conclusion: 'success', name: 'CI' },
  ];
  assert.deepEqual(runsForHead(runs, 'newhead0').map((r) => r.name), ['CI']);
});

test('SELF_WORKFLOW_NAME is pinned to the workflow file, so a rename fails loudly instead of silently un-filtering', () => {
  // The whole safety argument for filtering on a DISPLAY STRING is this test. Without it, editing
  // `name:` in the yml re-arms all three symptoms and nothing anywhere goes red.
  const yml = readFileSync(path.join(ROOT, '.github', 'workflows', 'merge-preflight.yml'), 'utf8');
  const m = yml.match(/^name:\s*(\S.*?)\s*$/m);
  assert.ok(m, '.github/workflows/merge-preflight.yml must declare a top-level `name:`');
  assert.equal(
    m[1],
    SELF_WORKFLOW_NAME,
    'the workflow was renamed without updating SELF_WORKFLOW_NAME — the gate is evaluating its own runs again',
  );
});

// ---------------------------------------------------------------------------------------------
// The fields the gate reads off `gh` must not go missing quietly
// ---------------------------------------------------------------------------------------------
//
// #137 made `runsForHead` exclude this gate's own runs with `r.name !== SELF_WORKFLOW_NAME`, and
// pinned `SELF_WORKFLOW_NAME` to the workflow's `name:` so a rename fails loudly. It pinned one end
// of the chain. The other end was `r.name`, which `merge-preflight.mjs` maps from `workflowName` in
// a `gh run list --json` field list that nothing referred to: drop that one word and every
// `r.name` is `undefined`, `undefined !== 'merge-preflight'` is always true, the filter is a no-op,
// and a head with NO CI clears `ci-matches-head` again.
//
// Reproduced end to end on 2026-09-10 against a `gh` that honours the `--json` field list: the
// script printed CLEAR and exited 0 on a head with one preflight run and zero CI runs -- and this
// suite stayed 30/30 green, because it imports `verdicts.mjs` and builds `name` onto its own
// fixtures, so no test here could ever have seen a field-name change. That is the gap these close.

test('a nameless run is invisible to the name filter, which is why the adapter must never emit one', () => {
  // Characterisation, not endorsement: `runsForHead` belongs to the PURE evaluator, its `Run.name`
  // is declared optional, and its fixtures may legitimately omit optional fields. Making it throw
  // would put it at odds with its own typedef and with the "not checked, not silently passed as
  // checked" tests above. So the contract check belongs in the adapter, where "this came from `gh`"
  // is knowable -- and this is the exact behaviour that makes it load-bearing there.
  const nameless = [{ headSha: 'newhead0', status: 'completed', conclusion: 'success' }];
  assert.deepEqual(runsForHead(nameless, 'newhead0'), nameless, 'no name, nothing to exclude by');
  const named = [{ ...nameless[0], name: SELF_WORKFLOW_NAME }];
  assert.deepEqual(runsForHead(named, 'newhead0'), [], 'with the name present the filter bites');
});

test('the gh --json field lists are pinned to the fields the adapter maps, and to the mapping itself', () => {
  // Both halves, because the mutation under test touches only one of them: pinning the `r.name`
  // mapping alone stays green when the request loses `workflowName`, and pinning the request alone
  // stays green when the mapping is rewritten. Anchored to each `gh` invocation rather than grepped
  // as a bare substring -- `workflowName` also appears in merge-policy.json's `ci-matches-head.why`,
  // where a loose match would pass for the wrong reason.
  const src = readFileSync(path.join(ROOT, 'scripts', 'merge-preflight.mjs'), 'utf8');

  const runReq = src.match(/'run',\s*'list',[\s\S]*?'--json',\s*'([^']+)'/);
  assert.ok(runReq, 'merge-preflight.mjs must ask `gh run list` for an explicit --json field list');
  assert.equal(
    runReq[1], RUN_FIELDS.join(','),
    'the run request and RUN_FIELDS have drifted. They are two independent statements of one list on purpose: a required set derived from the request cannot catch a field dropped from the request.',
  );
  const prReq = src.match(/'pr',\s*'view',[\s\S]*?'--json',\s*'([^']+)'/);
  assert.ok(prReq, 'merge-preflight.mjs must ask `gh pr view` for an explicit --json field list');
  assert.equal(prReq[1], PR_FIELDS.join(','), 'the PR request and PR_FIELDS have drifted');

  // Named literally, so deleting a field from BOTH statements above is still red. These are the
  // four FIELD-LIST entries whose absence DISARMS a rule instead of blocking on it; `.behind_by` is
  // the fifth such value and is checked by type rather than by presence, since `--jq` names it.
  assert.ok(RUN_FIELDS.includes('workflowName'), 'without workflowName, runsForHead excludes nothing and a head with no CI clears ci-matches-head');
  assert.ok(PR_FIELDS.includes('commits'), 'without commits there is no headCommittedDate and verdict-covers-head silently stops running');
  assert.ok(PR_FIELDS.includes('comments'), 'without comments there are no verdicts, so no-standing-reject, verdict-covers-head and base-current all silently stop running');
  assert.ok(PR_FIELDS.includes('isDraft'), 'without isDraft a draft PR is not blocked');

  // The mapping half: `workflowName` is what becomes `name`, which is what the filter reads.
  assert.match(
    src, /name:\s*r\.workflowName/,
    'merge-preflight.mjs must map workflowName onto `name`; `runsForHead` filters on `name` and reads undefined otherwise',
  );

  // And the guard must actually sit between `gh` and the evaluator, on the real arguments.
  const guardAt = src.indexOf('validateGhPayloads(pr.data, runs.data, cmp.data)');
  const evalAt = src.indexOf('evaluate({');
  assert.notEqual(guardAt, -1, 'main() must validate the gh payloads on the real arguments');
  assert.ok(evalAt !== -1 && guardAt < evalAt, 'the payload check must run BEFORE evaluate(), or it checks nothing that matters');
});

test('missingFields answers on key PRESENCE, not truthiness', () => {
  // `conclusion` is `""` on an in-progress run and `isDraft` is `false` on most PRs. Both are
  // answers. A truthiness check would reject the live API's own output.
  const inProgress = { headSha: 'a', status: 'in_progress', conclusion: '', workflowName: 'CI' };
  assert.deepEqual(missingFields(inProgress, RUN_FIELDS), [], 'an empty conclusion is a conclusion');
  assert.deepEqual(missingFields({ headSha: 'a', status: 'completed', conclusion: 'success' }, RUN_FIELDS), ['workflowName']);
  assert.deepEqual(missingFields(null, RUN_FIELDS), RUN_FIELDS, 'no object: everything is missing');
  assert.deepEqual(missingFields('not an object', RUN_FIELDS), RUN_FIELDS);
});

// A payload shaped like the live API's, so every negative case below differs from a working one by
// one field and nothing else.
const okPr = () => ({
  number: 1, state: 'OPEN', isDraft: false, headRefName: 'b', headRefOid: 'newhead0',
  baseRefName: 'protocol/main',
  comments: [{ createdAt: '2026-09-01T22:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=R -->', author: { login: 'SlumperSan' }, authorAssociation: 'OWNER' }],
  commits: [{ oid: 'newhead0', committedDate: '2026-09-01T21:00:00Z' }],
  body: '',
});
const okRuns = () => [{ headSha: 'newhead0', status: 'completed', conclusion: 'success', workflowName: 'CI' }];

test('validateGhPayloads passes the live shapes it was written against', () => {
  assert.equal(validateGhPayloads(okPr(), okRuns(), 0), null);
  assert.equal(validateGhPayloads(okPr(), okRuns(), 43), null, 'a behind branch is a judgement for base-current, not a broken payload');
  assert.equal(validateGhPayloads(okPr(), [], 0), null, 'NO RUNS is a legitimate state: ci-matches-head blocks on it correctly, and this must not pre-empt that');
  assert.equal(
    validateGhPayloads(okPr(), [{ headSha: 'newhead0', status: 'in_progress', conclusion: '', workflowName: 'CI' }], 0),
    null,
    'an in-progress run has an empty conclusion and is still a whole run',
  );
  assert.equal(
    validateGhPayloads({ ...okPr(), comments: [] }, okRuns(), 0), null,
    'a PR with no comments yet is a PR with no comments yet; the roster rules answer that, not this',
  );
});

test('validateGhPayloads fails CLOSED on every field whose absence would disarm a rule', () => {
  // Each of these puts undefined into the evaluator today, and each turns a rule off rather than
  // making it complain. Exit 2 is "could not determine", which the workflow publishes as `error`
  // and which merge-preflight.mjs's header records is not a pass.
  const withoutWorkflowName = okRuns().map(({ workflowName, ...rest }) => rest);
  assert.match(
    String(validateGhPayloads(okPr(), withoutWorkflowName, 0)), /workflowName/,
    'THE HOLE: no workflowName means runsForHead excludes nothing and a head with no CI clears ci-matches-head',
  );

  const { commits, ...noCommits } = okPr();
  assert.match(String(validateGhPayloads(noCommits, okRuns(), 0)), /commits/);
  assert.match(
    String(validateGhPayloads({ ...okPr(), commits: [{ oid: 'newhead0' }] }, okRuns(), 0)), /committedDate/,
    'nested, so no --json field name can ask for it: commits[].committedDate is Mode D only input',
  );

  const { comments, ...noComments } = okPr();
  assert.match(String(validateGhPayloads(noComments, okRuns(), 0)), /comments/);

  const { isDraft, ...noDraft } = okPr();
  assert.match(String(validateGhPayloads(noDraft, okRuns(), 0)), /isDraft/);

  // `body` (card 190): absent means buy-borrow-build-declared cannot tell "the author never wrote a
  // section" from "gh did not return one" -- refuse to judge rather than misreport the first as the
  // second.
  const { body, ...noBody } = okPr();
  assert.match(String(validateGhPayloads(noBody, okRuns(), 0)), /body/);

  // `--jq` on a key that is not there prints `null` and gh exits 0, so the JSON.parse failure path
  // never sees it and Mode E just stops firing.
  assert.match(String(validateGhPayloads(okPr(), okRuns(), null)), /behind_by/);
  assert.match(String(validateGhPayloads(okPr(), okRuns(), undefined)), /behind_by/);

  // The fields that already fail closed are in the set too: cheap, and it stops the next reader
  // having to re-derive which half of the list is load-bearing.
  const { state, ...noState } = okPr();
  assert.match(String(validateGhPayloads(noState, okRuns(), 0)), /state/);
  assert.ok(validateGhPayloads(okPr(), [{ status: 'completed', conclusion: 'success', workflowName: 'CI' }], 0));
  assert.ok(validateGhPayloads(okPr(), 'not an array', 0));
});

// ---------------------------------------------------------------------------------------------
// Card #352 — the latest roster token wins, INCLUDING an empty one (the dead-seat bug)
// ---------------------------------------------------------------------------------------------
// Real incident: a roster was declared for a reviewer whose session ended, and posting a fresh
// `<!-- REVIEW-ROSTER reviewers= -->` to withdraw it had no effect — the gate kept reading the
// dead seat, because `parseRoster` silently dropped every empty match. The only working remedy
// was reassigning to a DIFFERENT live reviewer, which may not exist (Security/Product/Finance/
// Design all dark the same day). Fixed: every roster token, empty or not, is the new declaration.

test('parseRoster: a later EMPTY roster overrides an earlier non-empty one', () => {
  const comments = [
    { createdAt: '2026-09-21T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=Security -->' },
    { createdAt: '2026-09-21T14:00:00Z', body: '<!-- REVIEW-ROSTER reviewers= -->' },
  ];
  assert.deepEqual(parseRoster(comments), { reviewers: [], at: '2026-09-21T14:00:00Z' });
});

test('parseRoster: a later roster naming a DIFFERENT reviewer fully replaces the old one (not a union)', () => {
  const comments = [
    { createdAt: '2026-09-21T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=Security -->' },
    { createdAt: '2026-09-21T14:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=Security2 -->' },
  ];
  assert.deepEqual(parseRoster(comments), { reviewers: ['Security2'], at: '2026-09-21T14:00:00Z' });
});

// MUTATION BAR, verified 2026-09-24 by actually editing the source rather than reasoning about
// it: changing card 167's `rosterDefaulted` check from `explicitRoster === null` to
// `!explicitRoster || explicitRoster.reviewers.length === 0` (reintroducing the #352 dead-seat
// bug inside the NEW default-fallback code path -- an explicit empty roster falling back to
// DEFAULT_ROSTER instead of being honoured) turned this test and one other red; reverting turned
// both green again.
test('an empty roster clears roster-resolved in strict mode for a now-withdrawn seat', () => {
  const pr = { number: 352, state: 'OPEN', headRefOid: 'feed0001', headRefName: 'feat/vault-addresses-lint', body: BBB_OK_BODY };
  const comments = [
    { createdAt: '2026-09-21T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=Security -->' },
    // Security's session ended with no verdict posted. Withdrawing the roster to empty must clear
    // roster-resolved (nobody is now required) rather than falling back to DEFAULT_ROSTER.
    { createdAt: '2026-09-21T14:00:00Z', body: '<!-- REVIEW-ROSTER reviewers= -->' },
  ];
  const strict = evaluate({ pr, comments, runs: greenOn('feed0001'), mode: 'strict' });
  assert.deepEqual(ruleIds(strict.blockers), []);
  assert.equal(strict.clear, true);
});

test('CRITICAL: a standing REJECT still blocks after its reviewer is dropped from the roster — the roster fix must not launder a REJECT', () => {
  const pr = { number: 999, state: 'OPEN', headRefOid: 'feed0002', headRefName: 'feat/whatever' };
  const comments = [
    { createdAt: '2026-09-21T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=Security -->' },
    { createdAt: '2026-09-21T11:00:00Z', body: '## Adversarial review — VERDICT\n\n<!-- REVIEW-VERDICT reviewer=Security verdict=REJECT -->' },
    // Security's session ends; the roster is withdrawn to empty so the PR is not stuck forever...
    { createdAt: '2026-09-21T14:00:00Z', body: '<!-- REVIEW-ROSTER reviewers= -->' },
  ];
  for (const mode of /** @type {const} */ (['advisory', 'strict'])) {
    const d = evaluate({ pr, comments, runs: greenOn('feed0002'), mode });
    assert.equal(d.clear, false, `${mode}: withdrawing the roster must NOT clear Security's standing REJECT`);
    assert.ok(
      d.blockers.some((b) => b.ruleId === 'no-standing-reject'),
      `${mode}: no-standing-reject must still fire`,
    );
  }
  // And posting a FRESH roster (even reassigning to nobody, or to a new reviewer) still does not
  // launder it -- only a newer REVIEW-VERDICT token can, per the invariant this asserts.
  const withNewRoster = [
    ...comments,
    { createdAt: '2026-09-21T15:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=SomeoneElse -->' },
  ];
  const d2 = evaluate({ pr, comments: withNewRoster, runs: greenOn('feed0002'), mode: 'strict' });
  assert.ok(d2.blockers.some((b) => b.ruleId === 'no-standing-reject'), 'a fresh roster must not clear a standing REJECT');
});

test('MUTATION: reverting parseRoster to drop empty matches (the #352 bug) is caught', () => {
  const comments = [
    { createdAt: '2026-09-21T10:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=Security -->' },
    { createdAt: '2026-09-21T14:00:00Z', body: '<!-- REVIEW-ROSTER reviewers= -->' },
  ];
  // Simulate the pre-fix behaviour directly (the bug this test must catch if reintroduced):
  // an empty match must be SKIPPED, so `found` stays on the last non-empty roster.
  const preFixParseRoster = (cs) => {
    const ROSTER_RE = /<!--\s*REVIEW-ROSTER\s+reviewers=([^\s>]*)\s*-->/g;
    let found = null;
    for (const c of cs) {
      ROSTER_RE.lastIndex = 0;
      let m;
      while ((m = ROSTER_RE.exec(c.body)) !== null) {
        const reviewers = m[1].split(',').map((s) => s.trim()).filter(Boolean);
        if (reviewers.length > 0) found = { reviewers, at: c.createdAt }; // the bug
      }
    }
    return found;
  };
  assert.deepEqual(preFixParseRoster(comments), { reviewers: ['Security'], at: '2026-09-21T10:00:00Z' }, 'RED: the pre-fix shape must keep reading the dead seat');
  assert.notDeepEqual(parseRoster(comments), preFixParseRoster(comments), 'the real parseRoster must differ from the reintroduced bug on this exact input');
});

// ---------------------------------------------------------------------------------------------
// Card 167 — an unposted roster defaults to Security instead of stalling the PR
// ---------------------------------------------------------------------------------------------
// Eight REVIEW-ROSTER tokens were posted by hand in one evening, every one mechanical, and four
// PRs sat blocked 14-17 days on nothing but that missing comment. `roster-declared` used to block
// forever on a PR nobody rostered; it now defaults instead, and `roster-resolved` is the rule that
// actually has to clear — proving a default does not mean "nobody needs to review".

test('card 167: no REVIEW-ROSTER token ever posted still requires Security to clear, in strict mode', () => {
  const pr = { number: 500, state: 'OPEN', headRefOid: 'feed0500', headRefName: 'fix/whatever' };
  const noToken = evaluate({ pr, comments: [], runs: greenOn('feed0500'), mode: 'strict' });
  assert.equal(noToken.clear, false, 'defaulting must not clear the PR by itself');
  assert.deepEqual(ruleIds(noToken.blockers), ['roster-resolved']);
  assert.equal(noToken.rosterDefaulted, true);
  assert.deepEqual(noToken.roster, ['Security']);
  assert.match(noToken.blockers[0].detail, /Security/);

  // Security posts a verdict without anyone ever declaring a roster: clears.
  const cleared = evaluate({
    pr,
    comments: [{ createdAt: '2026-09-24T00:00:00Z', body: '<!-- REVIEW-VERDICT reviewer=Security verdict=ACCEPT -->' }],
    runs: greenOn('feed0500'),
    mode: 'strict',
  });
  assert.equal(cleared.clear, true, 'the default roster must be resolvable exactly like an explicit one');
  assert.equal(cleared.rosterDefaulted, true);
});

test('card 167: an explicit REVIEW-ROSTER token still overrides the default', () => {
  const pr = { number: 501, state: 'OPEN', headRefOid: 'feed0501', headRefName: 'fix/whatever' };
  const comments = [{ createdAt: '2026-09-24T00:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=Finance -->' }];
  const d = evaluate({ pr, comments, runs: greenOn('feed0501'), mode: 'strict' });
  assert.equal(d.rosterDefaulted, false);
  assert.deepEqual(d.roster, ['Finance']);
  assert.deepEqual(ruleIds(d.blockers), ['roster-resolved']);
  assert.match(d.blockers[0].detail, /Finance/);
  assert.doesNotMatch(d.blockers[0].detail, /defaulted/, 'an explicit roster must not be reported as a default');
});

test('card 167: advisory mode never blocks on the defaulted roster (Mode B is strict-only)', () => {
  const pr = { number: 502, state: 'OPEN', headRefOid: 'feed0502', headRefName: 'fix/whatever' };
  const d = evaluate({ pr, comments: [], runs: greenOn('feed0502'), mode: 'advisory' });
  assert.equal(d.clear, true);
  assert.equal(d.rosterDefaulted, true);
  assert.ok(d.notes.some((n) => n.includes('roster defaulted to Security')));
});

test('MUTATION BAR — an empty DEFAULT_ROSTER must not silently clear an unrostered PR', () => {
  // The regression this guards: DEFAULT_ROSTER = [] (or any change that makes the default
  // resolve to nobody) turns "no REVIEW-ROSTER token" back into "nobody needs to review" --
  // exactly the stall-shaped bug card 167 exists to close, just inverted into a silent PASS
  // instead of a silent STALL. Verified by actually mutating DEFAULT_ROSTER to [] in
  // scripts/lib/verdicts.mjs and re-running this suite (2026-09-24): this test went red (on the
  // `.clear` assertion below, the first one it reaches) along with 5 others in the file; reverting
  // the mutation returned all 6 to green.
  const pr = { number: 504, state: 'OPEN', headRefOid: 'feed0504', headRefName: 'fix/whatever' };
  const d = evaluate({ pr, comments: [], runs: greenOn('feed0504'), mode: 'strict' });
  assert.equal(d.clear, false, 'RED if DEFAULT_ROSTER is empty: an empty roster has nothing left to resolve, so this would wrongly clear');
  assert.ok(d.roster && d.roster.length > 0, 'RED if DEFAULT_ROSTER is empty: the defaulted roster must name at least one reviewer');
  assert.deepEqual(ruleIds(d.blockers), ['roster-resolved']);
});

// ---------------------------------------------------------------------------------------------
// Card #59: report-only surfacing of verdict tokens that reach the gate silently unparsed
// ---------------------------------------------------------------------------------------------

test('parseUnparseableVerdicts: an invalid verdict= value is reported; the standard values are not', () => {
  const invalid = [{ createdAt: '2026-09-19T00:00:00Z', body: '<!-- REVIEW-VERDICT reviewer=Finance verdict=REQUEST_CHANGES -->' }];
  const found = parseUnparseableVerdicts(invalid);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { reviewer: 'Finance', value: 'REQUEST_CHANGES', at: '2026-09-19T00:00:00Z' });

  // MUTATION direction 1: fixing the value to ACCEPT must make it disappear from this report AND
  // start counting as a real verdict.
  const fixed = [{ createdAt: '2026-09-19T00:05:00Z', body: '<!-- REVIEW-VERDICT reviewer=Finance verdict=ACCEPT -->' }];
  assert.deepEqual(parseUnparseableVerdicts(fixed), []);
  const d = evaluate({ pr: { number: 1, state: 'OPEN', headRefOid: 'a', headRefName: 'x' }, comments: fixed, runs: greenOn('a') });
  assert.ok(Object.keys(d.latestVerdicts).includes('Finance'), 'the fixed token must count as a real verdict');

  assert.deepEqual(parseUnparseableVerdicts([]), []);
});

test('evaluate(): an unparseable verdict token is reported as a note, never clears, and (card 216) blocks as the reviewer\'s newest word', () => {
  const pr = { number: 307, state: 'OPEN', headRefOid: 'feed0059', headRefName: 'x' };
  const comments = [
    { createdAt: '2026-09-19T00:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=Finance -->' },
    { createdAt: '2026-09-19T00:05:00Z', body: '<!-- REVIEW-VERDICT reviewer=Finance verdict=REQUEST_CHANGES -->' },
  ];
  const d = evaluate({ pr, comments, runs: greenOn('feed0059'), mode: 'strict' });
  // Still blocked: the malformed token counts as no verdict, so the roster is unresolved, and it is
  // Finance's newest token, so it blocks in its own right (card 216).
  assert.equal(d.clear, false);
  assert.deepEqual(ruleIds(d.blockers).sort(), ['no-standing-reject', 'roster-resolved']);
  assert.ok(
    d.notes.some((n) => n.includes('verdict token found but not parsed') && n.includes('REQUEST_CHANGES')),
    'the report must name the unparsed value',
  );

  // MUTATION direction 2: the fixed value clears the note AND resolves the roster.
  const fixed = [
    comments[0],
    { createdAt: '2026-09-19T00:05:00Z', body: '<!-- REVIEW-VERDICT reviewer=Finance verdict=ACCEPT -->' },
  ];
  const d2 = evaluate({ pr, comments: fixed, runs: greenOn('feed0059'), mode: 'strict' });
  assert.equal(d2.clear, true);
  assert.ok(!d2.notes.some((n) => n.includes('verdict token found but not parsed')));
});

test('reviewObjectVerdicts: a rostered reviewer\'s token in a REVIEW OBJECT is reported only while comments carry none from them', () => {
  const reviews = [{ author: 'Finance', body: '<!-- REVIEW-VERDICT reviewer=Finance verdict=ACCEPT -->' }];
  // Rostered, no comment-verdict yet: reported.
  assert.deepEqual(reviewObjectVerdicts(reviews, {}, ['Finance']), ['Finance']);
  // Not on the roster: not reported -- this channel-mismatch report is scoped to reviewers who are
  // actually expected to post, same as roster-resolved itself.
  assert.deepEqual(reviewObjectVerdicts(reviews, {}, ['SomeoneElse']), []);
  // MUTATION direction: once the SAME verdict also exists in `comments` (re-posted correctly), the
  // report must go quiet.
  assert.deepEqual(reviewObjectVerdicts(reviews, { Finance: { verdict: 'ACCEPT', at: 'now' } }, ['Finance']), []);
  // A review object with no parseable token at all is not reported (prose review summary, etc).
  assert.deepEqual(reviewObjectVerdicts([{ author: 'Finance', body: 'Looks good to me' }], {}, ['Finance']), []);
});

test('evaluate(): a verdict posted only as a review object is a NOTE, never counted, never clears', () => {
  const pr = { number: 308, state: 'OPEN', headRefOid: 'feed0058', headRefName: 'x' };
  const comments = [{ createdAt: '2026-09-19T00:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=Finance -->' }];
  const reviews = [{ author: 'Finance', body: '<!-- REVIEW-VERDICT reviewer=Finance verdict=ACCEPT -->' }];
  const d = evaluate({ pr, comments, runs: greenOn('feed0058'), reviews, mode: 'strict' });
  assert.equal(d.clear, false, 'a review-object token must never clear roster-resolved');
  assert.deepEqual(ruleIds(d.blockers), ['roster-resolved']);
  assert.ok(d.notes.some((n) => n.includes('Finance posted a verdict as a review object')));

  // MUTATION direction: re-posting the SAME token as a comment (the correct channel) clears both
  // the blocker and the note.
  const reposted = [...comments, { createdAt: '2026-09-19T00:10:00Z', body: '<!-- REVIEW-VERDICT reviewer=Finance verdict=ACCEPT -->' }];
  const d2 = evaluate({ pr, comments: reposted, runs: greenOn('feed0058'), reviews, mode: 'strict' });
  assert.equal(d2.clear, true);
  assert.ok(!d2.notes.some((n) => n.includes('posted a verdict as a review object')));
});

test('evaluate(): omitting `reviews` entirely (every pre-existing caller/fixture) is unaffected', () => {
  const pr = { number: 1, state: 'OPEN', headRefOid: 'a', headRefName: 'x' };
  const comments = [{ createdAt: '2026-09-19T00:00:00Z', body: '<!-- REVIEW-ROSTER reviewers= -->' }];
  const d = evaluate({ pr, comments, runs: greenOn('a'), mode: 'strict' });
  assert.equal(d.clear, true);
  assert.deepEqual(d.notes, []);
});

// ---------------------------------------------------------------------------------------------
// Card 216: a reviewer's NEWEST token being unreadable blocks, whatever their older verdict says
// ---------------------------------------------------------------------------------------------

{
  const pr = { number: 216, state: 'OPEN', headRefOid: 'feed0216', headRefName: 'x' };
  const roster = { createdAt: '2026-09-24T00:00:00Z', body: '<!-- REVIEW-ROSTER reviewers=Security -->' };
  const tok = (at, v) => ({ createdAt: at, body: `<!-- REVIEW-VERDICT reviewer=Security verdict=${v} -->` });

  test('card 216: ACCEPT then a malformed verdict=Reject BLOCKS, in both modes', () => {
    const comments = [roster, tok('2026-09-24T01:00:00Z', 'ACCEPT'), tok('2026-09-24T02:00:00Z', 'Reject')];
    for (const mode of /** @type {const} */ (['advisory', 'strict'])) {
      const d = evaluate({ pr, comments, runs: greenOn('feed0216'), mode });
      assert.equal(d.clear, false, `${mode}: a newer unreadable token must not merge on the older ACCEPT`);
      assert.deepEqual(ruleIds(d.blockers), ['no-standing-reject']);
      assert.ok(d.blockers.some((b) => /unreadable \(verdict=Reject/.test(b.detail) && /Repost/.test(b.detail)));
    }
  });

  test('card 216: ACCEPT, malformed, then a valid ACCEPT clears', () => {
    const comments = [roster, tok('2026-09-24T01:00:00Z', 'ACCEPT'), tok('2026-09-24T02:00:00Z', 'Reject'), tok('2026-09-24T03:00:00Z', 'ACCEPT')];
    const d = evaluate({ pr, comments, runs: greenOn('feed0216'), mode: 'strict' });
    assert.equal(d.clear, true);
    assert.deepEqual(unreadableLatestVerdicts(comments), []);
  });

  test('card 216: a malformed token OLDER than a valid verdict does not block', () => {
    const comments = [roster, tok('2026-09-24T01:00:00Z', 'Reject'), tok('2026-09-24T02:00:00Z', 'ACCEPT')];
    assert.equal(evaluate({ pr, comments, runs: greenOn('feed0216'), mode: 'strict' }).clear, true);
  });

  test('card 216: same timestamp, same comment — the token that comes LAST in the body decides', () => {
    const at = '2026-09-24T01:00:00Z';
    const accLast = [roster, { createdAt: at, body: '<!-- REVIEW-VERDICT reviewer=Security verdict=Reject --> fixed: <!-- REVIEW-VERDICT reviewer=Security verdict=ACCEPT -->' }];
    const badLast = [roster, { createdAt: at, body: '<!-- REVIEW-VERDICT reviewer=Security verdict=ACCEPT --> then <!-- REVIEW-VERDICT reviewer=Security verdict=Reject -->' }];
    assert.equal(evaluate({ pr, comments: accLast, runs: greenOn('feed0216'), mode: 'strict' }).clear, true);
    assert.equal(evaluate({ pr, comments: badLast, runs: greenOn('feed0216'), mode: 'strict' }).clear, false);
  });

  test('card 216: same timestamp, separate comments — comment order decides', () => {
    const at = '2026-09-24T01:00:00Z';
    assert.equal(evaluate({ pr, comments: [roster, tok(at, 'ACCEPT'), tok(at, 'Reject')], runs: greenOn('feed0216'), mode: 'strict' }).clear, false);
    assert.equal(evaluate({ pr, comments: [roster, tok(at, 'Reject'), tok(at, 'ACCEPT')], runs: greenOn('feed0216'), mode: 'strict' }).clear, true);
  });

  test('card 216: another reviewer\'s malformed token does not touch Security, and blocks for its own author', () => {
    const comments = [roster, tok('2026-09-24T01:00:00Z', 'ACCEPT'), { createdAt: '2026-09-24T02:00:00Z', body: '<!-- REVIEW-VERDICT reviewer=Product verdict=LGTM -->' }];
    assert.deepEqual(unreadableLatestVerdicts(comments), [{ reviewer: 'Product', value: 'LGTM', at: '2026-09-24T02:00:00Z' }]);
    const d = evaluate({ pr, comments, runs: greenOn('feed0216'), mode: 'strict' });
    assert.equal(d.clear, false);
    assert.ok(d.blockers.every((b) => !b.detail.startsWith('Security')));
  });
}

// ---------------------------------------------------------------------------------------------
// Only collaborators speak to the gate (Security, Findings/2026-09-24-merge-gate-counts-anyones-
// comments.md): the repo is public, and a token names its reviewer in its own text.
// ---------------------------------------------------------------------------------------------

{
  const pr = { number: 417, state: 'OPEN', headRefOid: 'feed0417', headRefName: 'x' };
  const by = (assoc, login, at, body) => ({ createdAt: at, body, author: { login }, authorAssociation: assoc });
  const real = [
    by('OWNER', 'SlumperSan', '2026-09-24T01:00:00Z', '<!-- REVIEW-ROSTER reviewers=Security -->'),
    by('OWNER', 'SlumperSan', '2026-09-24T02:00:00Z', '<!-- REVIEW-VERDICT reviewer=Security verdict=REJECT -->'),
  ];

  test('trusted commenters: a forged ACCEPT from a NONE-association account does not clear a real REJECT', () => {
    const raw = [...real, by('NONE', 'mallory', '2026-09-24T03:00:00Z', '<!-- REVIEW-VERDICT reviewer=Security verdict=ACCEPT -->')];
    const t = trustedComments(raw);
    assert.deepEqual(t.dropped, ['mallory (NONE)']);
    for (const mode of /** @type {const} */ (['advisory', 'strict'])) {
      const d = evaluate({ pr, comments: t.comments, runs: greenOn('feed0417'), mode });
      assert.equal(d.clear, false, `${mode}: the forged ACCEPT must not supersede the REJECT`);
      assert.deepEqual(ruleIds(d.blockers), ['no-standing-reject']);
    }
    // Non-vacuity: the same forged comment, if trusted, WOULD clear — so the filter is what blocks.
    const untrusted = evaluate({ pr, comments: raw.map((c) => ({ createdAt: c.createdAt, body: c.body })), runs: greenOn('feed0417'), mode: 'strict' });
    assert.equal(untrusted.clear, true);
  });

  test('trusted commenters: a forged re-roster plus self-ACCEPT from a CONTRIBUTOR is ignored', () => {
    const raw = [
      by('OWNER', 'SlumperSan', '2026-09-24T01:00:00Z', '<!-- REVIEW-ROSTER reviewers=Security -->'),
      by('CONTRIBUTOR', 'mallory', '2026-09-24T02:00:00Z', '<!-- REVIEW-ROSTER reviewers=Mallory --> <!-- REVIEW-VERDICT reviewer=Mallory verdict=ACCEPT -->'),
    ];
    const d = evaluate({ pr, comments: trustedComments(raw).comments, runs: greenOn('feed0417'), mode: 'strict' });
    assert.equal(d.clear, false);
    assert.deepEqual(d.roster, ['Security']);
    assert.deepEqual(ruleIds(d.blockers), ['roster-resolved']);
  });

  test('trusted commenters: OWNER, MEMBER and COLLABORATOR are read; every other association is not', () => {
    assert.deepEqual([...TRUSTED_ASSOCIATIONS].sort(), ['COLLABORATOR', 'MEMBER', 'OWNER']);
    for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      assert.equal(trustedComments([by(assoc, 'a', 't', 'x')]).comments.length, 1, assoc);
    }
    for (const assoc of ['NONE', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', '', 'owner']) {
      assert.equal(trustedComments([by(assoc, 'a', 't', 'x')]).comments.length, 0, assoc);
    }
    // An untrusted comment with no token is dropped silently; only token-bearing ones are named.
    assert.deepEqual(trustedComments([by('NONE', 'a', 't', 'nice PR')]).dropped, []);
  });

  test('validateGhPayloads fails CLOSED on a comment with no authorAssociation', () => {
    const noAssoc = { ...okPr(), comments: [{ createdAt: 't', body: 'x', author: { login: 'SlumperSan' } }] };
    assert.match(String(validateGhPayloads(noAssoc, okRuns(), 0)), /authorAssociation/);
    assert.match(String(validateGhPayloads({ ...okPr(), comments: [null] }, okRuns(), 0)), /authorAssociation/);
  });

  test('main() feeds evaluate the TRUSTED comments, not the raw payload', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'merge-preflight.mjs'), 'utf8');
    const call = src.slice(src.indexOf('const decision = evaluate({'), src.indexOf('mode: opts.mode,'));
    assert.match(call, /comments: trusted\.comments,/);
    assert.doesNotMatch(call, /pr\.data\.comments/);
    assert.match(src, /const trusted = trustedComments\(pr\.data\.comments\);/);
  });
}

// ---------------------------------------------------------------------------------------------
// Card 190 / Chairman directive 13 — `## Buy / borrow / build` and `## Standards` on `feat/` PRs
// ---------------------------------------------------------------------------------------------

test('extractSection: finds the heading loosely, bounds content at the next heading, and returns null when absent', () => {
  const body = 'intro\n\n## Buy / borrow / build\nline one\nline two\n\n## Standards\nstandards line\n';
  assert.equal(extractSection(body, BBB_SECTIONS[0].heading).trim(), 'line one\nline two');
  assert.equal(extractSection(body, BBB_SECTIONS[1].heading).trim(), 'standards line');
  assert.equal(extractSection('no such heading here', BBB_SECTIONS[0].heading), null);
  // Spacing/slash variance the real skeleton and hand-written PRs both produce.
  assert.equal(extractSection('## Buy/borrow/build\nx', BBB_SECTIONS[0].heading), 'x');
  assert.equal(extractSection('##   Buy  /  borrow  /  build\nx', BBB_SECTIONS[0].heading), 'x');
});

test('MUTATION BAR — isBlankSection: the shapes that must fail, and the ones that must pass', () => {
  // Must be caught (blank): whitespace only, HTML comment only, one unfilled placeholder token.
  for (const blank of [
    '', '   \n  \n', '<!-- fill this in -->', '<!-- one --><!-- two -->  ',
    '<what you grepped in this repo, and what you found or did not>',
    '[fill this in]', 'TBD', 'TODO', 'N/A', 'FILL-IN', 'PLACEHOLDER', 'xxx',
  ]) {
    assert.equal(isBlankSection(blank), true, `must read as blank: ${JSON.stringify(blank)}`);
  }
  // Must NOT be caught (real content) — "None found" above all, per the card's own acceptance line.
  for (const real of [
    'None found.',
    '- **Searched:** grepped scripts/lib for an existing parser — none found\n- **Existing options:** none found\n- **Why we built:** narrow enough not to warrant a dependency',
    'a placeholder token elsewhere does not blank real prose: we searched npm, found nothing <shrug>',
    'None applies.',
    'no deviation',
  ]) {
    assert.equal(isBlankSection(real), false, `must NOT read as blank: ${JSON.stringify(real)}`);
  }
});

test('gradeSections: missing vs blank vs ok are three distinct, reported states', () => {
  assert.deepEqual(
    gradeSections('nothing relevant here').map((s) => s.state),
    ['missing', 'missing'],
  );
  assert.deepEqual(
    gradeSections('## Buy / borrow / build\n\n<!-- TODO -->\n\n## Standards\nnone applies').map((s) => s.state),
    ['blank', 'ok'],
  );
  assert.deepEqual(gradeSections(BBB_OK_BODY).map((s) => s.state), ['ok', 'ok']);
});

test('evaluate(): a feat/ PR with no body at all is blocked, in both modes', () => {
  const pr = { number: 1, state: 'OPEN', headRefOid: 'a', headRefName: 'feat/new-thing' };
  for (const mode of /** @type {const} */ (['advisory', 'strict'])) {
    const d = evaluate({ pr, comments: [], runs: greenOn('a'), mode });
    assert.ok(d.blockers.some((b) => b.ruleId === 'buy-borrow-build-declared'), `${mode}: missing body must block`);
    assert.match(
      d.blockers.find((b) => b.ruleId === 'buy-borrow-build-declared').detail,
      /Buy \/ borrow \/ build/,
    );
  }
});

test('evaluate(): a feat/ PR whose sections are present but blank is blocked, and names which section', () => {
  const blankBoth = '## Buy / borrow / build\n<!-- -->\n\n## Standards\nTBD\n';
  const d = evaluate({
    pr: { number: 1, state: 'OPEN', headRefOid: 'a', headRefName: 'feat/new-thing', body: blankBoth },
    comments: [], runs: greenOn('a'), mode: 'advisory',
  });
  const bbb = d.blockers.filter((b) => b.ruleId === 'buy-borrow-build-declared');
  assert.equal(bbb.length, 2, 'both sections are blank, so both must be reported');
  assert.ok(bbb.some((b) => b.detail.includes('Buy / borrow / build')));
  assert.ok(bbb.some((b) => b.detail.includes('Standards')));
});

test('evaluate(): "None found" / "None applies" is real content and clears buy-borrow-build-declared', () => {
  const pr = { number: 1, state: 'OPEN', headRefOid: 'a', headRefName: 'feat/new-thing', body: BBB_OK_BODY };
  const d = evaluate({ pr, comments: [], runs: greenOn('a'), mode: 'advisory' });
  assert.ok(!d.blockers.some((b) => b.ruleId === 'buy-borrow-build-declared'), '"None found" must not block');
});

test('evaluate(): a non-feat/ PR with no body at all is NOT blocked by buy-borrow-build-declared', () => {
  for (const branch of ['fix/x', 'test/x', 'docs/x', 'chore/x', 'x']) {
    const pr = { number: 1, state: 'OPEN', headRefOid: 'a', headRefName: branch };
    const d = evaluate({ pr, comments: [], runs: greenOn('a'), mode: 'advisory' });
    assert.ok(!d.blockers.some((b) => b.ruleId === 'buy-borrow-build-declared'), `${branch} must not be gated by this rule`);
  }
});
