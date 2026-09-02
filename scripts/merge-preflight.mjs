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
 * comments, so nothing connected a verdict to mergeability. The three failure modes and the rules
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

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.pr) {
    process.stderr.write('usage: node scripts/merge-preflight.mjs <pr-number> [--advisory] [--json] [--repo owner/name]\n');
    return 2;
  }

  const pr = gh([
    'pr', 'view', opts.pr, '--repo', opts.repo,
    '--json', 'number,state,isDraft,headRefName,headRefOid,comments,commits',
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
