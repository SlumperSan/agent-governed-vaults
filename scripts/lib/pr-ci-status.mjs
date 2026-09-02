// @ts-check
/**
 * "Is THIS head verified?" — per-PR CI state, matched to the exact head SHA.
 *
 * WHY THIS EXISTS. The standing rule in docs/RELEASE-CHECKLIST.md §2.3 is `green-belongs-to-a-
 * commit`: CI green must be matched by `headSha`, never read off `gh pr checks`, which reports runs
 * attached to a PR without saying which commit they ran on (it returned green for #107 from a
 * previous head — that is why the rule exists). The same section forbids the workaround people
 * reach for instead: a hand-written list of which branches are green. Such a list is stale the
 * moment anyone pushes, and during an Actions outage — exactly when people reach for one — it is
 * stale and load-bearing at the same time. On 2026-09-02 one was published to six concurrent
 * sessions and was wrong within the hour.
 *
 * So the board answers the question per head, on every run, instead of anybody remembering it.
 *
 * THE FIVE STATES ARE NOT COLLAPSIBLE. Collapsing them is the bug this module exists to fix:
 *
 *   green    a run at this SHA, completed, success            → verified
 *   red      completed, not success, and it really executed   → a defect in the candidate
 *   pending  a run exists at this SHA but is not completed    → not yet evidence
 *   none     NO run exists for this SHA                       → UNVERIFIED, not a pass
 *   unknown  we could not ask GitHub (gh failed / offline)    → UNVERIFIED, not a pass
 *   outage   completed red, but zero-step: it never executed  → not about the candidate
 *
 * `none` and `unknown` must never render as anything resembling a pass. A head with no run is not
 * a green head; it is a head nobody has checked. `outage` must never render as `red`: this repo
 * lost ~72h to exhausted Actions minutes on 2026-08-29 and again from ~04:56Z on 2026-09-02, and
 * during such a window gate 8 cannot be earned by any candidate, so the red is not a verdict on
 * the code.
 *
 * Everything above the fetch layer is pure and takes plain objects, so scripts/test/pr-ci-status.
 * test.mjs exercises every state with `gh` stubbed rather than whatever the org's runners happen to
 * be doing this minute.
 *
 * @typedef {object} Run
 * @property {string} [workflowName]
 * @property {string} [status]        'completed' | 'in_progress' | 'queued' | ...
 * @property {string} [conclusion]    'success' | 'failure' | 'skipped' | ... ('' while running)
 * @property {number} [databaseId]
 * @property {string} [event]
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 *
 * @typedef {'green'|'red'|'pending'|'none'|'unknown'|'outage'} CiState
 *
 * @typedef {object} CiVerdict
 * @property {CiState} state
 * @property {Run[]} runs      the deduped, newest-per-workflow runs the verdict was read from
 * @property {Run[]} failing   the completed non-success runs among them
 * @property {string} detail   short human phrase, e.g. '3 workflow(s)' or 'CI, merge-preflight'
 */

/** Conclusions that are neither a pass nor a failure — they carry no evidence either way. */
const NON_BLOCKING = new Set(['skipped', 'neutral']);

/**
 * A completed red this fast did not run anything. Only a PREFILTER for spending one extra
 * `gh run view`; `steps.length === 0` is the authoritative test. Deliberately generous: the
 * 2026-09-02 outage produced 3s, 5s AND 10s reds, and the asymmetry is one-sided — a loose
 * prefilter costs one extra API call, a tight one reports a capacity outage as a code defect,
 * which is precisely the mistake this module exists to prevent.
 */
export const OUTAGE_PROBE_MAX_MS = 30_000;

/** @param {Run} r */
function runMs(r) {
  const a = Date.parse(r.createdAt ?? '');
  const b = Date.parse(r.updatedAt ?? '');
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : Infinity;
}

/** @param {Run} r */
function runOrder(r) {
  const t = Date.parse(r.createdAt ?? '');
  return [Number.isFinite(t) ? t : 0, r.databaseId ?? 0];
}

/**
 * Keep only the newest run per `workflowName|event`.
 *
 * A SHA can carry SEVERAL runs of the same workflow — a re-run, or a workflow that fires on both
 * `push` and `pull_request`. `bab5ee90` carried four `merge-preflight` runs. Without this, a head
 * that was re-run green would render `red` forever off the superseded attempt, which is the same
 * class of lie as reading `gh pr checks`. Sorted explicitly rather than trusting API order.
 *
 * @param {Run[]} runs
 * @returns {Run[]}
 */
