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

It was **five distinct failure modes, and a defence against one is useless against the others.**

| mode | what happened | the PRs | the rule that answers it |
|---|---|---|---|
| **A — policy** | merged over a REJECT already standing, in writing, on the PR | #107 by 8 min, #92 by 29 min | `no-standing-reject` |
| **B — race** | the review lost a race it could not see it was in | #98's REJECT posted **25 s** after the merge; #109's 5.5 min after, so the PR merged before its verdict existed | `roster-declared` + `roster-resolved` |
| **C — orientation** | pushed to a branch whose PR had already merged | #107's fixer pass, rescued by hand as [#120] | `pr-open` |
| **D — invisibility** | the reviewed content was replaced *after* a correct verdict | a keep-ours resolution on #117 would have re-introduced the list #121 exists to abolish | `verdict-covers-head` |
| **E — staleness** | the *base* moved under a verdict whose head never did | #119's valid ACCEPT was falsified by #121 merging, with its own branch untouched | `base-current` |

Three consequences worth stating plainly, because each one defeats an obvious design:

- **An in-flight marker cannot catch Mode A.** The verdict was already there; it was overridden.
- **A REJECT-parser cannot catch Mode B.** For #98 there was nothing to parse — the gap was 25
  seconds.
- **An interval-based check — "did a merge race ahead of a posted verdict" — cannot catch #109 at
  all**, because no verdict existed to measure from. A check built to that wording would have
  passed the worst case and failed its own purpose.

So the enforceable property is not an interval. It is a conjunction: **the declared complement of
reviewers has reported, and every report is resolved, on the content that would actually merge** —
plus CI green on *this* head SHA, plus the PR still being open.

### Mode D is a different kind of thing, and it is worth stating separately

A, B and C are all about **when** a merge happens relative to a review. **D is about what a review
can see at all.** A conflict resolution is an edit nobody reviews: a PR diff shows the merged
*result* and never the *choice*. So the reviewer can be competent, the review thorough and the
verdict correct, and a defect still enters afterwards and ships under that verdict.

The live instance, 2026-09-01: #121 replaced a hand-written `liveSignals` array with
`signalNamesOnDisk()` — abolishing a hand-maintained list was the entire point of the PR — while
#117 had independently added an entry to that array. A keep-ours resolution re-introduces exactly
the list #121 exists to abolish, inside a PR whose own subject is unrelated to it. It was caught only
because a verifier ran `merge-tree` on a branch it did not own and read the *conflict* rather than
the diff.

`verdict-covers-head` detects that **the reviewed content is no longer the content that would
merge** — the automatable half. It cannot judge whether a resolution was *correct*; that is a
re-review, and no check can do it. Two related traps, both seen the same night:

- **"The conflict is only `.gas-snapshot`, so regenerate it" is not a general strategy.** #115 and
  #117 conflicted on real content. Any mechanism assuming conflicts are mechanical will be wrong on
  exactly the PRs where the stakes are highest.
- **A resolution's premise can be stale even when the resolution is right.** #117's correct
  resolution relies on `readdir` finding a signal file; if a rebase moved it, `readdir` finds
  nothing, the coverage test still passes because it asserts `size >= 8` and eight *other* signals
  satisfy it, and the addition is uncovered again with a green suite.

**The cheap convention that makes the choice reviewable at all** — and it is a convention, not a
gate, because it detects nothing by itself: **when a PR resolves a non-trivial conflict, its body
should state, per conflicted file, which side was taken and why.** That converts an invisible edit
into a claim someone can check.

### Mode E is Mode D's mirror, and it defeats every rule keyed to the PR

Mode D is *"the content changed under the verdict"*. Mode E is *"the world the content describes
changed under it"*. A PR can carry a **genuine, current, unstale ACCEPT on an unmoved head** and
still be wrong to merge.

The live instance, 2026-09-01: #119 held a valid ACCEPT against `d9293c23`. #121 then merged and
inverted the canary tier semantics in `sinks.mjs`, making two sentences #119 *adds* false against
merged `main`. Everything that a PR-keyed check can see stayed correct — `merge-tree` clean (they
touch different files), CI green on the reviewed head, the verdict untouched, **the branch head never
moved**. `verdict-covers-head` cannot see it, because nothing about the PR changed.

`base-current` reads `behind_by` from the compare API — `gh pr view`'s `mergeStateStatus` only
reports `BEHIND` once the repository *already* requires up-to-date branches, which is the setting
this argues for, so it cannot be the detector for its own absence. It fires only once the PR has been
reviewed at all: with no review the other rules already block, and reporting base drift there would
be noise.

