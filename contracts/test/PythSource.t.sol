// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PythSource, IPyth} from "./retired/PythSource.sol";
import {MockPyth} from "./mocks/OracleSourceMocks.sol";

/// Sprint 11 — unit, fixture and fuzz coverage for `PythSource` (a post-audit-freeze additive
/// `IPriceSource`). The exponent table below is fixture-based on purpose: expo normalization is
/// the one place a pull-oracle wrapper silently mis-prices by a factor of 10^n, and a
/// self-derived expectation would reproduce whatever sign error the implementation had.
contract PythSourceTest is Test {
    bytes32 constant ETH_USD =
        bytes32(uint256(0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace));
    uint32 constant MAX_CONF_BPS = 100; // 1%

    MockPyth pyth;
    PythSource src;

    function setUp() public {
        vm.warp(1_700_000_000);
        // $3000.10429 at Pyth's usual expo of -8, with a 0.1% confidence band.
        pyth = new MockPyth(300010429000, 300010429, -8, block.timestamp - 10);
        src = new PythSource(IPyth(address(pyth)), ETH_USD, MAX_CONF_BPS);
    }

    // --------------------------------------------------------------------------------------
    // expo normalization fixtures
    // --------------------------------------------------------------------------------------

    /// The common case: expo -8 scales up by 10^10 to reach WAD.
    function test_normalizesTypicalNegativeExpo() public view {
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 3000104290000000000000, "expo -8 -> WAD");
        assertEq(t, block.timestamp - 10, "updatedAt is Pyth publishTime, not now");
    }

    /// A table of exponents, each priced to the same $3000.10429 in its own scale. Every row
    /// must normalize to the identical WAD value — that is what "expo-independent" means.
    function test_expoTableAllNormalizeToTheSameWad() public {
        uint256 expected = 3000104290000000000000;

        pyth.set(300010429000, 1, -8, block.timestamp);
        (uint256 p,) = src.latestPrice();
        assertEq(p, expected, "expo -8");

        pyth.set(3000104290, 1, -6, block.timestamp);
        (p,) = src.latestPrice();
        assertEq(p, expected, "expo -6");

        pyth.set(3000104290000000, 1, -12, block.timestamp);
        (p,) = src.latestPrice();
        assertEq(p, expected, "expo -12");

        // expo exactly -18: no scaling at all, the raw value already IS the WAD value. int64
        // cannot hold $3000.10429 at that scale, so this row is $3.00010429 -- same digits, /1000.
        pyth.set(3000104290000000000, 1, -18, block.timestamp);
        (p,) = src.latestPrice();
        assertEq(p, expected / 1000, "expo -18 passes through unscaled");

        // Below -18 the feed carries more precision than WAD holds: scale DOWN, lose the tail.
        pyth.set(3000104290000000000, 1, -20, block.timestamp);
        (p,) = src.latestPrice();
        assertEq(p, expected / 100000, "expo -20 divides");
    }

    /// Non-negative exponents are rare but handled rather than assumed away.
    function test_normalizesZeroAndPositiveExpo() public {
        // conf 0: at these coarse scales any non-zero conf is itself wider than 1% of price,
        // which is the confidence gate doing its job rather than a normalization failure.
        pyth.set(3000, 0, 0, block.timestamp);
        (uint256 p,) = src.latestPrice();
        assertEq(p, 3000e18, "expo 0");

        pyth.set(30, 0, 2, block.timestamp);
        (p,) = src.latestPrice();
        assertEq(p, 3000e18, "expo 2");
    }

    /// The most extreme exponents the contract admits still normalize without overflow.
    function test_expoBoundsAreUsableNotJustAccepted() public {
        pyth.set(type(int64).max, 0, src.MAX_EXPO(), block.timestamp);
        (uint256 p,) = src.latestPrice();
        assertEq(p, uint256(uint64(type(int64).max)) * 1e18 * 1e18, "MAX_EXPO must not overflow");

        pyth.set(type(int64).max, 0, src.MIN_EXPO(), block.timestamp);
        (p,) = src.latestPrice();
        assertEq(p, uint256(uint64(type(int64).max)) / 1e18, "MIN_EXPO divides down");
    }

    // --------------------------------------------------------------------------------------
    // failure modes — every one must degrade to (0, 0), matching ChainlinkSourceAdapter
    // --------------------------------------------------------------------------------------

    function test_nonPositivePriceWithholds() public {
        pyth.set(0, 1, -8, block.timestamp);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0);
        assertEq(t, 0);

        pyth.set(-1, 1, -8, block.timestamp);
        (p, t) = src.latestPrice();
        assertEq(p, 0, "a negative price is not a price");
        assertEq(t, 0);
    }

    function test_zeroPublishTimeWithholds() public {
        pyth.set(300010429000, 1, -8, 0);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0);
        assertEq(t, 0);
    }

    function test_outOfRangeExpoWithholds() public {
        pyth.set(300010429000, 1, src.MAX_EXPO() + 1, block.timestamp);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0, "expo above the reasoned range");
        assertEq(t, 0);

        pyth.set(300010429000, 1, src.MIN_EXPO() - 1, block.timestamp);
        (p, t) = src.latestPrice();
        assertEq(p, 0, "expo below the reasoned range");
        assertEq(t, 0);
    }

    /// A price that scales down to nothing is not a vote — the aggregator reads 0 as
    /// not-fresh, so say so explicitly rather than smuggling a 0 into the median.
    function test_subDustPriceWithholds() public {
        pyth.set(1, 0, -36, block.timestamp);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0);
        assertEq(t, 0);
    }

    /// A feed that has never been populated on this chain reverts; the wrapper absorbs it.
    function test_revertingPythWithholds() public {
        pyth.setReverts(true);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0);
        assertEq(t, 0);
    }

    // --------------------------------------------------------------------------------------
    // confidence gate
    // --------------------------------------------------------------------------------------

    /// A feed in disagreement with itself declines to vote. At `maxConfBps = 100` (1%), a
    /// confidence interval of exactly 1% is accepted and one basis point wider is not.
    function test_confidenceGateBoundary() public {
        uint64 price = 300010429000;
        uint64 onePercent = price / 100;

        pyth.set(int64(price), onePercent, -8, block.timestamp);
        (uint256 p,) = src.latestPrice();
        assertGt(p, 0, "exactly at the bound is accepted");

        pyth.set(int64(price), onePercent + price / 10000, -8, block.timestamp);
        (uint256 p2, uint256 t2) = src.latestPrice();
        assertEq(p2, 0, "one basis point wider is rejected");
        assertEq(t2, 0);
    }

    function test_wideConfidenceWithholds() public {
        pyth.set(300010429000, 300010429000, -8, block.timestamp); // conf == price
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0);
        assertEq(t, 0);
    }

    // --------------------------------------------------------------------------------------
    // constructor validation
    // --------------------------------------------------------------------------------------

    function test_constructorRejectsZeroPriceId() public {
        vm.expectRevert(PythSource.BadPythConfig.selector);
        new PythSource(IPyth(address(pyth)), bytes32(0), MAX_CONF_BPS);
    }

    function test_constructorRejectsBadConfBounds() public {
        // Read the ceiling BEFORE arming the cheatcode: `vm.expectRevert` binds to the very
        // next call, and a getter is a call.
        uint32 tooWide = src.MAX_CONF_BPS_CEILING() + 1;
        vm.expectRevert(PythSource.BadPythConfig.selector);
        new PythSource(IPyth(address(pyth)), ETH_USD, 0);
        vm.expectRevert(PythSource.BadPythConfig.selector);
        new PythSource(IPyth(address(pyth)), ETH_USD, tooWide);
    }

    function test_constructorRejectsPythWithoutCode() public {
        vm.expectRevert(PythSource.BadPythConfig.selector);
        new PythSource(IPyth(address(0)), ETH_USD, MAX_CONF_BPS);
        vm.expectRevert(PythSource.BadPythConfig.selector);
        new PythSource(IPyth(address(0xDEAD)), ETH_USD, MAX_CONF_BPS);
    }

    /// The typo guard: an id that does not resolve on this chain cannot be deployed, so a
    /// source that would never vote cannot hide inside a 2-of-3 quorum.
    function test_constructorRejectsUnresolvableFeed() public {
        pyth.setReverts(true);
        vm.expectRevert(); // the Pyth contract's own "PriceFeedNotFound"
        new PythSource(IPyth(address(pyth)), ETH_USD, MAX_CONF_BPS);
    }

    function test_constructorRejectsOutOfRangeExpoAtDeploy() public {
        pyth.set(300010429000, 1, src.MIN_EXPO() - 1, block.timestamp);
        vm.expectRevert(PythSource.BadPythConfig.selector);
        new PythSource(IPyth(address(pyth)), ETH_USD, MAX_CONF_BPS);
    }

    // --------------------------------------------------------------------------------------
    // fuzz
    // --------------------------------------------------------------------------------------

    /// Normalization matches an independently written reference across the whole admitted
    /// exponent range, including every negative exponent.
    function testFuzz_expoNormalizationMatchesReference(int64 rawPrice, int32 rawExpo, uint64 publishTime)
        public
    {
        int64 price = int64(bound(rawPrice, 1, type(int64).max));
        int32 expo = int32(bound(rawExpo, src.MIN_EXPO(), src.MAX_EXPO()));
        uint256 pt = bound(publishTime, 1, type(uint64).max);

        pyth.set(price, 0, expo, pt); // conf 0 so the gate never interferes
        (uint256 p, uint256 t) = src.latestPrice();

        uint256 expected = _refWad(price, expo);
        if (expected == 0) {
            assertEq(p, 0, "dust must withhold");
            assertEq(t, 0);
        } else {
            assertEq(p, expected, "normalization mismatch");
            assertEq(t, pt, "publishTime passes through unchanged");
        }
    }

    /// The confidence gate is exactly `conf/price <= maxConfBps/10000`, with no rounding slop
    /// that could let a wide band through.
    function testFuzz_confidenceGateIsExact(int64 rawPrice, uint64 rawConf) public {
        int64 price = int64(bound(rawPrice, 1e6, type(int64).max));
        uint64 conf = uint64(bound(rawConf, 0, uint64(price)));

        pyth.set(price, conf, -8, block.timestamp);
        (uint256 p,) = src.latestPrice();

        bool shouldPass = uint256(conf) * 10_000 <= uint256(uint64(price)) * MAX_CONF_BPS;
        if (shouldPass && _refWad(price, -8) > 0) assertGt(p, 0, "inside the band must price");
        else assertEq(p, 0, "outside the band must withhold");
    }

    /// The read path never reverts, whatever the feed reports — it prices or it withholds.
    function testFuzz_latestPriceNeverReverts(int64 price, uint64 conf, int32 expo, uint64 publishTime)
        public
    {
        pyth.set(price, conf, expo, publishTime);
        (uint256 p, uint256 t) = src.latestPrice();
        if (p == 0) assertEq(t, 0, "withholding must zero updatedAt");
        else assertEq(t, publishTime, "a price must carry its publish time");
    }

    // --------------------------------------------------------------------------------------
    // reference implementation, written from the Pyth spec rather than from the contract
    // --------------------------------------------------------------------------------------

    function _refWad(int64 price, int32 expo) internal pure returns (uint256) {
        if (price <= 0) return 0;
        uint256 raw = uint256(uint64(price));
        // value = raw * 10^expo dollars; WAD = value * 1e18 = raw * 10^(expo + 18)
        int256 shift = int256(expo) + 18;
        if (shift >= 0) return raw * (10 ** uint256(shift));
        return raw / (10 ** uint256(-shift));
    }
}
