# Auto-Merge

Remediation work flows to `protocol/main` through per-finding PRs, rather than accumulating on a single long-lived branch. **OPERATING CONVENTION.**

> **THIS FILE IS AUTHORITATIVE.** An agent's machine-local memory may hold a copy of these rules for convenience; that copy is a convenience, not the source. When the two disagree, this file wins, and the memory gets corrected to match. The reverse arrangement is what produced the 2026-09-01 incident below: the corrected rule existed only outside the repository, so it reached no fresh clone, no human reading the tree, and no session on another machine — while this file went on asserting the rule that had already failed.

## When a PR is ready to merge

**All four must hold. "Green CI" alone is not ready.**

1. **CI is green *for your own head commit*.** See [Verifying CI](#verifying-ci-green-means-green-for-your-commit) — this is not the same as a green check summary.
2. **No open REJECT verdict on the PR.** Read the PR's comments immediately before merging.
3. **No review assigned and unposted.** A review in flight is not an absent objection.
4. **The change is not one of the [named human-merge exceptions](#never-self-merge-these).**

## Superseded: "merge once CI is green"

> **SUPERSEDED 2026-09-01.** Until this date, this file said remediation PRs "merge once CI is green", unqualified, and that is the entire rule an agent had. It has no clause about a standing REJECT, so **an agent following it correctly landed a HIGH finding on `protocol/main`.** That is the worst shape a rule can have: compliance produces the failure. The four conditions above replace it. The original rationale for per-finding PRs (below) is unchanged and still correct — it was the *merge condition* that was wrong, not the branching model.

### The incident that changed it (2026-09-01)

Four PRs merged across their own review verdicts in a single evening, putting two HIGH findings on `protocol/main`. Timestamps from `gh pr view --json mergedAt,comments`:

| PR | merged | REJECT posted | gap |
|---|---|---|---|
| #107 | 22:43:37Z | 22:35:29Z | **8 min BEFORE merge** |
| #92 | 22:45:01Z | 22:16:21Z | **29 min BEFORE merge** |
| #98 | 22:30:54Z | 22:31:19Z | 25 s after |
| #109 | 22:43:44Z | 22:49:14Z | 5.5 min after |
| #92 | (as above) | 23:27:37Z | 42 min after |

Two distinct failure modes, which need two distinct guards — neither one catches the other:

- **Mode A — a REJECT was already standing (#107, #92).** Not a visibility problem: the verdict was on the PR, in writing, for 8 and 29 minutes. This is a policy failure, fixed by condition 2 above.
- **Mode B — the review lost a race it could not see (#98, #109, #92's second).** A PR whose review is in flight is indistinguishable from one nobody objected to. Fixed by condition 3 above. **And when a verdict arrives after a merge, read it and open a follow-up** — a merge does not settle a review.

#98's 25-second gap is the tell that both modes are the same race seen from either side, and that the merge step was simply not reading the PR.

## Never self-merge these

Hand them to Michael with numbered, copy-pasteable steps ([[ask-with-links-and-steps]]). CI passing is not the question being asked in any of these cases.

1. **A `viem` or `@noble/*` bump.** The signing path. Needs human review of the dependency itself, not of green CI.
2. **Any new runtime dependency.** Needs an explicit decision, not a merge.
3. **A change to `.github/workflows/` action pins.** Generalising the reason: *the correctness of a SHA pin is not a property CI can certify, because CI is the thing being pinned.* A substituted action that runs successfully and exfiltrates on the side produces exactly the green board a correct one does.

A **policy change to this file** is a fourth case in practice: it needs a reader who is not its author.

## Verifying CI: "green" means green *for your commit*

`gh pr checks <n>` lists the runs attached to a PR **without surfacing their commit SHA**. Right after a push it can report a full green board belonging to the *previous* head while no run exists for your new commit at all. This was found on 2026-09-01 by a fixer who would otherwise have self-merged on someone else's evidence.

```bash
gh run list --repo <owner>/<repo> --branch <branch> --limit 5 --json headSha,status,conclusion
```

Match `headSha` against your own `HEAD` yourself. The standing rule that *a red CI is evidence* only holds when the run belongs to your commit.

## Before pushing to a PR branch, check the PR's STATE

Same root cause as above, one step earlier, and **no merge-time guard can catch it** — it fires before a merge is ever attempted.

On 2026-09-01 a fixer re-fetched, saw `git rev-list --left-right --count` report `0 behind / 3 ahead`, and pushed — into a PR that had merged 8 minutes earlier. **Divergence is not liveness: a freshly-merged branch is indistinguishable from a live one.** GitHub does not reopen a merged PR on push, creates no CI run for the new commits, and accepts review comments onto the closed PR. The work looks landed and is silently stranded.

```bash
gh pr view <n> --json state
```

If it is `MERGED`, open a follow-up PR from the same branch instead of pushing into the closed one.

The general defect behind all three incidents, in one sentence: **every step in the pipeline trusted a local view of the branch, and no step asked GitHub what state the PR was actually in.**

## Why per-finding PRs (unchanged)

The Phase-2 remediation produced a steady stream of focused, single-finding fixes (C-1, H-8, M-15, C-6 re-verification, ChainlinkOracle, plus the disposition sweep). Landing each one as its own PR to `protocol/main`, instead of batching, keeps the live branch continuously in the best-known state, keeps each diff reviewable in isolation, and means the "what is true right now" snapshot ([[current-state]]) is always the tip of `protocol/main`, not a branch waiting to be integrated.

Each finding gets its own `security/*` branch and PR; CI runs the full battery (`forge fmt --check`, `forge build --sizes`, `forge test`, `forge snapshot --check`, backend tests); on green **and the other three conditions above**, the PR merges to `protocol/main`. Examples in history: #43 (C-1), #44 (H-8), #45 (M-15), #46 (dispositions), #47 (C-6 re-verification), #49 (ChainlinkOracle).

This pairs with [[continuous-autonomous-mode]]: parallel workers each own a finding, and the merge queue serializes their output onto the live branch without a human gate per PR. **Caveat, learned the hard way:** the worktree is shared across concurrent sessions, so `git add -A` is banned here; it once swept another sprint's contracts into an unrelated PR. Stage explicitly.

Because the fixes are additive and gated by CI, gate 8 ("all CI gates green at the candidate ref") stays GO throughout, though a green board certifies the gates *ran*, not that the protocol is *safe* ([[launch-readiness-gates]]).

## Links

- Read first: `docs/SWARM.md` §8 (Git discipline) points here.
- Operating model: [[continuous-autonomous-mode]] · [[decisions-index]]
- Where the merges land: [[current-state]] · [[prs-and-issues]] · [[remediation-history]]
- Gate context: [[launch-readiness-gates]] · [[audit-reverification]]
