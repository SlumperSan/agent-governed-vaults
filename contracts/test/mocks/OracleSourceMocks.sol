// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPyth} from "../retired/PythSource.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

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

    /// @dev H-3: the tick that PREVAILED over stored history, as distinct from `tick`, which is
    /// slot0's LIVE tick. The old mock had no such distinction — it generated cumulatives from
    /// the live tick alone (`cumulative(t) = tick * t`), so any window averaged to exactly
    /// `tick` and a correct historical TWAP was numerically identical to a live-tick
    /// extrapolation. The mock's behaviour WAS the H-2 bug, which is why the entire Sprint-11
    /// oracle suite could not fail for that class.
    int24 public histTick;
    uint32 internal _newestTs;
    uint32 internal _oldestTs;
    bool internal _ringSet;

    constructor(address token0_, address token1_, uint24 fee_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    /// @notice Set BOTH the live tick and the historical tick, so a window averages to exactly
    /// `tick_` — the old mock's semantics, preserved verbatim for every existing test.
    function setTick(int24 tick_) external {
        tick = tick_;
        histTick = tick_;
    }

    /// @notice Move ONLY slot0's live tick, leaving stored history at `histTick`. This is the
    /// axis the old mock could not express, and the one H-2 lives on: with the newest
    /// observation `A` seconds old, the live tick's weight in the reported mean is exactly
    /// `min(A, W) / W`.
    function setLiveTick(int24 tick_) external {
        tick = tick_;
    }

    /// @notice Shape the observation ring: `cardinality` slots, newest at `index` stamped
    /// `newestTs`, oldest (the slot after `index`) stamped `oldestTs` and initialized.
    function setRing(uint16 cardinality, uint16 index, uint32 oldestTs, uint32 newestTs) external {
        observationCardinality = cardinality;
        observationIndex = index;
        histTick = tick; // history prevailed at the current tick unless setLiveTick moves it
        _newestTs = newestTs;
        _oldestTs = oldestTs;
        _ringSet = true;
        _obs[index] = Obs(newestTs, _cumAt(newestTs), 0, true);
        uint256 oldestIndex = (uint256(index) + 1) % cardinality;
        _obs[oldestIndex] = Obs(oldestTs, _cumAt(oldestTs), 0, true);
    }

    /// @dev Historical cumulative at `ts`, i.e. the integral of `histTick` up to `ts`.
    function _cumAt(uint32 ts) internal view returns (int56) {
        return int56(histTick) * int56(uint56(ts));
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
        for (uint256 i; i < secondsAgos.length; ++i) {
            uint32 target = uint32(block.timestamp) - secondsAgos[i];
            if (!_ringSet) {
                // No ring configured: fall back to the old linear model so fixtures that never
                // call setRing keep their exact previous behaviour.
                tc[i] = int56(tick) * int56(uint56(target));
                continue;
            }
            require(target >= _oldestTs, "OLD"); // v3 reverts when the window predates the ring
            if (target >= _newestTs) {
                // v3-core `observeSingle`: when the target is at or after the newest stored
                // observation, the endpoint is SYNTHESIZED from it using the CURRENT tick. This
                // is the whole of H-2 — the live tick leaks into a "historical" mean with
                // weight (target - newestTs) / window.
                tc[i] = _cumAt(_newestTs) + int56(tick) * int56(uint56(target - _newestTs));
            } else {
                tc[i] = _cumAt(target);
            }
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

    /// @dev The pair description, the way a real Chainlink proxy reports it ("ETH / USD"). Defaults
    /// to a USD-quoted string so every pre-existing fixture keeps passing {ChainlinkOracle}'s
    /// construction-time denomination check unchanged; `setDescription` is how a test builds the
    /// misconfigured feeds that check exists for (e.g. "CBETH / ETH").
    string internal _description = "MOCK / USD";

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        _decimals = decimals_;
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function setDescription(string memory description_) external {
        _description = description_;
    }

    /// @dev Change `decimals()` AFTER construction, the way a real Chainlink `EACAggregatorProxy`
    /// would if the aggregator swapped behind it reported a different precision. No genuine feed has
    /// ever been observed doing this (see AuditAggregatorSwapDrift.t.sol for the on-chain survey);
    /// the setter exists to prove what {ChainlinkOracle} does if one ever did.
    function setDecimals(uint8 decimals_) external {
        _decimals = decimals_;
    }

    function description() external view returns (string memory) {
        return _description;
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
