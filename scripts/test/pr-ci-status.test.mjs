// @ts-check
/**
 * Pure-logic tests for scripts/lib/pr-ci-status.mjs -- the "why" is in that module's header. No
 * `gh` is invoked; `runList`/`runJobs` are stubbed, so this exercises every state rather than
 * whatever the org's runners happen to be doing this minute.
 *
 * The load-bearing assertions are the ones that check what is NOT green: `none`, `unknown` and
 * `outage` all have to stay distinguishable from a pass, because collapsing them is the bug the
 * module exists to fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOutageEvidence,
  cacheTtlMs,
  ciRank,
  classifyRuns,
  describeCiState,
  isZeroStepJobSet,
  latestRunPerWorkflow,
  outageProbeTargets,
  resolvePrCi,
  shortSha,
} from '../lib/pr-ci-status.mjs';

/** A completed run. `ms` is how long it took, which is the outage prefilter's input. */
const run = (workflowName, conclusion, { id = 1, ms = 300_000, at = '2026-09-02T04:00:00Z', event = 'pull_request' } = {}) => ({
  workflowName,
  event,
  status: 'completed',
  conclusion,
  databaseId: id,
  createdAt: at,
  updatedAt: new Date(Date.parse(at) + ms).toISOString(),
});

const running = (workflowName, { id = 9, at = '2026-09-02T04:00:00Z' } = {}) => ({
  workflowName,
  event: 'pull_request',
  status: 'in_progress',
  conclusion: '',
  databaseId: id,
  createdAt: at,
  updatedAt: at,
});

// ---------------------------------------------------------------- the five states

test('a completed successful run at this SHA -> green', () => {
  const v = classifyRuns({ ok: true, runs: [run('CI', 'success'), run('merge-preflight', 'success', { id: 2 })] });
  assert.equal(v.state, 'green');
  assert.equal(describeCiState(v.state).tone, 'go');
});

test('a completed failing run -> red', () => {
  const v = classifyRuns({ ok: true, runs: [run('CI', 'success'), run('merge-preflight', 'failure', { id: 2 })] });
  assert.equal(v.state, 'red');
  assert.deepEqual(v.failing.map((r) => r.workflowName), ['merge-preflight']);
});

test('a run that is not completed -> pending, never green', () => {
  const v = classifyRuns({ ok: true, runs: [run('CI', 'success'), running('merge-preflight')] });
  assert.equal(v.state, 'pending');
  assert.notEqual(v.state, 'green');
});

test('NO run at this SHA -> none, and none is not a pass', () => {
  const v = classifyRuns({ ok: true, runs: [] });
  assert.equal(v.state, 'none');
  assert.notEqual(v.state, 'green');
  // The label must say so in words: on a status board a dash reads as "nothing wrong".
  const { label, tone } = describeCiState('none');
  assert.match(label, /unverified/i);
  assert.notEqual(tone, 'go');
});

test('gh failed -> unknown, distinct from none, and not a pass', () => {
  const v = classifyRuns({ ok: false });
  assert.equal(v.state, 'unknown');
  assert.notEqual(v.state, 'none', 'unreachable GitHub is a different fact from an unpushed head');
  assert.notEqual(v.state, 'green');
  assert.match(describeCiState('unknown').label, /unverified/i);
});

test('a malformed/absent fetch result is unknown, never green', () => {
  for (const bad of [undefined, null, {}, { ok: 'yes' }]) {
    assert.equal(classifyRuns(/** @type {any} */ (bad)).state, 'unknown');
  }
});

// ---------------------------------------------------------------- skipped is not evidence

test('all runs skipped -> none, NOT green', () => {
  const v = classifyRuns({ ok: true, runs: [run('CI', 'skipped'), run('merge-preflight', 'skipped', { id: 2 })] });
  assert.equal(v.state, 'none');
  assert.notEqual(v.state, 'green');
  assert.notEqual(v.state, 'red', 'a skip is the absence of evidence, not a failure');
});

test('some success + some skipped -> green', () => {
  const v = classifyRuns({ ok: true, runs: [run('CI', 'success'), run('merge-preflight', 'skipped', { id: 2 })] });
  assert.equal(v.state, 'green');
});

test('a failure outranks a run still in flight', () => {
  const v = classifyRuns({ ok: true, runs: [run('CI', 'failure'), running('merge-preflight')] });
  assert.equal(v.state, 'red', 'the other workflows finishing cannot make this head verified');
});

// ---------------------------------------------------------------- re-runs at the same SHA

