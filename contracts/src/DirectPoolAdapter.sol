// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IExecutionAdapter} from "./interfaces/IExecutionAdapter.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 ts);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IERC20Bal {
    function balanceOf(address) external view returns (uint256);
}

/// @title DirectPoolAdapter — swap directly against a Uniswap-V2-style pair
/// @notice A SECOND `IExecutionAdapter` implementation, proving the venue abstraction (C-2):
/// VaultCore.executeRebalance drives this exactly like the aggregation-router adapter, though the
/// venue shape is entirely different — no off-chain calldata, no selector allowlist, the amount
/// out is computed on-chain from the pair's reserves. The same safety contract holds: minOut and
/// deadline enforced HERE on the vault's measured balance delta (EX-3), per-swap approval, no
/// trust in any external return value.
///
/// Each adapter instance is pinned to one immutable pair — the analog of the aggregation
/// adapter's pinned router. A vault allow-lists whichever adapters (venues) its members accept.
contract DirectPoolAdapter is IExecutionAdapter {
    using SafeTransferLib for address;

    IUniswapV2Pair public immutable pair;
    address public immutable token0;
    address public immutable token1;
    uint256 public constant FEE_BPS = 30; // 0.30%, the canonical V2 fee

    event SwapExecuted(address indexed vault, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);

    error Expired();
    error BadOrder();
    error TokenNotInPair();
    error Slippage();

    constructor(IUniswapV2Pair pair_) {
        pair = pair_;
        token0 = pair_.token0();
        token1 = pair_.token1();
    }

    /// @inheritdoc IExecutionAdapter
    function executeSwap(SwapOrder calldata order) external returns (uint256 amountOut) {
        require(block.timestamp <= order.deadline, Expired());
        require(order.minAmountOut > 0 && order.amountIn > 0, BadOrder());
        require(order.tokenIn != order.tokenOut, BadOrder());

        bool inIs0 = order.tokenIn == token0;
        require(
            (inIs0 && order.tokenOut == token1) || (order.tokenIn == token1 && order.tokenOut == token0),
            TokenNotInPair()
        );

        order.tokenIn.safeTransferFrom(msg.sender, address(this), order.amountIn);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 reserveIn, uint256 reserveOut) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 quoted = _amountOut(order.amountIn, reserveIn, reserveOut);

        uint256 outBefore = IERC20Bal(order.tokenOut).balanceOf(address(this));
        order.tokenIn.safeTransfer(address(pair), order.amountIn); // V2 pulls from its own balance
        if (inIs0) pair.swap(0, quoted, address(this), "");
        else pair.swap(quoted, 0, address(this), "");
        amountOut = IERC20Bal(order.tokenOut).balanceOf(address(this)) - outBefore;

        // The check that matters: measured delta vs caller floor (EX-3) — never the quote.
        require(amountOut >= order.minAmountOut, Slippage());
        order.tokenOut.safeTransfer(msg.sender, amountOut);

        emit SwapExecuted(msg.sender, order.tokenIn, order.tokenOut, order.amountIn, amountOut);
    }

    /// @dev Constant-product amount-out with the 0.30% fee (Uniswap V2 formula).
    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        uint256 amountInWithFee = amountIn * (10_000 - FEE_BPS);
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 10_000 + amountInWithFee;
        return numerator / denominator;
    }
}
