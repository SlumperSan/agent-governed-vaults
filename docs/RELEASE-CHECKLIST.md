# Release checklist — the Ops6 run

**What this is.** The list of things that must be true to ship, where **every line is proved by a
command or an artifact, not by an opinion.** Each item gives the exact command, the output that
counts as a pass, and who can run it. "Contracts are audited" is not a check; "gate 1 re-attested
by the owner against `bab5ee90`" is.

**What this is not.** It does not restate the eight launch gates — [LAUNCH-READINESS.md](LAUNCH-READINESS.md)
§1 is authoritative for those and a second copy would go stale independently. This file carries a
*pointer* to each gate row, its status as measured on the date below, and the command that re-earns
it. Reasoning about the gates lives there; live facts (head SHA, CI, `behind_by`) live in
`npm run cc` and `gh` and are deliberately not written down anywhere.

**Measured 2026-09-01 local / `2026-09-02T04:00Z` against `protocol/main` @ `bab5ee90`.** (Both
stamps given because the repo dates in local time and the Obsidian vault dates in UTC — the same
measurement appears under either date.) Every status below is a measurement
with a re-run command next to it. Re-run before trusting any of it.

---

## Current verdict — **NO-GO**

Six things stand between here and a mainnet deploy, in dependency order — the shortest path, not a
wish list. **Step 2 is the hinge:** steps 3, 4 and 5 must each name the one commit it freezes, or
each of them goes stale again the moment the next merge lands.

| # | Blocker | Whose | Proves clear when |
| --- | --- | --- | --- |
| 1 | **The five gating PRs land** (§2.2). **#108** gates the mainnet deploy and has no verdict; **#120** keeps a HIGH live on `main` until it lands — both also need a rebase to `behind_by 0`. **#131** (agent policy, §5), **#132** (public claims, §3) and **#133** (incident NAV, §6) are already `behind_by 0` and need verdicts only. **#133 is on the critical path in its own right**: §6's post-deposit phase is the one whose back-out line is *"you cannot stop it"*, and it sends members to a runbook that currently reports a false shortfall. | agents + an independent reviewer | `gh pr list --state open` shows none of the five; CI green on `protocol/main` at the new head SHA |
| 2 | **Owner decides freeze-or-redeploy.** Every `contracts/src` merge invalidates the testnet deploy that gates 2, 3 and 6 rest on. Until this is decided, closing those gates is a treadmill. | **owner only** | `Decisions/freeze-or-redeploy.md` status ≠ open |
| 3 | **Owner re-attests gate 1 against the head frozen in step 2**, or accepts a named residual. The audited tree and the deployed tree are the same tree, and **both are 13 files / +458/−1083 of `contracts/src` behind `main`** (§1 gate 1). Attesting before the freeze re-stales the moment the next merge lands — the same trap as gates 2/3/6. | **owner only** — gates 2/3/6 an agent can re-earn by re-running drills; gate 1 is an attestation about an external party's work product, and no agent can re-earn it | `LAUNCH-READINESS.md` gate 1 names the frozen head |
| 4 | **Testnet redeploy at that same frozen head**, in the LAUNCH configuration (`allowSubVaults = false`). Steps 3 and 4 do not depend on each other, but both depend on step 2 and both must name the **same** commit — an audit attested to one tree and a deployment made from another puts you back where this checklist started. Needs a funded Base Sepolia key. | **owner only** (key) | `node scripts/verify-deployment-currency.mjs` exits 0 with no notes |
| 5 | **Re-earn gates 2, 3, 6 and finish gate 7** against that new deployment. Order matters: the gate-7 drill consumes artifacts from daemons watching a live deployment, so running it before step 4 means running it twice. | agents, after step 4 | §1 rows 2/3/6/7 |
| 6 | **Owner-only mainnet items** (§4) — including **three one-shots that cannot be undone**: the operator payout address, vault #1's fee posture (the same transaction), and `allowSubVaults = false` on the mainnet factory. | **owner only** | §4 |

Legal (entity, jurisdiction, counsel) is **parallel and NOT blocking**, per the owner directive of
2026-09-02. It is not in this list on purpose. It still gates *moving mainnet funds*; it does not
gate agent work, and the constraint that replaces it is claim accuracy (§3).

---

## 1. Blocking gates — by reference

Authoritative text: [LAUNCH-READINESS.md](LAUNCH-READINESS.md) §1. Do not copy its evidence prose
here. Status column measured 2026-09-01.

| Gate | Status now | What earns it | Who |
| --- | --- | --- | --- |
| **0** No unfixed Criticals | GO (root-only) — **and it does not cover H-8** | Holds only while `allowSubVaults = false` on the deploy path. Re-check after any redeploy: `node scripts/verify-deployment-currency.mjs` must print no `allowSubVaults` note. The row says *Critical*; H-8 is a **High** and does not breach it — see below. | agent |
| **1** External audit | **STALE — newly found, see below** | Owner re-attests against the current head, or records a named residual for the 31-commit delta. Cannot be delegated. | **owner** |
| **2** Testnet lifecycle | **STALE** (was GO 2026-09-01) | `node scripts/smoke-test.mjs` ten phases against a *current* deployment. Needs a funded testnet key. | owner (key) → agent |
| **3** Soak drills | **STALE, and structurally untransferable** | `scripts/soak/` re-run against a current deployment. **Two of the three transfer defects land here — see below; only one is redeploy-fixable.** | owner (key) → agent |
| **4** Live x402 settlement | GO (unaffected) | Off-chain + USDC `transferWithAuthorization`; no contract in the delta touches it. Nothing to re-earn. | — |
| **5** Mainnet oracle config | **GO — and re-earnable today, keyless** | `node scripts/verify-chainlink-oracle.mjs` — **26/26 pass, exit 0**, re-run 2026-09-02 against Base mainnet. Read-only, no key, no deployment: the script exists to be run *before* deploying. Anyone can re-earn this row in one command. | agent |
| **6** Canary operational | **STALE** | `npm run start:canary` against a current deployment, transitions reconciled to drill actions. | owner (key) → agent |
| **7** Restore drill | **CONDITIONAL — blocker now gone** | Re-run [RESTORE-DRILL.md](RESTORE-DRILL.md) steps 1 and 6 literally, plus the off-host volume backup ([RUNTIME.md](RUNTIME.md) §8.3) the drill records as never exercised. See below. | agent |
| **8** CI green at the candidate ref | GO at `bab5ee90` | `gh run list --branch protocol/main --json headSha,conclusion` — the run whose `headSha` equals `git rev-parse protocol/main`. Never `gh pr checks`. | agent |

