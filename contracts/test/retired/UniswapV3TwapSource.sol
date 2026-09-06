// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// RETIRED (C-6), formerly src/oracle/UniswapV3TwapSource.sol. The bespoke median-aggregator stack is
// superseded by src/oracle/ChainlinkOracle.sol and is no longer production source.
// It lives under test/ rather than being deleted because the audit tests for
// C-3/C-4/C-6 and H-1/H-2/M-1 drive the REAL contract, not a mock, and that evidence
// must keep building (SWARM §6). Citations to the old path resolve in git history.

import {IPriceSource} from "./OracleAggregator.sol";
import {TickMath} from "./vendor/TickMath.sol";
import {FullMath} from "./vendor/FullMath.sol";

/// @notice Minimal Uniswap V3 pool surface. Vendored inline rather than imported, matching the
/// `IUniswapV2Pair`/`IERC20Bal` convention in `DirectPoolAdapter.sol` — the dependency surface
/// stays small enough to read in one sitting.
interface IUniswapV3PoolMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observations(uint256 index)
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityX128,
            bool initialized
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title UniswapV3TwapSource — arithmetic-mean-tick TWAP as an IPriceSource
/// @notice Sprint 11. A **post-audit-freeze, additive** price source: it implements the
/// existing `IPriceSource` and modifies nothing inside the `v0.2.0-audit` tree. Its purpose is
/// SF-1 mechanism diversity — a spot-market TWAP fails in ways a Chainlink push feed and a
/// Pyth pull feed do not, so a 2-of-3 median across the three classes is not defeated by any
/// single upstream.
///
/// Prices `asset` in USD by composing up to two Uniswap V3 TWAPs and **pinning USDC to
/// $1.00**:
///
/// - one hop  — `poolA` is `asset`/`usdc`. Price = TWAP(asset→usdc).
/// - two hops — `poolA` is `asset`/`intermediate` and `poolB` is `intermediate`/`usdc`
///   (e.g. cbETH→WETH→USDC). Price = TWAP(asset→intermediate) then TWAP(intermediate→usdc).
///
/// The USDC leg is a *pin, not a measurement*: a sustained USDC depeg mis-prices every asset
/// this source quotes, by exactly the depeg. That is a deliberate, stated residual — the
/// alternative (a USDC/USD feed) would reintroduce the Chainlink dependency this source exists
/// to be independent of. The aggregator's median across mechanism classes is the mitigation:
/// a depeg moves only this source, and one source of three cannot move a lower median.
///
/// **Everything is immutable.** No setter exists — not for the pools, the window, the
/// cardinality floor, nor the observation-age bound. A vault creator wanting a different
/// window deploys a different source. This mirrors `OracleAggregator`'s own posture: the
/// configuration a prospective member inspects before depositing cannot be changed underneath
/// them.
///
/// ## Freshness, `updatedAt`, and K-4
///
/// `latestPrice` returns `updatedAt = block.timestamp`. That is *not* a claim that the pool is
/// active — it is the statement that the **computation** is performed at read time over a
/// window ending now, so there is no publish-lag term for the aggregator's staleness bound to
/// measure. A push feed's `updatedAt` answers "when did someone last write?"; a TWAP has no
/// writer, so the equivalent question is "does the pool still hold enough recent observations
/// for the mean to mean anything?" — and that question cannot be delegated to the aggregator,
/// because a hardcoded `block.timestamp` is unconditionally within any staleness bound.
///
/// So the staleness check lives **here**, and `latestPrice` degrades to `(0, 0)` — the
/// aggregator's not-fresh signal — unless all three of these hold:
///
///  1. `observationCardinality >= minCardinality`;
///  2. the pool's **oldest** retained observation is at least `window` old, so `observe()`
///     interpolates within recorded history instead of extrapolating from the live tick;
///  3. the pool's **newest** observation is no older than `maxObservationAge`.
///
/// Guard (2) is the one that matters most and the one that is easy to omit. `observe()` does
/// **not** revert for a pool that has stopped trading: `observeSingle` only reverts `OLD` when
/// the target predates the oldest observation, and otherwise transforms the last observation
/// using the *current* tick. A pool with `observationCardinality == 1`, or one that has not
/// traded for longer than `window`, therefore returns a "TWAP" whose every second is
/// synthesized from the live tick — a spot price wearing a TWAP's name, manipulable in one
/// block, and (with a hardcoded `updatedAt`) permanently fresh. Guards (1)–(3) are what make
/// the `updatedAt = block.timestamp` convention honest.
///
/// **K-4 consequence.** Because this source can withhold itself (return `(0, 0)`) when its
/// pool goes quiet, it participates in the staleness breaker like any other source: if enough
/// sources withhold, `priceWad` reverts `StaleOracle` and every NAV-reading path — including
/// exits — freezes, with no hatch. That is the accepted K-4/SF-2 tradeoff, unchanged. What
/// this source adds is that a *market* going quiet is now a breaker input, not a silently
/// stale number. The failure it prevents (pricing a basket off a one-block-manipulable tick)
/// is strictly worse than the failure it can cause (a freeze), which is why the guards fail
/// closed rather than falling back to spot.
contract UniswapV3TwapSource is IPriceSource {
    /// @notice Shortest permitted TWAP window. Below ~5 minutes the manipulation cost on a
    /// mid-liquidity pool stops being meaningful and the source degenerates toward spot.
    uint32 public constant MIN_WINDOW = 300;
    /// @notice Longest permitted TWAP window. Matches `OracleAggregator.MAX_STALENESS_CEILING`:
    /// averaging over more than a day is not a spot index price by any reading.
    uint32 public constant MAX_WINDOW = 1 days;
    /// @notice Hard floor on the pool's observation cardinality. A deployment should pin a far
    /// higher value (see the walkthrough); this only rules out the degenerate single-slot pool.
    uint16 public constant MIN_CARDINALITY_FLOOR = 2;
    /// @notice Upper bound on the configurable `maxObservationAge`, mirroring the aggregator's
    /// own staleness ceiling.
    uint32 public constant MAX_OBSERVATION_AGE_CEILING = 1 days;

    /// @notice H-2: the maximum share of the reported mean that may come from the LIVE tick,
    /// as a divisor of `window` (20 => 5%).
    ///
    /// `observe([window, 0])` asks v3-core for an endpoint at `block.timestamp`. When the
    /// newest stored observation is older than that target — i.e. always, on any pool not
    /// traded in this very block — `observeSingle` SYNTHESIZES the endpoint from the newest
    /// observation using the CURRENT tick. With `A = now - newestObservation` the live tick's
    /// weight in the "historical" mean is exactly `min(A, W) / W`, reaching 1.0 once the pool
    /// has been quiet for a full window. The old guards bounded `A` against `maxObservationAge`
    /// and the OLDEST observation against `window`, but nothing ever compared the NEWEST
    /// observation to the window, and the constructor validated the two independently — so the
    /// shipped 1800/3600 config permitted A = 2x the window, and the ceilings permitted 288x.
    ///
    /// The naive `require(now - newestTs < window)` was tested by the audit and is NOT enough:
    /// it caps live weight just below 1.0, still permitting a >90% error. Contamination equals
    /// the fraction, so the fraction is what must be small.
    uint32 public constant MAX_LIVE_TICK_WEIGHT_DIVISOR = 20; // <= 5% of the window

    /// @notice The asset being priced.
    address public immutable asset;
    /// @notice The USDC-like token pinned to $1.00 — the quote leg of the final hop.
    address public immutable usdc;
    /// @notice The bridging token for two-hop routes, or `address(0)` for a direct pool.
    address public immutable intermediate;
    /// @notice `asset`/(`intermediate` or `usdc`) pool.
    IUniswapV3PoolMinimal public immutable poolA;
    /// @notice `intermediate`/`usdc` pool, or the zero address for a direct route.
    IUniswapV3PoolMinimal public immutable poolB;
    /// @notice TWAP window in seconds, applied identically to both hops.
    uint32 public immutable window;
    /// @notice Minimum `observationCardinality` each pool must report at read time.
    uint16 public immutable minCardinality;
    /// @notice Maximum age of a pool's newest observation before this source withholds.
    uint32 public immutable maxObservationAge;

    /// @dev `10 ** asset.decimals()` — the base amount quoted, i.e. one whole asset token.
    uint256 public immutable assetUnit;
    /// @dev `10 ** (18 - usdc.decimals())` — final normalization of the USDC leg to WAD.
    uint256 public immutable usdcScale;
    /// @dev Whether `asset` is `poolA.token0()`; fixes the quote direction of hop one.
    bool public immutable assetIsToken0A;
    /// @dev Whether `intermediate` is `poolB.token0()`; fixes the quote direction of hop two.
    bool public immutable intermediateIsToken0B;

    error BadTwapConfig();
    /// @dev Thrown internally when a freshness guard fails; never escapes `latestPrice`, which
    /// converts it to the `(0, 0)` not-fresh signal.
    error TwapPoolNotUsable();

    /// @notice Pin the whole route forever, validating every property that is knowable at
    /// deployment: token wiring on both pools, decimals, window and age bounds, and — the
    /// check most worth having — that each pool **already** retains enough observation history
    /// to serve `window`. Deploying a TWAP source over a pool that cannot yet answer for its
    /// own window is the single most likely configuration mistake, and it is caught here
    /// rather than discovered as a silently-spot price in production.
    /// @param asset_ the token to price in USD
    /// @param usdc_ the USDC-like token pinned to $1.00 (decimals ≤ 18)
    /// @param poolA_ the `asset`/(`intermediate`|`usdc`) V3 pool
    /// @param poolB_ the `intermediate`/`usdc` V3 pool, or `address(0)` if `poolA_` quotes USDC
    /// @param window_ TWAP window in seconds, in [MIN_WINDOW, MAX_WINDOW]
    /// @param minCardinality_ required observation cardinality, at least MIN_CARDINALITY_FLOOR
    /// @param maxObservationAge_ newest-observation bound, in (0, MAX_OBSERVATION_AGE_CEILING]
    constructor(
        address asset_,
        address usdc_,
        IUniswapV3PoolMinimal poolA_,
        IUniswapV3PoolMinimal poolB_,
        uint32 window_,
        uint16 minCardinality_,
        uint32 maxObservationAge_
    ) {
        require(asset_ != address(0) && usdc_ != address(0) && asset_ != usdc_, BadTwapConfig());
        require(window_ >= MIN_WINDOW && window_ <= MAX_WINDOW, BadTwapConfig());
        require(minCardinality_ >= MIN_CARDINALITY_FLOOR, BadTwapConfig());
        require(maxObservationAge_ > 0 && maxObservationAge_ <= MAX_OBSERVATION_AGE_CEILING, BadTwapConfig());
        // H-2: `maxObservationAge` is no longer an INDEPENDENT knob. It was validated in
        // isolation from `window`, which is how a config could allow the newest observation to
        // be twice the window old. It may now never exceed the live-tick weight bound.
        require(
            uint256(maxObservationAge_) * MAX_LIVE_TICK_WEIGHT_DIVISOR <= uint256(window_), BadTwapConfig()
        );
        require(address(poolA_).code.length > 0, BadTwapConfig());

        uint8 assetDecimals = IERC20Decimals(asset_).decimals();
        uint8 usdcDecimals = IERC20Decimals(usdc_).decimals();
        require(assetDecimals <= 18 && usdcDecimals <= 18, BadTwapConfig());

        // Hop one: `asset` must be one of poolA's tokens; the other side is the hop's quote.
        (address a0, address a1) = (poolA_.token0(), poolA_.token1());
        bool assetIsToken0A_;
        address quoteA;
        if (a0 == asset_) {
            assetIsToken0A_ = true;
            quoteA = a1;
        } else if (a1 == asset_) {
            assetIsToken0A_ = false;
            quoteA = a0;
        } else {
            revert BadTwapConfig();
        }

        address intermediate_;
        bool intermediateIsToken0B_;
        if (address(poolB_) == address(0)) {
            // Direct route: hop one must already quote USDC.
            require(quoteA == usdc_, BadTwapConfig());
        } else {
            require(address(poolB_).code.length > 0, BadTwapConfig());
            // Two-hop route: hop one quotes a bridging token that is neither endpoint.
            require(quoteA != usdc_ && quoteA != asset_, BadTwapConfig());
            require(IERC20Decimals(quoteA).decimals() <= 18, BadTwapConfig());
            intermediate_ = quoteA;
            (address b0, address b1) = (poolB_.token0(), poolB_.token1());
            if (b0 == quoteA) {
                require(b1 == usdc_, BadTwapConfig());
                intermediateIsToken0B_ = true;
            } else if (b1 == quoteA) {
                require(b0 == usdc_, BadTwapConfig());
                intermediateIsToken0B_ = false;
            } else {
                revert BadTwapConfig();
            }
        }

        // Both pools must be able to serve `window` *today* — see the notice above.
        require(_poolServesWindow(poolA_, window_, minCardinality_), BadTwapConfig());
        if (address(poolB_) != address(0)) {
            require(_poolServesWindow(poolB_, window_, minCardinality_), BadTwapConfig());
        }

        asset = asset_;
        usdc = usdc_;
        intermediate = intermediate_;
        poolA = poolA_;
        poolB = poolB_;
        window = window_;
        minCardinality = minCardinality_;
        maxObservationAge = maxObservationAge_;
        assetUnit = 10 ** assetDecimals;
        usdcScale = 10 ** (18 - usdcDecimals);
        assetIsToken0A = assetIsToken0A_;
        intermediateIsToken0B = intermediateIsToken0B_;
    }

    /// @notice WAD USD price of one whole `asset`, or `(0, 0)` when any freshness guard fails
    /// or the tick math cannot be evaluated.
    /// @dev The entire computation runs behind `try this.computePriceWad()`. A nested
    /// STATICCALL from a `view` function is legal, and it is what makes the `(0, 0)` contract
    /// total: `FullMath.mulDiv` genuinely reverts at extreme ticks, and `observe()` reverts on
    /// a pool without code. Containing both here matches `ChainlinkSourceAdapter`'s convention
    /// (`answer <= 0` yields `(0, 0)`) rather than relying on the aggregator's `try/catch` to
    /// absorb a revert. The cost is one extra external call per TWAP source per `navWad` — see
    /// the walkthrough's note on Sprint-6 Finding 8.
    /// @return priceWad USD price of one whole token, WAD (0 if unusable)
    /// @return updatedAt `block.timestamp` — a TWAP is computed, not published (0 if unusable)
    function latestPrice() external view returns (uint256, uint256) {
        try this.computePriceWad() returns (uint256 p) {
            if (p == 0) return (0, 0);
            // H-2, second half: this used to hardcode `block.timestamp`, so a source computing
            // over a stale tick stamped itself ZERO SECONDS OLD and the aggregator's staleness
            // bound — even a 60-second one — was STRUCTURALLY incapable of rejecting it. The
            // contract's own notice claimed the guards were "what make the
            // `updatedAt = block.timestamp` convention honest"; they were not. Reporting the
            // newest observation actually backing the quote makes the aggregator's bound apply
            // to this class exactly as it applies to a push feed.
            return (p, _newestObservationTs());
        } catch {
            return (0, 0);
        }
    }

    /// @dev The oldest of the hops' newest-observation timestamps — the real age of the data
    /// backing a quote. Only reached after `computePriceWad` has succeeded, so the same pool
    /// reads have already been made without reverting.
    /// @return ts unix timestamp of the newest observation backing the quote
    function _newestObservationTs() internal view returns (uint256 ts) {
        ts = _newestTsOf(poolA);
        if (address(poolB) != address(0)) {
            uint256 b = _newestTsOf(poolB);
            if (b < ts) ts = b;
        }
    }

    /// @dev Newest observation timestamp of a single pool.
    /// @param pool the pool to read
    /// @return the newest stored observation's timestamp
    function _newestTsOf(IUniswapV3PoolMinimal pool) internal view returns (uint256) {
        (,, uint16 observationIndex,,,,) = pool.slot0();
        (uint32 newestTs,,,) = pool.observations(observationIndex);
        return newestTs;
    }

    /// @notice The unguarded price computation — reverts instead of degrading, so that
    /// `latestPrice` can convert every failure mode into `(0, 0)` in one place.
    /// @dev `external` because it is invoked through `this` for that containment; it is a
    /// `view` with no authority and is safe to call directly (useful when diagnosing *why* a
    /// source went not-fresh, which `(0, 0)` deliberately does not tell you).
    /// @return priceWad USD price of one whole `asset`, WAD-scaled
    function computePriceWad() external view returns (uint256 priceWad) {
        uint256 amountUsdc;
        if (address(poolB) == address(0)) {
            amountUsdc = _quote(_meanTick(poolA), assetUnit, assetIsToken0A);
        } else {
            uint256 amountIntermediate = _quote(_meanTick(poolA), assetUnit, assetIsToken0A);
            if (amountIntermediate == 0) return 0; // hop one rounded to dust; not a price
            amountUsdc = _quote(_meanTick(poolB), amountIntermediate, intermediateIsToken0B);
        }
        priceWad = amountUsdc * usdcScale;
    }

    /// @dev Arithmetic-mean tick over `window`, after the three freshness guards. Reverts
    /// `TwapPoolNotUsable` rather than returning a sentinel, so no caller can forget to check.
    function _meanTick(IUniswapV3PoolMinimal pool) internal view returns (int24) {
        (,, uint16 observationIndex, uint16 cardinality,,,) = pool.slot0();
        if (cardinality < minCardinality) revert TwapPoolNotUsable();

        // Guard 3: the newest observation must be recent — a pool nobody trades is not a market.
        (uint32 newestTs,,,) = pool.observations(observationIndex);
        unchecked {
            // uint32 subtraction wraps correctly across the 2106 rollover, as Uniswap's own
            // observation arithmetic does.
            uint32 age = uint32(block.timestamp) - newestTs;
            if (age > maxObservationAge) revert TwapPoolNotUsable();
            // H-2: and independently, the live tick may contribute at most 1/DIVISOR of the
            // reported mean. This is the bound that actually limits contamination; the
            // maxObservationAge bound above is now a subset of it by construction.
            if (uint256(age) * MAX_LIVE_TICK_WEIGHT_DIVISOR > uint256(window)) {
                revert TwapPoolNotUsable();
            }
        }

        // Guard 2: the oldest retained observation must predate the window, so `observe()`
        // interpolates over recorded history instead of extrapolating from the live tick.
        uint256 oldestIndex = (uint256(observationIndex) + 1) % cardinality;
        (uint32 oldestTs,,, bool initialized) = pool.observations(oldestIndex);
        if (!initialized) {
            // The ring has not wrapped yet; slot 0 is the oldest written entry.
            (oldestTs,,,) = pool.observations(0);
        }
        unchecked {
            if (uint32(block.timestamp) - oldestTs < window) revert TwapPoolNotUsable();
        }

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int56 span = int56(uint56(window));
        int56 mean = delta / span;
        // Round toward negative infinity: truncating division rounds toward zero, which would
        // bias every negative-tick pool (i.e. every pool whose asset is token0 against USDC)
        // upward by up to one tick on each hop.
        if (delta < 0 && delta % span != 0) --mean;
        // Range-check before narrowing: `int56 -> int24` truncates silently, and a pool
        // returning nonsense cumulatives would otherwise be laundered into a plausible tick.
        if (mean < TickMath.MIN_TICK || mean > TickMath.MAX_TICK) revert TwapPoolNotUsable();
        return int24(mean);
    }

    /// @dev `baseAmount` of the base token, valued in the quote token at `tick`. Mirrors
    /// Uniswap's `OracleLibrary.getQuoteAtTick`, re-derived here over the vendored primitives
    /// so the whole path is in-repo and auditable.
    /// @param tick the arithmetic-mean tick for the hop
    /// @param baseAmount amount of the base token, in the base token's own decimals
    /// @param baseIsToken0 whether the base token is the pool's `token0`
    /// @return quoteAmount the equivalent amount of the quote token, in its own decimals
    function _quote(int24 tick, uint256 baseAmount, bool baseIsToken0)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        // Squaring a Q64.96 needs 192 fractional bits; that only fits in 256 while the ratio
        // itself fits in 128. Above that, drop to Q64.128 first — the standard two-branch form.
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return baseIsToken0
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        }
        uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
        return baseIsToken0
            ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
            : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
    }

    /// @dev Constructor-time form of guards (1) and (2): the pool reports at least
    /// `minCardinality_` slots and already retains an observation older than `window_`.
    /// Takes its bounds as arguments because immutables cannot be read during construction.
    function _poolServesWindow(IUniswapV3PoolMinimal pool, uint32 window_, uint16 minCardinality_)
        private
        view
        returns (bool)
    {
        (,, uint16 observationIndex, uint16 cardinality,,,) = pool.slot0();
        if (cardinality < minCardinality_) return false;
        uint256 oldestIndex = (uint256(observationIndex) + 1) % cardinality;
        (uint32 oldestTs,,, bool initialized) = pool.observations(oldestIndex);
        if (!initialized) {
            (oldestTs,,,) = pool.observations(0);
        }
        unchecked {
            return uint32(block.timestamp) - oldestTs >= window_;
        }
    }
}
