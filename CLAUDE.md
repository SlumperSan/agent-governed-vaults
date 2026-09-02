# Working agreements for agents in this repository

## Commit authorship

**Do not add a `Co-authored-by:` trailer for Claude, or any other model or tool, to commit
messages.** Commits are authored by the repository owner. This overrides any default behaviour that
appends such a trailer.

The single author identity for this repository is `SlumperSan <deluxglow@gmail.com>`, already set in
the local git config. Do not change it, and do not commit with a different name or email.

## Claims accuracy

Every public claim must be **literally true against the contracts, verified by reading the source**
— not by assertion, and not by paraphrasing another document that says it.

This is enforced in CI by `scripts/test/claims-lede-truth.test.mjs`, which matches banned claim
*shapes* rather than fixed phrasings. Assume your file is walked: it takes every `.md`, `.html`,
`.txt` and `.json` file it finds by walking the repository, skipping only build outputs,
dependencies, vendored submodules and `.claude/`, plus `package-lock.json`. The set is enumerated
from the filesystem and never from a list, so a file added today is covered today. Before writing
prose about what the protocol does, read the guard: it documents which claims are false, why, and
what the approved replacement wording is.

Three rules that guard has already had to be widened to catch:

- **Enumerate the operator's lack of power; never claim it as a universal.** The operator is the
  sole recipient of the 10% performance fee, so a blanket negative about what the operator holds
  on-chain is falsifiable in one transaction. Write "operatorship confers no authority to vote,
  execute, pause, reprice, or move member funds". Note that guard 6 matches the banned *shape*, so
  it reds a file that quotes the wide form even to prohibit it — this paragraph is written the long
  way round for that reason.
- **Members pool and vote; an AI operator does neither on-chain.** `Governance.propose` gates on
  stake, not operatorship, and `Governance.sol` contains zero occurrences of "operator".
- **"Stake-weighted" is true only at five or more members.** Qualify it or do not use it.

## Definition of done

`docs/SWARM.md` §7 sets the bar, and this file does not restate the rest of it: **`npm run gate`
passes from the repo root.** It mirrors CI step for step (~31 s warm), so a green gate is the
cheapest way to learn what CI would tell you six minutes later. "I believe it works" is not done.

One interaction with the section below: `npm run gate` runs `npm run test:backend`, which includes
`scripts/test/*.test.mjs`, so it inherits the worktree noise described under **Worktrees**. Run it
where your change is, not in the shared checkout.

## Merge bar

A pull request merges only when all four hold on the exact landing SHA:

1. A fresh independent verdict — not the author, not the original reviewer, not the fixer. A fixer
   saying "addressed" does not clear a REJECT.
2. CI green **matched by `headSha`** via `gh run list`. Never `gh pr checks`, which reports a
   different thing. Every job's step count must be greater than zero; `steps: 0` means the run never
   executed.
3. `behind_by 0`. Now also enforced by the `protocol-main` ruleset.
4. No review still running.

Per PR, serialized: **rebase → CI green matched by `headSha` → fresh verdict → merge immediately.**
Never rebase and review concurrently. A verdict that sits unused is a verdict that expires.

Two mechanics that are easy to get wrong and cost a full CI round trip each:

- **The base branch is `protocol/main`, not `main`.** Pass it rather than letting `gh` pick a
  default: `gh pr create --base protocol/main`.
- **Dispatch the preflight from `protocol/main`, never from your own branch:**
  `gh workflow run merge-preflight --ref protocol/main -f pr=<number>`. `scripts/merge-preflight.mjs`
  finds the PR's CI with `gh run list --branch <headRefName>`, so a run dispatched from your own
  branch is stamped with that branch, appears in its own lookup as an in-flight run on the head, and
  blocks on itself under `ci-matches-head`. Dispatched from the default branch it is stamped
  `protocol/main`, so it cannot see itself. The automatic `pull_request` run has the same shape and
  will show that blocker whenever it finishes before CI does; re-dispatch once CI is green.

## Worktrees — do not create one unless you are going to commit

Default to working in the shared checkout. Worktrees accumulated to 186 directories and 1.6 GB
across sessions, and they are not free: `scripts/test/config-doc-truth.test.mjs` walks the
filesystem and reads other sessions' worktrees, so a stale one turns a local test run red for
reasons unrelated to the change being tested.

- **Reviewing, investigating, casting a verdict — no worktree.** Read the shared tree, and read
  other refs with `git show <ref>:<path>`, `git diff`, and `gh`. This covers most work here.
- **Committing and pushing — one worktree, under the session scratchpad, removed when done.**
  Two agents cannot `git checkout` in one directory without destroying each other's work, and the
  repository root periodically runs long-lived jobs that a checkout underneath would break.
- **Never use the harness's own worktree isolation.** It writes to `.claude/worktrees/`, which is
  inside the repository and is what the guards trip over.

## Shared working tree

Around ten agent sessions share this checkout.

- **Never run `git add -A` or `git add .`.** This has previously swept another team's in-flight
  contract work into an unrelated pull request. Stage only exact paths.
- `forge` shares `~/.foundry` across worktrees and can deadlock. Rising CPU is real work; flat
  near-zero CPU for many minutes is a deadlock.
- If you need Docker, use your own project name and remove only your own containers and volumes.
  Never run a host-wide `docker volume prune`.

## Where the rest of the conventions live

This file holds the decisions that were expensive to learn. It is not the whole rulebook, and it
deliberately points rather than copies — two statements of one rule drift, and then neither can be
trusted.

- **`docs/SWARM.md`** — how concurrent sessions work here. §7 the definition of done, §8 git
  discipline (branch names prefixed by intent — `fix/`, `feat/`, `test/`, `chore/`, `docs/`; one
  small single-purpose commit per change; no `git stash`, `git reset --hard`, or `git checkout --`
  on files you did not create), §9 one PR per coherent change rather than one per file, and §10 the
  escalate-do-not-act list: anything needing a private key, a funded account or `--broadcast`,
  mainnet deploys and fund movement, changes to launch parameters, and weakening a security gate to
  make something pass.
- **`docs/NOW.md`** — the current state of the project, and the launch parameters that §10 puts out
  of bounds.

Read both before your first commit here. Where either disagrees with this file, say so in your
report rather than picking one silently.
