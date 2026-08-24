// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UniswapV3TwapSource, IUniswapV3PoolMinimal} from "../src/oracle/UniswapV3TwapSource.sol";
import {TickMath} from "../src/oracle/vendor/TickMath.sol";
import {FullMath} from "../src/oracle/vendor/FullMath.sol";
import {MockV3Pool} from "./mocks/OracleSourceMocks.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// Sprint 11 — unit, fixture and fuzz coverage for `UniswapV3TwapSource` (a post-audit-freeze
/// additive `IPriceSource`).
///
/// The tick fixtures below are **golden values**, not self-consistency checks. They were
/// produced by an independent 120-decimal-digit implementation of `round(sqrt(1.0001^t) · 2^96)`
/// and cross-checked against the two canonical endpoints Uniswap publishes
/// (`MIN_SQRT_RATIO`/`MAX_SQRT_RATIO`). A wrong magic constant in the vendored `TickMath` port
/// fails these; it would not fail a test that re-derived the expectation from the same code.
contract UniswapV3TwapSourceTest is Test {
    MockERC20 weth;
    MockERC20 usdc;
    MockERC20 cbeth;
    MockERC20 wbtc;

    uint32 constant WINDOW = 1800; // 30 minutes
    uint16 constant MIN_CARD = 100;
    uint32 constant MAX_OBS_AGE = 3600;

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockERC20("WETH", 18);
        usdc = new MockERC20("USDC", 6);
        cbeth = new MockERC20("cbETH", 18);
        wbtc = new MockERC20("WBTC", 8);
    }

    // --------------------------------------------------------------------------------------
    // helpers
    // --------------------------------------------------------------------------------------

    /// A pool that satisfies all three freshness guards: deep ring, oldest observation well
    /// before the window, newest observation recent.
    function _healthyPool(address t0, address t1, int24 tick) internal returns (MockV3Pool p) {
        p = new MockV3Pool(t0, t1, 500);
        p.setTick(tick);
        p.setRing(MIN_CARD, 40, uint32(block.timestamp - 2 * WINDOW), uint32(block.timestamp - 30));
    }

    function _oneHop(address asset, MockV3Pool pool) internal returns (UniswapV3TwapSource) {
        return new UniswapV3TwapSource(
            asset,
            address(usdc),
            IUniswapV3PoolMinimal(address(pool)),
            IUniswapV3PoolMinimal(address(0)),
            WINDOW,
            MIN_CARD,
            MAX_OBS_AGE
        );
    }

    // --------------------------------------------------------------------------------------
    // TickMath golden fixtures
    // --------------------------------------------------------------------------------------

    function test_tickMathMatchesGoldenFixtures() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(0), 79228162514264337593543950336, "tick 0 must be exactly 2^96");
        assertEq(TickMath.getSqrtRatioAtTick(1), 79232123823359799118286999568, "tick 1");
        assertEq(TickMath.getSqrtRatioAtTick(-1), 79224201403219477170569942574, "tick -1");
        assertEq(TickMath.getSqrtRatioAtTick(60), 79466191966197645195421774833, "tick 60");
        assertEq(TickMath.getSqrtRatioAtTick(-60), 78990846045029531151608375686, "tick -60");
        assertEq(TickMath.getSqrtRatioAtTick(1000), 83290069058676223003182343270, "tick 1000");
        assertEq(TickMath.getSqrtRatioAtTick(-1000), 75364347830767020784054125655, "tick -1000");
        assertEq(TickMath.getSqrtRatioAtTick(6931), 112040957517951813098925484553, "tick 6931 (~2x)");
        assertEq(TickMath.getSqrtRatioAtTick(-6931), 56025063284388026574112267992, "tick -6931 (~0.5x)");
        assertEq(TickMath.getSqrtRatioAtTick(100000), 11755562826496067164730007768450, "tick 100000");
        assertEq(TickMath.getSqrtRatioAtTick(-100000), 533968626430936354154228408, "tick -100000");
        assertEq(TickMath.getSqrtRatioAtTick(196256), 1446476584571639225752396618629938, "ETH/USDC tick");
        assertEq(TickMath.getSqrtRatioAtTick(-196267), 4337194613517777023204848, "USDC/ETH tick");
        // Straddling the point where `_quote` switches from the Q64.192 form to Q64.128.
        assertEq(TickMath.getSqrtRatioAtTick(443636), 340275971719517849884101479065584693834, "tick 443636");
        assertEq(TickMath.getSqrtRatioAtTick(443637), 340292985092780127046320864355664555423, "tick 443637");
        assertEq(TickMath.getSqrtRatioAtTick(500000), 5697689776495288729098254600827762987878, "tick 500000");
    }

    /// The two endpoints Uniswap publishes as `MIN_SQRT_RATIO`/`MAX_SQRT_RATIO`. Between them
    /// these two ticks exercise ten of the twenty magic constants.
    function test_tickMathEndpointsMatchCanonicalSqrtRatios() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MIN_TICK), TickMath.MIN_SQRT_RATIO, "MIN");
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MAX_TICK), TickMath.MAX_SQRT_RATIO, "MAX");
        assertEq(TickMath.MIN_SQRT_RATIO, 4295128739, "MIN_SQRT_RATIO literal");
        assertEq(
            TickMath.MAX_SQRT_RATIO,
            1461446703485210103287273052203988822378723970342,
            "MAX_SQRT_RATIO literal"
        );
    }

    function test_tickMathRejectsOutOfRangeTicks() public {
        vm.expectRevert(TickMath.TickOutOfRange.selector);
        this.callGetSqrtRatio(TickMath.MAX_TICK + 1);
        vm.expectRevert(TickMath.TickOutOfRange.selector);
        this.callGetSqrtRatio(TickMath.MIN_TICK - 1);
    }

    function callGetSqrtRatio(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(tick);
    }

    // --------------------------------------------------------------------------------------
    // end-to-end price fixtures (both token orderings, negative ticks, non-18 decimals)
    // --------------------------------------------------------------------------------------

    /// Asset is `token1`, tick positive: the mainnet USDC/WETH shape.
    function test_priceFixture_assetIsToken1_positiveTick() public {
        MockV3Pool pool = _healthyPool(address(usdc), address(weth), 196256);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 3000104290000000000000, "WETH price at tick 196256"); // $3000.10429
        assertEq(t, block.timestamp, "TWAP is computed at read time");
        assertFalse(src.assetIsToken0A(), "asset must be detected as token1");
    }

    /// Asset is `token0`, tick negative: the Base WETH/USDC shape. The same asset at very
    /// nearly the same price, reached through the other branch of `_quote`.
    function test_priceFixture_assetIsToken0_negativeTick() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), -196267);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        (uint256 p,) = src.latestPrice();
        assertEq(p, 2996806154000000000000, "WETH price at tick -196267"); // $2996.806154
        assertTrue(src.assetIsToken0A(), "asset must be detected as token0");
    }

    /// Eight-decimal asset — the `assetUnit` scaling is per-asset, not assumed to be 1e18.
    function test_priceFixture_eightDecimalAsset() public {
        MockV3Pool pool = _healthyPool(address(wbtc), address(usdc), 63972);
        UniswapV3TwapSource src = _oneHop(address(wbtc), pool);
        (uint256 p,) = src.latestPrice();
        assertEq(p, 59997030439000000000000, "WBTC price at tick 63972"); // $59997.030439
        assertEq(src.assetUnit(), 1e8, "base amount is one whole WBTC");
        assertEq(src.usdcScale(), 1e12, "USDC leg normalized 6 -> 18 decimals");
    }

    /// Two hops: cbETH -> WETH (tick 862, ~1.09) -> USDC (tick -196267).
    function test_priceFixture_twoHopThroughIntermediate() public {
        MockV3Pool poolA = _healthyPool(address(cbeth), address(weth), 862);
        MockV3Pool poolB = _healthyPool(address(weth), address(usdc), -196267);
        UniswapV3TwapSource src = new UniswapV3TwapSource(
            address(cbeth),
            address(usdc),
            IUniswapV3PoolMinimal(address(poolA)),
            IUniswapV3PoolMinimal(address(poolB)),
            WINDOW,
            MIN_CARD,
            MAX_OBS_AGE
        );
        (uint256 p,) = src.latestPrice();
        assertEq(p, 3266577487000000000000, "cbETH price via WETH"); // $3266.577487
        assertEq(src.intermediate(), address(weth), "bridging token recorded");
        assertTrue(src.intermediateIsToken0B(), "hop-two direction");
    }

    /// `_quote` has two branches: the Q64.192 form while `sqrtRatioX96` fits in 128 bits, and a
    /// Q64.128 form above it. Every fixture above lives on the FIRST branch — real pools never
    /// reach the crossover — so without these two tests a transposed shift in the second branch
    /// would pass the whole suite. The crossover is at tick 443637, established by bisection
    /// against the same independent reference that produced the golden ratios.
    function test_quoteCrossoverBranchIsWhereExpected() public pure {
        assertLe(TickMath.getSqrtRatioAtTick(443636), type(uint128).max, "443636 is the Q64.192 branch");
        assertGt(TickMath.getSqrtRatioAtTick(443637), type(uint128).max, "443637 is the Q64.128 branch");
    }

    /// The two branches must agree where they meet. These are ADJACENT ticks evaluated by
    /// DIFFERENT code paths, so the price step between them can only be one tick — 1 bp. A
    /// wrong shift in the Q64.128 branch shows up here as an order-of-magnitude discontinuity,
    /// not a rounding difference.
    function test_quoteBranchesAreContinuousAcrossTheCrossover() public {
        MockV3Pool below = _healthyPool(address(weth), address(usdc), 443636);
        MockV3Pool above = _healthyPool(address(weth), address(usdc), 443637);
        (uint256 pBelow,) = _oneHop(address(weth), below).latestPrice();
        (uint256 pAbove,) = _oneHop(address(weth), above).latestPrice();

        assertEq(pBelow, 18446050711097703529776342895654370894000000000000, "Q64.192 side");
        assertEq(pAbove, 18447895316168813300129320530133980662000000000000, "Q64.128 side");
        assertGt(pAbove, pBelow, "one tick up must price higher across the branch change");
        assertLt((pAbove - pBelow) * 10_000 / pBelow, 5, "branch discontinuity, not a one-tick step");
    }

    /// Golden values well inside the Q64.128 branch, including the extreme tick — the widest
    /// value the whole path can produce without overflowing the final WAD scaling.
    function test_priceFixture_highTicksUseTheQ64_128Branch() public {
        MockV3Pool mid = _healthyPool(address(weth), address(usdc), 500000);
        (uint256 p,) = _oneHop(address(weth), mid).latestPrice();
        assertEq(p, 5171760815372400971558161893748917540546000000000000, "tick 500000");

        MockV3Pool top = _healthyPool(address(weth), address(usdc), TickMath.MAX_TICK);
        (uint256 pTop,) = _oneHop(address(weth), top).latestPrice();
        assertEq(
            pTop,
            340256786836388094070642339899681172762184831912720469415000000000000,
            "MAX_TICK still prices rather than overflowing"
        );
    }

    // --------------------------------------------------------------------------------------
    // mean-tick rounding — the negative-tick trap
    // --------------------------------------------------------------------------------------

    /// A delta that does not divide the window must round toward NEGATIVE INFINITY, not toward
    /// zero. Truncating division would return -1 here and bias every token0-against-USDC pool
    /// upward. `-1801 / 1800 = -1` truncated; the correct arithmetic mean tick is -2.
    function test_meanTickRoundsTowardNegativeInfinity() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), 0);
        pool.setRawCumulatives(0, -1801);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        (uint256 p,) = src.latestPrice();

        uint256 expected = _referencePrice(-2, 1e18, true, 1e12);
        assertEq(p, expected, "mean tick must floor to -2");
        assertTrue(p != _referencePrice(-1, 1e18, true, 1e12), "must not truncate toward zero");
    }

    /// The positive side keeps truncating toward zero, which for positives *is* the floor.
    function test_meanTickTruncatesPositiveTowardZero() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), 0);
        pool.setRawCumulatives(0, 3599);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        (uint256 p,) = src.latestPrice();
        assertEq(p, _referencePrice(1, 1e18, true, 1e12), "mean tick must floor to 1");
    }

    /// An exactly-divisible negative delta must NOT be decremented.
    function test_meanTickExactNegativeIsNotDecremented() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), 0);
        pool.setRawCumulatives(0, -1800);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        (uint256 p,) = src.latestPrice();
        assertEq(p, _referencePrice(-1, 1e18, true, 1e12), "exact division stays at -1");
    }

    /// Cumulatives implying a tick outside the representable range are rejected rather than
    /// silently truncated into a plausible-looking tick by the int56 -> int24 narrowing.
    function test_outOfRangeMeanTickWithholds() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), 0);
        pool.setRawCumulatives(0, int56(1800) * int56(TickMath.MAX_TICK) + 1800);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0, "out-of-range tick must not price");
        assertEq(t, 0, "and must report not-fresh");
    }

    // --------------------------------------------------------------------------------------
    // freshness guards — the reason `updatedAt = block.timestamp` is defensible
    // --------------------------------------------------------------------------------------

    /// Guard 1: a pool whose cardinality fell below the pinned floor withholds.
    function test_withholdsWhenCardinalityBelowFloor() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), -196267);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        pool.setRing(MIN_CARD - 1, 40, uint32(block.timestamp - 2 * WINDOW), uint32(block.timestamp - 30));
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0);
        assertEq(t, 0);
    }

    /// Guard 2 — the important one. A pool whose oldest retained observation is younger than
    /// the window would have `observe()` extrapolate the missing seconds from the LIVE tick:
    /// a spot price wearing a TWAP's name. It must withhold instead.
    function test_withholdsWhenWindowIsNotCoveredByHistory() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), -196267);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        // Oldest observation only 5 minutes old; the window asks for 30.
        pool.setRing(MIN_CARD, 40, uint32(block.timestamp - 300), uint32(block.timestamp - 30));
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0, "under-covered window must not price");
        assertEq(t, 0);
    }

    /// Guard 3: a pool that has stopped trading withholds, even though `observe()` still
    /// happily returns numbers for it.
    function test_withholdsWhenNewestObservationIsStale() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), -196267);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        pool.setRing(
            MIN_CARD, 40, uint32(block.timestamp - 10 days), uint32(block.timestamp - MAX_OBS_AGE - 1)
        );
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0, "quiet pool must not price");
        assertEq(t, 0);
        // One second inside the bound is fine.
        pool.setRing(MIN_CARD, 40, uint32(block.timestamp - 10 days), uint32(block.timestamp - MAX_OBS_AGE));
        (p, t) = src.latestPrice();
        assertGt(p, 0, "boundary is inclusive");
    }

    /// The un-wrapped-ring branch: slot `index+1` is uninitialized, so slot 0 is the oldest.
    function test_unwrappedRingUsesSlotZeroAsOldest() public {
        MockV3Pool pool = new MockV3Pool(address(weth), address(usdc), 500);
        pool.setTick(-196267);
        pool.setUnwrappedRing(
            MIN_CARD, 40, uint32(block.timestamp - 2 * WINDOW), uint32(block.timestamp - 30)
        );
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        (uint256 p,) = src.latestPrice();
        assertEq(p, 2996806154000000000000, "slot 0 covers the window");

        // Now make slot 0 too young: the same branch must withhold.
        pool.setUnwrappedRing(MIN_CARD, 40, uint32(block.timestamp - 60), uint32(block.timestamp - 30));
        (p,) = src.latestPrice();
        assertEq(p, 0, "un-wrapped ring shorter than the window must withhold");
    }

    /// A reverting `observe()` (a real pool's `OLD`) degrades to (0,0), never propagates.
    function test_revertingObserveDegradesToZero() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), -196267);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        pool.setObserveReverts(true);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0);
        assertEq(t, 0);
    }

    /// `computePriceWad` is the diagnostic counterpart: it reverts where `latestPrice` returns
    /// (0,0), so an operator can find out *why* a source stopped voting.
    function test_computePriceWadRevertsWhereLatestPriceWithholds() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), -196267);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);
        pool.setRing(MIN_CARD, 40, uint32(block.timestamp - 300), uint32(block.timestamp - 30));
        vm.expectRevert(UniswapV3TwapSource.TwapPoolNotUsable.selector);
        src.computePriceWad();
    }

    // --------------------------------------------------------------------------------------
    // constructor validation
    // --------------------------------------------------------------------------------------

    function test_constructorRejectsWindowOutOfBounds() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), -196267);
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        new UniswapV3TwapSource(
            address(weth),
            address(usdc),
            IUniswapV3PoolMinimal(address(pool)),
            IUniswapV3PoolMinimal(address(0)),
            299,
            MIN_CARD,
            MAX_OBS_AGE
        );
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        new UniswapV3TwapSource(
            address(weth),
            address(usdc),
            IUniswapV3PoolMinimal(address(pool)),
            IUniswapV3PoolMinimal(address(0)),
            1 days + 1,
            MIN_CARD,
            MAX_OBS_AGE
        );
    }

    function test_constructorRejectsAssetNotInPool() public {
        MockV3Pool pool = _healthyPool(address(cbeth), address(usdc), -196267);
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        _oneHop(address(weth), pool);
    }

    function test_constructorRejectsDirectPoolThatDoesNotQuoteUsdc() public {
        MockV3Pool pool = _healthyPool(address(weth), address(cbeth), 100);
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        _oneHop(address(weth), pool);
    }

    function test_constructorRejectsSecondPoolNotBridgingToUsdc() public {
        MockV3Pool poolA = _healthyPool(address(cbeth), address(weth), 862);
        MockV3Pool poolB = _healthyPool(address(weth), address(wbtc), 100); // wrong quote side
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        new UniswapV3TwapSource(
            address(cbeth),
            address(usdc),
            IUniswapV3PoolMinimal(address(poolA)),
            IUniswapV3PoolMinimal(address(poolB)),
            WINDOW,
            MIN_CARD,
            MAX_OBS_AGE
        );
    }

    /// The check most worth having: a pool that cannot serve its own window today is not
    /// deployable, rather than silently spot in production.
    function test_constructorRejectsPoolThatCannotServeWindowYet() public {
        MockV3Pool pool = new MockV3Pool(address(weth), address(usdc), 500);
        pool.setTick(-196267);
        pool.setRing(MIN_CARD, 40, uint32(block.timestamp - 60), uint32(block.timestamp - 30));
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        _oneHop(address(weth), pool);
    }

    function test_constructorRejectsSingleSlotPool() public {
        MockV3Pool pool = new MockV3Pool(address(weth), address(usdc), 500);
        pool.setTick(-196267);
        pool.setRing(1, 0, uint32(block.timestamp - 2 * WINDOW), uint32(block.timestamp - 30));
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        new UniswapV3TwapSource(
            address(weth),
            address(usdc),
            IUniswapV3PoolMinimal(address(pool)),
            IUniswapV3PoolMinimal(address(0)),
            WINDOW,
            1, // below MIN_CARDINALITY_FLOOR
            MAX_OBS_AGE
        );
    }

    function test_constructorRejectsBadAgeAndSameToken() public {
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), -196267);
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        new UniswapV3TwapSource(
            address(weth),
            address(usdc),
            IUniswapV3PoolMinimal(address(pool)),
            IUniswapV3PoolMinimal(address(0)),
            WINDOW,
            MIN_CARD,
            0
        );
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        new UniswapV3TwapSource(
            address(weth),
            address(usdc),
            IUniswapV3PoolMinimal(address(pool)),
            IUniswapV3PoolMinimal(address(0)),
            WINDOW,
            MIN_CARD,
            1 days + 1
        );
        MockV3Pool same = _healthyPool(address(usdc), address(usdc), 0);
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        _oneHop(address(usdc), same);
    }

    function test_constructorRejectsPoolWithoutCode() public {
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        new UniswapV3TwapSource(
            address(weth),
            address(usdc),
            IUniswapV3PoolMinimal(address(0xDEAD)),
            IUniswapV3PoolMinimal(address(0)),
            WINDOW,
            MIN_CARD,
            MAX_OBS_AGE
        );
    }

    // --------------------------------------------------------------------------------------
    // fuzz — tick conversion and quote ranges
    // --------------------------------------------------------------------------------------

    /// `getSqrtRatioAtTick` is strictly increasing across the entire tick range. A transposed
    /// or corrupted magic constant breaks monotonicity somewhere in the affected octave.
    function testFuzz_sqrtRatioStrictlyIncreasing(int256 rawTick) public pure {
        int24 t = int24(bound(rawTick, TickMath.MIN_TICK, TickMath.MAX_TICK - 1));
        assertLt(
            TickMath.getSqrtRatioAtTick(t), TickMath.getSqrtRatioAtTick(t + 1), "not strictly increasing"
        );
    }

    /// Every ratio in range stays inside the published endpoints.
    function testFuzz_sqrtRatioWithinCanonicalBounds(int256 rawTick) public pure {
        int24 t = int24(bound(rawTick, TickMath.MIN_TICK, TickMath.MAX_TICK));
        uint160 r = TickMath.getSqrtRatioAtTick(t);
        assertGe(r, TickMath.MIN_SQRT_RATIO);
        assertLe(r, TickMath.MAX_SQRT_RATIO);
    }

    /// Price is monotone in the mean tick, in the direction the token ordering implies. Uses a
    /// tick gap wide enough that the two branches' rounding cannot invert the comparison.
    function testFuzz_priceMonotoneInTick(int256 rawTick, uint16 gap, bool assetIsToken0) public {
        // Deliberately spans the 443637 branch crossover in both directions.
        int24 t = int24(bound(rawTick, -600000, 600000 - int256(uint256(gap)) - 1));
        int24 t2 = t + int24(int256(uint256(gap))) + 1;

        MockV3Pool poolLow = assetIsToken0
            ? _healthyPool(address(weth), address(usdc), t)
            : _healthyPool(address(usdc), address(weth), t);
        MockV3Pool poolHigh = assetIsToken0
            ? _healthyPool(address(weth), address(usdc), t2)
            : _healthyPool(address(usdc), address(weth), t2);

        (uint256 pLow,) = _oneHop(address(weth), poolLow).latestPrice();
        (uint256 pHigh,) = _oneHop(address(weth), poolHigh).latestPrice();

        if (assetIsToken0) {
            assertGe(pHigh, pLow, "token0 asset: price rises with tick");
        } else {
            assertLe(pHigh, pLow, "token1 asset: price falls with tick");
        }
    }

    /// The full read path never reverts, whatever the pool reports — it either prices or
    /// withholds. This is the property the aggregator's `try/catch` relies on and the reason
    /// the computation is wrapped in a self-call.
    function testFuzz_latestPriceNeverReverts(int256 rawTick, int64 rawCum, uint16 card, uint32 ageSeed)
        public
    {
        int24 t = int24(bound(rawTick, TickMath.MIN_TICK, TickMath.MAX_TICK));
        MockV3Pool pool = _healthyPool(address(weth), address(usdc), t);
        UniswapV3TwapSource src = _oneHop(address(weth), pool);

        uint32 age = uint32(bound(ageSeed, 0, 20 days));
        pool.setRing(
            uint16(bound(card, 1, type(uint16).max)),
            7,
            uint32(block.timestamp - bound(ageSeed, 0, 30 days)),
            uint32(block.timestamp - age)
        );
        pool.setRawCumulatives(0, int56(rawCum));

        (uint256 p, uint256 ts) = src.latestPrice();
        // Either a real price stamped now, or the not-fresh signal. Never anything else.
        if (p == 0) assertEq(ts, 0, "withholding must zero updatedAt");
        else assertEq(ts, block.timestamp, "a price must be stamped now");
    }

    // --------------------------------------------------------------------------------------
    // reference implementation (mirrors `_quote`, used only where a fixture is impractical)
    // --------------------------------------------------------------------------------------

    function _referencePrice(int24 tick, uint256 baseAmount, bool baseIsToken0, uint256 scale)
        internal
        pure
        returns (uint256)
    {
        uint160 s = TickMath.getSqrtRatioAtTick(tick);
        uint256 q;
        if (s <= type(uint128).max) {
            uint256 r = uint256(s) * s;
            q = baseIsToken0
                ? FullMath.mulDiv(r, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, r);
        } else {
            uint256 r = FullMath.mulDiv(s, s, 1 << 64);
            q = baseIsToken0
                ? FullMath.mulDiv(r, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, r);
        }
        return q * scale;
    }
}
