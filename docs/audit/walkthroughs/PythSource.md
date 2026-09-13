# Walkthrough — PythSource.sol

**Risk: Medium-High (feeds the contract that prices everything).** ~60 non-comment LoC.
`contracts/test/retired/PythSource.sol` (was `contracts/src/oracle/`).

> **⚠ RETIRED — NOT THE LAUNCH ORACLE (marked 2026-08-30).** Critical **C-6** replaced this design
> with `contracts/src/oracle/ChainlinkOracle.sol` (one genuine Chainlink Data Feed per asset, no
> median, no quorum), walked in [ChainlinkOracle.md](ChainlinkOracle.md). The source now lives under **`contracts/test/retired/`** and is
> non-selectable through the `VaultFactory` oracle allowlist. This walkthrough is kept as the
> C-4/C-6 evidence record — scope it only if you are reviewing that finding.

> **NEW IN SPRINT 11 — POST-FREEZE.** Not part of `v0.2.0-audit`. Additive: implements the
> existing `IPriceSource`, modifies nothing in the frozen tree. **Zero** internal adversarial
> review passes; its test suite is the only thing behind it. See
> [../../CHANGES-SINCE-REVIEWS.md](../../CHANGES-SINCE-REVIEWS.md) §5.

## Purpose

The **pull-oracle** mechanism class for SF-1, completing the trio with `ChainlinkSourceAdapter`
(push) and `UniswapV3TwapSource` (spot TWAP). Wraps one pinned Pyth price id, normalizing
Pyth's `(int64 mantissa, int32 expo)` to WAD and mapping `publishTime` to `updatedAt`.

`IPyth` is vendored inline as a minimal interface — two declarations — rather than importing
the official SDK, which brings its own `PythStructs`/`PythErrors` files and an `AbstractPyth`
base for a single `view` call. Same rationale as `SafeTransferLib`: keep the dependency surface
readable in one sitting. The struct layout is ABI-identical to `PythStructs.Price`:
`(int64 price, uint64 conf, int32 expo, uint256 publishTime)`.

## Config (immutable after construction)

`pyth`, `priceId`, `maxConfBps`. No setters.

Constructor enforces: `pyth` non-zero **and has code**; `priceId != 0`;
`maxConfBps ∈ (0, 2000]`; and — the check worth arguing about — it **reads the feed**, so an
id that does not resolve on this chain reverts at deployment, and the returned `expo` must be
inside `[-36, 18]`.

That read is deliberate. A mistyped 32-byte price id is otherwise indistinguishable from a
correct one: the source silently returns `(0, 0)` for the life of the vault, and a source that
never votes is **invisible inside a 2-of-3 quorum** until the day one of the other two fails.
The cost is that the feed must already be populated on Base — which is a prerequisite for the
source being useful at all.

## `latestPrice()` — the whole algorithm

1. `try pyth.getPriceUnsafe(priceId)` — the `Unsafe` variant on purpose. Freshness is the
   **aggregator's** decision, made against the per-asset `maxStaleness`.
   `getPriceNoOlderThan` would duplicate that policy in a second place with a second bound,
   which is how two staleness models drift apart. A revert (id never populated) becomes
   `(0, 0)`.
2. Reject `price <= 0` or `publishTime == 0`.
3. Reject `expo` outside `[MIN_EXPO, MAX_EXPO]`.
4. **Confidence gate:** reject when `conf * 10_000 > price * maxConfBps`. Cross-multiplied, no
   division; both sides are far inside `uint256`.
5. Normalize to WAD: `expo >= 0 → raw · 10^expo · 1e18`; `expo < 0` with `|expo| ≤ 18` scales
   **up** by `10^(18−|expo|)` (the ordinary case: `expo = −8` becomes `×1e10`); beyond 18 it
   scales **down** and loses the tail.
6. A result of 0 returns `(0, 0)` rather than voting a zero into the median.
7. `updatedAt = publishTime` — a real published number with a real publish lag, unlike a TWAP.

Every failure mode degrades to `(0, 0)`, matching `ChainlinkSourceAdapter`'s convention.

## The deployment trap this contract is most likely to hit

