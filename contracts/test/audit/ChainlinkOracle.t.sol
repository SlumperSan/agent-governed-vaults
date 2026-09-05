// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {OracleAggregator, IPriceSource} from "../retired/OracleAggregator.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

/// @notice A WAD price source with directly settable price/time — used only to build a real
/// {OracleAggregator} for the C-6 contrast test. Mirrors AuditAggregatorLowerMedian's StubSource.
contract StubSource is IPriceSource {
    uint256 public p;
    uint256 public t;
    bool public boom;

    constructor(uint256 p_, uint256 t_) {
        p = p_;
        t = t_;
    }

    function set(uint256 p_, uint256 t_) external {
        p = p_;
        t = t_;
    }

    function setBoom(bool b) external {
        boom = b;
    }

    function latestPrice() external view returns (uint256, uint256) {
        require(!boom, "source down");
        return (p, t);
    }
}

/// @notice Tests for {ChainlinkOracle}: WAD normalization across feed decimals, the fail-closed
/// contract on every bad read, the sane-price band, the L2 sequencer gate, the construction guards,
/// and a C-6-style contrast against the bespoke {OracleAggregator} median showing there is no
/// per-vault quorum surface to game or misconfigure.
contract ChainlinkOracleTest is Test {
    address constant WETH = address(0xE7);
    address constant WBTC = address(0xB7);
    address constant USDC = address(0x05DC);

    uint32 constant HEARTBEAT = 3600;
    uint256 constant GRACE = 3600;

    function setUp() public {
        vm.warp(1_000_000); // a clock comfortably larger than any heartbeat/grace window
    }

    // --- helpers -----------------------------------------------------------

    /// One listed asset, bounds DISABLED (min=max=0).
    function _one(address asset, address feed, address usdc, address seq) internal returns (ChainlinkOracle) {
        return _oneBounded(asset, feed, usdc, seq, 0, 0);
    }

    /// One listed asset with an explicit sane-price band.
    function _oneBounded(address asset, address feed, address usdc, address seq, uint256 lo, uint256 hi)
        internal
        returns (ChainlinkOracle)
    {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[] memory feeds = new address[](1);
        feeds[0] = feed;
        uint32[] memory hb = new uint32[](1);
        hb[0] = HEARTBEAT;
        uint256[] memory mn = new uint256[](1);
        mn[0] = lo;
        uint256[] memory mx = new uint256[](1);
        mx[0] = hi;
        return new ChainlinkOracle(assets, feeds, hb, mn, mx, usdc, seq);
    }

    function _expectStale(ChainlinkOracle oracle, address asset) internal {
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        oracle.priceWad(asset);
    }

    // --- WAD normalization -------------------------------------------------

    function test_wadNormalization_8Decimals() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(0));
        assertEq(oracle.priceWad(WETH), 2500e18, "8-dec feed -> WAD");
    }

    /// 18 decimals is Chainlink's ETH-DENOMINATED convention. Even with a USD-looking description
    /// the decimals cross-check rejects it at construction — see AuditFeedDenomination.t.sol.
    function test_constructor_rejects18DecimalFeed() public {
        MockAggregatorV3 feed = new MockAggregatorV3(18, 2500e18, block.timestamp);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _one(WETH, address(feed), address(0), address(0));
    }

    function test_constructor_rejects6DecimalFeed() public {
        MockAggregatorV3 feed = new MockAggregatorV3(6, 30000e6, block.timestamp);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _one(WBTC, address(feed), address(0), address(0));
    }

    // --- fail-closed on bad reads -----------------------------------------

    function test_failClosed_unlistedAsset() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(0));
        _expectStale(oracle, WBTC);
    }

    function test_failClosed_stale() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(0));
        feed.set(2500e8, block.timestamp - HEARTBEAT - 1);
        _expectStale(oracle, WETH);
    }

    function test_freshAtHeartbeatBoundary() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(0));
        feed.set(2500e8, block.timestamp - HEARTBEAT);
        assertEq(oracle.priceWad(WETH), 2500e18, "boundary is fresh");
    }

    function test_failClosed_zeroAnswer() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(0));
        feed.set(0, block.timestamp);
        _expectStale(oracle, WETH);
    }

    function test_failClosed_negativeAnswer() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(0));
        feed.set(-1, block.timestamp);
        _expectStale(oracle, WETH);
    }

    function test_failClosed_unsetRound() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(0));
        feed.set(2500e8, 0);
        _expectStale(oracle, WETH);
    }

    function test_failClosed_futureTimestamp() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(0));
        feed.set(2500e8, block.timestamp + 1);
        _expectStale(oracle, WETH);
    }

    function test_failClosed_revertingFeed() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(0));
        feed.setReverts(true);
        _expectStale(oracle, WETH);
    }

    // --- sane-price band (the depeg-clamp defence) -------------------------

    /// @notice In-band price flows; the band is inclusive at both ends.
    function test_saneBand_inBandAndBoundariesPrice() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _oneBounded(WETH, address(feed), address(0), address(0), 1000e18, 5000e18);
        assertEq(oracle.priceWad(WETH), 2500e18, "in-band prices");
        feed.set(1000e8, block.timestamp);
        assertEq(oracle.priceWad(WETH), 1000e18, "floor is inclusive");
        feed.set(5000e8, block.timestamp);
        assertEq(oracle.priceWad(WETH), 5000e18, "ceiling is inclusive");
    }

    /// @notice A feed reporting a value below the floor (a crash/depeg clamp) fails closed.
    function test_saneBand_belowFloorFailsClosed() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _oneBounded(WETH, address(feed), address(0), address(0), 1000e18, 5000e18);
        feed.set(999e8, block.timestamp); // below the floor
        _expectStale(oracle, WETH);
    }

    /// @notice A feed reporting a value above the ceiling fails closed.
    function test_saneBand_aboveCeilingFailsClosed() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _oneBounded(WETH, address(feed), address(0), address(0), 1000e18, 5000e18);
        feed.set(5001e8, block.timestamp); // above the ceiling
        _expectStale(oracle, WETH);
    }

    /// @notice A disabled band (0,0) imposes no bound — any positive price prices.
    function test_saneBand_disabledImposesNoBound() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 1e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(0)); // 0,0
        assertEq(oracle.priceWad(WETH), 1e18, "no band: $1 prices");
        feed.set(1_000_000e8, block.timestamp);
        assertEq(oracle.priceWad(WETH), 1_000_000e18, "no band: $1m prices");
    }

    // --- construction guards ----------------------------------------------

    function test_constructor_rejectsCodelessFeed() public {
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _one(WETH, address(0xDEAD), address(0), address(0));
    }

    function test_constructor_rejectsZeroHeartbeat() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        address[] memory assets = new address[](1);
        assets[0] = WETH;
        address[] memory feeds = new address[](1);
        feeds[0] = address(feed);
        uint32[] memory hb = new uint32[](1);
        hb[0] = 0;
        uint256[] memory z = new uint256[](1);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        new ChainlinkOracle(assets, feeds, hb, z, z, address(0), address(0));
    }

    function test_constructor_rejectsZeroAsset() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _one(address(0), address(feed), address(0), address(0));
    }

    function test_constructor_rejectsDuplicateAsset() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        address[] memory assets = new address[](2);
        assets[0] = WETH;
        assets[1] = WETH;
        address[] memory feeds = new address[](2);
        feeds[0] = address(feed);
        feeds[1] = address(feed);
        uint32[] memory hb = new uint32[](2);
        hb[0] = HEARTBEAT;
        hb[1] = HEARTBEAT;
        uint256[] memory z = new uint256[](2);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        new ChainlinkOracle(assets, feeds, hb, z, z, address(0), address(0));
    }

    function test_constructor_rejectsFeedWithAbsurdDecimals() public {
        MockAggregatorV3 feed = new MockAggregatorV3(19, 2500e8, block.timestamp);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _one(WETH, address(feed), address(0), address(0));
    }

    /// @notice A USDC pinned to $1 must NOT also carry a feed — the two configs would silently
    /// conflict (the pin would shadow the feed). Reject at construction.
    function test_constructor_rejectsUsdcAlsoListed() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 1e8, block.timestamp);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _one(USDC, address(feed), USDC, address(0)); // asset == usdc_
    }

    /// @notice A malformed band (min > max) is rejected.
    function test_constructor_rejectsMinAboveMax() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _oneBounded(WETH, address(feed), address(0), address(0), 5000e18, 1000e18);
    }

    /// @notice A has-code-but-wrong-ABI sequencer feed is caught at construction (decode-proof),
    /// not left to brick the whole oracle at first read.
    function test_constructor_decodeProofsSequencerFeed() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        // The oracle contract itself has code but no latestRoundData()/answering ABI shape usable
        // as a sequencer feed data source; use an ERC20-like with no AggregatorV3 surface.
        StubSource notAFeed = new StubSource(1, 1); // has code, no latestRoundData()
        vm.expectRevert(); // decode-proof call reverts inside the constructor
        _oneWithSeq(WETH, address(feed), address(notAFeed));
    }

    function _oneWithSeq(address asset, address feed, address seq) internal returns (ChainlinkOracle) {
        return _one(asset, feed, address(0), seq);
    }

    // --- USDC pin ----------------------------------------------------------

    function test_usdcPin() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle oracle = _one(WETH, address(feed), USDC, address(0));
        assertEq(oracle.priceWad(USDC), 1e18, "USDC pinned to 1e18");
        assertEq(oracle.priceWad(WETH), 2500e18, "listed feed still priced");
    }

    // --- L2 sequencer gate -------------------------------------------------

    function test_sequencer_upAndPastGrace() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        MockAggregatorV3 seq = new MockAggregatorV3(0, 0, block.timestamp - GRACE - 1); // up, restarted long ago
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(seq));
        assertEq(oracle.priceWad(WETH), 2500e18, "sequencer healthy: price flows");
    }

    function test_sequencer_down() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        MockAggregatorV3 seq = new MockAggregatorV3(0, 1, block.timestamp - GRACE - 1); // answer 1 = down
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(seq));
        _expectStale(oracle, WETH);
    }

    function test_sequencer_withinGrace() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        MockAggregatorV3 seq = new MockAggregatorV3(0, 0, block.timestamp - 100); // up 100s ago, < grace
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(seq));
        _expectStale(oracle, WETH);
    }

    function test_sequencer_atGraceBoundaryStillReverts() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        MockAggregatorV3 seq = new MockAggregatorV3(0, 0, block.timestamp - GRACE); // exactly at grace
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(seq));
        _expectStale(oracle, WETH); // must be STRICTLY past
    }

    function test_sequencer_uninitializedRound() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        MockAggregatorV3 seq = new MockAggregatorV3(0, 0, 0); // answer 0 up, but startedAt 0
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(seq));
        _expectStale(oracle, WETH);
    }

    function test_sequencer_revertingFeed() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        MockAggregatorV3 seq = new MockAggregatorV3(0, 0, block.timestamp - GRACE - 1);
        ChainlinkOracle oracle = _one(WETH, address(feed), address(0), address(seq));
        seq.setReverts(true);
        _expectStale(oracle, WETH);
    }

    function test_sequencer_gatesUsdcPinToo() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        MockAggregatorV3 seq = new MockAggregatorV3(0, 1, block.timestamp - GRACE - 1); // down
        ChainlinkOracle oracle = _one(WETH, address(feed), USDC, address(seq));
        _expectStale(oracle, USDC);
    }

    // --- C-6 contrast: no per-vault median/quorum surface to game ----------

    /// @notice C-6-STYLE. The bespoke {OracleAggregator}'s OUTPUT is a function of WHICH sources are
    /// fresh — the surface H-1/M-1/C-6 lived on. {ChainlinkOracle} prices from ONE feed: no second
    /// source to stall, no quorum to misconfigure. Asserts the STRUCTURAL difference.
    function test_c6_noQuorumSurfaceToGameOrMisconfigure() public {
        StubSource s0 = new StubSource(2500e18, block.timestamp);
        StubSource s1 = new StubSource(2500e18, block.timestamp);
        StubSource s2 = new StubSource(2500e18, block.timestamp);
        StubSource s3 = new StubSource(2500e18, block.timestamp);
        StubSource s4 = new StubSource(2500e18, block.timestamp);

        address[] memory assets = new address[](1);
        assets[0] = WETH;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](5);
        sources[0][0] = address(s0);
        sources[0][1] = address(s1);
        sources[0][2] = address(s2);
        sources[0][3] = address(s3);
        sources[0][4] = address(s4);
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = HEARTBEAT;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 3;
        OracleAggregator agg = new OracleAggregator(assets, sources, staleness, quorum);

        assertEq(agg.priceWad(WETH), 2500e18, "aggregator: all fresh");
        // Stall two sources (k=3), then move the fresh set to show the OUTPUT depends on it (C-6).
        s3.setBoom(true);
        s4.setBoom(true);
        s2.set(2400e18, block.timestamp);
        assertEq(agg.priceWad(WETH), 2500e18, "aggregator k=3: median still 2500");
        s1.set(2400e18, block.timestamp);
        assertEq(agg.priceWad(WETH), 2400e18, "aggregator output depends on the fresh set");

        // ChainlinkOracle: ONE feed. No second source's freshness moves the result, no quorum knob.
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle chainlink = _one(WETH, address(feed), address(0), address(0));
        assertEq(chainlink.priceWad(WETH), 2500e18, "chainlink: the feed, full stop");

        // The aggregator ACCEPTS a weak-but-legal m=3/quorum=3 shape (any one failure freezes) — a
        // per-vault sizing decision a creator can get wrong. ChainlinkOracle has no such knob.
        StubSource a = new StubSource(2500e18, block.timestamp);
        StubSource b = new StubSource(2500e18, block.timestamp);
        StubSource c = new StubSource(2500e18, block.timestamp);
        address[][] memory weak = new address[][](1);
        weak[0] = new address[](3);
        weak[0][0] = address(a);
        weak[0][1] = address(b);
        weak[0][2] = address(c);
        uint8[] memory q3 = new uint8[](1);
        q3[0] = 3;
        OracleAggregator fragile = new OracleAggregator(assets, weak, staleness, q3);
        c.setBoom(true);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, WETH));
        fragile.priceWad(WETH);

        assertEq(chainlink.priceWad(WETH), 2500e18, "single feed: no quorum to misconfigure");
    }
}
