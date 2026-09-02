// @ts-check
/**
 * Pure logic behind `scripts/merge-preflight.mjs`: given a PR's metadata, its comments and the
 * workflow runs on its branch, decide whether it may merge. No network, no `gh`, no filesystem —
 * so the test suite feeds it fixtures rebuilt from real PRs instead of needing an authenticated
 * GitHub, and `npm run gate` stays runnable offline.
 *
 * ## Why this exists
 *
 * On 2026-09-01 four PRs — #92, #98, #107 and #109 — merged across review verdicts that were never
 * addressed, landing two HIGHs on `protocol/main`. Nothing mechanically connected a verdict to
 * mergeability: `gh pr merge` does not read comments, and the review pattern is a convention.
 *
 * It was five distinct failure modes, and a defence against one is useless against the others:
 *
 *   - **Mode A — merged over a REJECT already standing in writing.** #107 by 8 minutes, #92 by 29.
 *     Not a visibility problem: a *policy* one. The standing self-merge rule had no clause about an
 *     open REJECT, so an agent following it as written merges correctly and lands a HIGH.
 *   - **Mode B — the review lost a race it could not see it was in.** #98's REJECT posted 25
 *     seconds after its merge; #109's 5.5 minutes after, so the PR merged before its verdict
 *     existed at all. An interval-based check ("did a merge race ahead of a posted verdict") cannot
 *     catch #109, because there was no verdict to measure from.
 *   - **Mode C — the branch pushed to was already dead.** `git rev-list --left-right --count`
 *     reports "0 behind / N ahead" for a freshly-merged branch exactly as for a live one.
 *     Divergence is not liveness.
 *   - **Mode D — the reviewed content was replaced after the verdict.** A, B and C are all about
 *     *when* a merge happens relative to a review; D is about *what a review can see at all*. A
 *     conflict resolution is an edit nobody reviews — a PR diff shows the merged RESULT and never
 *     the CHOICE — so a defect can enter after a correct verdict and ship under it.
 *   - **Mode E — the base moved under the verdict.** D's mirror: D is "the content changed under
 *     the verdict", E is "the world the content describes changed under it". #119 held a valid
 *     ACCEPT on an UNMOVED head while `main` moved beneath it and falsified two sentences the PR
 *     adds. Nothing about the PR changed, so no rule keyed to the PR can see it.
 *
 * So the enforceable property is a conjunction, not an interval: **the declared complement of
 * reviewers has reported, and every report is resolved, on the content that would actually merge**
 * — plus CI green on *this* head SHA, plus the PR still being open.
 *
 * ## The one design decision that stops this being theatre
 *
 * A structured token is the ONLY thing that may CLEAR a blocker; the prose heuristic may only ADD
 * one. A check satisfiable by writing the word ACCEPT would be theatre, and this asymmetry makes
 * that impossible by construction. It also bounds the fragility of natural-language parsing to
 * false alarms — a reviewer who writes "this is not a REJECT, but" gets blocked, and clears it by
 * posting a token — which is the safe direction to be wrong in.
 *
 * The rules themselves live in `merge-policy.json`, which `docs/reviews/MERGE-POLICY.md` embeds
 * verbatim, so the prose humans read cannot drift from what this file enforces.
 *
 * @typedef {'ACCEPT'|'REJECT'} Verdict
 *
 * @typedef {object} Comment
 * @property {string} createdAt   ISO 8601; compared lexicographically, which is correct for ISO Z
 * @property {string} body
 *
 * @typedef {object} PullRequest
 * @property {number} [number]
 * @property {string} state       'OPEN' | 'MERGED' | 'CLOSED'
 * @property {string} headRefOid  the commit CI must have run on
 * @property {string} [headCommittedDate]  ISO; when the head commit landed, for Mode D
 * @property {number} [behindBy]  commits the branch is behind its base, for Mode E
 * @property {string} [baseRefName]
 * @property {string} [headRefName]
 * @property {boolean} [isDraft]
 *
 * @typedef {object} Run
 * @property {string} headSha
 * @property {string} status      'completed' | 'in_progress' | 'queued' | ...
 * @property {string|null} conclusion
 * @property {string} [name]
 *
 * @typedef {object} Blocker
 * @property {string} ruleId
 * @property {string} detail
 *
 * @typedef {object} Decision
 * @property {'advisory'|'strict'} mode
 * @property {boolean} clear
 * @property {Blocker[]} blockers
 * @property {string[]} notes
 * @property {string[]|null} roster
 * @property {Record<string, {verdict: Verdict, at: string}>} latestVerdicts
 */

