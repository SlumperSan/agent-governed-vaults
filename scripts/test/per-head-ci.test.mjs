/**
 * Pins for `npm run cc`'s per-head verification column.
 *
 * WHY THIS FILE EXISTS. On 2026-09-02 six sessions each re-derived by hand whether a given PR head
 * had verified CI, and the shared answer was published wrong twice -- once as a stale list of
 * "known-good greens", once as a stale list of open findings measured against a head that had
 * already moved. The fix was to compute the fact in `cc` instead of in six heads. This file exists
 * so the four specific misreadings that caused those wrong answers cannot come back silently.
 *
 * Every case below is a real observation from that night, not a hypothetical. The classifiers are
 * pure functions over the GraphQL shape precisely so they can be pinned WITHOUT the network -- a
 * test that needed GitHub to be up would itself be unavailable during the outage that motivated
 * trap 4.
 *
 * ## The four traps, and which test holds each
 *
 * 1. Match by commit, never by PR association       -> "the latest CI suite wins, never nodes[0]"
 * 2. A run's conclusion is not the status it posts   -> the two classifiers are separate functions
 *                                                       over separate inputs; a preflight fixture
 *                                                       is not even accepted by classifyCi
 * 3. Absent evidence is neither a pass nor a fail    -> the `none` block
 * 4. An infrastructure stop looks like a code failure -> the `no-runner` block
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCi, classifyPreflight } from '../lib/project-status.mjs';

/** A completed check suite for the named workflow, `secs` seconds wide. */
const suite = (name, conclusion, secs, createdAt = '2026-09-02T00:00:00Z', status = 'COMPLETED') => ({
  status,
  conclusion,
  createdAt,
  updatedAt: new Date(Date.parse(createdAt) + secs * 1000).toISOString(),
  workflowRun: { databaseId: 1, url: 'https://example.invalid/1', workflow: { name } },
});

// ---------------------------------------------------------------- trap 3: absent evidence

test('a head with no runs at all reports `none` -- not a pass, not a failure', () => {
  const r = classifyCi([]);
  assert.equal(r.label, 'none');
  assert.notEqual(r.label, 'pass');
  assert.notEqual(r.label, 'fail');
});

test('`none` distinguishes "no CI run" from "no run NAMED CI", and says what it did see', () => {
  // If the workflow is ever renamed, every head would silently read `none`. That is trap 3 arriving
  // as a LABELLING failure rather than a missing run, so the note has to name the suites present.
  const r = classifyCi([suite('merge-preflight', 'SUCCESS', 500)]);
  assert.equal(r.label, 'none');
  assert.match(r.note, /no suite named CI/);
  assert.match(r.note, /merge-preflight/);
});

test('a queued or running suite is `pending`, never the raw null conclusion', () => {
  const s = suite('CI', null, 0, '2026-09-02T00:00:00Z', 'QUEUED');
  assert.equal(classifyCi([s]).label, 'pending');
  const running = suite('CI', null, 0, '2026-09-02T00:00:00Z', 'IN_PROGRESS');
  assert.equal(classifyCi([running]).label, 'pending');
});

