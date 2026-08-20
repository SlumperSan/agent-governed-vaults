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
| `src/VaultDeployer.sol` | **New.** 106 lines, ~25 assembly. Holds `VaultCore`'s creation code because EIP-170 leaves it nowhere else to live. Zero authority. |
| `src/VaultFactory.sol` | A fifth constructor parameter + `immutable`, and `_deploy` calling `vaultDeployer.deploy(abi.encode(...))` instead of `new VaultCore(...)`. Nothing else. |
| `script/Deploy.s.sol`, `script/DeployTestnet.s.sol` | Construct the deployer before the factory (forced: the pin is `immutable`). |
| `test/Eip170.t.sol` | **New.** 9 tests guarding the fix. |
| 7 existing test files | Fixture plumbing only — one import and one constructor argument each; the two deploy tests each gained an assertion. **No assertion was weakened.** |
| `.github/workflows/ci.yml` | Comment updates; then Sprint 10's F-3 filter fix. |
| `.gas-snapshot` | Regenerated. Every delta reconciled to the mechanism — see the review, §4. |

**Why it was necessary, in one sentence:** `VaultCore`'s *creation* code is 24,731 B, larger than
EIP-170's 24,576 B runtime cap all by itself, so any contract containing `new VaultCore(...)`
embeds a blob that cannot fit in a deployable contract — `VaultFactory` measured 27,241 B and was
undeployable on any chain.

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
  budget is uneven, this ~106-line file has the least accumulated scrutiny per line.
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

- **No testnet deployment exists.** [TESTNET-REPORT.md](TESTNET-REPORT.md) is a **pre-flight
  record only** — nothing was broadcast, no key was ever handled, no contract was deployed to any
  chain. What it *does* establish, live on Base Sepolia, is that all six configured addresses
  verify on-chain (USDC/WETH/LINK symbols and decimals, both Chainlink feeds fresh with correct
  descriptions and decimals, the pinned router has code), and that the toolchain is at the
  required versions. That is configuration evidence, not deployment evidence. **There is no
  deployed bytecode to compare against.**
- **`v0.1.0-rc2` was never cut.** The Sprint-8 merge train did not run. Any document referring to
  an rc2 base is describing a plan, not a tag.
- **PRs #11 (canary) and #12 (reference agent) are unmerged**, and neither contains Solidity
  (§1). Out of contract-audit scope either way.
- **PR #17 itself may still be unmerged** when you read this — see §4.

---

## 4. Which revision to audit

The intended audit reference is the tag **`v0.2.0-audit`**.

> **If that tag does not exist in the repository, it was not created**, and the reason is
> recorded here rather than left as a mystery. The Sprint-10 session could not merge PR #17: the
> `gh pr merge` call was refused by the agent harness's permission classifier, and performing the
> equivalent local merge-and-push was declined as the same action by another name. The Sprint-8
> merge train ([issue #14](https://github.com/SlumperSan/agent-governed-vaults/issues/14)) is
> blocked on exactly this, which is why no rc2 was ever cut. A prior session had recorded the
> restriction as unverified because it had not attempted the call; it is now verified.
>
> Everything else in the freeze is complete: the review, the fixes, the package sync. What
> remains is a merge and a tag, by a human with merge rights:
>
> ```bash
> gh pr merge 17 --merge          # the EIP-170 fix — reviewed PASS, CI green, MERGEABLE/CLEAN
> gh pr merge 19 --merge          # this sprint: review + doc/CI fixes
> git checkout protocol/main && git pull
> git tag -a v0.2.0-audit -m "Audit candidate: EIP-170 deployment split, re-reviewed"
> git push origin v0.2.0-audit
> ```
>
> Until then, the audit-candidate *content* is the head of `sprint-10/audit-freeze`
> ([PR #19](https://github.com/SlumperSan/agent-governed-vaults/pull/19)), which contains
> PR #17 in full plus this sprint's changes. Auditing a branch head is workable; it is simply
> not the frozen reference the package intends.
