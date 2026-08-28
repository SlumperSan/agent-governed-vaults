# AI Pre-Audit Report — Agent-Governed Vaults

**Engagement reference:** tag `v0.3.0-audit` (annotated → commit `ad9396d7`)
**Date:** 2026-08-25
**Status:** Complete — all nine specialist passes ran to completion.

> **What this is, and what it is not.** This is a rigorous *pre-audit* pass performed by an AI
> agent team. It carries **no liability, no insurance, no signed attestation, and none of the
> reputational stake a firm provides**, and it does **not** satisfy any audit gate. Treat it as
> findings to fix before a paid engagement — not as clearance to ship. §6 states plainly what this
> method cannot attest.

---

## 1. Executive summary

Nine independent specialist passes over the 3,349 LoC contract surface produced **41 findings**:
**5 Critical, 9 High, 15 Medium, 7 Low, 5 Informational**. Thirty-three purpose-written Foundry
tests were authored and executed against the frozen sources; all pass, and they confirm four of
the five Critical findings and five of the nine High ones (the fifth Critical, **C-1**, is
established by source derivation rather than by a test). The protocol's own 189-test suite is fully green at
this tag — and one finding (**H-3**) establishes that its green status on the oracle layer is
*structurally incapable* of detecting **H-2**.

Four results dominate.

- **The oracle layer** — the post-freeze code the handoff itself flags as least-reviewed — lets a
  single price source permanently brick all pricing for every vault on that aggregator, with no
  recovery (**C-3**); and the documented mainnet configuration degrades the "median" into a
  *minimum* under its own documented expected operating conditions, handing one source unilateral
  downward control of price (**H-1**).
- **Governance can be frozen permanently by a single `propose()` call** (**C-2**), because three
  of four duration parameters have no upper bound — and the frozen vault cannot legislate its way
  out, because a stuck proposal also blocks every future proposal.
- **Voting weight survives a full exit** (**C-5**): a member can hold stake across one block
  boundary, propose, withdraw all capital instantly, and then vote the proposal through with stake
  they no longer own — bearing none of the price exposure the design's alignment rests on.
- **A funded sub-vault can be captured outright for one minimum deposit** (**C-1**), because the
  parent is excluded from its child's electorate entirely, leaving a vault that holds real money
  with an empty electorate.

A pattern is more concerning than any single bug: **eight documented threat-model mitigations do
not hold as written** (EX-2, CM-7, EE-10, VO-7, MO-1, MO-2, SF-1, PX-1), and several name the exact
attack that defeats them. The threat model is unusually thorough, which makes the gap between the
stated mitigation and the shipped code the most dangerous property of the package — a reviewer who
trusts the rows will not look. Four incorrect dispositions in `SLITHER-TRIAGE.md` are documented in
§4.5.

The audit also **refuted one of its own findings** (**H-2**, *Corrected scope*): an initial claim of
single-block TWAP manipulation did not survive adversarial verification. It is recorded as refuted
rather than quietly dropped.

| Severity | Count | CONFIRMED — executing test | CONFIRMED — source derivation / inspection | PLAUSIBLE — reasoning only |
|---|---|---|---|---|
| **Critical** | 5 | 4 | 1 | 0 |
| **High** | 9 | 5 | 2 | 2 |
| **Medium** | 15 | 3 | 7 | 5 |
| **Low** | 7 | 1 | 3 | 3 |
| **Informational** | 5 | — | — | — |
| **Total** | **41** | **13** | **13** | **10** |

The middle column is deliberately separated from the first: those findings are established by
reading the source, not by executing anything. Only the 13 in the first column are backed by a
test in `contracts/test/audit/`.

### Recommendation: **NO-GO** for immutable mainnet deployment

This is not a close call. Five Critical findings each independently cause permanent, unrecoverable
loss or lock of member funds, and there is no proxy, pause, admin, or migration path that could
mitigate any of them after deployment. `C-2` and `C-3` are each triggerable by a single
transaction; `C-1` costs one minimum deposit; `C-5` costs one block of capital exposure. The
remediation set touches `Governance`, `OracleAggregator`, `UniswapV3TwapSource`, `VaultCore`,
`SafeTransferLib` and `VaultFactory` — most of the critical surface — so the corrected tree is
materially different code requiring a **full** re-review, not a delta review.

**Recommended sequence:** (1) remediate all Critical and High findings; (2) replace the oracle test
mock per **H-3** and re-run the Sprint-11 suite against faithful semantics, treating every new
failure as a finding; (3) commission the human audit against the corrected tree; (4) run the oracle
sources against real Uniswap and Pyth contracts on a fork and on testnet — which has never been
done (§6).

---

## 2. Scope

**Audited revision.** Tag `v0.3.0-audit`, an annotated tag resolving to commit
`ad9396d728229810058bf192f24b15cbae3af535`, reviewed in an isolated detached `git worktree`. The
main working tree was never modified.

**In scope — `contracts/src/`, 22 files, 3,349 LoC:**

| File | LoC | File | LoC |
|---|---|---|---|
| `VaultCore.sol` | 906 | `DirectPoolAdapter.sol` | 95 |
| `Governance.sol` | 532 | `oracle/vendor/FullMath.sol` | 89 |
| `oracle/UniswapV3TwapSource.sol` | 369 | `oracle/vendor/TickMath.sol` | 81 |
| `OperatorRegistry.sol` | 162 | `AggregationRouterAdapter.sol` | 78 |
| `OracleAggregator.sol` | 158 | `lib/SafeTransferLib.sol` | 58 |
| `oracle/PythSource.sol` | 148 | `lib/Checkpoints.sol` | 46 |
| `VaultFactory.sol` | 140 | `lib/BoundedCall.sol` | 46 |
| `FeeEngine.sol` | 136 | `interfaces/` (5 files) | ~94 |
| `VaultDeployer.sol` | 106 | | |
| `SubVaultRegistry.sol` | 105 | | |

**Also reviewed for context:** `contracts/config/base-mainnet.json`,
`contracts/config/deployments/base-sepolia.json`, `contracts/script/`, `contracts/test/`,
`scripts/verify-mainnet-config.mjs`, `foundry.toml`, and the full `docs/` set.

**Out of scope:** `packages/indexer`, `apps/api`, `apps/web`, `packages/canary`,
`packages/reference-agent` — none custody funds.

**Baseline verified, not assumed.** The project's suite at this tag is **189 tests, 189 passing** —
higher than the 128 quoted in `AUDIT-HANDOFF.md`, which predates the 58 Sprint-11 oracle tests.
Contract sizes were measured with `forge build --sizes`: `VaultCore` 23,016 B runtime, **1,560 B
(6.3%) of EIP-170 margin** — the only contract meaningfully close to a cap; `VaultDeployer` initcode
26,148 B against EIP-3860's 49,152 B.

**What was NOT covered — stated so the gaps are visible.**
- **No live-chain verification.** No RPC was available. Every address, pool identity and Pyth price
  ID in `base-mainnet.json` remains unverified against Base mainnet. This audit's statements about
  that file concern its *internal consistency* and *what the verification script does and does not
  check* — never what is deployed at those addresses.
- **No fork testing.** Uniswap V3 and Pyth interface shapes were reproduced faithfully from
  upstream source but never executed against the real contracts. `slot0`'s three same-width
  `uint16` fields could be transposed without any decode failure, and `_meanTick:282` reads exactly
  two of them.
- **No formal verification**, and the project's own invariant suites were read but not re-derived.
- **`Checkpoints.sol`** was reviewed for voting-snapshot correctness; it carries no fund-flow path.

**Frozen-code discipline.** No file under `contracts/src/` was modified at any point, verified with
`git status --porcelain`. All audit artifacts are additive test files, landed under `contracts/test/audit/`.

---

## 3. Findings

Severity is impact × likelihood, then **adjusted up one level for immutability** per the engagement
brief; each finding states the adjustment, and where a finding is already Critical the adjustment
is a **no-op** and is marked so. Every remediation is an exact source change plus **"requires
redeploy + re-review"**, because the tree is frozen and there is no upgrade path.

Where two or more independent passes found the same defect it is reported as **one** finding, with
the rediscovery noted as corroboration.

---

## CRITICAL

### C-1 — Any outsider takes unilateral governance control of a funded sub-vault for one minimum deposit, and drains it

| | |
|---|---|
| **Severity** | **CRITICAL** (already Critical — adjustment is a **no-op**) |
| **Status** | **CONFIRMED by source re-derivation**; every link re-read by the lead auditor. No end-to-end test. |
| **Corroboration** | Independently found by the access-control and reentrancy passes |
| **Files** | `VaultCore.sol:421-431`, `:835-846`; `Governance.sol:236-239`, `:435-437`, `:443`, `:460-486`; `VaultCore.sol:752-795`; `AggregationRouterAdapter.sol:50-74` |

**Description.** The GA-1 fix addressed a real problem — a parent holding child shares made
full-consensus `RuleChange` unreachable — by excluding the parent from the child's voting-eligible
stake **and** from its holder count:

```solidity
// VaultCore.sol:425-430
uint256 pElig = pv == address(0) ? 0 : sharesOf[pv] - queuedExitShares[pv];
uint256 pHeld = (pv != address(0) && sharesOf[pv] > 0) ? 1 : 0;
_totalEligibleHist.push(totalShares - totalQueuedShares - pElig);
_holderCountHist.push(holderCount - pHeld);
```

The unanticipated consequence: in a child whose **only** capital is its parent's allocation,
`pastTotalVotingEligibleShares == 0` and `pastHolderCount == 0`. The vault holds real money and has
an **empty electorate**. `deposit` is permissionless, so one `minDepositUsdc` makes the attacker the
sole eligible voter, and every gate passes trivially:

| Gate | Code | With a sole eligible holder |
|---|---|---|
| Proposal threshold | `Governance.sol:239` `own*BPS >= thresholdBps*total` | `own == total` ⇒ holds for **any** threshold ≤ 100% |
| Regime | `:435` `memberCount (1) < SIGNER_REGIME_BELOW (5)` | absolute-signer regime |
| Quorum | `:436` `revealedVoterCount*2 > memberCount` | `1*2 > 1` ✓ |
| Outcome | `:443` `forWeight > againstWeight` | attacker weight > 0 ✓ |

`Governance.execute` (`:460`) is permissionless, so the attacker also controls execution timing.

**Why capture equals drain.** `executeRebalance` (`:752-795`) validates only caller, adapter
allow-list, token membership, and `received >= o.minAmountOut` (`:778`) — where **`minAmountOut` is
supplied by the proposer**. `AggregationRouterAdapter` (`:50-74`) requires only `minAmountOut > 0`
(1 wei suffices) and allow-lists only the router **selector**; `routeData` is otherwise opaque and
passed verbatim, so the swap *path* is attacker-chosen and may route through an attacker-seeded
pool. No oracle-derived bound exists anywhere on this path (**H-4**).

**Exploit path.**
1. Honest parent `V` creates child `C`; `V`'s governance passes `allocateToChild(C, 1_000_000e6)`.
   `C` now holds $1M with zero voting-eligible stake.
2. Attacker calls `C.deposit(minDepositUsdc)`, then `C.activate(attacker)` (or `skipWindow()`).
3. Attacker calls `propose(C, Rebalance, keccak256(payload))` — threshold passes because
   `own == total`.
4. Attacker commits, reveals FOR, `finalize` → **Passed**, waits `C`'s timelock, calls `execute`.
5. Payload: `SwapOrder{tokenIn: usdc, amountIn: 1_000_000e6, minAmountOut: 1, routeData: exactInput
   path through an attacker-seeded pool}`.
6. `C` pays out $1M and books 1 wei.

**Cost:** one `minDepositUsdc` — as low as 1 unit (`VaultCore.sol:215` requires only `> 0`) — plus
gas. **Loss:** borne by `V`'s members via collapsed look-through NAV.

**Scaling.** With `k` honest non-parent holders the attacker needs `k+1` sybils (`2n > k+n ⟺ n > k`)
while `k < 4`; at `k >= 4` the regime flips to stake quorum over a denominator that **still excludes
the parent**. A sub-vault is therefore governed by whoever holds a majority of the *smallest* pool
of capital in it, never the largest.

