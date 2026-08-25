// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleAggregator, IPriceSource} from "../../src/OracleAggregator.sol";

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

/// @notice AUDIT ARTIFACT — not a protocol test.
///
/// Tests the claim at `OracleAggregator.sol:104-105`: "Majority-fresh quorum guarantees the
/// middle element is bounded by the honest set." The quorum is validated in the constructor as
/// a strict majority of the CONFIGURED set size `m`, never of the FRESH set size `k`. With the
/// production configuration (m = 3, quorum = 2) a single stale source drops `k` to 2, and
/// `fresh[(k-1)/2] = fresh[0]` is then the MINIMUM of the two survivors — so one manipulated
/// source that reports LOW sets the vault's price outright.
contract AuditAggregatorLowerMedianTest is Test {
    address constant ASSET = address(0xA55E7);

    StubSource chainlink;
    StubSource twap;
    StubSource pyth;
    OracleAggregator agg;

    function setUp() public {
        vm.warp(1_000_000);
        // Three mechanism classes, all honest at ~$2500, as base-mainnet.json configures WETH.
        chainlink = new StubSource(2500e18, block.timestamp);
        twap = new StubSource(2500e18, block.timestamp);
        pyth = new StubSource(2500e18, block.timestamp);

        address[] memory assets = new address[](1);
        assets[0] = ASSET;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](3);
        sources[0][0] = address(chainlink);
        sources[0][1] = address(twap);
        sources[0][2] = address(pyth);
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = 3600; // base-mainnet.json maxStalenessSeconds
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 2; // base-mainnet.json quorum

        agg = new OracleAggregator(assets, sources, staleness, quorum);
    }

    /// @notice CONTROL: with all three sources fresh, the median defends as designed — one
    /// manipulated source cannot move the price at all.
    function test_control_threeFresh_manipulatedSourceCannotMovePrice() public {
        twap.set(100e18, block.timestamp); // manipulated 96% low
        assertEq(agg.priceWad(ASSET), 2500e18, "median of three absorbs the outlier");
    }

    /// @notice THE FINDING: drop the pull (Pyth) leg out of the fresh set — the documented
    /// expected steady state on a quiet chain (PythSource.sol:41-56, and base-mainnet.json's
    /// operationalNote records the cbETH Pyth price observed 2549s old against a 3600s bound).
    /// The quorum of 2 is still satisfied, so no breaker trips and nothing signals degradation,
    /// but the "median" is now the MINIMUM of the two survivors.
    function test_finding_twoFresh_lowerMedianHandsOneSourceTheDownside() public {
        // Pyth goes stale (older than maxStaleness). Quorum 2-of-3 still met by the other two.
        pyth.set(2500e18, block.timestamp - 3601);

        // Both survivors honest: price is still right, so nothing looks wrong yet.
        assertEq(agg.priceWad(ASSET), 2500e18, "two honest fresh sources agree");

        // Now the TWAP leg is manipulated LOW (see AuditTwapSpotDegeneration.t.sol for how
        // that is achieved atomically on a quiet pool).
        twap.set(100e18, block.timestamp);

        uint256 price = agg.priceWad(ASSET);
        assertEq(price, 100e18, "lower median of two == the manipulated minimum");
        emit log_named_uint("price the vault will use (WAD)", price);
    }

    /// @notice The same asymmetry in the other direction: a manipulated HIGH source is fully
    /// absorbed. The lower-median rule makes exactly one direction — down — attacker-controlled,
    /// and down is the direction that mints excess shares on deposit (VaultCore.sol:391).
    function test_finding_asymmetry_highSideIsSafeLowSideIsNot() public {
        pyth.set(2500e18, block.timestamp - 3601); // stale, k = 2

        twap.set(1_000_000e18, block.timestamp); // manipulated HIGH
        assertEq(agg.priceWad(ASSET), 2500e18, "high-side manipulation is absorbed");

        twap.set(1e18, block.timestamp); // manipulated LOW
        assertEq(agg.priceWad(ASSET), 1e18, "low-side manipulation passes straight through");
    }

    /// @notice A reverting source is treated identically to a stale one, so an attacker who can
    /// DoS one leg gets the same k = 2 regime for free.
    function test_finding_revertingSourceAlsoProducesTheTwoFreshRegime() public {
        pyth.setBoom(true);
        twap.set(100e18, block.timestamp);
        assertEq(agg.priceWad(ASSET), 100e18, "reverting leg also collapses to lower-of-two");
    }

    /// @notice The constructor does not deduplicate or zero-check the source set: three copies
    /// of ONE address satisfy MIN_SOURCES = 3 and a 2-of-3 "strict majority" quorum, so the
    /// "median of >= 3 independent sources" floor is a convention, not an enforced property.
    function test_finding_constructorAcceptsThreeCopiesOfOneSource() public {
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
        quorum[0] = 2;

        OracleAggregator honeypot = new OracleAggregator(assets, sources, staleness, quorum);
        assertEq(honeypot.priceWad(ASSET), 2500e18, "deploys and prices happily");

        // One address controls the price outright, with no median to cross.
        only.set(1e18, block.timestamp);
        assertEq(honeypot.priceWad(ASSET), 1e18, "single source dictates the price");
    }
}
