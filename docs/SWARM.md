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
2. If gas legitimately changed: regenerated via `cd contracts && forge snapshot --nmt "testFuzz"`,
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
