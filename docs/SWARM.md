# SWARM.md — the contract every parallel agent reads first

This is the shared spec for parallel development on this repo. Read it before writing a line.

It exists because parallel agents without a shared contract produce *divergent* output — five
different naming conventions, five different opinions about what "done" means, and a merge that
costs more than the parallelism saved. The method is borrowed from Bun's Zig→Rust rewrite, which
moved 535k lines with 64 concurrent agents in 11 days: **the first three hours went into writing the
porting guide, not into porting.** That guide is what made the other 64 agents agree.

---

## 0. Start in the vault, end in the vault

**Every sprint opens by onboarding from Obsidian ("ob") and closes by updating it.** Not optional,
and not a nicety — the vault is the project's memory. The repo records what the code does; the vault
records *why*, what was decided, what was tried and rejected, and what is blocked on a human. A
sprint that skips the read re-derives context that already exists; a sprint that skips the write
makes the next sprint pay for it again.

**Vault root:** `C:\Users\Micha\desktop\Obsidian Vault\Agent-Governed Vaults\`

### Onboarding — first thing, before any code

Read, in this order, stopping once you have what your task needs:

1. `Project State.md` — where the build actually stands.
2. The most recent `Session Handoff *.md` — what the last session did and left open.
3. `Key Decisions.md` and `Security Findings.md` — decisions and findings you must not re-litigate.
4. Whichever of `Business/` or `Working Agreement.md` your task touches.

Then `docs/NOW.md` and `npm run cc` for the live, computed state. The vault carries the reasoning;
`cc` carries the facts. Where they disagree the facts win, and the vault is what needs fixing.

### Closeout — last thing, after the gate passes

Update the vault before you report done. At minimum:

- `Project State.md` — what changed, and what is now true that was not before.
- Anything your work invalidated. A stale vault note is worse than a missing one, because it will be
  believed. If you found that a recorded number or claim is wrong, correct it and say so explicitly
  rather than quietly overwriting it.
- New findings, decisions and dead ends worth not repeating — including what you deliberately did
  **not** do, and why. Rejected approaches are among the most valuable things in the vault.

Convert relative dates to absolute. Link related notes with `[[wikilinks]]`.

The shorthand for this is **"update ob"**.

---

## 0.5 Route the model to the task

Every agent runs on a model and an effort level, and both are choices. Running the strongest model
at the highest effort on mechanical work is not "being careful" — it is slower and more expensive
for an identical result. Running a cheap model on a permanent, irreversible decision is the opposite
mistake, and far worse. Route deliberately.

| Tier | Use it for | Effort |
|---|---|---|
| **Haiku** | Mechanical and verifiable: sweeps, greps, collation, renames, link fixes, formatting, scaffolding from a template, gathering data for someone else to judge. | low |
| **Sonnet** | Implementation against a clear spec where tests are the oracle: components, docs, straightforward refactors, test writing. | medium |
| **Fable** | Writing- and judgement-heavy work with no single correct answer: charters, strategy, market and partner analysis, comms, positioning. | medium–high |
| **Opus** | Anything where a wrong answer is permanent or expensive: security review, contract changes, adversarial verification, merge conflicts in security code, architecture decisions, launch-parameter calls. | high–max |

**The one rule that is not a preference: never route security-critical judgment below the top tier.**
These contracts are immutable. A cheap wrong answer about `VaultCore` cannot be patched later, and
the saving is measured in cents against funds that cannot be recovered.

Two heuristics that settle most cases:

- **Ask what a wrong answer costs.** Cheap and instantly visible (a broken link, a failed build)
  routes down. Permanent, silent, or financial routes up.
- **Ask whether the task has a checkable oracle.** If tests, a compiler, or a schema will catch a
  mistake, a smaller model is safe because the mistake cannot survive. If the only check is
  judgement, pay for judgement.

Within one workflow, mix tiers rather than picking one for the whole run: a Haiku pass to gather
and normalize, Sonnet to implement, Opus to adversarially review. The review stage is the last place
to economize — it exists precisely to catch what the implementer got wrong.

---

## 0.7 Departments collaborate — check before you produce

Departments are not silos. Two failures come from treating them as such: **double work** (two
departments independently write the same analysis) and **information leakage** (one department
ships a claim another department already knows is false).

The second is the dangerous one. Marketing writing "zero capital cost to the operator" is not a
copy error — Finance has the number, Development knows the contract enforces it, and Legal knows
that claim is exactly the kind that attracts a regulator. A claim is only as good as the department
best placed to check it.

### Before you produce, read what already exists

The Obsidian vault's `Business/` tree is the shared surface, and `npm run cc` lists every
department's notes with how recently each changed. Read the neighbouring departments' output before
writing yours. If another department has already answered your question, cite it — do not
re-derive it, and do not quietly contradict it. If you believe they are wrong, say so explicitly
and name the note, so the disagreement is visible rather than buried in two conflicting documents.

### Who checks what

Route an artifact through the departments that can actually falsify it:

| Artifact | Must be checked by | For what |
|---|---|---|
| Anything public-facing | **Legal** | securities / CIS recharacterization, and every claim needing counsel sign-off |
| Anything claiming a capability | **Development** | does the feature exist, on which network, and is it in the launch scope |
| Anything with a number in it | **Finance** | is the number derived from the code, or asserted |
| Anything promising a response | **Operations** | can a one-to-two person rotation actually honour it |
| Anything naming a counterparty | **BD** | is the relationship real, and is the claim about them defensible |
| Anything a user will read in-product | **Design** | is it legible under stress, and accessible |

This is the same idea as the review pattern in section 3, applied across departments instead of
within one: the producer does not get to be the only judge.

### Say what you need, do not invent it

When your work needs something another department owns — a number, a legal position, a statement
about what the code does — **ask for it in your report rather than assuming it.** An assumed number
that turns out wrong propagates into every document that cites it. Explicitly listing what you took
from where makes the dependency visible and cheap to correct.

---

## 1. The unit of work

**One agent owns one module.** Not one feature spanning six files — one file, or one tightly-bounded
set. Ownership is exclusive for the life of the task: if you need to change a file another agent
owns, say so in your report rather than changing it.

Work is divvied by module boundary precisely so that merges are trivial. A conflict means the
decomposition was wrong, not that the merge was unlucky.

## 2. The work queue is mechanical, never invented

Bun used compiler errors: 16,000 of them, grouped by crate, handed to 64 fixers. The queue was
machine-generated, unambiguous, and finite, so no agent ever had to guess what to do next.

Our equivalents, in order of preference:

1. **`npm run gate` failures** — the CI mirror. Unambiguous, fast, and authoritative.
2. **Slither output** — `cd contracts && slither . --filter-paths "^lib/|^test/|^script/" --json -`.
   312 results today, grouped by detector. Advisory in CI, which means nobody has triaged them.
3. **`forge build --sizes` margins** — EIP-170 headroom is the binding constraint on several
   deferred features. A byte freed is a feature unblocked.
4. **Named findings** in `docs/LAUNCH-READINESS.md` and `docs/NOW.md`.

If you find yourself inventing work, stop: pick from a queue instead.

## 3. The review pattern: 1 implementer → 2 adversarial reviewers → 1 fixer

This is not optional and it is not a formality. Bun caught three real bugs this way that would
otherwise have shipped — a use-after-free from a premature `Box` drop, a `trunc()` that needed to be
`floor()` for negative values, and an eager `unwrap_or()` that panicked where a closure was intended.
All three passed the implementer's own review.

Rules that make it work:

- **Reviewers see the diff, not the plan.** They are told to *find the way it is wrong*, not to
  assess whether it seems reasonable. A reviewer who reports "looks good" has not done the job.
- **Reviewers are independent.** They do not see each other's verdicts.
- **The burden of proof is on the change.** A reviewer who cannot convince themselves the change is
  correct votes to reject. Unverified is not the same as correct.
- **The fixer is a separate step.** The implementer does not grade their own homework.

### Say the verdict in a form a program can read

On 2026-09-01 four PRs merged across REJECT verdicts nobody had addressed, because a verdict was
prose in a comment and `gh pr merge` does not read comments. So the verdict is now also a token:

- **The orchestrator, when it spawns reviewers**, posts `<!-- REVIEW-ROSTER reviewers=A,B -->`.
  This is what makes "a review is still running" visible — without it, *nobody objected* and *nobody
  looked* are the same observation, which is how one PR merged five minutes before its verdict
  existed.
- **Each reviewer**, inside its existing `## Adversarial review — VERDICT` comment, posts
  `<!-- REVIEW-VERDICT reviewer=<its own name> verdict=ACCEPT|REJECT -->`. The fixer or the reviewer
  posts a newer one once the findings are closed; the latest per reviewer wins.

