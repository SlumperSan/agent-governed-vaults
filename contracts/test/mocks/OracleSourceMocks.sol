// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPyth} from "../../src/oracle/PythSource.sol";
import {IAggregatorV3} from "../../src/OracleAggregator.sol";

/// @notice Uniswap V3 pool stub for the Sprint-11 TWAP source. Exposes the whole observation
/// ring as writable state so a test can construct the pathological pools the guards exist for:
/// a single-slot pool, a pool that stopped trading, a pool whose oldest observation is younger
/// than the requested window.
///
/// Two `observe()` modes:
///  - **linear** (default) — cumulatives are generated from a single configured `tick`, so the
///    arithmetic mean over any window is exactly that tick. Used for the price fixtures.
///  - **raw** — `observe()` returns two pinned `tickCumulative` values verbatim. Used for the
///    mean-tick rounding cases, where the point is a delta that does *not* divide the window.
contract MockV3Pool {
    struct Obs {
        uint32 blockTimestamp;
        int56 tickCumulative;
        uint160 secondsPerLiquidityX128;
        bool initialized;
    }

    address public token0;
    address public token1;
    uint24 public fee;

    int24 public tick;
    uint16 public observationIndex;
    uint16 public observationCardinality;
    mapping(uint256 => Obs) internal _obs;

    bool public rawMode;
    int56 public rawOldest;
    int56 public rawNewest;
    bool public observeReverts;

    constructor(address token0_, address token1_, uint24 fee_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    /// @notice Set the tick the linear cumulative model averages to.
    function setTick(int24 tick_) external {
        tick = tick_;
    }

    /// @notice Shape the observation ring: `cardinality` slots, newest at `index` stamped
    /// `newestTs`, oldest (the slot after `index`) stamped `oldestTs` and initialized.
    function setRing(uint16 cardinality, uint16 index, uint32 oldestTs, uint32 newestTs) external {
        observationCardinality = cardinality;
        observationIndex = index;
        _obs[index] = Obs(newestTs, 0, 0, true);
        uint256 oldestIndex = (uint256(index) + 1) % cardinality;
        _obs[oldestIndex] = Obs(oldestTs, 0, 0, true);
    }

    /// @notice Un-initialize the ring's nominal oldest slot, forcing the source down its
    /// "ring has not wrapped yet, slot 0 is oldest" branch, with slot 0 stamped `slot0Ts`.
    function setUnwrappedRing(uint16 cardinality, uint16 index, uint32 slot0Ts, uint32 newestTs) external {
        observationCardinality = cardinality;
        observationIndex = index;
        _obs[index] = Obs(newestTs, 0, 0, true);
        uint256 oldestIndex = (uint256(index) + 1) % cardinality;
        _obs[oldestIndex] = Obs(0, 0, 0, false);
        _obs[0] = Obs(slot0Ts, 0, 0, true);
    }

    /// @notice Return these two cumulatives from `observe()` verbatim (oldest first).
    function setRawCumulatives(int56 oldest, int56 newest) external {
        rawMode = true;
        rawOldest = oldest;
        rawNewest = newest;
    }

    function setObserveReverts(bool reverts_) external {
        observeReverts = reverts_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, tick, observationIndex, observationCardinality, observationCardinality, 0, true);
    }

    function observations(uint256 index) external view returns (uint32, int56, uint160, bool) {
        Obs memory o = _obs[index];
        return (o.blockTimestamp, o.tickCumulative, o.secondsPerLiquidityX128, o.initialized);
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory) {
        require(!observeReverts, "OLD");
        int56[] memory tc = new int56[](secondsAgos.length);
        uint160[] memory sl = new uint160[](secondsAgos.length);
        if (rawMode) {
            require(secondsAgos.length == 2, "raw mode expects 2");
            tc[0] = rawOldest;
            tc[1] = rawNewest;
            return (tc, sl);
        }
        // Linear model: cumulative(t) = tick * t, so any window averages to exactly `tick`.
        for (uint256 i; i < secondsAgos.length; ++i) {
            tc[i] = int56(tick) * int56(uint56(uint32(block.timestamp) - secondsAgos[i]));
        }
        return (tc, sl);
    }
}

/// @notice Pyth stub. `getPriceUnsafe` ignores the id (the source pins exactly one) but can be
/// switched to revert, which is how a never-populated feed behaves on a real deployment.
contract MockPyth {
    IPyth.Price internal _price;
    bool public reverts;

    constructor(int64 price_, uint64 conf_, int32 expo_, uint256 publishTime_) {
        _price = IPyth.Price(price_, conf_, expo_, publishTime_);
    }

    function set(int64 price_, uint64 conf_, int32 expo_, uint256 publishTime_) external {
        _price = IPyth.Price(price_, conf_, expo_, publishTime_);
    }

    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    function getPriceUnsafe(bytes32) external view returns (IPyth.Price memory) {
        require(!reverts, "PriceFeedNotFound");
        return _price;
    }
}

/// @notice Chainlink AggregatorV3 stub — the push mechanism class in the mixed-source
/// integration tests. `Mocks.sol` has no AggregatorV3 stub because nothing before Sprint 11
/// exercised `ChainlinkSourceAdapter` end to end.
contract MockAggregatorV3 is IAggregatorV3 {
    uint8 internal _decimals;
    int256 internal _answer;
    uint256 internal _updatedAt;
    bool public reverts;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        _decimals = decimals_;
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverts, "feed down");
        return (1, _answer, _updatedAt, _updatedAt, 1);
    }
}
