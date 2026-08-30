// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleAggregator, ChainlinkSourceAdapter} from "./retired/OracleAggregator.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {UniswapV3TwapSource, IUniswapV3PoolMinimal} from "./retired/UniswapV3TwapSource.sol";
import {PythSource, IPyth} from "./retired/PythSource.sol";
import {MockV3Pool, MockPyth, MockAggregatorV3} from "./mocks/OracleSourceMocks.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// Sprint 11 — integration of the SF-1 **mechanism classes** behind the `OracleAggregator`:
///
///   1. push       — `ChainlinkSourceAdapter` over an AggregatorV3 feed
///   2. spot TWAP  — `UniswapV3TwapSource` over a V3 pool
///   3. pull       — `PythSource` over a Pyth price id
///
/// **This file was restructured by the H-1 remediation, and the reason matters more than the
/// diff.** It previously pinned the configuration `base-mainnet.json` drafted and DEPLOYMENT.md
/// §2 prescribed: three sources, quorum 2. Four of its tests asserted that any ONE class going
/// dark left the breaker un-tripped while "the other two hold" — which is true, and was the
/// wrong thing to be reassured by. At two fresh sources the aggregator's lower median
/// `fresh[(k-1)/2]` is `fresh[0]`, the **minimum**. So every one of those tests was asserting
/// that a single failure silently converts the price feed into a one-directional downward
/// selector, which is the exploitable direction for share issuance (C-4).
///
/// The old file even contained the tradeoff in words — *"quorum 2 is … the largest value that
/// tolerates a failure: at quorum 3 a single dark source would freeze the asset"* — having
/// noticed the redundancy cost and missed that the aggregation FUNCTION changes underneath it.
///
/// The resolution is not a smaller quorum, it is **more sources**: at m = 5 / quorum = 3 the
/// stack tolerates two failures AND always takes a real median. That is what this file now
/// pins, and what `base-mainnet.json` must become before any deployment.
contract MixedOracleSourcesTest is Test {
    uint32 constant WINDOW = 1800;
    uint16 constant MIN_CARD = 100;
    uint32 constant MAX_OBS_AGE = 90; // H-2: <= WINDOW / MAX_LIVE_TICK_WEIGHT_DIVISOR (1800/20)
    uint32 constant MAX_STALENESS = 1 hours;

    bytes32 constant ETH_USD =
        bytes32(uint256(0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace));

    MockERC20 weth;
    MockERC20 usdc;

    MockAggregatorV3 feed;
    MockAggregatorV3 feed2;
    MockAggregatorV3 feed3;
    MockV3Pool pool;
    MockPyth pyth;

    ChainlinkSourceAdapter chainlinkSource;
    ChainlinkSourceAdapter pushSource2;
    ChainlinkSourceAdapter pushSource3;
    UniswapV3TwapSource twapSource;
    PythSource pythSource;

    OracleAggregator oracle;
    address asset;

    // Every source quotes a deliberately different price, so which one the median picked is
    // never ambiguous.
    uint256 constant TWAP_PRICE = 2996806154000000000000; // $2996.806154, tick -196267
    uint256 constant PUSH2_PRICE = 2999e18; // $2999.00
    uint256 constant CHAINLINK_PRICE = 3000e18; // $3000.00, 8-decimal feed
    uint256 constant PYTH_PRICE = 3001e18; // $3001.00, expo -8
    uint256 constant PUSH3_PRICE = 3002e18; // $3002.00

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockERC20("WETH", 18);
        usdc = new MockERC20("USDC", 6);
        asset = address(weth);

        // (1) push
        feed = new MockAggregatorV3(8, 3000e8, block.timestamp);
        chainlinkSource = new ChainlinkSourceAdapter(IAggregatorV3(address(feed)));

        // (2) spot TWAP — Base's WETH/USDC ordering, so a negative tick
        pool = new MockV3Pool(address(weth), address(usdc), 500);
        pool.setTick(-196267);
        pool.setRing(MIN_CARD, 40, uint32(block.timestamp - 2 * WINDOW), uint32(block.timestamp - 30));
        twapSource = new UniswapV3TwapSource(
            address(weth),
            address(usdc),
            IUniswapV3PoolMinimal(address(pool)),
            IUniswapV3PoolMinimal(address(0)),
            WINDOW,
            MIN_CARD,
            MAX_OBS_AGE
        );

        // (3) pull
        pyth = new MockPyth(300100000000, 100000000, -8, block.timestamp - 30);
        pythSource = new PythSource(IPyth(address(pyth)), ETH_USD, 100);

        // (4)(5) two further INDEPENDENTLY OPERATED push feeds. Same mechanism class as (1),
        // different operators — which is the axis H-1 forces: mechanism diversity alone cannot
        // reach m >= 5 with only three classes implemented, so operator diversity carries the
        // rest. SF-1's requirement is that no single failure is shared, not that all five
        // mechanisms differ.
        feed2 = new MockAggregatorV3(8, 2999e8, block.timestamp);
        pushSource2 = new ChainlinkSourceAdapter(IAggregatorV3(address(feed2)));
        feed3 = new MockAggregatorV3(8, 3002e8, block.timestamp);
        pushSource3 = new ChainlinkSourceAdapter(IAggregatorV3(address(feed3)));

        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](5);
        sources[0][0] = address(chainlinkSource);
        sources[0][1] = address(twapSource);
        sources[0][2] = address(pythSource);
        sources[0][3] = address(pushSource2);
        sources[0][4] = address(pushSource3);
        uint32[] memory stale = new uint32[](1);
        stale[0] = MAX_STALENESS;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 3; // MIN_MEDIAN, and two failures of headroom at m = 5
        oracle = new OracleAggregator(assets, sources, stale, quorum);
    }

    // --------------------------------------------------------------------------------------
    // the three classes agree on units
    // --------------------------------------------------------------------------------------

    /// Three adapters written against three different upstream shapes — an 8-decimal int256
    /// answer, a Q64.96 tick over 6- and 18-decimal tokens, and an int64 mantissa with an
    /// exponent — must land within a fraction of a percent of each other in WAD. A units bug
    /// in any one of them shows up here as an order-of-magnitude gap, not a rounding gap.
    function test_allThreeClassesQuoteTheSameAssetInComparableWad() public view {
        (uint256 cl,) = chainlinkSource.latestPrice();
        (uint256 tw,) = twapSource.latestPrice();
        (uint256 py,) = pythSource.latestPrice();

        assertEq(cl, CHAINLINK_PRICE, "chainlink leg");
        assertEq(tw, TWAP_PRICE, "twap leg");
        assertEq(py, PYTH_PRICE, "pyth leg");

        // Pairwise spread under 0.2%.
        uint256 lo = tw;
        uint256 hi = py;
        assertLt((hi - lo) * 10_000 / lo, 20, "classes disagree by more than 20 bps");
    }

    /// The full stack: quorum reached, lower median of five is the middle value.
    function test_mixedSourcesReachQuorumAndMedian() public view {
        assertEq(oracle.priceWad(asset), CHAINLINK_PRICE, "median of five");
    }

    /// The shape the aggregator's floors now accept: 5 sources, quorum 3 — a strict majority,
    /// at least MIN_MEDIAN, and two sources of headroom.
    function test_configurationSatisfiesBothMedianIntegrityAndHeadroom() public view {
        (address[] memory srcs, uint32 stale, uint8 q) = oracle.assetConfig(asset);
        assertEq(srcs.length, 5, "m = 5");
        assertEq(q, 3, "quorum 3");
        assertEq(stale, MAX_STALENESS);
        assertGt(q, srcs.length / 2, "strict majority");
        assertGe(q, oracle.MIN_MEDIAN(), "H-1: never fewer than three fresh sources");
        assertLt(q, srcs.length, "headroom: a failure must not freeze the asset");
        // The property the old 3-source shape could not have: BOTH at once.
        assertEq(srcs.length - q, 2, "two failures of headroom");
    }

    /// H-1 REMEDIATED, stated as a constructor property: the previously-shipped shape — three
    /// sources, quorum 2 — is no longer constructible, because its "median" was a minimum.
    function test_remediated_theOldThreeSourceQuorumTwoShapeIsRejected() public {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](3);
        sources[0][0] = address(chainlinkSource);
        sources[0][1] = address(twapSource);
        sources[0][2] = address(pythSource);
        uint32[] memory stale = new uint32[](1);
        stale[0] = MAX_STALENESS;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 2; // the old base-mainnet.json value
        vm.expectRevert(OracleAggregator.BadOracleConfig.selector);
        new OracleAggregator(assets, sources, stale, quorum);
    }

    // --------------------------------------------------------------------------------------
    // one class dark — the breaker must NOT trip, and the price stays a real median
    // --------------------------------------------------------------------------------------

    /// The TWAP class goes dark because its pool stopped trading. This is the scenario the
    /// source's freshness guards exist for: without them it would keep voting a one-block
    /// spot price forever. With them it withholds, and four sources still hold quorum.
    function test_twapClassDarkDoesNotTripBreaker() public {
        pool.setRing(MIN_CARD, 40, uint32(block.timestamp - 10 days), uint32(block.timestamp - 10 days));
        (uint256 tw,) = twapSource.latestPrice();
        assertEq(tw, 0, "quiet pool must withhold");

        // Fresh set {2999, 3000, 3001, 3002}; lower median of four is index 1.
        assertEq(oracle.priceWad(asset), CHAINLINK_PRICE, "quorum holds on 4 of 5");
    }

    /// The pull class goes dark because no keeper posted an update inside `maxStaleness`.
    function test_pythClassDarkDoesNotTripBreaker() public {
        pyth.set(300100000000, 100000000, -8, block.timestamp - MAX_STALENESS - 1);
        // {2996.8, 2999, 3000, 3002} -> index 1
        assertEq(oracle.priceWad(asset), PUSH2_PRICE, "quorum holds on 4 of 5");
    }

    /// The push class goes dark on a non-positive answer (its documented `(0, 0)` convention).
    function test_chainlinkClassDarkDoesNotTripBreaker() public {
        feed.set(-1, block.timestamp);
        // {2996.8, 2999, 3001, 3002} -> index 1
        assertEq(oracle.priceWad(asset), PUSH2_PRICE, "quorum holds on 4 of 5");
    }

    /// A source that reverts outright is likewise absorbed — by the aggregator's bounded
    /// staticcall for Chainlink, and by the adapters' own containment for the other two.
    function test_revertingSourcesAreAbsorbedNotPropagated() public {
        feed.setReverts(true);
        assertEq(oracle.priceWad(asset), PUSH2_PRICE, "reverting feed is merely not-fresh");

        feed.setReverts(false);
        pool.setObserveReverts(true);
        assertEq(oracle.priceWad(asset), CHAINLINK_PRICE, "reverting pool is merely not-fresh");
    }

    /// Two dark still prices, and — the property H-1 is about — still takes a genuine median
    /// of three rather than the minimum of two.
    function test_twoSourcesDarkStillTakesARealMedian() public {
        feed.set(-1, block.timestamp); // push (1) dark
        pyth.setReverts(true); // pull dark
        // Fresh set {2996.8, 2999, 3002} -> true middle
        assertEq(oracle.priceWad(asset), PUSH2_PRICE, "median of the surviving three");
    }

    // --------------------------------------------------------------------------------------
    // three dark — the breaker must trip (K-4, deliberately)
    // --------------------------------------------------------------------------------------

    function test_threeSourcesDarkTripsBreaker() public {
        feed.set(-1, block.timestamp);
        pool.setRing(MIN_CARD, 40, uint32(block.timestamp - 10 days), uint32(block.timestamp - 10 days));
        pyth.setReverts(true);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        oracle.priceWad(asset);
    }

    /// No ordering of failures is privileged — any three dark trips it.
    function test_everyTripleOfDarkSourcesTripsBreaker() public {
        // push(1) + pull + push(2)
        feed.set(-1, block.timestamp);
        pyth.setReverts(true);
        feed2.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        oracle.priceWad(asset);

        // pull + twap + push(3)
        feed.set(3000e8, block.timestamp);
        feed2.set(2999e8, block.timestamp);
        pool.setObserveReverts(true);
        feed3.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        oracle.priceWad(asset);
    }

    // --------------------------------------------------------------------------------------
    // the configuration trap this stack is most likely to be mis-deployed into
    // --------------------------------------------------------------------------------------

    /// DEPLOYMENT.md's standing advice — "pick `maxStaleness` tight (minutes)" — is push-feed
    /// advice. Applied to a stack containing a pull oracle it silently drops the Pyth leg on
    /// every read where no keeper has posted recently.
    ///
    /// At the OLD 3-source shape that demoted 2-of-3 into 2-of-2, which H-1 showed is not a
    /// median at all. At m = 5 the same mistake costs a source of headroom rather than the
    /// integrity of the price — the failure mode degrades from *silently wrong* to *visibly
    /// less redundant*, which is the entire point of the change.
    function test_tightStalenessCostsHeadroomButNoLongerCostsTheMedian() public {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](5);
        sources[0][0] = address(chainlinkSource);
        sources[0][1] = address(twapSource);
        sources[0][2] = address(pythSource);
        sources[0][3] = address(pushSource2);
        sources[0][4] = address(pushSource3);
        uint32[] memory stale = new uint32[](1);
        stale[0] = 60; // "tight (minutes)"
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 3;
        OracleAggregator tight = new OracleAggregator(assets, sources, stale, quorum);

        // A perfectly healthy Pyth feed, last posted five minutes ago — normal for a quiet
        // chain, and outside a 60-second bound.
        pyth.set(300100000000, 100000000, -8, block.timestamp - 300);

        // Still prices, and still on a genuine median of four.
        assertEq(tight.priceWad(asset), PUSH2_PRICE, "4 of 5 reach quorum, on a real median");

        // One more failure still prices (median of three); the SECOND one trips the breaker.
        feed.set(-1, block.timestamp);
        assertEq(tight.priceWad(asset), PUSH2_PRICE, "3 of 5 still a real median");
        feed2.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        tight.priceWad(asset);

        // The correctly-bounded stack is unaffected by the keeper cadence entirely.
        assertEq(oracle.priceWad(asset), PYTH_PRICE, "1-hour bound keeps the pull leg voting");
    }
}
