// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UniswapV3TwapSource, IUniswapV3PoolMinimal} from "../../src/oracle/UniswapV3TwapSource.sol";
import {TokenStub, FaithfulV3Pool} from "./AuditTwapSpotDegeneration.t.sol";

/// @notice AUDIT ARTIFACT — not a protocol test.
///
/// Extends `AuditTwapSpotDegeneration` with the PARTIAL case, which is the one that determines
/// how the finding must actually be remediated.
///
/// `_meanTick` calls `observe([window, 0])`. In v3-core:
///   - the `secondsAgo = 0` endpoint ALWAYS extrapolates from the newest stored observation at
///     the CURRENT tick, over `(now - newestTs)`;
///   - the `secondsAgo = window` endpoint interpolates from recorded history so long as
///     `newestTs > now - window`.
/// So the live tick's weight in the reported mean is `(now - newestTs) / window` — a CONTINUOUS
/// function of quiet time that is non-zero from the very first second of quiet, not a cliff at
/// `window`.
///
/// Consequences, both of which matter for the report:
///  1. Reachability is far broader than "quiet >= window". A pool that has simply not traded for
///     900 seconds on a 1800-second window already reports a price half-composed of the live,
///     single-block-manipulable tick. On a secondary Base pool that needs no attacker at all.
///  2. The obvious fix — `require(block.timestamp - newestTs < window)` — only caps the live
///     weight strictly below 1. It does NOT close the hole. Bounding the newest-observation age
///     to a small fraction of the window is what bounds the contamination.
contract AuditTwapPartialQuietTest is Test {
    uint32 constant WINDOW = 1800; // base-mainnet.json twapDefaults.windowSeconds
    uint32 constant MAX_OBS_AGE = 3600; // base-mainnet.json twapDefaults.maxObservationAgeSeconds
    uint16 constant MIN_CARD = 30;

    int24 constant HISTORICAL_TICK = -198000; // ~ $2500/ETH with asset = token0
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

    function _deploySourceOver(FaithfulV3Pool p) internal returns (UniswapV3TwapSource) {
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

    /// @notice A reference source over a pool that genuinely traded at `tick` for its whole
    /// history — i.e. the price a HONEST TWAP of `tick` would report.
    function _honestTwapOf(int24 tick) internal returns (uint256) {
        FaithfulV3Pool ref = new FaithfulV3Pool(address(asset), address(usdc));
        ref.seedHistory(tick, uint32(block.timestamp - 7200), uint32(block.timestamp), 60);
        return _deploySourceOver(ref).computePriceWad();
    }

    /// @notice THE POINT: at HALF the window of quiet, the reported "30-minute TWAP" is the
    /// arithmetic mean of the honest tick and the attacker's live tick, weighted 50/50 — exactly
    /// the blended tick, to the wei. Both freshness guards pass and the source reports FRESH.
    function test_finding_halfWindowQuiet_livesTickGetsHalfWeight() public {
        UniswapV3TwapSource src = _deploySourceOver(pool);
        uint256 honest = src.computePriceWad();

        // Quiet for exactly half the window — far inside maxObservationAge, and BELOW `window`,
        // so the remediation "newest observation younger than window" would still permit this.
        vm.warp(block.timestamp + 900);
        pool.setLiveTick(MANIPULATED_TICK);

        (uint256 reported, uint256 updatedAt) = src.latestPrice();
        assertEq(updatedAt, block.timestamp, "still reported FRESH");

        // Predicted mean tick = (hist*900 + live*900)/1800 = the midpoint tick.
        int24 blended = (HISTORICAL_TICK + MANIPULATED_TICK) / 2;
        assertEq(reported, _honestTwapOf(blended), "reported price == TWAP of the blended tick");

        // And that is a very large move for a source advertised as a 30-minute average.
        assertLt(reported, honest / 2, "half-window quiet already halves the reported price");

        emit log_named_uint("honest TWAP (WAD)", honest);
        emit log_named_uint("after 900s quiet + 1-block manipulation (WAD)", reported);
    }

    /// @notice The live-tick weight is (now - newestTs)/window, continuous from the first second
    /// of quiet. Demonstrated at 1/6, 1/3, 1/2, 2/3 of the window: the reported price is strictly
    /// monotone in quiet time and always equals the TWAP of the correspondingly blended tick.
    function test_finding_contaminationIsContinuousInQuietTime() public {
        uint32[4] memory quiets = [uint32(300), 600, 900, 1200];
        uint256 previous = type(uint256).max;

        for (uint256 i; i < quiets.length; ++i) {
            uint256 snap = vm.snapshotState();

            UniswapV3TwapSource src = _deploySourceOver(pool);
            vm.warp(block.timestamp + quiets[i]);
            pool.setLiveTick(MANIPULATED_TICK);
            uint256 reported = src.computePriceWad();

            int24 blended = int24(
                (int256(HISTORICAL_TICK)
                        * int256(uint256(WINDOW - quiets[i]))
                        + int256(MANIPULATED_TICK)
                        * int256(uint256(quiets[i]))) / int256(uint256(WINDOW))
            );
            // 1e15 = 0.1%: `blended` is computed with integer tick division, so it can differ
            // from the exact weighted tick by up to one tick (=1bp) before pricing.
            assertApproxEqRel(reported, _honestTwapOf(blended), 1e15, "weight is quiet/window");
            assertLt(reported, previous, "more quiet => more contamination, monotone");
            previous = reported;

            vm.revertToState(snap);
        }
    }

    /// @notice Therefore the naive remediation is INSUFFICIENT. Even under a hypothetical guard
    /// `block.timestamp - newestTs < window`, a pool one second under that bound reports a price
    /// almost entirely composed of the live tick.
    function test_finding_newestYoungerThanWindowGuardWouldStillLeak() public {
        UniswapV3TwapSource src = _deploySourceOver(pool);
        uint256 honest = src.computePriceWad();

        vm.warp(block.timestamp + (WINDOW - 1)); // would PASS a `newest younger than window` guard
        pool.setLiveTick(MANIPULATED_TICK);

        uint256 reported = src.computePriceWad();
        uint256 fullySpot = _honestTwapOf(MANIPULATED_TICK);

        // Within a hair of the pure spot price, despite the hypothetical guard passing.
        assertApproxEqRel(reported, fullySpot, 5e15, "price is ~the manipulated spot price");
        assertLt(reported, honest / 10, "guard would still permit a >90% error");
    }
}
