// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleAggregator, IPriceSource} from "../src/OracleAggregator.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";

contract FuzzSource is IPriceSource {
    uint256 p;
    uint256 t;

    function set(uint256 p_, uint256 t_) external {
        p = p_;
        t = t_;
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (p, t);
    }
}

/// Fuzz + property tests for the median oracle — the "prices everything" contract. Hardens the
/// post-S6 lower-median + majority-quorum design (Finding 6): correct median, and a minority of
/// extreme outliers can never move the result outside the honest majority's range.
contract OracleFuzzTest is Test {
    OracleAggregator oracle;
    FuzzSource[5] srcs;
    address constant ASSET = address(0xBEEF);

    function setUp() public {
        vm.warp(1_700_000_000);
        address[] memory assets = new address[](1);
        assets[0] = ASSET;
        address[][] memory ss = new address[][](1);
        ss[0] = new address[](5);
        for (uint256 i; i < 5; ++i) {
            srcs[i] = new FuzzSource();
            ss[0][i] = address(srcs[i]);
        }
        uint32[] memory stale = new uint32[](1);
        stale[0] = 1 hours;
        uint8[] memory q = new uint8[](1);
        q[0] = 3; // strict majority of 5
        oracle = new OracleAggregator(assets, ss, stale, q);
    }

    function _setAll(uint256[5] memory prices) internal {
        for (uint256 i; i < 5; ++i) {
            srcs[i].set(prices[i], block.timestamp);
        }
    }

    /// The returned price is always the exact lower median of 5 fresh sources.
    function testFuzz_lowerMedianOfFive(uint256[5] memory raw) public {
        uint256[5] memory prices;
        for (uint256 i; i < 5; ++i) {
            prices[i] = bound(raw[i], 1, 1e30);
        }
        _setAll(prices);

        // Reference: sort a copy, take index 2 (lower median of 5).
        uint256[5] memory sorted = prices;
        for (uint256 i = 1; i < 5; ++i) {
            uint256 key = sorted[i];
            uint256 j = i;
            while (j > 0 && sorted[j - 1] > key) {
                sorted[j] = sorted[j - 1];
                --j;
            }
            sorted[j] = key;
        }
        assertEq(oracle.priceWad(ASSET), sorted[2], "not the lower median");
    }

    /// The median always lies within the range of the fresh inputs — never an extrapolation.
    function testFuzz_medianWithinRange(uint256[5] memory raw) public {
        uint256 mn = type(uint256).max;
        uint256 mx;
        uint256[5] memory prices;
        for (uint256 i; i < 5; ++i) {
            prices[i] = bound(raw[i], 1, 1e30);
            if (prices[i] < mn) mn = prices[i];
            if (prices[i] > mx) mx = prices[i];
        }
        _setAll(prices);
        uint256 m = oracle.priceWad(ASSET);
        assertGe(m, mn);
        assertLe(m, mx);
    }

    /// A minority (2 of 5) of arbitrary outliers cannot move the median outside the range of the
    /// 3 honest sources. This is the SF-1 guarantee: compromise of < majority can't move price.
    function testFuzz_minorityOutliersCannotMoveMedian(uint256 honestSeed, uint256 lo, uint256 hi) public {
        uint256 base = bound(honestSeed, 1000e18, 5000e18);
        // 3 honest sources clustered within ±0.5%.
        uint256[5] memory prices;
        prices[0] = base;
        prices[1] = base + base / 500;
        prices[2] = base - base / 500;
        uint256 hLo = base - base / 500;
        uint256 hHi = base + base / 500;
        // 2 attacker outliers, arbitrary.
        prices[3] = bound(lo, 1, 1e30);
        prices[4] = bound(hi, 1, 1e30);
        _setAll(prices);

        uint256 m = oracle.priceWad(ASSET);
        assertGe(m, hLo, "outlier dragged median below honest range");
        assertLe(m, hHi, "outlier dragged median above honest range");
    }

    /// Below-quorum fresh sources always trip the breaker, never return a value.
    function testFuzz_belowQuorumTripsBreaker(uint8 freshCount) public {
        uint256 n = bound(freshCount, 0, 2); // < quorum (3)
        for (uint256 i; i < 5; ++i) {
            srcs[i].set(4000e18, i < n ? block.timestamp : 1); // stale rest beyond n
        }
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, ASSET));
        oracle.priceWad(ASSET);
    }
}