### Gate 1 is stale, and nobody had asked

This was not on the carryover list and it is the highest-consequence finding here.

```bash
git rev-parse b1a8ae84:contracts/src 5934ef22:contracts/src protocol/main:contracts/src
```

The attested tree (`b1a8ae84`, named in `LAUNCH-READINESS.md`'s header) and the deployed tree
(`5934ef22`, `base-sepolia.json`'s `sourceCommit`) have the **identical** `contracts/src` tree hash
`abed2e5d`. `protocol/main` is `fe05004d`. The audit is therefore behind `main` by the same delta as
the deployment.

Measure that delta as **13 files, +458/−1083** — not as a commit count. Commit counts here are a
trap: `b1a8ae84..protocol/main` is **211** commits (136 non-merge) across the whole tree, and **31**
(**17** non-merge) once filtered with `-- contracts/src`. Four different true numbers for one delta
is an argument waiting to happen — quote the diffstat and skip it. What
nobody can discount:

- **Four commits carry a `SECURITY:` prefix** — `cf7b4fb2` (a vault whose oracle cannot price its
  basket: a creatable permanent brick), `2be3a456` (Chainlink feed denomination read on-chain),
  `b5b33bf0` (heartbeat and sane-price bounds), `0e70ea69` (read-only reentrancy). A fifth,
  `8a2afc3e`, refuses a nested `executeSwap` that sweeps the outer order's input — security in
  substance, without the prefix.
- **`0857d6bc` moved the entire retired oracle stack out of `src/`** — a change to the audited
  surface itself, not merely to code within it.
- `0811dadd` reclaimed 3,849 B of `VaultCore`.

This does **not** say the tree is less safe — most of that delta is hardening that landed *after*
the audit. It says the attestation covers a tree that is not the tree. Only the owner can re-attest.
`LAUNCH-READINESS.md` is authoritative and is deliberately not edited by this file.

### H-8: the contradiction resolves, and what is left is an owner decision

[LAUNCH-READINESS.md](LAUNCH-READINESS.md) reads two ways — L18 lists H-8 among findings *"fixed +
config-mitigated"*, while L62–65 and L370–373 call it *"the key open High for a root-only launch"*
and *"the only open High that is reachable"*. **Both halves are locally true**, which is why it
survived. Derived from source rather than from either sentence:

- **The stake-blind quorum is genuinely FIXED.** `contracts/src/Governance.sol:553-555` — the
  sub-five branch is now `headMajorityWithStake || forStakeMajority`, and **both** carry a stake
  term (`p.forWeight * BPS >= quorumBps * p.snapshotTotal`, and an outright FOR stake majority).
  L18 is right about this half.
- **H-8(a) is unfixed BY DESIGN.** The same NatSpec, `Governance.sol:549-552`, states it outright:
  *"What stays UNfixed here BY DESIGN: buying the 5th seat to reach the stake regime (H-8(a))…
  mitigated at the config layer (a meaningful minimum deposit)."* L62/L372 are right about this half.

**The document is not wrong in one place — it uses one label for two things, and one line dropped a
word.** `docs/AUDIT-HANDOFF.md:19` already carries the correct form: **"H-8: partially fixed +
config-mitigated."** `LAUNCH-READINESS.md:18` says "fixed + config-mitigated", omitting
*partially*. **L18 is the defective line**; L62/L372 stand. That file is authoritative and is not
edited from here — this is the finding, and it needs a PR of its own.

**What the residual actually costs, in the numbers rather than in prose.**
`SIGNER_REGIME_BELOW = 5` (`Governance.sol:82`); `quorumBps` = **2500** (25%); the config note puts
the attack at *"the ~4 seats needed to flip the regime"*, so the cost is **4 × `minDepositUsdc`**.

**And that is as far as the arithmetic goes, because vault #1's `minDepositUsdc` does not exist
yet.** `grep -c minDeposit docs/LAUNCH-READINESS.md` returns **0** — the launch vault's value is
recorded nowhere. The 100 USDC in `contracts/config/base-mainnet.json:222` sits inside that file's
**`"smoke"`** block, whose own `capacityCapUsdc` is `1000000000` (**1,000 USDC**); against *its* cap,
4 × 100 USDC is **40%**. The 50,000 USDC cap is `LAUNCH-READINESS.md:123`, describing a **different
vault**. Pairing that numerator with that denominator produces a reassuring ratio out of two sources
that never described the same vault — exactly what `base-mainnet.json:13` forbids when it says
*"relative to its capacity"*. **An earlier revision of this file quoted ≈0.8% on that pairing. It is
retracted; do not reintroduce it.**

So the true statement is stronger than any ratio: **vault #1's entire H-8 mitigation rests on a
parameter that has no recorded value, is immutable once set, and is set before the vault exists.**
And the mitigation is a **listing constraint, not a contract floor** — the note records that no safe
contract-level floor exists (a fraction-of-stake floor repeats M-6's liveness cliff). Nothing
enforces it: a vault created with a low `minDepositUsdc` has no mitigation at all, and the code will
not stop it.

**The mitigation cannot bind anyone but us.** The only contract-level constraint is
`require(minDepositUsdc_ > 0, BadConfig())` (`contracts/src/VaultCore.sol:252`) — **any nonzero
value is accepted**, and the field is `immutable` (`:82`). `VaultFactory.createVault`
(`VaultFactory.sol:178`) has **no access control**: it checks only that the oracle is on the curated
allowlist and that the oracle covers the basket. So anyone may create a vault on this factory with
`minDepositUsdc = 1`, and in that vault the H-8(a) regime flip costs about **4 USDC**.

That is a separate point from vault #1's own posture, which is unresolved for a different reason
(its `minDepositUsdc` is not set yet — above). What this changes is **what may ever be said in
public about vaults in general**, so it is a claims boundary as much as a risk item: see §3.

This is also the third of the three reasons testnet evidence does not transfer — enumerated
below, because they need separate fixes.

**Nothing in the gate set forbids an open High.** Gate 0 is scoped to *Critical*, and no other gate
row or the audit handoff asserts a stronger claim — checked, so that it is derived rather than
assumed either way. So H-8 does **not** put any gate into NO-GO on its face. What it does do is put
a **known, accepted, by-design High into production**, and accepting a residual is a risk decision.
It is in §4 as an owner item, because a documentation state cannot make it for them.

### Three reasons testnet evidence does not transfer — and a redeploy fixes only the first

Keep these enumerated. Collapsing them into "the testnet is stale" is how the second and third get
silently closed by a redeploy that did not touch either.

| # | Reason | Fixed by a redeploy? |
| --- | --- | --- |
| 1 | **Stale tree** — the deployment is behind `main` by 13 files / +458−1083 (§2.1) | **Yes**, at the frozen head |
| 2 | **Wrong topology, immutably** — the deployed factory has `allowSubVaults = true`; the flag is `immutable` (below) | **No.** A launch-configured redeploy makes gate 3's sub-vault drills *unreachable* instead. One factory cannot evidence both topologies |
| 3 | **H-8 mitigation absent** — `contracts/config/base-sepolia.json:101` sets `minDepositUsdc` = 1 USDC, explicitly a smoke value, so the live Sepolia vault runs the H-8(a) residual essentially unmitigated | **No**, unless the redeploy also changes that value — and it is `immutable` per vault, so it means a new vault |

Gate 3 carries reasons 1 and 2 directly; reason 3 is listed with them so a redeploy cannot silently close it.

**Defect 1 — staleness.** The deployment is behind `main` by 13 files / +458/−1083 of
`contracts/src` (§2.1). A redeploy at the frozen head fixes it.

**Defect 2 — the topology is immutable and it is the wrong one.**
`VaultFactory.allowSubVaults` is `bool public immutable` (`contracts/src/VaultFactory.sol:54`, set at
`:106`); its own NatSpec at `:86` reads *"C-1 launch switch. Pass FALSE for mainnet launch (root
vaults only)."* The deployed Base Sepolia factory has it **`true`** — recorded in
`base-sepolia.json` and confirmed on-chain. That factory **can never become root-only.**

This is not a mistake: gate 3's drills include sub-vault aggregation and SV-7 look-through, which
cannot run against a root-only factory, so `DeployTestnet.s.sol` sets it `true` deliberately
(`:157`, with a dated 2026-08-29 review-hardening comment). The consequence is the problem:
**one immutable factory cannot evidence both topologies.** A launch-configured redeploy makes the
sub-vault drills unreachable — `createChildVault` reverts (`VaultFactory.sol:203`) — while the
current deployment evidences a topology mainnet must not ship.

Three things follow, and none of them is an agent's call:

1. **Gate 3 must be re-scoped**, or the redeploy deliberately non-launch-configured with gate 3
   recorded as evidence about a different topology. Owner's judgement about what the gate means.
2. **"Root vaults only at launch" is not a property of any deployed contract.** It is a constructor
   argument the mainnet deploy must be *given*. It must not appear anywhere as already true, and it
   must never be sourced to a testnet proof.
3. **No Sepolia observation settles C-1 / H-5 / H-6 in either direction.** The standing claim that
   they are unreachable at launch rests on `allowSubVaults == false`, which is true of the *intended*
   mainnet deploy and false of the *deployed* testnet. Do not let a testnet run be cited as clearing
   them.

**There is no defaulting hazard in the scripts** — checked, because it would be the obvious place
for one. `contracts/script/Deploy.s.sol:79` passes **`false`** with the C-1 comment;
`DeployTestnet.s.sol:157` passes **`true`** behind its documented rationale. Both are deliberate and
correct. What is *not* yet verified is the artifact rather than the intent: nobody can confirm the
eventual mainnet deployment transaction ran `Deploy.s.sol` unmodified. So the item is in §4, and it
is a read performed **after** the deploy — the same lesson as the `VaultDeployer` pinned-chunks trap
in §2.1: a script that says the right thing is not evidence about what is on chain.

### Gate 7: the Docker blocker is gone; the gate is not earned

`Decisions/docker-reboot.md` and the carryover both say gate 7 waits on an owner reboot.
**Re-measured directly on this machine 2026-09-01 — it does not.**

```bash
docker info --format '{{.ServerVersion}}' && docker compose version && docker run --rm alpine:3 echo DOCKER_ENGINE_OK
```

Pass: `29.7.2`, `Docker Compose version v5.4.0`, `DOCKER_ENGINE_OK`. All three observed; the engine
that `RESTORE-DRILL.md` §9 recorded as "unable to start" is up, and `wsl --list -v` shows the
`docker-desktop` distro present.

The *blocker* is cleared. The *gate* is not: 2 of the drill's 6 steps (`docker compose stop/start
indexer`) were substituted, and the off-host `docker run … tar czf` volume backup ([RUNTIME.md](RUNTIME.md) §8.3) — the one that protects against a dead disk rather than a bad write — was never run. That is now agent
work, not an owner decision — and it should run **after** any redeploy, since the drill's artifacts
come from daemons watching a live deployment. Worth recording: `RESTORE-DRILL.md` §9 also notes a
WSL2-native process path would have satisfied the row without Docker at all, so "reboot" was never
the only remedy.

---

## 2. Engineering

### 2.1 The deployment must not be behind `main`

The check that closes the recorded trap. **Comparing singleton codesizes gives a false all-clear** —
`VaultFactory` and friends do not change when `VaultCore` does, because the vault's code lives in
`VaultDeployer`'s two SSTORE2 chunks (`contracts/src/VaultDeployer.sol:28-39`), not in any singleton.

```bash
node scripts/verify-deployment-currency.mjs --onchain
```

- **Pass:** exit 0, `OK base-sepolia … contracts/src unchanged since deploy`, and no `NOTE:` lines.
- **Measured 2026-09-01: FAILS.** `BEHIND base-sepolia 5934ef22 — 13 contracts/src path(s) changed`;
  `NOTE: factory.allowSubVaults() = true, but launch ships false`; on-chain
  `pinned VaultCore creation code 26076 B vs local 22391 B (delta 3685) — MISMATCH`.
- Anyone can run the git half offline. The `--onchain` half needs a read-only RPC and a prior
  `forge build`; it sends no transaction and needs no key.

Two independent confirmations behind that verdict, either usable by hand:

```bash
# 1. locked() exists on main's VaultCore (VaultCore.sol:161) but not on any deployed vault
cast call 0x4D60E49d451117b9Ab8F9Fb9BE56454Ab7f01A0F "locked()(bool)" --rpc-url https://sepolia.base.org
```
Pass = returns a bool. **Measured: reverts** — selector `cf309012` is absent from the deployed
runtime, while `basketLength()`, `navWad()` and `isCapped()` all answer. It is a live `VaultCore`
that simply predates the read-only-reentrancy guard.

```bash
# 2. the pinned chunks, read straight off VaultDeployer
cast call 0x891633092Cff72f6566785C9c9B6b574c178e036 "codeChunkA()(address)" --rpc-url https://sepolia.base.org
```

*Do not* use `totalSupply()` or `decimals()` as the probe — they revert on a perfectly current
vault too. `VaultCore` is not an ERC20; those selectors are declarations for an external token
(`contracts/src/VaultCore.sol:18`).

### 2.2 PRs that gate release

Enumerated from `gh`, not from the vault. **5 of the 18 open PRs gate release; 13 do not.**

```bash
gh pr list --state open --limit 50 --json number,title,reviewDecision,mergeStateStatus
```

| PR | Why it gates | Measured 2026-09-01 |
| --- | --- | --- |
| **#108** adapter scoped sweep | Gates the mainnet deploy. | `reviewDecision` **NONE** — no verdict at all. `mergeStateStatus` **DIRTY** (real conflicts). `behind_by 66`. |
| **#120** indexer exit/fee/gov ABIs | A HIGH from #107 stays live on `main` until it lands. | `reviewDecision` **NONE**. `mergeStateStatus` CLEAN. `behind_by 61`. |
| **#132** public-claims sweep (LedeFix) | §3's first three rows cannot pass without it — it is the lede fix and the drift check. | `reviewDecision` **NONE**. `behind_by 0`. Also edits `docs/LAUNCH-READINESS.md`. |
| **#131** vault #1 agent policy (AgentPolicy) | §5's "agent policy published" row and the launch narrative both depend on it; it must be public **before** the first on-chain proposal. | `reviewDecision` **NONE**. `behind_by 0`. |
| **#133** incident NAV reconstruction (LaunchComms) | §6 sends members to a runbook whose NAV reconciliation omitted the child look-through leg — a false shortfall mid-incident, read at the moment nothing can be paused. | `reviewDecision` **NONE**. `behind_by 0`. |

The other thirteen (#106, #110, #111, #112, #115, #116, #118, #122, #124, #126, #127, #128, and
this one) are open but not gating: Slither triage docs, canary signal fixes, supply-chain pins,
member docs. Merge-queue work, not release work.

Three facts about the twelve **older** PRs (#131, #132 and #133 are current and `behind_by 0`) that
matter more than the individual rows:

- **None has a `reviewDecision`.** All fourteen read `NONE`.
- **Every one is behind `main` by 61–104 commits.** `mergeStateStatus: CLEAN` means *no conflict*,
  not *up to date*. Their green checks were earned on a base 61–104 commits stale, so no merge is
  admissible on that green — each needs a rebase and a re-run first. Seven were `DIRTY` with real
  conflicts on two separate reads 2026-09-01: #108, #110, #111, #115, #118, #124, #126. Re-read
  rather than trusting that list — GitHub computes `mergeStateStatus` lazily, so a first query can
  answer `UNKNOWN` and settle only afterwards.
- **#124 is red** (`backend` FAILURE). #124 is the doc-citation guard — the check that resolves
  every `file:line` citation in `docs/` against the repo. **Until it lands green, nothing verifies
  the citations in this file.** That is the guard for this artifact, and it is currently off.

### 2.3 CI green, matched by head SHA

```bash
git rev-parse protocol/main
gh run list --branch protocol/main --limit 5 --json headSha,conclusion,workflowName
```

Pass: a run whose `headSha` **equals** the rev-parse output, `conclusion: success`, with all three
jobs (`contracts`, `backend`, `slither`) green — check them with `gh run view <id> --json jobs`.

**Never `gh pr checks`.** It reports runs attached to a PR without saying which commit they ran on,
so a green from six commits ago reads as a pass.

**A red is not always a failure — check the shape before you act on it.** A job that fails in
2–3 seconds with **`steps` = 0 and no logs** did not run: that is exhausted Actions minutes or a
runner it could not get, not your code. Tell them apart before touching anything:

```bash
gh run view <id> --json jobs --jq '.jobs[] | "\(.name) \(.conclusion) steps=\(.steps|length)"'
```

`steps=0` on every job, seconds apart, is the capacity signature ([NOW.md](NOW.md) records the
2026-08-29 outage with exactly this tell). It is also **not something a re-run fixes** — a re-run
reproduces it. During such a window **gate 8 cannot be earned by anybody**, on any PR: it is not
that the candidate is bad, it is that no candidate can be evidenced. Do not merge on a local pass
instead; `npm run gate` (~30 s warm, 9 steps) is the right thing to run and the wrong thing to
substitute, because gate 8's whole content is *CI green at the candidate ref*. Wait for capacity and
re-run at the same head.

**During an outage, every push trades a verified head for an unverifiable one — and you should
still make that trade for a falsehood.** A branch sitting on a green from before the cutover has
evidence; push once and it has none until runners return. That asymmetry tempts people to sit on a
verified head that carries something they know is wrong. **Do not.** The rule, in order:

1. **Fix the falsehood. Lose the green. Record why** — in the commit message, so the missing green
   reads as a decision rather than an oversight.
2. A verified green over a known-false claim is the worse artifact of the two. Gate 8 is
   re-earnable in one CI run; a false claim shipped on a public surface is not re-earnable at all
   (§3).
3. The trade only costs something if you *hold* a green. A head that is already unverifiable loses
   nothing by moving, so batch the rest of the outage's edits onto it freely.

Demonstrated 2026-09-02: PR #132 held a verified green whose tree carried a live falsehood in
`base-mainnet.json`'s `minDepositNote` — the note the whole H-8 mitigation rests on (§1) — and took
the unverifiable head with the correction. That was right.

**And do not keep a hand-written list of which branches are green.** It is stale the moment anyone
pushes, which during an outage is exactly when people reach for one. Query per head instead:

```bash
gh pr view <n> --json headRefOid --jq .headRefOid
gh run list --commit <sha> --json workflowName,conclusion
```

Measured 2026-09-01: head `bab5ee90`, run `33586340700`, `headSha bab5ee90…`, `success`,
`contracts`/`backend`/`slither` all green. The transient Foundry-download reset the handoff mentions
is resolved. Locally, `npm run gate` is the ~30 s mirror.

#### The check that enforces this rule has a hole in the permissive direction

`merge-preflight` automates exactly the rule above. **It does not do what its name promises**, and
the more dangerous half is the one that lets things through.

**The permissive hole — `ci-matches-head` can green a head that has no CI run at all.**

1. `scripts/merge-preflight.mjs:97-100` fetches runs with `gh run list --branch <head branch>` and
   **no `--workflow` filter**, so the preflight's own runs are in the set.
2. `scripts/lib/verdicts.mjs:213-216` — `runsForHead` narrows by head SHA **alone**. No
   workflow-name exclusion anywhere; `workflowName` is fetched and never read.
3. `scripts/lib/verdicts.mjs:273-293` — the rule blocks when the run set is empty, on each `failed`
   run, and on each `pending` run. It never asks whether a **CI** run in particular succeeded.

So a head carrying one completed, successful preflight run and **no CI run** yields
`succeeded = 1, failed = 0, pending = 0` — and **no blocker**. The rule named `ci-matches-head`
would report green on a head with no CI. That is fail-open, and it outranks the restrictive half
below: a gate that wrongly blocks is noticed immediately, a gate that wrongly passes is not.

**The restrictive half — real, but narrower than it looks.** On the **`pull_request`** trigger the
evaluating run is itself on the head branch at the head SHA, so it is in its own run set and blocks
on itself. **Observed** on PR #130 at head `bcb7a4e5`: after CI had completed green, a re-run
reported exactly one blocker — itself.

**This does NOT generalise to every trigger, and the greens prove it.** On the `issue_comment`
trigger the run is on `protocol/main` (`.github/workflows/merge-preflight.yml` checks out
`ref: protocol/main`, and the run's `headBranch` is `protocol/main`), so `gh run list --branch <PR
head branch>` never returns it and there is no self-block. Measured across all 18 open PRs:
**2 green (#131, #133), 1 red (#132), 15 with no status at all.** Any claim that it "can never post
green" is false, and a green from an `issue_comment` run is **meaningful** — reaching "no blocker
found" required finding at least one completed, successful run at that head.

One `--workflow`-filter fix closes both halves at once.

**How to read its status, since two natural readings mislead:**

- **The run's conclusion is not the status it posts.** `gh run list` can report `merge-preflight` as
  `conclusion: success` while the status it posted is red — the job **succeeded at posting a red
  status**. Read `gh api repos/{owner}/{repo}/commits/<sha>/status`. This has already misled one
  reader into calling red heads green.
- **A red alone does not prove the self-block.** A genuinely pending CI run at the same head blocks
  too, and blocks *correctly*. Only the post-green re-run isolates it.

It is **advisory today**. The trap is the workflow's own stated rollout: it becomes binding once the
owner requires the `merge-preflight` context in branch protection
(`.github/workflows/merge-preflight.yml`, "STATUS" header). Fix the `--workflow` filter first — and
fix the permissive half whether or not it is ever made binding, because that one is wrong in the
direction nobody checks.
Fix this before making it required — and note that branch protection cannot be configured on the
current GitHub plan anyway (§4), so there is time.

Until then, `merge-preflight` red on a PR is **not** evidence of anything. Match `headSha` by hand,
as §2.3 says.

### 2.4 No HIGH live on `main`

Pass: #120 merged. Until then a known HIGH from #107 is live on the branch that would be deployed.
There is no automated check for this — it is a fact about the finding ledger, and the honest
statement is that it is proved by #120's absence from `gh pr list --state open`.

---

## 3. Claim accuracy

The constraint that replaces legal review, per the owner directive of 2026-09-02: **every public
claim must be literally true against `contracts/src`, verified by reading the contracts.** The repo
is already public, so this binds `README.md`, `llms.txt`, `docs/` and `apps/web/` today.

| Item | Pass condition | Owner |
| --- | --- | --- |
| The lede says who does what | README line 1, `llms.txt` and the web discover view no longer say AI agents *pool* and *govern*. Members pool and vote; the agent-operator only **proposes**. | `gtm-fix-lede-mechanics` (LedeFix) — **PR #132**, open |
| A drift check exists and is green | LedeFix ships a repo check that reds when any of the seven surfaces drifts from the canonical sentence. Run it; do not read it. | LedeFix |
| The check covers *every* approved sentence | The drift check is keyed by claim id across all claims in `core-claims-doc.md`, not just the lede. | `gtm-claims-pipeline` — **sequenced strictly after LedeFix**; both edit the same files |
| Every PROOF field re-verified, not sampled | **Every** claim's PROOF in `core-claims-doc.md` re-read against current `contracts/src`. Sampling is not enough: of the first handful anyone has actually checked, **two came back stale** (the §1.4 exit-fee decay, and the §1.3/§5 operator-exclusivity claim below). A hit rate like that on a sample is an argument for the full sweep, not for confidence. | `gtm-claims-pipeline` |
| Agent policy published | Vault #1's deterministic rebalance policy exists and is public **before** the first on-chain proposal, so proposals are checkable against it. | `gtm-agent-policy-published` (AgentPolicy) — **PR #131**, open |
| **No governance-security claim travels from vault #1 to vaults in general** | See below — this is a boundary on what may be said, not a task that completes. | §3 standing rule |

`core-claims-doc.md` is LedeFix's file; nothing else writes to it while that task is open.

**Known open defect against the first row.** LaunchComms has parked four claims-doc asks for LedeFix
at `GTM/LaunchComms to LedeFix - claims-doc asks.md` in the Obsidian vault. Three of them are re-verified here against the
contracts rather than taken on report:

- **Operator exclusivity is false.** `§1.3` and the `§5` headline both assert it.
  `contracts/src/Governance.sol:281` — `propose` is `external` and gates only on
  `vaultRegistered`, no active proposal, and a per-`msg.sender` cooldown. **There is no operator
  check.** Anyone may propose. This blocks the lede row above: the surface it regenerates from is
  itself wrong.
- **"Fee waived" has no contract basis.** `contracts/src/FeeEngine.sol:35` —
  `uint256 public constant PERF_FEE_BPS = 1_000` (10%), used unconditionally at line 88. A
  `constant` has no setter and no override, so no vault can waive it.
- **`§1.4`'s exit-fee-decay PROOF cites a retracted figure.**
  [LAUNCH-READINESS.md](LAUNCH-READINESS.md) §2 gives 604,800 s (7 days) and says the 302,400 s
  (3.5 days) figure "was never what the 50 bps vault ran" — and flags 3.5 d vs 7 d as an
  **unresolved owner decision**, so no claim can be pinned to either until it is made.

Resolving these is LedeFix's; noticing that this section does not pass without them is this
checklist's.

### The claims boundary: vault #1 is not "the protocol"

H-8's mitigation is a **configuration value with no contract floor** (§1). `VaultCore.sol:252`
accepts any nonzero `minDepositUsdc`, and `VaultFactory.createVault` (`:178`) is permissionless — it
gates on the curated oracle allowlist and nothing else. So a third party can stand up a vault on
**this same factory** with `minDepositUsdc = 1`, where the H-8(a) regime flip costs roughly 4 USDC.

Every governance-security property that rests on `minDepositUsdc` is therefore a property of **vault
#1's configuration**, never of the protocol, the factory, or "vaults." Two consequences that bind
copy:

- A sentence like *"a governance attack costs ~400 USDC"* is true of vault #1 and **false of the
  next vault someone deploys.** Any such claim must name the vault and its `minDepositUsdc`, or not
  be made.
- The same holds in reverse for reassurance: nothing about vault #1's settings can be offered as
  evidence about a third-party vault a reader might find on the factory.

This is a standing boundary, not a task. It does not complete — it constrains every surface §3
covers, and it is the kind of claim that is *individually defensible and collectively false*, which
is exactly the failure mode a single falsifiable public claim represents here.

---

## 4. Owner-only — cannot be delegated

Each of these is irreversible or needs something no agent has (a key, a funded account, an
attestation, a payment). The irreversibility is stated plainly because that is the whole reason
they are on a separate list.

**Three of them are one-shot and permanent**, and two are decided at the *same moment* — the
transaction that registers the operator. Settle both before sending it:

1. **The operator payout address** (`OperatorRegistry` has no rebind).
2. **The vault-#1 fee posture** — see the fee-waiver row; it is not a separate decision from (1).
3. **`allowSubVaults` on the mainnet factory** (`immutable`; the deploy transaction's constructor
   argument, verified afterwards by reading it).

| Item | Irreversibility | Pass |
| --- | --- | --- |
| **Operator payout is a Safe, never an EOA** | `OperatorRegistry` has **no rebind** — `registerOperator` "can never rebind an existing operator" (`contracts/src/OperatorRegistry.sol:87`, CM-4). An EOA here **permanently** forecloses any future protocol fee split. Free, one afternoon, and the easiest thing on the board to get wrong by default. | The registered operator address is a deployed Safe, verified by reading it back on-chain before any vault is created |
| **Freeze the tree, or make redeploy part of the gate** | Not irreversible, but it is the decision that unsticks gates 2/3/6. Without it, every merge re-stales them. | `Decisions/freeze-or-redeploy.md` status ≠ open |
| **Re-attest gate 1** | An attestation about a private report; no agent can make it. | `LAUNCH-READINESS.md` gate 1 names the current head |
| **Vault #1's fee posture — waived is not implementable as written** | `FeeEngine.PERF_FEE_BPS` is a `constant` (10%, `FeeEngine.sol:35`) applied unconditionally at `:88`. No per-vault override, no setter, no waiver function. The go-to-market plan's "fee waived on vault #1, for regulatory optics" **cannot be done in the contracts.** The two available routes are (a) non-collection — the operator simply never claims, but fees still accrue on-chain and the accrual is publicly visible, so the optics claim is weaker than intended and must not be stated as a waiver; or (b) an operator payout address that cannot claim — which is **permanent**, because there is no rebind. Route (b) makes this the *same* decision as the Safe row above, taken in the same transaction. | Decided and recorded **before** the operator address is registered, and whatever is chosen is described accurately on every public surface (§3) |
| **`exitFeeDecayPeriod`: 3.5 days or 7?** | A launch parameter, immutable per vault. `contracts/config/base-mainnet.json:226` says `604800` (7 d); [LAUNCH-READINESS.md](LAUNCH-READINESS.md) §2 records that 302,400 s (3.5 d) "was never what the 50 bps vault ran" and flags the contradiction as unresolved. Until it is decided **no public claim can be pinned to either figure** — and one already is (§3). | Owner decides; the value is then confirmed by reading it off the **deployed vault**, not off the config |
| **Set vault #1's `minDepositUsdc`, then accept H-8(a) at that number** | Launching knowingly with an unfixed High. It is unfixed **by design** — there is no contract-level fix (§1) — so the only levers are the config value and acceptance. **The value does not exist yet**: it is written down nowhere for the launch vault (§1), and it is immutable per vault, so it is chosen **before** vault #1 is created and can never be revised. The flip costs 4 × `minDepositUsdc`, and whether that is tolerable is meaningless until the cap it sits against is named too. | Owner records **both** numbers — the `minDepositUsdc` and the `capacityCapUsdc` it is relative to — and accepts the resulting ratio, or names a higher `minDepositUsdc` — and every public surface (§3) describes the governance regime accurately, since "fixed" is not what the contracts say. **The acceptance covers vault #1 only:** `VaultCore.sol:252` accepts any nonzero value and the factory is permissionless, so it cannot be extended to third-party vaults and no claim may imply it does (§3) |
| **Ratify no-token / beachhead / anchor strategy** | A token, once issued, cannot be un-issued; a public posture cannot be un-said. | `gtm-ratify-launch-posture` ratified or overridden |
| **Testnet redeploy** | Needs a funded Base Sepolia key. Must be in the **launch** configuration (`allowSubVaults = false`) or the re-earned evidence is again about the wrong contracts. | `verify-deployment-currency.mjs` exits 0, no notes |
| **Mainnet deploy** | Immutable. No pause, no upgrade, no admin (§6). One shot. | `Deploy.s.sol` run with `--broadcast`; a `contracts/config/deployments/base-mainnet.json` record written and verified |
| **The deployed mainnet factory reads `allowSubVaults() == false`** | `bool public immutable` (`VaultFactory.sol:54`). A factory constructed `true` is sub-vault-enabled **forever** — no admin, no upgrade, no second chance — and that reopens C-1 and the sub-vault Highs H-5/H-6. `Deploy.s.sol:79` does pass `false`, so this is not a defaulting hazard; what is unverified is that the deploy *transaction* ran that script unmodified. **Verify the artifact, not the intent.** | `cast call <factory> "allowSubVaults()(bool)" --rpc-url <base-mainnet>` returns **`false`** — run **after** the deploy, before any vault is created |
| **Branch protection on `protocol/main`** | Its absence is why fourteen PRs sit 61–104 commits behind with green checks earned on stale bases. | **Currently unprovable.** `gh api repos/SlumperSan/agent-governed-vaults/branches/protocol/main/protection` returns **403 — "Upgrade to GitHub Pro or make this repository public"**. The owner must upgrade, make the repo public, or accept this as unverifiable and say so. Do not write a check whose command cannot run. |
| **Entity, jurisdiction, counsel** | **Parallel, NOT blocking** (owner directive 2026-09-02). Still gates moving mainnet funds; gates no agent work. | `gtm-counsel-engagement` — owner's own record |

No agent runs anything needing a private key, a funded account, `--broadcast`, or mainnet. Every
command in this file is read-only.

---

## 5. Cohort readiness

| Item | Pass condition | State 2026-09-01 |
| --- | --- | --- |
| Beachhead list resolved | ~150 named individuals, DeFi-native and sovereignty-first, on Base | **Partial** — 62 delivered from Farcaster (`gtm-beachhead-list`, done). The gap to 150 needs X and Discord and a human to work them. |
| Agent policy published | Vault #1's deterministic policy is public before the first proposal | Not yet — `gtm-agent-policy-published` |
| Launch + incident comms staged | Every sentence verified against the contracts; pre-clearance optional, accuracy is not | `gtm-launch-comms-staged`, ready |
| Ecosystem placements drafted | Base, Chainlink, DeFiLlama packets drafted; **submitted only after claims clear** | `gtm-ecosystem-placements`, ready |
| Cap selects the cohort | First vault `capacityCapUsdc` = 50,000 USDC, immutable per vault ([LAUNCH-READINESS.md](LAUNCH-READINESS.md) §2) | Argued, not yet deployed |
| Anchor discipline | Hold for ~30 real depositors rather than a fast 2-whale fill | Owner ratification pending (§4) |

---

## 6. Abort criteria — what stops Ops6 mid-release

**Read this first: there is no pause.**

```bash
grep -rniE "pause|pausable|setPaused" contracts/src/
```

Zero functional matches — only comments about deprecated Chainlink feeds. `VaultFactory` has no
owner and no admin setter; its only mutating externals are `createVault` and `createChildVault`.
There is no halt, no upgrade, no admin key. **After the mainnet deploy the protocol cannot be
stopped**, and that is not an oversight — it is the product's promise, and it is why the back-out
path has to be written down before the deploy rather than discovered after it.

### The only levers that exist

1. **Do not call `createVault`.** Before the first vault exists, aborting is free and complete. This
   is the only clean abort, and it is the reason the ordering in §4 puts the operator Safe and the
   posture ratification *before* the deploy.
2. **The immutable `capacityCapUsdc`** (50,000 USDC) bounds the worst case for vault #1. It cannot
   be lowered once set.
3. **Members exit via `requestExit` → `settleQueuedExit`.** Mode-F, at fair value, no lockup, no
   veto. Nobody — including the owner — can block it. This is the member-side back-out and it works
   whether or not we are cooperating.
4. **Off-chain withdrawal.** Stop the agent-operator proposing; take down the facilitator. This
   halts *new* rebalances. It does not touch deposits, exits, or anything already on-chain.

That is the complete list. Any plan that assumes more than these four is wrong.

### Triggers — stop and do not proceed if

| Trigger | How it shows up |
| --- | --- |
| Canary `NOT OK` on a live transition | `oracle-freshness|<vault>|<asset>` or `exit-liveness|<vault>` — the shapes recorded in [RESTORE-DRILL.md](RESTORE-DRILL.md) §4 |
| Oracle staleness past the configured bound | `maxStalenessSeconds` = 86,400 in `base-sepolia.json`; `ChainlinkOracle` reverts `StaleOracle` rather than falling through |
| A feed's denomination, heartbeat or sane-price band breaches on-chain | The three `SECURITY:` guards added after the audit — if one fires, gate 1's stale attestation becomes the live question |
| `verify-deployment-currency.mjs` goes red between the freeze and the deploy | Someone merged to `contracts/src` after the freeze; the audited/tested tree is no longer the tree being deployed |
| CI red at the candidate ref, matched by `headSha` | §2.3 |
| The cap fills from 2 addresses | Anchor discipline broken; the cohort thesis is not being tested |
| Any public surface drifts from `core-claims-doc.md` | The §3 drift check reds. A single falsifiable public claim permanently burns the only moat here. |

### Backing out, by phase

- **Before the mainnet deploy** — stop. Nothing is irreversible yet except an already-registered
  operator EOA (§4). Cost: time.
- **After the deploy, before the first vault** — stop. The singletons are inert without a vault; do
  not call `createVault`. Cost: gas.
- **After the first vault, before deposits** — announce, do not solicit. An empty vault is harmless.
- **After deposits** — you cannot stop it. Publish the pre-cleared incident comms (§5) verbatim,
  point members at `requestExit`, and stop proposing. Members exit at fair value; that is the whole
  design. Do not improvise comms under time pressure — that is what staging them was for.
  **Not ready yet, and this is on the critical path (§verdict step 1):** `docs/INCIDENTS.md`'s NAV
  reconciliation omitted the child look-through leg, so the runbook reports a **false shortfall** —
  read under pressure, in the one phase whose back-out line is *"you cannot stop it"*. Do not enter
  this phase until **PR #133** has landed.

---

## Running the whole thing

```bash
npm run cc && node scripts/verify-deployment-currency.mjs --onchain && node scripts/verify-deployment-reproducibility.mjs && npm run gate
```

Everything above is read-only and needs no key. The commands that do need one are in §4, and only
the owner runs them.