test('a newer success supersedes an older failure of the same workflow -> green', () => {
  // Observed on protocol/main: bab5ee90 carried four merge-preflight runs at one SHA.
  const v = classifyRuns({
    ok: true,
    runs: [
      run('merge-preflight', 'failure', { id: 10, at: '2026-09-02T04:53:08Z' }),
      run('merge-preflight', 'success', { id: 40, at: '2026-09-02T05:00:15Z' }),
      run('merge-preflight', 'failure', { id: 20, at: '2026-09-02T04:56:24Z' }),
    ],
  });
  assert.equal(v.state, 'green', 'a superseded attempt must not pin the head red forever');
  assert.equal(v.runs.length, 1);
});

test('latestRunPerWorkflow keys on workflow AND event, and does not trust input order', () => {
  const kept = latestRunPerWorkflow([
    run('CI', 'success', { id: 2, at: '2026-09-02T05:00:00Z', event: 'push' }),
    run('CI', 'failure', { id: 1, at: '2026-09-02T04:00:00Z', event: 'pull_request' }),
    run('CI', 'failure', { id: 3, at: '2026-09-02T04:30:00Z', event: 'push' }),
  ]);
  assert.equal(kept.length, 2, 'push and pull_request are separate runs, not re-runs of each other');
  assert.equal(kept.find((r) => r.event === 'push')?.databaseId, 2);
});

test('same createdAt breaks the tie on databaseId', () => {
  const kept = latestRunPerWorkflow([
    run('CI', 'failure', { id: 7, at: '2026-09-02T04:00:00Z' }),
    run('CI', 'success', { id: 8, at: '2026-09-02T04:00:00Z' }),
  ]);
  assert.equal(kept[0].databaseId, 8);
});

// ---------------------------------------------------------------- the outage shape

test('zero-step job set is the capacity signature; an empty job list is not', () => {
  assert.equal(isZeroStepJobSet([{ steps: [] }, { steps: [] }]), true);
  assert.equal(isZeroStepJobSet([{ steps: [] }, { steps: [{}, {}] }]), false);
  assert.equal(isZeroStepJobSet([]), false, 'no jobs = a run we could not read, not a proven outage');
  assert.equal(isZeroStepJobSet(/** @type {any} */ (undefined)), false);
});

test('a fast red whose jobs ran no steps -> outage, not red', () => {
  const v = classifyRuns({ ok: true, runs: [run('merge-preflight', 'failure', { id: 5, ms: 5_000 })] });
  assert.equal(v.state, 'red');
  const out = applyOutageEvidence(v, new Map([[5, true]]));
  assert.equal(out.state, 'outage');
  assert.notEqual(describeCiState('outage').tone, 'nogo', 'an outage is not a verdict on the candidate');
  assert.match(out.detail, /never ran/);
});

test('a 10s red is still probed -- the 2026-09-02 outage produced 3s, 5s and 10s reds', () => {
  const v = classifyRuns({ ok: true, runs: [run('merge-preflight', 'failure', { id: 5, ms: 10_000 })] });
  assert.equal(outageProbeTargets(v).length, 1);
});

test('a red that took minutes is not probed', () => {
  const v = classifyRuns({ ok: true, runs: [run('CI', 'failure', { id: 5, ms: 480_000 })] });
  assert.deepEqual(outageProbeTargets(v), []);
});

test('one failing run with REAL steps keeps the whole SHA red, even beside a zero-step one', () => {
  // Otherwise a live outage would hide a genuine test failure behind "not your fault".
  const v = classifyRuns({
    ok: true,
    runs: [
      run('merge-preflight', 'failure', { id: 5, ms: 4_000 }),
      run('CI', 'failure', { id: 6, ms: 9_000 }),
    ],
  });
  const out = applyOutageEvidence(v, new Map([[5, true], [6, false]]));
  assert.equal(out.state, 'red');
});

test('an unreadable probe leaves the SHA red rather than excusing it as an outage', () => {
  const v = classifyRuns({ ok: true, runs: [run('CI', 'failure', { id: 5, ms: 4_000 })] });
  assert.equal(applyOutageEvidence(v, new Map()).state, 'red');
});

test('outage evidence never promotes a non-red verdict', () => {
  for (const s of ['green', 'none', 'pending', 'unknown']) {
    const v = { state: /** @type {any} */ (s), runs: [], failing: [], detail: '' };
    assert.equal(applyOutageEvidence(v, new Map([[1, true]])).state, s);
  }
});

// ---------------------------------------------------------------- orchestration

