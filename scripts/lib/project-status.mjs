// @ts-check
/**
 * The single collector behind both `npm run cc` (terminal) and `npm run cc:web` (dashboard).
 *
 * DESIGN RULE, inherited from scripts/status.mjs: report FACTS WE COMPUTE and POINT AT the prose we
 * cannot. Everything here is derived from git, the last gate run, the deployment address book, the
 * go/no-go table and the GitHub API. Nothing is stored, so nothing can go stale on its own -- if a
 * value is wrong, its SOURCE is wrong, which is the bug you actually want to find.
 *
 * One collector, two renderers. A dashboard that drifts from the terminal board is worse than
 * having only one of them, because you then have to remember which is lying.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Run a command for stdout. Empty string on any failure -- this never throws and never hangs. */
function sh(cmd, args, timeout = 10_000) {
  // shell:false deliberately: git and gh are real executables Node resolves from PATH itself, and
  // cmd.exe would reinterpret arguments (see the shell policy in scripts/gate.mjs).
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

const jsonOr = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------- tree

function tree() {
  return {
    branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || '?',
    head: sh('git', ['rev-parse', '--short', 'HEAD']) || '?',
    headFull: sh('git', ['rev-parse', 'HEAD']),
    subject: sh('git', ['log', '-1', '--format=%s']),
    // Named, never merely counted: this is a SHARED worktree, so an unexpected path is probably
    // another session's work and must never be swept into a commit.
    // NOT `l.slice(3)`: sh() trims the whole stdout, which eats the leading space of a
    // " M path" line, so a fixed offset silently truncated the FIRST filename by one character.
    // Strip the status field by pattern instead, which is correct however the line arrives.
    dirty: sh('git', ['status', '--porcelain'])
      .split('\n')
      .filter(Boolean)
      .map((l) => l.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim())
      .filter(Boolean),
  };
}

// ---------------------------------------------------------------- gate

function gate() {
  const p = path.join(REPO, '.gate-state.json');
  if (!existsSync(p)) return null;
  const g = jsonOr(readFileSync(p, 'utf8'), null);
  if (!g) return null;
  const headFull = sh('git', ['rev-parse', 'HEAD']);
  // The two ways a green gate lies. A board that omits these is the failure mode it exists to stop.
  g.sameCommit = Boolean(g.commit && headFull && g.commit === headFull);
  g.caveats = [
    !g.sameCommit && 'ran on a DIFFERENT commit',
    g.treeDirty && 'ran against a dirty tree',
    g.mode?.quick && 'was --quick (no gas snapshot)',
    g.mode?.only && `was --only ${g.mode.only.join(',')}`,
  ].filter(Boolean);
  return g;
}

// ---------------------------------------------------------------- launch gates

function launchGates() {
  const p = path.join(REPO, 'docs/LAUNCH-READINESS.md');
  if (!existsSync(p)) return { verdict: null, rows: [] };
  const text = readFileSync(p, 'utf8');
  const verdict = /\*\*VERDICT:\s*([A-Z-]+)/.exec(text)?.[1] ?? null;
  const clean = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*(\d+)\s*\|([^|]+)\|([^|]+)\|/.exec(line);
    if (m) rows.push({ n: Number(m[1]), name: clean(m[2]), status: clean(m[3]) });
  }
  // The document holds SEVERAL numbered tables (the gates 0..8, the residual register 1..11). Take
  // the first contiguous run from 0 and STOP at the break -- accepting any row whose number happens
  // to match the next index let residual rows masquerade as launch gates.
  const gateRows = [];
  for (const r of rows) {
    if (r.n === gateRows.length) gateRows.push(r);
    else if (gateRows.length) break;
  }
  return { verdict, rows: gateRows };
}

export function gateClass(status) {
  const u = (status || '').toUpperCase();
  if (u.startsWith('GO')) return 'go';
  if (u.includes('NO-GO')) return 'nogo';
  if (u.includes('STALE') || u.includes('CONDITIONAL')) return 'warn';
  return 'idle';
}