test('a conclusion we do not recognise is never reported as a pass', () => {
  for (const c of ['CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'NEUTRAL', 'SKIPPED', '']) {
    const r = classifyCi([suite('CI', c, 30)]);
    assert.notEqual(r.label, 'pass', `${c || '(empty)'} must not read as a pass`);
    assert.match(r.label, /^fail/);
  }
});

// ---------------------------------------------------------------- trap 1: match the commit, and
// within the commit, the LATEST run

test('the latest CI suite wins, never nodes[0] -- a re-run must not report the stale red', () => {
  // The live case this guards: during the Actions outage every head carried a 3s FAILURE. When
  // runners came back and sessions re-ran, each head carried BOTH the old red and the new green.
  // Reading array order would report the stale red -- `green-belongs-to-a-commit` committed inside
  // the tool built to prevent it. Order is deliberately scrambled here: the answer must come from
  // createdAt, not from position.
  const stale = suite('CI', 'FAILURE', 3, '2026-09-02T04:56:00Z');
  const fresh = suite('CI', 'SUCCESS', 470, '2026-09-02T09:10:00Z');

  for (const order of [[stale, fresh], [fresh, stale]]) {
    const r = classifyCi(order);
    assert.equal(r.label, 'pass');
    assert.equal(r.suites, 2);
    assert.match(r.note, /2 CI suites/, 'a re-run must be visible to the reader, not silently collapsed');
  }
});

test('suites belonging to other workflows never contribute to the CI verdict', () => {
  // merge-preflight runs on the same head and routinely disagrees with CI. Folding it in is trap 2.
  const r = classifyCi([suite('merge-preflight', 'FAILURE', 4), suite('CI', 'SUCCESS', 470)]);
  assert.equal(r.label, 'pass');
  assert.equal(r.suites, 1, 'only CI suites are counted');
});

// ---------------------------------------------------------------- trap 4: infrastructure, not code

test('a failure seconds wide is flagged as a suspected no-runner stop', () => {
  // Observed 2026-09-02 on #130 and #132: conclusion=failure, 3s and 5s wide, every job steps=0
  // with no runner assigned. Real jobs in this repo take 400-500s. (The CAUSE that day turned out
  // to be a billing stop, not capacity -- which is why the label says `no-runner` and leaves the
  // reason to the annotation `--ci-jobs` fetches. Naming a cause you have not read is the error.)
  const r = classifyCi([suite('CI', 'FAILURE', 3)]);
  assert.equal(r.label, 'fail(no-runner?)');
  assert.equal(r.seconds, 3);
  assert.ok(r.runId, 'the run id must survive, because --ci-jobs needs it to confirm');
});

test('the question mark is load-bearing: the duration alone is a heuristic, not a confirmation', () => {
  // The default label must stay interrogative. Confirming costs one API call per run (`--ci-jobs`),
  // and the tool must never claim "infrastructure, not code" on a timing coincidence alone.
  // Nor may it guess WHICH infrastructure cause: capacity clears itself and a billing stop does
  // not, so `--ci-jobs` reads the job annotation and quotes it rather than inferring.
  assert.ok(classifyCi([suite('CI', 'FAILURE', 3)]).label.includes('?'));
});

test('a genuine long failure is NOT excused as infrastructure', () => {
  // Observed the same night on #124: conclusion=failure, 450s wide. Real. Mislabelling this as
  // infrastructure is how a red gets ignored, which is the more dangerous direction of trap 4.
  const r = classifyCi([suite('CI', 'FAILURE', 450)]);
  assert.equal(r.label, 'fail');
  assert.doesNotMatch(r.label, /runner/);
});

// ---------------------------------------------------------------- trap 2: the posted status is a
// DIFFERENT artifact from the run that posted it

test('no posted commit status reports `none`, never `pending` and never a pass', () => {
  // Sharper than it looks. The REST endpoint returns `{state: "pending", statuses: []}` for a head
  // with NO statuses at all, so reading the rollup `state` would render `preflight=pending` on a
  // head where the gate never spoke. Only the CONTEXTS can answer this. Observed on #120, #124
  // and #130, all of which have zero statuses and a REST rollup state of "pending".
  assert.equal(classifyPreflight(null).label, 'none');
  assert.equal(classifyPreflight({ state: 'PENDING', contexts: [] }).label, 'none');
});

test('a commit status from some other context is not a preflight verdict', () => {
  const r = classifyPreflight({ state: 'SUCCESS', contexts: [{ context: 'codecov/patch', state: 'SUCCESS', description: '' }] });
  assert.equal(r.label, 'none');
  assert.match(r.note, /no merge-preflight context/);
  assert.match(r.note, /codecov\/patch/);
});

test('the posted preflight status is read from the context, and carries its description', () => {
  const r = classifyPreflight({ state: 'SUCCESS', contexts: [{ context: 'merge-preflight', state: 'SUCCESS', description: 'no blocker found' }] });
  assert.equal(r.label, 'success');
  assert.equal(r.note, 'no blocker found');
});

test('THE CENTRAL CASE: a run that SUCCEEDS at posting a RED must read run=pass, status=failure', () => {
  // This is the exact pair four sessions conflated in one night. `merge-preflight` does its work
  // correctly and posts `failure`; its own run therefore concludes `success`. The two classifiers
  // must disagree here, and the renderer labels them `CI run=` and `preflight=` so that no reader
  // can collapse them back into one verdict.
  //
  // Note the CI column is deliberately unaffected by the preflight run: CI is `none` on this head.
  const suites = [suite('merge-preflight', 'SUCCESS', 500)];
  const status = { state: 'FAILURE', contexts: [{ context: 'merge-preflight', state: 'FAILURE', description: 'blocked, see the job log' }] };

  assert.equal(classifyCi(suites).label, 'none', 'a preflight run is not CI evidence');
  assert.equal(classifyPreflight(status).label, 'failure', 'the POSTED decision is the red');
  // Stated as an assertion rather than a comment, because the whole point is that these two values
  // are produced by different code paths from different inputs and are allowed to disagree.
  assert.notEqual(classifyCi(suites).label, classifyPreflight(status).label);
});
