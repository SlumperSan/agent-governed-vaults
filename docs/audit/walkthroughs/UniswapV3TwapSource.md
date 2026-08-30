# Walkthrough — UniswapV3TwapSource.sol

**Risk: High (feeds the contract that prices everything).** ~200 LoC incl. NatSpec + two
vendored math libraries. `contracts/test/retired/UniswapV3TwapSource.sol`,
`contracts/test/retired/vendor/{TickMath,FullMath}.sol` (both were under `contracts/src/oracle/`).

> **⚠ RETIRED — NOT THE LAUNCH ORACLE (marked 2026-08-30).** Critical **C-6** replaced this design
> with `contracts/src/oracle/ChainlinkOracle.sol` (one genuine Chainlink Data Feed per asset, no
> median, no quorum). The source now lives under **`contracts/test/retired/`** and is
> non-selectable through the `VaultFactory` oracle allowlist. This walkthrough is kept as the
> C-4/C-6 evidence record — scope it only if you are reviewing that finding.

> **NEW IN SPRINT 11 — POST-FREEZE.** This contract is **not** part of `v0.2.0-audit`. It is
> additive: it implements the existing `IPriceSource` and modifies nothing inside the frozen
> tree (`OracleAggregator` included). It has had **zero** internal adversarial review passes —
> the only thing standing behind it is its own test suite. See
> [../../CHANGES-SINCE-REVIEWS.md](../../CHANGES-SINCE-REVIEWS.md) §5. If your budget is
> uneven, weight this file accordingly.

## Purpose

The **spot-market TWAP** mechanism class for SF-1. `OracleAggregator` medians ≥3 sources, but
three Chainlink adapters over three Chainlink feeds are one source wearing three hats — the
listing criterion is *mechanism* diversity. This contract fails in ways a push feed and a pull
oracle do not (thin liquidity, a quiet pool, a tick-manipulating whale) and, crucially, does
not fail when they do (an aggregator pause, a keeper going unfunded).

Prices `asset` in USD from up to two Uniswap V3 arithmetic-mean-tick TWAPs, **pinning USDC to
$1.00**:

- **one hop** — `poolA` is `asset`/`usdc`.
- **two hops** — `poolA` is `asset`/`intermediate`, `poolB` is `intermediate`/`usdc`
  (cbETH → WETH → USDC).

## Config (immutable after construction)

`asset`, `usdc`, `poolA`, `poolB`, `window`, `minCardinality`, `maxObservationAge`, plus the
derived `intermediate`, `assetUnit`, `usdcScale`, `assetIsToken0A`, `intermediateIsToken0B`.
No setters. A creator wanting a different window deploys a different source — same posture as
the aggregator itself.

Constructor enforces:

- `window ∈ [300, 86400]`, `maxObservationAge ∈ (0, 1 days]`, `minCardinality ≥ 2`
- `asset ≠ usdc`, both non-zero, both `decimals ≤ 18`; `poolA` (and `poolB` when used) has code
- **token wiring, read from the pools themselves** — `asset` must be one of `poolA`'s tokens;
  the other side must be `usdc` (direct) or a bridging token that `poolB` pairs with `usdc`.
  The `token0`/`token1` *ordering* is read, not assumed, because it decides the sign of every
  tick and the branch of every quote.
- **each pool already retains observation history covering `window`.** This is the check most
  worth having and the reason the constructor makes on-chain calls at all — see below.

## `latestPrice()` — the whole algorithm

1. `try this.computePriceWad()` — the entire computation is behind a **self-STATICCALL**, so
   every failure mode lands on one `(0, 0)` return. This matches `ChainlinkSourceAdapter`'s
   `answer <= 0 → (0, 0)` convention rather than leaning on the aggregator's `try/catch`.
2. `_meanTick(pool)` for each hop, which applies the three freshness guards, calls
   `observe([window, 0])`, and takes `(tc[1] − tc[0]) / window` **floored toward negative
   infinity**.