// ---------------------------------------------------------------- deployments

function deployments() {
  const out = [];
  // Address books live in two places across generations -- read both rather than assuming one.
  for (const dir of [path.join(REPO, 'contracts/config/deployments'), path.join(REPO, 'contracts/config')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const j = jsonOr(readFileSync(path.join(dir, f), 'utf8'), null);
      if (!j) continue;
      const flat = {};
      const walk = (o) => {
        for (const [k, v] of Object.entries(o ?? {})) {
          if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) flat[k] = v;
          else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v);
        }
      };
      walk(j);
      const network = f.replace(/\.json$/, '');
      if (Object.keys(flat).length && !out.some((d) => d.network === network)) {
        out.push({ network, addresses: flat });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- sprints

/**
 * The sprint board, derived rather than maintained.
 *
 * A hand-kept list of sprints would go stale the moment one finished, so instead: every remote
 * branch NOT yet merged into protocol/main is work in flight. Cross-referencing open PRs tells us
 * whether it is still being written or waiting on review. No registry, nothing to update, and it
 * cannot disagree with the repository.
 */
function sprints(prs) {
  const unmerged = sh('git', ['branch', '-r', '--no-merged', 'origin/protocol/main'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.includes('->') && s !== 'origin/protocol/main')
    .map((s) => s.replace(/^origin\//, ''));

  const ages = {};
  for (const line of sh('git', ['for-each-ref', '--format=%(refname:short)|%(committerdate:iso8601)|%(committerdate:relative)', 'refs/remotes/origin']).split('\n')) {
    const [ref, iso, rel] = line.split('|');
    if (ref) ages[ref.replace(/^origin\//, '')] = { iso, rel };
  }

  const byBranch = new Map(prs.map((p) => [p.headRefName, p]));

  return unmerged
    .map((b) => {
      const pr = byBranch.get(b);
      return {
        branch: b,
        team: teamOf(b),
        pr: pr ? pr.number : null,
        prTitle: pr ? pr.title : null,
        // A conflicting PR is the state most likely to stall silently, so surface it as its own
        // status rather than folding it into "open".
        state: pr ? (pr.mergeable === 'CONFLICTING' ? 'conflict' : 'review') : 'building',
        age: ages[b]?.rel ?? '',
        iso: ages[b]?.iso ?? '',
      };
    })
    // Newest first: an old unmerged branch is usually abandoned, not urgent.
    .sort((a, b) => (b.iso || '').localeCompare(a.iso || ''));
}

/** Map a branch prefix to the department that owns it. Cosmetic grouping, not a source of truth. */
function teamOf(branch) {
  if (branch.startsWith('design/')) return 'Design';
  if (branch.startsWith('ops/')) return 'Ops';
  if (branch.startsWith('docs/')) return 'Docs';
  if (branch.startsWith('security/')) return 'Security';
  if (/^(fix|feat|perf|test|chore)\//.test(branch)) return 'Dev';
  return 'Other';
}

// ---------------------------------------------------------------- departments (the vault)

/**
 * Department output, read from the Obsidian vault. This is the only part of the board that looks
 * OUTSIDE the repo, because department deliverables are notes, not code.
 */
function departments(vaultRoot) {
  const base = path.join(vaultRoot, 'Business');
  if (!existsSync(base)) return [];
  const out = [];
  for (const entry of readdirSync(base)) {
    const full = path.join(base, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let notes = [];
    try {
      notes = readdirSync(full)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const s = statSync(path.join(full, f));
          return { name: f.replace(/\.md$/, ''), mtime: s.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      /* unreadable dir is not fatal to the board */
    }
    if (notes.length) out.push({ name: entry, notes, updated: notes[0].mtime });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

// ---------------------------------------------------------------- per-head CI

/**
 * Per-head verification state for every open PR, in ONE API call.
 *
 * WHY THIS EXISTS. Six sessions in one night each re-derived by hand whether a given PR head had
 * verified CI, and the answer was published wrong twice. A per-head fact that several sessions need
 * belongs in the shared status tool, not in each session's head -- publish the QUERY, not the answer.
 *
 * FOUR TRAPS THIS CODE IS SHAPED AROUND. Each is a mistake that was actually made here, so the
 * structure that prevents it is load-bearing, not decorative:
 *
 * 1. MATCH BY COMMIT, NEVER BY PR ASSOCIATION. `gh pr checks` lists runs attached to a PR without
 *    saying which commit they ran on -- one branch showed three greens on three different heads and
 *    a PR was nearly merged on a green belonging to a previous commit. This query reads
 *    `commits(last:1) { commit { checkSuites, status } }`, so every value below is scoped to a
 *    commit BY CONSTRUCTION rather than by our remembering to filter. We still verify
 *    `commit.oid === headRefOid` per PR and refuse to report the row if it ever disagrees.
 *
 * 2. A RUN'S CONCLUSION IS NOT THE STATUS IT POSTS. `merge-preflight` reports
 *    `conclusion: success` while the commit status it posted reads `failure` -- it succeeded at
 *    posting a red. Four sessions in one night conflated the two. So this reports two DIFFERENT
 *    artifacts from two different places and never merges them into one verdict:
 *      ci        <- the CI workflow RUN's own conclusion  (checkSuites)
 *      preflight <- the POSTED COMMIT STATUS              (commit.status.contexts)
 *    The renderer labels them `CI run=` and `preflight status=` for the same reason.
 *
 * 3. ABSENT EVIDENCE IS NOT A PASS AND NOT A FAILURE. A head with no run reports `none`, never
 *    `fail` and never a blank. `none` is the case the whole "green belongs to a commit" rule exists
 *    for, so it gets a name of its own.
 *
 * 4. AN INFRASTRUCTURE STOP LOOKS EXACTLY LIKE A CODE FAILURE. A run with no runner assigned
 *    concludes `failure` in 2-3 seconds having executed zero steps. This repo has lost ~72h to that
 *    twice and misdiagnosed it as its own code both times. The suite timestamps are already in this
 *    response, so a suspiciously fast failure is flagged `fail(no-runner?)` for free. The QUESTION
 *    MARK is the honest part: confirming it costs `gh run view <id> --json jobs` per run (~1.6s
 *    each), so confirmation is opt-in via `--ci-jobs`.
 *
 *    AND `--ci-jobs` NAMES THE CAUSE, because "no runner" is a symptom with at least two causes that
 *    demand OPPOSITE responses: capacity exhaustion clears itself, so you wait; a billing or
 *    spending-limit stop never clears, so you escalate to the account owner. They are
 *    indistinguishable in every field above -- the only artifact that separates them is the job's
 *    annotations, quoted verbatim. Verified 2026-09-02: what four sessions (and this file's own
 *    first draft) called "Actions capacity" was actually *"recent account payments have failed or
 *    your spending limit needs to be increased"*. Paraphrasing is exactly how that happened.
 *
 * COST. One GraphQL call covers every open PR: ~0.9s against a ~1.9s baseline, versus 2+ REST calls
 * per PR (36+ calls, ~20s) for the same answer. It is on by default because a fact behind a flag is
 * still a fact each session has to know to ask for, which is half the failure this exists to fix.
 * `--no-ci` skips it; `--no-gh` already skipped everything.
 */

/** GraphQL display name of the workflow whose RUN conclusion answers "did CI pass at this head". */
const CI_WORKFLOW = 'CI';
/** Commit-status context that the merge gate POSTS. Deliberately not a workflow name -- see trap 2. */
const PREFLIGHT_CONTEXT = 'merge-preflight';
/** A completed run this fast never reached a runner. Generous: real jobs here take 400-500s. */
const NO_RUNNER_SECONDS = 15;

const PER_HEAD_QUERY = `
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN, first:50, orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        number
        headRefName
        headRefOid
        baseRefName
        commits(last:1){nodes{commit{
          oid
          status{contexts{context state description}}
          checkSuites(first:30){nodes{
            status conclusion createdAt updatedAt
            workflowRun{databaseId url workflow{name}}
          }}
        }}}
      }
    }
  }
}`;

/** owner/name of `origin`, from the remote URL. No API call, and no assumption about the repo. */
function originRepo() {
  const url = sh('git', ['remote', 'get-url', 'origin']);
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return m ? { owner: m[1], name: m[2] } : null;
}

const secondsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 1000);

/**
 * Classify the CI workflow RUN for one head. Returns a label from a CLOSED set, so a reader never
 * has to interpret a raw API enum: none | pending | pass | fail | fail(no-runner?) | fail(<reason>).
 */
export function classifyCi(suites) {
  // Filter by workflow NAME, then take the LATEST by createdAt -- never nodes[0]. A re-run leaves
  // two CI suites on one head (the old red and the new green); reading array order would report the
  // stale red, which is `green-belongs-to-a-commit` committed inside the tool built to prevent it.
  const mine = suites
    .filter((s) => s.workflowRun?.workflow?.name === CI_WORKFLOW)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  if (!mine.length) {
    // Trap 3, one level in: "no run for this head" and "no run NAMED CI" are different bugs. If the
    // workflow is ever renamed, every head would silently read `none` -- so name what we did see.
    const others = [...new Set(suites.map((s) => s.workflowRun?.workflow?.name).filter(Boolean))];
    return { label: 'none', note: others.length ? `no suite named ${CI_WORKFLOW}; saw ${others.join(', ')}` : '', runId: null, url: null, seconds: null, suites: 0 };
  }

  const s = mine[mine.length - 1];
  const base = { runId: s.workflowRun?.databaseId ?? null, url: s.workflowRun?.url ?? null, suites: mine.length, note: mine.length > 1 ? `${mine.length} CI suites on this head, showing latest` : '' };
  // A queued or running suite has conclusion === null. Not a pass, not a failure, not `null`.
  if (s.status !== 'COMPLETED') return { ...base, label: 'pending', seconds: null };

  const secs = secondsBetween(s.createdAt, s.updatedAt);
  const c = (s.conclusion || '').toLowerCase();
  if (c === 'success') return { ...base, label: 'pass', seconds: secs };
  if (c === 'failure') {
    return { ...base, label: secs <= NO_RUNNER_SECONDS ? 'fail(no-runner?)' : 'fail', seconds: secs };
  }
  // cancelled / timed_out / startup_failure / action_required / skipped / neutral -- name it rather
  // than folding it into pass or fail. Anything we do not recognise is not evidence of a green.
  return { ...base, label: `fail(${c || 'unknown'})`, seconds: secs };
}

/**
 * Classify the POSTED COMMIT STATUS for one head -- a different artifact from the run above.
 * `commit.status === null` means nothing was ever posted, which is not a pass and not a failure.
 */
export function classifyPreflight(status) {
  if (!status || !status.contexts?.length) return { label: 'none', note: '' };
  const ctx = status.contexts.find((c) => c.context === PREFLIGHT_CONTEXT);
  if (!ctx) {
    const seen = status.contexts.map((c) => c.context).join(', ');
    return { label: 'none', note: `no ${PREFLIGHT_CONTEXT} context; saw ${seen}` };
  }
  return { label: (ctx.state || 'unknown').toLowerCase(), note: ctx.description || '' };
}

/**
 * @param {{ jobs?: boolean }} [opts] jobs: confirm the no-runner heuristic with one extra API call
 *   per suspected run (~1.6s each). Opt-in; the default only ever says `fail(no-runner?)`.
 */
function perHeadCi(opts = {}) {
  const repo = originRepo();
  if (!repo) return { up: false, reason: 'no origin remote', rows: [] };

  const raw = sh('gh', ['api', 'graphql', '-f', `query=${PER_HEAD_QUERY}`, '-F', `owner=${repo.owner}`, '-F', `name=${repo.name}`], 25_000);
  const j = jsonOr(raw, null);
  const nodes = j?.data?.repository?.pullRequests?.nodes;
  // gh missing, unauthenticated, offline, rate-limited or a schema change all land here. The board
  // prints "unavailable" and everything else on it still renders -- same contract as `gh pr list`.
  if (!Array.isArray(nodes)) return { up: false, reason: 'gh graphql unavailable', rows: [] };

  // What `behind` is measured AGAINST -- each PR's OWN base, never a hardcoded branch, because a PR
  // targeting something else would otherwise be measured against the wrong ref and reported as
  // behind when it is not. It is a LOCAL ref either way, so the renderer names it AND its SHA:
  // `behind 0` otherwise reads as authoritative when it means "0 vs whatever I last fetched".
  const baseShaOf = (ref) => {
    if (!(ref in baseShaOf.cache)) baseShaOf.cache[ref] = sh('git', ['rev-parse', '--short', `origin/${ref}`]) || null;
    return baseShaOf.cache[ref];
  };
  baseShaOf.cache = {};

  const rows = nodes.map((p) => {
    const commit = p.commits?.nodes?.[0]?.commit ?? null;
    // The one structural guarantee that everything below belongs to THIS head. If it ever fails we
    // report nothing rather than another commit's evidence -- that is `gh pr checks`'s exact defect.
    const matches = Boolean(commit && commit.oid === p.headRefOid);
    if (!matches) {
      return { number: p.number, head: p.headRefOid, branch: p.headRefName, headMismatch: true, ci: { label: 'head?' }, preflight: { label: 'head?' }, behind: null };
    }
    // Local, so free -- and `?` when the object is not fetched, which is honest rather than 0.
    const behindRaw = baseShaOf(p.baseRefName) ? sh('git', ['rev-list', '--count', `${p.headRefOid}..origin/${p.baseRefName}`]) : '';
    return {
      number: p.number,
      head: p.headRefOid,
      branch: p.headRefName,
      base: p.baseRefName,
      headMismatch: false,
      ci: classifyCi(commit.checkSuites?.nodes ?? []),
      preflight: classifyPreflight(commit.status),
      behind: /^\d+$/.test(behindRaw) ? Number(behindRaw) : null,
    };
  });

  // Opt-in confirmation of trap 4. `steps=0` with no runner assigned across every job means no
  // runner was ever allocated; anything else is a real failure and must stop being excused as
  // infrastructure.
  //
  // AND THEN NAME THE CAUSE, because "no runner" is a symptom with at least two causes that behave
  // COMPLETELY differently: capacity exhaustion clears itself, whereas a billing/spending-limit stop
  // never does and only the account owner can lift it. A session told "capacity" waits; a session
  // told "billing" escalates. Verified 2026-09-02 -- what looked like a capacity outage was in fact
  // "recent account payments have failed or your spending limit needs to be increased", and the ONLY
  // artifact carrying that sentence is the job's annotations. One more call per probed run, on a
  // flag that is already opt-in and already spending one.
  let probed = 0;
  if (opts.jobs) {
    for (const r of rows) {
      if (r.ci?.label !== 'fail(no-runner?)' || !r.ci.runId) continue;
      probed += 1;
      const jr = jsonOr(sh('gh', ['run', 'view', String(r.ci.runId), '--json', 'jobs'], 20_000), null);
      const jobs = jr?.jobs;
      if (!Array.isArray(jobs) || !jobs.length) continue;
      const starved = jobs.every((x) => (x.steps?.length ?? 0) === 0 && !x.runnerName);
      if (!starved) {
        r.ci.label = 'fail';
        r.ci.note = `${jobs.length} job(s) ran steps — a real failure, not infrastructure`;
        continue;
      }
      r.ci.label = 'fail(no-runner)';
      // Every starved job, not `jobs[0]` -- that is the same `nodes[0]` shape excluded from
      // classifyCi above, and it would report ONE job's cause as the whole run's. Today all three
      // jobs carry the same billing annotation, but a run starved for two different reasons must not
      // be summarised by whichever job sorted first. Deduped, so the common case stays one line.
      const seen = new Set();
      for (const j of jobs) {
        if (!j?.databaseId) continue;
        const notes = jsonOr(sh('gh', ['api', `repos/${repo.owner}/${repo.name}/check-runs/${j.databaseId}/annotations`], 20_000), null);
        if (Array.isArray(notes)) for (const n of notes) if (n?.message) seen.add(n.message.trim());
      }
      // Report the annotation VERBATIM. A paraphrase is how "billing, escalate" became "capacity,
      // wait" in the first place, and the two imply opposite actions.
      r.ci.note = seen.size
        ? [...seen].join(' | ')
        : `${jobs.length} job(s), all steps=0 runner="" — no runner allocated; no annotation says why`;
    }
  }

  rows.sort((a, b) => a.number - b.number);
  // Name the base ONLY when every PR shares one -- a single header line over mixed bases would be a
  // false label on some rows, which is the class of error this whole block exists to stop.
  const bases = [...new Set(rows.map((r) => r.base).filter(Boolean))];
  const baseRef = bases.length === 1 ? `origin/${bases[0]}` : "each PR's own base";
  const baseSha = bases.length === 1 ? baseShaOf(bases[0]) : null;
  return {
    up: true,
    reason: null,
    rows,
    baseRef,
    baseSha,
    // `first: 50` in the query. Say so rather than silently reporting a subset as if it were all --
    // an under-reported list of open PRs is exactly the stale-snapshot failure this replaces.
    truncated: nodes.length >= 50,
    jobsProbed: opts.jobs ? probed : null,
  };
}
// ---------------------------------------------------------------- now

function rightNow() {
  const p = path.join(REPO, 'docs/NOW.md');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  // Echo the section verbatim rather than summarizing it -- see the design rule at the top.
  const pick = (h) => new RegExp(`##\\s*${h}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n*$)`, 'i').exec(text)?.[1]?.trim() ?? null;
  return { now: pick('Right now'), blocked: pick('Blocked on a human'), traps: pick('Traps that are not visible in the code') };
}

// ---------------------------------------------------------------- collect

/**
 * @param {{ gh?: boolean, vault?: string, ci?: boolean, ciJobs?: boolean }} [opts]
 *   ci:     per-head CI + preflight for every open PR. One extra API call, ~0.9s. Default on.
 *   ciJobs: additionally confirm each `fail(no-runner?)` against the run's job list. One API call
 *           per suspected run (~1.6s each), so opt-in.
 */
export function collect(opts = {}) {
  const useGh = opts.gh !== false;
  const useCi = useGh && opts.ci !== false;
  const vaultRoot = opts.vault ?? 'C:/Users/Micha/desktop/Obsidian Vault/Agent-Governed Vaults';

  let prs = [];
  let issues = [];
  let ghUp = false;
  if (useGh) {
    // mergeable is computed asynchronously by GitHub, so it can legitimately come back UNKNOWN.
    // --limit 50 to match the per-head query's `first: 50`. At 40 the two lists silently disagreed
    // between 41 and 50 open PRs -- two counts of "the open PRs" in one screen, which is the class
    // of divergence this board exists to remove.
    const p = sh('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,mergeable', '--limit', '50'], 20_000);
    const i = sh('gh', ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '40'], 20_000);
    if (p || i) {
      prs = jsonOr(p, []);
      issues = jsonOr(i, []);
      ghUp = true;
    }
  }

  return {
    at: new Date().toISOString(),
    tree: tree(),
    gate: gate(),
    launch: launchGates(),
    deployments: deployments(),
    sprints: sprints(prs),
    departments: departments(vaultRoot),
    now: rightNow(),
    github: { up: ghUp, prs, issues },
    // Its own `up` flag, deliberately: this degrades INDEPENDENTLY of the PR list above, so a
    // GraphQL hiccup costs the per-head column and nothing else on the board.
    perHead: useCi ? perHeadCi({ jobs: Boolean(opts.ciJobs) }) : { up: false, reason: 'skipped (--no-ci)', rows: [] },
  };
}
