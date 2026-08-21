# Base Sepolia Testnet Run — Report

**Status: DEPLOYED AND VERIFIED — awaiting the human-signed smoke run.**

The blocker that stopped the first attempt is **resolved**: the Sprint-8 merge train landed, so
`protocol/main` now carries the EIP-170 fix, the canary, and the reference agent, and
`forge build --sizes` exits 0. Pre-flight has been re-run against that base and is green.

**The protocol is deployed and independently verified on Base Sepolia** (§6) — 17 transactions, all
successful, 0.000078948396 ETH, every address and wire confirmed by direct chain reads rather than
from the deploy log. That distinction turned out to matter: forge mislabelled contracts in its own
output, and taking it at face value would have swapped `VaultFactory` and `VaultDeployer` in the
address book (§6.3).

The run now waits on the human-signed smoke test (§7). Nothing in this session broadcast a
transaction or handled a key — all verification here is `cast call` / `cast receipt`.

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

## 6. Deploy — ✅ COMPLETE

Broadcast by the human on 2026-08-21 from `C:\Users\Micha\desktop\x402-testnet`, source commit
`153d4cf3`. Every transaction succeeded (`status 1`), all in a single block.

| | |
| --- | --- |
| Deployer | `0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35` (nonce 0 at deploy) |
| Block | **45784186** — also the indexer `START_BLOCK` |
| Transactions | 17 (14 CREATE + 3 wiring CALLs), all successful |
| Gas used | **13,158,066** |
| Gas price | 0.006 gwei |
| **Total paid** | **0.000078948396 ETH** |
| Basescan verification | ✅ all 14 contracts `Pass - Verified` |

Pre-deploy balances (confirmed on-chain before broadcast): **0.5 ETH**, **20.0 USDC** at the
canonical Circle testnet token — comfortably above the checklist's ≥ 0.05 ETH / ≥ 10 USDC.
The deploy consumed **0.016 %** of the ETH balance.

A no-broadcast simulation was run first (`forge script … --sender 0x0f80…`, no `--broadcast`). It
completed with all eight wiring assertions passing and predicted every address correctly — the
live deployment matched the prediction exactly, since CREATE addresses are deterministic from
sender and nonce.

### 6.1 Address book — independently verified

Committed to
[`contracts/config/deployments/base-sepolia.json`](../contracts/config/deployments/base-sepolia.json).
Every address below was confirmed by reading the chain, **not** by trusting the deploy log — see
the deviation in §6.3 for why that distinction mattered here.

| Contract | Address | On-chain codesize | Expected | ✓ |
| --- | --- | --- | --- | --- |
| OperatorRegistry | `0xC5F3A734618019C4abE512dD9BF3D5B852494bDB` | 2,219 | 2,219 | ✅ |
| SubVaultRegistry | `0x0C60b9a4C207dd622CcC0Ee3C51b5c274cb7B979` | 1,605 | 1,605 | ✅ |
| FeeEngine | `0xDEb08dCF5ceaf00c95E2C355CB63aC334C7e3fBc` | 2,983 | 2,983 | ✅ |
| Governance | `0x4AddcAc4834a8672edb4Aef25c33D7909865091c` | 11,990 | 11,990 | ✅ |
| VaultDeployer | `0x2c70858BA8796398CC7638389155d1Cc0426533D` | 938 | 938 | ✅ |
| VaultFactory | `0x79279FBa3b6F6736f07cbBFcB7Cf0559466D5bfB` | 2,718 | 2,718 | ✅ |
| OracleAggregator | `0xEc1976579Af27b3dF5fd103390acAb22E4b566F4` | 1,212 | 1,212 | ✅ |
| AggregationRouterAdapter | `0x1D8794279035CC04C9BCF939AB956845916998c1` | 2,066 | 2,066 | ✅ |

Runtime codesize matching the compiled size **exactly** for all eight is what establishes identity
independently of any label in the tooling output.

Six `ChainlinkSourceAdapter` instances (636 B each), three per asset:

| Asset | Sources | Underlying feed |
| --- | --- | --- |
| WETH | `0x790A308f…5B125`, `0xc36198FD…AF05a`, `0xc44B853F…88Fd1` | ETH/USD `0x4aDC6769…c7cb1` |
| LINK | `0xd415F712…57869`, `0x9B2B1DF6…66fFF`, `0x61a840C5…8e096` | LINK/USD `0xb113F5A9…5A61` |

### 6.2 Wiring — verified by direct reads

Every one-shot wire asserted from the chain:

