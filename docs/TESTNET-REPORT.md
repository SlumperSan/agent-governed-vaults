# Base Sepolia Testnet Run — Report

**Status: PRE-FLIGHT GREEN — awaiting the human-signed deploy.**

The blocker that stopped the first attempt is **resolved**: the Sprint-8 merge train landed, so
`protocol/main` now carries the EIP-170 fix, the canary, and the reference agent, and
`forge build --sizes` exits 0. Pre-flight has been re-run against that base and is green.

Nothing has been deployed yet. No transaction has been broadcast, no key handled. The run resumes at
§6 the moment a funded deployer key exists.

Sprint issue: [#15](https://github.com/SlumperSan/agent-governed-vaults/issues/15) — **open until a
full green lifecycle is documented here.**

| | |
| --- | --- |
| Report branch | `sprint-9/testnet-run` (PR [#18](https://github.com/SlumperSan/agent-governed-vaults/pull/18)) |
| Base | `protocol/main` @ `5081f9b9` (merge train complete; tags `v0.1.0-rc2`, `v0.2.0-audit`) |
| Chain | Base Sepolia, chainId **84532** |
| RPC | `https://base-sepolia-rpc.publicnode.com` |
| Chain interaction | **read-only** (`cast call` / `cast block`) — no key handled, nothing signed |

> **Worktree note.** This branch is worked in a **separate git worktree**, not the shared checkout at
> `C:\Users\Micha\desktop\x402` — that one was on `sprint-13/prod-ops` with uncommitted Sprint-13
> files and untracked Sprint-11 oracle files, and a branch switch would have swept another sprint's
> work into this PR. Concurrent sessions share this repo; see the `concurrent-sessions-git-add`
> note.

---

## 1. Toolchain

| Tool | Version | Required | OK |
| --- | --- | --- | --- |
| forge | 1.7.1 (`4072e487`) | v1.7.1 | ✅ |
| cast | 1.7.1 (`4072e487`) | v1.7.1 | ✅ |
| node | v24.18.0 | ≥ 20 | ✅ |

RPC liveness: `chainId` **84532**, head block **45748604**. `sepolia.base.org` was not used — the
publicnode endpoint responded normally throughout, consistent with the known-infra note.

---

## 2. Config addresses — verified live on-chain

Every address in [`contracts/config/base-sepolia.json`](../contracts/config/base-sepolia.json) was
read back from the live chain. **All six match the committed config exactly.** Re-verified against
the post-merge base.

### Tokens

| Role | Address | `symbol()` | `decimals()` | Config expects | OK |
| --- | --- | --- | --- | --- | --- |
| Settlement | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `"USDC"` | 6 | USDC, 6 | ✅ |
| Basket | `0x4200000000000000000000000000000000000006` | `"WETH"` | 18 | WETH, 18 | ✅ |
| Basket | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` | `"LINK"` | 18 | LINK, 18 | ✅ |

### Chainlink feeds

| Address | `description()` | `decimals()` | Age at check | vs `maxStaleness` 86,400 s | OK |
| --- | --- | --- | --- | --- | --- |
| `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | `"ETH / USD"` | 8 | **258 s** | fresh | ✅ |
| `0xb113F5A928BCfF189C998ab20d753a47F9dE5A61` | `"LINK / USD"` | 8 | **480 s** | fresh | ✅ |

No `StaleOracle` preflight warning (TESTNET-CHECKLIST §6) is expected for a run started now.

### Router

| Address | Check | Result | OK |
| --- | --- | --- | --- |
| `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4` | `codesize` | 24,497 B (code present) | ✅ |

> **Carried forward, not a new finding:** the oracle config lists the *same* Chainlink feed three
> times per asset to satisfy the `OracleAggregator` ≥3-source floor (2-of-3 quorum over three
> distinct adapter instances). This is the documented, deliberate testnet compromise — **not** SF-1
> mechanism diversity. Recorded in the config's `testnetCompromise` field and TESTNET-CHECKLIST §3.

---

## 3. `forge build --sizes` — GREEN

Measured on this branch over the post-merge base. **Exit code 0.**

| Contract | Runtime (B) | Runtime margin (B) | EIP-170 |
| --- | --- | --- | --- |
| `VaultCore` | 23,016 | 1,560 | ✅ |
| `VaultFactory` | **2,718** | 21,858 | ✅ |
| `VaultDeployer` | 938 | 23,638 | ✅ |
| `Governance` | 11,990 | 12,586 | ✅ |
| `FeeEngine` | 2,983 | 21,593 | ✅ |
| `OperatorRegistry` | 2,219 | 22,357 | ✅ |
| `AggregationRouterAdapter` | 2,066 | 22,510 | ✅ |
| `SubVaultRegistry` | 1,605 | 22,971 | ✅ |
| `OracleAggregator` | 1,212 | 23,364 | ✅ |
| `ChainlinkSourceAdapter` | 636 | 23,940 | ✅ |

> **Observation (not a bug — no issue filed):** the EIP-170 fix relocated `VaultCore`'s creation code
> rather than shrinking `VaultCore`, which still sits at 23,016 B with **1,560 B** of headroom. By
> design and frozen byte-identical at `v0.2.0-audit`; noted because future `VaultCore` growth has
> little room.

---

## 4. First attempt — blocker, now resolved

Recorded for the paper trail. The first Sprint-9 attempt (2026-08-20) stopped at pre-flight because
the base named in the brief did not exist: no `v0.1.0-rc2` tag, `protocol/main` lacked the EIP-170
fix, and `forge build --sizes` measured `VaultFactory` at **27,241 B — 2,665 B over the cap**, so the
checklist §3 deploy would have reverted before any vault existed. The canary (#11) and reference
agent (#12) were also absent from every candidate base. No funds were spent.

**All of that is now fixed.** `protocol/main` @ `5081f9b9` contains #17, #11, #12 and #19; tags
`v0.1.0-rc2` and `v0.2.0-audit` exist; sizes are green (§3); `docs/CANARY.md`,
`packages/canary/` and `packages/reference-agent/` are present.

One process note worth keeping: `gh pr view --json reviewDecision` returns `''` / `reviews: []` for
this repo's PRs, which reads as "unreviewed" but is not — reviews are posted as **issue comments**,
not formal review objects. Read `--json comments` before concluding a PR is unreviewed.

---

## 5. Observation on the deploy script

`DeployTestnet.s.sol` deploys `VaultDeployer` (line 80) and pins it into the factory (line 86), but
its `console2.log` block prints only seven addresses and **omits `VaultDeployer`**. Not blocking —
the address is recoverable from
`contracts/broadcast/DeployTestnet.s.sol/84532/run-latest.json` — and the deploy path is
deliberately **not** being edited immediately before a real broadcast, so the script stays exactly
what CI exercised. The address book in §7 will carry `VaultDeployer` regardless.

---

## 6. Deploy — PENDING (human-signed)

**Blocked on a funded deployer key.** `~/.foundry/keystores/` does not exist, so no key has been
imported. Current Base Sepolia gas price is **0.006 gwei**, so the checklist's ≥ 0.05 ETH is ample.

Handover instructions are in the session message. Nothing here can proceed until the human
completes the keystore import and funding, and the balances are confirmed on-chain.

*(Sections 7–11 — address book, lifecycle phases with independent verification, canary
observations, agent dry-run transcript, gas actually paid, and findings — are filled in as the run
progresses.)*
