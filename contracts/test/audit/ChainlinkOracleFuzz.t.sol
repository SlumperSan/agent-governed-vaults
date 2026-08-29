// SPDX-License-Identifier: BUSL-1.1
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

    /// WAD normalization is exact for any feed-decimals in [0,18] and any positive answer that
    /// won't overflow when scaled. Result is always > 0 (never a zero price).
    function testFuzz_wadNormalizationExact(uint8 decimals, uint256 answer) public {
        decimals = uint8(bound(decimals, 0, 18));
        uint256 scale = 10 ** (18 - uint256(decimals));
        // keep answer positive and the WAD product within int256/uint256 sanity
        answer = bound(answer, 1, type(uint128).max);
        MockAggregatorV3 feed = new MockAggregatorV3(decimals, int256(answer), block.timestamp);
        ChainlinkOracle oracle = _oracle(feed, 0, 0); // band disabled
        uint256 p = oracle.priceWad(ASSET);
        assertEq(p, answer * scale, "WAD = answer * 10^(18-decimals)");
        assertGt(p, 0, "never a zero price");
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
    function testFuzz_saneBandEnforced(uint256 answer8, uint256 lo, uint256 hi) public {
        lo = bound(lo, 1e18, 1_000_000e18);
        hi = bound(hi, lo, 10_000_000e18);
        answer8 = bound(answer8, 1, 100_000_000e8); // up to $100m/token in 8-dec units
        uint256 priceWad = answer8 * 1e10;
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(answer8), block.timestamp);
        ChainlinkOracle oracle = _oracle(feed, lo, hi);
        if (priceWad >= lo && priceWad <= hi) {
            assertEq(oracle.priceWad(ASSET), priceWad, "in-band prices exactly");
        } else {
            vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, ASSET));
            oracle.priceWad(ASSET);
        }
    }
}
