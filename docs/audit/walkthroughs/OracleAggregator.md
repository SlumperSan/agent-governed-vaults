# Walkthrough — OracleAggregator.sol

**RETIRED (C-6) — no longer production source.** Moved to `contracts/test/retired/OracleAggregator.sol`;
it is still compiled and still driven by the C-3/C-4/C-6 audit tests, but it is not deployable as
protocol code and is out of the production scope. Assets are priced by
`contracts/src/oracle/ChainlinkOracle.sol`; `Deploy.s.sol` refuses a real-chain deploy unless
VaultFactory is constructed with a non-empty blessed-oracle allowlist, so this contract cannot be
bound to a vault in production.

Read on for the historical design; the risk weight below is the pre-retirement one.

**Risk: Critical (prices everything).** ~140 LoC. Formerly `contracts/src/OracleAggregator.sol`.

## Purpose

Multi-source median price oracle with a staleness circuit breaker (SF-1/SF-2). Per-vault, not
a singleton: each vault creator deploys (or reuses) an aggregator and binds it immutably at
`createVault`. Members inspect the source set before depositing — that inspection is the trust
model, which is why the constructor floors are load-bearing.

Also in this file: `ChainlinkSourceAdapter`, a thin `IPriceSource` wrapper normalizing an
AggregatorV3 feed to WAD (one mechanism class among several; SF-1 requires mechanism-diverse
sources for real independence).

## Config (immutable after construction)

Per asset: `sources[]`, `maxStaleness`, `quorum`. Constructor enforces (all S6 Finding 2/6
fixes):

- `3 ≤ sources.length ≤ 15` (`MIN_SOURCES = 3`, matches ARCHITECTURE §11)
- `quorum > m/2` and `≤ m` — **strict majority** freshness quorum, so no single source can
  freeze or move an asset
- `0 < maxStaleness ≤ 1 days` (`MAX_STALENESS_CEILING`) — kills the unbounded-staleness
  underflow honeypot AND bounds the EE-5 latency-arb drift window
- no duplicate asset entries

No setters exist. A creator wanting different sources deploys a different aggregator.

## `priceWad(asset)` — the whole algorithm

1. Unlisted asset → revert `StaleOracle` (breaker, not zero — an unpriceable asset must fail
   safe, never value at 0).
2. `minUpdated = saturating(block.timestamp − maxStaleness)` — cannot underflow-panic even in
   pathological clock states (S6 Finding 2 defense-in-depth alongside the ceiling).
3. Poll every source under `try/catch`: a reverting source is simply *not fresh* — one broken
   feed must not trip the breaker while quorum holds elsewhere. Accept `p > 0 && updatedAt ≥
   minUpdated`.
4. `k < quorum` → revert `StaleOracle` (the breaker).
5. Insertion-sort the fresh set (m ≤ 15) and return the **lower median** `fresh[(k−1)/2]` —
   no even-k averaging, hence no single-outlier half-deviation swing and no checked-add
   overflow freeze (S6 Finding 6).

## Breaker semantics (K-4 — the deliberate design decision)

When quorum fails, `priceWad` reverts, which reverts **every NAV-reading path in consuming
vaults: deposits, exits, rebalance-adjacent views**. There is intentionally no escape hatch —
any exit during staleness is exactly the stale-price exit the breaker exists to prevent.
Mitigation is source count + independence + the 1-day ceiling, not a hatch. The one deliberate
softening lives in VaultCore: `cancelPending` reads no oracle, so observation-window capital
is never trapped.

## Invariants / properties (fuzz-tested)

- Result is always an element of the fresh set (no synthetic averages) and lies within
  [min, max] of fresh values (`testFuzz_lowerMedianOfFive`, `testFuzz_medianWithinRange`).
- A minority of adversarial sources (< quorum, at any extreme values) cannot move the median
  outside the honest range (`testFuzz_minorityOutliersCannotMoveMedian`).
- Below-quorum freshness always reverts `StaleOracle` (`testFuzz_belowQuorumTripsBreaker`).

## Review focus

1. **Freshness edge cases:** sources reporting `updatedAt` in the future; `p > 0` filtering vs.
   the ChainlinkSourceAdapter's `answer <= 0 → (0, 0)` convention (adapter output is treated
   as not-fresh, by design).
2. **Median parity at even k:** the lower median biases *down* when k is even — check no
   consuming path becomes exploitable from a systematically half-step-low price (direction
   favors under-valuing the basket: mints fewer shares, pays exiters less — conservative for
   remainers, and symmetric for entry/exit).
3. **Source-set quality is out of code's reach:** correlated upstreams (same aggregator API
   behind two adapters) defeat the independence assumption — a listing-criterion problem
   (SF-1), not detectable on-chain. Confirm nothing in the code *claims* otherwise.
4. `ChainlinkSourceAdapter`: decimals ≤ 18 enforced; no `answeredInRound`/round-completeness
   checks — staleness is delegated to the aggregator's `updatedAt` bound. Worth a look.

## Accepted risks here (do not re-report)

- **K-4/SF-2:** induced staleness traps active capital; honest staleness in a crash locks
  members into a falling basket. Accepted with eyes open; no hatch will be added.
- **SF-1 residual:** compromise of a strict majority of sources moves the median — the bound
  is the config floor, source independence is a listing criterion.
