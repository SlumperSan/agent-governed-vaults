# Audit Handoff Package

Sprint 9. Everything an external auditor needs to scope the engagement. The protocol is
immutable (no proxies, no admin upgrade path), so the audit surface is the deployed bytecode —
there is no "we'll patch it later."

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
| `AggregationRouterAdapter.sol` | ~80 | DEX-aggregation execution | High — external calls |
| `SubVaultRegistry.sol` | ~100 | edges, depth, fee-stack caps | Medium |
| `VaultFactory.sol` | ~90 | permissionless deploy + attestation | Medium |
| `lib/` (SafeTransferLib, Checkpoints, BoundedCall) | ~150 | primitives | Medium |

Out of scope for the contract audit (separate review): `packages/indexer`, `apps/api`
(x402 metering), `apps/web`. These never custody funds; the API server holds no keys.

## Design intent (read first)

- [ARCHITECTURE.md](ARCHITECTURE.md) — module boundaries, NAV/share math, the C-1..C-5
  commitments, and the resolved contradictions K-1..K-4.
- [THREAT-MODEL.md](THREAT-MODEL.md) — 44 mechanic→vector→mitigation rows plus the Sprint 6
  finding dispositions. **The "Accepted" rows are deliberate tradeoffs, not oversights** — please
  challenge them, but know they were chosen (esp. K-4: the oracle breaker freezes exits by
  design; there is intentionally no escape hatch).

## What has already been reviewed (two internal rounds)

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

The threat model's "Sprint 6 adversarial pass" table maps every finding to its disposition.

## Invariants proven (Foundry)

117 tests, incl. these invariant suites (256 runs × 16k calls each):
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
4. `OracleAggregator` median robustness and the `BoundedCall` returndata handling.
5. `AggregationRouterAdapter` against the 2026 arbitrary-calldata exploit class (the reason the
   selector allowlist + measured-delta minOut exist).

## Build & test

```bash
cd contracts && forge build && forge test -vvv    # 117 tests
forge snapshot --check                              # gas regression gate
slither . --filter-paths "lib|test|script"          # static analysis (triaged: reviews/SLITHER-TRIAGE.md)
```