**Mitigations that exist, and why they are insufficient.** The child's timelock lets `V`'s members
race a `redeemFromChild` proposal through `V`'s own ≥2 h commit/reveal cycle — a race, not a
defence. If the attacker created the child themselves via `createChildVault`, which performs **no
authorization on `parent`** (**L-1**), they are the child's `creator` and register its `GovConfig`
themselves (`Governance.sol:182` gates only on `msg.sender == creator()`), so they set
`timelockDuration = 0` and remove even the race.

**Remediation.** The two exclusions were conflated. The parent must be excluded from *voting weight*
while still counted as a **member** for regime and quorum purposes:

```solidity
// VaultCore.sol:426 — remove the holder-count exclusion
uint256 pHeld = 0; // the parent is a non-VOTING member, but it IS a member
```

This makes an empty electorate impossible and forces `memberCount >= 2`. It does **not** by itself
preserve GA-1, so full consensus must be re-derived to measure against *voting-eligible* stake
(`snapshotTotal`, which already excludes the parent) while regime and quorum measure against member
counts that include it; `SubVaults::test_childRuleChangePassesAfterParentAllocates` must be
re-verified against the change. Additionally gate `createChildVault` on the parent's creator or
governance. **Requires redeploy + re-review of `VaultCore`'s snapshot logic, `Governance`'s quorum
regimes, and `VaultFactory`.**

