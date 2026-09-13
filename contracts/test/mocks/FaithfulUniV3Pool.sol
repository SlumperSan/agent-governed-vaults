// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal ERC20 exposing only `decimals()` — the whole of the surface
/// `UniswapV3TwapSource`'s constructor reads from a token.
contract Erc20Stub {
    uint8 public immutable decimals;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }
}

/// @title FaithfulUniV3Pool — a Uniswap V3 pool mock built on a TRUE fixed-size circular
/// observation ring, a line-for-line port of v3-core `Oracle.sol`
/// (`initialize`/`grow`/`transform`/`write`/`observeSingle`/`getSurroundingObservations`/
/// `binarySearch`/`lte`).
///
/// ## Why this exists (re-verification of audit finding H-3)
///
/// The repo's `test/mocks/OracleSourceMocks.sol::MockV3Pool` and the audit's own reference
/// `test/audit/AuditTwapSpotDegeneration.t.sol::FaithfulV3Pool` both model observations as an
/// ever-GROWING array whose write pointer is pinned at `length - 1` and whose
/// `observationCardinality == length`. Under that shape the source's oldest-observation lookup
///
///     oldestIndex = (observationIndex + 1) % cardinality
///
/// ALWAYS resolves to slot 0 — which happens to be the true oldest — so the modular-wrap branch
/// of `UniswapV3TwapSource._meanTick` / `_poolServesWindow` is never actually exercised. This
/// mock uses a genuine modular write pointer: after more than `cardinality` writes the ring
/// wraps and the true oldest sits at a NON-ZERO index that is neither slot 0 nor `index+1==len`.
/// That is the fidelity dimension the prior mocks structurally cannot reach.
///
/// The `transform`-from-newest-at-current-tick behaviour that finding H-2 turns on is reproduced
/// exactly: the `secondsAgo == 0` endpoint (and any endpoint at or after the newest stored
/// observation) is synthesised from the newest observation using the LIVE tick, giving that tick
/// a weight of `(now - newestTs) / window` in the reported mean.
contract FaithfulUniV3Pool {
    struct Obs {
        uint32 blockTimestamp;
        int56 tickCumulative;
        // v3-core also stores secondsPerLiquidityCumulativeX128; the source never reads it.
        bool initialized;
    }

    address public token0;
    address public token1;
    uint24 public fee = 500;

    /// @dev slot0's LIVE tick — what an in-block swap moves, and what `transform` extrapolates
    /// the newest observation forward at.
    int24 public tick;
    uint16 public observationIndex;
    uint16 public observationCardinality;
    uint16 public observationCardinalityNext;

    /// @dev A true ring: slot i is `_ring[i]`, i in [0, observationCardinalityNext).
    mapping(uint256 => Obs) internal _ring;

    bool public observeReverts;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    // ------------------------------------------------------------------------------------------
    // v3-core Oracle.sol — faithful port
    // ------------------------------------------------------------------------------------------

    /// @dev `Oracle.transform`: extrapolate `last` to `blockTimestamp` at tick `t`.
    function _transform(Obs memory last, uint32 blockTimestamp, int24 t) internal pure returns (Obs memory) {
        uint32 delta = blockTimestamp - last.blockTimestamp;
        return Obs(blockTimestamp, last.tickCumulative + int56(t) * int56(uint56(delta)), true);
    }

    /// @dev `Oracle.initialize`.
    function initialize(uint32 time, int24 tick_) public {
        _ring[0] = Obs(time, 0, true);
        observationIndex = 0;
        observationCardinality = 1;
        observationCardinalityNext = 1;
        tick = tick_;
    }

    /// @dev `Oracle.grow`.
    function grow(uint16 next) public {
        require(next >= observationCardinalityNext, "grow: shrink");
        for (uint16 i = observationCardinalityNext; i < next; i++) {
            // v3-core marks the slot non-zero so the store is warmed, but leaves it
            // uninitialized so it is never mistaken for real history.
            _ring[i].blockTimestamp = 1;
        }
        observationCardinalityNext = next;
    }

    /// @dev `Oracle.write` — advance the ring by one observation stamping tick `t` at `time`.
    /// At most one write per block (dedup on timestamp); grows the active cardinality exactly
    /// when the pointer laps the current end.
    function _write(uint32 time, int24 t) internal {
        Obs memory last = _ring[observationIndex];
        if (last.blockTimestamp == time) return;

        uint16 cardinalityUpdated;
        if (
            observationCardinalityNext > observationCardinality
                && observationIndex == observationCardinality - 1
        ) {
            cardinalityUpdated = observationCardinalityNext;
        } else {
            cardinalityUpdated = observationCardinality;
        }
        uint16 indexUpdated = uint16((uint256(observationIndex) + 1) % cardinalityUpdated);
        _ring[indexUpdated] = _transform(last, time, t);
        observationIndex = indexUpdated;
        observationCardinality = cardinalityUpdated;
    }

    /// @dev `Oracle.lte` — timestamp ordering that is correct across the uint32 rollover.
    function _lte(uint32 time, uint32 a, uint32 b) internal pure returns (bool) {
        if (a <= time && b <= time) return a <= b;
        uint256 aAdjusted = a > time ? a : a + 2 ** 32;
        uint256 bAdjusted = b > time ? b : b + 2 ** 32;
        return aAdjusted <= bAdjusted;
    }

    /// @dev `Oracle.binarySearch`.
    function _binarySearch(uint32 time, uint32 target)
        internal
        view
        returns (Obs memory beforeOrAt, Obs memory atOrAfter)
    {
        uint256 l = (uint256(observationIndex) + 1) % observationCardinality;
        uint256 r = l + observationCardinality - 1;
        uint256 i;
        while (true) {
            i = (l + r) / 2;
            beforeOrAt = _ring[i % observationCardinality];
            if (!beforeOrAt.initialized) {
                l = i + 1;
                continue;
            }
            atOrAfter = _ring[(i + 1) % observationCardinality];
            bool targetAtOrAfter = _lte(time, beforeOrAt.blockTimestamp, target);
            if (targetAtOrAfter && _lte(time, target, atOrAfter.blockTimestamp)) break;
            if (!targetAtOrAfter) r = i - 1;
            else l = i + 1;
        }
    }

    /// @dev `Oracle.getSurroundingObservations`.
    function _getSurroundingObservations(uint32 time, uint32 target)
        internal
        view
        returns (Obs memory beforeOrAt, Obs memory atOrAfter)
    {
        beforeOrAt = _ring[observationIndex];
        if (_lte(time, beforeOrAt.blockTimestamp, target)) {
            if (beforeOrAt.blockTimestamp == target) {
                return (beforeOrAt, beforeOrAt);
            }
            // Newest stored observation is at or before the target: SYNTHESISE the endpoint
            // from it using the CURRENT tick. This is the whole of H-2's mechanism.
            return (beforeOrAt, _transform(beforeOrAt, target, tick));
        }

        beforeOrAt = _ring[(uint256(observationIndex) + 1) % observationCardinality];
        if (!beforeOrAt.initialized) beforeOrAt = _ring[0];
        require(_lte(time, beforeOrAt.blockTimestamp, target), "OLD");

        return _binarySearch(time, target);
    }

    /// @dev `Oracle.observeSingle`.
    function _observeSingle(uint32 time, uint32 secondsAgo) internal view returns (int56) {
        if (secondsAgo == 0) {
            Obs memory last = _ring[observationIndex];
            if (last.blockTimestamp != time) last = _transform(last, time, tick);
            return last.tickCumulative;
        }
        uint32 target = time - secondsAgo;
        (Obs memory beforeOrAt, Obs memory atOrAfter) = _getSurroundingObservations(time, target);

        if (target == beforeOrAt.blockTimestamp) {
            return beforeOrAt.tickCumulative;
        } else if (target == atOrAfter.blockTimestamp) {
            return atOrAfter.tickCumulative;
        } else {
            uint32 observationTimeDelta = atOrAfter.blockTimestamp - beforeOrAt.blockTimestamp;
            uint32 targetDelta = target - beforeOrAt.blockTimestamp;
            // v3-core order EXACTLY: divide the cumulative slope first (truncating toward zero),
            // THEN scale. Reordering to `* targetDelta / delta` would change the low-order tick.
            return beforeOrAt.tickCumulative
                + ((atOrAfter.tickCumulative - beforeOrAt.tickCumulative)
                    / int56(uint56(observationTimeDelta))) * int56(uint56(targetDelta));
        }
    }

    // ------------------------------------------------------------------------------------------
    // IUniswapV3PoolMinimal surface
    // ------------------------------------------------------------------------------------------

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, tick, observationIndex, observationCardinality, observationCardinalityNext, 0, true);
    }

    function observations(uint256 index) external view returns (uint32, int56, uint160, bool) {
        Obs memory o = _ring[index];
        return (o.blockTimestamp, o.tickCumulative, 0, o.initialized);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!observeReverts, "OLD");
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        uint32 time = uint32(block.timestamp);
        for (uint256 i; i < secondsAgos.length; ++i) {
            tickCumulatives[i] = _observeSingle(time, secondsAgos[i]);
        }
    }

    // ------------------------------------------------------------------------------------------
    // test-driving helpers
    // ------------------------------------------------------------------------------------------

    /// @notice Build a genuinely WRAPPED ring at a single constant tick. `numWrites` observations
    /// are written `step` seconds apart, ending exactly at `endTs`; with `numWrites > cardinality`
    /// the ring laps and the retained oldest lands at a non-zero index. Retained history spans
    /// `(cardinality - 1) * step` seconds back from `endTs`.
    function seedWrappedConstant(int24 tick_, uint32 endTs, uint32 step, uint16 cardinality, uint16 numWrites)
        external
    {
        uint32 startTs = endTs - uint32(numWrites) * step;
        initialize(startTs, tick_);
        grow(cardinality);
        for (uint16 j = 1; j <= numWrites; j++) {
            _write(startTs + uint32(j) * step, tick_);
        }
    }

    /// @notice Append one observation at `ts` stamping the CURRENT live tick (a "trade at the
    /// prevailing tick"). Used to build multi-regime histories.
    function writeObservation(uint32 ts) external {
        _write(ts, tick);
    }

    /// @notice Move the live tick WITHOUT writing an observation — models "the tick is here and
    /// nothing has traded since the newest observation". This is the axis H-2 lives on; it is
    /// NOT reachable by a real swap (see `swap`).
    function setLiveTick(int24 t) external {
        tick = t;
    }

    /// @notice A faithful swap: v3-core `UniswapV3Pool.swap` writes the observation with the
    /// PRE-swap tick at `block.timestamp` and only then moves `slot0.tick`. The manipulating
    /// swap therefore stamps the honest pre-swap tick AND resets `now - newestTs` to zero in the
    /// same call — which is exactly why an atomic single-block TWAP manipulation is impossible.
    function swap(uint32 ts, int24 newTick) external {
        _write(ts, tick); // pre-swap tick
        tick = newTick;
    }

    function setObserveReverts(bool v) external {
        observeReverts = v;
    }
}
