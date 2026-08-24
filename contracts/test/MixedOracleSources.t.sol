// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleAggregator, ChainlinkSourceAdapter, IAggregatorV3} from "../src/OracleAggregator.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {UniswapV3TwapSource, IUniswapV3PoolMinimal} from "../src/oracle/UniswapV3TwapSource.sol";
import {PythSource, IPyth} from "../src/oracle/PythSource.sol";
import {MockV3Pool, MockPyth, MockAggregatorV3} from "./mocks/OracleSourceMocks.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// Sprint 11 — integration of the three SF-1 **mechanism classes** behind the (frozen,
/// unmodified) `OracleAggregator`:
///
///   1. push       — `ChainlinkSourceAdapter` over an AggregatorV3 feed
///   2. spot TWAP  — `UniswapV3TwapSource` over a V3 pool
///   3. pull       — `PythSource` over a Pyth price id
///
/// This is the configuration `base-mainnet.json` drafts and DEPLOYMENT.md §2 prescribes: three
/// sources, quorum 2. The point of these tests is not that the median arithmetic works —
/// `OracleFuzz.t.sol` already establishes that over abstract sources — but that three
/// *independently written adapters* agree on units, and that any ONE class going dark leaves
/// the breaker un-tripped while the other two hold.
contract MixedOracleSourcesTest is Test {
    uint32 constant WINDOW = 1800;
    uint16 constant MIN_CARD = 100;
    uint32 constant MAX_OBS_AGE = 3600;
    uint32 constant MAX_STALENESS = 1 hours;

    bytes32 constant ETH_USD =
        bytes32(uint256(0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace));

    MockERC20 weth;
    MockERC20 usdc;

    MockAggregatorV3 feed;
    MockV3Pool pool;
    MockPyth pyth;

    ChainlinkSourceAdapter chainlinkSource;
    UniswapV3TwapSource twapSource;
    PythSource pythSource;

    OracleAggregator oracle;
    address asset;

    // The three sources quote the same asset at deliberately different prices, so which one
    // the median picked is never ambiguous.
    uint256 constant TWAP_PRICE = 2996806154000000000000; // $2996.806154, tick -196267
    uint256 constant CHAINLINK_PRICE = 3000e18; // $3000.00, 8-decimal feed
    uint256 constant PYTH_PRICE = 3001e18; // $3001.00, expo -8

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
        quorum[0] = 2; // strict majority of 3 — the constructor floor, exactly
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

    /// The full stack: quorum reached, lower median of three is the middle value.
    function test_mixedSourcesReachQuorumAndMedian() public view {
        assertEq(oracle.priceWad(asset), CHAINLINK_PRICE, "median of the three classes");
    }

    /// The aggregator's own floors accept this shape and nothing weaker: 3 sources, quorum 2.
    function test_configurationSitsExactlyOnTheAggregatorFloor() public view {
        (address[] memory srcs, uint32 stale, uint8 q) = oracle.assetConfig(asset);
        assertEq(srcs.length, 3, "MIN_SOURCES");
        assertEq(q, 2, "strict majority of 3");
        assertEq(stale, MAX_STALENESS);
        // quorum 2 is both the strict-majority floor and the largest value that tolerates a
        // failure: at quorum 3 a single dark source would freeze the asset.
        assertGt(q, srcs.length / 2, "must be a strict majority");
        assertLt(q, srcs.length, "must leave one source of headroom");
    }

    // --------------------------------------------------------------------------------------
    // one class dark — the breaker must NOT trip
    // --------------------------------------------------------------------------------------

    /// The TWAP class goes dark because its pool stopped trading. This is the scenario the
    /// source's freshness guards exist for: without them it would keep voting a one-block
    /// spot price forever. With them it withholds, and the other two classes hold quorum.
    function test_twapClassDarkDoesNotTripBreaker() public {
        pool.setRing(MIN_CARD, 40, uint32(block.timestamp - 10 days), uint32(block.timestamp - 10 days));
        (uint256 tw,) = twapSource.latestPrice();
        assertEq(tw, 0, "quiet pool must withhold");

        // Fresh set is {3000, 3001}; the lower median of two is the lower one.
        assertEq(oracle.priceWad(asset), CHAINLINK_PRICE, "quorum still holds on 2 of 3");
    }

    /// The pull class goes dark because no keeper posted an update inside `maxStaleness`.
    function test_pythClassDarkDoesNotTripBreaker() public {
        pyth.set(300100000000, 100000000, -8, block.timestamp - MAX_STALENESS - 1);
        assertEq(oracle.priceWad(asset), TWAP_PRICE, "fresh set {2996.8, 3000} -> lower median");
    }

    /// The push class goes dark on a non-positive answer (its documented `(0, 0)` convention).
    function test_chainlinkClassDarkDoesNotTripBreaker() public {
        feed.set(-1, block.timestamp);
        assertEq(oracle.priceWad(asset), TWAP_PRICE, "fresh set {2996.8, 3001} -> lower median");
    }

    /// A source that reverts outright is likewise absorbed — by the aggregator's `try/catch`
    /// for Chainlink, and by the adapters' own containment for the other two.
    function test_revertingSourcesAreAbsorbedNotPropagated() public {
        feed.setReverts(true);
        assertEq(oracle.priceWad(asset), TWAP_PRICE, "reverting feed is merely not-fresh");

        feed.setReverts(false);
        pool.setObserveReverts(true);
        assertEq(oracle.priceWad(asset), CHAINLINK_PRICE, "reverting pool is merely not-fresh");
    }

    // --------------------------------------------------------------------------------------
    // two classes dark — the breaker must trip (K-4, deliberately)
    // --------------------------------------------------------------------------------------

    function test_twoClassesDarkTripsBreaker() public {
        feed.set(-1, block.timestamp);
        pool.setRing(MIN_CARD, 40, uint32(block.timestamp - 10 days), uint32(block.timestamp - 10 days));
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        oracle.priceWad(asset);
    }

    /// Every pair of failures trips it — no ordering of the three classes is privileged.
    function test_everyPairOfDarkClassesTripsBreaker() public {
        // push + pull
        feed.set(-1, block.timestamp);
        pyth.setReverts(true);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        oracle.priceWad(asset);

        // pull + twap
        feed.set(3000e8, block.timestamp);
        pool.setObserveReverts(true);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        oracle.priceWad(asset);
    }

    // --------------------------------------------------------------------------------------
    // the configuration trap this stack is most likely to be mis-deployed into
    // --------------------------------------------------------------------------------------

    /// DEPLOYMENT.md's standing advice — "pick `maxStaleness` tight (minutes)" — is push-feed
    /// advice. Applied to a stack containing a pull oracle it silently demotes 2-of-3 into
    /// 2-of-2: the Pyth leg is dropped on every read where no keeper has posted recently, so
    /// the vault is one Chainlink hiccup from a frozen breaker even though nothing is broken.
    /// Asserted here so the tradeoff is a test, not just a paragraph.
    function test_tightStalenessSilentlyDemotesPullLegAndRemovesHeadroom() public {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](3);
        sources[0][0] = address(chainlinkSource);
        sources[0][1] = address(twapSource);
        sources[0][2] = address(pythSource);
        uint32[] memory stale = new uint32[](1);
        stale[0] = 60; // "tight (minutes)"
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 2;
        OracleAggregator tight = new OracleAggregator(assets, sources, stale, quorum);

        // A perfectly healthy Pyth feed, last posted five minutes ago — normal for a quiet
        // chain, and outside a 60-second bound.
        pyth.set(300100000000, 100000000, -8, block.timestamp - 300);

        // Still prices: push + TWAP hold quorum.
        assertEq(tight.priceWad(asset), TWAP_PRICE, "2 of 3 still reach quorum");

        // But there is no headroom left. One more failure freezes the asset, where the
        // correctly-configured aggregator above would still price.
        feed.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        tight.priceWad(asset);
        assertEq(oracle.priceWad(asset), TWAP_PRICE, "the 1-hour-bound stack still prices on {twap, pyth}");
    }
}