test('resolvePrCi reads each PR at its own head SHA and never calls gh pr view', async () => {
  /** @type {string[]} */
  const asked = [];
  const rows = await resolvePrCi(
    [
      { number: 133, headRefOid: 'aaaaaaaa1111' },
      { number: 130, headRefOid: 'bbbbbbbb2222' },
      { number: 128, headRefOid: 'cccccccc3333' },
    ],
    {
      concurrency: 3,
      runList: async (sha) => {
        asked.push(sha);
        if (sha === 'aaaaaaaa1111') return { ok: true, runs: [run('CI', 'success')] };
        if (sha === 'bbbbbbbb2222') return { ok: true, runs: [run('merge-preflight', 'failure', { id: 5, ms: 3_000 })] };
        return { ok: true, runs: [] };
      },
      runJobs: async () => ({ ok: true, jobs: [{ steps: [] }] }),
    }
  );
  assert.deepEqual(asked.sort(), ['aaaaaaaa1111', 'bbbbbbbb2222', 'cccccccc3333']);
  assert.deepEqual(
    rows.map((r) => [r.number, r.ci.state, r.headSha]),
    [
      [133, 'green', 'aaaaaaaa1111'],
      [130, 'outage', 'bbbbbbbb2222'],
      [128, 'none', 'cccccccc3333'],
    ]
  );
});

test('a PR with no head SHA is unknown, and costs no gh call', async () => {
  const rows = await resolvePrCi([{ number: 1 }], {
    runList: async () => {
      throw new Error('must not be called');
    },
    runJobs: async () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(rows[0].ci.state, 'unknown');
});

test('a gh failure surfaces as unknown for that PR alone', async () => {
  const rows = await resolvePrCi(
    [
      { number: 1, headRefOid: 'aaa' },
      { number: 2, headRefOid: 'bbb' },
    ],
    {
      runList: async (sha) => (sha === 'aaa' ? { ok: false } : { ok: true, runs: [run('CI', 'success')] }),
      runJobs: async () => ({ ok: false }),
    }
  );
  assert.deepEqual(rows.map((r) => r.ci.state), ['unknown', 'green']);
});

test('the cache is consulted per head SHA and skips the lookup entirely', async () => {
  let calls = 0;
  const rows = await resolvePrCi([{ number: 1, headRefOid: 'sha-a' }], {
    cacheGet: (sha) => (sha === 'sha-a' ? { state: 'green', runs: [], failing: [], detail: 'cached' } : null),
    runList: async () => {
      calls++;
      return { ok: true, runs: [] };
    },
    runJobs: async () => ({ ok: false }),
  });
  assert.equal(calls, 0);
  assert.equal(rows[0].ci.state, 'green');
});

test('a fresh verdict is written back under its head SHA, so the next push is a different key', async () => {
  /** @type {string[]} */
  const written = [];
  await resolvePrCi([{ number: 1, headRefOid: 'sha-b' }], {
    cachePut: (sha) => written.push(sha),
    runList: async () => ({ ok: true, runs: [run('CI', 'success')] }),
    runJobs: async () => ({ ok: false }),
  });
  assert.deepEqual(written, ['sha-b']);
});

test('in-flight verdicts expire faster than settled ones', () => {
  assert.ok(cacheTtlMs('pending') < cacheTtlMs('green'));
  assert.ok(cacheTtlMs('none') < cacheTtlMs('red'));
  assert.ok(cacheTtlMs('unknown') < cacheTtlMs('outage'));
});

test('resolvePrCi honours its concurrency limit', async () => {
  let live = 0;
  let peak = 0;
  const prs = Array.from({ length: 12 }, (_, n) => ({ number: n, headRefOid: `sha${n}` }));
  await resolvePrCi(prs, {
    concurrency: 4,
    runList: async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { ok: true, runs: [] };
    },
    runJobs: async () => ({ ok: false }),
  });
  assert.ok(peak > 1, 'the lookups must actually overlap -- 18 sequential gh calls is ~13s');
  assert.ok(peak <= 4);
});

// ---------------------------------------------------------------- rendering

test('every state has a label, and only green reads as a pass', () => {
  for (const s of ['green', 'red', 'outage', 'pending', 'none', 'unknown']) {
    const { label, tone } = describeCiState(/** @type {any} */ (s));
    assert.ok(label.trim().length, `${s} must render a word, never a dash or a blank`);
    assert.equal(tone === 'go', s === 'green', `only green may render as a pass (${s})`);
  }
});

test('the head is shown as a 7-char git prefix, not an elided address', () => {
  assert.equal(shortSha('14073402efa5eb7056190a70db2ec571ea1e8239'), '1407340');
  assert.doesNotMatch(shortSha('14073402efa5eb7056190a70db2ec571ea1e8239'), /…/);
  assert.equal(shortSha(''), '???????');
});

test('ranking puts the rows that need a decision first', () => {
  assert.ok(ciRank('red') < ciRank('pending'));
  assert.ok(ciRank('outage') < ciRank('green'));
  assert.ok(ciRank('none') < ciRank('green'), 'an unverified head outranks a verified one');
  assert.equal(ciRank(/** @type {any} */ ('nonsense')), 6);
});
