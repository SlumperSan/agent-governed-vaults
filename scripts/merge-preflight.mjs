#!/usr/bin/env node
// @ts-check
/**
 * Merge preflight: ask, before merging or before pushing, whether a PR is actually mergeable.
 *
 *     node scripts/merge-preflight.mjs 119                  # strict (the merge question)
 *     node scripts/merge-preflight.mjs 119 --advisory       # skip the roster rules
 *     node scripts/merge-preflight.mjs 119 --json
 *
 * Exit 0 = clear, 1 = blocked, 2 = could not determine (no `gh`, no auth, no such PR). **Exit 2 is
 * not a pass.** A preflight that cannot see is not a preflight that saw nothing wrong.
 *
 * WHY THIS EXISTS. On 2026-09-01 four PRs — #92, #98, #107 and #109 — merged across review verdicts
 * that were never addressed, putting two HIGHs on `protocol/main`. `gh pr merge` does not read
 * comments, so nothing connected a verdict to mergeability. The five failure modes and the rules
 * that answer them are documented in `scripts/lib/verdicts.mjs` and specified in
 * `scripts/lib/merge-policy.json`, which is the single source of truth this reads.
 *
 * WHAT THIS IS AND IS NOT. Run by hand or from the `merge-preflight` workflow, this is a
 * **convention**: nothing compels an agent to run it, and an agent that skips it merges exactly as
 * before. It becomes **enforcement** only when the repository owner requires the `merge-preflight`
 * status context in branch protection on `protocol/main`, with `enforce_admins` on. Until then, do
 * not describe it as a gate. See `docs/reviews/MERGE-POLICY.md` § "What this cannot catch".
 *
 * NO LOCAL STATE. It takes a PR number and reads only `gh`, so it behaves identically on a
 * developer's machine, in a detached review worktree, and on a CI runner. The rule evaluation
 * itself is pure and lives in `scripts/lib/verdicts.mjs`, tested against fixtures rebuilt from the
 * four real PRs in `scripts/test/merge-preflight.test.mjs` — no network in the test suite.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './lib/verdicts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = 'SlumperSan/agent-governed-vaults';

/** @param {string[]} args */
function parseArgs(args) {
  const out = {
    /** @type {string|null} */ pr: null,
    /** @type {'advisory'|'strict'} */ mode: /** @type {'strict'} */ ('strict'),
    repo: process.env.MERGE_PREFLIGHT_REPO || DEFAULT_REPO,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--advisory') out.mode = /** @type {'advisory'} */ ('advisory');
    else if (a === '--strict') out.mode = /** @type {'strict'} */ ('strict');
    else if (a === '--json') out.json = true;
    else if (a === '--repo') out.repo = args[++i];
    else if (/^\d+$/.test(a)) out.pr = a;
  }
  return out;
}

/**
 * @param {string[]} args
 * @returns {{ok: true, data: any} | {ok: false, err: string}}
 */
