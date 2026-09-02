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

**Measured 2026-09-01 against `protocol/main` @ `bab5ee90`.** Every status below is a measurement
with a re-run command next to it. Re-run before trusting any of it.

---

## Current verdict — **NO-GO**

Six things stand between here and a mainnet deploy. In dependency order — each blocks the ones
below it, so this is the shortest path, not a wish list:

| # | Blocker | Whose | Proves clear when |
| --- | --- | --- | --- |
| 1 | **#108 and #120 land.** #108 gates the mainnet deploy and has no verdict; #120 keeps a HIGH live on `main` until it lands. Both need a verdict, a rebase to `behind_by 0`, and re-green. | agents + an independent reviewer | `gh pr list --state open` shows neither; `gh run list --branch protocol/main` green at the new head SHA |
| 2 | **Owner decides freeze-or-redeploy.** Every `contracts/src` merge invalidates the testnet deploy that gates 2, 3 and 6 rest on. Until this is decided, closing those gates is a treadmill. | **owner only** | `Decisions/freeze-or-redeploy.md` status ≠ open |
| 3 | **Owner re-attests gate 1**, or accepts a named residual. The audited tree and the deployed tree are the same tree, and **both are 31 `contracts/src` commits behind `main`** (§1 gate 1). | **owner only** — it is an attestation | `LAUNCH-READINESS.md` gate 1 names a commit that is `protocol/main`'s head |
| 4 | **Testnet redeploy at the frozen head, in the LAUNCH configuration** (`allowSubVaults = false`). Needs a funded Base Sepolia key. | **owner only** (key) | `node scripts/verify-deployment-currency.mjs` exits 0 with no notes |
| 5 | **Re-earn gates 2, 3, 6 and finish gate 7** against that new deployment. Order matters: the gate-7 drill consumes artifacts from daemons watching a live deployment, so running it before step 4 means running it twice. | agents, after step 4 | §1 rows 2/3/6/7 |
| 6 | **Owner-only mainnet items** — operator payout Safe, launch posture, branch protection (§4). | **owner only** | §4 |

Legal (entity, jurisdiction, counsel) is **parallel and NOT blocking**, per the owner directive of
2026-09-02. It is not in this list on purpose. It still gates *moving mainnet funds*; it does not
gate agent work, and the constraint that replaces it is claim accuracy (§3).

---

## 1. Blocking gates — by reference

Authoritative text: [LAUNCH-READINESS.md](LAUNCH-READINESS.md) §1. Do not copy its evidence prose
here. Status column measured 2026-09-01.

| Gate | Status now | What earns it | Who |
| --- | --- | --- | --- |
| **0** No unfixed Criticals | GO (root-only) | Holds only while `allowSubVaults = false` on the deploy path. Re-check after any redeploy: `node scripts/verify-deployment-currency.mjs` must print no `allowSubVaults` note. | agent |
| **1** External audit | **STALE — newly found, see below** | Owner re-attests against the current head, or records a named residual for the 31-commit delta. Cannot be delegated. | **owner** |
| **2** Testnet lifecycle | **STALE** (was GO 2026-09-01) | `node scripts/smoke-test.mjs` ten phases against a *current* deployment. Needs a funded testnet key. | owner (key) → agent |
| **3** Soak drills | **STALE** | `scripts/soak/` re-run against a current deployment. **Open question — see below.** | owner (key) → agent |
| **4** Live x402 settlement | GO (unaffected) | Off-chain + USDC `transferWithAuthorization`; no contract in the delta touches it. Nothing to re-earn. | — |
| **5** Mainnet oracle config | **UNVERIFIABLE here** | `contracts/config/deployments/` contains only `base-sepolia.json` — there is no `base-mainnet.json` in the tree to verify. `node scripts/verify-mainnet-config.mjs` once one exists. | owner (deploy) → agent |
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
`abed2e5d`. `protocol/main` is `fe05004d`. So the audit is behind `main` by exactly the same 31
commits as the deployment, among them eight that change contracts — five of which say `SECURITY:`
in their own subject line (oracle basket-pricing brick, Chainlink feed denomination, heartbeat and
sane-price bounds, read-only reentrancy, nested `executeSwap`), plus a 3,849-byte `VaultCore`
size reclaim.

This does **not** say the tree is less safe — most of that delta is hardening that landed *after*
the audit. It says the attestation covers a tree that is not the tree. Only the owner can re-attest.
`LAUNCH-READINESS.md` is authoritative and is deliberately not edited by this file.

### Gate 3 has an open question the owner must answer

`SOAK-REPORT.md`'s five drills include sub-vault aggregation and SV-7 look-through. Those exist only
because `allowSubVaults = true`. On the launch configuration (`allowSubVaults = false`, which is what
closes C-1) **`createChildVault` reverts and those drills are unreachable.** So "re-run the 5 soak
drills" is not executable as written against a launch-configured deployment. Either gate 3 is
re-scoped to the reachable drills, or the redeploy is deliberately non-launch-configured and gate 3
is explicitly evidence about a different configuration. That is a judgement about what the gate
means — owner's call, not an agent's.

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