**"Reviewed at all" deliberately includes a *prose* verdict of either kind**, and that widening was
forced by running the tool rather than reasoning about it. The first version gated on a verdict
*token*, and against **#112** — an ACCEPTed PR **43 commits behind `main`**, sitting on the owner's
desk to merge — it reported **CLEAR**, because #112's ACCEPT is prose and a token-only gate cannot
see it. That is precisely the case Mode E exists for, missed by the rule written to catch it. Reading
a prose ACCEPT to *raise* a blocker keeps the asymmetry intact: prose still never clears anything.

**The enforcement half is a branch-protection setting, not more script.** "Require branches to be up
to date before merging" (`strict=true` on `required_status_checks`) makes every advance of
`protocol/main` force each open PR to re-integrate — which moves its head, which trips
`verdict-covers-head`, which forces a re-verdict. The two rules compose into the property you
actually want. Its cost is a rebase treadmill proportional to how often the base moves, which here is
often, so it is a deliberate decision — § Making this enforcement, step 1.

**What it cannot tell you is whether the moved base actually falsifies anything.** That is a re-read.
`base-current` only establishes that nobody has looked since the ground shifted.

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

...and a newer one with `verdict=ACCEPT` clears it once the findings are closed. The latest verdict
per reviewer wins; verdicts arrive out of band (#92 collected a second REJECT 42 minutes after its
merge) and a REJECT must be clearable, or no fixer pass could ever land.

**A fixer pass does not clear a verdict**, and this is the one workflow change beyond the tokens
themselves, so it is worth being blunt about. Posting "all findings addressed" is a claim, not a
verdict; only the *reviewer* clears one. And because a fixer's commits move the head,
`verdict-covers-head` requires that token to be posted **after** the fix lands — a verdict written
before the last commit graded content that is no longer what would merge.

The practical consequence, seen live on #106 while this was being written: a PR with a standing
REJECT and a fixer mid-pass shows **two** blockers, and only a reviewer can clear either. That is
the discipline being argued for, not a malfunction — but a rule that mysteriously blocks everything
gets routed around, so it belongs in `docs/SWARM.md` §3 where reviewers actually read it, and it is
there.

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

`--advisory` drops the two roster rules, and so drops all of Mode B. It keeps everything else,
including Mode D — that rule needs only a verdict token, which is a reviewer's own act rather than an
orchestrator convention. It is what the rollout workflow
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
- **Whether a conflict resolution was CORRECT.** `verdict-covers-head` catches that the reviewed
  content changed; judging the change is a re-review, and no check can do it. The per-file "which
  side and why" note in the PR body is the only thing that makes the choice visible, and it is a
  convention that detects nothing on its own.
- **A verdict that graded an older SHA than the one it was posted after.** Mode D is inferred from
  timestamps — the head commit's `committedDate` against the verdict comment's `createdAt` — so a
  reviewer who read stale content and posted late looks identical to one who read the head. Binding
  a SHA into the token would close this; it was rejected because an optional attribute nobody fills
  in is theatre, and a mandatory one changes the reviewer workflow a second time.
- **Whether a moved base actually falsifies the PR.** `base-current` establishes only that nobody has
  looked since the ground shifted. Deciding whether #121 broke #119's sentences is a re-read.
- **The quality of CI itself.** `ci-matches-head` proves a green run exists for this commit. It says
  nothing about what that run checked — and note that a green run on an unmoved head was *also*
  computed against the old base, so Mode E degrades that evidence too.
- **A red posted by a `pull_request`-triggered run does not clear itself when CI later goes green.**
  Both workflows start on the same push, so the preflight evaluates while CI is still `in_progress`,
  reports `ci-matches-head` correctly — CI genuinely is not green yet — and posts red. Nothing
  re-runs the preflight when CI completes: there is no `workflow_run` / `check_suite` trigger, so
  the status stays stale until an `issue_comment` or `workflow_dispatch` run re-evaluates it. That
  is a *missing trigger*, not a wrong answer, and it is why a pushed head can sit red beside a green
  CI. It is separate from the self-inclusion defect that `runsForHead` now closes, and it survives
  that fix. **Read a red here before assuming it, especially after the `--strict` flip.**

## Making this enforcement

These need the repository owner. An agent cannot set branch protection, and should not try.

