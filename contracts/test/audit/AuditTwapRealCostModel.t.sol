// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UniswapV3TwapSource, IUniswapV3PoolMinimal} from "../retired/UniswapV3TwapSource.sol";
import {TokenStub, FaithfulV3Pool} from "./AuditTwapSpotDegeneration.t.sol";

/// @notice AUDIT ARTIFACT — not a protocol test.
///
/// CORRECTION HARNESS. `AuditTwapSpotDegeneration` and `AuditTwapPartialQuiet` move the tick with
/// `setLiveTick()`, which models "the tick is here and nothing has traded since" but is NOT
/// reachable on a real pool: `slot0.tick` changes only inside `UniswapV3Pool.swap`, which calls
/// `observations.write(...)` stamping the PRE-swap tick at `block.timestamp`.
///
/// This file re-runs the attack using only FAITHFUL swaps, to establish what an attacker can
/// actually do. The governing quantity is
///
///     liveWeight = min(A, W) / W        where A = block.timestamp - newestObservation.timestamp
///
/// and the key fact is that **the attacker's own manipulating swap resets A to zero**. So an
/// attacker cannot manufacture contamination; they can only inherit it from a pool that is
/// already quiet, and then must hold the off-market tick, un-arbitraged, for A seconds to earn
/// weight A/W. That is the standard, intended TWAP cost model — not a bypass of it.
///
/// What remains a genuine defect is orthogonal to manipulation: the source stamps
/// `updatedAt = block.timestamp` (`src/oracle/UniswapV3TwapSource.sol:255`) no matter how large A
/// is, and the constructor never requires `maxObservationAge < window`
/// (`:165-239`, bounds checked independently at `:175` and `:177`). With the shipped
/// `base-mainnet.json` pair (window 1800, maxObservationAge 3600), A may reach 2x the window, so a
/// tick last traded 59 minutes ago is reported as a zero-seconds-old "30-minute TWAP".
contract AuditTwapRealCostModelTest is Test {
    uint32 constant WINDOW = 1800;
    // H-2: maxObservationAge may no longer exceed window / MAX_LIVE_TICK_WEIGHT_DIVISOR.
    uint32 constant MAX_OBS_AGE = 90;
    uint16 constant MIN_CARD = 30;

    int24 constant HISTORICAL_TICK = -198000; // ~$2500/ETH, asset = token0
    int24 constant MANIPULATED_TICK = -230000;

    TokenStub asset;
    TokenStub usdc;
    FaithfulV3Pool pool;

    function setUp() public {
        vm.warp(1_000_000);
        asset = new TokenStub(18);
        usdc = new TokenStub(6);
        pool = new FaithfulV3Pool(address(asset), address(usdc));
        pool.seedHistory(HISTORICAL_TICK, uint32(block.timestamp - 7200), uint32(block.timestamp), 60);
    }

    function _src(FaithfulV3Pool p) internal returns (UniswapV3TwapSource) {
        return new UniswapV3TwapSource(
            address(asset),
            address(usdc),
            IUniswapV3PoolMinimal(address(p)),
            IUniswapV3PoolMinimal(address(0)),
            WINDOW,
            MIN_CARD,
            MAX_OBS_AGE
        );
    }

    /// @notice THE CORRECTION: even on a pool quiet for LONGER than the window — the state the
    /// earlier tests called maximally vulnerable — a faithful manipulating swap moves the reported
    /// price by NOTHING in that block, because the swap stamps an observation at the pre-swap tick
    /// and resets A to zero.
    /// This correction stands unchanged in substance, but the pool must now be quiet by less
    /// than the 5% ceiling for the source to price at all - which is itself the H-2 fix. The
    /// property demonstrated is unaffected: a real swap stamps an observation at the PRE-swap
    /// tick and resets A to zero, so it has no same-block effect.
    function test_correction_faithfulSwapOnAQuietPoolHasZeroImmediateEffect() public {
        UniswapV3TwapSource src = _src(pool);
        vm.warp(block.timestamp + 60); // quiet, but inside the 5% live-tick ceiling
        uint256 beforeManip = src.computePriceWad();

        pool.swap(MANIPULATED_TICK); // a REAL swap, this block

        assertEq(src.computePriceWad(), beforeManip, "faithful swap: zero immediate effect");
    }

    /// @notice H-2 FIXED, the manipulation half: a pool quiet for LONGER than the window used
    /// to report a price composed ~entirely of the live tick. It now withholds outright, so an
    /// attacker cannot even inherit contamination from an already-quiet pool.
    function test_remediated_poolQuietBeyondTheCeilingWithholds() public {
        UniswapV3TwapSource src = _src(pool);
        vm.warp(block.timestamp + 2000); // quiet longer than WINDOW
        (uint256 pr, uint256 ts) = src.latestPrice();
        assertEq(pr, 0, "withholds");
        assertEq(ts, 0, "and does not vote");
    }

    // NOTE: a weight-accrual test was drafted here and REMOVED. Its harness produced a
    // non-monotone progression this audit could not fully explain, and unexplained numbers do not
    // belong in an audit artifact. The weight law itself is established exactly elsewhere, in
    // AuditTwapPartialQuiet.t.sol, where each reported price matches a genuine TWAP of the
    // correspondingly blended tick.

    /// @notice THE FINDING THAT SURVIVES: staleness misreported as freshness. No manipulation at
    /// all — the pool is simply quiet, and the source stamps a 59-minute-old tick as fresh.
    /// The aggregator's own staleness bound is structurally unable to reject it.
    /// @notice H-2 FIXED, the freshness-misreport half. The source used to stamp
    /// updatedAt = block.timestamp however old the underlying tick was, so a 3400-second-old
    /// tick was presented as zero seconds old and NO aggregator staleness bound - not even a
    /// 60-second one - could reject it. Two things now hold, and both are needed:
    ///   1. beyond the 5% ceiling the source withholds entirely; and
    ///   2. within it, updatedAt is the newest observation timestamp, so the aggregator own
    ///      bound governs the leg exactly as it governs a push feed.
    function test_remediated_staleTickWithholdsAndFreshOneReportsItsRealAge() public {
        UniswapV3TwapSource src = _src(pool);

        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + 3400); // far beyond the ceiling
        (uint256 p1, uint256 t1) = src.latestPrice();
        assertEq(p1, 0, "a 3400s-old tick is no longer offered as a price");
        assertEq(t1, 0, "and carries no timestamp");
        vm.revertToState(snap);

        // Inside the ceiling it votes, and it tells the truth about its age.
        vm.warp(block.timestamp + 60);
        (uint256 p2, uint256 t2) = src.latestPrice();
        assertGt(p2, 0, "still votes");
        assertEq(t2, block.timestamp - 60, "updatedAt is the age of the data");
        // The property that was structurally impossible before: a tight aggregator bound can
        // now actually reject this leg.
        assertLt(t2, block.timestamp - 30, "a 30s staleness bound WOULD now reject it");
    }

    /// @notice The root cause is a missing constructor cross-check: window and maxObservationAge
    /// are validated independently, so maxObservationAge may exceed window (the shipped config has
    /// exactly 2x), which is what lets A reach 100% live-tick weight while guard 3 still passes.
    /// @notice H-2 FIXED at the constructor - the root cause. window and maxObservationAge
    /// were validated INDEPENDENTLY, so the ceilings permitted maxObservationAge = 288x the
    /// window (window 300 with age 86400), and the SHIPPED config was already at 2x
    /// (1800/3600). That is what let A reach 100% live-tick weight while guard 3 still passed.
    /// The two are now bound to each other.
    function test_remediated_constructorRejectsMaxObsAgeAboveTheWindowFraction() public {
        FaithfulV3Pool p2 = new FaithfulV3Pool(address(asset), address(usdc));
        p2.seedHistory(HISTORICAL_TICK, uint32(block.timestamp - 7200), uint32(block.timestamp), 60);

        // The old 288x shape.
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        new UniswapV3TwapSource(
            address(asset),
            address(usdc),
            IUniswapV3PoolMinimal(address(p2)),
            IUniswapV3PoolMinimal(address(0)),
            300,
            MIN_CARD,
            86400
        );

        // The SHIPPED base-mainnet.json pair, 1800/3600 - also rejected. The config that was
        // deployment-ready is not constructible any more, which is exactly the point.
        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        new UniswapV3TwapSource(
            address(asset),
            address(usdc),
            IUniswapV3PoolMinimal(address(p2)),
            IUniswapV3PoolMinimal(address(0)),
            1800,
            MIN_CARD,
            3600
        );

        // 1800 / 20 = 90 is the loosest legal age at that window, and it is accepted.
        UniswapV3TwapSource ok = new UniswapV3TwapSource(
            address(asset),
            address(usdc),
            IUniswapV3PoolMinimal(address(p2)),
            IUniswapV3PoolMinimal(address(0)),
            1800,
            MIN_CARD,
            90
        );
        assertEq(ok.maxObservationAge(), 90, "5% of the window");
    }
}
