# Changes Since the Internal Reviews

One page, for the external audit firm. It answers a single question: **between the internal
security reviews and the tree you are auditing, what changed — and which of it did internal review
actually look at?**

Written at the Sprint-10 freeze. Read it before
[AUDIT-HANDOFF.md](AUDIT-HANDOFF.md), because it tells you what that document's claims are
current as of.

---

## 1. The contract delta is one pull request

Measured, not asserted:

| Question | Command | Answer |
| --- | --- | --- |
| Did any contract change between `v0.1.0-rc1` and `protocol/main`? | `git diff v0.1.0-rc1..protocol/main -- contracts/src/` | **No** — empty |
| Did `VaultCore.sol` change in the EIP-170 fix? | `git diff protocol/main...sprint-7/eip170-fix -- contracts/src/VaultCore.sol` | **No** — empty, byte-identical |
| Do the canary / reference-agent branches touch contracts? | same, for `sprint-5/canary` and `sprint-6/reference-agent` | **No** — both empty |

So the entire contract-level delta since the Sprint-6 reviews is **PR #17, the EIP-170
deployment fix**:

| File | What changed |
| --- | --- |
| `src/VaultDeployer.sol` | **New.** 106 lines / 59 non-comment, ~25 assembly. Holds `VaultCore`'s creation code because EIP-170 leaves it nowhere else to live. Zero authority. |
| `src/VaultFactory.sol` | A fifth constructor parameter + `immutable`, and `_deploy` calling `vaultDeployer.deploy(abi.encode(...))` instead of `new VaultCore(...)`. Nothing else. |
| `script/Deploy.s.sol`, `script/DeployTestnet.s.sol` | Construct the deployer before the factory (forced: the pin is `immutable`). |
| `test/Eip170.t.sol` | **New.** 9 tests guarding the fix. |
| 7 existing test files | Fixture plumbing only — one import and one constructor argument each; the two deploy tests each gained an assertion. **No assertion was weakened.** |
| `.github/workflows/ci.yml` | Comment updates; then Sprint 10's F-3 filter fix. |
| `.gas-snapshot` | Regenerated **in Sprint 7**, when the fix was written. Sprint 10 did not re-run it — it read the diff entry by entry and reconciled every delta to the mechanism (review §4). |

**Why it was necessary, in one sentence:** any contract containing `new VaultCore(...)` embeds
VaultCore's whole *creation* code in its own runtime, and the sum does not fit — the initcode
measures **22,391 B** against a 24,576 B runtime cap (2026-09-02), leaving 2,185 B for a factory
whose own logic is 3,572 B. (This sentence said the creation code was 24,731 B and exceeded the cap
*by itself*. True when written; the figure has since moved below the cap, and the comparison with
it went too.) `VaultFactory` measured 27,241 B and was undeployable on any chain.

---

## 2. What internal review covered, and what it did not

| Round | Scope | Outcome |
| --- | --- | --- |
| [SPRINT1-SECURITY-REVIEW](reviews/SPRINT1-SECURITY-REVIEW.md) | `VaultCore` | 4 findings (H-1, H-2, M-1, M-2) — all fixed |
| [SPRINT6-EXECUTION-REVIEW](reviews/SPRINT6-EXECUTION-REVIEW.md) | Oracle / execution / sub-vaults | 8 findings (2H/5M/1L) — fixed or documented |
| [SPRINT6-GOVERNANCE-REVIEW](reviews/SPRINT6-GOVERNANCE-REVIEW.md) | Governance / economics | 5 findings — fixed or documented |
| [SPRINT6-GOVERNANCE-ACCEPTED-ROWS](reviews/SPRINT6-GOVERNANCE-ACCEPTED-ROWS.md) | The deliberately-Accepted governance rows | GA-1 found and fixed |
| [SPRINT10-DEPLOYMENT-REVIEW](reviews/SPRINT10-DEPLOYMENT-REVIEW.md) | The §1 delta — `VaultDeployer`, `VaultFactory._deploy`, the deploy scripts, and the test/CI edits beside them | **No High or Medium.** 4 findings, all dispositioned |

### Coverage, stated honestly

