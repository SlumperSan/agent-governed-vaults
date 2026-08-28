// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UniswapV3TwapSource, IUniswapV3PoolMinimal} from "../../src/oracle/UniswapV3TwapSource.sol";

/// @notice Minimal ERC20 with settable decimals (the TWAP source only reads `decimals()`).
contract TokenStub {
    uint8 public decimals;

    constructor(uint8 d) {
        decimals = d;
    }
}

/// @notice A Uniswap V3 pool mock that reproduces the REAL `Oracle.observe` semantics from
/// v3-core, rather than the linear `tick * t` model used by the repo's own
/// `test/mocks/OracleSourceMocks.sol`. The distinction is the whole point of this test: the
/// repo's mock synthesizes cumulatives from the LIVE tick unconditionally, so under it a
/// correct historical TWAP and a live-tick extrapolation are numerically identical and no test
/// can tell them apart.
///
/// Faithful behaviours reproduced here:
///  - `transform(last, target, tick)` extrapolates a cumulative forward using the CURRENT tick;
///  - `getSurroundingObservations` returns `(newest, transform(newest, target, tick))` whenever
///    the newest stored observation is at or before the target timestamp;
///  - genuine interpolation between two stored observations otherwise.
contract FaithfulV3Pool {
    struct Obs {
        uint32 blockTimestamp;
        int56 tickCumulative;
        bool initialized;
    }

    address public token0;
    address public token1;
    uint24 public fee = 500;

    int24 public tick; // the LIVE tick (what a swap in this block moves)
    uint16 public observationIndex;
    uint16 public observationCardinality;
    Obs[] public obsRing;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    /// @notice Write a linear history at `historicalTick` covering `[startTs, endTs]`, one
    /// observation every `step` seconds. After this the pool has "stopped trading" at `endTs`.
    function seedHistory(int24 historicalTick, uint32 startTs, uint32 endTs, uint32 step) external {
        delete obsRing;
        int56 cum = 0;
        uint32 t = startTs;
        obsRing.push(Obs(t, cum, true));
        while (t + step <= endTs) {
            cum += int56(historicalTick) * int56(uint56(step));
            t += step;
            obsRing.push(Obs(t, cum, true));
        }
        observationIndex = uint16(obsRing.length - 1);
        observationCardinality = uint16(obsRing.length);
        tick = historicalTick;
    }

    /// @notice Move the live tick WITHOUT writing an observation. This models the pool state
    /// "the tick is here and nothing has traded since the newest observation" — it is NOT a
    /// swap. Use `swap()` for a faithful swap.
    function setLiveTick(int24 t) external {
        tick = t;
    }

    /// @notice A faithful swap. v3-core's `UniswapV3Pool.swap` writes the observation with
    /// `slot0Start.tick` — the tick BEFORE the swap — and only when the tick actually moves,
    /// and only once per block. This is what makes an ATOMIC manipulation impossible: the
    /// manipulating swap stamps the pre-swap tick and simultaneously closes the staleness gap
    /// the attack depends on.
    function swap(int24 newTick) external {
        uint32 nowTs = uint32(block.timestamp);
        Obs memory last = obsRing[observationIndex];
        if (newTick != tick && last.blockTimestamp != nowTs) {
            obsRing.push(_transform(last, nowTs)); // stamped with the PRE-swap tick
            observationIndex = uint16(obsRing.length - 1);
            observationCardinality = uint16(obsRing.length);
        }
        tick = newTick;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, tick, observationIndex, observationCardinality, observationCardinality, 0, true);
    }

    function observations(uint256 index) external view returns (uint32, int56, uint160, bool) {
        if (index >= obsRing.length) return (0, 0, 0, false);
        Obs memory o = obsRing[index];
        return (o.blockTimestamp, o.tickCumulative, 0, o.initialized);
    }

    function _transform(Obs memory last, uint32 target) internal view returns (Obs memory) {
        uint32 delta = target - last.blockTimestamp;
        return Obs(target, last.tickCumulative + int56(tick) * int56(uint56(delta)), true);
    }

    /// @dev Faithful port of v3-core `Oracle.observeSingle`.
    function _observeSingle(uint32 time, uint32 secondsAgo) internal view returns (int56) {
        Obs memory newest = obsRing[observationIndex];
        if (secondsAgo == 0) {
            if (newest.blockTimestamp != time) newest = _transform(newest, time);
            return newest.tickCumulative;
        }
        uint32 target = time - secondsAgo;

        // v3-core: if the newest observation is at or before the target, the "atOrAfter"
        // endpoint is SYNTHESIZED from the newest observation using the CURRENT tick.
        if (newest.blockTimestamp <= target) {
            if (newest.blockTimestamp == target) return newest.tickCumulative;
            return _transform(newest, target).tickCumulative;
        }

        Obs memory oldest = obsRing[0];
        require(oldest.blockTimestamp <= target, "OLD");

        // Genuine interpolation between the two surrounding stored observations.
        for (uint256 i = obsRing.length; i > 0; --i) {
            Obs memory beforeOrAt = obsRing[i - 1];
            if (beforeOrAt.blockTimestamp <= target) {
                if (beforeOrAt.blockTimestamp == target) return beforeOrAt.tickCumulative;
                Obs memory atOrAfter = obsRing[i];
                uint32 obsDelta = atOrAfter.blockTimestamp - beforeOrAt.blockTimestamp;
                uint32 targetDelta = target - beforeOrAt.blockTimestamp;
                return beforeOrAt.tickCumulative
                    + ((atOrAfter.tickCumulative - beforeOrAt.tickCumulative) / int56(uint56(obsDelta)))
                    * int56(uint56(targetDelta));
            }
        }
        revert("OLD");
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory sl)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        sl = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            tickCumulatives[i] = _observeSingle(uint32(block.timestamp), secondsAgos[i]);
        }
    }
}

