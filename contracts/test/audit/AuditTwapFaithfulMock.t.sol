// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UniswapV3TwapSource, IUniswapV3PoolMinimal} from "../../src/oracle/UniswapV3TwapSource.sol";
import {TickMath} from "../../src/oracle/vendor/TickMath.sol";
import {FaithfulUniV3Pool, Erc20Stub} from "../mocks/FaithfulUniV3Pool.sol";

/// @notice AUDIT RE-VERIFICATION of findings H-2 and H-3.
///
/// H-3 says the repo's own V3 mock makes H-2's defect class undetectable. Both the repo mock
/// (`OracleSourceMocks.sol::MockV3Pool`) and the audit's reference (`FaithfulV3Pool`) model the
/// observation ring as an ever-GROWING array with the write pointer pinned at the end, so the
/// source's oldest-observation lookup `(observationIndex + 1) % cardinality` always resolves to
/// slot 0 — the modular-wrap branch is never exercised.
///
/// This file drives the FIXED `UniswapV3TwapSource` against `FaithfulUniV3Pool`, a line-for-line
/// port of v3-core `Oracle.sol` on a TRUE fixed-size circular ring. After more writes than the
/// cardinality, the ring laps and the retained oldest sits at a non-zero index that is neither
/// slot 0 nor the newest — the fidelity dimension the prior mocks cannot reach. Every H-2 guard
/// is then re-checked against genuinely faithful semantics.
contract AuditTwapFaithfulMockTest is Test {
    uint32 constant WINDOW = 1800; // 30 min, base-mainnet.json twapDefaults.windowSeconds
    uint16 constant MIN_CARD = 10;
    uint32 constant MAX_OBS_AGE = 90; // == WINDOW / MAX_LIVE_TICK_WEIGHT_DIVISOR (1800/20)

    // asset = token0, tick negative: the Base WETH/USDC shape. This exact tick has a golden
    // price fixture in test/UniswapV3TwapSource.t.sol produced by an independent 120-digit
    // reference, so reproducing it here cross-validates the whole path THROUGH the faithful ring.
    int24 constant WETH_TICK = -196267;
    uint256 constant WETH_GOLDEN_PRICE = 2996806154000000000000; // $2996.806154

    int24 constant MANIP_TICK = -230000; // a live tick pushed far below the honest one

    Erc20Stub weth; // 18 decimals, token0
    Erc20Stub usdc; // 6 decimals, token1

    function setUp() public {
        vm.warp(2_000_000);
        weth = new Erc20Stub(18);
        usdc = new Erc20Stub(6);
    }

    function _oneHop(FaithfulUniV3Pool pool) internal returns (UniswapV3TwapSource) {
        return new UniswapV3TwapSource(
            address(weth),
            address(usdc),
            IUniswapV3PoolMinimal(address(pool)),
            IUniswapV3PoolMinimal(address(0)),
            WINDOW,
            MIN_CARD,
            MAX_OBS_AGE
        );
    }

    /// A healthy WRAPPED ring: cardinality 12, 30 writes 180s apart ending now, constant tick.
    /// After 30 writes the pointer sits at index 6 and the oldest at index 7 — a real wrap.
    function _healthyWrapped(int24 tick) internal returns (FaithfulUniV3Pool p) {
        p = new FaithfulUniV3Pool(address(weth), address(usdc));
        p.seedWrappedConstant(tick, uint32(block.timestamp), 180, 12, 30);
    }

    // ==========================================================================================
    // (A) The faithful ring reproduces the golden price — the path works end to end
    // ==========================================================================================

    /// @notice The source, reading a GENUINELY WRAPPED ring, reproduces the independently-derived
    /// golden price for tick -196267 exactly. Read at A = 0 (now == newest observation), so both
    /// `observe` endpoints land on stored observations and no interpolation truncation enters.
    function test_faithfulWrappedRing_reproducesGoldenPriceAtConstantTick() public {
        FaithfulUniV3Pool pool = _healthyWrapped(WETH_TICK);

        // Prove the ring actually wrapped: pointer is interior, not pinned at the array end.
        assertEq(pool.observationIndex(), 6, "ring must have lapped to an interior index");
        assertEq(pool.observationCardinality(), 12, "active cardinality is the ring size");

        UniswapV3TwapSource src = _oneHop(pool);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, WETH_GOLDEN_PRICE, "wrapped ring reproduces the golden TWAP price");
        assertEq(t, block.timestamp, "A == 0: newest observation is now");
        assertTrue(src.assetIsToken0A(), "asset detected as token0");
    }

    /// @notice The differentiator, made explicit. On this wrapped ring the TRUE oldest is at the
    /// initialized slot `(index + 1) % cardinality == 7`, while slot 0 has been OVERWRITTEN to a
    /// YOUNGER timestamp. A mock that pins the write pointer at the array end (the repo mock and
    /// `FaithfulV3Pool`) can never produce this state — there slot 0 is always the true oldest, so
    /// the modular index and slot 0 coincide and the lookup is untested. Here they DIVERGE: this
    /// asserts the source resolves the modular index to the genuine oldest (age 1980s, which
    /// clears the 1800s window) rather than to slot 0 (age ~1080s, which would not), and that the
    /// wrapped-ring price still equals the golden value. The source's own slot-0 fallback fires
    /// only when the modular slot is uninitialized, which is not this case; the slot-0 age is
    /// shown purely to prove the two slots genuinely differ on a lapped ring.
    function test_faithfulWrappedRing_exercisesModularOldestLookup() public {
        FaithfulUniV3Pool pool = _healthyWrapped(WETH_TICK);

        uint256 oldestIdx = (uint256(pool.observationIndex()) + 1) % pool.observationCardinality();
        assertEq(oldestIdx, 7, "true oldest is at a non-zero, non-terminal index");

        (uint32 trueOldestTs,,, bool initTrue) = pool.observations(oldestIdx);
        (uint32 slot0Ts,,, bool initSlot0) = pool.observations(0);
        assertTrue(initTrue && initSlot0, "both slots are live in a wrapped ring");

        // The state the prior mocks could not set: on a lapped ring slot 0 is STRICTLY YOUNGER
        // than the real oldest, so the modular index and slot 0 no longer coincide.
        assertGt(slot0Ts, trueOldestTs, "slot 0 has been overwritten to a younger observation");
        assertEq(uint256(block.timestamp) - trueOldestTs, 1980, "modular oldest covers the window");
        assertLt(uint256(block.timestamp) - slot0Ts, WINDOW, "slot 0's own age would not cover it");

        // And the source prices — it resolved the modular index to the genuine oldest.
        UniswapV3TwapSource src = _oneHop(pool);
        (uint256 p,) = src.latestPrice();
        assertEq(p, WETH_GOLDEN_PRICE, "source read the modular oldest, not slot 0");
    }

    // ==========================================================================================
    // (B) Window longer than the ring can cover — against a ring that ACTUALLY wrapped
    // ==========================================================================================

    /// @notice A ring with enough cardinality (>= MIN_CARD) but too SHORT a retained span: 10
    /// slots 180s apart cover only 1620s, less than the 1800s window. The ring genuinely wraps
    /// (pointer at index 0, oldest at index 1 — slot 0 is now the NEWEST). The constructor's
    /// `_poolServesWindow` must reject it, because `observe([window,0])` would otherwise
    /// extrapolate the missing 180s from the live tick. Prior mocks faked this by stamping
    /// `oldestTs` directly; here the shortfall arises from real ring geometry.
    function test_lowCardinalityWrappedRing_constructorRejectsUncoveredWindow() public {
        FaithfulUniV3Pool pool = new FaithfulUniV3Pool(address(weth), address(usdc));
        pool.seedWrappedConstant(WETH_TICK, uint32(block.timestamp), 180, 10, 30);

        // Cardinality clears the floor, so the rejection is about window coverage, not card.
        assertGe(pool.observationCardinality(), MIN_CARD, "cardinality clears the floor");
        assertEq(pool.observationIndex(), 0, "pointer wrapped back onto slot 0");
        uint256 oldestIdx = (uint256(pool.observationIndex()) + 1) % pool.observationCardinality();
        (uint32 oldestTs,,,) = pool.observations(oldestIdx);
        assertLt(uint256(block.timestamp) - oldestTs, WINDOW, "retained history is shorter than window");

        vm.expectRevert(UniswapV3TwapSource.BadTwapConfig.selector);
        _oneHop(pool);
    }

    // ==========================================================================================
    // (C) H-2 core: the live-tick weight ceiling actually bites
    // ==========================================================================================

    /// @notice A pool quiet for longer than the window would, in v3-core, have EVERY `observe`
    /// endpoint synthesised from one stored observation at the current tick — the mean tick would
    /// BE the live, single-block tick. The fixed source withholds instead of reporting it, and
    /// casts no vote. Manipulating the live tick changes nothing, because nothing is reported.
    function test_h2_quietBeyondCeiling_withholdsInsteadOfCollapsingToLiveTick() public {
        FaithfulUniV3Pool pool = _healthyWrapped(WETH_TICK);
        UniswapV3TwapSource src = _oneHop(pool);
        assertGt(src.computePriceWad(), 0, "healthy wrapped pool prices");

        vm.warp(block.timestamp + 2000); // quiet longer than WINDOW; A = 2000 > ceiling (90)
        pool.setLiveTick(MANIP_TICK);

        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0, "withholds a live-tick 'TWAP'");
        assertEq(t, 0, "and does not vote");
        vm.expectRevert(UniswapV3TwapSource.TwapPoolNotUsable.selector);
        src.computePriceWad();
    }

    /// @notice For EVERY live tick an attacker could hold on a pool quiet past the ceiling, the
    /// source offers no price. The complement of the bounded-influence test below.
    function testFuzz_h2_quietBeyondCeiling_withholdsForAnyLiveTick(int24 liveTick) public {
        liveTick = int24(bound(int256(liveTick), -600000, 600000));
        FaithfulUniV3Pool pool = _healthyWrapped(WETH_TICK);
        UniswapV3TwapSource src = _oneHop(pool);

        vm.warp(block.timestamp + 2000);
        pool.setLiveTick(liveTick);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0, "no price whatever the live tick");
        assertEq(t, 0, "and no timestamp");
    }

    /// @notice The useful half: INSIDE the ceiling the source still prices, and the live tick's
    /// contribution is bounded to ~5% of the window — a fix that merely withheld everywhere would
    /// be useless. At A == 90 (exactly the ceiling) a live tick pushed far below honest moves the
    /// reported price by a bounded amount, never a collapse; one second past the ceiling it
    /// withholds.
    function test_h2_insideCeiling_pricesWithBoundedLiveTickInfluence() public {
        FaithfulUniV3Pool pool = _healthyWrapped(WETH_TICK);
        UniswapV3TwapSource src = _oneHop(pool);
        uint256 honest = src.computePriceWad();
        assertGt(honest, 0, "healthy price");

        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + MAX_OBS_AGE); // A == 90, the ceiling
        pool.setLiveTick(MANIP_TICK);
        uint256 reported = src.computePriceWad();
        assertGt(reported, 0, "still prices inside the ceiling");
        assertLt(reported, honest, "the 5% is real: the manipulated tick moved the price");
        assertGt(reported, honest * 80 / 100, "but the move is bounded, not a collapse");
        vm.revertToState(snap);

        // One second past the ceiling: withheld.
        vm.warp(block.timestamp + MAX_OBS_AGE + 1);
        pool.setLiveTick(MANIP_TICK);
        vm.expectRevert(UniswapV3TwapSource.TwapPoolNotUsable.selector);
        src.computePriceWad();
    }

    // ==========================================================================================
    // (D) The refutation (H-2 "corrected scope") holds on the faithful ring
    // ==========================================================================================

    /// @notice An atomic single-block manipulation is impossible even on a quiet pool: a real
    /// swap writes an observation stamped with the PRE-swap tick at `block.timestamp` and resets
    /// `A` to zero in the same call. So within the manipulating block the reported price is
    /// unchanged. This reproduces the audit's self-refutation against genuinely faithful ring
    /// semantics (not a `setLiveTick` shortcut).
    function test_refuted_atomicSwapCannotMoveTheTwapInTheSameBlock() public {
        FaithfulUniV3Pool pool = _healthyWrapped(WETH_TICK);
        UniswapV3TwapSource src = _oneHop(pool);

        vm.warp(block.timestamp + 60); // quiet, but inside the ceiling so it still prices
        uint256 honest = src.computePriceWad();
        assertGt(honest, 0, "prices before the swap");

        pool.swap(uint32(block.timestamp), MANIP_TICK); // a REAL swap, this block

        assertEq(src.computePriceWad(), honest, "atomic swap does not move the reported TWAP");
    }

    // ==========================================================================================
    // (E) Multi-observation interpolation — the property a 2-slot mock cannot represent
    // ==========================================================================================

    /// @notice A two-regime history across MANY stored observations, read with a window boundary
    /// that lands BETWEEN observations so v3's per-segment interpolation is genuinely exercised.
    /// The reported price must equal a TWAP of the time-weighted blended tick. The repo's
    /// `MockV3Pool` stores only two observations and cannot represent a mid-window regime change
    /// at all, so this correctness property has never been under test.
    function test_multiObservationInterpolationIsTimeWeighted() public {
        // 40 writes, 175s apart (does NOT divide the 1800s window), cardinality 16 -> wraps.
        // First 35 writes at WETH_TICK, last 5 at a higher tick: the higher regime spans the
        // most recent 875s, the lower regime the 925s before it, within the window.
        int24 tickHigh = -190000;
        FaithfulUniV3Pool pool = new FaithfulUniV3Pool(address(weth), address(usdc));
        _buildTwoRegime(pool, WETH_TICK, tickHigh, 175, 16, 40, 35);

        UniswapV3TwapSource src = _oneHop(pool);
        uint256 reported = src.computePriceWad();

        // Time-weighted blend WITHIN the window [now-1800, now]: high tick over 875s, low over 925s.
        int24 blended = int24((int256(WETH_TICK) * 925 + int256(tickHigh) * 875) / int256(uint256(WINDOW)));

        uint256 refLow = _refConstant(WETH_TICK);
        uint256 refHigh = _refConstant(tickHigh);
        uint256 refBlend = _refConstant(blended);

        // asset == token0, so higher tick => higher price: the blend sits strictly between.
        assertGt(reported, refLow, "above the pure low-tick TWAP");
        assertLt(reported, refHigh, "below the pure high-tick TWAP");
        assertApproxEqRel(reported, refBlend, 1e15, "matches the time-weighted blended TWAP (0.1%)");
    }

    /// @dev Reference price: a fresh wrapped pool trading at a single constant tick.
    function _refConstant(int24 tick) internal returns (uint256) {
        FaithfulUniV3Pool ref = new FaithfulUniV3Pool(address(weth), address(usdc));
        ref.seedWrappedConstant(tick, uint32(block.timestamp), 175, 16, 40);
        return _oneHop(ref).computePriceWad();
    }

    /// @dev Build a wrapped two-regime history ending now: writes [1..switchAt] at `tickA`,
    /// writes (switchAt..numWrites] at `tickB`.
    function _buildTwoRegime(
        FaithfulUniV3Pool pool,
        int24 tickA,
        int24 tickB,
        uint32 step,
        uint16 cardinality,
        uint16 numWrites,
        uint16 switchAt
    ) internal {
        uint32 startTs = uint32(block.timestamp) - uint32(numWrites) * step;
        pool.initialize(startTs, tickA);
        pool.grow(cardinality);
        for (uint16 j = 1; j <= numWrites; j++) {
            if (j == switchAt + 1) pool.setLiveTick(tickB);
            pool.writeObservation(startTs + uint32(j) * step);
        }
    }
}