/**
 * The `name:` of this gate's own workflow, `.github/workflows/merge-preflight.yml`.
 *
 * `merge-preflight.mjs` lists runs with `--branch <headRefName>` and no `--workflow` filter, so the
 * gate's own runs arrive inside the set it is about to judge. That is a display string to key a
 * filter on, and keying a filter to a display string is how a filter silently stops matching. The
 * mitigation is that the string is pinned to the yml by a test in the gate's own path
 * (`scripts/test/merge-preflight.test.mjs`, run by `npm run gate` via `test:backend`), so renaming
 * the workflow fails the suite loudly instead of quietly re-arming self-inclusion.
 *
 * The rejected alternative was the run id (`GITHUB_RUN_ID`). It excludes only the CURRENTLY
 * EXECUTING run, so previously completed preflight runs stay in the tally — leaving the two
 * PERMISSIVE symptoms armed while fixing only the annoying one — and it is absent when the script
 * runs on a developer's machine, breaking the header's promise that this tool "reads only `gh`, so
 * it behaves identically on a developer's machine, in a detached review worktree, and on a CI
 * runner."
 */
export const SELF_WORKFLOW_NAME = 'merge-preflight';

/** The orchestrator declares who is reviewing. Last declaration wins — reviewers can be added. */
const ROSTER_RE = /<!--\s*REVIEW-ROSTER\s+reviewers=([^\s>]+)\s*-->/g;

/** A reviewer's machine-readable verdict. The only thing that may clear a blocker. */
const VERDICT_RE = /<!--\s*REVIEW-VERDICT\s+reviewer=([A-Za-z0-9_.\-]+)\s+verdict=(ACCEPT|REJECT)\s*-->/g;

/**
 * Legacy prose verdicts, for PRs written before the token existed. Block-only, by design.
 *
 * Applied to the FIRST NON-EMPTY LINE with bold markers stripped, not to the whole body — the
 * difference is not cosmetic. Validated against every comment on PRs #90–#120 on 2026-09-01:
 * 15 matches, 15 correct. It skips `## Fixer pass — Review92-B findings` and
 * `## Fixer pass — Review109 findings`, both of which quote the word REJECT in their bodies and
 * which a naive body-wide grep flags as verdicts.
 */
const LEGACY_REJECT_RE = /^#{1,6}\s+.*\breview\b.*\bREJECT\b/i;

/**
 * The same heading shape, but either verdict. This does NOT clear anything — it answers only
 * "has anyone reviewed this at all", which Mode E needs as its denominator on PRs that predate the
 * token. Using it to raise `base-current` is still block-only, so the asymmetry holds.
 *
 * Found by running the tool against #112: an ACCEPTed PR 43 commits behind `main` reported CLEAR,
 * because its ACCEPT is prose and a token-only gate cannot see it — the exact case Mode E exists
 * for, missed by the rule meant to catch it.
 */
const LEGACY_VERDICT_RE = /^#{1,6}\s+.*\breview\b.*\b(?:REJECT|ACCEPT)\b/i;


/** Exported so a test can pin it byte-for-byte against merge-policy.json, which is the single
 * source of truth for the rules. Two copies of a rule is how the doc and the enforcement drift. */
export const LEGACY_REJECT_PATTERN = LEGACY_REJECT_RE.source;

/** Likewise pinned against the policy file. */
export const LEGACY_VERDICT_PATTERN = LEGACY_VERDICT_RE.source;

/**
 * Comments that look like a review verdict of EITHER kind. Never clears; only supplies Mode E's
 * denominator on PRs written before the token existed.
 * @param {Comment[]} comments
 */
export function parseLegacyVerdicts(comments) {
  return comments.filter((c) => LEGACY_VERDICT_RE.test(firstHeadingLine(c.body)));
}

/** @param {string} body */
function firstHeadingLine(body) {
  const line = body.split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/\*\*/g, '').trim();
}

/**
 * @param {Comment[]} comments
 * @returns {{reviewers: string[], at: string}|null}
 */