3. `_quote(tick, baseAmount, baseIsToken0)` — `TickMath.getSqrtRatioAtTick` then the standard
   two-branch `FullMath.mulDiv` (Q64.192 while the ratio fits in 128 bits, Q64.128 above). The
   crossover is at **tick 443637**, located by bisection against the same independent reference
   that produced the golden ratios. No real pool reaches it, so the second branch would
   otherwise be exercised only by "does not revert" fuzz — `test_quoteCrossoverBranchIsWhereExpected`
   pins where the branch flips, `test_quoteBranchesAreContinuousAcrossTheCrossover` evaluates
   the two adjacent ticks 443636/443637 through the two different paths and requires the step
   between them to be the one basis point a single tick is worth, and
   `test_priceFixture_highTicksUseTheQ64_128Branch` pins golden values at tick 500000 and at
   `MAX_TICK`.
4. Multiply the USDC leg by `usdcScale` to reach WAD.
5. `updatedAt = block.timestamp`.

## Why `updatedAt = block.timestamp` is not a cheat (and where the staleness check moved)

A push feed's `updatedAt` answers *"when did someone last write?"*. A TWAP has no writer, so
there is no publish-lag term for the aggregator's `maxStaleness` to measure — the computation
is performed at read time over a window ending now.

The trap: `observe()` **does not revert on a dead pool**. `observeSingle` reverts `OLD` only
when the target predates the *oldest* observation; otherwise it transforms the last
observation using the **current tick**. So a pool with `observationCardinality == 1`, or one
that has not traded for longer than `window`, returns a "TWAP" synthesized entirely from the
live tick — a one-block-manipulable spot price wearing a TWAP's name. Combined with a
hardcoded `updatedAt`, that source would be **permanently fresh** and would vote in every
median forever.

So the staleness check lives in this contract, as three guards, all of which yield `(0, 0)`:

| # | Guard | What it rules out |
| --- | --- | --- |
| 1 | `observationCardinality ≥ minCardinality` | the degenerate single-slot pool |
| 2 | oldest retained observation is ≥ `window` old | `observe()` extrapolating from the live tick |
| 3 | newest observation is ≤ `maxObservationAge` old | a pool nobody trades any more |

Guard 2 is the load-bearing one and is also enforced at construction, so a source that cannot
serve its own window is **undeployable** rather than silently-spot in production.

### K-4 consequence

Because this source can withhold, it participates in the staleness breaker like any other: if
enough sources withhold, `priceWad` reverts `StaleOracle` and every NAV-reading path,
**including exits**, freezes with no hatch. Unchanged accepted tradeoff. What is new is that a
*market* going quiet is now a breaker input rather than a silently-stale number. The guards
fail closed — falling back to spot would trade a freeze for a manipulable price, which is
strictly worse.

## Vendored math and the license boundary

`vendor/TickMath.sol` and `vendor/FullMath.sol` are **third-party code in their own files
under their own SPDX headers** — GPL-2.0-or-later and MIT respectively, both derived from
Uniswap v3-core. The rest of the repository is BUSL-1.1. Do not inline these constants into a
BUSL-1.1 file; the separation is the license boundary. Only the `tick → sqrtPrice` direction
is vendored (`getTickAtSqrtRatio` is omitted rather than carried unused and unreviewed).

Both are 0.7.6 → 0.8.26 ports: the bodies are `unchecked` (the algorithms depend on wrapping
arithmetic), `-denominator` is written `0 - denominator`, `abs(tick)` goes through `int256`,
and the original `require` strings became custom errors.

**The 20 magic constants were verified against an independent reference**, not eyeballed: a
120-decimal-digit implementation of `round(√(1.0001^t) · 2⁹⁶)` over 685 ticks spanning the full
range, max relative deviation **2.3e-10**, at the extreme tick. `test_tickMathMatchesGoldenFixtures`
pins the resulting values, and `test_tickMathEndpointsMatchCanonicalSqrtRatios` pins the two
endpoints Uniswap publishes (`4295128739` and `1461446703485210103287273052203988822378723970342`).
These are golden fixtures, not self-consistency checks — a re-derived expectation would
reproduce whatever error the implementation had.

