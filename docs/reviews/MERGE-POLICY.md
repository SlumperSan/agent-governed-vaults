# Merge policy — when a PR may land on `protocol/main`

**Status: CONVENTION, not enforcement.** Nothing in this repository can stop a merge today. This
document and `scripts/merge-preflight.mjs` describe and check the policy; only branch protection —
which needs the repository owner — makes it binding. The exact steps are in
[§ Making this enforcement](#making-this-enforcement). Until they are taken, do not call it a gate.

## Why this exists

On 2026-09-01 four pull requests — [#92], [#98], [#107] and [#109] — merged across review verdicts
that were never addressed, putting two HIGHs onto `protocol/main`. Nothing mechanically connected a
verdict to mergeability: `gh pr merge` does not read comments, and the review pattern in
`docs/SWARM.md` §3 is a convention.

It was **three distinct failure modes, and a defence against one is useless against the others.**

| mode | what happened | the PRs | the rule that answers it |
|---|---|---|---|
| **A — policy** | merged over a REJECT already standing, in writing, on the PR | #107 by 8 min, #92 by 29 min | `no-standing-reject` |
| **B — race** | the review lost a race it could not see it was in | #98's REJECT posted **25 s** after the merge; #109's 5.5 min after, so the PR merged before its verdict existed | `roster-declared` + `roster-resolved` |
| **C — orientation** | pushed to a branch whose PR had already merged | #107's fixer pass, rescued by hand as [#120] | `pr-open` |

Three consequences worth stating plainly, because each one defeats an obvious design:

- **An in-flight marker cannot catch Mode A.** The verdict was already there; it was overridden.
- **A REJECT-parser cannot catch Mode B.** For #98 there was nothing to parse — the gap was 25
  seconds.
- **An interval-based check — "did a merge race ahead of a posted verdict" — cannot catch #109 at
  all**, because no verdict existed to measure from. A check built to that wording would have
  passed the worst case and failed its own purpose.

So the enforceable property is not an interval. It is a conjunction: **the declared complement of
reviewers has reported, and every report is resolved** — plus CI green on *this* head SHA, plus the
PR still being open.

### The compounding factor

`gh pr checks` reports the runs attached to a PR **without surfacing which commit they belong to**,
and it returned green for #107 from a run belonging to the previous head. So on the night in
question an agent could have merged a PR that had an open REJECT, a review still running, and
"green CI" belonging to someone else's commit — while following every rule as written. The
`ci-matches-head` rule reads `gh run list --branch <b> --json headSha,status,conclusion` and matches
`headSha` against the PR's `headRefOid` itself.

### Why not just use GitHub's own reviews

Asked and answered, because it is the first question this design invites. The whole swarm is a
single GitHub identity (`SlumperSan`) and every PR is authored by it, so GitHub refuses `approve`
and `request-changes` on its own pull requests: `reviewDecision` is permanently `null` and
`CHANGES_REQUESTED` — the state branch protection natively blocks on — is unreachable. Verified on
2026-09-01: `viewerDidAuthor: true` on every PR checked, and **zero** native reviews exist in this
repository's history. A second machine account is the only path to natively-enforced reviewer
independence, and it is the owner's call (§ Making this enforcement, step 4).

The same fact has a second consequence: a script cannot tell reviewer 1 from reviewer 2 by identity.
"Two reviewers reported" is not computable from GitHub — only from a roster the orchestrator
declares. Hence the tokens below.

## The protocol

Two HTML comments. They are invisible in the rendered comment, so they cost a reviewer nothing.

**The orchestrator, when it spawns reviewers, posts:**

```text
<!-- REVIEW-ROSTER reviewers=Review119,Review119b -->
```

**Each reviewer, inside its existing `## Adversarial review — VERDICT` comment, posts:**

```text
<!-- REVIEW-VERDICT reviewer=Review119 verdict=REJECT -->
```

...and the fixer or the reviewer posts a newer one with `verdict=ACCEPT` once the findings are
closed. The latest verdict per reviewer wins; verdicts arrive out of band (#92 collected a second
REJECT 42 minutes after its merge) and a REJECT must be clearable, or no fixer pass could ever land.

**The roster is the Mode B mechanism.** It is not a second, separate defence bolted on beside the
verdicts — it is their denominator. Without it, "nobody objected" and "nobody looked" are the same
observation, which is exactly how #109 merged 5.5 minutes before its review existed.

**The reviewer count is whatever the roster declares.** It is deliberately not a hardcoded two: most
PRs on 2026-09-01 got one review, and a check demanding two would make most PRs unmergeable, which is
how a check gets routed around. A weaker rule that is followed beats a stronger one that is not.

## The one decision that stops this being theatre

A check satisfiable by writing the word ACCEPT is theatre. So:

> **A structured token is the only thing that may CLEAR a blocker. The prose heuristic may only ADD
> one.**

That asymmetry does three things at once:

1. **Prose can never clear**, so the "write ACCEPT to get through" attack does not exist.
2. **The fragility of natural-language parsing is bounded to false alarms.** A reviewer who writes
   *"this is not a REJECT, but"* gets blocked and clears it by posting a token — wrong in the safe
   direction, and self-service to fix.
3. **Mode A is caught on PRs that have not adopted the convention at all**, including every PR open
   today. A token-only design would have to wait for adoption before it protected anything.

The heuristic is deliberately narrow: it tests the **first non-empty line** of a comment, with bold
markers stripped, against `^#{1,6}\s+.*\breview\b.*\bREJECT\b`. Validated against every comment on
PRs #90–#120 on 2026-09-01: **15 matches, 15 correct.** It catches all 13 real verdict headings and
correctly skips `## Fixer pass — Review92-B findings` and `## Fixer pass — Review109 findings` —
both of which quote the word REJECT in their bodies, and both of which a naive body-wide grep flags
as verdicts. That corpus is pinned in `scripts/test/merge-preflight.test.mjs`.

## Running it

```bash
node scripts/merge-preflight.mjs 119
```

Exit 0 = clear, 1 = blocked, **2 = could not determine** (no `gh`, no auth, no such PR). Exit 2 is
not a pass: a preflight that could not see is not a preflight that saw nothing wrong.

`--advisory` drops the two roster rules, and so drops all of Mode B. It is what the rollout workflow
runs while adoption is partial, and it is honestly weaker: `scripts/test/merge-preflight.test.mjs`
asserts, as a test rather than as a claim, that advisory mode **clears** both #98 and #109 at their
real merge instants.

Run it in two places, not one:

- **Before merging** — `--strict`. This is the merge question.
- **Before pushing to a PR branch you did not just create** — the `pr-open` rule is Mode C, and it
  is one call. Divergence is not liveness: `git rev-list --left-right --count` reports "0 behind /
  N ahead" for a freshly-merged branch exactly as it does for a live one.

## What this cannot catch

Stated plainly, because failing to state a mechanism's blind spots is the failure this whole
exercise exists to prevent.

- **A reviewer that posts ACCEPT without reviewing.** Nothing here reads the review's quality. The
  token records that a verdict was reached, never that it was earned.
- **An agent that simply does not run it.** Everything above is convention until branch protection
  lands. This is the largest hole by far, and it is the owner's to close.
- **A duplicated or invented reviewer name.** The roster is self-declared by the same identity that
  posts the verdicts, so one agent can satisfy a two-name roster. Under one GitHub account this is
  self-policing by construction; see step 4.
- **A verdict that arrives after a legitimate merge** — #92's second REJECT, 42 minutes late. A
  merge gate structurally cannot catch this. It needs a post-merge sweep over recently merged PRs,
  which is a different tool and is not built.
- **Labels and comments are removable by whoever can merge**, so a determined agent can clear its own
  blockers. This raises the cost of a bad merge from zero to deliberate; it does not make it
  impossible.
- **The quality of CI itself.** `ci-matches-head` proves a green run exists for this commit. It says
  nothing about what that run checked.

## Making this enforcement

These need the repository owner. An agent cannot set branch protection, and should not try.

1. **Require the check.** Settings → Branches → `protocol/main` → *Require status checks to pass
   before merging*, and add the context **`merge-preflight`**.
2. **Include administrators.** Tick *Do not allow bypassing the above settings* (`enforce_admins`).
   Without it, branch protection is bypassed by exactly the account that does the merging, and the
   policy reads as real while being advisory for the only identity that matters.
   **Backfill the PRs already open when you do this.** A required context that has *never* reported
   blocks exactly as hard as a red one, and a PR whose head SHA predates the workflow has no status
   and nothing scheduled to give it one. Each already-open PR needs one triggering event — a push, a
   comment carrying a token, or `gh workflow run merge-preflight.yml -f pr=<n>` — before it can
   merge. New PRs are unaffected.
3. **Switch the workflow from advisory to strict** once reviewers are emitting tokens: change
   `--advisory` to `--strict` in `.github/workflows/merge-preflight.yml`. Steps 1 and 2 are worth
   taking before this one — advisory already catches Modes A and C and stale CI.
4. **Decide on a second machine account.** It is the only way "two independent reviewers" becomes
   more than self-policing, and the only way GitHub's own `CHANGES_REQUESTED` becomes usable. Cost:
   a second identity to provision and hold a token for. Not urgent; not ignorable.

The `gh api` equivalents of steps 1 and 2, for the record, are in
`scripts/lib/merge-policy.json` → `enforcement`.

### The CI cost, so it is your decision and not a surprise

The workflow triggers on `issue_comment`, because a verdict arriving is the event it exists to
notice and a `pull_request` workflow does not re-run on a comment. That fires on **every** comment in
the repository. This repo ran out of Actions minutes for ~72 hours on 2026-08-29, so the job is
filtered to comments that could actually change the decision — ones containing `REVIEW-`, `REJECT` or
`ACCEPT` — which on a busy night is roughly a third of them rather than all. The job itself is
short: a checkout, a node setup and two `gh` calls, well under a minute. If even that is too much,
drop the `issue_comment` trigger entirely and accept that a status only refreshes on a push.

## The policy itself

Everything below is `scripts/lib/merge-policy.json`, verbatim. It is the single source of truth:
`scripts/merge-preflight.mjs` reads it, and `scripts/test/merge-preflight.test.mjs` asserts that this
block is byte-identical to that file, that the regex published here is the one the code runs, and
that every rule the evaluator can emit is declared here and vice versa. A rule cannot drift from its
documentation without a red test — which is the general form of what went wrong: the tracked
`docs/vault/auto-merge.md` still said merges land "once CI is green", unqualified, while every
correction lived in a machine-local memory file that no fresh clone, no other machine and no CI
check could ever read. **A gate nobody can read from a fresh clone is not an interlock.**

```json
{
  "version": 1,
  "why": "Four PRs (#92 #98 #107 #109) merged on 2026-09-01 across review verdicts that were never addressed. This file is the single machine-readable source of truth for when a PR may merge. scripts/merge-preflight.mjs reads it; docs/reviews/MERGE-POLICY.md embeds it verbatim and a test asserts the two are byte-identical, so the prose humans read cannot drift from the rules the program enforces.",
  "tokens": {
    "roster": {
      "form": "<!-- REVIEW-ROSTER reviewers=Name1,Name2 -->",
      "postedBy": "the orchestrator, when it spawns reviewers",
      "purpose": "makes 'assigned but not yet posted' a computable state. The roster is the denominator; verdicts are the numerator."
    },
    "verdict": {
      "form": "<!-- REVIEW-VERDICT reviewer=Name verdict=ACCEPT|REJECT -->",
      "postedBy": "each reviewer, inside its existing '## Adversarial review — VERDICT' comment",
      "purpose": "the ONLY thing that may CLEAR a PR. Prose can never clear."
    }
  },
  "invariants": [
    "A structured token is the only thing that may CLEAR a blocker. Prose is never sufficient, so 'satisfy the check by writing the word ACCEPT' is impossible by construction.",
    "The legacy prose heuristic may only ADD a blocker, never remove one. Its fragility is therefore bounded to false alarms, which a reviewer clears by posting a token.",
    "The latest verdict per reviewer wins. Verdicts arrive out of band and a REJECT must be clearable, or no fixer pass could ever land.",
    "The reviewer count is whatever the roster declares. It is never a hardcoded N: most PRs get one review, and a gate demanding two would be routed around."
  ],
  "rules": [
    {
      "id": "pr-open",
      "modes": [
        "advisory",
        "strict"
      ],
      "title": "the PR must be OPEN",
      "blocksWhen": "state is MERGED or CLOSED, or the PR is a draft",
      "why": "Mode C. A freshly-merged branch is indistinguishable from a live one by git divergence -- 'git rev-list --left-right --count' reports 0 behind / N ahead for both. GitHub reopens no PR on push, creates no CI run, and still accepts comments onto the closed PR, so the work looks landed and is silently stranded. This cost PR #107's entire fixer pass on 2026-09-01."
    },
    {
      "id": "no-standing-reject",
      "modes": [
        "advisory",
        "strict"
      ],
      "title": "no reviewer's latest verdict may be REJECT",
      "blocksWhen": "any reviewer's latest REVIEW-VERDICT token is REJECT, or a legacy prose REJECT heading is not followed by a later ACCEPT token",
      "why": "Mode A. #107 merged 8 minutes after a REJECT was standing in writing on the PR; #92 merged 29 minutes after one. This is a policy failure, not a visibility one: the standing self-merge rule had no clause about an open REJECT, so an agent following it as written merges correctly and lands a HIGH."
    },
    {
      "id": "ci-matches-head",
      "modes": [
        "advisory",
        "strict"
      ],
      "title": "a successful CI run must exist for THIS head SHA",
      "blocksWhen": "no completed successful workflow run has headSha equal to the PR's headRefOid",
      "why": "'gh pr checks' reports the runs attached to a PR without surfacing which SHA they belong to, and returned green for #107 from a run belonging to the previous head. Match headSha yourself: gh run list --branch <b> --json headSha,status,conclusion."
    },
    {
      "id": "roster-declared",
      "modes": [
        "strict"
      ],
      "title": "a review roster must have been declared",
      "blocksWhen": "no REVIEW-ROSTER token appears on the PR",
      "why": "Mode B, half one. Without a declared roster there is no denominator, so 'nobody has objected' and 'nobody has looked' are the same observation. #109 merged 5.5 minutes before its review existed."
    },
    {
      "id": "roster-resolved",
      "modes": [
        "strict"
      ],
      "title": "every rostered reviewer must have posted a verdict",
      "blocksWhen": "any name in the roster has no REVIEW-VERDICT token",
      "why": "Mode B, half two. #98 merged at 22:30:54Z holding exactly one verdict -- an ACCEPT from reviewer 1 of 2 -- and its reviewer-2 REJECT posted 25 seconds later. A rule of 'at least one verdict and it is not REJECT' passes #98 and lands its finding. The property is not 'a review exists'; it is 'the declared complement has reported and every report is resolved'."
    }
  ],
  "legacyProseHeuristic": {
    "pattern": "^#{1,6}\\s+.*\\breview\\b.*\\bREJECT\\b",
    "appliedTo": "the first non-empty line of a comment, with markdown bold markers stripped",
    "direction": "block-only",
    "evidence": "Validated against every comment on PRs #90-#120 on 2026-09-01: 15 matches, 15 correct. It catches all 13 real verdict headings and correctly skips '## Fixer pass -- Review92-B findings' and '## Fixer pass -- Review109 findings', both of which quote the word REJECT in their bodies and which a naive body grep flags as verdicts."
  },
  "enforcement": {
    "today": "convention. scripts/merge-preflight.mjs is a preflight an orchestrator runs; nothing compels it to.",
    "toBecomeEnforcement": "branch protection on protocol/main requiring the 'merge-preflight' status context, with enforce_admins true. That needs the repository owner; an agent cannot set it.",
    "nativeReviewsUnavailable": "The whole swarm is one GitHub identity (SlumperSan) and every PR is authored by it, so GitHub refuses approve/request-changes on its own PRs: reviewDecision is permanently null and CHANGES_REQUESTED -- the state branch protection natively blocks on -- is unreachable. Zero native reviews exist in this repo's history. A second machine account is the only path to natively-enforced reviewer independence, and that is the owner's call.",
    "requiredStatusContext": "merge-preflight",
    "ghApi": [
      "gh api -X PUT repos/SlumperSan/agent-governed-vaults/branches/protocol%2Fmain/protection/required_status_checks -f strict=true -f 'contexts[]=merge-preflight'",
      "gh api -X POST repos/SlumperSan/agent-governed-vaults/branches/protocol%2Fmain/protection/enforce_admins"
    ]
  }
}
```

[#92]: https://github.com/SlumperSan/agent-governed-vaults/pull/92
[#98]: https://github.com/SlumperSan/agent-governed-vaults/pull/98
[#107]: https://github.com/SlumperSan/agent-governed-vaults/pull/107
[#109]: https://github.com/SlumperSan/agent-governed-vaults/pull/109
[#120]: https://github.com/SlumperSan/agent-governed-vaults/pull/120