export function parseRoster(comments) {
  /** @type {{reviewers: string[], at: string}|null} */
  let found = null;
  for (const c of comments) {
    ROSTER_RE.lastIndex = 0;
    let m;
    while ((m = ROSTER_RE.exec(c.body)) !== null) {
      const reviewers = m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (reviewers.length > 0) found = { reviewers, at: c.createdAt };
    }
  }
  return found;
}

/**
 * @param {Comment[]} comments
 * @returns {{reviewer: string, verdict: Verdict, at: string}[]}
 */
export function parseVerdicts(comments) {
  /** @type {{reviewer: string, verdict: Verdict, at: string}[]} */
  const out = [];
  for (const c of comments) {
    VERDICT_RE.lastIndex = 0;
    let m;
    while ((m = VERDICT_RE.exec(c.body)) !== null) {
      out.push({ reviewer: m[1], verdict: /** @type {Verdict} */ (m[2]), at: c.createdAt });
    }
  }
  return out;
}

/**
 * Prose REJECT headings, for PRs predating the token.
 * @param {Comment[]} comments
 * @returns {{heading: string, at: string}[]}
 */
export function parseLegacyRejects(comments) {
  const out = [];
  for (const c of comments) {
    const heading = firstHeadingLine(c.body);
    if (LEGACY_REJECT_RE.test(heading)) out.push({ heading, at: c.createdAt });
  }
  return out;
}

/**
 * Latest verdict per reviewer. Verdicts arrive out of band — #92 collected a second REJECT 42
 * minutes after its merge — and a REJECT must be clearable, or no fixer pass could ever land.
 *
 * @param {{reviewer: string, verdict: Verdict, at: string}[]} verdicts
 * @returns {Record<string, {verdict: Verdict, at: string}>}
 */
export function latestPerReviewer(verdicts) {
  /** @type {Record<string, {verdict: Verdict, at: string}>} */
  const latest = {};
  for (const v of verdicts) {
    const prev = latest[v.reviewer];
    if (!prev || v.at >= prev.at) latest[v.reviewer] = { verdict: v.verdict, at: v.at };
  }
  return latest;
}

/**
 * Runs belonging to THIS head SHA, **excluding this gate's own**. `gh pr checks` reports the runs
 * attached to a PR without surfacing which commit they belong to, and returned green for #107 from
 * a run belonging to the previous head — so the SHA correspondence is made explicit here rather
 * than inherited.
 *
 * WHY THE SECOND FILTER. `merge-preflight.mjs` lists runs with `--branch <headRefName>` and no
 * `--workflow` filter, so a `pull_request`-triggered preflight run — which carries the PR head's
 * SHA — matched on `headSha` alone and the gate evaluated itself. One root cause, three symptoms:
 *
 *   1. It blocked on its own `in_progress` run, which is by construction never `completed` while it
 *      is the run doing the asking.
 *   2. It counted its own *completed* run as a green, because `conclusion` is the RUN's conclusion
 *      and a run that succeeds at posting a `failure` commit status concludes `success`. That is
 *      the artifact substitution this whole file exists to prevent, committed inside the gate.
 *   3. Worst, and permissive: one completed preflight run makes `mine.length === 0` false and
 *      `succeeded.length === 1` true, defeating the `ci-matches-head` catch-all — so a head with NO
 *      CI would pass the rule NAMED for matching CI to the head. Latent while `ci.yml` has a bare
 *      `pull_request:` trigger with no `paths:` filter, and armed by any routine "skip CI for
 *      docs-only changes". Nothing in the gate depended on that trigger config or checked it; after
 *      this filter, nothing needs to.
 *
 * Exclusion is EXACT-match on the name, not a prefix or substring: a future `merge-preflight-lint`
 * would be a real workflow whose result is real evidence, and swallowing it is the same class of
 * bug in the opposite direction. `SELF_WORKFLOW_NAME` is pinned to the yml by the test suite.
 *
 * @param {Run[]} runs
 * @param {string} headSha
 */
export function runsForHead(runs, headSha) {
  const head = (headSha ?? '').toLowerCase();
  return runs.filter((r) => (r.headSha ?? '').toLowerCase() === head && r.name !== SELF_WORKFLOW_NAME);
}

/**
 * @param {object} input
 * @param {PullRequest} input.pr
 * @param {Comment[]} input.comments
 * @param {Run[]} input.runs
 * @param {'advisory'|'strict'} [input.mode]
 * @returns {Decision}
 */
