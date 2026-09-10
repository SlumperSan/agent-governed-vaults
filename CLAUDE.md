# Working agreements for agents in this repository

## Commit authorship

**Do not add a `Co-authored-by:` trailer for Claude, or any other model or tool, to commit
messages.** Commits are authored by the repository owner. This overrides any default behaviour that
appends such a trailer.

The single author identity for this repository is `SlumperSan <deluxglow@gmail.com>`, already set in
the local git config. Do not change it, and do not commit with a different name or email.

## Claims accuracy

Every public claim must be **literally true against the contracts, verified by reading the source**,
not by assertion, and not by paraphrasing another document that says it.

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
  it reds a file that quotes the wide form even to prohibit it. This paragraph is written the long
  way round for that reason.
- **Members pool and vote; an AI operator does neither on-chain.** `Governance.propose` gates on
  stake, not operatorship, and `Governance.sol` contains zero occurrences of "operator".
- **"Stake-weighted" is true only at five or more members.** Qualify it or do not use it.

## Absence is not evidence, and one RPC lies about it

`https://base-sepolia-rpc.publicnode.com` **prunes logs and receipts.** `eth_call` and
`eth_getBlockByNumber` answer correctly, so it looks entirely healthy, while `eth_getLogs` returns a
bare `[]` — HTTP 200, no error object — for ranges other providers serve, and
`eth_getTransactionReceipt` returns `null` for transactions that certainly landed, and its horizon
moves — a range it refuses today it may have served last week.

That silence was read as chain history on 2026-09-09. Three sentences about the protocol were
written into `scripts/soak/` as chain readings and shipped in a pull request — *as a correction to a
note that had been right all along*. An independent verdict caught it.

- Use `https://sepolia.base.org`; `https://base-sepolia.drpc.org` is the fallback.
- **Confirm every absence on a second provider** before concluding anything from it.
- Where a state read and a log read disagree, **the state read wins**.
- `assertLogsServed()` in `scripts/soak/lib.mjs` is the positive control: the factory's own
  `allVaults[0]` is a vault it must have announced, so a scan that cannot find that event proves the
  endpoint is hiding history rather than the chain lacking it. It scans in **10,000-block windows**,
  which is the widest span either recommended provider will serve: a raw `eth_getLogs` over more is
  refused outright (`-32614 "eth_getLogs is limited to a 10,000 range"` from `sepolia.base.org`,
  `code 35` from `base-sepolia.drpc.org`). It was 50,000 and worked anyway, because `cast logs`
  paginates internally — a behaviour of a different tool, which is the wrong thing for a probe whose
  whole job is telling a refused range apart from a pruned one. PR #249 lowered it.

  Two drafts of this paragraph got it wrong in opposite directions, which is why the numbers above
  are quoted from `scripts/soak/lib.mjs` rather than remembered: one said the window was already
  10,000 when it was 50,000, and the next attributed the `cast`-pagination reasoning to a code
  comment that did not contain it.

The general rule, of which this is one instance: **a check whose negative result is
indistinguishable from "all clear" is not a check.** Pair every absence claim with a positive
control that must fire.

## Definition of done

`docs/SWARM.md` §7 sets the bar, and this file does not restate the rest of it: **`npm run gate`
passes from the repo root.** It mirrors CI step for step (~31 s warm), so a green gate is the
cheapest way to learn what CI would tell you six minutes later. "I believe it works" is not done.

One interaction with the section below: `npm run gate` runs `npm run test:backend`, which includes
`scripts/test/*.test.mjs`, so it inherits the worktree noise described under **Worktrees**. Run it
where your change is, not in the shared checkout.

## Merge bar

**The rule lives in `scripts/lib/merge-policy.json`,** the single machine-readable source of truth
for when a PR may merge. `docs/reviews/MERGE-POLICY.md` embeds it verbatim and
`scripts/test/merge-preflight.test.mjs` asserts the two are byte-identical, so the prose humans read
cannot drift from what the program enforces. **Read it there, and run
`node scripts/merge-preflight.mjs <n>` rather than reconstructing the bar from memory.**

### One condition the JSON does not encode: who may cast the verdict