export function latestRunPerWorkflow(runs) {
  /** @type {Map<string, Run>} */
  const best = new Map();
  for (const r of runs ?? []) {
    const key = `${r.workflowName ?? '?'}|${r.event ?? '?'}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, r);
      continue;
    }
    const [at, ai] = runOrder(r);
    const [bt, bi] = runOrder(prev);
    if (at > bt || (at === bt && ai > bi)) best.set(key, r);
  }
  return [...best.values()];
}

/**
 * Read a verdict from the runs at one SHA.
 *
 * `ok` is separate from an empty list on purpose. `gh` returns nothing on rate-limit, timeout,
 * auth failure and offline alike, and "GitHub is unreachable" is a different action from "this
 * head was never pushed to CI" even though neither is green. Collapsing them would repeat, one
 * level down, exactly the mistake this module exists to fix.
 *
 * Precedence, once superseded runs are dropped: a definite failure outranks a run still deciding,
 * because a head with one red workflow is not going to become verified by the others finishing.
 * All-non-blocking (every run `skipped`) yields `none` — a skip is the absence of evidence, and
 * must never be counted toward green.
 *
 * @param {{ ok: boolean, runs?: Run[] }} fetched
 * @returns {CiVerdict}
 */
export function classifyRuns(fetched) {
  if (!fetched || fetched.ok !== true) {
    return { state: 'unknown', runs: [], failing: [], detail: 'could not reach GitHub' };
  }
  const runs = latestRunPerWorkflow(fetched.runs ?? []);
  if (!runs.length) return { state: 'none', runs, failing: [], detail: 'no run at this SHA' };

  const completed = runs.filter((r) => r.status === 'completed');
  const failing = completed.filter(
    (r) => r.conclusion !== 'success' && !NON_BLOCKING.has(r.conclusion ?? '')
  );
  const passing = completed.filter((r) => r.conclusion === 'success');
  const names = (rs) => rs.map((r) => r.workflowName ?? '?').join(', ');

  if (failing.length) return { state: 'red', runs, failing, detail: names(failing) };
  if (completed.length < runs.length) {
    const running = runs.filter((r) => r.status !== 'completed');
    return { state: 'pending', runs, failing: [], detail: names(running) };
  }
  if (passing.length) {
    return { state: 'green', runs, failing: [], detail: `${passing.length} workflow(s)` };
  }
  // Everything completed, nothing failed, nothing passed: all skipped/neutral. No evidence.
  return { state: 'none', runs, failing: [], detail: 'all runs skipped' };
}

/**
 * Which failing runs are worth one `gh run view` to check for the capacity signature.
 * @param {CiVerdict} verdict
 * @returns {Run[]}
 */
export function outageProbeTargets(verdict) {
  if (verdict.state !== 'red') return [];
  return verdict.failing.filter((r) => runMs(r) <= OUTAGE_PROBE_MAX_MS);
}

/**
 * The capacity signature: the job completed, but ran no steps and produced no logs.
 * An empty `jobs` array is NOT the signature — that is a run we could not read.
 * @param {{ steps?: unknown[] }[]} jobs
 */
export function isZeroStepJobSet(jobs) {
  return Array.isArray(jobs) && jobs.length > 0 && jobs.every((j) => (j?.steps ?? []).length === 0);
}

/**
 * Promote `red` to `outage` only when EVERY failing run at the SHA is zero-step.
 *
 * The composite matters: if one failing run has real steps, a real test failed, and a concurrent
 * outage must not be allowed to hide it behind a "not your fault" label.
 *
 * @param {CiVerdict} verdict
 * @param {Map<number, boolean>} zeroStepById  run id -> zero-step; absent = not probed / unreadable
 * @returns {CiVerdict}
 */
export function applyOutageEvidence(verdict, zeroStepById) {
  if (verdict.state !== 'red' || !verdict.failing.length) return verdict;
  const all = verdict.failing.every((r) => zeroStepById.get(r.databaseId ?? -1) === true);
  if (!all) return verdict;
  return { ...verdict, state: 'outage', detail: `${verdict.detail} — 0 steps, never ran` };
}

/** Every state, worst first. The board's row order, so terminal and dashboard cannot disagree. */
export const CI_STATES = /** @type {CiState[]} */ (['red', 'outage', 'unknown', 'none', 'pending', 'green']);

/** @param {CiState} state */
export function ciRank(state) {
  const i = CI_STATES.indexOf(state);
  return i < 0 ? CI_STATES.length : i;
}

/**
 * Rendering vocabulary, shared by the terminal board, `--md` and the web dashboard so the three
 * cannot drift. `tone` reuses the board's existing gate classes (go / warn / nogo / idle).
 *
 * `none` and `unknown` say "unverified" in words. They are never a dash and never blank: on a
 * status board an em-dash reads as "nothing wrong", and a head nobody checked is not a head that
 * is fine.
 *
 * @param {CiState} state
 * @returns {{ label: string, tone: 'go'|'warn'|'nogo'|'idle' }}
 */
export function describeCiState(state) {
  switch (state) {
    case 'green':
      return { label: 'green', tone: 'go' };
    case 'red':
      return { label: 'RED', tone: 'nogo' };
    case 'outage':
      return { label: 'outage', tone: 'warn' };
    case 'pending':
      return { label: 'pending', tone: 'warn' };
    case 'none':
      return { label: 'none · unverified', tone: 'warn' };
    default:
      return { label: 'unknown · unverified', tone: 'idle' };
  }
}

/**
 * Short git-style SHA. Deliberately NOT the board's `short()` helper, which elides the middle
 * (`140734…8239`) — that shape reads as a contract address, and this is a commit.
 * @param {string} sha
 */
export function shortSha(sha) {
  return (sha ?? '').slice(0, 7) || '???????';
}

/** One line of the GITHUB block, without colour. @param {{number:number, headSha:string, ci:CiVerdict}} e */
export function formatPrCiLine(e) {
  const { label } = describeCiState(e.ci.state);
  return `#${e.number} ${shortSha(e.headSha)} ${label}${e.ci.detail ? ` (${e.ci.detail})` : ''}`;
}

// ---------------------------------------------------------------- fetch orchestration

/** Resolve `tasks` with at most `limit` in flight. @template T */
async function pool(tasks, limit) {
  /** @type {any[]} */
  const out = new Array(tasks.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (i < tasks.length) {
      const n = i++;
      out[n] = await tasks[n]();
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Resolve the CI verdict for every PR, concurrently.
 *
 * 1 + N `gh` calls, not 2N: `gh pr list` already returns `headRefOid`, so no per-PR `gh pr view`
 * is needed. The extra `gh run view` probes are spent only on fast reds, which are rare outside an
 * outage — and inside one there are only as many as there are PRs.
 *
 * @param {{ number: number, headRefOid?: string }[]} prs
 * @param {{
 *   runList: (sha: string) => Promise<{ ok: boolean, runs?: Run[] }>,
 *   runJobs: (id: number) => Promise<{ ok: boolean, jobs?: { steps?: unknown[] }[] }>,
 *   concurrency?: number,
 *   cacheGet?: (sha: string) => CiVerdict | null,
 *   cachePut?: (sha: string, v: CiVerdict) => void,
 * }} deps
 * @returns {Promise<{ number: number, headSha: string, ci: CiVerdict }[]>}
 */
export async function resolvePrCi(prs, deps) {
  const limit = deps.concurrency ?? 8;
  const tasks = (prs ?? []).map((pr) => async () => {
    const headSha = pr.headRefOid ?? '';
    if (!headSha) {
      return {
        number: pr.number,
        headSha: '',
        ci: /** @type {CiVerdict} */ ({ state: 'unknown', runs: [], failing: [], detail: 'no head SHA' }),
      };
    }
    const cached = deps.cacheGet?.(headSha);
    if (cached) return { number: pr.number, headSha, ci: cached };

    let verdict = classifyRuns(await deps.runList(headSha));
    const probes = outageProbeTargets(verdict);
    if (probes.length) {
      /** @type {Map<number, boolean>} */
      const zeroStep = new Map();
      const results = await pool(
        probes.map((r) => async () => [r.databaseId, await deps.runJobs(r.databaseId ?? -1)]),
        limit
      );
      for (const [id, res] of results) {
        if (res?.ok) zeroStep.set(id, isZeroStepJobSet(res.jobs ?? []));
      }
      verdict = applyOutageEvidence(verdict, zeroStep);
    }
    deps.cachePut?.(headSha, verdict);
    return { number: pr.number, headSha, ci: verdict };
  });
  return pool(tasks, limit);
}

/**
 * How long a verdict may be reused.
 *
 * The collector's design rule is "nothing is stored, so nothing can go stale on its own", and this
 * is the one exemption. It holds because the cache is keyed by HEAD SHA: the fact being cached is
 * a fact ABOUT that SHA, so the next push is a different key and the entry physically cannot
 * outlive its subject. That is the precise property the hand-written list lacked.
 *
 * Terminal verdicts get a longer life than in-flight ones, which change under you by design.
 *
 * @param {CiState} state
 */
export function cacheTtlMs(state) {
  return state === 'pending' || state === 'none' || state === 'unknown' ? 15_000 : 120_000;
}
