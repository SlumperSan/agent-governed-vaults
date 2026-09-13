// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Fuzz/robustness for ChainlinkOracle — the C-6 pivot's oracle. Proves the two properties a vault's
// pricing depends on hold across the input space, not just the hand-picked cases:
//   1. WAD normalization is exact for every feed-decimals in [0,18] and every positive answer.
//   2. Fail-closed: a stale/non-positive answer, or an out-of-band price, NEVER returns a value —
//      it always reverts StaleOracle. priceWad never returns 0 and never a stale price.
// testFuzz_* names => excluded from the gas gate (fuzz gas is non-reproducible), included in the suite.

import {Test} from "forge-std/Test.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

contract ChainlinkOracleFuzzTest is Test {
    address constant ASSET = address(0xA55E7);
    uint32 constant HEARTBEAT = 3600;

    function setUp() public {
        vm.warp(2_000_000);
    }

    function _oracle(MockAggregatorV3 feed, uint256 lo, uint256 hi) internal returns (ChainlinkOracle) {
        address[] memory assets = new address[](1);
        assets[0] = ASSET;
        address[] memory feeds = new address[](1);
        feeds[0] = address(feed);
        uint32[] memory hb = new uint32[](1);
        hb[0] = HEARTBEAT;
        uint256[] memory mn = new uint256[](1);
        mn[0] = lo;
        uint256[] memory mx = new uint256[](1);
        mx[0] = hi;
        return new ChainlinkOracle(assets, feeds, hb, mn, mx, address(0), address(0));
    }

    /// WAD normalization is exact for any positive answer that won't overflow when scaled. Result
    /// is always > 0 (never a zero price). Decimals are FIXED at 8: the constructor now pins
    /// feed-decimals to the Chainlink USD-feed convention as the denomination cross-check, so the
    /// old 0..18 sweep would only ever exercise the reject path. That path is fuzzed below instead.
    function testFuzz_wadNormalizationExact(uint256 answer) public {
        // keep answer positive and the WAD product within int256/uint256 sanity
        answer = bound(answer, 1, type(uint128).max);
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(answer), block.timestamp);
        ChainlinkOracle oracle = _oracle(feed, 0, 0); // band disabled
        uint256 p = oracle.priceWad(ASSET);
        assertEq(p, answer * 1e10, "WAD = answer * 10^(18-8)");
        assertGt(p, 0, "never a zero price");
    }

    /// Denomination cross-check: EVERY feed-decimals other than 8 is rejected at construction,
    /// across the whole uint8 space — including 18, the Chainlink ETH-denominated convention that
    /// a cbETH/ETH-style misconfiguration would carry.
    function testFuzz_nonEightDecimalsRejected(uint8 decimals) public {
        vm.assume(decimals != 8);
        MockAggregatorV3 feed = new MockAggregatorV3(decimals, 2500e8, block.timestamp);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _oracle(feed, 0, 0);
    }

    /// Any answer as stale as or staler than the heartbeat fails closed.
    function testFuzz_staleAlwaysFailsClosed(uint256 age) public {
        age = bound(age, HEARTBEAT + 1, 1_000_000);
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp - age);
        ChainlinkOracle oracle = _oracle(feed, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, ASSET));
        oracle.priceWad(ASSET);
    }

    /// Any non-positive answer fails closed (never cast to a price).
    function testFuzz_nonPositiveAnswerFailsClosed(int256 answer) public {
        answer = bound(answer, type(int256).min, 0);
        MockAggregatorV3 feed = new MockAggregatorV3(8, answer, block.timestamp);
        ChainlinkOracle oracle = _oracle(feed, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, ASSET));
        oracle.priceWad(ASSET);
    }

    /// Sane-price band: an 8-decimal feed with band [lo,hi]. In-band prices exactly; out-of-band
    /// (either side) fails closed. Never returns an out-of-band value.
    /// @dev The band is now shape-checked at construction (strict ordering, width <= 1000x, and it
    /// must contain the feed's CURRENT answer), so the fuzzed width is bounded to the admissible
    /// range and the oracle is built at an in-band price. The fuzzed answer is applied afterwards
    /// — which is the property under test: what `priceWad` does once the feed MOVES.
    function testFuzz_saneBandEnforced(uint256 answer8, uint256 lo, uint256 hi) public {
        // Draw the floor in 8-decimal units so it is exactly representable by the feed, then the
        // ceiling anywhere in the admissible (lo, lo*1000] width. Domain is the original $1..$1m.
        uint256 lo8 = bound(lo, 1e8, 1_000_000e8);
        lo = lo8 * 1e10;
        hi = bound(hi, lo + 1, lo * 1000);
        answer8 = bound(answer8, 1, 100_000_000e8); // up to $100m/token in 8-dec units
        uint256 priceWad = answer8 * 1e10;
        // Construct at exactly the band floor — in band for every (lo, hi) above — then move.
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(lo8), block.timestamp);
        ChainlinkOracle oracle = _oracle(feed, lo, hi);
        feed.set(int256(answer8), block.timestamp);
        if (priceWad >= lo && priceWad <= hi) {
            assertEq(oracle.priceWad(ASSET), priceWad, "in-band prices exactly");
        } else {
            vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, ASSET));
            oracle.priceWad(ASSET);
        }
    }
}