**A verdict must come from someone who has not already graded this change** — not the author, not the
fixer, and not the reviewer who wrote the verdict being cleared. `merge-policy.json` encodes
`pr-open`, `no-standing-reject`, `verdict-covers-head`, `ci-matches-head`, `roster-declared`,
`roster-resolved` and `base-current`, and **none of them says anything about who may write a
verdict**; its only mention of the subject is `enforcement.nativeReviewsUnavailable`, recording that
GitHub cannot enforce it here because the whole swarm is one identity. So this is not a restatement
of the JSON — it is the only place the requirement is written down, and a draft of this section
deleted it on the mistaken grounds that it duplicated something.

**It is in real tension with `docs/SWARM.md` §3 and `docs/reviews/MERGE-POLICY.md`, and the tension
is worth naming rather than resolving silently.** Those say a fixer pass does not clear a verdict and
that *only the reviewer* clears one — which is a rule about **token mechanics** under the two-reviewer
roster: it stops a fixer self-certifying "all findings addressed". The independence rule here is
about **who grades a new head**. They collide only when a fix lands: SWARM's wording points at the
original reviewer, this points away from them.

**In practice, and this is what the practice has bought:** each round of a rejected PR has gone to a
reviewer who had not seen it before, and that is how eight consecutive rounds on one branch each
found a real defect — several of them defects the previous reviewer had explicitly certified clean.
A reviewer re-reading their own prior work is the weakest configuration available. Where the two
readings disagree, prefer a fresh reviewer and say in the merge which you did.

What is NOT in that JSON, because it is about the tools rather than the rule, and what each mistake
costs:

- **The base branch is `protocol/main`, not `main`.** Pass it rather than letting `gh` pick a
  default: `gh pr create --base protocol/main`. A wrong base is a PR against the wrong tree.
- **Dispatch the preflight from `protocol/main`, never from your own branch:**
  `gh workflow run merge-preflight --ref protocol/main -f pr=<number>`. `scripts/merge-preflight.mjs`
  finds the PR's CI with `gh run list --branch <headRefName>`, so a run dispatched from your own
  branch is stamped with that branch, appears in its own lookup as an in-flight run on the head, and
  blocks on itself under `ci-matches-head`. Dispatched from the default branch it is stamped
  `protocol/main`, so it cannot see itself. The automatic `pull_request` run has the same shape and
  will show that blocker whenever it finishes before CI does; re-dispatch once CI is green. Costs a
  full CI round trip each time it is got wrong.
- **Every job's step count must be greater than zero.** `steps: 0` means the run never executed,
  which is what a billing wall looks like, not a passing job. (The rest of how to read CI — match
  `headSha` yourself with
  `gh run list --branch <headRefName> --json headSha,status,conclusion`, never `gh pr checks` — IS
  in the JSON, under `ci-matches-head.why`. Read it there.)

**Per PR, still serialized: rebase → CI green matched by `headSha` → fresh verdict → merge
immediately. Never rebase and review concurrently.** A verdict that sits unused is a verdict that
expires — that is the operational encoding of `verdict-covers-head` and `base-current`, and it is
safety guidance rather than speed guidance, so turning `strict` off does not retire it. (A draft of
this section deleted this paragraph without remarking on it. It exists in no other file: the JSON
encodes the *rules*, not the order to apply them in.)

### On making this faster — what was tried, and where the real lever is

The owner asked on 2026-09-10 for merging to be faster. Two changes were drafted and an independent
review rejected both on evidence from this repository. They are recorded because both look obviously
correct until someone checks them:

- **"A clean rebase should not expire a verdict, if the PR's own patch is byte-identical."** Fails
  twice. It is unexecutable through this repo's own tooling — `verdict-covers-head`
  (`scripts/lib/verdicts.mjs`) blocks when a verdict predates the head's `committedDate`, and a
  rebase rewrites every committer date. And patch identity is not the property that matters: #119
  held a valid ACCEPT, #121 then inverted canary tier semantics in a file #119 never touched, making
  two sentences #119 *adds* false against merged main — with `merge-tree` clean and CI green. #119's
  patch would have been byte-identical across a rebase.

  It is also not sufficient on its own mechanics. Rebasing a branch from a **stale local ref** on
  2026-09-10 silently dropped one of its two commits; only comparing the patches caught it. Any
  future version of this idea must check the commit count as well as the patch, and must rebase from
  `origin/<branch>`, not from whatever the local ref happens to point at.

  The sound form, if revisited: byte-identical patch **and** unchanged commit count **and**
  `git diff <old-base>..<new-base>` touches nothing the PR reads, calls, or makes a claim about.