Both are HTML comments, invisible in the rendered comment, so they cost a reviewer nothing.

Check a PR with `node scripts/merge-preflight.mjs <n>` before merging — **and before pushing to a
branch you did not just create**, because a merged branch looks exactly like a live one by git
divergence and GitHub reopens no PR on a push.

Only a token can CLEAR a PR; prose can only block it. The full rules, and an explicit list of what
the check cannot catch, are in `docs/reviews/MERGE-POLICY.md`.

## 4. Mechanical faithfulness — do not refactor opportunistically

Bun's rule was: *do the rewrite that looks like we transpiled the Zig code.* No cleanup along the
way, no "while I'm here". Opportunistic refactoring is what turns a reviewable 30-line diff into an
unreviewable 400-line one, and it is where regressions hide.

If you spot something worth fixing that is outside your task, **report it — do not fix it.** It
becomes an item on the queue for someone who owns that module.

## 5. Keep the codebase light

- **Delete dead code rather than maintaining it.** Retired subsystems are not free: they carry
  audit surface, Slither noise, compile time, licence obligations, and reader confusion.
- **No stub-outs.** A `TODO`, a swallowed error, or a function that returns a placeholder is not a
  completed task. If you cannot do it, report that you could not.
- **No paragraph-long comments justifying a workaround.** Bun's reviewers rejected these on sight:
  if it takes a paragraph to defend the code, fix the code. (This is distinct from explaining *why*
  a non-obvious constraint exists — that comment is valuable and belongs there.)