1. **Require the check.** Settings → Branches → `protocol/main` → *Require status checks to pass
   before merging*, and add the context **`merge-preflight`**. **Also tick *Require branches to be up
   to date before merging*** in the same box — that one is the enforcement half of Mode E, and it is
   easy to miss because it looks like a formality. Without it, a PR keeps a stale-but-unmoved verdict
   against a `main` that has moved on; with it, every advance of `main` forces a re-integration and
   therefore a re-verdict. Its cost is a rebase treadmill proportional to how often `main` moves,
   which in this swarm is often — so it is a real trade, not a default.
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
  "why": "Four PRs (#92 #98 #107 #109) merged on 2026-09-01 across review verdicts that were never addressed, and a fifth (#121/#117) showed that a conflict resolution can introduce a defect no review ever sees. This file is the single machine-readable source of truth for when a PR may merge. scripts/merge-preflight.mjs reads it; docs/reviews/MERGE-POLICY.md embeds it verbatim and a test asserts the two are byte-identical, so the prose humans read cannot drift from the rules the program enforces.",
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
    "The reviewer count is whatever the roster declares. It is never a hardcoded N: most PRs get one review, and a gate demanding two would be routed around.",
    "A verdict grades content, not a pull request. If the head moves after a verdict is posted, what merges is not what was reviewed -- and the dangerous case is a conflict resolution, because the diff shows the result and never the choice.",
    "A verdict is valid only against the base it was computed on. A PR can carry a genuine, current, unstale ACCEPT on an unmoved head and still be wrong to merge, because the base moved beneath it."
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
      "id": "verdict-covers-head",
      "modes": [
        "advisory",
        "strict"
      ],
      "title": "every verdict must post-date the head commit",
      "blocksWhen": "any reviewer's latest verdict is older than the PR's head commit",
      "why": "Mode D. Modes A, B and C are all about WHEN a merge happens relative to a review; D is about WHAT A REVIEW CAN SEE AT ALL. A conflict resolution is an edit nobody reviews -- a PR diff shows the merged RESULT and never the CHOICE -- so a defect can enter after a correct verdict and ship under it. Seen live on 2026-09-01: a keep-ours resolution on #117 would have re-introduced the hand-maintained signal list that #121 exists to abolish, inside a PR whose own subject was unrelated, and it was caught only because a verifier ran merge-tree on a branch it did not own and read the conflict rather than the diff. This rule detects that the reviewed content is no longer the content that would merge; it cannot judge whether the resolution was CORRECT, which is a re-review and not automatable. Runs in BOTH modes, unlike the roster rules: it needs only a verdict token, which is the reviewer's own act rather than an orchestrator convention."
    },
    {
      "id": "ci-matches-head",
      "modes": [
        "advisory",
        "strict"
      ],
      "title": "a successful CI run must exist for THIS head SHA",
      "blocksWhen": "no completed successful workflow run OTHER THAN THIS GATE'S OWN has headSha equal to the PR's headRefOid",
      "why": "'gh pr checks' reports the runs attached to a PR without surfacing which SHA they belong to, and returned green for #107 from a run belonging to the previous head. Match headSha yourself: gh run list --branch <b> --json headSha,status,conclusion,workflowName. The gate's own runs are then excluded by workflowName, because merge-preflight.mjs lists runs by branch with no --workflow filter and a pull_request-triggered preflight run carries the PR head's SHA: it blocked on its own in_progress run, and -- the permissive half -- counted its own COMPLETED run as a green, because a run that succeeds at posting a red commit status still concludes 'success'. That one miscount defeated this rule's catch-all, so a head with NO CI would have passed the rule named for matching CI to the head. Latent while ci.yml had a bare pull_request: trigger and no paths: filter; armed by any routine 'skip CI for docs-only changes'. After the exclusion this rule no longer depends on ci.yml's trigger config at all."
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
    },
    {
      "id": "base-current",
      "modes": [
        "advisory",
        "strict"
      ],
      "title": "a verdict is only valid against the base it was computed on",
      "blocksWhen": "the branch is behind its base branch and the PR has been reviewed at all (a verdict token, or a prose verdict heading of either kind)",
      "why": "Mode E, and Mode D's mirror: D is 'the content changed under the verdict', E is 'the world the content describes changed under it'. Seen live on 2026-09-01: #119 held a valid ACCEPT against d9293c23, then #121 merged and inverted the canary tier semantics in sinks.mjs, making two sentences #119 ADDS false against merged main -- while merge-tree stayed clean (they touch different files), CI stayed green on the reviewed head, and the verdict stayed untouched. The branch head never moved, so verdict-covers-head cannot see it and no rule keyed to the PR alone can. Read from the compare API's behind_by, because gh pr view's mergeStateStatus only reports BEHIND once the repository already requires up-to-date branches -- the very setting this argues for. It detects that a verdict was computed against a base that no longer exists; it cannot tell you WHETHER the moved base falsifies anything, which is a re-read. The enforcement half is GitHub's 'Require branches to be up to date before merging' (strict=true on required_status_checks), which makes every base advance force a re-integration and therefore a re-verdict."
    }
  ],
  "legacyProseHeuristic": {
    "pattern": "^#{1,6}\\s+.*\\breview\\b.*\\bREJECT\\b",
    "appliedTo": "the first non-empty line of a comment, with markdown bold markers stripped",
    "direction": "block-only",
    "evidence": "Validated against every comment on PRs #90-#120 on 2026-09-01: 15 matches, 15 correct. It catches all 13 real verdict headings and correctly skips '## Fixer pass -- Review92-B findings' and '## Fixer pass -- Review109 findings', both of which quote the word REJECT in their bodies and which a naive body grep flags as verdicts.",
    "verdictPattern": "^#{1,6}\\s+.*\\breview\\b.*\\b(?:REJECT|ACCEPT)\\b",
    "verdictPatternPurpose": "The same heading shape but either verdict. It NEVER clears -- it answers only 'has anyone reviewed this at all', which base-current needs as its denominator on PRs predating the token, so raising a blocker from it is still block-only. Added after running the tool against #112: an ACCEPTed PR 43 commits behind main reported CLEAR, because its ACCEPT is prose and a token-only gate cannot see it -- the exact case Mode E exists for, missed by the rule meant to catch it."
  },
  "enforcement": {
    "today": "convention. scripts/merge-preflight.mjs is a preflight an orchestrator runs; nothing compels it to.",
    "toBecomeEnforcement": "branch protection on protocol/main requiring the 'merge-preflight' status context, with enforce_admins true. That needs the repository owner; an agent cannot set it.",
    "nativeReviewsUnavailable": "The whole swarm is one GitHub identity (SlumperSan) and every PR is authored by it, so GitHub refuses approve/request-changes on its own PRs: reviewDecision is permanently null and CHANGES_REQUESTED -- the state branch protection natively blocks on -- is unreachable. Zero native reviews exist in this repo's history. A second machine account is the only path to natively-enforced reviewer independence, and that is the owner's call.",
    "requiredStatusContext": "merge-preflight",
    "ghApi": [
      "gh api -X PUT repos/SlumperSan/agent-governed-vaults/branches/protocol%2Fmain/protection/required_status_checks -f strict=true -f 'contexts[]=merge-preflight'",
      "gh api -X POST repos/SlumperSan/agent-governed-vaults/branches/protocol%2Fmain/protection/enforce_admins"
    ],
    "requireUpToDateBranches": "The 'strict=true' already present in the gh api line below IS GitHub's 'Require branches to be up to date before merging', and it is the enforcement half of Mode E: it makes every advance of protocol/main force each open PR to re-integrate, which moves its head and therefore trips verdict-covers-head, forcing a re-verdict. Its cost is a rebase treadmill proportional to how often the base moves, which in this swarm is often -- so it is a deliberate owner decision, not a default. Without it, base-current still reports the drift; nothing compels anyone to act on it."
  },
  "conventions": {
    "statePerFileResolutions": "When a PR resolves a non-trivial conflict, the PR body should state, per conflicted file, WHICH SIDE was taken and WHY. This detects nothing by itself. It is the only thing that makes an otherwise invisible edit into a claim a reviewer can check, and it is a CONVENTION -- do not describe it as a gate. Note also that 'the conflict is only .gas-snapshot, so regenerate it' is not a general strategy: #115 and #117 conflicted on real content."
  }
}
```

[#92]: https://github.com/SlumperSan/agent-governed-vaults/pull/92
[#98]: https://github.com/SlumperSan/agent-governed-vaults/pull/98
[#107]: https://github.com/SlumperSan/agent-governed-vaults/pull/107
[#109]: https://github.com/SlumperSan/agent-governed-vaults/pull/109
[#120]: https://github.com/SlumperSan/agent-governed-vaults/pull/120
