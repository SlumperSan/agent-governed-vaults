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
 * @property {string} [body]  PR description, for buy-borrow-build-declared (card 190)
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
 * @property {boolean} rosterDefaulted  true when no REVIEW-ROSTER token was ever posted and
 *   `roster` is `DEFAULT_ROSTER` rather than something the orchestrator declared (card 167)
 * @property {Record<string, {verdict: Verdict, at: string}>} latestVerdicts
 */

// Card 190 / Chairman directive 13 -- see scripts/lib/pr-body-sections.mjs for the section
// extraction and blank-detection logic, factored out so it can be unit-tested without a PR fixture.
import { BBB_SECTIONS, extractSection, isBlankSection } from './pr-body-sections.mjs';

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

/**
 * The orchestrator declares who is reviewing. THE LATEST TOKEN IS ALWAYS AUTHORITATIVE — reviewers
 * can be added, reassigned, or withdrawn to none. `[^\s>]*` (not `+`): `reviewers=` with nothing
 * after it must still MATCH, because an empty roster is how a dead seat (a department whose
 * session ended) gets withdrawn. See `parseRoster`'s own comment for why this cannot be used to
 * clear a standing REJECT.
 */
const ROSTER_RE = /<!--\s*REVIEW-ROSTER\s+reviewers=([^\s>]*)\s*-->/g;

/**
 * Card 167. Eight `REVIEW-ROSTER` tokens were posted by hand in one evening, every one mechanical
 * -- "whoever did not write it", and the author is always known -- and four PRs sat blocked
 * 14-17 days on nothing but that missing comment. `roster-declared` used to block a PR with no
 * token at all; now the absence of a token is not an unresolved question, it is a default. When
 * `parseRoster` finds no token, `evaluate` treats the roster as `DEFAULT_ROSTER` rather than
 * `null`, so review starts immediately instead of stalling on an orchestrator posting a comment.
 *
 * This does not weaken Mode B. `roster-resolved` still blocks in strict mode until every name in
 * the roster IN FORCE -- default or explicit -- has posted a verdict, so "no roster" can no
 * longer mean "nobody needs to review"; it means "Security needs to review, same as if someone
 * had typed the token". An explicit `REVIEW-ROSTER` token, posted at any time, still overrides the
 * default -- `parseRoster`'s "latest token wins" is unchanged, including an explicit empty
 * `reviewers=` to withdraw a dead seat (card #352), which stays a real, distinct state from "no
 * token was ever posted" and does NOT fall back to the default.
 *
 * Mirrored in `merge-policy.json`'s top-level `defaultRoster` field; keep the two in sync.
 */
export const DEFAULT_ROSTER = Object.freeze(['Security']);

/** A reviewer's machine-readable verdict. The only thing that may clear a blocker. */
const VERDICT_RE = /<!--\s*REVIEW-VERDICT\s+reviewer=([A-Za-z0-9_.\-]+)\s+verdict=(ACCEPT|REJECT)\s*-->/g;

/**
 * Same shape as `VERDICT_RE` but with `verdict=` left unconstrained, so it matches a token whose
 * value the strict regex above rejects — `verdict=REQUEST_CHANGES` (GitHub's own review UI's word)
 * being the case that motivated this. Used by `parseUnparseableVerdicts` to REPORT a token the gate
 * saw but could not parse, and by `unreadableLatestVerdicts` to BLOCK when such a token is its
 * reviewer's newest (card 216). A match here never clears anything and is never counted as a real
 * verdict. Card #59 (PR 307): this exact shape, in a comment, held a REJECT that
 * `roster-resolved` reported as "reviewer has not reported" — a blocking finding that never reached
 * the gate, because the invalid value made the token invisible rather than merely rejected.
 */
