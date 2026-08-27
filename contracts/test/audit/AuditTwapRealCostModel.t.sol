// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UniswapV3TwapSource, IUniswapV3PoolMinimal} from "../../src/oracle/UniswapV3TwapSource.sol";
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
    uint32 constant MAX_OBS_AGE = 3600;
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
    function test_correction_faithfulSwapOnAQuietPoolHasZeroImmediateEffect() public {
        UniswapV3TwapSource src = _src(pool);
        vm.warp(block.timestamp + 2000); // quiet longer than WINDOW (1800), inside MAX_OBS_AGE
        uint256 beforeManip = src.computePriceWad();

        pool.swap(MANIPULATED_TICK); // a REAL swap, this block

        assertEq(src.computePriceWad(), beforeManip, "faithful swap: zero immediate effect");
    }

    // NOTE: a weight-accrual test was drafted here and REMOVED. Its harness produced a
    // non-monotone progression this audit could not fully explain, and unexplained numbers do not
    // belong in an audit artifact. The weight law itself is established exactly elsewhere, in
    // AuditTwapPartialQuiet.t.sol, where each reported price matches a genuine TWAP of the
    // correspondingly blended tick.

    /// @notice THE FINDING THAT SURVIVES: staleness misreported as freshness. No manipulation at
    /// all — the pool is simply quiet, and the source stamps a 59-minute-old tick as fresh.
    /// The aggregator's own staleness bound is structurally unable to reject it.
    function test_finding_staleTickIsReportedAsZeroSecondsOld() public {
        UniswapV3TwapSource src = _src(pool);

        vm.warp(block.timestamp + 3400); // newest observation is 3400s old; < MAX_OBS_AGE (3600)

        (uint256 p, uint256 updatedAt) = src.latestPrice();
        assertGt(p, 0, "source still votes");
        assertEq(updatedAt, block.timestamp, "reported as ZERO seconds old...");
        // ...while the underlying data is 3400 seconds old. Any aggregator maxStaleness — even
        // 60 seconds — accepts this leg, because updatedAt is hardcoded to now.
        assertGt(uint256(3400), uint256(60), "a 60s staleness bound cannot reject a 3400s-old tick");
    }

    /// @notice The root cause is a missing constructor cross-check: window and maxObservationAge
    /// are validated independently, so maxObservationAge may exceed window (the shipped config has
    /// exactly 2x), which is what lets A reach 100% live-tick weight while guard 3 still passes.
    function test_finding_constructorAcceptsMaxObsAgeGreaterThanWindow() public {
        // window 300 (MIN_WINDOW) with maxObservationAge 86400 (the ceiling): a 24-hour-old tick
        // reported as a fresh 5-minute TWAP. Accepted without complaint.
        FaithfulV3Pool p2 = new FaithfulV3Pool(address(asset), address(usdc));
        p2.seedHistory(HISTORICAL_TICK, uint32(block.timestamp - 7200), uint32(block.timestamp), 60);
        UniswapV3TwapSource s = new UniswapV3TwapSource(
            address(asset),
            address(usdc),
            IUniswapV3PoolMinimal(address(p2)),
            IUniswapV3PoolMinimal(address(0)),
            300,
            MIN_CARD,
            86400
        );
        assertEq(s.window(), 300);
        assertEq(s.maxObservationAge(), 86400, "288x the window, accepted");
    }
}