function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.error) return { ok: false, err: `could not run gh: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, err: (r.stderr || r.stdout || '').trim() };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, err: `gh returned unparseable JSON: ${String(e)}` };
  }
}

/** @param {string} label */
function rule(label) {
  const policy = JSON.parse(readFileSync(path.join(HERE, 'lib', 'merge-policy.json'), 'utf8'));
  return policy.rules.find((/** @type {any} */ r) => r.id === label);
}

/**
 * THE FIELD CONTRACT BETWEEN `gh` AND THE EVALUATOR.
 *
 * Everything below this comment exists because of one asymmetry: `verdicts.mjs` is a PURE evaluator
 * whose fixtures may legitimately omit an optional field, while THIS file is the only place where
 * "the field came from `gh`" is knowable. In the evaluator an absent value is an honest limit; here
 * it is contract drift, and the two must be answered differently.
 *
 * The drift that motivated this. #137 stopped the gate counting its own runs as CI evidence, with
 * `runsForHead` filtering on `r.name !== SELF_WORKFLOW_NAME`. Nothing pinned where `r.name` comes
 * from. Drop `workflowName` from the run request below and every `r.name` is `undefined`,
 * `undefined !== 'merge-preflight'` is always true, the filter degrades to a no-op, and a head with
 * NO CI AT ALL clears `ci-matches-head` again. Reproduced end to end on 2026-09-10 against a `gh`
 * that honours the `--json` field list: the script printed CLEAR and exited 0 on a head carrying
 * one preflight run and zero CI runs, while `scripts/test/merge-preflight.test.mjs` stayed 30/30
 * green, because the suite imports `verdicts.mjs` and never executes this file.
 *
 * It is not one field. Twelve rule-bearing values reach `evaluate()` from `gh`. SEVEN fail CLOSED
 * when absent — `state`, `headRefOid`, `headRefName`, `baseRefName`, `headSha`, `status` and
 * `conclusion` each push a blocker, make the head match nothing, or make the `gh` call itself fail.
 * FIVE fail OPEN: `workflowName` disarms the self-exclusion; `commits` silently retires Mode D;
 * `comments` retires Modes A, D and E, which in the `--advisory` mode the workflow actually runs
 * leaves nothing but `pr-open` and `ci-matches-head` standing; `isDraft` lets a draft through; and
 * `.behind_by` retires Mode E, because `--jq` on a key that is not there prints `null` while `gh`
 * still exits 0. So the check is on the SET, not on the field that was noticed.
 *
 * `number` is the thirteenth field and the only cosmetic one: it is required below because the
 * printed header names the PR, and no rule reads it.
 *
 * DECLARED HERE, NOT DERIVED FROM THE `--json` STRINGS. A required set read back out of the request
 * is self-referential: drop a field from the request and it drops out of the requirement too, so
 * the check would pass exactly when it is needed. These constants and the literal `--json` strings
 * are two independent statements of one list, pinned equal by a test in
 * `scripts/test/merge-preflight.test.mjs` — which also names `workflowName` and `commits`
 * literally, so deleting a field from BOTH statements is still red.
 */
export const PR_FIELDS = ['number', 'state', 'isDraft', 'headRefName', 'headRefOid', 'baseRefName', 'comments', 'commits'];

/** Likewise for `gh run list`. `workflowName` is what `runsForHead` excludes this gate's own runs by. */
export const RUN_FIELDS = ['headSha', 'status', 'conclusion', 'workflowName'];

/**
 * Which of `fields` the object does not carry.
 *
 * PRESENCE, never truthiness: `conclusion` comes back as `""` on an in-progress run and `isDraft`
 * is `false` on most PRs. Both are answers. Only a missing KEY means the field never came back —
 * verified against the live API on 2026-09-10, where `gh run list --json headSha,status,conclusion,
 * workflowName` returned `{"conclusion":"","headSha":"479f0020…","status":"in_progress",
 * "workflowName":"CI"}`.
 *
 * @param {any} obj
 * @param {string[]} fields
 * @returns {string[]}
 */
export function missingFields(obj, fields) {
  if (obj === null || typeof obj !== 'object') return [...fields];
  return fields.filter((f) => !Object.hasOwn(obj, f));
}

/**
 * The payload `evaluate()` is about to judge, checked against the contract above.
 *
 * Returns the reason it cannot be trusted, or `null`. The caller turns a reason into exit 2 —
 * "could not determine", which this file's header records is NOT a pass and which
 * `.github/workflows/merge-preflight.yml` publishes as a `error` commit status. Blocking on a
 * payload we cannot read is the safe direction to be wrong in; judging one is not.
 *
 * @param {any} prData    what `gh pr view --json …` returned
 * @param {any} runsData  what `gh run list --json …` returned
 * @param {any} behindBy  what `gh api …/compare/… --jq .behind_by` returned
 * @returns {string|null}
 */
export function validateGhPayloads(prData, runsData, behindBy) {
  const prMissing = missingFields(prData, PR_FIELDS);
  if (prMissing.length > 0) return `'gh pr view' returned no ${prMissing.join(', ')}`;

  // Nested, so no `--json` field name can ask for it directly: `commits[].committedDate` is Mode D's
  // whole input. Every PR has at least one commit and every commit object carries `committedDate`
  // (checked against the API on 2026-09-10), so an absent one is drift, not a PR without commits —
  // and drift here retires `verdict-covers-head` without a word.
  const headCommit = (Array.isArray(prData.commits) ? prData.commits : []).at(-1);
  if (!headCommit || !Object.hasOwn(headCommit, 'committedDate')) {
    return "'gh pr view' returned no commits[].committedDate, which is the only input to verdict-covers-head";
  }

  // Not "the array is non-empty": a branch with no runs at all is a legitimate state, and
  // `ci-matches-head` already blocks on it correctly. The check is that every run PRESENT is whole.
  if (!Array.isArray(runsData)) return "'gh run list' did not return an array";
  for (const [i, r] of runsData.entries()) {
    const m = missingFields(r, RUN_FIELDS);
    if (m.length > 0) return `'gh run list' run #${i} carries no ${m.join(', ')}`;
  }

  // `--jq` on a key that is not there emits `null` and `gh` still exits 0, so this is the one case
  // the JSON.parse failure path above cannot see. `behindBy` is not a number means Mode E is off.
  if (typeof behindBy !== 'number') {
    return `the compare API's .behind_by came back as ${JSON.stringify(behindBy)}, not a number`;
  }
  return null;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.pr) {
    process.stderr.write('usage: node scripts/merge-preflight.mjs <pr-number> [--advisory] [--json] [--repo owner/name]\n');
    return 2;
  }

  const pr = gh([
    'pr', 'view', opts.pr, '--repo', opts.repo,
    '--json', 'number,state,isDraft,headRefName,headRefOid,baseRefName,comments,commits',
  ]);
  if (!pr.ok) {
    process.stderr.write(`merge-preflight: cannot read PR #${opts.pr}: ${pr.err}\n`);
    return 2;
  }

  // The branch, not the PR, is what `gh run list` keys on — and keying on the branch is the whole
  // point: it is the only way to get `headSha` back and check it ourselves.
  const runs = gh([
    'run', 'list', '--repo', opts.repo, '--branch', pr.data.headRefName,
    '--limit', '30', '--json', 'headSha,status,conclusion,workflowName',
  ]);
  if (!runs.ok) {
    process.stderr.write(`merge-preflight: cannot list runs for ${pr.data.headRefName}: ${runs.err}\n`);
    return 2;
  }

  // Mode E: how far the branch's merge-base has fallen behind its base branch. `gh pr view` does
  // not report it -- mergeStateStatus only says BEHIND when the repo already requires up-to-date
  // branches, which is the setting we are trying to argue for -- so ask the compare API directly.
  // `--jq` so we get back the one integer rather than the full compare payload, which carries every
  // changed file and can run to megabytes on a branch this far along.
  const cmp = gh([
    'api', `repos/${opts.repo}/compare/${pr.data.baseRefName}...${pr.data.headRefName}`,
    '--jq', '.behind_by',
  ]);
  if (!cmp.ok) {
    const where = `${pr.data.baseRefName}...${pr.data.headRefName}`;
    process.stderr.write(`merge-preflight: cannot compare ${where}: ${cmp.err}\n`);
    return 2;
  }

  // Fail CLOSED on a payload that cannot answer the rules. See the field contract above: five of
  // the twelve rule-bearing values silently DISARM a rule when absent rather than blocking, so a
  // partial payload does not produce a wrong-looking answer — it produces a confident CLEAR.
  const broken = validateGhPayloads(pr.data, runs.data, cmp.data);
  if (broken) {
    process.stderr.write(
      `merge-preflight: ${broken}. Refusing to judge PR #${opts.pr} on a payload the rules cannot ` +
      `read: the evaluator would see undefined there and quietly stop checking, which reads as ` +
      `CLEAR. Exit 2 is 'could not determine', and could not determine is not a pass.\n`,
    );
    return 2;
  }

  const decision = evaluate({
    pr: {
      number: pr.data.number,
      state: pr.data.state,
      isDraft: pr.data.isDraft,
      headRefName: pr.data.headRefName,
      headRefOid: pr.data.headRefOid,
      // When the head commit landed. A merge/conflict-resolution commit gets a fresh committer
      // date, which is exactly the Mode D signal: content changed after a verdict was written.
      headCommittedDate: (pr.data.commits ?? []).at(-1)?.committedDate,
      baseRefName: pr.data.baseRefName,
      behindBy: cmp.data,
    },
    comments: (pr.data.comments ?? []).map((/** @type {any} */ c) => ({ createdAt: c.createdAt, body: c.body })),
    runs: (runs.data ?? []).map((/** @type {any} */ r) => ({
      headSha: r.headSha, status: r.status, conclusion: r.conclusion, name: r.workflowName,
    })),
    mode: opts.mode,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ pr: pr.data.number, headRefOid: pr.data.headRefOid, ...decision }, null, 2) + '\n');
    return decision.clear ? 0 : 1;
  }

  const head = String(pr.data.headRefOid).slice(0, 8);
  process.stdout.write(`\nmerge-preflight #${pr.data.number} (${opts.mode}) — ${pr.data.headRefName} @ ${head}\n`);
  process.stdout.write(`  roster:   ${decision.roster ? decision.roster.join(', ') : '(none declared)'}\n`);
  const vs = Object.entries(decision.latestVerdicts);
  process.stdout.write(`  verdicts: ${vs.length ? vs.map(([r, v]) => `${r}=${v.verdict}`).join(', ') : '(no tokens)'}\n\n`);

  if (decision.clear) {
    process.stdout.write('  CLEAR — no blocker found.\n');
  } else {
    process.stdout.write(`  BLOCKED — ${decision.blockers.length} blocker(s):\n`);
    for (const b of decision.blockers) {
      process.stdout.write(`\n  [${b.ruleId}] ${b.detail}\n`);
      const r = rule(b.ruleId);
      if (r) process.stdout.write(`      why: ${r.why}\n`);
    }
  }
  for (const n of decision.notes) process.stdout.write(`\n  note: ${n}\n`);
  process.stdout.write(
    decision.clear
      ? '\n  This is a preflight, not a gate: it is advisory until branch protection requires it.\n\n'
      : '\n',
  );
  return decision.clear ? 0 : 1;
}

// Only run when invoked directly, so the test suite can import this module without executing it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