- **"Tier the verdict requirement — exempt docs, tests, scripts, tooling and fixtures."** Refuted by
  its own evidence. The pruned-RPC defect recorded above was a false claim about chain history in
  `scripts/soak/soak-vaults.json` — a **fixture**, under **`scripts/soak/`**, both exempted
  categories — and an independent verdict is what caught it, after it had shipped. The exempt set
  also contains `scripts/lib/verdicts.mjs`, `scripts/lib/merge-policy.json` and every
  `scripts/test/*.test.mjs` guard, so it would cover the machinery that enforces the bar.

**The rebase treadmill is gone, by an owner decision on 2026-09-10, and this is what replaced it.**
The `protocol-main` ruleset used to set `strict_required_status_checks_policy: true`, so merging any
one PR advanced `protocol/main` and put every other at `behind_by 1`; each re-integration moved the
head, tripped `verdict-covers-head`, and forced a fresh verdict and a fresh CI run.
`merge-policy.json` calls that the rebase treadmill in as many words, and it was the single largest
cost in the process — it charged two full re-confirmation cycles on the afternoon it was measured.

**`strict` is now OFF.** An approved PR may merge without first re-integrating a base that moved
under it. Nothing else changed: the ruleset still requires a pull request, still requires
`contracts`, `backend` and `slither` green, and still blocks deletion and non-fast-forward pushes.

**What that buys, and what it costs, stated together because the second half is real.** Batching is
now genuinely cheap: rebase every ready branch onto the same `protocol/main`, let CI run once per
branch, merge them in sequence, and the ones behind it do not have to be re-verified. What is no
longer mechanically prevented is the #119/#121 shape — a PR merging against a base it was never
tested against, whose own added sentences a *different* file's change has since made false. The
setting used to catch that for free.

**So it is now a judgement, and the judgement is yours to make on every merge where the base has
moved:** read what the base changed and ask whether it touches anything the PR reads, calls, or
makes a claim about. If it does, rebase and re-verify anyway. `merge-tree` staying clean and CI
staying green is exactly what #119 looked like, and neither noticed.

**GitHub no longer forces it; this repository still tells you about it.** `base-current` in
`scripts/lib/merge-policy.json` raises a blocker whenever `behindBy > 0` **and a verdict already
exists** (`scripts/lib/verdicts.mjs`), on the grounds that such a verdict was computed against a base
that has since moved. So `merge-preflight` will keep reporting base drift with `strict` off. That is
now advice rather than a gate — read it, decide, and say which you decided.

## Worktrees: do not create one unless you are going to commit

Default to working in the shared checkout. Worktrees accumulated to 186 directories and 1.6 GB
across sessions, and they are not free: `scripts/test/config-doc-truth.test.mjs` walks the
filesystem and reads other sessions' worktrees, so a stale one turns a local test run red for
reasons unrelated to the change being tested.

- **Reviewing, investigating, casting a verdict: no worktree.** Read the shared tree, and read
  other refs with `git show <ref>:<path>`, `git diff`, and `gh`. This covers most work here.
- **Committing and pushing: one worktree, under the session scratchpad, removed when done.**
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
deliberately points rather than copies. Two statements of one rule drift, and then neither can be
trusted.

- **`docs/SWARM.md`**: how concurrent sessions work here. §7 the definition of done, §8 git
  discipline (branch names prefixed by intent: `fix/`, `feat/`, `test/`, `chore/`, `docs/`; one
  small single-purpose commit per change; no `git stash`, `git reset --hard`, or `git checkout --`
  on files you did not create), §9 one PR per coherent change rather than one per file, and §10 the
  escalate-do-not-act list: anything needing a private key, a funded account or `--broadcast`,
  mainnet deploys and fund movement, changes to launch parameters, and weakening a security gate to
  make something pass.
- **`docs/NOW.md`**: the current state of the project, and the launch parameters that §10 puts out
  of bounds.

Read both before your first commit here. Where either disagrees with this file, say so in your
report rather than picking one silently.