const LOOSE_VERDICT_RE = /<!--\s*REVIEW-VERDICT\s+reviewer=([A-Za-z0-9_.\-]+)\s+verdict=([^\s>]*)\s*-->/g;

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
 * THE LATEST ROSTER TOKEN WINS, INCLUDING AN EMPTY ONE. Card #352's dead-seat bug: this used to
 * update `found` only when the new token was non-empty (`if (reviewers.length > 0) found = ...`),
 * so a later `reviewers=` posted specifically to withdraw a department whose session ended was
 * silently ignored and `found` stayed on the last non-empty roster forever. The only working
 * remedy was reassigning to a DIFFERENT live reviewer — which may not exist, which is exactly the
 * situation (Security/Product/Finance/Design all dark the same day) this fix exists for.
 *
 * `{ reviewers: [], at }` (an explicit empty roster) is a REAL, DISTINCT state from `null` (no
 * roster ever declared) — `roster-declared` blocks on `null`, not on an empty array, so a roster
 * withdrawn to nobody reads as "a roster was declared, and it currently requires no one," not as
 * "no review was ever assigned." `roster-resolved` trivially passes an empty roster (nothing to
 * be missing), which is the correct denominator when nobody is currently required.
 *
 * THIS DOES NOT WEAKEN no-standing-reject. That rule (Mode A, in `evaluate` below) blocks on
 * `latestPerReviewer(verdicts)` — every REVIEW-VERDICT token ever posted, independent of who is
 * currently on the roster — so a reviewer's standing REJECT still blocks a merge after that
 * reviewer is dropped from the roster. Only the roster-declared/roster-resolved DENOMINATOR moves
 * with the latest roster; a verdict already cast keeps its force regardless of roster changes,
 * per merge-policy.json's own invariant and the #98/#109 incidents behind it.
 *
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
      // Every match updates `found` — no `reviewers.length > 0` gate. An empty match (reviewers=
      // with nothing after it) is itself the latest declaration and must take effect, not be
      // treated as noise.
      found = { reviewers, at: c.createdAt };
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
 * REVIEW-VERDICT tokens whose shape the gate recognizes but whose `verdict=` value `VERDICT_RE`
 * does not match — seen, not parsed, and rendering identically to "reviewer has not reported" in
 * `roster-resolved`. Report-only: a match here is NEVER counted as a real verdict by anything else
 * in this file, so it can never clear or weaken a blocker.
 * @param {Comment[]} comments
 * @returns {{reviewer: string, value: string, at: string}[]}
 */
export function parseUnparseableVerdicts(comments) {
  const out = [];
  for (const c of comments) {
    LOOSE_VERDICT_RE.lastIndex = 0;
    let m;
    while ((m = LOOSE_VERDICT_RE.exec(c.body)) !== null) {
      if (!/^(?:ACCEPT|REJECT)$/.test(m[2])) out.push({ reviewer: m[1], value: m[2], at: c.createdAt });
    }
  }
  return out;
}

/**
 * Card 216: each reviewer's token that the gate SEES but cannot PARSE, when it is newer than that
 * reviewer's latest parsed verdict (or the reviewer has no parsed verdict at all). Suppose a reviewer
 * posts ACCEPT, then `verdict=Reject`: `latestPerReviewer` still returns the ACCEPT, so the gate
 * merged on a note while the reviewer's last word was an objection it could not read. That token
 * must block until the reviewer reposts a well-formed one.
 *
 * "Newer" is by comment time, then by position: comment order, then offset in the body. So a
 * malformed token and a valid one in the SAME comment are ordered by which comes last, and a
 * well-formed repost after the malformed token clears it.
 * @param {Comment[]} comments
 * @returns {{reviewer: string, value: string, at: string}[]}
 */
