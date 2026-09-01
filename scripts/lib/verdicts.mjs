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
 * It was three distinct failure modes, and a defence against one is useless against the others:
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
 *
 * So the enforceable property is a conjunction, not an interval: **the declared complement of
 * reviewers has reported, and every report is resolved** — plus CI green on *this* head SHA, plus
 * the PR still being open.
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


/** Exported so a test can pin it byte-for-byte against merge-policy.json, which is the single
 * source of truth for the rules. Two copies of a rule is how the doc and the enforcement drift. */
export const LEGACY_REJECT_PATTERN = LEGACY_REJECT_RE.source;

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
 * Runs belonging to THIS head SHA. `gh pr checks` reports the runs attached to a PR without
 * surfacing which commit they belong to, and returned green for #107 from a run belonging to the
 * previous head — so the SHA correspondence is made explicit here rather than inherited.
 *
 * @param {Run[]} runs
 * @param {string} headSha
 */
export function runsForHead(runs, headSha) {
  const head = (headSha ?? '').toLowerCase();
  return runs.filter((r) => (r.headSha ?? '').toLowerCase() === head);
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
      detail: `no workflow run exists for head ${short(pr.headRefOid)}. Any green you can see belongs to another commit — 'gh pr checks' does not say which SHA it ran on.`,
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