export function evaluate({ pr, comments, runs, mode = 'strict' }) {
  /** @type {Blocker[]} */
  const blockers = [];
  /** @type {string[]} */
  const notes = [];

  // --- pr-open (Mode C) -----------------------------------------------------------------------
  if (pr.state !== 'OPEN') {
    blockers.push({
      ruleId: 'pr-open',
      detail:
        `PR state is ${pr.state}, not OPEN. Do not merge, and do not push to ` +
        `${pr.headRefName ?? 'this branch'}: GitHub reopens no PR on push, opens no CI run for the ` +
        `new commits, and still accepts comments onto the closed PR, so the work looks landed and ` +
        `is stranded. Open a NEW PR instead.`,
    });
  } else if (pr.isDraft) {
    blockers.push({ ruleId: 'pr-open', detail: 'PR is a draft.' });
  }

  // --- verdicts -------------------------------------------------------------------------------
  const roster = parseRoster(comments);
  const verdicts = parseVerdicts(comments);
  const latest = latestPerReviewer(verdicts);
  const legacy = parseLegacyRejects(comments);
  const lastVerdictAt = verdicts.reduce((acc, v) => (v.at > acc ? v.at : acc), '');

  // --- no-standing-reject (Mode A) ------------------------------------------------------------
  for (const [reviewer, v] of Object.entries(latest)) {
    if (v.verdict === 'REJECT') {
      blockers.push({
        ruleId: 'no-standing-reject',
        detail: `${reviewer}'s latest verdict is REJECT (${v.at}). Address the findings; the fixer or the reviewer then posts a newer REVIEW-VERDICT token.`,
      });
    }
  }
  for (const l of legacy) {
    // Block-only: a prose REJECT is cleared solely by a LATER structured token, never by more prose.
    if (!(lastVerdictAt && lastVerdictAt > l.at)) {
      blockers.push({
        ruleId: 'no-standing-reject',
        detail: `unresolved prose REJECT at ${l.at}: "${l.heading}". Prose cannot clear itself — post a REVIEW-VERDICT token after addressing it (or, if this heading is a false alarm, post one saying so).`,
      });
    }
  }

  // --- ci-matches-head ------------------------------------------------------------------------
  const mine = runsForHead(runs, pr.headRefOid);
  const succeeded = mine.filter((r) => r.status === 'completed' && r.conclusion === 'success');
  const failed = mine.filter(
    (r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'skipped',
  );
  const pending = mine.filter((r) => r.status !== 'completed');
  if (mine.length === 0) {
    blockers.push({
      ruleId: 'ci-matches-head',
      detail: `no workflow run exists for head ${short(pr.headRefOid)} (this gate's own '${SELF_WORKFLOW_NAME}' runs are excluded, so 'gh run list' may show runs this counted as none). Any green you can see belongs to another commit — 'gh pr checks' does not say which SHA it ran on.`,
    });
  } else {
    for (const r of failed) {
      blockers.push({
        ruleId: 'ci-matches-head',
        detail: `run ${r.name ?? '(unnamed)'} on head ${short(pr.headRefOid)} concluded ${r.conclusion}.`,
      });
    }
    for (const r of pending) {
      blockers.push({
        ruleId: 'ci-matches-head',
        detail: `run ${r.name ?? '(unnamed)'} on head ${short(pr.headRefOid)} is ${r.status}, not completed.`,
      });
    }
    if (succeeded.length === 0 && failed.length === 0 && pending.length === 0) {
      blockers.push({
        ruleId: 'ci-matches-head',
        detail: `no successful run for head ${short(pr.headRefOid)} (${mine.length} run(s) present, none conclusive).`,
      });
    }
  }

  // --- verdict-covers-head (Mode D) — both modes ----------------------------------------------
  // A verdict grades content, not a pull request. If the head moved after the verdict was posted,
  // what merges is not what was reviewed — and the dangerous case is not a fixer's new commit
  // (visible, expected) but a CONFLICT RESOLUTION, because a PR diff shows the merged RESULT and
  // never the CHOICE. Seen live on #121/#117: a keep-ours resolution would have re-introduced the
  // hand-maintained signal list that #121 exists to abolish, inside a PR whose subject is unrelated,
  // under a verdict that was correct when it was written. The reviewer was competent, the review was
  // right, and the defect enters afterwards in an edit nobody reads.
  // Both modes, unlike the roster rules: this needs only a verdict token, which is the reviewer's
  // own act, not an orchestrator convention. If a verdict exists at all, checking it against the
  // head costs nothing and is never wrong to do.
  if (pr.headCommittedDate) {
    const stale = Object.entries(latest)
      .filter(([, v]) => v.at < /** @type {string} */ (pr.headCommittedDate))
      .map(([r, v]) => `${r} (verdict ${v.at})`);
    if (stale.length > 0) {
      blockers.push({
        ruleId: 'verdict-covers-head',
        detail:
          `head ${short(pr.headRefOid)} was committed ${pr.headCommittedDate}, after: ${stale.join(', ')}. ` +
          `Those verdicts graded content that is no longer what would merge. Re-confirm with a newer ` +
          `REVIEW-VERDICT token. If the new commit is a conflict resolution, re-read the resolution ` +
          `itself — the diff shows the result, never which side was chosen.`,
      });
    }
  }

  // --- base-current (Mode E) — both modes -----------------------------------------------------
  // Mode D's mirror. Mode D is "the content changed under the verdict"; this is "the world the
  // content describes changed under the verdict". A PR can carry a genuine, current, unstale ACCEPT
  // on an UNMOVED head and still be wrong to merge, because `main` moved beneath it.
  //
  // Live on #119, 2026-09-01: it held a valid ACCEPT against `d9293c23`, then #121 merged and
  // inverted the canary tier semantics in `sinks.mjs`. Two sentences #119 *adds* became false
  // against merged main — while `merge-tree` stayed clean (they touch different files), CI stayed
  // green on the reviewed head, and the verdict stayed untouched. `verdict-covers-head` cannot see
  // it, because the branch head never moved.
  //
  // `behindBy > 0` means the branch's merge-base is not the base branch's tip, so any verdict on it
  // was computed against a base that no longer exists. Gated on a verdict existing: without one the
  // other rules already block, and reporting base drift there would be noise.
  const reviewed = Object.keys(latest).length > 0 || parseLegacyVerdicts(comments).length > 0;
  if (typeof pr.behindBy === 'number' && pr.behindBy > 0 && reviewed) {
    blockers.push({
      ruleId: 'base-current',
      detail:
        `the branch is ${pr.behindBy} commit(s) behind ${pr.baseRefName ?? 'the base branch'}, so every ` +
        `verdict on it was computed against a base that has since moved. Merge the base in — which ` +
        `also re-runs CI against the content that would really land — and have the reviewer ` +
        `re-confirm. This cannot tell you WHETHER the moved base falsifies anything; only a re-read can.`,
    });
  }

  // --- roster rules (Mode B) — strict only ----------------------------------------------------
  if (mode === 'strict') {
    if (!roster) {
      blockers.push({
        ruleId: 'roster-declared',
        detail:
          'no REVIEW-ROSTER token on this PR. Without a declared roster there is no denominator, ' +
          'so "nobody objected" and "nobody looked" are the same observation — which is exactly how ' +
          '#109 merged 5.5 minutes before its review existed.',
      });
    } else {
      const missing = roster.reviewers.filter((r) => !latest[r]);
      if (missing.length > 0) {
        blockers.push({
          ruleId: 'roster-resolved',
          detail: `rostered reviewer(s) with no verdict yet: ${missing.join(', ')}. Review in flight — this is not "nobody objected".`,
        });
      }
    }
  } else if (!roster) {
    notes.push('advisory mode: no REVIEW-ROSTER token, so Mode B (a review still in flight) is NOT checked.');
  }

  // --- notes ----------------------------------------------------------------------------------
  if (roster) {
    const offRoster = Object.keys(latest).filter((r) => !roster.reviewers.includes(r));
    if (offRoster.length > 0) {
      notes.push(`verdict(s) from reviewer(s) not on the roster, counted anyway: ${offRoster.join(', ')}.`);
    }
  } else if (verdicts.length > 0) {
    notes.push(`${verdicts.length} verdict token(s) present but no roster declared — the complement is unknown.`);
  }
  if (legacy.length > 0 && verdicts.length === 0) {
    notes.push('this PR predates the REVIEW-VERDICT token; verdicts read by the block-only prose heuristic.');
  }

  return {
    mode,
    clear: blockers.length === 0,
    blockers,
    notes,
    roster: roster ? roster.reviewers : null,
    latestVerdicts: latest,
  };
}

/** @param {string} sha */
function short(sha) {
  return (sha ?? '').slice(0, 8) || '(unknown)';
}
