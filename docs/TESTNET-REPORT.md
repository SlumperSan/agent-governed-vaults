# Base Sepolia Testnet Run — Report

**Status: ⛔ PRE-FLIGHT ONLY — the lifecycle was NOT run.**

This report records Sprint 9 pre-flight verification. No deployment was made, no transaction was
broadcast, and no lifecycle phase was exercised. The run is **blocked on repository state**, not on
infrastructure: the base revision named in the sprint brief does not exist, and two of the four
runtime components Sprint 9 must exercise are not present on any candidate base. Details in §4.

Sprint issue: [#15](https://github.com/SlumperSan/agent-governed-vaults/issues/15) — **left open.**

| | |
| --- | --- |
| Date (UTC) | 2026-08-20 |
| Report branch | `sprint-9/testnet-run` (from `protocol/main` @ `20d1b4f8`) |
| Chain | Base Sepolia, chainId **84532** |
| RPC | `https://base-sepolia-rpc.publicnode.com` |
| Chain interaction | **read-only** (`cast call` / `cast block`) — no key handled, nothing signed |

---

## 1. Toolchain

| Tool | Version | Required | OK |
| --- | --- | --- | --- |
| forge | 1.7.1 (`4072e487`) | v1.7.1 | ✅ |
| cast | 1.7.1 (`4072e487`) | v1.7.1 | ✅ |
| node | v24.18.0 | ≥ 20 | ✅ |

RPC liveness: `chainId` = **84532** (matches the config's expected value), head block **45740507**,
latest block timestamp `1787249334` (Thu 2026-08-20 18:08:54 UTC). `sepolia.base.org` was not used —
the publicnode endpoint responded normally throughout, consistent with the known-infra note.

---

## 2. Config addresses — verified live on-chain

Every address in [`contracts/config/base-sepolia.json`](../contracts/config/base-sepolia.json) was
read back from the live chain. **All six match the committed config exactly.**

### Tokens

| Role | Address | `symbol()` | `decimals()` | Config expects | OK |
| --- | --- | --- | --- | --- | --- |
| Settlement | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `"USDC"` | 6 | USDC, 6 | ✅ |
| Basket | `0x4200000000000000000000000000000000000006` | `"WETH"` | 18 | WETH, 18 | ✅ |
| Basket | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` | `"LINK"` | 18 | LINK, 18 | ✅ |

### Chainlink feeds

| Address | `description()` | `decimals()` | Latest answer | `updatedAt` | Age at check | OK |
| --- | --- | --- | --- | --- | --- | --- |
| `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | `"ETH / USD"` | 8 | `232952631758` → **$2,329.53** | `1787249318` | **16 s** | ✅ |
| `0xb113F5A928BCfF189C998ab20d753a47F9dE5A61` | `"LINK / USD"` | 8 | `1070832000` → **$10.708** | `1787249180` | **154 s** | ✅ |

Both feeds are **fresh** against the config's `maxStalenessSeconds = 86400`. The `StaleOracle`
preflight warning described in TESTNET-CHECKLIST §6 is **not** expected for a run started now.

### Router

| Address | Check | Result | OK |
| --- | --- | --- | --- |
| `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4` | `codesize` | 24,497 B (code present) | ✅ |

Pinned as Uniswap SwapRouter02, with only `exactInputSingle` / `exactInput` allow-listed.

> **Carried forward, not a new finding:** the oracle config lists the *same* Chainlink feed three
> times per asset to satisfy the `OracleAggregator` ≥3-source floor (2-of-3 quorum over three
> distinct adapter instances). This is the documented, deliberate testnet compromise — it is **not**
> SF-1 mechanism diversity. Already recorded in the config's `testnetCompromise` field and in
> TESTNET-CHECKLIST §3; restated so this run record stands alone.

---

## 3. `forge build --sizes` — RED on the stated base

Measured directly in this session on both candidate revisions.

### On `protocol/main` @ `20d1b4f8` (the base named in the brief)

| Contract | Runtime (B) | Runtime margin (B) | EIP-170 |
| --- | --- | --- | --- |
| `VaultCore` | 23,016 | 1,560 | ✅ |
| **`VaultFactory`** | **27,241** | **−2,665** | ❌ **OVER CAP** |
| `VaultDeployer` | *(does not exist)* | — | — |

### On `sprint-7/eip170-fix` @ `b9355d54` (PR #17, unmerged)

| Contract | Runtime (B) | Runtime margin (B) | EIP-170 |
| --- | --- | --- | --- |
| `VaultCore` | 23,016 | 1,560 | ✅ |
| **`VaultFactory`** | **2,718** | **21,858** | ✅ |
| `VaultDeployer` | 938 | 23,638 | ✅ |

All other contracts sit comfortably under cap on both revisions (largest remaining: `Governance`
11,990 B, margin 12,586 B).

**Consequence:** on `protocol/main` the one-command deploy in TESTNET-CHECKLIST §3 reverts before
any vault exists. Funding a key and broadcasting against that base would burn faucet funds for
nothing — exactly the failure the checklist's own ⛔ banner warns about.

> **Observation (not a bug — no issue filed):** the fix relocates `VaultCore`'s creation code rather
> than shrinking `VaultCore`, which still sits at 23,016 B with only **1,560 B** of headroom. That is
> by design and the contracts are post-review; noted because future `VaultCore` growth has little
> room before meeting the same wall the factory just cleared.

---

## 4. Why the run is blocked

The brief states the base is `protocol/main` @ **v0.1.0-rc2 — CI fully green including sizes**. Four
verified facts contradict that. Issue #15 itself says *"Run AFTER Sprint 8 (rc2, CI fully green)"* —
**Sprint 8 never landed.**

| # | Claim in brief | Verified reality | Evidence |
| --- | --- | --- | --- |
| 1 | base @ `v0.1.0-rc2` | **No such tag.** Only `v0.1.0-rc1` exists | `git fetch --all --tags`; `git tag -l` |
| 2 | sizes green | `VaultFactory` **−2,665 B** over cap | `forge build --sizes` on `20d1b4f8` (§3) |
| 3 | fix is in the base | `origin/protocol/main` = `20d1b4f8`, lacks `12b49d80` | `git branch -a --contains 12b49d80` → fix branch only |
| 4 | Sprint 8 merged | PR #17 **OPEN**, `reviews: []`, `reviewDecision: ""` | `gh pr view 17` |

### The gap is wider than the EIP-170 fix

Sprint 9 step 4 must run the **indexer, API, canary, and reference agent**. The canary and the
reference agent are on neither `protocol/main` nor `sprint-7/eip170-fix` — they live on their own
unmerged branches:

| PR | Branch | Provides | State |
| --- | --- | --- | --- |
| [#17](https://github.com/SlumperSan/agent-governed-vaults/pull/17) | `sprint-7/eip170-fix` | deployable `VaultFactory` + `VaultDeployer` | OPEN, CI green, **0 reviews** |
| [#11](https://github.com/SlumperSan/agent-governed-vaults/pull/11) | `sprint-5/canary` | `docs/CANARY.md`, `packages/canary/` | OPEN, unmerged |
| [#12](https://github.com/SlumperSan/agent-governed-vaults/pull/12) | `sprint-6/reference-agent` | `packages/reference-agent/` | OPEN, unmerged |

**No single revision in the repository contains all three.** Choosing a different base does not
unblock the run; landing the Sprint-8 merge train does. Note too that TESTNET-CHECKLIST §3 on
`protocol/main` already documents `VaultDeployer` — the committed docs describe a contract that
exists only in the unmerged #17.

### Merge order is forced — and #11/#12 are not actually broken

The `contracts` check fails on **#11 and #12** but passes on **#17**. Inspecting the failing job
([run 32286311397](https://github.com/SlumperSan/agent-governed-vaults/actions/runs/32286311397/job/96176551996))
shows the failure is **entirely the inherited size gate**, not anything those branches changed:

```
[PASS] invariant_feeNeverExceedsNetGainTenth()  (runs: 256, calls: 16384, reverts: 0)
[PASS] invariant_revealedNeverExceedsSnapshot() (runs: 256, calls: 16384, reverts: 0)
Run forge build --sizes
Error: some contracts exceed the runtime size limit (EIP-170: 24576 bytes)
| VaultFactory | 27,241 | 27,524 | -2,665 | 21,628 |
```

Their own suites are green; they inherit `protocol/main`'s oversized factory and trip the size gate
that CI runs last. So the order is forced:

1. Review and merge **#17** — it is `MERGEABLE / CLEAN` with all three checks green.
2. Rebase **#11** and **#12** onto the new `protocol/main`; their `contracts` check should go green
   with no code change, since the size gate is the only thing failing. Both are currently
   `MERGEABLE / UNSTABLE` — unstable *because* of that check, not because of conflicts.
3. Tag `v0.1.0-rc2` and confirm CI green on `protocol/main`.

All three PRs have `reviewDecision: ''` (no reviews). #17 is the one that genuinely needs a contract
review before merging — it changes the deployment shape.

### Not done, and why

- **No faucet funding requested.** Pointless until the base is settled; the deploy would revert
  regardless of balance.
- **No deploy command handed over.** It would have reverted on the stated base.
- **No integration branch created.** #17 is unreviewed and, by its own title, *changes the deployment
  shape*. Merging unreviewed contract changes so they can be broadcast is the "contract bugs get
  issues, not hotfixes" constraint in another form. That call belongs to the human.
- **No issues filed.** Nothing found is a defect — the config is correct, every address verifies, the
  toolchain is right. The blocker is repository/process state, which belongs in this report and in
  the Sprint-8 merge train, not in a new bug issue.
- **Issue #15 left open.** Its precondition (Sprint 8 / rc2) is unmet, and its DONE criterion — a full
  green lifecycle with indexer/API/canary/agent all exercised — is not met.

---

## 5. What is ready to go

Everything not dependent on the blocked base is verified and will not need redoing:

- ✅ RPC endpoint live, correct chain, no 503s observed
- ✅ All 6 config addresses confirmed on-chain (symbol / decimals / description all match)
- ✅ Both Chainlink feeds fresh — no stale-oracle warning expected
- ✅ Router has code at the pinned address
- ✅ Toolchain at required versions
- ✅ Size profile characterised on both candidate revisions

**To unblock:** land the Sprint-8 merge train (#17 reviewed + merged, plus #11 and #12), tag
`v0.1.0-rc2`, confirm CI green including sizes on `protocol/main` — then re-run this pre-flight
(cheap, ~2 min) and proceed to funding and deploy.
