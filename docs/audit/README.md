# External Audit Package: Reviewer Entry Point

> ## ⚠ SCOPE HAS MOVED SINCE THIS PACKAGE WAS WRITTEN — read before you scope anything
>
> This package was assembled at the **Sprint-10 audit freeze**, before Critical **C-6**. It is kept
> as the reviewer-facing evidence record and is deliberately **not** rewritten to match the current
> tree. Two things it says are no longer true of what ships:
>
> 1. **The oracle was REPLACED, not patched.** The launch oracle is
>    `contracts/src/oracle/ChainlinkOracle.sol` — **one genuine Chainlink Data Feed per asset**, no
>    median, no quorum, no per-vault source set — curated by a `VaultFactory` oracle allowlist.
>    C-6 showed the bespoke median could not be secured by curation. **This is the single most
>    important delta for any reviewer.**
> 2. **`OracleAggregator`, `PythSource`, `UniswapV3TwapSource` and the vendored
>    `FullMath`/`TickMath` are no longer in `contracts/src/`.** They live under
>    **`contracts/test/retired/`**, kept solely as the C-4/C-6 exploit evidence. They are not
>    deployable and are non-selectable through the factory allowlist. Their walkthroughs below
>    describe retired code.
>
> For current scope start at [../AUDIT-HANDOFF.md](../AUDIT-HANDOFF.md) and
> [../LAUNCH-READINESS.md](../LAUNCH-READINESS.md); the finding itself is
> [AI-AUDIT-REPORT.md](AI-AUDIT-REPORT.md) C-6.

You are auditing an **immutable** protocol: no proxies, no upgrade path, no admin able to
re-point anything after deployment. What ships is final; the audit surface is the deployed
bytecode. This document gets a reviewer with zero context productive within an hour.

## 0. One-paragraph system summary

Permissionless vaults in which members pool USDC into spot crypto index baskets and ratify
every rebalance by on-chain commit-reveal vote. Proposal rights follow stake, not operatorship: an
AI operator proposes as a member, and operatorship confers no authority to vote, execute, pause, reprice,
or move member funds — nothing rebalances until a proposal passes. Members enter through a 4-hour observation
window, exit in-kind (pro-rata slices of every basket asset) under a two-mode settlement rule
that closes the exit-before-rebalance free option, and pay a 10% performance fee on realized
profit netted against a cross-vault per-(member, operator) loss carryforward. Pricing is
**one genuine Chainlink Data Feed per asset** (`ChainlinkOracle`, guarded by an L2 sequencer uptime
gate, a per-feed heartbeat and a sane-price band) that fails **closed** — deliberately freezing
everything, including exits, when it cannot produce a trustworthy price. *(This sentence originally
read "a multi-source median oracle with a staleness circuit breaker"; see the banner — that design
is retired.)* The protocol *supports* child vaults (depth ≤ 3) with
recursive look-through NAV, but **sub-vaults are DISABLED at launch** (`VaultFactory` deployed with
`allowSubVaults = false`) as the Critical **C-1** remediation ("root vaults only") — the sub-vault
code is present and in scope, but no deployed vault can create or fund a child, so review it as
dormant-at-launch. The off-chain layer (x402-metered API, indexer, web) never custodies funds and
is out of scope.

## 1. Reading order (estimated ~1 hour to productive)

| # | Read | Why | Time |
| --- | --- | --- | --- |
| 1 | This file, top to bottom | System map, trust boundaries, wiring | 15 min |
| 2 | [../ARCHITECTURE.md](../ARCHITECTURE.md) | Design intent: NAV/share math (§4), two-mode exits (§4.4), fees (§4.6, §7), governance (§8), sub-vaults (§10), C-1..C-5 commitments, K-1..K-4 accepted contradictions | 20 min |
| 3 | [../THREAT-MODEL.md](../THREAT-MODEL.md) | 44 mechanic→vector→mitigation rows + Sprint 6 finding dispositions. **"Accepted" rows are deliberate tradeoffs, not oversights** | 15 min |
| 4 | [walkthroughs/VaultCore.md](walkthroughs/VaultCore.md) | The critical contract, then the others as you reach them | 10 min |
| 5 | Prior reviews in [../reviews/](../reviews/) | What three internal adversarial passes already found and how each finding was dispositioned | as needed |