Enumerated from `gh`, not from the vault. **Only 2 of the 14 open PRs gate release.**

```bash
gh pr list --state open --limit 50 --json number,title,reviewDecision,mergeStateStatus
```

| PR | Why it gates | Measured 2026-09-01 |
| --- | --- | --- |
| **#108** adapter scoped sweep | Gates the mainnet deploy. | `reviewDecision` **NONE** — no verdict at all. `mergeStateStatus` **DIRTY** (real conflicts). `behind_by 66`. |
| **#120** indexer exit/fee/gov ABIs | A HIGH from #107 stays live on `main` until it lands. | `reviewDecision` **NONE**. `mergeStateStatus` CLEAN. `behind_by 61`. |

The other twelve (#106, #110, #111, #112, #115, #116, #118, #122, #124, #126, #127, #128) are open,
not gating: Slither triage docs, canary signal fixes, supply-chain pins, member docs. They are
merge-queue work, not release work.

Three facts about all fourteen that matter more than the individual rows:

- **None has a `reviewDecision`.** All fourteen read `NONE`.
- **Every one is behind `main` by 61–104 commits.** `mergeStateStatus: CLEAN` means *no conflict*,
  not *up to date*. Their green checks were earned on a base 61–104 commits stale, so no merge is
  admissible on that green — each needs a rebase and a re-run first. Seven are `DIRTY` with real
  conflicts: #108, #110, #111, #115, #118, #124, #126.
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

Measured 2026-09-01: head `bab5ee90`, run `33586340700`, `headSha bab5ee90…`, `success`,
`contracts`/`backend`/`slither` all green. The transient Foundry-download reset the handoff mentions
is resolved. Locally, `npm run gate` is the ~30 s mirror.

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
| The lede says who does what | README line 1, `llms.txt` and the web discover view no longer say AI agents *pool* and *govern*. Members pool and vote; the agent-operator only **proposes**. | `gtm-fix-lede-mechanics` (LedeFix) — in flight |
| A drift check exists and is green | LedeFix ships a repo check that reds when any of the seven surfaces drifts from the canonical sentence. Run it; do not read it. | LedeFix |
| The check covers *every* approved sentence | The drift check is keyed by claim id across all claims in `core-claims-doc.md`, not just the lede. | `gtm-claims-pipeline` — **sequenced strictly after LedeFix**; both edit the same files |
| Every PROOF field re-verified | Each claim's PROOF in `core-claims-doc.md` re-read against current `contracts/src`. Only two have had this run. | `gtm-claims-pipeline` |
| Agent policy published | Vault #1's deterministic rebalance policy exists and is public **before** the first on-chain proposal, so proposals are checkable against it. | `gtm-agent-policy-published` (AgentPolicy) |

`core-claims-doc.md` is LedeFix's file; nothing else writes to it while that task is open.

---

## 4. Owner-only — cannot be delegated

Each of these is irreversible or needs something no agent has (a key, a funded account, an
attestation, a payment). The irreversibility is stated plainly because that is the whole reason
they are on a separate list.

| Item | Irreversibility | Pass |
| --- | --- | --- |
| **Operator payout is a Safe, never an EOA** | `OperatorRegistry` has **no rebind** — `registerOperator` "can never rebind an existing operator" (`contracts/src/OperatorRegistry.sol:87`, CM-4). An EOA here **permanently** forecloses any future protocol fee split. Free, one afternoon, and the easiest thing on the board to get wrong by default. | The registered operator address is a deployed Safe, verified by reading it back on-chain before any vault is created |
| **Freeze the tree, or make redeploy part of the gate** | Not irreversible, but it is the decision that unsticks gates 2/3/6. Without it, every merge re-stales them. | `Decisions/freeze-or-redeploy.md` status ≠ open |
| **Re-attest gate 1** | An attestation about a private report; no agent can make it. | `LAUNCH-READINESS.md` gate 1 names the current head |
| **Ratify no-token / beachhead / anchor strategy** | A token, once issued, cannot be un-issued; a public posture cannot be un-said. | `gtm-ratify-launch-posture` ratified or overridden |
| **Testnet redeploy** | Needs a funded Base Sepolia key. Must be in the **launch** configuration (`allowSubVaults = false`) or the re-earned evidence is again about the wrong contracts. | `verify-deployment-currency.mjs` exits 0, no notes |
| **Mainnet deploy** | Immutable. No pause, no upgrade, no admin (§6). One shot. | `Deploy.s.sol` run with `--broadcast`; `base-mainnet.json` recorded and verified |
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

---

## Running the whole thing

```bash
npm run cc && node scripts/verify-deployment-currency.mjs --onchain && node scripts/verify-deployment-reproducibility.mjs && npm run gate
```

Everything above is read-only and needs no key. The commands that do need one are in §4, and only
the owner runs them.
