# Audit Handoff Package

> ## ⚠ READ FIRST — this package predates the Phase-2 remediation (current tree: `protocol/main` @ `fea091ab`, 2026-08-28)
>
> An AI pre-audit on **2026-08-25** found **41 issues: 5 Critical, 9 High, 15 Medium, 7 Low**
> ([audit/AI-AUDIT-REPORT.md](audit/AI-AUDIT-REPORT.md), issues #31–#35). Two remediation phases
> followed. **The authoritative current status is [AI-AUDIT-REPORT.md](audit/AI-AUDIT-REPORT.md)
> §1 "Phase-2 remediation disposition" and [LAUNCH-READINESS.md](LAUNCH-READINESS.md)** — not the
> scope/residuals tables below, which are pre-remediation.
>
> **`v0.3.0-audit` is WITHDRAWN** (contains all five Criticals). Tag the corrected tree
> (`v0.4.0-audit` recommended) at the current `protocol/main` and commission a **full review, not
> a delta**.
>
> **Phase-2 outcome (for a root-only launch):**
> - **C-1** (empty-electorate sub-vault capture): FIXED at launch — `VaultFactory.allowSubVaults = false`
>   ("root vaults only"); no internal fix exists, so sub-vaults are disabled and the sub-vault-only
>   Highs **H-5/H-6/H-7/H-9** are DORMANT (deferred with the feature).
> - **C-2, C-3, C-5**: FIXED. **H-1..H-4**: FIXED. **H-8**: partially fixed + config-mitigated.
> - **C-4 → new Critical C-6.** A Phase-2 *re-verification* replaced the inferred C-4 closure with an
>   executed end-to-end test and found **C-6**: the bespoke `OracleAggregator`'s quorum is a
>   fault-tolerance floor, silent on the Byzantine floor (`quorum ≥ 2a+1`) — two adversarial sources
>   seize an asset's price, re-opening C-4's 88.9% theft. **Resolution = the ORACLE CHANGED.** The
>   launch oracle is now **Chainlink-direct**: `contracts/src/oracle/ChainlinkOracle.sol` (one genuine
>   Chainlink Data Feed per asset, no median/quorum), curated via a `VaultFactory` **oracle allowlist**
>   so the vulnerable custom aggregator is non-selectable. An independent adversarial review accepted
>   it (8.1/10, no Critical/High). **This is the single most important delta for the audit.**
> - Remaining Mediums/Lows: dispositioned (accepted design-tradeoffs / off-chain / dormant) in the
>   report's §1 table.
>
> **Launch is NO-GO on two external gates:** (1) the mainnet deploy config must supply
> **real, on-chain-verified Base Chainlink feed addresses** (the `chainlinkOracle` block in
> `base-mainnet.json` is placeholders; `scripts/verify-chainlink-oracle.mjs` gates it; `Deploy.s.sol`
> refuses a Base-mainnet deploy with an empty oracle allowlist); (2) **this external audit**.
>
> Treat every specific line number, size (VaultCore's EIP-170 margin is **3,926 B** measured
> 2026-09-02; the 283 B and 1,182 B figures that circulated in earlier notes are history, not
> this document — re-measure, never copy),
> test count and "Accepted" disposition below as pre-remediation — verify against the current tree.


Everything an external auditor needs to scope the engagement. Current as of the **Sprint-10
audit freeze**. The protocol is immutable (no proxies, no admin upgrade path), so whatever ships
is the audit surface permanently — there is no "we'll patch it later."

## Audit this tag: `v0.3.0-audit`

> `v0.3.0-audit` is cut at the `protocol/main` commit that merged this document update, and
> supersedes **`v0.2.0-audit`** (`5081f9b9`) as the engagement reference. The delta between the
> two tags' contract surface is exactly four **additive** files under `contracts/src/oracle/` —
> Sprint 11's mechanism-diverse price sources and their vendored math (see the Scope table).
> Every file present in `v0.2.0-audit` is byte-identical in `v0.3.0-audit`. Verify, don't trust:
>
> ```
> git diff v0.2.0-audit v0.3.0-audit --name-status -- contracts/src
> ```
>
> must show only `A` lines. The older tag remains valid as the Sprint-10 freeze reference; it is
> simply not the full audit surface any more, because a firm scoped to it would review an oracle
> aggregator while excluding two of its three source mechanism classes.

**Read [CHANGES-SINCE-REVIEWS.md](CHANGES-SINCE-REVIEWS.md) first**, then this file. It is one
page stating what changed since the internal reviews, which rounds covered what, and — more
usefully — what internal review did **not** cover.

**There is deployed bytecode on Base Sepolia, but do NOT compare this tree against the address book
— they are different code.** Read this paragraph carefully; it has been wrong in both directions.

The committed address book at `contracts/config/deployments/base-sepolia.json` records
`sourceCommit 5934ef22`, deploy block 46,111,530, and it names a still earlier deployment at block
45,784,186. **Neither is this tree.** `contracts/src` has moved substantially since `5934ef22` —
`VaultCore`, `VaultFactory` and `ChainlinkOracle` among the files — and the address book's own
`execution.note` records that the adapter it names predates both the reentrancy mutex (#101) and
the scoped-refund fix, and carries a cross-order theft path.

The codesize equality this paragraph used to assert is therefore false, and its figures were stale
in the ordinary way as well: it cited VaultFactory 2,718 B and Governance 11,990 B, which measure
**3,572 B** and **12,155 B** at `protocol/main` (`forge build --sizes`, 2026-09-02).

**There is presently no committed record an auditor can diff this tree against.** The address book
is the only one, and it describes an earlier deployment. Do not substitute it.

**No mainnet deployment exists.** The audit surface is the source at the tag above. Treat every
testnet instance as evidence about the bytecode it actually ran, and check which commit that was
before relying on it.

> **Reviewers start at [audit/README.md](audit/README.md)** — the full audit package: reading
> order, system map, trust boundaries, wiring order, per-contract walkthroughs
> ([audit/walkthroughs/](audit/walkthroughs/)), the threat-model→test cross-reference
> ([audit/TEST-CROSS-REFERENCE.md](audit/TEST-CROSS-REFERENCE.md)), and the findings-response
> process ([audit/FINDINGS-TEMPLATE.md](audit/FINDINGS-TEMPLATE.md)). This file is the
> engagement-scoping summary.

## Scope

| Contract | LoC-ish | Role | Risk |
| --- | --- | --- | --- |
| `VaultCore.sol` | ~750 | shares/NAV, deposits, two-mode exits, in-kind redemption, rebalance exec, sub-vault flows | **Critical** — holds all funds |
| `Governance.sol` | ~450 | commit-reveal, quorum regimes, delegation, timelock, execute | **Critical** — authorizes fund movement |
| `FeeEngine.sol` | ~110 | 10% perf fee, HWM netting, operator claims | High |
| `OperatorRegistry.sol` | ~150 | identity, cross-vault carry, leaderboard | High |
| `OracleAggregator.sol` | ~140 | median + staleness breaker | **Critical** — prices everything |
| `oracle/UniswapV3TwapSource.sol` | ~370 | spot-TWAP `IPriceSource` (SF-1 mechanism class 2); one- or two-hop, USDC pinned to $1 | **Critical** — feeds the aggregator. Added POST-FREEZE (Sprint 11, PR #25): one internal adversarial review round, no prior external eyes — the least-scrutinized contracts here |
| `oracle/PythSource.sol` | ~150 | pull-oracle `IPriceSource` (class 3); expo→WAD, confidence gate | **Critical** — same provenance and caveat as above |
| `oracle/vendor/` (TickMath, FullMath) | ~170 | vendored Uniswap math under original licenses (GPL-2.0-or-later / MIT) | High — vendored; license mix vs BUSL is flagged for counsel, not for the technical audit |
| `AggregationRouterAdapter.sol` | ~80 | DEX-aggregation execution | High — external calls |
| `SubVaultRegistry.sol` | ~100 | edges, depth, fee-stack caps | Medium |
| `VaultFactory.sol` | ~120 | permissionless deploy + attestation | Medium |
| `VaultDeployer.sol` | ~60 | holds VaultCore's creation code (EIP-170 forced, #10); no authority | Medium |
| `lib/` (SafeTransferLib, Checkpoints, BoundedCall) | ~150 | primitives | Medium |

Out of scope for the contract audit (separate review): `packages/indexer`, `apps/api`
(x402 metering), `apps/web`. These never custody funds; the API server holds no keys.

## Deployment shape changed after this package was assembled

Stated plainly because it post-dates the rest of this document. At v0.1.0-rc1 the protocol was
**undeployable**: `VaultFactory` compiled to 27,241 B against EIP-170's 24,576 B cap, because
`new VaultCore(...)` embeds VaultCore's entire creation code
([#10](https://github.com/SlumperSan/agent-governed-vaults/issues/10)). `forge test` was green
throughout — Foundry's test EVM does not enforce EIP-170 — so only `forge build --sizes` caught it.

The governing constraint, and the reason the obvious fixes do not work: **VaultCore's creation
code (24,731 B) is larger than the runtime cap itself.** Any contract holding
`new VaultCore(...)` is therefore over the cap before its own logic; a minimal helper doing
nothing else measured 25,100 B, and the entire `optimizer_runs` ladder from 800 down to 50 buys
only 229 B.

**Sprint 7 fix:** a new `VaultDeployer` carries the creation code in its own *creation* code
(where EIP-3860's 49,152 B cap applies) and writes it into two immutable, non-executable data
contracts at construction. `VaultFactory` pins that deployer immutably and calls it with
ABI-encoded constructor arguments only. Net effect on the audit surface:

- **`VaultCore.sol` is byte-identical** — not one line changed, its walkthrough stands as written.
- **`VaultFactory.sol`** changed in exactly two places: a fifth constructor parameter, and
  `_deploy` calling the deployer instead of `new VaultCore(...)`. All attestation, edge
  registration and basket-subset logic is untouched.
- **One new contract to review**, `VaultDeployer.sol`
  ([walkthrough](audit/walkthroughs/VaultDeployer.md)), which holds no authority of any kind.
- **The trust anchor is unchanged.** `OperatorRegistry.attestVault` is still factory-only, so
  calling the deployer directly yields an unattested vault — the same position anyone was in
  before, deploying VaultCore themselves. New threat-model row **PX-4** covers the added link.
- **No proxy, no delegatecall, no upgrade path** was introduced. The "immutable, no proxies"
  claim at the top of this file holds verbatim.

The optimizer settings were deliberately **not** changed: the 229 B available would have cost
global runtime gas on every contract and, once the deployer exists, buys nothing — VaultCore's
1,560 B of headroom is no longer on the deployability path.

## Design intent (read first)

- [ARCHITECTURE.md](ARCHITECTURE.md) — module boundaries, NAV/share math, the C-1..C-5
  commitments, and the resolved contradictions K-1..K-4.
- [THREAT-MODEL.md](THREAT-MODEL.md) — 45 mechanic→vector→mitigation rows plus the Sprint 6
  finding dispositions. **The "Accepted" rows are deliberate tradeoffs, not oversights** — please
  challenge them, but know they were chosen (esp. K-4: the oracle breaker freezes exits by
  design; there is intentionally no escape hatch).

## What has already been reviewed (four internal rounds)

> **`VaultDeployer.sol` post-dated every one of these rounds. Sprint 10 closed that gap.**
> It is the newest code in the package (Sprint 7, forced by EIP-170 — #10) and the only contract
> here containing hand-written assembly: an 11-byte SSTORE2 header emitted in the constructor,
> and a memory-assembly `CREATE` in `deploy`. Both were walked opcode by opcode in
> [SPRINT10-DEPLOYMENT-REVIEW](reviews/SPRINT10-DEPLOYMENT-REVIEW.md) §3.5 — **no High or Medium
> finding**. It remains the file with the least *accumulated* scrutiny (one internal pass, versus
> three for `VaultCore`), so it is still where uneven review budget should go first.

- [reviews/SPRINT1-SECURITY-REVIEW.md](reviews/SPRINT1-SECURITY-REVIEW.md) — VaultCore. 4 findings
  (H-1 module-liveness lockup, H-2 returndata-bomb, M-1 creator-gate strand, M-2 in-kind fee
  dodge), **all fixed**, regression suite `test/ModuleHardening.t.sol`.
- [reviews/SPRINT6-EXECUTION-REVIEW.md](reviews/SPRINT6-EXECUTION-REVIEW.md) — oracle/execution/
  sub-vaults. 8 findings (2H/5M/1L), **all fixed or documented**, `test/Sprint6Fixes.t.sol`.
- [reviews/SPRINT6-GOVERNANCE-REVIEW.md](reviews/SPRINT6-GOVERNANCE-REVIEW.md) — governance/
  economics. 5 findings (1H concentration-cap DoA, 2M, 2 documented), **fixed/documented**.

A third pass ([reviews/SPRINT6-GOVERNANCE-ACCEPTED-ROWS.md](reviews/SPRINT6-GOVERNANCE-ACCEPTED-ROWS.md))
challenged the deliberately-Accepted governance rows: K-3/VO-2/VO-3 and snapshot soundness hold
as designed; it found GA-1 (parent-vault-as-non-voting-member froze child RuleChange — **fixed**)
and confirmed VO-7's mid-reveal tally visibility is benign under commit-binding.

- [reviews/SPRINT10-DEPLOYMENT-REVIEW.md](reviews/SPRINT10-DEPLOYMENT-REVIEW.md) — the EIP-170
  deployment split (`VaultDeployer.sol`, `VaultFactory._deploy`, the deploy scripts). **No High or
  Medium finding**; 4 informational/low, one of which (F-3) found that `src/lib/` had been
  excluded from every Slither run the project had done.

The threat model's "Sprint 6 adversarial pass" table maps every finding to its disposition.

## Invariants proven (Foundry)

128 tests, incl. these invariant suites (256 runs × 16k calls each):
- `Σ member shares == totalShares` across every path (VaultCore + system-level with children)
- **NAVps non-decreasing for remaining members across any redemption** (§4.6) — proven with and
  without sub-vaults present
- vault solvency: real USDC ≥ internal idle + escrowed pending, under adversarial donation
- queued (Mode-F) share consistency; voting-eligible = supply − locked
- pending escrow excluded from NAV; child fully backs parent

## Known residuals (accepted / documented, NOT fixed — please pressure-test)

| ID | What | Why accepted |
| --- | --- | --- |
| K-4/SF-2 | Stale-oracle breaker freezes exits; an attacker inducing staleness traps capital | Any exit hatch during staleness IS the stale-price exit the breaker prevents. Mitigation = source count/independence + 1-day staleness ceiling |
| K-2 | One permanently-offline member freezes rule changes forever | Near-immutability is the intent |
| E7/EE-5 | Latency-arb on repeat deposits against stale NAV; threshold is gas within the oracle drift band | Bounded by the 1-day staleness ceiling + non-zero exit fee; full closure needs oracle-enforced mint-time freshness (design option) |
| G3/CM-5 | Single-vault carry farming to shelter perf fees | Gated by the 1% exit-fee cap forcing ~100:1 capital fronting + leaderboard reputation drag; economic deterrent, not a code fix |
| PX-1 | USDC blacklist on a vault address freezes the USDC leg | Inherent to the USDC settlement choice; in-kind escrow keeps non-USDC assets exitable |
| E4 (S6) | A parent member exit whose cash need exceeds idle reverts `ExitNeedsChildSettlement` when the only covering child is mid-rebalance | Clean rollback + bounded retry (child timelock). Window narrowed vs. the original deep-stack revert, not eliminated |
| E5 (S6) | A child that persistently escrows an in-kind slice back to the parent (e.g. blacklisted parent) turns the parent exit into a permanent revert, rather than escrow-and-continue as direct holdings do | Silent underpayment is fixed; the EE-6 asymmetry for child-held slices is a known residual — a deferred-claim mechanism would close it |

## Scope notes — specified but NOT in the audited surface

To prevent doc/code confusion during review, these are described in ARCHITECTURE.md but are
**not implemented in v1** and carry no contract code:

- **Swing pricing (§4.7).** v1 ships in-kind-only redemption, which imposes no dilution on
  remaining members, so swing pricing is unnecessary (the §4.6 NAVps-non-decreasing invariant
  holds without it — see the invariant suites). Swing is specified for the future optional
  cash-redemption path (via the execution adapter). EE-11 is therefore N/A in v1.
- **ERC-4626 compliance.** Deliberately not claimed (commitment C-1) — in-kind redemption,
  forward pricing, and the (future) swing pricing each break `previewRedeem` round-trips. Only
  4626-shaped read views exist, and they are indicative, not compliant.

## Suggested audit focus (highest leverage)

1. The two-mode exit accounting in `_settleExit` — the forward-pricing seam (VO-8 × K-1) and the
   SV-5 shortfall unwind with children present. Rounding direction and the §4.6 invariant.
2. `Governance.execute` payload decoding across the three proposal types (type-confusion) and the
   commit-reveal quorum math at the <5-member regime boundary.
3. The recursive look-through `_fullNavWad` (S6 E1 fix) — depth bounding, and whether a
   descendant vault can misprice an ancestor's NAV.
4. The post-freeze oracle sources (`UniswapV3TwapSource`, `PythSource`) — these have had the
   least internal scrutiny of anything in scope. Specifically: the Q64.192/Q64.128 branch
   crossover and $1e-6 output quantization in the TWAP math (quantization is a filed,
   documented listing constraint below ~$0.01/token, not a defect for majors), tick-sign
   handling across token orderings, two-hop composition through a shared intermediate pool,
   and the Pyth expo/confidence gates. An internal re-derivation at 200-digit precision
   reproduced all committed fixtures (PR #25 review), but no external eyes have touched them.
4. `OracleAggregator` median robustness and the `BoundedCall` returndata handling.
5. `AggregationRouterAdapter` against the 2026 arbitrary-calldata exploit class (the reason the
   selector allowlist + measured-delta minOut exist).

## Build & test

```bash
cd contracts && forge build && forge test -vvv     # 128 tests
forge snapshot --check --nmt "testFuzz"            # gas regression gate (fuzz gas is corpus-dependent, so not gated)
forge build --sizes                                # EIP-170 gate
slither . --filter-paths "^lib/|^test/|^script/"   # static analysis (triaged: reviews/SLITHER-TRIAGE.md)
```

The first three are **blocking** CI gates. `slither` is **advisory** — its CI step is
`continue-on-error: true`, so a new high-severity static-analysis finding does **not** turn CI
red; [SLITHER-TRIAGE.md](reviews/SLITHER-TRIAGE.md) is the record of what was dispositioned and
why. The filter pattern is anchored as of Sprint 10: the previous unanchored `"lib|test|script"`
also matched `src/lib/`, which excluded `SafeTransferLib`, `BoundedCall` and `Checkpoints` from
every Slither run the project had done
([SPRINT10-DEPLOYMENT-REVIEW §F-3](reviews/SPRINT10-DEPLOYMENT-REVIEW.md)).