- **`VaultCore.sol` has three internal passes** and did not change since. Its walkthrough stands.
- **`VaultDeployer.sol` has exactly one** (Sprint 10). It is the newest code in the package and
  the only contract carrying hand-written assembly written after the Sprint-6 rounds. If your
  budget is uneven, this file (59 non-comment lines) has the least accumulated scrutiny per line.
- **`src/lib/` — `SafeTransferLib`, `BoundedCall`, `Checkpoints` — has never been seen by
  Slither.** Sprint 10 found that the CI filter `--filter-paths "lib|test|script"` was an
  unanchored regex that also matched `src/lib/`. Human review covered these files (the H-1 and
  H-2 fixes live there and were reviewed in Sprint 1); *static analysis* did not, for the whole
  life of the project until this freeze. The filter is now anchored and the resulting findings
  are triaged in [SLITHER-TRIAGE.md](reviews/SLITHER-TRIAGE.md). Treat any prior statement that
  reads as a Slither disposition for those files with that history in mind.
- **Slither is advisory in CI** (`continue-on-error: true`), so a new high-severity static finding
  does not turn CI red. It never has been blocking.
- **Accepted residual carried into the freeze:** `VaultFactory`'s constructor zero-checks none of
  its five immutables (review F-1, threat-model **PX-4**). Accepted rather than fixed — the
  reasoning, *including a toolchain constraint that made a contract fix impossible in that
  session*, is stated in full in the review. Worth your own judgement.

---

## 3. What is **not** in the tree you are auditing

Stated because the absence is easy to misread.

- **A Base Sepolia deployment exists, and since 2026-09-05 a Robinhood Chain mainnet one (chain 4663) does too; no Base mainnet deployment does.**
  [TESTNET-REPORT.md](TESTNET-REPORT.md) *was* a pre-flight record only, and this section said so
  for the life of the freeze. That is **no longer true**: PR #18 deployed the protocol to Base
  Sepolia — 17 transactions, deploy block 45784186, every address and wire confirmed by direct
  chain reads rather than from the deploy log — and ran the full lifecycle green. The addresses
  are recorded in
  [`contracts/config/deployments/base-sepolia.json`](../contracts/config/deployments/base-sepolia.json).
  **So there IS deployed bytecode to compare against, on Base Sepolia**, built from commit
  `153d4cf3`; the contract sources there are the frozen `v0.2.0-audit` tree. There is still no
  mainnet deployment, and `contracts/config/base-mainnet.json` (§5) is an unverified draft.
  *Corrected in Sprint 11* — the prior wording was written before PR #18 landed and would have
  told an auditor the opposite of the truth.
- **`v0.1.0-rc2` was never cut.** The Sprint-8 merge train did not run. Any document referring to
  an rc2 base is describing a plan, not a tag.
- **PRs #11 (canary) and #12 (reference agent)** contain no Solidity (§1) and are out of
  contract-audit scope either way. *Corrected in Sprint 11:* both are now merged, as are #17
  and #19 — see §4.
- **`v0.2.0-audit` now exists** and the §4 warning below no longer applies — see §4.

---

## 4. Which revision to audit

The intended audit reference is the tag **`v0.2.0-audit`**.

**Resolved in Sprint 11.** The tag exists, on `origin`, at `5081f9b9` — the head of
`protocol/main`. PRs #17, #19, #11 and #12 are all merged.

