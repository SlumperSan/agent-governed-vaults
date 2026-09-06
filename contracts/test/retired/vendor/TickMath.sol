// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/// @title TickMath — tick → √price conversion
/// @notice VENDORED THIRD-PARTY CODE. Derived from Uniswap v3-core `TickMath.sol`
/// (https://github.com/Uniswap/v3-core, `contracts/libraries/TickMath.sol`), whose SPDX
/// license identifier is **GPL-2.0-or-later** — reproduced in this file's header above. It
/// applies to this file only; the rest of this repository is MIT (BUSL-1.1 until 2026-09-05,
/// see LICENSE-HISTORY.md). Keeping the vendored code in its own file, under its own header, is
/// what keeps that boundary legible — do not inline these constants into an MIT file. The
/// relicense did not dissolve the boundary: GPL-2.0-or-later is not MIT either.
///
/// @dev Only the `tick → sqrtPriceX96` direction is vendored; `getTickAtSqrtRatio` is not
/// needed by any consumer here and is omitted rather than carried unused and unreviewed.
///
/// Port notes for solc 0.8.26 (the original targets 0.7.6):
/// - the body is `unchecked`: every step is deliberate wrapping/truncating fixed-point
///   arithmetic, and `type(uint256).max / ratio` plus the Q128.128 multiplies would otherwise
///   carry pointless checked-math overhead;
/// - `abs(tick)` is computed via `int256` because negating `type(int24).min` overflows int24;
/// - the original's `require(absTick <= MAX_TICK, 'T')` became a custom error.
///
/// The 20 magic constants are Q128.128 fixed-point values of √1.0001^(2^i). They were
/// verified for this repository against an independent 120-decimal-digit reference
/// implementation of `round(√(1.0001^t) · 2⁹⁶)` over 685 ticks spanning the full range: the
/// maximum relative deviation is 2.3e-10, at the extreme tick. `TickMathFixture.t.sol` pins
/// the resulting values, including the two canonical endpoints below.
library TickMath {
    error TickOutOfRange();

    /// @dev Minimum tick that may be passed to `getSqrtRatioAtTick`.
    int24 internal constant MIN_TICK = -887272;
    /// @dev Maximum tick that may be passed to `getSqrtRatioAtTick`.
    int24 internal constant MAX_TICK = -MIN_TICK;

    /// @dev `getSqrtRatioAtTick(MIN_TICK)`.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    /// @dev `getSqrtRatioAtTick(MAX_TICK)`.
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// @notice Calculates √(1.0001^tick) · 2⁹⁶.
    /// @dev Accurate to within a few units in the last place — never exact. Callers must not
    /// treat the output as a lossless round-trip of `tick`.
    /// @param tick the tick to convert; |tick| ≤ MAX_TICK
    /// @return sqrtPriceX96 the √price as a Q64.96, in [MIN_SQRT_RATIO, MAX_SQRT_RATIO]
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            // int256 first: negating type(int24).min is not representable in int24.
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            if (absTick > uint256(int256(MAX_TICK))) revert TickOutOfRange();

            // Q128.128 accumulator, seeded with √1.0001^1 when bit 0 is set, else 1.0.
            uint256 ratio =
                absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            // The loop above computed √1.0001^(-|tick|); invert for positive ticks.
            if (tick > 0) ratio = type(uint256).max / ratio;

            // Q128.128 → Q64.96, rounding up so the result never understates the ratio.
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}