> **REMEDIATION STATUS — FIXED at launch (2026-08-28, Phase 2, "root vaults only").** The
> recommended in-contract fix above was evaluated and **rejected**: `pHeld = 0` breaks the
> legitimate parent+1-member child (the absolute-signer regime needs `1*2 > 2`, false), and the
> tension is structural — any voting denominator that excludes the parent lets a dust depositor
> govern the parent's allocation, and including it makes the child ungovernable (the parent is a
> contract with no vote path). There is **no purely-internal fix**; a correct fix needs a new
> "parent casts the child's vote" governance mechanism, which is a product decision, new attack
> surface, and larger than the finding. The owner's decision is to **ship launch with sub-vaults
> disabled at the contract level** and defer that mechanism to a post-launch, post-audit release.
> `VaultFactory` gains an immutable `allowSubVaults` (false at launch): `createChildVault` reverts
> `SubVaultsDisabled`, and every deployed vault is wired `subVaultRegistry = address(0)` so it is
> intrinsically root-only. Because `registerChild` is factory-only and `allocateToChild` requires a
> registered edge, no vault can ever be funded as a child, so the empty-electorate precondition is
> **unreachable**. This closes **C-1, H-5, H-6, H-7, H-9** and residual-risk row 9 as a class.
> VaultCore bytes are **unchanged**. Regression: `contracts/test/audit/AuditRootVaultsOnly.t.sol`
> — one test reproduces the live capture with sub-vaults enabled, one proves it unreachable at
> launch. (L-1's `createChildVault` creator gate, already merged, is retained behind the new gate.)

---

### C-2 — Governance duration parameters are unbounded above: a single `propose()` call can freeze every exit in a vault permanently

| | |
|---|---|
| **Severity** | **CRITICAL** (base High × immutable → Critical) |
| **Status** | **CONFIRMED** — 4 tests (`AuditExecutionWindowFreeze.t.sol`) plus 3 independent tests from the DoS pass |
| **Corroboration** | Independently found by the access-control, governance, DoS and standards passes |
| **Files** | `Governance.sol:201-208`, `:428`, `:446-447`, `:465`, `:492`, `:504-506`, `:519-526`; `VaultCore.sol:445`, `:477` |

**Description.** `_validateConfig` bounds durations on one side only. Of five parameters, **exactly
one is capped above — and it is the only one that does not gate exits**:

| Parameter | Lower bound | Upper bound | Gates exits? |
|---|---|---|---|
| `timelockDuration` | — | **`TIMELOCK_HARD_CAP` = 30 days** | no |
| `commitDuration` | `>= 1 hours` | **none** (`uint32` ≈ 136 y) | yes |
| `revealDuration` | `>= 1 hours` | **none** | **yes** |
| `executionWindow` | `>= 1 hours` | **none** | yes |
| `proposalCooldown` | **not validated at all** | none | — |

```solidity
// Governance.sol:203-204 — the asymmetry, on two adjacent lines
require(cfg.timelockDuration <= TIMELOCK_HARD_CAP, BadGovConfig());   // capped
require(cfg.executionWindow >= 1 hours, BadGovConfig());              // floor only
```

**The severest form needs no vote at all.** `hasPendingExecution`'s `Active` branch (`:519-521`)
returns true for any proposal past its `commitDeadline` — **passage is irrelevant**:

```solidity
if (p.status == Status.Active) {
    return block.timestamp >= p.commitDeadline;
}
```

`finalize` requires `block.timestamp >= p.revealDeadline` (`:428`). So with an unbounded
`revealDuration` the proposal is pinned in `Active` for ~136 years, and **a single `propose()` call
by any holder freezes every exit forever** — no vote, no quorum, no collusion. With
`proposalThresholdBps = 0` — the value shipped in `base-mainnet.json` (**M-6**) — the attacker needs
one `minDepositUsdc`.

In `VaultCore` that flag *is* the Mode-F switch: `requestExit` queues instead of settling (`:445`)
and `settleQueuedExit` reverts `ExecutionStillPending` (`:477`). **There is no cancel path** —
`queuedExitShares` is written only at `:449` and zeroed only inside `settleQueuedExit`.

**And the vault cannot legislate its way out.** `_isSettled` counts only
`Defeated | Executed | Expired` (`:504-506`), so a stuck proposal fails `propose`'s guard at
`:223-226` — **no new proposal can be opened**, including the `RuleChange` that would repair the
config. `markExpired` and `_refreshStatus` both require `status == Passed`, so neither applies to a
proposal pinned in `Active`.

A second, equally permanent variant uses `executionWindow`: a `Passed` proposal whose payload
preimage is never published can never execute — `propose` never validates that `actionHash`
corresponds to any decodable payload (`:219`) — and `markExpired` requires
`block.timestamp > expiresAt`, 136 years away.

**Measured** (`AuditExecutionWindowFreeze.t.sol`). The fixture is the project's own
`Governance.t.sol` fixture with **one** parameter changed:

- `registerVault` **accepts** `executionWindow = type(uint32).max` and `revealDuration = type(uint32).max`;
- one `propose()` + six hours ⇒ `hasPendingExecution` true **with zero votes cast**;
- `requestExit` **queues**; `settleQueuedExit` reverts `ExecutionStillPending`;
- `execute` reverts `BadPayload`; `markExpired` and `finalize` revert `WrongPhase`;
- **ten years later** the vault is still frozen;
- a `RuleChange` to repair the config reverts `ProposalActive`.

The DoS pass independently reproduced this and added that **deposits keep working**, so fresh
capital continues to enter the trap.

**This falsifies two documented guarantees.** **EE-10**: *"if a passed proposal expires unexecuted …
queued exits settle at then-current NAV — no indefinite lock."* And **MO-1**: *"a broken governance
loses forward pricing … never member liveness."* MO-1's `_pendingExecution` Mode-I fallback
(`VaultCore.sol:462-468`) protects against a *broken* module; here governance functions correctly
and truthfully answers `true` forever, so the fallback never fires. `VaultCore.sol:461` and `:472`
repeat the claim in NatSpec.

**Likelihood.** The creator picks these values unilaterally in `registerVault`, a separate
transaction unordered relative to deposits and requiring no member consent — so the trap parameters
can be chosen *after* capital has entered. An honest creator can also trip a partial version: even a
well-intentioned 90-day `executionWindow` freezes all redemptions for 90 days on ordinary executor
inaction.

**Remediation.**

```solidity
uint256 public constant PHASE_HARD_CAP = 14 days;
...
require(cfg.commitDuration  >= 1 hours && cfg.commitDuration  <= PHASE_HARD_CAP, BadGovConfig());
require(cfg.revealDuration  >= 1 hours && cfg.revealDuration  <= PHASE_HARD_CAP, BadGovConfig());
require(cfg.executionWindow >= 1 hours && cfg.executionWindow <= PHASE_HARD_CAP, BadGovConfig());
require(cfg.proposalCooldown <= PHASE_HARD_CAP, BadGovConfig()); // currently unvalidated
```

Additionally decouple Mode F from proposals that have not passed, and allow a vault to open a
`RuleChange` even while a stale proposal is pinned. **Requires redeploy + re-review of
`Governance`'s config validation, its status machine, and the `hasPendingExecution` coupling into
`VaultCore`.**

---

### C-3 — A single price source returning malformed return data permanently bricks all pricing for every vault on that aggregator

| | |
|---|---|
| **Severity** | **CRITICAL** (base High × immutable → Critical) |
| **Status** | **CONFIRMED** — 5 tests (`AuditAggregatorDecodeBrick.t.sol`), independently reproduced by the lead auditor after the oracle pass raised it |
| **File** | `OracleAggregator.sol:88-90`; constructor `:60-72` |

**Description.**

```solidity
try IPriceSource(cfg.sources[i]).latestPrice() returns (uint256 p, uint256 updatedAt) {
    if (p > 0 && updatedAt >= minUpdated) fresh[k++] = p;
} catch {}
```

Solidity decodes the returned buffer in the **caller's** frame *after* the callee returns
successfully. A `catch` clause cannot absorb a decode failure. So a source returning anything other
than ≥64 well-formed bytes makes `priceWad` revert **unconditionally — regardless of quorum** — and
with **empty returndata**, not `StaleOracle`.

This falsifies the contract's own stated contract at `:86-87`: *"A reverting source is simply not
fresh — one broken feed must not trip the breaker while quorum still holds elsewhere."* True for a
genuine `revert`; false for a malformed return.

**Measured** (3 sources, quorum 2 — the shipped configuration):

| Third source behaviour | `priceWad` |
|---|---|
| well-formed `(uint256,uint256)` | ✓ returns the median |
| **genuine `revert("boom")`** | **✓ absorbed — correctly not-fresh** (control) |
| returns 32 bytes | **revert, returndata `0x`** |
| returns 0 bytes | **revert, returndata `0x`** |
| **codeless address (a deploy typo)** | **revert, returndata `0x`** |

The control passing is what isolates the defect: the `catch` works for the case it was written for
and fails for the adjacent one.

**Two reachable paths.**

*(a) Deploy-time typo — permanent brick.* `VaultFactory.sol:74,125` takes the aggregator as a
creator-supplied, pre-deployed address, and the aggregator's constructor performs **no
`code.length` check on any source**. One mistyped address makes the asset unpriceable forever, so
every vault using that aggregator can never accept a deposit or settle an exit. Note the
inconsistency within the same PR: `UniswapV3TwapSource.sol:178,204` and `PythSource.sol:102` both
check `code.length > 0` on *their* dependencies — evidence this is an oversight, not a decision.

*(b) Creator-controlled hostage vector.* The creator is explicitly untrusted (`:42-44`: *"Floors are
load-bearing (the creator is untrusted)"*). A creator-authored source can serve well-formed data
throughout the deposit phase and later flip to a 32-byte return with a single `SSTORE`. From that
block onward **every NAV path, including every exit, reverts forever.** `cancelPending`
(`VaultCore.sol:358-365`) rescues only *un-activated* deposits.

**This also defeats the K-4 premise**, which accepts a freeze requiring a *quorum failure*. Here
**one source out of fifteen suffices**, unilaterally, permanently, under its own operator's control.
Value at risk: 100% of active share capital in every vault wired to the aggregator.

**Remediation.**

```solidity
// replace the try/catch at :88-90
(bool ok, bytes memory ret) = cfg.sources[i].staticcall(
    abi.encodeCall(IPriceSource.latestPrice, ())
);
if (ok && ret.length >= 64) {
    (uint256 p, uint256 updatedAt) = abi.decode(ret, (uint256, uint256));
    if (p > 0 && updatedAt >= minUpdated) fresh[k++] = p;
}
// and in the constructor loop at :62
require(sources_[i][a].code.length > 0, BadOracleConfig());
```

**Requires redeploy + re-review of `OracleAggregator` and every aggregator instance.**

---

### C-4 — A depressed oracle price converts directly into theft of existing members' capital

| | |
|---|---|
| **Severity** | **CRITICAL** (already Critical — adjustment is a **no-op**) |
| **Status** | **CONFIRMED** for the `VaultCore` half; the full chain is **composed, not executed in one transaction** — see *Scope of this confirmation* |
| **File** | `VaultCore.sol:391` (`_mintShares`), `:335` (immediate mint) |

**Description.** `_mintShares` mints `amountWad * totalShares / navWad()` — issuance is inversely
proportional to reported NAV — and `deposit` (`:335`) mints **immediately, in the same transaction**,
for any member who has cleared the observation window (a one-time, per-member gate, so a returning
depositor faces no delay). A depressed price is therefore convertible to excess shares atomically,
and the excess is redeemable for real assets.

**Measured** (`AuditOracleToShareTheft.t.sol`), price depressed $2,500 → $100 on an 800-wETH basket:

| | |
|---|---|
| Attacker capital in | **1,000,000 USDC** |
| Attacker claim out | **2,777,762.43 USD** |
| Victim value before | 1,000,000.00 USD |
| Victim value after | **111,123.79 USD** |
| **Attacker gain** | **+1,777,762.43 USD** |
| **Victim loss** | **−888,876.21 USD (88.9% of stake)** |

A second test confirms this is not a paper-NAV artifact: the attacker **withdraws** 733.33 wETH +
916,667.71 USDC = 2,749,984.80 USD against 1,000,010 USD deposited.

**Scope of this confirmation — stated precisely.** This test builds `VaultCore` over a `MockOracle`
and sets the depressed price directly (the test's own header, lines 8-21, says so). It confirms the
**`VaultCore` half** rigorously and takes the depressed price as given. The **oracle half** is
confirmed separately: **C-3**, **H-1** and **M-1** each independently produce a wrong or
attacker-chosen price against real code. **No single test executes the full chain in one
transaction**; the composition is a well-founded argument, not an executed exploit.

Coherence supports the composition: C-4 assumes a 96.0% depression, and the TWAP source *measurably*
produces a 95.9% error under **H-2**'s conditions.

**Note on direction.** The oracle findings bias **downward** (H-1's minimum, H-2's stale tick), and
downward is exactly the exploitable direction here. The walkthrough's disposition of the even-`k`
bias claims the opposite — see **H-1**.

**Remediation.** This is the *consequence*; fixing C-3, H-1, H-2 and M-1 removes its trigger. As
defence in depth, bound mint-time price movement — reject a deposit whose implied NAV per share
deviates from a recent reference beyond a tolerance. This is the "oracle-enforced mint-time
freshness" option the threat model identifies under **E7/EE-5** and explicitly did not ship; C-4
raises the cost of that omission considerably. **Requires redeploy + re-review of `VaultCore`'s
deposit path.**

> **REMEDIATION STATUS — root cause CLOSED; defence-in-depth DEFERRED (2026-08-28, Phase 2).** The
> trigger is gone: **C-3, H-1, H-2 and M-1 are all merged**, so no wrong or attacker-chosen price
> reaches `_mintShares` through real code, and the measured exploit's precondition no longer holds.
> What remains is the *defence-in-depth* mint-time NAV-deviation bound only. It lands in
> `VaultCore`, which currently has **1,014 B of EIP-170 headroom** — too tight to add it safely
> alongside the other in-VaultCore fixes — so it is **deferred to the VaultCore-headroom sprint**
> (see #40, #32) and tracked as the remaining, non-blocking half of #32. It is a second layer, not
> the fix: the exploitable path is already closed. (M-15, the user-side `minSharesOut`/deadline, is
> the same deposit-path change and is deferred with it.)

---

### C-5 — Voting weight survives a full exit: stake held for one block boundary can pass a proposal after the capital has been withdrawn

| | |
|---|---|
| **Severity** | **CRITICAL** (base High × immutable → Critical). **Capital precondition, stated up front:** the attacker must actually acquire enough stake to carry the vote, and hold it across a deposit→exit round trip. That is not free — see *Cost, stated precisely* below. The rating rests on total impact plus the removal of the design's core alignment, not on the attack being cheap. |
| **Status** | **CONFIRMED** — 2 tests (`AuditVoteAfterExit.t.sol`), including a passing control |
| **Files** | `Governance.sol:269`, `:299`, `:326`, `:393`, `:519-521`; `VaultCore.sol:445`, `:453-455`, `:529`; `lib/Checkpoints.sol:36-45` |

**Description.** Every weight read in `Governance` is
`pastVotingEligibleShares(voter, p.createdAt - 1)`, and `Checkpoints.getAt` returns the last
checkpoint **at or before** that timestamp. The checkpoint written when a member **exits** is
stamped at the current block — strictly after `createdAt - 1` — so it is **invisible to a proposal
already in flight**. There is no current-balance check at `commitVote`, `revealVote`,
`revealDelegated`, `applyStandingDefault`, or `finalize`.

Critically, the exit also **settles instantly and in full**: `hasPendingExecution` returns
`block.timestamp >= p.commitDeadline` for an `Active` proposal (`:519-521`), which is **false for the
entire commit phase**. So `requestExit` takes the Mode-I branch and pays the member out immediately,
at pre-rebalance NAV.

**Exploit path — confirmed end to end by test.**
1. Attacker calls `skipWindow()` (permissionless, unconditional) and deposits a dominant position;
   it mints immediately.
2. One block later (2 s on Base), attacker calls `propose(...)`. Snapshots read `createdAt - 1`, so
   the stake counts.
3. Attacker immediately calls `requestExit(all)` — still inside the commit phase, so
   `hasPendingExecution` is **false** and the exit **settles Mode I, instantly, in full**. Test
   asserts `sharesOf(attacker) == 0`, `queuedExitShares(attacker) == 0`, and capital returned.
4. Attacker commits and reveals FOR with the full snapshot weight. `revealVote` **does not revert**
   despite a zero current balance.
5. `finalize` → **Passed**, on stake the attacker no longer owns.

**Cost, stated precisely.** An earlier draft of this finding said "capital is exposed for one
block." That was wrong and is corrected here. The attacker holds the position from the deposit
until the exit lands — the deposit block, the boundary, and the propose/exit block, i.e. **at least
two blocks** — and because `_mintShares` and `_settleExit` both price at current NAV, the real cost
is round-trip price risk on a dominant position across that window, plus the exit fee (capped at
100 bps, and **zero** in any vault setting `exitFeeMaxBps == 0`, which `VaultCore.sol:213-216`
permits and the test uses). On Base that window is a handful of seconds, so the risk is small in
expectation but it is **not zero and not free**.

What the attacker escapes is far larger: all price exposure across the **reveal phase, the
timelock, and the execution window** — days at any sane configuration, and up to 30 days of
timelock alone at the hard cap. That is precisely the alignment the timelock and forward-pricing
design depend on: the design assumes whoever authorizes a rebalance still owns the position when it
executes. Here they do not, and they never did after the snapshot block.

So this is not "governance capture for free." It is **governance capture with the skin-in-the-game
requirement reduced from days to seconds**, which is the property the entire timelock mechanism
exists to create.

Composed with **H-4** (`minAmountOut` unbounded) this is a complete drain primitive against **any**
vault, not only sub-vaults; composed with **M-8** (opaque `actionHash`) voters cannot even see what
they are approving.

**Control test passes:** VO-9 is correctly implemented in the direction it claims — stake acquired
*after* proposal creation carries zero weight and `commitVote` reverts `NoWeight`. The defect is
that VO-9 says nothing about the **withdrawal** direction, which is the profitable one.

**This also subsumes EE-10's stated Mode-F mitigation.** EE-10 claims *"Mode-F-locked shares lose
voting eligibility at queue time."* Tracing it: `requestExit`'s Mode-F path calls `_snapshot` at the
*current* timestamp while Governance reads `createdAt - 1`, so the lock removes eligibility only
from *future* proposals — never from the one that motivated the queue. And in the commit phase the
member does not even need to queue; they simply exit.

**Remediation.** Take the minimum of snapshot and current eligible weight at every read:

```solidity
uint256 w = pastVotingEligibleShares(vault, voter, p.createdAt - 1);
uint256 cur = IVaultSnapshots(p.vault).votingEligibleShares(voter);
uint256 weight = w < cur ? w : cur;   // exiting forfeits voice on the in-flight proposal
```

applied at `:269`, `:299`, `:326` and `:393`. **Requires redeploy + re-review of all four weight-read
sites in `Governance`.**

---

## HIGH

### H-1 — `OracleAggregator`'s lower median degenerates to `min()` at two fresh sources, in the documented mainnet configuration

| | |
|---|---|
| **Severity** | **HIGH** (base Medium × immutable → High) |
| **Status** | **CONFIRMED** — 5 tests (`AuditAggregatorLowerMedian.t.sol`) |
| **File** | `OracleAggregator.sol:106`; constructor bound `:65` |

The aggregator returns `fresh[(k-1)/2]`. At `k == 2` that is `fresh[0]` — the **minimum**. The
constructor permits it: `quorum_[i] > m / 2` with `m == 3` yields `quorum >= 2`, and `k >= quorum`
allows `k == 2`. The in-code claim at `:104-105` — *"Majority-fresh quorum guarantees the middle
element is bounded by the honest set"* — is true for `k >= 3` and **false at `k == 2`**, as is
`:60-61`'s *"no single source can freeze **or move** an asset."*

**This is the documented mainnet plan, in its own documented expected state.**
`DEPLOYMENT.md:67,83-84` specifies quorum 2-of-3; `base-mainnet.json:58-59` sets `quorum: 2` for
every asset; `:23` records cbETH's Pyth leg at **2549 s stale** at check time and warns to *"expect
PythSource to withhold and the asset to run on 2-of-3 with no headroom"*; `:38` separately warns that
tight staleness *"silently demotes 2-of-3 into 2-of-2."* `PythSource.sol:52-56` says the same in
code comments. The project documented the `k == 2` state repeatedly **as a redundancy concern**,
without noticing that at `k == 2` the aggregation function itself changes from median to minimum.

**Measured:** at `k=3` with one source manipulated to 1 wei the median holds at 2490 (control passes
— the design works at odd `k`); at `k=2` the same manipulation yields **1 wei**. A *reverting*
source also produces the `k=2` regime, so any source can induce it by failing. Bias is
one-directional: **downward**. Even with no attacker, at `k=4` a single quiet source moved the
reported price 0.8%.

**The prior disposition is not merely undocumented but inverted.**
`walkthroughs/OracleAggregator.md` accepts the even-`k` bias because it *"mints fewer shares, pays
exiters less — conservative for remainers."* Both halves are backwards: `VaultCore.sol:391` mints
`amountWad * ts / navWad()`, so a **lower** NAV mints **more** shares; and the exit payout (`:538`)
is in-kind pro-rata and **price-independent**, so exiters are not paid less — a lower price only
reduces or zeroes their performance fee (`:582-605`). The bias runs toward profit in *both* consuming
paths.

**There is no inter-source deviation check anywhere** — no bound on `max(fresh)/min(fresh)`, no
per-asset floor/ceiling, no rate-of-change limit. The median is the only defence, and at `k = 2` it
is not one.

**Remediation.**
```solidity
if (k < 3) revert StaleOracle(asset);   // a 2-element "median" is a minimum
// and in the constructor at :65
require(quorum_[i] >= 3 && quorum_[i] > m / 2 && quorum_[i] <= m, BadOracleConfig());
```
This makes the SF-1 tension explicit rather than hiding it: with `m == 3`, requiring `k >= 3` means
any single failure trips the breaker. The honest resolution is **more than three sources per asset**
(`m >= 5`, `quorum >= 3`) so fault tolerance and median integrity can coexist. **Requires redeploy +
re-review of every aggregator instance, plus revision of `DEPLOYMENT.md` §2 and
`base-mainnet.json`.**

---

### H-2 — `UniswapV3TwapSource` reports a stale tick as zero seconds old, and the constructor never requires `maxObservationAge < window`

| | |
|---|---|
| **Severity** | **HIGH** (base Medium × immutable → High) |
| **Status** | **CONFIRMED** — 10 tests across three files |
| **Files** | `UniswapV3TwapSource.sol:255`, `:165-239` (bounds validated independently at `:175`, `:177`), `:285-303` |

**Description.** `_meanTick` calls `observe([window, 0])`. In Uniswap v3-core, `observeSingle`
synthesizes its endpoint from the newest stored observation using the **current tick** whenever
`newest.blockTimestamp <= target`. With `A = block.timestamp − newestObservation.timestamp` and
`W = window`, the live tick's weight in the reported mean is exactly

```
liveWeight = min(A, W) / W
```

— continuous in `A`, reaching 1.0 once the pool has been quiet for `W`. Confirmed **exactly**
(`assertEq`, no tolerance): at `A = 900` on `W = 1800` the reported price equals a genuine TWAP of
the 50/50-blended tick, monotone across `A ∈ {300, 600, 900, 1200}`.

Guard 3 (`:286-291`) bounds `A` against `maxObservationAge`; guard 2 (`:295-303`) bounds only the
*oldest* observation. **Neither compares the newest observation against `window`**, and the
constructor validates `window` and `maxObservationAge` **independently** — it never requires
`maxObservationAge < window`. The shipped `base-mainnet.json` pins `1800 / 3600`, so `A` may reach
**2× the window**; the ceilings permit `300 / 86400`, i.e. **288×** (confirmed by test).

Throughout, `latestPrice` hardcodes `updatedAt = block.timestamp` (`:255`). **Confirmed:** with the
newest observation 3400 s old the source votes and stamps itself zero seconds old. The aggregator's
staleness bound — even a 60-second one — is *structurally incapable* of rejecting it. The contract's
notice at `:96-97` claims guards (1)–(3) *"are what make the `updatedAt = block.timestamp`
convention honest"*; they do not.

**Corrected scope — a claim this audit refuted against itself.** An earlier draft asserted
single-block manipulability, measuring a 96% price collapse. **That claim is refuted and recorded
here rather than quietly dropped.** The measurement used a harness that moved the tick *without
writing an observation*, which is **not reachable on a real pool**: `slot0.tick` changes only inside
`swap`, which calls `observations.write(...)` stamping the **pre-swap** tick at `block.timestamp`,
resetting `A` to zero. A dedicated test now pins the refutation — on a pool quiet *longer* than the
window, a faithful manipulating swap moves the reported price by **exactly nothing** in that block.
The oracle pass reached the same conclusion independently against its own transcription of upstream
`Oracle.sol`.

An attacker therefore cannot *manufacture* contamination; they can only inherit it from an
already-quiet pool and must then hold an off-market tick, un-arbitraged, to accrue weight — the
standard, intended TWAP cost model.

**What genuinely survives** is the freshness misreport, and it needs no attacker: an honest pool that
simply stops trading yields an arithmetically-correct TWAP of a tick up to `maxObservationAge` old,
presented as current. Combined with **H-1**, that stale leg can *be* the price whenever `k == 2`.
Exposure is worst where least noticed — thin secondary pools, and shared pools
(`base-mainnet.json` notes the WETH/USDC 0.05% pool is `poolA` for WETH and `poolB` for cbETH, so
one quiet pool degrades both assets at once).

**Remediation.** Bound `A` to a small fraction of the window, since contamination equals that
fraction:
```solidity
(uint32 newestTs,,,) = pool.observations(observationIndex);
unchecked {
    require((uint32(block.timestamp) - newestTs) * 20 <= window, TwapPoolNotUsable()); // ≤5%
}
```
and remove `maxObservationAge` as an independent knob, or at minimum
`require(maxObservationAge_ < window_)`. Alternatively return `updatedAt = newestObservationTimestamp`
so the aggregator's own bound applies. The naive fix `require(now - newestTs < window)` was tested
and is **insufficient** — it caps live weight just below 1.0, still permitting a >90% error.
**Requires redeploy + re-review of the source and every aggregator configured with it.**

---

### H-3 — The repository's own V3 mock makes H-2's entire defect class undetectable by its own test suite

| | |
|---|---|
| **Severity** | **HIGH** (test-validity defect on the least-reviewed contract) |
| **Status** | **CONFIRMED** |
| **File** | `contracts/test/mocks/OracleSourceMocks.sol:101-103` |

```solidity
// Linear model: cumulative(t) = tick * t, so any window averages to exactly `tick`.
tc[i] = int56(tick) * int56(uint56(uint32(block.timestamp) - secondsAgos[i]));
```

The mock backing every TWAP test generates cumulatives from a single current `tick`; no stored
observation history drives `observe()`. Under this model a correct historical TWAP and a live-tick
extrapolation are **numerically identical** — the mock's behaviour *is* the bug in H-2. The entire
Sprint-11 oracle suite (`UniswapV3TwapSource.t.sol`, `MixedOracleSources.t.sol`, 58 tests) is
structurally incapable of distinguishing a working TWAP from a spot price, and no assertion in it
can fail for this class of defect.

Both this audit and the oracle pass had to write faithful observation-ring harnesses before the
guards could be tested at all. This also explains how H-2 survived the one internal review round.

**Impact.** The suite's green status on the TWAP source conveys no assurance about the single
property that source exists to provide, and any future change will be validated against a model that
cannot fail in the relevant way.

**Remediation.** Replace the linear mock with an observation-ring mock reproducing
`transform`-from-newest semantics; `FaithfulV3Pool` in
`contracts/test/audit/AuditTwapSpotDegeneration.t.sol` is a working reference. Re-run the Sprint-11 suite
against it and treat every newly failing test as a finding. **Test-only change — no redeploy, but it
must precede re-review of H-2's fix.**

---

### H-4 — The threat model's EX-2 slippage mitigation is not implemented

| | |
|---|---|
| **Severity** | **HIGH** (base Medium × immutable → High) |
| **Status** | **CONFIRMED by inspection** |
| **Files** | `VaultCore.sol:778`; `AggregationRouterAdapter.sol:52,67`; `DirectPoolAdapter.sol:55,78`; claim at `THREAT-MODEL.md:19` |

`THREAT-MODEL.md:19` states EX-2's mitigation as *"minOut bound from oracle median ± tolerance."*
No such bound exists. Both execution paths compare the measured output delta only against the
**caller-supplied** `minAmountOut`; the oracle is never consulted on the execution path.

The measured-delta check is a genuine and well-implemented defence against EX-3 (a lying router) and
is frequently conflated with a slippage bound. It is not one: measuring honestly against a floor of
1 wei still yields 1 wei.

The selector allow-list constrains the call *target* — which genuinely defeats the
SwapNet/Aperture target-substitution class — and the first four bytes of `routeData`, but **nothing
past byte 4**. For SwapRouter02 that leaves the entire `path` (any pool sequence, including a
freshly created attacker-owned pool), `recipient`, `amountIn` and `sqrtPriceLimitX96` unconstrained,
and the adapter never cross-checks them against `order.tokenIn/tokenOut/amountIn`. The header
comment at `AggregationRouterAdapter.sol:12-20` reads as though the allow-list bounds the route; it
does not.

**Partial mitigation worth preserving:** `VaultCore:778` independently re-checks `received >=
o.minAmountOut` on its own balance delta and `:788-794` refunds from this swap's own `spent`, so even
a fully hostile allow-listed adapter cannot cost the vault more than the governance-set
`amountIn − minAmountOut`. The residual is therefore exactly the size of the unbounded
`minAmountOut` — which C-1 and C-5 show is attacker-chosen.

**Remediation.** Bound `minAmountOut` against the vault's own oracle inside `executeRebalance`, with
`maxSlippageBps` as an immutable per-vault constructor parameter:
```solidity
uint256 inValueWad  = o.amountIn * _priceOf(o.tokenIn) / _unitOf(o.tokenIn);
uint256 floorOutWad = inValueWad * (BPS - maxSlippageBps) / BPS;
require(o.minAmountOut * _priceOf(o.tokenOut) / _unitOf(o.tokenOut) >= floorOutWad, MinOutTooLow());
```
This makes rebalancing depend on oracle liveness — consistent with the rest of the design, but it
should be stated. **Requires redeploy + re-review of `VaultCore`'s execution path.**

---

### H-5 — Child positions are marked at gross look-through value; realization cost is never accrued, so the first exiter extracts it

| | |
|---|---|
| **Severity** | **HIGH** (base Medium × immutable → High) |
| **Status** | **CONFIRMED** — executing PoC from the accounting pass |
| **Files** | `VaultCore.sol:268-275`, `:281-297`, `:513-576` |

`_childValueWad` values the parent's child position at the child's **gross** NAV fraction. Realizing
any part of it always returns strictly less, because the child's `_settleExit` deducts its tenure
exit fee (`:504-506`), its 10% performance fee on the parent's realized gain (`:583-605`), and
in-kind slice truncation (`:538`). Nothing in the parent accrues that drag — `navWad`,
`navPerShareWad` and `cashTargetWad` (`:517`) all use the gross mark.

Because SV-5 satisfies the cash leg from `idleUsdc` first, an exiter whose target is covered by idle
**never touches the child**: they receive 100% of a gross-marked entitlement and leave the entire
realization drag with whoever stays.

**Worked example (PoC passes).** Two equal 1,000 USDC deposits; 400 allocated to a child that
doubles. Child marked $800, realizable $760. Fair 50/50 split of realizable = $1,180 each. Alice
exits first at a $1,200 gross / $1,180 net cash target, covered by idle — child untouched
(asserted). The remaining member then receives $1,160 gross / $1,144 net. **$18 net moved from the
remaining member to the first exiter** on identical deposits and identical share counts.

This violates ARCHITECTURE §4.6's unconditional *"NAVps for remaining members is non-decreasing
across any redemption."* The PoC asserts `navPerShareWad` is **exactly unchanged** across the exit.

**Why the suite cannot see it.** `SystemInvariant.t.sol:87` asserts
`parent.navPerShareWad() + 2 >= psBefore` — it measures the very quantity that is mis-marked, so the
leak is invisible to it by construction. `SubVaults.t.sol:231
test_exitDrawsIdleFirst_childUntouched` asserts this exact behaviour **as correct**.

**Remediation.** Mark child positions net of the realization cost the child would actually charge —
its `keepBps` and expected `feeFrac` are readable — or accrue the drag to the exiting member rather
than the remainers. **Requires redeploy + re-review of the look-through valuation and
`_settleExit`'s cash-target computation.**

---

### H-6 — The SV-5 child unwind is sized gross but repaid net, making `ExitNeedsChildSettlement` structurally unsatisfiable

| | |
|---|---|
| **Severity** | **HIGH** (base Medium × immutable → High) |
| **Status** | **CONFIRMED** — executing PoCs from the accounting and DoS passes independently |
| **Files** | `VaultCore.sol:548-576`, esp. `:556-557`, `:559-571`, `:576` |

The shortfall loop sizes `cs = childShares * takeWad / cv` from the **gross** child value, requesting
`takeWad` gross — but the child pays `takeWad × keepBps/BPS × (1 − feeFrac)`. `:571` correctly
reduces the shortfall by what *actually arrived* (the E5 fix), so a residual always survives; `++i`
advances unconditionally so **no child is ever revisited**; and
`require(shortfallWad <= SHORTFALL_DUST_WAD)` (`:576`, tolerance 1e-6 USD) reverts the whole exit.

**Three independent triggers, all confirmed:**
- **In-kind truncation alone** — no fee, no gain, no price move. An 8-decimal child asset leaves a
  fraction-of-a-unit residue ≈ 5e14 WAD against a 1e12 tolerance (**500×** over).
- **Any unrealized gain in the child** — the 10% performance fee leaves ~$25 residue on a $500
  shortfall (**~2.5e19 WAD**, 7 orders over). This is the unconditional variant.
- **Any child exit fee**, whenever the parent is not the child's sole holder (`:505` waiver does
  not apply).

**Convergence is not a rescue:** the residual is geometric, `shortfall × f^k`. At the 10% fee rate a
$1,000 shortfall needs `k >= 9` children to fall under tolerance, and `MAX_CHILDREN = 8`.

**The honest statement of impact.** This is *not* a permanent vault-wide lock: a partial exit covered
by parent idle succeeds, and governance can call `redeemFromChild` to top up idle. The accurate
claim is that **a member cannot exit the child-backed fraction of their position without a passing
governance vote** — converting an unconditional exit right into a governance-liveness dependency,
precisely what SV-5 was written to avoid. Once idle is drained, every member is blocked at every
size, including a one-share exit (asserted).

**This is broader than the accepted E5 residual**, which is scoped to a *failing token transfer*.
Ordinary child fees and ordinary truncation hit the identical `require` on the default
configuration, and E4/E5's *"bounded retry"* disposition is wrong: retry cannot help, because the
shortfall is a **fee**, not a timing artifact.

**Remediation.** Size `cs` against the *net* recoverable value; or retry a child until exhausted
rather than advancing `i` unconditionally; or degrade an uncovered residue to the EE-6 escrow path
instead of reverting. **Requires redeploy + re-review of `_settleExit`'s shortfall loop.**

---

### H-7 — A frozen child governance permanently strands the parent's exit path, and closes the governance rescue with it

| | |
|---|---|
| **Severity** | **HIGH** |
| **Status** | **CONFIRMED** — executing test from the DoS pass |
| **Files** | `VaultCore.sol:548-576`, `:553`, `:707-708`, `:722-728`; `Governance.sol:519-521` |

Apply **C-2** to a *child*. `_childPendingExecution(child)` returns true forever, so the shortfall
loop `continue`s past that child on every iteration (`:553`); if no other child covers the shortfall,
`:576` reverts. The escape hatch closes in the same move: `redeemFromChild` →
`_redeemChildMeasured` → `child.requestExit` queues the parent's exit and reverts
`ChildSettlementPending` (`:708`).

Confirmed: a parent with 1,900 of 2,000 idle allocated to a child whose creator registered it with
`revealDuration = type(uint32).max`. `alice.requestExit` on the **parent** reverts
`ExitNeedsChildSettlement`, still reverting after 100 years; `parent.redeemFromChild(...)` reverts
`ChildSettlementPending`.

**Why this is distinct from C-2.** The parent's members never chose the child's governance config —
the *child's creator* did — and parent members have **no** governance action that helps, because
their only lever is the path that reverts. This contradicts E4's *"clean rollback + bounded retry
(child timelock)"*: there is no timelock bound when the child never leaves `Active`.

**Remediation.** Fixing **C-2** removes the trigger. Independently, `_settleExit` should degrade a
permanently-pending child to the escrow path rather than reverting. **Requires redeploy +
re-review.**

---

### H-8 — The `<5`-member quorum regime is stake-blind and its boundary is purchasable for dust

| | |
|---|---|
| **Severity** | **HIGH** (base Medium × immutable → High) |
| **Status** | **PLAUSIBLE** — derived from source by two independent passes; no executing test |
| **Files** | `Governance.sol:252`, `:435-441`, `:60`; `VaultCore.sol:369-378`, `:394-397` |

The regime is selected solely by `p.memberCount` (`:435`), snapshotted as `pastHolderCount(nowTs-1)`
(`:252`); `holderCount` increments for **any** address with `sharesOf > 0` regardless of size. The
proposer chooses the block. Two distinct attacks follow.

**(a) Buy your way into the stake regime.** A vault with 4 holders — A 40%, B/C/D 20% each — is in
the signer regime, where A needs 3 of 4 revealers and cannot act alone. A deposits `minDepositUsdc`
from a fresh address (`skipWindow()` is permissionless, so deposit+activate is one transaction),
then proposes in the next block: `memberCount` = 5 → **stake regime** → A alone reveals FOR,
`40% ≥ 25%` ✓ → **Passed** with A the only participant. Cost: **1 USDC** in the repo's only worked
config, fully recoverable.

**(b) The signer regime has no stake floor at all.** In that branch `quorumBps` and `snapshotTotal`
are never consulted — quorum is a **head count** of revealers, each needing only `weight > 0`.
Against a single-holder vault, three dust sybils give `3 × 2 > 4` and pass an arbitrary Rebalance on
approximately zero stake if the incumbent does not reveal AGAINST within the reveal window.

**The inverse also works:** `k` permanently-held dust addresses raise the signer denominator, so
`k >= n` blocks every proposal while `n + k <= 4`. For a new 1–2 member vault, **$1–$2 of dust makes
it ungovernable forever** — and governance is the only route to `executeRebalance`.

**This refutes CM-7's disposition**, which names this exact attack (*"Sybil to 5 to switch regimes"*)
and mitigates with *"regime is snapshotted per proposal at creation."* The snapshot binds changes
made **after** creation and does nothing about the proposer arranging membership **before** it.
`SPRINT6-GOVERNANCE-REVIEW.md:315-320` concludes *"No path found … without real deposits"*; the
required real deposit is one dollar.

**Remediation.** Select the regime by stake distribution rather than address count; impose a
minimum-stake threshold for `holderCount` membership; and give the signer regime a stake floor as
well. **Requires redeploy + re-review of the quorum regime and holder accounting.**

---

### H-9 — Read-only cross-contract reentrancy: a parent's look-through NAV is readable mid-mutation

| | |
|---|---|
| **Severity** | **HIGH** (base Medium × immutable → High) |
| **Status** | **PLAUSIBLE** — derived from source by two independent passes; no executing test |
| **Files** | `VaultCore.sol:765-771` vs `:773`, `:776`; `:695-717` (`:707` vs `:711`/`:715`); readers `:274`, `:282`, `:286`; consumers `:324`, `:391`, `:515`, `:555` |

Two windows exist where a `VaultCore`'s internal accounting is understated while an external call is
in flight:

- **`executeRebalance`** debits before and credits after: `idleUsdc -= o.amountIn` (`:765-771`) →
  `safeApprove` (`:773`, full gas) → `executeSwap` (`:776`, full gas) → `idleUsdc += received`
  (`:782-783`).
- **`_redeemChildMeasured` with `credit = true`** (the governance path) credits only at `:711`/`:715`,
  *after* `child.requestExit` returns at `:707`.

`nonReentrant` protects *that* vault. It does **not** protect an ancestor: vaults are different
instances with independent `_lock` slots, and an ancestor reads the descendant's live state through
**unguarded view functions** (`idleUsdc()`, `assetBalance()`) inside `_childValueWad`/`_fullNavWad` —
which are consumed by the ancestor's *mutating* paths (`deposit` capacity `:324`, `_mintShares` price
`:391`, `_settleExit` `:515`/`:555`).

**Exploit.** The attacker takes a child's governance per **C-1**, executes a rebalance routed through
an attacker-controlled hop token, and from that token's hook calls `V.deposit(d)` while `V`'s NAV is
understated by `h`. With `θ = h/N` and `x = d/N`, gain is `xN·θ/(1−θ+x)` — for `θ=0.5, x=0.1`,
roughly **+8.3% of N on a 10%-of-N outlay**, ~90% of that net of fees. A second victim path calls
`V.settleQueuedExit(victim)` from the same hook, shorting the victim's cash leg. A variant requiring
**no governance capture** exists if any basket token calls out on `approve`, which hits `:773`
directly — hostile basket tokens are explicitly in the declared threat model.

**Verified consistent** (not a finding): the member-exit path (`credit = false`) completes all
internal accounting at `:523-543` before the first external call at `:587`, so CEI holds there.

**Note on the prior disposition.** `SLITHER-TRIAGE.md:39` dismisses every reentrancy row because
*"every flagged function carries the `nonReentrant` mutex."* That reasoning is sound for
same-contract reentrancy and does **not** cover a different `VaultCore` instance being read through
views — and Slither does not model that either, so the row's reasoning and the analyser's blind spot
coincide. No prior treatment of read-only or cross-contract reentrancy appears anywhere in `docs/`.

**Remediation.** Expose a reentrancy status the ancestor can read and have `_childValueWad`/
`_fullNavWad` revert when any traversed vault reports it locked; or reconcile the debit/credit in a
single post-call step. **Requires redeploy + re-review of `VaultCore`'s execution, child-redemption
and look-through paths.**

---

## MEDIUM

| ID | Finding | Status |
|---|---|---|
| **M-1** | **`OracleAggregator`'s constructor accepts the same source address repeated**, leaving SF-1 source-independence entirely unenforced (`:60-72` — the `:68` duplicate check is on *assets*, not sources). `[S,S,S]` satisfies "3 sources" and any quorum; its median is just `S`, and `assetConfig` shows a compliant-looking 3-source set only address-by-address comparison distinguishes. Combined with H-1, that one source both sets the price and can trip the breaker. This is distinct from the accepted SF-1 residual: correlated upstreams behind different addresses is genuinely out of code's reach, but literal address equality is trivially in reach and unchecked. Fix: an O(m²) distinctness loop (`m ≤ 15`). | **CONFIRMED** (test) |
| **M-2** | **The USDC settlement legs have no EE-6 escrow isolation**, unlike every other transfer: `:611`, `:642` and `:363` use reverting `safeTransfer` while basket assets use `tryTransfer`+escrow (`:624`, `:629`). A blacklisted member cannot exit **at all** and loses their in-kind legs too — the precise outcome EE-6 exists to prevent; `cancelPending` (`:363`) is worse, being unconditional, so a member blacklisted after depositing has their pending escrow permanently stranded. **Systemically:** `feeEngine` is a factory-wired singleton shared by every vault (`VaultFactory.sol:63,126`) and is exactly the address class that attracts a blacklist — once listed, `:611` reverts and **every exit carrying a positive performance fee, in every vault, reverts permanently**. Precondition (stated honestly): `usdcPay > 0`, i.e. the vault holds idle USDC — the ordinary steady state, since deposits credit `idleUsdc` and SV-5 draws cash first. Falsifies PX-1's claim that in-kind redemption *"keeps non-USDC basket assets exitable."* Fix is mechanical and already designed: route both USDC legs through `tryTransfer` + `claimable`, which `claimEscrowed` already handles asset-agnostically. | CONFIRMED (reasoning) |
| **M-3** | **`FeeEngine.pullEscrowed` is unguarded and its balance delta straddles a full-gas external call** (`FeeEngine.sol:115-125`). `FeeEngine` has no mutex; nesting targets a *different* vault, so `VaultCore`'s guard does not help. The outer call measures `X+X2` while the inner correctly credits the victim `X` ⇒ `2X+X2` credited against `X+X2` delivered; the attacker claims first. The precondition is attacker-controlled: escrow at `VaultCore.sol:637` is populated only when `tryTransfer` returns false, which a hook token decides on demand. Caveat: ERC-777 specifically does **not** work (FeeEngine is not an ERC-1820 implementer). Fix: add a mutex, or credit from the callee's reported `claimable` read before the call. | PLAUSIBLE |
| **M-4** | **A settlement token with fewer than 6 decimals bricks every redemption.** `:221` bounds only `dec <= 18`; `shortfallWad` is the sub-unit truncation residual, uniform in `[0, usdcScalar-1]`, and `:576` requires `<= 1e12`. So `dec >= 6` is required but unenforced: at `dec=5` ~90% of exits revert and at `dec=2` (e.g. GUSD, a real USD stablecoin) ~99.99%, from a vault with **no children at all** — and `ExitNeedsChildSettlement` is a misleading error for a pure truncation artifact. Requires a creator to choose such a token, but constructor validation is explicitly described as load-bearing against a hostile creator. Fix: `require(usdcScalar <= SHORTFALL_DUST_WAD)`. See also **L-2** for the zero-margin observation at the canonical 6 decimals. | CONFIRMED (derivation) |
| **M-5** | **`navWad()` costs ~12.0M gas at the `MAX_CHILDREN` fan-out**, measured at 8×8 = 73 vaults with 10 assets each and the minimum 3 sources/asset; `deposit` 12.1M, a settled `requestExit` 12.9M. `NavGas.t.sol:146` asserts `< 600_000` against a single 1-child/1-grandchild, 3-asset config over stub sources — the reachable worst case is **20× its ceiling** on gas and **~122× on `priceWad` call count** (730 vs 6). `_settleExit` traverses the tree at least twice (`:514-516`, then `:555`) and that path is unmeasured. **There is no path to remove a child** — `childVaults` only ever grows (`:666`) — so once the tree crosses the block gas limit, capital is permanently locked. Each `ChildAllocation` looks reasonable in isolation; the cliff is invisible until crossed and irreversible after. | CONFIRMED (measured) |
| **M-6** | **Every named CM-6/VO-5 defense is optional, and the repo's only worked config disables all three.** `proposalThresholdBps = 0`, `concentrationCapBps = 10000`, `proposalCooldown = 0` in both `base-mainnet.json:146-155` and `base-sepolia.json:43-51`; `proposalCooldown` is **not validated at all**. With the cap at 10000, one delegate can carry 100% of snapshot stake, so one live participant plus a permissionless cranker manufactures full quorum from offline delegators — defeating VO-2's "quorum measured against live participation" rationale. Fix: protective bounds in `_validateConfig`, plus a production reference config that does not disable its own defenses. | CONFIRMED (inspection) |
| **M-7** | **Serial-proposal exit freeze.** `hasPendingExecution` is true for any `Active` proposal past `commitDeadline` — passage irrelevant. With `proposalCooldown = 0`, an attacker holding `minDepositUsdc` cycles `propose → wait → finalize(Defeated) → propose`, freezing exits on a ~50% duty cycle indefinitely for gas; members calling `requestExit` inside a frozen window are **irrevocably** queued. Even at a fully compliant config, a `Passed` proposal holds Mode F for `timelockDuration + executionWindow` — ~31 days at the hard cap, repeatable, which is not what EE-10's *"no indefinite lock"* conveys. Bounded only by the ≥1 h commit phase per cycle. | PLAUSIBLE |
| **M-8** | **Voters approve an opaque 32-byte hash; no on-chain payload disclosure exists.** `propose` stores and emits only `actionHash` (`:98`, `:255`); the preimage surfaces only in `execute`'s calldata — *after* the vote, the finalize and the entire timelock. Voters have no on-chain means to verify what they are approving. `propose` never checks that `actionHash` decodes to anything, so a hash of random bytes yields an unexecutable `Passed` proposal (the state **C-2** makes permanent), and a malformed-but-matching payload reverts inside `execute` for the same effect. A lapsed `SwapOrder.deadline` — fixed at propose time, never compared against `executableAt` — does likewise. Fix: validate decodability at propose time and require `deadline >= executableAt + executionWindow`. | PLAUSIBLE |
| **M-9** | **Settlement timing is a free option over the exit performance fee.** `finalize` (`:428`) and `settleQueuedExit` (`VaultCore.sol:476`) are both permissionless with no upper deadline and can be bundled atomically. Payout *quantities* are price-independent, but `payoutValueWad` drives `gain`/`perfFee`/`feeFracWad` (`:585-605`). A queued member waits for a block where `payoutValueUsdc <= basisRemoved`, takes the `else` branch at `:594`, and pays **zero** performance fee while receiving identical tokens — avoiding up to `gain/10`. Waiting is otherwise free, since the tenure exit fee only decays. The mirror is live too: a searcher can force a victim's settlement at a price peak. Whoever wins the ordering race sets the other party's fee. | PLAUSIBLE |
| **M-10** | **Commit-reveal binds an address, not an economic actor.** The commitment is `keccak256(abi.encode(pid, msg.sender, support, salt))` (`:292`). A whale splits stake across two addresses, commits FOR from one and AGAINST from the other, reads the public mid-reveal tally, and reveals only the side it now wants — converting a blind commitment into an **informed last-mover choice** at the cost of the forfeited half. VO-7's reasoning (*"the commit binds `support`, so a late revealer cannot change direction"*) holds per address and fails per actor. Cheaper still in the signer regime, where quorum counts addresses rather than stake. | PLAUSIBLE |
| **M-11** | **`SafeTransferLib`'s non-`try` helpers are returndata-unbounded, so the MO-2 hardening covers one of four call shapes.** `:11-26` copy the **entire** returndata into `bytes memory ret`; a returndata-bombing token OOGs every one of them — the exact failure MO-2 was written to close, on the paths it does not cover. A token returning 1–31 bytes also makes `abi.decode(ret,(bool))` revert with a decoder panic, so the intended `TransferFailed` error is unreachable for the malformed-return case. Reachable at `:611`, `:642`, `:363`, `:816` (`claimEscrowed` — so an asset that degraded to escrow can be permanently unclaimable), `:673/675`, `:773/779`, and both adapters. Confirmed correct: 0 bytes → success (USDT-compatible); `tryTransfer` (`:34-57`) is genuinely bounded. | CONFIRMED (inspection) |
| **M-12** | **The `VERIFIED-ON-CHAIN` badge licenses less than it appears.** In `scripts/verify-mainnet-config.mjs`: the router-selector check (`:144-149`) returns a hard-coded `{pass:true}` — **1 of 22 checks cannot fail**; `maxObservationAgeSeconds` is **never checked at all** and `observations(uint256)` is called **zero** times anywhere in the repo, so the one pool tuple guards 2 and 3 actually read is never exercised; the `observe([1800,0])` check reports success as *"the full window is retained"* when success is equally consistent with *the pool having been dead for ≥30 minutes* — the two opposite conclusions it exists to separate; and pool tokens are matched by `symbol()` string while the constructor matches **addresses**. The gate therefore cannot observe the parameter behind **H-2**. | CONFIRMED (inspection) |
| **M-13** | **No deploy script can consume `base-mainnet.json`.** `Deploy.s.sol` (the mainnet script) reads **no config file** and deploys only the five singletons — it constructs no `OracleAggregator`, no source adapter, no execution adapter. `DeployTestnet.s.sol` could be pointed at the file but its `_readAssets` requires an `.assets[i].feeds` address array that the mainnet schema does not have, and it only ever builds `ChainlinkSourceAdapter`s, so it cannot express the 3-class stack. **Every mainnet constructor argument is therefore hand-transcribed**, and every claim M-12 makes is evidence about a *document*, not about a deployment. Compounding: `Deploy.s.sol:63-75` performs the three irreversible `wire()` calls and then only `console2.log`s, while the throwaway `DeployTestnet.s.sol:119-129` asserts the full wiring — **the mainnet script has strictly weaker post-conditions than the testnet one**, and performs no chain-id assertion at all. | CONFIRMED (inspection) |
| **M-14** | **Gas-capped `view` callers receive a silently different, successfully-returned, wrong NAV.** Because `catch {}` absorbs out-of-gas in the nested frame, a caller capping gas starves later sources while earlier ones succeed and `priceWad` **returns normally** with a smaller `k` — which, per H-1, is specifically the *minimum* of the surviving prefix. Measured: 2405.0 unlimited vs **2400.0** at ≤800k gas. **State-changing paths are refuted with a number:** a 225,560-gas post-price tail requires ≈14.4M gas inside a starved source, above the block limit, and a 100k→5M sweep found no level producing a successful deposit at a starved price. So this affects `navPerShareWad`, `previewDeposit`, `previewRedeem` and `totalAssets` consumers — integrators, keepers, front-ends, multicall aggregators — not deposits or exits. | CONFIRMED (measured) |
| **M-15** | **No slippage or deadline protection on entry or exit.** `deposit(uint256)` takes no `minSharesOut` and no deadline; shares mint at whatever NAV the including block produces (`:391`). `requestExit(uint256)` takes no `minValueOut`. Every entry and exit is an unbounded market order — the user-side half of C-4/H-1/H-2, where a depositor who can *see* an anomaly still has no transaction-level defence. Note the asymmetry: `IExecutionAdapter.SwapOrder` carries both `minAmountOut` and `deadline`, so the protection exists for the operator's swaps and not for the member's principal. | CONFIRMED (inspection) |

---

## LOW

| ID | Finding | Status |
|---|---|---|
| **L-1** | **`VaultFactory.createChildVault` performs no authorization on `parent`** (`:100-110`) — only `parent.usdc() == p.usdc` and the basket-subset rule. Anyone may permanently attach an arbitrary child under any vault; `registerChild` is creation-time-only with **no removal path**. Low standalone (moving funds still needs the parent's governance), but it is the enabler that removes the timelock race in **C-1**. Fix: require `msg.sender == VaultCore(parent).creator()`. | **FIXED** (merged, commit `b50f652a`): `VaultFactory.createChildVault` now requires `msg.sender == parent.creator()` (`NotParentCreator`); regression `SubVaults::test_remediated_onlyTheParentsCreatorMayAttachAChild`. Now moot at launch behind the C-1 `allowSubVaults` gate, but retained for the enabled path. |
| **L-2** | **`SHORTFALL_DUST_WAD` passes at the canonical 6 decimals with exactly zero margin.** The maximum truncation residual is `usdcScalar − 1 = 1e12 − 1` against a `<= 1e12` bound — one unit of slack. Correct today, but there is no headroom for any future change to the residual's derivation, and the relationship is undocumented and unasserted. Fix: assert the invariant explicitly rather than relying on the coincidence. | CONFIRMED (derivation) |
| **L-3** | **`BoundedCall` returns a word built from uninitialised memory** for 1–31-byte returndata (`:19-25`, `:34-43`). Two of five call sites gate on `retSize >= 32`; **`VaultCore.sol:588` (`perfFee = feeWord`) does not**. Bounded to Low by the `cap = gain/10` clamp at `:590-592` and by `feeEngine` being factory-pinned. Fix: zero `ptr` before the copy, or gate on `retSize`. | CONFIRMED |
| **L-4** | **`minCardinality: 900` in `base-mainnet.json` is off by one.** A ring of `C` slots spans `(C−1) × blocktime`, so 900 slots cover 1798 s against an 1800 s window and the constructor **reverts**; 901 succeeds. Fails closed, and the deployed pools are at 5000/2000/5000, so it is not currently triggered — it would bite the next asset listing. | CONFIRMED (test) |
| **L-5** | **Basket-asset admission validates only `decimals() <= 18`** (`:236-242`), while `assetBalance` is a fixed internal number. **Rebasing tokens** silently break: a negative rebase leaves `assetBalance` overstating real holdings, slices are sized from the overstated figure, `tryTransfer` fails, and value escrows into `claimable` where it can never be satisfied — with NAV overstated for the life of the vault. **Double-entrypoint tokens** double-credit: both entrypoints pass the `assetUnit[a] == 0` uniqueness check, and the per-address `balanceOf` snapshots at `:704`/`:713` both rise on a single transfer. Creator-chosen and disclosed by inspection, hence Low. | PLAUSIBLE |
| **L-6** | **SV-6 quorum-floor inheritance is never re-checked on children.** `_requireParentQuorumFloor` (`:193-199`) walks *upward* only, so a parent that later raises its own quorum by RuleChange leaves children at the old, looser floor — *"a child may never be easier to pass than its parent"* silently fails. It also returns silently when the parent is not yet registered (`:196`), and `wireSubVaultRegistry` being un-called disables SV-6 entirely with no on-chain signal. | PLAUSIBLE |
| **L-7** | **Asymmetric absentee recall.** `clearStandingDefault` (`:363-366`) has **no phase guard**, so a member watching the live tally can withdraw their default mid-reveal; `setDelegate` is locked for the whole proposal (`:412-415`), so a delegator has **no** way to recall delegated weight. The weaker, tally-only instrument is freely revocable; the stronger one, which counts toward quorum (`:333`), is not. | PLAUSIBLE |

---

## INFORMATIONAL

- **I-1 — Pyth `conf` is validated at no layer before deploy.** `PythSource`'s constructor checks only
  `expo` (`:107`); the verification script decodes `getPriceUnsafe` but never reads the `conf` field;
  `verification.checks` does not mention it. A feed whose confidence routinely exceeds 1% of price
  deploys cleanly and then **withholds forever, invisibly** — undetectable in a 2-of-3 quorum until
  one of the other two fails, at which point **H-1** applies. Nothing bounds `pythMaxConfBps` from
  below either, so a creator can pin a value so tight the leg never votes.
- **I-2 — `MODULE_CALL_GAS = 300_000` is a hardcoded gas amount on an immutable protocol**
  (`VaultCore.sol:45`, used at nine sites). Any future repricing that pushes a bounded callee past
  300k makes it fail *silently and permanently* — `_recordRealization` degrades to an event, so the
  loss carryforward stops accruing with no other on-chain signal; on `tryTransfer` sites, repricing
  pushes legitimate tokens into escrow. There is no way to raise the constant.
- **I-3 — `base-mainnet.json` contradicts itself about its own status:** `status:
  "VERIFIED-ON-CHAIN"` while `pythNote` still reads *"UNVERIFIED"* and `verification.note` still says
  *"Run every line … before flipping `status`."* Cosmetic, but it is the field a human reads to
  decide whether to deploy. (Structural checks did pass: all 12 addresses are valid EIP-55
  checksums, all three Pyth IDs are 64 hex chars, and every bound holds against its contract-level
  ceiling.)
- **I-4 — Dead code and stale documentation.** `Checkpoints.latest`, `TickMath.MIN_SQRT_RATIO`/
  `MAX_SQRT_RATIO`, and `IGovernance.isExecutor`/`Governance.isExecutor` (`:529-531`) have no
  consumers. `VaultCore.MAX_LOOKTHROUGH_DEPTH = 3` permits one level deeper than
  `SubVaultRegistry.MAX_DEPTH` can produce, so the deepest `_fullNavWad` branch is unreachable.
  Separately, **four** documentation sites (`Governance.sol:84`, `:119`, `:337-339`, and VO-5)
  state the concentration cap includes the delegate's own weight; the code caps **received** weight
  only — the deliberate G1 fix documented at `:296-298`. The shipped property is `own + cap`, not
  `cap`. The code is correct; the documentation is not.
- **I-5 — Fees can be stranded in `FeeEngine`.** `:611`/`:629` transfer **before** the bounded
  accounting callbacks at `:612`/`:630`. If a callback fails, tokens sit in `FeeEngine` with no
  `claimableFees` credit and no sweep function — permanently unclaimable. Unlikely at 300k gas.

---

## 4. Coverage ledger

Every in-scope file, every external/public state-changing function, and every coded threat-model row,
with a verdict. **No line is left implicitly passed.**

### 4.1 Contracts

| File | LoC | Lenses | Verdict |
|---|---|---|---|
| `VaultCore.sol` | 906 | 1,2,3,5,6,7,9 | **Defects:** C-4, C-5, H-5, H-6, H-7, H-9, M-2, M-4, M-5, M-15, L-2, L-3, L-5. Reentrancy-guard coverage on all 11 mutating externals verified **complete**; CEI on the member-exit path verified correct. |
| `Governance.sol` | 532 | 1,2,5,7,9 | **Defects:** C-1, C-2, C-5, H-8, M-6..M-10, L-6, L-7, I-4. Every function and every branch walked; quorum enumerated for `memberCount` 0–6. |
| `OracleAggregator.sol` | 158 | 3,4,9 | **Defects:** C-3, H-1, M-1, M-14. Every line walked; median enumerated for k=0..5. |
| `oracle/UniswapV3TwapSource.sol` | 369 | 3,4,8 | **Defects:** H-2, L-4. Guards, both quote branches, both token orderings and two-hop composition walked. One self-refuted claim recorded. |
| `oracle/PythSource.sol` | 148 | 3,4,8,9 | **No exploitable defect.** expo/conf math re-derived correct, including the load-bearing `MIN_EXPO` guard ordering (a `try/catch` cannot absorb a panic in the success block). Deploy-time gap → I-1. |
| `oracle/vendor/TickMath.sol` | 81 | 3,8 | **Clean.** All 20 constants verified at **0 ulp** against independent 200-digit computation; bit-pairing confirmed by permutation search; both endpoints exact; max deviation 2.328e-10 matches the file's own claim. |
| `oracle/vendor/FullMath.sol` | 89 | 3,8 | **Clean.** Faithful port; fuzzed 200,012 cases, **0 mismatches**. The `prod1 == 0` fast path IS canonical upstream (a suspected port addition — refuted). |
| `FeeEngine.sol` | 136 | 1,2,3,6,9 | **Defects:** M-2, M-3, I-5. Fee/carry math re-derived correct and complementary. |
| `OperatorRegistry.sol` | 162 | 1,3,6 | **No exploitable defect.** Carry cannot be double-consumed. Manufactured-loss-carry probed; self-corrects. |
| `AggregationRouterAdapter.sol` | 78 | 1,2,3,8,9 | **Defects:** H-4. Full-balance sweep and missing guard noted; approvals verified correct; bounded by the vault's own delta re-check. |
| `DirectPoolAdapter.sol` | 95 | 1,2,3,8 | **No defect.** V2 formula canonical; swap direction verified both ways. Not deployed by any config. |
| `SubVaultRegistry.sol` | 105 | 1,3,5,7 | **No exploitable defect.** Fee stacking exact; depth cap matches; cycles structurally impossible (though the guard relies on the factory, not itself — noted). |
| `VaultFactory.sol` | 140 | 1,2,8 | **Defects:** L-1; PX-4 residual challenged (§5). |
| `VaultDeployer.sol` | 106 | 1,2,8 | **Clean.** CREATE uses a compile-time-pinned blob; holds no authority; attestation stays factory-gated. Refuted as an attack path. |
| `lib/BoundedCall.sol` | 46 | 2,7,9 | **Defect:** L-3. |
| `lib/Checkpoints.sol` | 46 | 2,5,9 | **Clean.** `push` writes only at `block.timestamp`; same-second overwrite is load-bearing and correct; `uint192` overflow unreachable. |
| `lib/SafeTransferLib.sol` | 58 | 2,6,9 | **Defect:** M-11. `tryTransfer` assembly verified correct for all returndata shapes. |
| `interfaces/` (5) | ~94 | 1,2,4 | **Clean.** `IOracleAggregator.priceWad` is `view` ⇒ STATICCALL, which kills oracle reentrancy. |

### 4.2 Threat-model rows

All 45 coded rows reviewed. **Eight documented mitigations do not hold as written:**

| Row | Verdict |
|---|---|
| **EX-2** | **NOT IMPLEMENTED** — H-4. |
| **CM-7** | **DOES NOT HOLD** — H-8; the snapshot binds the wrong side of proposal creation. |
| **EE-10** | **DOES NOT HOLD**, on three independent counts — **C-2** (no bounded deadline), **C-5** (exited *and* Mode-F-queued shares both retain full weight on the in-flight proposal), **M-7** (~31-day repeatable lock even at a fully compliant config). |
| **VO-7** | **RESIDUAL MATERIALLY LARGER** — M-10; direction-binding is per address, not per actor. |
| **MO-1** | **SCOPE CLAIM FALSIFIED** — C-2; the Mode-I fallback covers a *broken* module, not a correct governance answering `true` forever. |
| **MO-2** | **PARTIALLY FALSIFIED** — M-11; returndata bounding covers `tryTransfer` only, one of four call shapes. |
| **SF-1** | **NOT UPHELD** — M-1 (independence unenforced) and H-1 (median robustness fails at the documented quorum). |
| **PX-1** | **PARTIALLY FALSE** — M-2; the reverting USDC leg takes the whole settlement down, so in-kind assets are *not* kept exitable. |
| **SV-1 / SV-7** | **GOVERNANCE NOT UPHELD** — C-1. Look-through *pricing* is correct (verified); child *governance* is not. |
| EE-1 | **UPHELD** — NAV never reads `balanceOf`; verified across all paths. Donation defence holds. |
| VO-9 | **UPHELD in the deposit direction** (control test passes); silent on withdrawal — C-5. |
| PX-4 | **UPHELD as to authority** (see §5 for the challenge to its accepted residual). |
| EE-7 | **UPHELD** — shares are non-transferable; no `transfer`/`approve`/`transferFrom` exists. |
| MO-3, MO-4 | **UPHELD** — queue-time gate and uniform fee withholding verified. |
| CM-1..CM-6, CM-8, EE-2..EE-6, EE-8, EE-9, EE-11, EX-1, EX-3, EX-4, SF-3..SF-5, SV-2..SV-6, VO-1..VO-6, VO-8, PX-2, PX-3 | Reviewed; no new defect beyond those reported above. |

### 4.3 Standards sweep (SWC-100…136)

All 37 entries walked. **Not present / not applicable (24):** SWC-100, 103, 105, 106, 108, 109, 110,
111, 112 (no `delegatecall` anywhere — verified by grep), 115 (no `tx.origin`), 117, 118, 119, 120
(no randomness consumed), 121, 122, 124 (no `sstore` in any assembly block; all six sites
`memory-safe`), 125, 127, 129, 130, 132, 133 (no `abi.encodePacked` anywhere).

**Applicable — defended:** SWC-101 (0.8 checked math; all five `unchecked` blocks individually
verified, all failing closed), SWC-104 (return values checked at every site), SWC-107 (mutex complete
for same-contract; see H-9 for the cross-contract case), SWC-116 (`block.timestamp` deliberate per
C-2 — but see H-2 for the one unsound use), SWC-126 (`BoundedCall`; the inverse gas-starvation attack
refuted with numbers).

**Applicable — PRESENT:** SWC-113 (DoS with failed call — M-2, M-11, H-6), SWC-114 (transaction-order
dependence — M-9, M-10, M-15), SWC-128 (block gas limit — M-5), SWC-123 (requirement violation —
M-8), SWC-131/135 (unused code — I-4), SWC-134 (hardcoded gas — I-2), SWC-136 (unencrypted on-chain
data — VO-7 residual, plus unenforced salt entropy).

**Recent DeFi exploit classes.** Share inflation / first-depositor / donation: **refuted** (internal
accounting, `minted > 0` required, smallest first mint 1e12 share-wei, exit-fee pump bounded to
100 bps). Price-of-share manipulation via donation: **defended** — this one could not be broken.
Oracle manipulation: **present** (C-3, C-4, H-1, H-2). Read-only reentrancy: **present** (H-9).
Callback/hook tokens: **partially present** (M-3, L-5). Fee-on-transfer: defended on the vault
(measured deltas everywhere), **not** on `FeeEngine`'s vault-reported credit paths. Signature replay
/ domain separation: **not applicable** — no signature scheme exists anywhere in the tree (verified
by grep for `ecrecover`, `_TYPEHASH`, `permit`, EIP-712 domain — zero hits), so the
"USDC EIP-712 domain varies per chain" hazard does not arise. Approval race: **refuted** (0→amt→0 at
all three sites, so the USDT nonzero-approval revert never triggers). Dust-loop extraction:
**refuted with numbers** (~$1e-6 per exit against ≥150k gas — ~3,400:1 against the attacker; and
`:538`'s truncation loss exceeds `:621`'s gain by construction). Arbitrary-calldata router class:
**partially present** (H-4), materially bounded by the vault's independent delta re-check.
Flash-loan governance capture: **present in the withdrawal direction** (C-5); the deposit direction
is correctly defended.

### 4.4 Audit test artifacts

All under `contracts/test/audit/`; `contracts/src` never modified. (They were authored under
`docs/audit/tests/` and moved when they landed in PR #36 — that path is not in the tree.)

| File | Tests | Covers |
|---|---|---|
| `AuditAggregatorDecodeBrick.t.sol` | 5 | C-3 |
| `AuditAggregatorLowerMedian.t.sol` | 5 | H-1, M-1 |
| `AuditDosExitLiveness.t.sol` | 5 | C-2, H-6, H-7 |
| `AuditExecutionWindowFreeze.t.sol` | 4 | C-2 |
| `AuditOracleToShareTheft.t.sol` | 2 | C-4 |
| `AuditTwapPartialQuiet.t.sol` | 3 | H-2 (weight law) |
| `AuditTwapRealCostModel.t.sol` | 3 | H-2 (correction + surviving finding) |
| `AuditTwapSpotDegeneration.t.sol` | 4 | H-2, H-3 |
| `AuditVoteAfterExit.t.sol` | 2 | C-5 (incl. passing VO-9 control) |
| **Total** | **33** | **33 passing** |

The table above is the count **as audited**, against the pre-remediation tree. **30 are in the
tree today:** the three C-2 cases in `AuditExecutionWindowFreeze.t.sol` were removed when the C-2
hard caps landed (PR #36) — they asserted the *unfixed* behaviour, so keeping them would mean a
permanently-red suite, which is noise rather than evidence. That file's header records the removal
and the exploits survive in git history; the fix is pinned by
`Governance.t.sol::test_phaseDurationHardCapsEnforced`. Verified 2026-08-27: the command below
runs 9 suites / 30 tests, all passing.

```bash
cd contracts && forge test --match-path "test/audit/Audit*.t.sol" -vv
```

**Remediation-era additions (post-`v0.3.0-audit`, same directory).** Later fixes added their own
regression suites under `contracts/test/audit/`, referenced per-finding above:
`AuditProposalThresholdFloor.t.sol`, `AuditSafeTransferBounded.t.sol`,
`AuditFeeEngineReentrancy.t.sol`, `AuditUsdcLegEscrow.t.sol`, and — Phase 2 —
`AuditRootVaultsOnly.t.sol` (2 tests, C-1: one reproduces the funded-child capture with sub-vaults
enabled, one proves it unreachable under the launch "root vaults only" gate).

### 4.5 `SLITHER-TRIAGE.md` — incorrect dispositions

- **`calls-loop` / `costly-loop`** — the cited evidence does not support the claim. The row bounds
  `navWad` at *"~237k gas (`NavGas.t.sol`)"*, but that fixture builds **one** child and **one**
  grandchild with 3/2/1-asset baskets over stub sources — 6 `priceWad` calls. The caps the row
  invokes permit **730** calls over source sets of up to 15. The loops are bounded in *shape* and
  unbounded in *cost* (**M-5**).
- **`reentrancy-*`** — accurate for same-contract reentrancy and incomplete: a `VaultCore`'s public
  views *are* consumed as an oracle by its parent, and a per-contract mutex is definitionally not a
  defence against a different contract reading mid-mutation. Slither does not model this either, so
  the row's reasoning and the analyser's blind spot coincide (**H-9**).
- **`timestamp`** — sound for `Governance` and `Checkpoints`, but omits `UniswapV3TwapSource.sol:255`,
  which is the one timestamp use with security consequence (**H-2**). The row predates Sprint 11 and
  was not updated.
- **`divide-before-multiply`** — correct for the payout legs, but generalizes "rounds in the vault's
  favour" to "is safe." The same pattern at `:557` is exactly what makes `:576` unsatisfiable and
  reverts a member's exit (**H-6**). Those are different propositions.
- **`missing-zero-check` ("Fixed")** — scope statement incomplete but benign: `VaultCore`'s
  constructor also zero-checks none of `operatorRegistry_`, `governance_`, `feeEngine_`, `oracle_`.
  Worth recording the specific silent failure mode: a zero `governance` makes `boundedStaticCall`
  succeed with `retSize == 0`, so `_pendingExecution` returns `false` permanently — the H-1 fallback
  silently masks a mis-wired vault as "always Mode I."

Rows checked and found **correct**: `unused-return`, `incorrect-equality` (including the load-bearing
same-second overwrite in `Checkpoints.sol:23`), `uninitialized-local`, `low-level-calls`, `assembly`,
`too-many-digits`, `missing-inheritance`. The Sprint-10 catch of the unanchored `--filter-paths`
regex is genuinely good work and the corrected form is right.

---

## 5. Threat-model challenge — the accepted rows

The brief asked that accepted-risk rows be challenged rather than rubber-stamped.

| Row | Accepted rationale | Verdict |
|---|---|---|
| **K-4 / SF-2** — staleness breaker freezes exits, no hatch | *"Any exit hatch during staleness IS the stale-price exit the breaker prevents."* | **Agree with the tradeoff; its premise is broken.** K-4 accepts a freeze requiring a *quorum failure*. **C-3** shows **one** source can force it permanently and unilaterally, and **M-1** shows the "≥3 independent sources" bounding the risk are unenforced. Fix C-3 and M-1 and we would accept K-4 as written. |
| **K-2** — one offline member freezes rule changes | *"Near-immutability is the intent."* | **Agree.** Deliberate, clearly documented, and the cost falls on the vault that chose the config. Note it compounds C-2: a vault frozen by C-2 cannot RuleChange out even with full participation. |
| **E7 / EE-5** — latency arb on repeat deposits | *"Bounded by the 1-day staleness ceiling + non-zero exit fee."* | **Disagree — materially understated.** The bound assumes a correct price within a drift band. **H-1**, **H-2** and **M-14** each break the band itself, **M-15** removes any user-side defence, and **C-4** measures the result at 88.9% of a victim's stake. The stated mitigation is the right one; the code does not deliver its precondition. |
| **G3 / CM-5** — single-vault carry farming | *"1% exit-fee cap forces ~100:1 capital fronting + leaderboard drag."* | **Agree.** Independently probed: the cycle self-corrects because `costBasisUsdc` falls by exactly the carry gained. No net-positive path after gas was constructible. |
| **PX-1** — USDC blacklist on a vault address | *"In-kind escrow keeps non-USDC assets exitable."* | **Disagree — the claim is false as written.** See **M-2**: the USDC leg uses reverting `safeTransfer`, so a blacklisted member loses the in-kind legs too, and the shared `FeeEngine` is a single blacklist target that would brick every fee-paying exit protocol-wide. The *risk* is inherent to USDC; the *stated mitigation* does not function. |
| **E4** — parent exit reverts while the only covering child is mid-rebalance | *"Clean rollback + bounded retry (child timelock)."* | **Disagree — the bound does not exist.** **H-7**: a child pinned in `Active` by C-2 never settles, so there is no timelock to bound the retry, and the governance rescue reverts on the same path. |
| **E5** — persistently-escrowing child makes the parent exit revert | *"Known residual (EE-6 asymmetry for child-held slices)."* | **Disagree — far broader than documented.** **H-6**: the residual is scoped to a *failing token transfer*, but ordinary child fees and ordinary in-kind truncation hit the identical `require` on the **default** configuration, and retrying cannot help because the shortfall is a fee. |
| **GA-2 / VO-7** — mid-reveal tally readable | *"Commit binds direction, so no last-mover advantage."* | **Disagree — residual is larger.** **M-10**: binding is per address, and one actor may hold many. |
| **EE-8** — last-two-member exit-fee endgame | *"Bounded at 1%, self-limiting."* | **Agree.** Verified: the sole-holder waiver fires correctly and the effect is bounded. |
| **EE-9** — operator receives exit fee as a member | *"Routing is to shares, not identity."* | **Agree.** Verified: no identity-based routing exists. |
| **SF-3** — cap-squatting on an opt-in capacity cap | *"Squatter's capital is at risk like anyone's."* | **Agree**, with a note: the cap is **not re-checked at activation** (`:379-385` vs `:325-327`), so NAV growth during the observation window can carry a vault past its cap. Informational. |
| **CM-4** — operator sheds carry via a fresh identity | *"Reputation, not funds, is the enforcement."* | **Agree.** Verified the carry is keyed per `(member, opId)` and a fresh identity genuinely starts empty; the accepted residual is stated accurately. |
| **PX-4 / S10 F-1** — `VaultFactory`'s five unvalidated immutables | *"A typo fails loudly; a hostile deployer is unanswerable."* | **Partially disagree.** The five do **not** fail alike. `registry` fails closed and loudly. But a factory pinned to a *valid* `VaultDeployer` holding a different creation-code blob mints **attested, registry-canonical vaults whose code is not `VaultCore`** — exactly the guarantee `VaultFactory.sol:27-30` claims. `VaultDeployer.creationCode()` exists as a verification aid and **nothing consumes it** outside a unit test. Compounding: see **M-13** — the mainnet deploy script has strictly weaker post-conditions than the testnet one. Recommend `require(keccak256(vaultDeployer.creationCode()) == keccak256(type(VaultCore).creationCode))` in `Deploy.s.sol`, plus a `code.length` check in the factory constructor. |

---

## 6. Methodology and limitations

**Passes run.** Nine specialist reviews — access control; reentrancy and external-call safety;
arithmetic; oracle and price manipulation; governance and MEV; accounting and fund-flow invariants;
denial of service and griefing; external integrations and deployment; standards and known CVE
classes — each walking every in-scope function rather than sampling, with deliberate overlap. Every
candidate was then subjected to a separate adversarial pass whose objective was to **refute** it;
candidates without a concrete, reproducible path were downgraded or dropped, and notable refutations
are recorded so they are not re-reported.

**Verified, not trusted.** NatSpec, walkthroughs, prior internal reviews and `SLITHER-TRIAGE.md`
were treated as *claims to be checked*. Many proved inaccurate: H-2 (guard NatSpec), H-1 (median
comment, plus a walkthrough disposition whose directional reasoning is inverted against the code),
H-4 (threat model), C-2 (EE-10 and MO-1), C-5 (EE-10 again), M-2 (PX-1), M-11 (MO-2), I-4 (four
sites on the concentration cap), and four `SLITHER-TRIAGE.md` rows (§4.5). `TickMath`'s twenty
constants were re-derived by independent 200-digit computation and `FullMath` fuzzed over 200,012
cases rather than recognised by eye.

**Self-correction.** One finding was withdrawn after adversarial verification contradicted it
(**H-2**, *Corrected scope*): an initial claim of single-block TWAP manipulation rested on a harness
that moved a pool's tick without writing an observation, which is unreachable on a real pool. The
claim is recorded as refuted rather than removed, and the surviving finding is narrower. Readers
should weight this as evidence about the process, in both directions.

**What an AI pre-audit cannot attest.**
- **No liability, insurance, or signed attestation**, and no reputational stake. This does not
  satisfy an audit gate.
- **No formal verification** — no symbolic execution, model checking, or machine-checked proof. The
  project's own invariant suites were read but not re-derived. Note that `foundry.toml` sets
  `fail_on_revert = false` and `SystemInvariant.t.sol:82-88` wraps `requestExit` in `try/catch {}`,
  so H-6's reverts are silently discarded by those runs; its handler also holds prices static and
  never gives the child a second holder, which is exactly the intersection where H-5 cannot fire.
- **Economic and game-theoretic modelling is shallow.** Findings quantify direct value transfer;
  they do not model equilibrium behaviour, cross-protocol composability, or MEV supply chains.
- **No novel cryptographic review.** Commit-reveal was assessed against standard failure modes only.
- **No live-chain verification and no fork testing.** Every result comes from source and local
  Foundry execution against mocks. `base-mainnet.json` remains unverified as far as this audit is
  concerned; neither oracle source has ever executed against a real chain; and the Uniswap/Pyth
  interface shapes are this repository's understanding of them.
- **Completeness is bounded by the lens set.** Nine overlapping lenses reduce, but do not eliminate,
  the chance of a class no lens owned.

**What a human firm should still do.**
1. Re-derive the oracle findings against live Base state, on a fork.
2. Verify every address, pool identity and Pyth price ID in `base-mainnet.json` on-chain — including
   `cast call <pool> 'observations(uint256)(uint32,int56,uint160,bool)' 0` on each pool, which
   nothing in this repository exercises (**M-12**), and confirm `slot0`'s three same-width `uint16`
   fields are in the assumed order.
3. Measure each Chainlink feed's heartbeat and any `minAnswer`/`maxAnswer` bounds, and each Pyth
   feed's typical `conf` — all three feed into H-1's reachability and I-1.
4. Run symbolic execution over `_settleExit` and the `_fullNavWad` recursion.
5. Model the sub-vault and one-block-stake governance economics adversarially (C-1, C-5, H-8).
6. **Independently re-audit the corrected tree in full.** The remediation set touches most of the
   critical surface, and on an immutable protocol a fix is itself a new immutable deployment.