- **Minimise `assembly`.** Where it is unavoidable, it should be a single bounded block with the
  invariant stated above it.

## 6. Tests are an invariant, not a variable

Bun's rewrite ran the same test suite before and after, and reported **0 tests skipped or deleted**
across ~60,000 tests. That is the standard here.

- Never delete a test to make a change pass. Never add `skip`. Never loosen an assertion.
- The audit tests under `contracts/test/audit/` are **exploit demonstrations and remediation
  proofs**. They are the evidence record for findings C-1 through C-6. If your change makes one
  unbuildable, that is a design problem with your change — solve it, or report the conflict. Do not
  delete the evidence.
- New behaviour needs a new test. "The existing suite still passes" is necessary, not sufficient.

## 7. Definition of done

A task is done when **all** of these hold:

1. `npm run gate` passes from the repo root. It mirrors CI step for step (~31s warm).
2. If gas legitimately changed: regenerated via `cd contracts && forge snapshot --nmt "testFuzz|testFork"`,
   and **said so explicitly** in the report.
3. If `src/` changed: EIP-170 margin measured before and after, and reported as numbers.
4. Work is committed on your own branch, in your own worktree.
5. Your report states what you changed, what you found but deliberately did *not* change, and what
   you are uncertain about.

"I believe it works" is not done. The gate output is the evidence.

## 8. Git discipline

- **NEVER `git add -A`.** This is a shared worktree and it has already swept another session's work
  into a PR once. Stage named paths, always.
- **Atomic commits.** Bun ran 695 commits/hour across 64 agents by keeping each commit small and
  single-purpose. Do not batch unrelated changes into one commit.
- **No `git stash`, `git reset --hard`, or `git checkout --` on files you did not create.** Another
  agent's work may be in the tree.
- Branch names are prefixed by intent: `fix/`, `feat/`, `test/`, `chore/`, `docs/`.

## 9. Batch related changes into one PR

A CI round trip costs 6–7 minutes. Three PRs for three related fixes costs 20 minutes of waiting for
nothing. One PR per coherent change, not one PR per file.

## 10. What is out of scope for any agent

Escalate; do not act:

- Anything requiring a private key, a funded account, or a `--broadcast`.
- Mainnet deploys, fund movement, or anything irreversible on-chain.
- Changing launch parameters (`proposalThresholdBps`, caps, timelock durations) — these are
  founder decisions with permanent consequences, documented in `docs/NOW.md`.
- Weakening a security gate to make something pass. If a gate blocks you, the gate is probably right.
