// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title FullMath — 512-bit multiply-then-divide
/// @notice VENDORED THIRD-PARTY CODE. Derived from Uniswap v3-core `FullMath.sol`
/// (https://github.com/Uniswap/v3-core, `contracts/libraries/FullMath.sol`), whose SPDX
/// license identifier is **MIT** — reproduced in this file's header above. That license is
/// preserved on this file and is independent of the licence on the rest of this repository,
/// which is MIT since 2026-09-05 and was BUSL-1.1 before it; see the header of every other file
/// and LICENSE-HISTORY.md.
///
/// @dev Port notes for solc 0.8.26 (the original targets 0.7.6):
/// - the whole body is `unchecked`: the algorithm relies on wrapping arithmetic, and 0.8's
///   default checked math would revert on the intermediate `prod0 - remainder` and on
///   `denominator * inv` during Newton–Raphson inversion;
/// - `-denominator` is written `0 - denominator` for the same reason;
/// - the original's bare `require(...)` calls became custom errors. Every one of them is a
///   genuine overflow/zero-divisor condition, and every caller in this repo reaches this
///   library from inside a `try/catch` (see `UniswapV3TwapSource.latestPrice`), so a revert
///   here degrades a price source to "not fresh" rather than propagating.
library FullMath {
    error DivByZero();
    error MulDivOverflow();

    /// @notice Calculates floor(a×b÷denominator) with full precision — the intermediate
    /// product may exceed 2²⁵⁶ as long as the result does not.
    /// @param a the multiplicand
    /// @param b the multiplier
    /// @param denominator the divisor (must be non-zero, and greater than the high 256 bits
    /// of a×b)
    /// @return result floor(a×b÷denominator)
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            // 512-bit multiply [prod1 prod0] = a * b.
            uint256 prod0; // least significant 256 bits
            uint256 prod1; // most significant 256 bits
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            // Fast path: the product fits in 256 bits.
            if (prod1 == 0) {
                if (denominator == 0) revert DivByZero();
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }

            // The result must fit in 256 bits; this also covers denominator == 0.
            if (denominator <= prod1) revert MulDivOverflow();

            // Subtract the 512-bit remainder from the 512-bit product.
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            // Factor the powers of two out of the denominator, then shift the product right
            // by the same amount — the quotient is unchanged and the denominator becomes odd.
            uint256 twos = denominator & (0 - denominator);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                // Flip `twos` into the multiplier that shifts prod1's bits into prod0.
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;

            // Invert the (now odd) denominator mod 2²⁵⁶ by Newton–Raphson: correct to 4 bits
            // by seed, then doubling to 8, 16, 32, 64, 128, 256.
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;

            // Because the division is now exact, multiplying by the modular inverse gives the
            // exact quotient.
            result = prod0 * inv;
            return result;
        }
    }
}
