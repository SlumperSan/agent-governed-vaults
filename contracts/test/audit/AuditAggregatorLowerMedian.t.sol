// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleAggregator, IPriceSource} from "../retired/OracleAggregator.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";

/// @notice A price source whose price and publish time are directly settable.
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

/// @notice AUDIT ARTIFACT — not a protocol test. **H-1 AND M-1 ARE REMEDIATED.**
///
/// This file originally carried four `test_finding_*` cases proving that the quorum was
/// validated as a strict majority of the CONFIGURED set size `m` and never of the FRESH set
/// size `k`. With the shipped production configuration (m = 3, quorum = 2) a single stale or
/// reverting source dropped `k` to 2, at which point `fresh[(k-1)/2] == fresh[0]` is the
/// **minimum** — so one manipulated source reporting LOW set the vault's price outright, with
/// no breaker tripped and nothing signalling degradation.
///
/// The asymmetry was the sharp part: a manipulated HIGH source was fully absorbed, a
/// manipulated LOW one passed straight through, and DOWN is the direction that mints excess
/// shares on deposit (`VaultCore.sol:391`) — the C-4 trigger.
///
/// The exploits are preserved in git history and described in full in
/// docs/audit/AI-AUDIT-REPORT.md H-1 and M-1. They are replaced here by `test_remediated_*`
/// cases, because a permanently-red suite is noise, not evidence.
///
/// **The fix has a cost, and it is asserted here rather than hidden:** requiring
/// `quorum >= MIN_MEDIAN` means an m == 3 stack has no failure tolerance at all. Median
/// integrity and fault tolerance cannot coexist at three sources. The resolution is five
/// sources per asset, which the last test pins.
contract AuditAggregatorLowerMedianTest is Test {
    address constant ASSET = address(0xA55E7);

    StubSource chainlink;
    StubSource twap;
    StubSource pyth;
    StubSource push2;
    StubSource push3;
    OracleAggregator agg;

    function setUp() public {
        vm.warp(1_000_000);
        // Five sources, all honest at ~$2500 — the post-H-1 shape base-mainnet.json must adopt.
        chainlink = new StubSource(2500e18, block.timestamp);
        twap = new StubSource(2500e18, block.timestamp);
        pyth = new StubSource(2500e18, block.timestamp);
        push2 = new StubSource(2500e18, block.timestamp);
        push3 = new StubSource(2500e18, block.timestamp);

        address[] memory assets = new address[](1);
        assets[0] = ASSET;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](5);
        sources[0][0] = address(chainlink);
        sources[0][1] = address(twap);
        sources[0][2] = address(pyth);
        sources[0][3] = address(push2);
        sources[0][4] = address(push3);
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = 3600;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 3;

        agg = new OracleAggregator(assets, sources, staleness, quorum);
    }

    /// @notice CONTROL, unchanged: with every source fresh, the median absorbs one outlier.
    function test_control_threeFresh_manipulatedSourceCannotMovePrice() public {
        twap.set(100e18, block.timestamp); // manipulated 96% low
        assertEq(agg.priceWad(ASSET), 2500e18, "median absorbs the outlier");
    }

    /// @notice H-1 FIXED. The old finding dropped the pull leg — the documented expected steady
    /// state on a quiet chain — and then manipulated the TWAP leg LOW, which became the price.
    /// The same sequence now cannot reach a two-element set: quorum is 3, so the manipulated
    /// low source is still outvoted by the honest majority.
    function test_remediated_droppingOneLegNoLongerHandsOverThePrice() public {
        pyth.set(2500e18, block.timestamp - 3601); // stale, as base-mainnet.json observed live
        assertEq(agg.priceWad(ASSET), 2500e18, "four honest fresh sources agree");

        twap.set(100e18, block.timestamp); // manipulated 96% low
        assertEq(agg.priceWad(ASSET), 2500e18, "the outlier is outvoted, not adopted");
    }

    /// @notice H-1 FIXED — the directional asymmetry is gone. High-side manipulation was always
    /// absorbed; low-side now is too. This is the property C-4 depended on the absence of.
    function test_remediated_asymmetryIsGoneBothDirectionsAreAbsorbed() public {
        pyth.set(2500e18, block.timestamp - 3601); // k = 4

        twap.set(1_000_000e18, block.timestamp); // manipulated HIGH
        assertEq(agg.priceWad(ASSET), 2500e18, "high-side absorbed");

        twap.set(1e18, block.timestamp); // manipulated LOW
        assertEq(agg.priceWad(ASSET), 2500e18, "low-side absorbed too");
    }

    /// @notice A reverting source is still treated as not-fresh, but it no longer buys the
    /// attacker a degenerate regime — it costs one of the two spare sources.
    function test_remediated_revertingSourceCostsHeadroomNotThePrice() public {
        pyth.setBoom(true);
        twap.set(100e18, block.timestamp);
        assertEq(agg.priceWad(ASSET), 2500e18, "reverting leg costs headroom, not integrity");
    }

    /// @notice M-1 FIXED: three copies of one address no longer satisfy "3 independent
    /// sources". The old honeypot deployed happily and let a single address dictate the price
    /// with no median to cross.
    function test_remediated_constructorRejectsThreeCopiesOfOneSource() public {
        StubSource only = new StubSource(2500e18, block.timestamp);

        address[] memory assets = new address[](1);
        assets[0] = ASSET;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](3);
        sources[0][0] = address(only);
        sources[0][1] = address(only);
        sources[0][2] = address(only);
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = 3600;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 3;

        vm.expectRevert(OracleAggregator.BadOracleConfig.selector);
        new OracleAggregator(assets, sources, staleness, quorum);
    }

    /// @notice **The cost of the fix, asserted rather than described.** At m == 3 the quorum
    /// must be 3, so a single failure freezes the asset. That is not a regression hidden in the
    /// remediation — it is the reason five sources per asset is now a deployment requirement,
    /// and the reason `base-mainnet.json` cannot be deployed as previously written.
    function test_remediated_theCostIsRealAtThreeSourcesOneFailureFreezes() public {
        StubSource a = new StubSource(2500e18, block.timestamp);
        StubSource b = new StubSource(2501e18, block.timestamp);
        StubSource c = new StubSource(2502e18, block.timestamp);

        address[] memory assets = new address[](1);
        assets[0] = ASSET;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](3);
        sources[0][0] = address(a);
        sources[0][1] = address(b);
        sources[0][2] = address(c);
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = 3600;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 3; // forced: MIN_MEDIAN and a strict majority coincide at m == 3

        OracleAggregator three = new OracleAggregator(assets, sources, staleness, quorum);
        assertEq(three.priceWad(ASSET), 2501e18, "all three fresh: a genuine median");

        c.setBoom(true);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, ASSET));
        three.priceWad(ASSET);

        // The five-source stack in setUp survives the same failure, and two more besides.
        pyth.setBoom(true);
        push3.setBoom(true);
        assertEq(agg.priceWad(ASSET), 2500e18, "m = 5 absorbs two failures and still medians");
    }
}