| Read | Value | Points at | ✓ |
| --- | --- | --- | --- |
| `registry.factory()` | `0x79279FBa…D5bfB` | VaultFactory | ✅ |
| `registry.feeEngine()` | `0xDEb08dCF…e3fBc` | FeeEngine | ✅ |
| `subReg.factory()` | `0x79279FBa…D5bfB` | VaultFactory | ✅ |
| `gov.subVaultRegistry()` | `0x0C60b9a4…7B979` | SubVaultRegistry | ✅ |
| `factory.registry()` | `0xC5F3A734…94bDB` | OperatorRegistry | ✅ |
| `factory.governance()` | `0x4AddcAc4…5091c` | Governance | ✅ |
| `factory.feeEngine()` | `0xDEb08dCF…e3fBc` | FeeEngine | ✅ |
| `factory.subVaultRegistry()` | `0x0C60b9a4…7B979` | SubVaultRegistry | ✅ |
| `factory.vaultDeployer()` | `0x2c70858B…26533D` | VaultDeployer | ✅ |
| `routerAdapter.router()` | `0x94cC0AaC…12bc4` | canonical Uniswap SwapRouter02 | ✅ |

**Oracle config and live pricing** (`aggregator.assetConfig` + `priceWad` per asset):

| Asset | sources | quorum | maxStaleness | `priceWad` live |
| --- | --- | --- | --- | --- |
| WETH | 3 | 2 | 86,400 | `2425264600000000000000` → **$2,425.26** |
| LINK | 3 | 2 | 86,400 | `11647277610000000000` → **$11.65** |

Both price through the real feeds and return sane values, so the oracle path is live end-to-end.

### 6.3 Deviation — forge mislabelled contracts in its own output

**Severity: cosmetic (tooling), no on-chain impact. Not a repo defect — no issue filed.**

The deploy output disagreed with itself. Its per-transaction receipt lines paired contract *names*
with the wrong *addresses* — e.g. it printed `Contract: VaultFactory` for the transaction that
actually created `VaultDeployer`, and `Contract: SubVaultRegistry` against `OperatorRegistry`'s
address. The broadcast JSON has the same class of problem in a different place: its
`transactions[i].contractName` does not align with the receipt reached through
`transactions[i].hash`.

Taking either at face value would have produced a **wrong address book** — specifically swapping
`VaultFactory` and `VaultDeployer`, which would then have broken the indexer's factory watch and
every downstream consumer.

Three independent sources agree with each other and with what is recorded above:

1. **The `== Return ==` block** — typed named returns from the script itself.
2. **On-chain `codesize`** — all eight match their compiled sizes exactly (table in §6.1).
3. **Basescan verification** — each address verified against the correct source file.

A fourth check settled it physically: `VaultDeployer` used **5,669,107 gas** while `VaultFactory`
used **643,159**. A 2,718-byte contract cannot cost 5.6 M gas; a 938-byte contract whose
constructor writes 24.7 KB of SSTORE2 data must. The gas confirms the codesize reading and
contradicts the tooling labels.

**Lesson for the mainnet runbook:** derive the address book from `== Return ==` plus on-chain
`codesize`, never from the per-transaction console labels or the broadcast JSON's `contractName`.

### 6.4 The two "no matching bytecode" addresses — expected, not an error

Verification warned it could not match bytecode for `0xf449c167…84bb` and `0x896114ba…3e1f`. These
are the `VaultDeployer`'s **SSTORE2 data contracts**, written by its constructor to hold
`VaultCore`'s creation code. Confirmed arithmetically:

```
12,366 + 12,367 = 24,733 bytes
       − 2 STOP prefix bytes  =  24,731  ← exactly VaultCore's initcode size
```

Both begin with the `0x00` STOP byte that makes them non-executable data. They have no source to
verify against because they are not compiled contracts. This is the PX-4 design working as
specified, and it is the mechanism that got `VaultFactory` from 27,241 B under the EIP-170 cap.

### 6.5 Gas actually paid, per contract

Keyed by address from `cast receipt` — **not** from the broadcast JSON, per §6.3.

| Contract | Gas | Share |
| --- | --- | --- |
| VaultDeployer | 5,669,107 | 43.1 % |
| Governance | 2,643,687 | 20.1 % |
| FeeEngine | 699,107 | 5.3 % |
| VaultFactory | 643,159 | 4.9 % |
| OracleAggregator | 638,154 | 4.8 % |
| AggregationRouterAdapter | 551,603 | 4.2 % |
| OperatorRegistry | 532,777 | 4.0 % |
| SubVaultRegistry | 400,053 | 3.0 % |
| 6 × ChainlinkSourceAdapter | 203,801 each (1,222,806) | 9.3 % |
| 3 × wiring CALL | 69,074 / 44,463 / 44,076 | 1.2 % |
| **Total** | **13,158,066** | **0.000078948396 ETH** |

`VaultDeployer` dominating at 43 % is the expected cost of the EIP-170 fix: paying ~200 gas/byte to
put `VaultCore`'s 24.7 KB creation code on chain once, so the factory never has to carry it.

---

## 7. Smoke test — PENDING (human-signed)

Awaiting the human-run `node scripts/smoke-test.mjs`. Roughly 6–7 h wall clock: a 4 h observation
window plus 1 h commit and 1 h reveal. Resumable — `Ctrl+C` and re-run resumes at the pending phase.

Each phase will be verified independently against the chain here as it lands.

*(Sections 8–10 — runtime stack, canary observations, agent dry-run transcript — follow the smoke
run.)*