> **Historical note, kept because it explains a gap in the record.** At the Sprint-10 freeze the
> tag did *not* exist, and this section carried the reason: that session could not merge PR #17
> — the `gh pr merge` call was refused by the agent harness's permission classifier, and the
> equivalent local merge-and-push was declined as the same action by another name. The Sprint-8
> merge train ([issue #14](https://github.com/SlumperSan/agent-governed-vaults/issues/14)) was
> blocked on exactly this, which is why **no `v0.1.0-rc2` was ever cut** — that statement in §3
> still stands. A human with merge rights has since performed the merges and created the tag.


---

## 5. Post-freeze additions (Sprint 11) — outside `v0.2.0-audit`, INSIDE `v0.3.0-audit`

Everything above describes the tree **at** the `v0.2.0-audit` tag. This section describes work
landed on `protocol/main` **after** it. The engagement reference has since moved to
**`v0.3.0-audit`** (see AUDIT-HANDOFF.md), which includes these files precisely so that the
warning this section used to carry — "scoped to `v0.2.0-audit`, none of this is in scope" — no
longer produces an audit of an oracle aggregator that excludes two of its three source classes.
Read this section as the provenance record for the least-reviewed part of the surface.

**Nothing inside the freeze was modified.** Measurable the same way §1 is:

| Question | Command | Answer |
| --- | --- | --- |
| Did any frozen contract change? | `git diff v0.2.0-audit..protocol/main -- contracts/src/OracleAggregator.sol contracts/src/VaultCore.sol contracts/src/VaultFactory.sol contracts/src/VaultDeployer.sol contracts/src/Governance.sol contracts/src/FeeEngine.sol contracts/src/OperatorRegistry.sol contracts/src/SubVaultRegistry.sol contracts/src/AggregationRouterAdapter.sol contracts/src/DirectPoolAdapter.sol contracts/src/lib contracts/src/interfaces` | **No** — empty |
| What is new under `contracts/src/`? | `git diff --stat v0.2.0-audit..protocol/main -- contracts/src/` | only `src/oracle/**`, all new files |

### What was added

| File | What it is |
| --- | --- |
| `src/oracle/UniswapV3TwapSource.sol` | **New.** Spot-market TWAP `IPriceSource` — the second SF-1 mechanism class. Two-hop capable, USDC pinned to $1.00. |
| `src/oracle/PythSource.sol` | **New.** Pull-oracle `IPriceSource` — the third class. Vendored minimal `IPyth`. |
| `src/oracle/vendor/TickMath.sol` | **New, third-party.** Uniswap v3-core tick math, ported to 0.8.26. **GPL-2.0-or-later**, in its own file under its own header. |
| `src/oracle/vendor/FullMath.sol` | **New, third-party.** Uniswap v3-core 512-bit `mulDiv`, ported to 0.8.26. **MIT**, likewise. |
| `test/UniswapV3TwapSource.t.sol`, `test/PythSource.t.sol`, `test/MixedOracleSources.t.sol`, `test/mocks/OracleSourceMocks.sol` | **New.** 58 tests: golden tick fixtures, expo table, freshness guards, constructor validation, fuzz, and three-class integration behind the unmodified aggregator. |
| `config/base-mainnet.json` | **New.** Base mainnet address draft, marked `UNVERIFIED-ON-CHAIN` with its own verification checklist. Nothing reads it yet. |
| `docs/audit/walkthroughs/{UniswapV3TwapSource,PythSource}.md` | **New.** Per-source walkthroughs to the standard of the frozen set. |
| `docs/DEPLOYMENT.md` §0/§2/§4 | The mainnet oracle stack is now specified as three mechanism classes at quorum 2-of-3, with the `maxStaleness` and pool-cardinality traps called out. |
| `contracts/.gas-snapshot` | Regenerated (`forge snapshot --nmt "testFuzz"`). **Additions only** — 51 new entries, no existing entry changed. |

### Coverage, stated honestly

- **Both new sources have ZERO internal adversarial review passes.** The frozen contracts have
  one to three each (§2). These have their test suites and nothing else. They are the least
  scrutinized Solidity in the repository, and they feed the contract that prices everything.
- **The vendored math is third-party code under two different licenses**, neither of which is
  this repository's BUSL-1.1. They are kept in separate files under their own SPDX headers, and
  only the `tick → sqrtPrice` direction of `TickMath` was taken. The 20 magic constants were
  verified against an independent 120-decimal-digit reference over 685 ticks (max relative
  deviation 2.3e-10) rather than trusted from memory, and the resulting values are pinned as
  golden fixtures. **The license mix is a decision a human should confirm**, not a technical
  finding.
- **Neither source has ever been run against a real chain.** Every test drives a mock pool or a
  mock Pyth contract — so the Uniswap and Pyth interface shapes are asserted against this
  repository's understanding of them, not against the deployed contracts. `base-mainnet.json` is
  documentation-derived and explicitly `UNVERIFIED-ON-CHAIN`. Note the asymmetry with the frozen
  tree: that code now has a Base Sepolia deployment behind it (§3), these two sources have
  nothing.
- **`UniswapV3TwapSource` adds an external call per source per `navWad`** (the self-STATICCALL
  containment that makes its `(0, 0)` contract total). That compounds Sprint-6 **Finding 8**'s
  gas scaling, and Finding 8's disposition has not been revisited in light of it.