**Pyth's on-chain freshness is keeper economics, not Pyth's liveness.** Chainlink pushes: a
heartbeat writes the feed whether or not anyone reads. Pyth pulls: the on-chain price only
advances when somebody *pays* to post a signed update. A feed can be minutes or hours stale
on-chain while Pythnet's off-chain aggregate is a second old.

So **`OracleAggregator`'s `maxStaleness` must be chosen against the pinned id's observed
on-chain update cadence, not only against basket volatility.** DEPLOYMENT.md's standing "pick
`maxStaleness` tight (minutes)" is push-feed advice; applied to a stack containing this
contract it silently drops the Pyth leg on most reads, demoting an advertised **2-of-3 into an
effective 2-of-2 with zero headroom** — one Chainlink hiccup from a frozen breaker while
nothing is actually broken.

This is asserted, not just documented:
`MixedOracleSources.t.sol::test_tightStalenessSilentlyDemotesPullLegAndRemovesHeadroom`.
`config/base-mainnet.json` therefore pins one hour and says why.

## Invariants / properties (tested)

- An **exponent table** — `−6, −8, −12, −18, −20, 0, +2` — where every row is the same dollar
  price in its own scale and must normalize to the identical WAD value
  (`test_expoTableAllNormalizeToTheSameWad`). Fixture-based on purpose: expo handling is the one
  place a pull wrapper mis-prices by a clean factor of 10ⁿ, and a self-derived expectation
  would reproduce whatever sign error the implementation had.
- Normalization matches an independently written reference across the entire admitted exponent
  range (`testFuzz_expoNormalizationMatchesReference`).
- `MIN_EXPO`/`MAX_EXPO` at `int64` max normalize without overflow — the bounds are *usable*,
  not merely accepted (`test_expoBoundsAreUsableNotJustAccepted`).
- The confidence gate is exact at the boundary: `conf` of exactly `maxConfBps` passes, one
  basis point wider does not (`test_confidenceGateBoundary`, `testFuzz_confidenceGateIsExact`).
- `latestPrice()` never reverts; a price always carries its `publishTime`, a withheld price
  always carries `updatedAt == 0` (`testFuzz_latestPriceNeverReverts`).
- A dark Pyth leg does not trip the aggregator's breaker while the other two classes hold
  (`MixedOracleSources.t.sol`).

## Review focus

1. **`getPriceUnsafe` vs `getPriceNoOlderThan`.** The choice is argued above; disagree with it
   if you think a source should enforce its own floor. Note that a second bound here would be
   invisible to the member inspecting `assetConfig` before depositing.
2. **The constructor's on-chain read.** It makes deployment order-dependent (feed must be
   populated first) and it is an external call in a constructor. Judge whether the typo-catch
   is worth that.
3. **Confidence-gate policy.** `conf` is a 1-sigma-ish band, not a hard bound. Rejecting above
   1% is a judgement call: too tight and the source withholds during exactly the volatility
   where diversity matters most; too loose and it is not a filter. `MAX_CONF_BPS_CEILING = 2000`
   caps how far a creator can configure it away, but nothing stops a creator picking a value so
   tight the source rarely votes.
4. **`expo > 0` handling** is dead code against every Pyth USD feed in practice. It is handled
   rather than assumed away; check the arithmetic bound (`int64` max × 10¹⁸ × 1e18 ≈ 9.2e54,
   inside `uint256`) rather than the likelihood.
5. **The vendored `IPyth` struct layout.** A field-order or width mismatch against the real
   `PythStructs.Price` would decode garbage silently. Verify against the deployed Base contract.

## Accepted risks here (do not re-report)

- **Pyth-side compromise or a wrong aggregate** moves this source. That is SF-1's premise: one
  source of three cannot move a lower median. The mitigation is mechanism diversity, not a
  sanity band inside the adapter — the aggregator deliberately has no per-source deviation band
  (Sprint-6 Finding 6, dispositioned via the lower-median + strict-majority quorum instead).
- **Keeper-funding risk** is a liveness dependency this source adds. Accepted: it withholds
  rather than serving a stale number, and withholding is what the breaker is for (K-4).