export function unreadableLatestVerdicts(comments) {
  /** @type {Record<string, {key: [string, number, number], value: string | null, at: string}>} */
  const last = {};
  const later = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]);
  comments.forEach((c, ci) => {
    LOOSE_VERDICT_RE.lastIndex = 0;
    let m;
    while ((m = LOOSE_VERDICT_RE.exec(c.body)) !== null) {
      /** @type {[string, number, number]} */
      const key = [c.createdAt, ci, m.index];
      const prev = last[m[1]];
      if (!prev || later(key, prev.key)) {
        last[m[1]] = { key, value: /^(?:ACCEPT|REJECT)$/.test(m[2]) ? null : m[2], at: c.createdAt };
      }
    }
  });
  return Object.entries(last)
    .filter(([, v]) => v.value !== null)
    .map(([reviewer, v]) => ({ reviewer, value: /** @type {string} */ (v.value), at: v.at }));
}

/**
 * @typedef {object} Review   a GitHub REVIEW OBJECT (`gh pr view --json reviews`), distinct from an
 *   issue comment — `merge-preflight.mjs` never reads this array for rule evaluation and never
 *   will (a token here cannot clear anything; see `merge-policy.json`'s
 *   `enforcement.nativeReviewsUnavailable`). Passed to `evaluate` for REPORTING ONLY.
 * @property {string} author
 * @property {string} body
 */

/**
 * Rostered reviewers who posted a well-formed verdict token inside a REVIEW OBJECT (`gh pr review`)
 * but have no verdict in `comments` — the token renders correctly on the PR page and is invisible
 * to the gate, which reads issue comments only. Report-only: never counted as a verdict.
 * @param {Review[]} reviews
 * @param {Record<string, {verdict: Verdict, at: string}>} latestFromComments
 * @param {string[]} rosterReviewers
 * @returns {string[]}
 */