Per-contract walkthroughs (state, entry points, invariants, trickiest paths, accepted risks):

- [walkthroughs/VaultCore.md](walkthroughs/VaultCore.md) — **critical**, holds all funds
- [walkthroughs/Governance.md](walkthroughs/Governance.md) — **critical**, authorizes fund movement
- [walkthroughs/OracleAggregator.md](walkthroughs/OracleAggregator.md) **RETIRED (C-6)**, now
  `contracts/test/retired/OracleAggregator.sol`, out of production scope. Pricing is done by
  `contracts/src/oracle/ChainlinkOracle.sol` (single Chainlink feed per asset, enforced by
  VaultFactory's blessed-oracle allowlist); it has no walkthrough yet. Read the source
- [walkthroughs/FeeEngine.md](walkthroughs/FeeEngine.md)
- [walkthroughs/OperatorRegistry.md](walkthroughs/OperatorRegistry.md)
- [walkthroughs/AggregationRouterAdapter.md](walkthroughs/AggregationRouterAdapter.md)
- [walkthroughs/DirectPoolAdapter.md](walkthroughs/DirectPoolAdapter.md)
- [walkthroughs/SubVaultRegistry.md](walkthroughs/SubVaultRegistry.md)
- [walkthroughs/VaultFactory.md](walkthroughs/VaultFactory.md)
- [walkthroughs/VaultDeployer.md](walkthroughs/VaultDeployer.md) — **new in Sprint 7**;
  adversarially reviewed in Sprint 10 (see §6)

**RETIRED: do not scope these unless you are reviewing the C-4/C-6 evidence.** Added in Sprint 11
as additive `IPriceSource` implementations, outside the `v0.2.0-audit` freeze and with **zero**
internal review passes (see [../CHANGES-SINCE-REVIEWS.md](../CHANGES-SINCE-REVIEWS.md) §5). They now
live under `contracts/test/retired/` and no deployed vault can use them:

- [walkthroughs/UniswapV3TwapSource.md](walkthroughs/UniswapV3TwapSource.md) — spot-market TWAP
  source, plus two vendored Uniswap math libraries under their own licenses.
  **RETIRED (C-6)**, now `contracts/test/retired/UniswapV3TwapSource.sol` + `retired/vendor/`
- [walkthroughs/PythSource.md](walkthroughs/PythSource.md) — pull-oracle source.
  **RETIRED (C-6)**, now `contracts/test/retired/PythSource.sol`

Cross-references:

- [TEST-CROSS-REFERENCE.md](TEST-CROSS-REFERENCE.md) — every threat-model mechanic → the test(s) covering it
- [FINDINGS-TEMPLATE.md](FINDINGS-TEMPLATE.md) — how we will respond to your findings
- [../reviews/SLITHER-TRIAGE.md](../reviews/SLITHER-TRIAGE.md) — every static-analysis detector dispositioned

## 2. System map

```
                       ┌────────────────────────────────────────────────┐
                       │                 VaultFactory                   │  permissionless deploy;
                       │  createVault / createChildVault → attest       │  the ONLY attestation path
                       │            │ CREATEs via (immutable pin)       │
                       │            ▼                                   │
                       │      VaultDeployer — holds VaultCore's         │  no authority of its
                       │      creation code (EIP-170, #10)              │  own (PX-4)
                       └───────┬───────────────────┬────────────────────┘
                     attests   │                   │ registers child edge
                               ▼                   ▼
                    ┌──────────────────┐   ┌──────────────────┐
                    │ OperatorRegistry │   │ SubVaultRegistry │
                    │ identity, carry, │   │ parent/child     │
                    │ leaderboard      │   │ edges, depth ≤ 3 │
                    └────────▲─────────┘   └───────▲──────────┘
          carry reads /      │                     │ parentOf (quorum floor,
          realization writes │                     │ voting exclusion, edges)
                             │                     │
┌───────────────┐  executes  ┌▼─────────────────┐  │        ┌──────────────────┐
│  Governance   │───────────►│    VaultCore     │──┘ prices │ OracleAggregator │
│ commit-reveal │ rebalance/ │  shares / NAV /  │◄──────────│ ≥3-source median │
│ quorum/deleg. │ child-alloc│  deposits/exits  │ + breaker │ + staleness trip │
│ timelock      │◄───────────│  sub-vault flows │           └──────────────────┘
└───────────────┘ Mode-F     └─┬──────────┬─────┘
    hasPendingExecution        │          │ onRealize / onFeeCollected*
                     swaps via │          ▼
                    ┌──────────▼─────┐  ┌───────────┐
                    │IExecutionAdapter│ │ FeeEngine │  10% perf fee, HWM netting,
                    │ 2 impls: agg-   │ │           │  per-token operator claims
                    │ router + V2 pool│ └───────────┘
                    └────────────────┘
```

### Contract roles and risk weights

| Contract | LoC | Role | Risk |
| --- | --- | --- | --- |
| `VaultCore.sol` | ~850 | Shares/NAV, deposits + observation window, two-mode exits, in-kind redemption + escrow, rebalance execution, sub-vault allocate/redeem/look-through, creator gate, exit fee, capacity cap, voting-stake checkpoints | **Critical**: holds all funds |
| `Governance.sol` | ~490 | Proposals (3 types), commit-reveal, 3 quorum regimes, standing defaults, delegation + concentration cap, timelock, execute | **Critical**: authorizes every fund movement |
| `OracleAggregator.sol` | ~140 | ≥3-source lower-median price with per-source staleness + quorum breaker. **RETIRED (C-6)**: moved to `contracts/test/retired/`, not production source. Assets are priced by `src/oracle/ChainlinkOracle.sol` | Out of production scope: was **Critical** |
| `FeeEngine.sol` | ~130 | 10% perf fee netted against registry carry; operator fee claims per token | High |
| `OperatorRegistry.sol` | ~150 | Operator identity, (member, operator) loss carryforward, monotone leaderboard stats | High |
| `AggregationRouterAdapter.sol` | ~76 | Off-chain-routed DEX-aggregation execution (pinned router + selector allowlist) | High — external calls |
| `DirectPoolAdapter.sol` | ~94 | On-chain V2-pool execution (second adapter proving venue abstraction) | High — external calls |
| `SubVaultRegistry.sol` | ~95 | Parent/child edges, depth cap 3, exit-fee stack cap, fee-stack display views | Medium |
| `VaultFactory.sol` | ~120 | Permissionless deploy + attestation; child-basket-subset enforcement | Medium |
| `VaultDeployer.sol` | ~60 | Holds VaultCore's creation code (EIP-170 forced, #10). Zero authority; ~25 lines of assembly | Medium |
| `lib/BoundedCall.sol` | ~46 | Gas- and returndata-bounded module calls (H-1 fix) | Medium |
| `lib/Checkpoints.sol` | ~46 | Timestamp-keyed stake history (VO-9 snapshots) | Medium |
| `lib/SafeTransferLib.sol` | ~58 | Safe transfers + assembly non-reverting `tryTransfer` (H-2 fix) | Medium |

Out of scope: `packages/indexer`, `apps/api` (x402 metering), `apps/web`. These never custody
funds; the API server holds no keys; the contracts have zero x402 coupling (ARCHITECTURE §9).

Also out of the production set: **`contracts/test/retired/`** — the C-6-retired bespoke oracle stack
(`OracleAggregator.sol`, `PythSource.sol`, `UniswapV3TwapSource.sol`, `vendor/{TickMath,FullMath}.sol`).
These still compile and are still driven by the audit tests that demonstrate C-3/C-4/C-6, so the
exploit evidence keeps building, but they are not deployable protocol code and no production
contract imports them. The production oracle is `contracts/src/oracle/ChainlinkOracle.sol`.

## 3. Trust boundaries

The protocol has **four distinct trust tiers**. Getting these straight matters because several
defenses only make sense against the right adversary:

1. **Protocol singletons (trusted-by-all, immutable):** `OperatorRegistry`, `FeeEngine`,
   `Governance`, `SubVaultRegistry`, `VaultFactory`, and since Sprint 7, `VaultDeployer`,
   which holds VaultCore's creation code because EIP-170 leaves it nowhere else to live (#10).
   The deployer is a singleton by position only: it carries **no authority whatsoever** and is
   trusted by nobody for anything (see
   [walkthroughs/VaultDeployer.md](walkthroughs/VaultDeployer.md)). One canonical set, deployed and one-shot
   wired together (§5 below). No admin functions exist after wiring. Vaults deployed by the
   canonical factory reference these; the factory is what makes carry marks and leaderboard
   rows trustworthy (CM-5). Nothing stops someone deploying a *look-alike* stack, but it
   won't be attested in the canonical registry.
2. **Per-vault creator choices (trusted by that vault's members only):** the
   `OracleAggregator` instance, the adapter allowlist, the basket, fee/capacity/window
   parameters. All immutable at vault creation and visible on-chain before anyone deposits —
   "read the config before you deposit" is the security model, so constructor validation
   (oracle source floor, staleness ceiling, exit-fee cap, basket cap) is load-bearing: it
   bounds what a malicious creator can configure a honeypot with.
3. **Modules as adversaries on the exit path:** even the *canonical* governance/feeEngine/
   registry are treated as potentially faulty where member liveness is at stake. Every module
   call on the exit path is gas-bounded (300k), returndata-bounded (1 word), and non-blocking
   (H-1 fix): a failing module forfeits its own bookkeeping but never a member's exit. Value is
   separately bounded by the 10%-of-gain fee clamp.
4. **Members, tokens, and children as adversaries:** every member is assumed potentially
   malicious (snapshots, commit binding, reentrancy locks); basket tokens may misbehave
   (assembly `tryTransfer` degrades to escrow, EE-6); child vaults are priced through the
   parent's own oracle and internal accounting, never trusted self-reports (SV-7).

Key boundary facts a reviewer should hold onto:

- **Shares are non-transferable.** There is no `transfer`/`transferFrom` on VaultCore. Several
  defenses (tenure clock, snapshot completeness, concentration-cap non-splittability) lean on
  this.
- **NAV never reads `balanceOf`.** All accounting is internal (`idleUsdc`, `assetBalance`);
  donations cannot move NAV (EE-1). The only `balanceOf` reads are measured *deltas* around
  external interactions (deposit receipt, swap output, child redemption proceeds).
- **`block.timestamp` is the only clock** (C-2). No block-number arithmetic anywhere.
- **Governance is the only caller** of `executeRebalance`, `allocateToChild`,
  `redeemFromChild`. Everything else is permissionless or member-initiated.
- **A parent vault is a non-voting member of its child.** It holds child shares but is excluded
  from the child's voting-eligible stake and holder counts (`parentVault()` exclusion, GA-1
  fix) — otherwise child full-consensus RuleChange would be structurally unreachable.

## 4. Immutability posture (read before proposing "add an admin fix")

- **No proxies, no upgradeable contracts, no pause guardians.** Protocol iteration = deploy a
  new version through a new factory; migration is voluntary per vault.
- The **only** mutable on-chain surface is per-vault `GovConfig`, changeable exclusively by a
  full-consensus RuleChange + timelock (CM-8/K-2 — one permanently offline member freezes a
  vault's config forever, and that is the intent).
- The `wire()` calls on OperatorRegistry / SubVaultRegistry / Governance are **one-shot
  deploy-time wiring**, not admin powers: callable only by the deployer, only once, revert
  `AlreadyWired` thereafter (proven by `test_deployWiresAndLocks`).
- Consequence for findings: "add an owner who can rescue X" is not an accepted remediation
  shape. Fixes must be constructor validation, code-path changes, or documented acceptance.

## 5. Deploy & wiring order (the only valid sequence)

From `script/Deploy.s.sol` (proven by `test/Deploy.t.sol`):

```
1. OperatorRegistry()                      — no deps
2. SubVaultRegistry()                      — no deps
3. FeeEngine(registry)                     — immutable registry ref
4. Governance()                            — no ctor deps
5. VaultDeployer()                         — no deps; MUST precede the factory (#10)
6. VaultFactory(registry, governance, feeEngine, subVaultRegistry, vaultDeployer)
7. registry.wire(factory, feeEngine)       — one-shot, locks attestation + fee recording
8. subVaultRegistry.wire(factory)          — one-shot, locks child registration
9. governance.wireSubVaultRegistry(subReg) — one-shot, locks SV-6 floor inheritance
```

Oracles and adapters are **not** singletons — each creator supplies their own at
`createVault` time (per-vault venue/source choice, C-2/SF-1).

Per-vault bring-up is **two-step**: `factory.createVault(params)` deploys + attests, then the
creator calls `governance.registerVault(vault, cfg)` in a second transaction. Until
registration, no proposals can exist and exits settle Mode I. This gap is documented UX, not
a trust gap (nothing privileged happens in between).

## 6. What has already been reviewed

Four internal adversarial passes, all findings fixed or explicitly dispositioned:

> **`VaultDeployer.sol` post-dated every one of these rounds. Sprint 10 closed that gap.**
> It is the newest code in the package (Sprint 7, forced by EIP-170 — #10) and the only contract
> here containing hand-written assembly: an 11-byte SSTORE2 header emitted in the constructor,
> and a memory-assembly `CREATE` in `deploy`. Both were walked opcode by opcode in
> [SPRINT10-DEPLOYMENT-REVIEW](../reviews/SPRINT10-DEPLOYMENT-REVIEW.md) §3.5 — **no High or Medium
> finding**. It remains the file with the least *accumulated* scrutiny (one internal pass, versus
> three for `VaultCore`), so it is still where uneven review budget should go first.

| Review | Scope | Outcome |
| --- | --- | --- |
| [SPRINT1-SECURITY-REVIEW](../reviews/SPRINT1-SECURITY-REVIEW.md) | VaultCore | 4 findings (H-1 module-liveness, H-2 returndata-bomb, M-1 gate-strand, M-2 in-kind fee dodge) — **all fixed**, regression `test/ModuleHardening.t.sol` |
| [SPRINT6-EXECUTION-REVIEW](../reviews/SPRINT6-EXECUTION-REVIEW.md) | Oracle / execution / sub-vaults | 8 findings (2H/5M/1L) — fixed or documented, regression `test/Sprint6Fixes.t.sol` |
| [SPRINT6-GOVERNANCE-REVIEW](../reviews/SPRINT6-GOVERNANCE-REVIEW.md) | Governance / economics | 5 findings (1H/2M/2 documented) — fixed/documented |
| [SPRINT6-GOVERNANCE-ACCEPTED-ROWS](../reviews/SPRINT6-GOVERNANCE-ACCEPTED-ROWS.md) | The deliberately-Accepted governance rows | K-3/VO-2/VO-3 + snapshots hold; GA-1 (parent froze child RuleChange) **fixed**; VO-7 doc-corrected |
| [SPRINT10-DEPLOYMENT-REVIEW](../reviews/SPRINT10-DEPLOYMENT-REVIEW.md) | The EIP-170 deployment split — `VaultDeployer.sol`, `VaultFactory._deploy`, deploy scripts, and the test/CI edits alongside them | **No High or Medium.** 4 findings: F-1 unvalidated factory immutables (**accepted**, PX-4), F-2 + F-4 doc corrections (**fixed**), F-3 `src/lib/` excluded from every Slither run to date (**fixed**) |

The threat model's "Sprint 6 adversarial pass" table maps every finding ID (E1–E8, G1–G5,
GA-1/GA-2) to its disposition. Each walkthrough's "Accepted risks" section lists what applies
to that contract.

## 7. Known residuals: please pressure-test, but don't re-report as new

| ID | What | Why accepted |
| --- | --- | --- |
| K-4/SF-2 | Stale-oracle breaker freezes exits; induced staleness traps capital | Any exit hatch during staleness IS the stale-price exit the breaker prevents. Mitigations: ≥3 sources, strict-majority quorum, 1-day staleness ceiling. Pending (un-activated) deposits stay cancellable during a freeze |
| K-2 | One permanently-offline member freezes rule changes forever | Near-immutability is the intent |
| E7/EE-5 | Latency-arb on repeat deposits against stale NAV; profitable-drift threshold is gas within the oracle drift band | Bounded by 1-day staleness ceiling + non-zero exit fee; full closure needs oracle-enforced mint-time freshness (design option, not shipped) |
| G3/CM-5 | Single-vault carry farming to shelter perf fees | 1% exit-fee cap forces ~100:1 transient capital fronting; leaderboard reputation drag. Economic deterrent, not a code fix |
| PX-1 | USDC blacklist on a vault address freezes the USDC leg | Inherent to USDC settlement; in-kind escrow keeps non-USDC assets exitable |
| E4 (S6) | Parent exit needing child unwind reverts `ExitNeedsChildSettlement` while the only covering child is mid-rebalance | Clean rollback + bounded retry (child timelock). Window narrowed vs. original deep-stack revert, not eliminated |
| E5 (S6) | A child that persistently escrows an in-kind slice to the parent (e.g. blacklisted parent) makes the parent exit revert rather than escrow-and-continue | Silent underpayment fixed; EE-6 asymmetry for child-held slices is a known residual — a deferred-claim mechanism would close it |
| GA-2/VO-7 | Mid-reveal tally is publicly readable | Commit binds vote direction, so no direction-changing last-mover advantage; encrypted reveals are a v1 non-goal |

## 8. Specified but NOT in the audited surface

- **Swing pricing (ARCHITECTURE §4.7).** v1 is in-kind-only redemption, which imposes no
  dilution on remaining members, so there is nothing to swing; EE-11 is N/A in v1. The spec
  exists for a future optional cash-redemption path. No swing code exists.
- **ERC-4626 compliance.** Deliberately not claimed (C-1). `totalAssets`/`convertToShares`/
  `convertToAssets` are indicative-only views for tooling.

## 9. Suggested audit focus (highest leverage first)

1. `VaultCore._settleExit` — two-mode exit accounting: the forward-pricing seam (VO-8 × K-1),
   the SV-5 shortfall unwind with children present, rounding direction, and the §4.6
   NAVps-non-decreasing invariant.
2. `Governance.execute` payload decoding across the three proposal types (type-confusion), and
   commit-reveal quorum math at the <5-member regime boundary (CM-7).
3. `VaultCore._fullNavWad` recursive look-through — depth bounding, and whether any descendant
   state can misprice an ancestor's NAV (S6 E1 fix).
4. `OracleAggregator` median robustness (lower-median, strict-majority quorum, saturating
   staleness) and `BoundedCall`/`tryTransfer` returndata handling.
5. `AggregationRouterAdapter` vs. the 2026 arbitrary-calldata exploit class (SwapNet/Aperture
   et al.) — the reason the pinned router + selector allowlist + measured-delta minOut exist.

## 10. Build, test, verify

```bash
cd contracts
forge build
forge test                                   # 445 tests (2026-09-03), incl. invariant/fuzz suites
forge snapshot --check --nmt "testFuzz"      # gas regression gate (fuzz gas is corpus-dependent, so not gated)
slither . --filter-paths "lib|test|script"   # triaged: docs/reviews/SLITHER-TRIAGE.md
```

Invariant suites run 256 runs × 16k calls each. Key proven invariants:

- Σ member shares == totalShares across every path (single-vault and with children)
- NAVps non-decreasing for remaining members across any redemption (§4.6), with and without
  sub-vaults
- Vault solvency: real USDC ≥ internal idle + escrowed pending, under adversarial donation
- Queued (Mode-F) share consistency; voting-eligible = supply − locked
- Pending escrow excluded from NAV; child fully backs parent
- Fee/carry ghost-model equivalence; leaderboard stats monotone; fee ≤ 10% of net gain

See [TEST-CROSS-REFERENCE.md](TEST-CROSS-REFERENCE.md) for the full mechanic → test map.

## 11. Findings process

Submit findings in any format; we will respond using
[FINDINGS-TEMPLATE.md](FINDINGS-TEMPLATE.md) — one entry per finding with severity,
disposition, response rationale, and fix commit. Ground rules we commit to:

- Every finding gets a written disposition; "Accepted" always comes with a why.
- Fixes land as isolated commits referenced from the findings log, with regression tests.
- We will not silently fix anything you report — the log is the audit trail.