## Invariants / properties (tested)

- Exact price fixtures at real-world ticks in **both token orderings**, including the negative
  tick that Base's WETH/USDC ordering produces, an 8-decimal asset, and the two-hop route
  (`test_priceFixture_*`).
- Mean-tick division floors toward negative infinity: `−1801 / 1800 = −2`, not `−1`
  (`test_meanTickRoundsTowardNegativeInfinity`). Truncation would bias every token0-against-USDC
  pool upward by up to one tick **per hop**.
- `getSqrtRatioAtTick` is strictly increasing across the whole range and stays inside the
  canonical endpoints (`testFuzz_sqrtRatioStrictlyIncreasing`, `testFuzz_sqrtRatioWithinCanonicalBounds`).
- `latestPrice()` **never reverts**, for any pool state: it prices or it withholds, and a
  withheld price always carries `updatedAt == 0` (`testFuzz_latestPriceNeverReverts`).
- Each guard withholds in isolation, and one dark TWAP leg does not trip the aggregator's
  breaker while the other two classes hold (`MixedOracleSources.t.sol`).

## Review focus

1. **Guard 2's oldest-observation logic.** `oldestIndex = (observationIndex + 1) % cardinality`,
   falling back to slot 0 when that slot is uninitialized (the ring has not wrapped). Both
   branches are tested, but this mirrors Uniswap's `getOldestObservationSecondsAgo` and is the
   single point on which "is this a real TWAP" rests.
2. **`uint32` timestamp arithmetic** is deliberately `unchecked` so it wraps correctly across
   the 2106 rollover, as Uniswap's own observation arithmetic does. Confirm the comparisons
   still read correctly under wrap.
3. **The self-STATICCALL containment.** It works (a nested STATICCALL from a `view` is legal)
   and it is what makes `(0, 0)` total — `FullMath.mulDiv` genuinely reverts at extreme ticks.
   The cost is **one extra external call per TWAP source per `navWad`**, which compounds
   Sprint-6 **Finding 8**'s O(children × basketAssets × sources) gas scaling. Worth a look at
   whether that changes Finding 8's disposition for a TWAP-heavy basket.
4. **The USDC pin.** `usdc = $1.00` is asserted, never measured. A sustained depeg mis-prices
   this source's leg by exactly the depeg. Deliberate — measuring it would reintroduce the
   push-feed dependency this source exists to be independent of — and mitigated only by the
   median across classes. Confirm nothing in the code *claims* otherwise.
5. **Two-hop precision.** Hop one's output (in the intermediate's own decimals) is hop two's
   input. With an 18-decimal intermediate this is comfortable; a low-decimal intermediate would
   lose precision. Nothing enforces a decimals *floor* on the intermediate — only `≤ 18`.
6. **`minCardinality` is a config value, not a safety floor.** `MIN_CARDINALITY_FLOOR = 2` only
   rules out the degenerate pool. A deployment that pins `minCardinality = 2` and relies on
   guard 2 alone is *technically* fine (guard 2 is the real check) but leaves no margin as the
   ring wraps. `config/base-mainnet.json` pins 900 for a 1800-second window on 2-second blocks.

## Accepted risks here (do not re-report)

- **USDC depeg** mis-prices this source's leg, by design (see §4 above). Mitigation is the
  cross-class median, not an on-chain peg check.
- **TWAP lag.** A 30-minute mean tracks a fast market late, by construction. That is the
  manipulation-resistance trade the window buys, and it is why this is one source of three
  rather than the only one.
- **Pool-level correlation.** When several assets route through the same WETH/USDC pool, that
  pool going quiet withdraws the TWAP leg from all of them at once. Stated in
  `config/base-mainnet.json` rather than prevented in code — it is a listing-criterion problem,
  like SF-1's correlated-upstream problem.