export function reviewObjectVerdicts(reviews, latestFromComments, rosterReviewers) {
  const out = [];
  for (const r of reviews) {
    if (!rosterReviewers.includes(r.author) || latestFromComments[r.author]) continue;
    VERDICT_RE.lastIndex = 0;
    if (VERDICT_RE.test(r.body ?? '') && !out.includes(r.author)) out.push(r.author);
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
 * @param {Review[]} [input.reviews]   REPORT-ONLY (see `reviewObjectVerdicts`); defaults to `[]` so
 *   every existing caller and fixture that does not supply it is unaffected.
 * @param {'advisory'|'strict'} [input.mode]
 * @returns {Decision}
 */
export function evaluate({ pr, comments, runs, reviews = [], mode = 'strict' }) {
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

  // --- buy-borrow-build-declared (Chairman directive 13, card 190) — both modes ---------------
  // A feat/ PR must say what the repo already has and what exists elsewhere before it builds
  // something new. "None found" is a real answer and must pass; a missing section, or one nobody
  // filled in, reads identically to a real search in a diff — that is the failure this rule exists
  // to stop. Both modes, like ci-matches-head and pr-open: this is a body-content requirement, not
  // a review-workflow one, so it applies whether or not the roster rules are armed. See
  // scripts/lib/pr-body-sections.mjs for the section extraction and blank-detection logic.
  if (typeof pr.headRefName === 'string' && pr.headRefName.startsWith('feat/')) {
    for (const { label, heading } of BBB_SECTIONS) {
      const section = extractSection(pr.body ?? '', heading);
      if (section === null) {
        blockers.push({
          ruleId: 'buy-borrow-build-declared',
          detail:
            `no "## ${label}" section in the PR body. Chairman directive 13: every feat/ PR states ` +
            `what the repo already has and what exists elsewhere before building something new — ` +
            `"None found" is a real answer and must be written, not omitted.`,
        });
      } else if (isBlankSection(section)) {
        blockers.push({
          ruleId: 'buy-borrow-build-declared',
          detail:
            `"## ${label}" section is present but blank (only whitespace, an HTML comment, or an ` +
            `unfilled template placeholder). Fill it in, or write "None found" if that is the ` +
            `honest answer — a blank section reads the same whether the search happened or not.`,
        });
      }
    }
  }

  // --- verdicts -------------------------------------------------------------------------------
  // Card 167: an explicit token (including an explicit empty one, card #352) always wins; only a
  // PR that has NEVER carried a REVIEW-ROSTER token falls back to DEFAULT_ROSTER.
  const explicitRoster = parseRoster(comments);
  const rosterDefaulted = explicitRoster === null;
  const roster = explicitRoster ?? { reviewers: [...DEFAULT_ROSTER], at: null };
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
  // Card 216: a reviewer whose NEWEST token is unreadable blocks, whatever their older parsed
  // verdict says — the gate cannot tell an objection from a typo, so it must not merge on either.
  for (const u of unreadableLatestVerdicts(comments)) {
    blockers.push({
      ruleId: 'no-standing-reject',
      detail: `${u.reviewer}'s newest verdict token is unreadable (verdict=${u.value} at ${u.at}), and it is newer than any verdict of theirs the gate can parse. Repost it as a well-formed token: verdict=ACCEPT or verdict=REJECT.`,
    });
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
  // Card 167: roster-declared can no longer block on its own — a roster is always IN FORCE, either
  // the orchestrator's explicit token or DEFAULT_ROSTER — so the only remaining question is whether
  // it is RESOLVED. See DEFAULT_ROSTER's comment for why this does not weaken Mode B.
  if (mode === 'strict') {
    const missing = roster.reviewers.filter((r) => !latest[r]);
    if (missing.length > 0) {
      blockers.push({
        ruleId: 'roster-resolved',
        detail:
          `rostered reviewer(s) with no verdict yet: ${missing.join(', ')}` +
          (rosterDefaulted ? ` (roster defaulted to ${DEFAULT_ROSTER.join(', ')} — no REVIEW-ROSTER token was posted, card 167)` : '') +
          '. Review in flight — this is not "nobody objected".',
      });
    }
  } else if (rosterDefaulted) {
    notes.push('advisory mode: no REVIEW-ROSTER token, so Mode B (a review still in flight) is NOT checked — the roster default (card 167) only matters in strict mode.');
  }

  // --- notes ----------------------------------------------------------------------------------
  if (rosterDefaulted) {
    notes.push(`roster defaulted to ${DEFAULT_ROSTER.join(', ')}: no REVIEW-ROSTER token was ever posted, so merge-policy.json's defaultRoster applies (card 167) — an unposted roster no longer means "nobody needs to review".`);
  }
  const offRoster = Object.keys(latest).filter((r) => !roster.reviewers.includes(r));
  if (offRoster.length > 0) {
    notes.push(`verdict(s) from reviewer(s) not on the roster, counted anyway: ${offRoster.join(', ')}.`);
  }
  if (legacy.length > 0 && verdicts.length === 0) {
    notes.push('this PR predates the REVIEW-VERDICT token; verdicts read by the block-only prose heuristic.');
  }

  // --- card #59: verdict tokens that reach the gate silently unparsed ------------------------
  // Both render on the PR page identically to "reviewer has not reported", which `roster-resolved`
  // cannot tell apart from a review still in flight. These notes never clear anything. An
  // unparsed token that is a reviewer's NEWEST also blocks, under no-standing-reject (card 216).
  for (const u of parseUnparseableVerdicts(comments)) {
    notes.push(
      `verdict token found but not parsed: reviewer=${u.reviewer} verdict=${u.value} (at ${u.at}) — ` +
      'accepted values are ACCEPT, REJECT.',
    );
  }
  if (roster) {
    for (const author of reviewObjectVerdicts(reviews, latest, roster.reviewers)) {
      notes.push(`${author} posted a verdict as a review object; the gate reads issue comments. Re-post with \`gh pr comment\`.`);
    }
  }

  return {
    mode,
    clear: blockers.length === 0,
    blockers,
    notes,
    roster: roster.reviewers,
    rosterDefaulted,
    latestVerdicts: latest,
  };
}

/** @param {string} sha */
function short(sha) {
  return (sha ?? '').slice(0, 8) || '(unknown)';
}
