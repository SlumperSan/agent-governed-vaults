// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

/// @notice A contract that has code and answers `decimals()`/`latestRoundData()` like a feed but
/// does NOT implement `description()` — the shape of a hand-rolled or non-Chainlink aggregator
/// wired in by mistake. The oracle must refuse to bless it rather than assume USD.
contract NoDescriptionFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 2500e8, block.timestamp, block.timestamp, 1);
    }
}

/// @notice FEED DENOMINATION — the silent, catastrophic misconfiguration {ChainlinkOracle} used to
/// accept without a word.
///
/// Every consumer of `priceWad` (NAV, deposit, exit, rebalance) reads the answer as USD. Nothing
/// checked that the wired aggregator quotes in USD. The concrete trap is on the launch chain: Base
/// has a `CBETH / ETH` Data Feed and NO cbETH/USD one (see base-mainnet.json `notListed.cbETH`), so
/// a deployer reaching for cbETH wires the only feed that exists — and every vault holding cbETH
/// then prices it at ~1.04 "dollars" forever, with no revert, no staleness, no band trip.
///
/// The fix is a construction-time proof of the quote leg from the feed's own `description()`, plus
/// a decimals cross-check (Chainlink quotes USD feeds in 8 decimals and ETH-denominated ones in
/// 18). This suite covers: the real launch-set descriptions PASS; the real ETH-denominated feed
/// that caused cbETH to be dropped is REJECTED; unexpected decimals are REJECTED; and the sequencer
/// uptime feed — a status feed, not a price feed — is deliberately EXEMPT.
contract AuditFeedDenominationTest is Test {
    address constant WETH = address(0xE7);
    address constant CBETH = address(0xCBE7);
    uint32 constant HEARTBEAT = 3600;
    uint256 constant GRACE = 3600;

    function setUp() public {
        vm.warp(1_000_000);
    }

    // --- helpers -----------------------------------------------------------

    function _deploy(address asset, address feed, address seq) internal returns (ChainlinkOracle) {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[] memory feeds = new address[](1);
        feeds[0] = feed;
        uint32[] memory hb = new uint32[](1);
        hb[0] = HEARTBEAT;
        uint256[] memory z = new uint256[](1);
        return new ChainlinkOracle(assets, feeds, hb, z, z, address(0), seq);
    }

    function _feed(uint8 decimals_, int256 answer, string memory description_)
        internal
        returns (MockAggregatorV3 f)
    {
        f = new MockAggregatorV3(decimals_, answer, block.timestamp);
        f.setDescription(description_);
    }

    // --- a correct USD feed passes ----------------------------------------

    /// The exact descriptions read off-chain and recorded in the deployment configs
    /// (`verifiedOnChain` in base-mainnet.json / base-sepolia.json) must all be accepted — the
    /// check is worthless if it rejects the launch set.
    function test_realLaunchSetDescriptionsAreAccepted() public {
        string[3] memory descriptions = ["ETH / USD", "BTC / USD", "LINK / USD"];
        for (uint256 i; i < descriptions.length; ++i) {
            MockAggregatorV3 feed = _feed(8, 2500e8, descriptions[i]);
            ChainlinkOracle oracle = _deploy(WETH, address(feed), address(0));
            assertEq(oracle.priceWad(WETH), 2500e18, "a genuine USD feed prices normally");
        }
    }

    /// Chainlink has used the unspaced spelling too; the separator rule accepts `/` as well as ' '.
    function test_unspacedUsdDescriptionIsAccepted() public {
        MockAggregatorV3 feed = _feed(8, 2500e8, "ETH/USD");
        ChainlinkOracle oracle = _deploy(WETH, address(feed), address(0));
        assertEq(oracle.priceWad(WETH), 2500e18, "ETH/USD is the same denomination");
    }

    // --- an ETH-denominated feed is rejected -------------------------------

    /// THE FINDING. `CBETH / ETH` is a real Base feed; cbETH/USD is not. Before this check the
    /// oracle blessed it and returned an ETH-denominated number to USD-reading consumers.
    function test_ethDenominatedFeedIsRejected() public {
        MockAggregatorV3 feed = _feed(18, 1.04e18, "CBETH / ETH");
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _deploy(CBETH, address(feed), address(0));
    }

    /// Isolate the DESCRIPTION axis from the decimals axis: an ETH-quoted feed that nonetheless
    /// reports the USD-convention 8 decimals is still rejected, on the description alone.
    function test_ethDenominatedFeedRejectedOnDescriptionAlone() public {
        MockAggregatorV3 feed = _feed(8, 1.04e8, "CBETH / ETH");
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _deploy(CBETH, address(feed), address(0));
    }

    /// A USD-ish TOKEN is not USD: "ETH / PYUSD" ends in the bytes "USD" but its quote leg is a
    /// token that can depeg. The separator requirement is what rejects it.
    function test_usdSuffixWithoutSeparatorIsRejected() public {
        MockAggregatorV3 feed = _feed(8, 2500e8, "ETH / PYUSD");
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _deploy(WETH, address(feed), address(0));
    }

    function test_nonUsdQuoteLegsAreRejected() public {
        string[3] memory bad = ["ETH / BTC", "GBP / EUR", "Some Random Contract"];
        for (uint256 i; i < bad.length; ++i) {
            MockAggregatorV3 feed = _feed(8, 2500e8, bad[i]);
            vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
            _deploy(WETH, address(feed), address(0));
        }
    }

    /// Degenerate descriptions must not underflow the `n - 4` separator read.
    function test_shortDescriptionsAreRejected() public {
        string[3] memory bad = ["", "USD", "/US"];
        for (uint256 i; i < bad.length; ++i) {
            MockAggregatorV3 feed = _feed(8, 2500e8, bad[i]);
            vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
            _deploy(WETH, address(feed), address(0));
        }
    }

    /// A feed-shaped contract with no `description()` at all cannot prove its denomination, so it
    /// is refused rather than assumed to be USD.
    function test_feedWithoutDescriptionIsRejected() public {
        NoDescriptionFeed feed = new NoDescriptionFeed();
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _deploy(WETH, address(feed), address(0));
    }

    // --- unexpected decimals are rejected ----------------------------------

    /// 18 decimals is the ETH-denominated convention. A feed claiming a USD quote while reporting
    /// 18 decimals is not the feed the deployer thinks it is — reject, do not cache a `scale` off
    /// a contradiction.
    function test_usdDescriptionWith18DecimalsIsRejected() public {
        MockAggregatorV3 feed = _feed(18, 2500e18, "ETH / USD");
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _deploy(WETH, address(feed), address(0));
    }

    function test_usdDescriptionWithOtherDecimalsIsRejected() public {
        uint8[4] memory bad = [0, 6, 9, 19];
        for (uint256 i; i < bad.length; ++i) {
            MockAggregatorV3 feed = _feed(bad[i], 2500e8, "ETH / USD");
            vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
            _deploy(WETH, address(feed), address(0));
        }
    }

    // --- the sequencer uptime feed is exempt -------------------------------

    /// The L2 Sequencer Uptime Feed is a STATUS feed: Base's reports 0 decimals and does not
    /// describe itself as a currency pair. Applying the price-feed denomination rule to it would
    /// reject every correct Base mainnet deployment, so it is exempt by construction. This test
    /// pins that exemption — it is a deliberate asymmetry, not an oversight.
    function test_sequencerUptimeFeedIsExemptFromDenominationChecks() public {
        MockAggregatorV3 feed = _feed(8, 2500e8, "ETH / USD");
        MockAggregatorV3 seq = _feed(0, 0, "L2 Sequencer Uptime Status Feed");
        seq.set(0, block.timestamp - GRACE - 1); // up, restarted long ago
        ChainlinkOracle oracle = _deploy(WETH, address(feed), address(seq));
        assertEq(oracle.priceWad(WETH), 2500e18, "status feed exempt; price still flows");
    }

    // --- the hot path is untouched -----------------------------------------

    /// The whole check is initcode-only: `priceWad` never reads `description()`, so a feed that
    /// starts reverting on `description()` AFTER construction cannot freeze pricing. (Config is
    /// immutable, so there is nothing to re-verify at read time either.)
    function test_priceWadNeverReadsDescription() public {
        MockAggregatorV3 feed = _feed(8, 2500e8, "ETH / USD");
        ChainlinkOracle oracle = _deploy(WETH, address(feed), address(0));
        feed.setDescription(""); // would fail the construction check now
        assertEq(oracle.priceWad(WETH), 2500e18, "denomination is proven once, at construction");
    }
}
