// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UniswapV3TwapSource, IUniswapV3PoolMinimal} from "../../src/oracle/UniswapV3TwapSource.sol";
import {TokenStub, FaithfulV3Pool} from "./AuditTwapSpotDegeneration.t.sol";

/// @notice AUDIT ARTIFACT — not a protocol test. **H-2 IS REMEDIATED.**
///
/// The three `test_finding_*` cases here proved the contamination law below and are preserved
/// as `test_remediated_*`: the same quiet-time scenarios now make the source WITHHOLD rather
/// than report a blended price as fresh. The exploits are in git history and in
/// docs/audit/AI-AUDIT-REPORT.md H-2.
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
    // H-2: maxObservationAge is no longer an independent knob — it may not exceed
    // window / MAX_LIVE_TICK_WEIGHT_DIVISOR, so 1800/20 = 90 is the loosest legal value here.
    uint32 constant MAX_OBS_AGE = 90;
    uint32 constant MAX_QUIET = 90; // == the live tick's 5% weight ceiling
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

    /// @notice H-2 FIXED. At half the window of quiet the source used to report a price
    /// half-composed of the live, single-block-movable tick — and stamp it FRESH. It now
    /// withholds, because 900s of quiet is 50% live-tick weight and the ceiling is 5%.
    function test_remediated_halfWindowQuietNowWithholdsInsteadOfBlending() public {
        UniswapV3TwapSource src = _deploySourceOver(pool);
        assertGt(src.computePriceWad(), 0, "healthy pool prices normally");

        vm.warp(block.timestamp + 900);
        pool.setLiveTick(MANIPULATED_TICK);

        (uint256 reported, uint256 updatedAt) = src.latestPrice();
        assertEq(reported, 0, "withholds instead of reporting a 50/50 blend");
        assertEq(updatedAt, 0, "and does not vote");

        vm.expectRevert(UniswapV3TwapSource.TwapPoolNotUsable.selector);
        src.computePriceWad();
    }

    /// @notice The contamination law itself is unchanged — it is a property of v3-core, not of
    /// this contract. What changed is that the reachable range is now bounded to 5%. At exactly
    /// the ceiling the source still prices, and the blend is exactly 5% live tick; one second
    /// past it, it withholds. This is the boundary the fix is built on, asserted rather than
    /// assumed.
    function test_remediated_contaminationIsBoundedToFivePercentOfTheWindow() public {
        UniswapV3TwapSource src = _deploySourceOver(pool);

        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + MAX_QUIET);
        pool.setLiveTick(MANIPULATED_TICK);
        uint256 reported = src.computePriceWad();

        int24 blended = int24(
            (int256(HISTORICAL_TICK)
                    * int256(uint256(WINDOW - MAX_QUIET))
                    + int256(MANIPULATED_TICK)
                    * int256(uint256(MAX_QUIET))) / int256(uint256(WINDOW))
        );
        assertApproxEqRel(reported, _honestTwapOf(blended), 1e15, "exactly 5% live-tick weight");
        vm.revertToState(snap);

        // One second past the ceiling: withheld.
        vm.warp(block.timestamp + MAX_QUIET + 1);
        pool.setLiveTick(MANIPULATED_TICK);
        vm.expectRevert(UniswapV3TwapSource.TwapPoolNotUsable.selector);
        src.computePriceWad();
    }

    /// @notice The naive remediation the audit tested and rejected — `newestTs younger than
    /// window` — would have passed a pool one second under the window while reporting a price
    /// almost entirely composed of the live tick. The shipped guard is a FRACTION of the window
    /// for exactly this reason, and it refuses that pool.
    function test_remediated_theNaiveWindowGuardWouldHaveLeakedButThisOneDoesNot() public {
        UniswapV3TwapSource src = _deploySourceOver(pool);

        vm.warp(block.timestamp + (WINDOW - 1)); // would PASS a "newest younger than window" guard
        pool.setLiveTick(MANIPULATED_TICK);

        vm.expectRevert(UniswapV3TwapSource.TwapPoolNotUsable.selector);
        src.computePriceWad();
    }

    /// @notice H-2's other half: a stale tick used to be stamped `block.timestamp`, so the
    /// aggregator's staleness bound could never reject it. `updatedAt` is now the age of the
    /// DATA — which is what makes the aggregator's bound apply to a TWAP leg at all.
    function test_remediated_updatedAtIsTheDataAgeNotTheReadTime() public {
        UniswapV3TwapSource src = _deploySourceOver(pool);
        vm.warp(block.timestamp + 60); // inside the 5% ceiling, so it still votes
        (uint256 p2, uint256 updatedAt) = src.latestPrice();
        assertGt(p2, 0, "still fresh enough to vote");
        assertEq(updatedAt, block.timestamp - 60, "reports the newest observation, not now");
        assertLt(updatedAt, block.timestamp, "strictly older than the read");
    }
}