/// @notice AUDIT ARTIFACT — not a protocol test. Demonstrates that
/// `UniswapV3TwapSource._meanTick`'s guard 2 does not do what its NatSpec claims, and that the
/// production parameter set in `config/base-mainnet.json` (window 1800s, maxObservationAge
/// 3600s) admits a reachable state in which the "TWAP" is exactly the live, single-block
/// tick.
contract AuditTwapSpotDegenerationTest is Test {
    uint32 constant WINDOW = 1800; // base-mainnet.json twapDefaults.windowSeconds
    // H-2: bound to window / MAX_LIVE_TICK_WEIGHT_DIVISOR (1800/20). The old value, 3600,
    // was the shipped base-mainnet.json figure and is no longer constructible.
    uint32 constant MAX_OBS_AGE = 90;
    uint16 constant MIN_CARD = 30;

    int24 constant HISTORICAL_TICK = -198000; // ~ $2500/ETH with asset = token0
    int24 constant MANIPULATED_TICK = -230000; // pushed down ~96% in one block

    TokenStub asset;
    TokenStub usdc;
    FaithfulV3Pool pool;

    function setUp() public {
        vm.warp(1_000_000);
        asset = new TokenStub(18);
        usdc = new TokenStub(6);
        pool = new FaithfulV3Pool(address(asset), address(usdc));
        // 2 hours of history at one observation per 60s, ending "now".
        pool.seedHistory(HISTORICAL_TICK, uint32(block.timestamp - 7200), uint32(block.timestamp), 60);
    }

    function _deploySource() internal returns (UniswapV3TwapSource) {
        return new UniswapV3TwapSource(
            address(asset),
            address(usdc),
            IUniswapV3PoolMinimal(address(pool)),
            IUniswapV3PoolMinimal(address(0)),
            WINDOW,
            MIN_CARD,
            MAX_OBS_AGE
        );
    }

    /// @notice CONTROL: while the pool is actively trading (newest observation inside the
    /// window), the source behaves as advertised — moving the live tick does NOT move the
    /// reported price, because both `observe` endpoints come from recorded history.
    function test_control_activePool_liveTickDoesNotMovePrice() public {
        UniswapV3TwapSource src = _deploySource();
        uint256 before = src.computePriceWad();

        pool.setLiveTick(MANIPULATED_TICK); // a swap this block
        uint256 afterManipulation = src.computePriceWad();

        assertEq(afterManipulation, before, "active pool: live tick must not move the TWAP");
    }

    /// @notice REFUTATION, recorded deliberately: the manipulation is NOT atomic. A swap that
    /// moves the tick writes an observation stamped with the PRE-swap tick and closes the
    /// staleness gap in the same call, so within the manipulating block the mean tick is still
    /// the honest pre-swap tick. Any claim of a flash-loan-atomic TWAP manipulation here is
    /// false, and this test pins that.
    function test_refuted_atomicSwapCannotMoveTheTwapInTheSameBlock() public {
        UniswapV3TwapSource src = _deploySource();
        // Quiet, but inside the 5% ceiling so the source still prices. The refutation is
        // about the SWAP being non-atomic, and is unaffected by how quiet the pool was.
        vm.warp(block.timestamp + 60);
        uint256 honest = src.computePriceWad();

        pool.swap(MANIPULATED_TICK); // a real swap, this block

        assertEq(src.computePriceWad(), honest, "atomic swap does NOT move the reported TWAP");
    }

    /// @notice THE FINDING: once the pool has been quiet for longer than `window` — but still
    /// within `maxObservationAge`, so guard 3 passes — every `observe` endpoint is synthesized
    /// from the same stored observation using the CURRENT tick. The cumulative delta is
    /// exactly `currentTick * window`, so the arithmetic-mean tick IS the live tick.
    ///
    /// Reachability (see the report): this is NOT flash-loanable. The state it needs is "the
    /// tick sits at X and nothing has traded for >= window seconds", which arises when (a) the
    /// pool is creator-controlled or dead, so holding a chosen tick is free; (b) an attacker
    /// holds an off-market tick on a live pool for `window` seconds against arbitrage; or
    /// (c) an honest pool simply goes quiet, in which case the value returned is a STALE spot
    /// tick — up to `maxObservationAge` old — reported as fresh.
    /// @notice H-2 FIXED. Everything above the ceiling is now refused outright, so the
    /// collapse this test used to demonstrate is unreachable: the source withholds rather
    /// than reporting a live tick as a 30-minute average. The reachability analysis in the
    /// old comment still stands as the reason the fix had to bound the FRACTION rather than
    /// merely compare against the window.
    function test_remediated_quietPoolWithholdsInsteadOfCollapsingToTheLiveTick() public {
        UniswapV3TwapSource src = _deploySource();
        assertGt(src.computePriceWad(), 0, "healthy pool prices");

        // Pool goes quiet for 2000s - the state that used to yield a 100%-live-tick "TWAP",
        // reported as zero seconds old.
        vm.warp(block.timestamp + 2000);

        (uint256 pQuiet, uint256 updatedAt) = src.latestPrice();
        assertEq(pQuiet, 0, "withholds rather than reporting a live tick as an average");
        assertEq(updatedAt, 0, "and casts no vote at the aggregator");

        // Manipulating the live tick changes nothing, because nothing is being reported.
        pool.setLiveTick(MANIPULATED_TICK);
        (uint256 pManipulated,) = src.latestPrice();
        assertEq(pManipulated, 0, "still withheld; the collapse is unreachable");

        vm.expectRevert(UniswapV3TwapSource.TwapPoolNotUsable.selector);
        src.computePriceWad();
    }

    /// @notice H-2 FIXED, as a property over every tick an attacker could choose. This used
    /// to assert that a quiet pool reported EXACTLY the live tick - the window contributing
    /// nothing whatsoever. It now asserts the complement: for any tick, a pool quiet past the
    /// ceiling reports nothing at all.
    function testFuzz_quietPool_withholdsForEveryLiveTick(int24 liveTick) public {
        liveTick = int24(bound(int256(liveTick), -600000, 600000));

        UniswapV3TwapSource src = _deploySource();
        vm.warp(block.timestamp + 2000); // quiet past the 5% ceiling

        pool.setLiveTick(liveTick);
        (uint256 pr, uint256 ts) = src.latestPrice();
        assertEq(pr, 0, "no price is offered, whatever the live tick");
        assertEq(ts, 0, "and no timestamp");
    }

    /// @notice The complementary bound: INSIDE the ceiling the source still prices, and the
    /// live tick contributes at most 5%. A fix that simply withheld everywhere would pass the
    /// test above and be useless, so the useful half is asserted too.
    function test_remediated_insideTheCeilingTheSourceStillPricesWithBoundedInfluence() public {
        UniswapV3TwapSource src = _deploySource();
        uint256 honest = src.computePriceWad();

        vm.warp(block.timestamp + 90); // exactly the ceiling
        pool.setLiveTick(MANIPULATED_TICK);
        uint256 reported = src.computePriceWad();

        assertGt(reported, 0, "still prices inside the ceiling");
        // The manipulated tick is far below the honest one, so bounded influence means the
        // reported price stays within a few percent of honest rather than collapsing.
        assertGt(reported, honest * 80 / 100, "live tick moved the price by a bounded amount");
        assertLt(reported, honest, "but it did move it - the 5% is real, not zero");
    }
}
