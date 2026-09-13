// SPDX-License-Identifier: MIT
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

    event SwapExecuted(
        address indexed vault, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut
    );

    error Expired();
    error BadOrder();
    error TokenNotInPair();
    error Slippage();
    error Reentrancy();

    uint256 private _lock = 1;

    /// @dev Non-reentrancy is a property of the `IExecutionAdapter` contract itself, not of any
    /// one caller: every implementation settles on a measured balance delta, and a nested call
    /// measures the outer order's in-flight balance. The sibling aggregation adapter is
    /// exploitable that way, so the guard is stated once for the interface. Same shape as
    /// `VaultCore._lock`.
    ///
    /// THIS adapter is not exploitable by re-entry, and the reason matters more than the
    /// conclusion — a wrong reason here is an argument for deleting the guard. Two facts, and it
    /// is the second that carries it:
    ///   1. There is **no whole-balance sweep**. This adapter moves only its own measured delta,
    ///      so a nested call cannot walk off with a sibling order's in-flight input — which is
    ///      precisely what the aggregation adapter's `balanceOf(tokenIn)` sweep allowed.
    ///   2. `pair.swap` is the **only** external call, and it is the counterparty's own contract.
    ///      Re-entry therefore grants the pair no capability it does not already hold as
    ///      counterparty: a hostile pair can inflict the same loss by simply minting less, and
    ///      the outer order's own `minAmountOut` is what refuses it either way. An honest V2 pair
    ///      also carries its own `lock` and only calls back when `data.length > 0`, and this
    ///      adapter passes `""` at both call sites.
    ///
    /// Do NOT restate this as "re-entry can only shrink the outer delta, so it fails closed on
    /// `Slippage`". That was the original wording and it is false: a shrink that stays inside the
    /// caller's tolerance is **absorbed, not refused**. The guard is cheap and the interface
    /// invariant is worth stating uniformly; that is the reason it is here, not a proof that
    /// re-entry would otherwise steal from this adapter.
    modifier nonReentrant() {
        require(_lock == 1, Reentrancy());
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param pair_ the V2-style pair this adapter is permanently pinned to
    constructor(IUniswapV2Pair pair_) {
        pair = pair_;
        token0 = pair_.token0();
        token1 = pair_.token1();
    }

    /// @inheritdoc IExecutionAdapter
    function executeSwap(SwapOrder calldata order) external nonReentrant returns (uint256 amountOut) {
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
        (uint256 reserveIn, uint256 reserveOut) =
            inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 quoted = _amountOut(order.amountIn, reserveIn, reserveOut);

        uint256 outBefore = IERC20Bal(order.tokenOut).balanceOf(address(this));
        order.tokenIn.safeTransfer(address(pair), order.amountIn); // V2 pulls from its own balance
        if (inIs0) pair.swap(0, quoted, address(this), "");
        else pair.swap(quoted, 0, address(this), "");
        amountOut = IERC20Bal(order.tokenOut).balanceOf(address(this)) - outBefore;

        // The check that matters: measured delta vs caller floor (EX-3) — never the quote.
        // Slither `reentrancy-balance` flags this: `outBefore` is read before `pair.swap`. That
        // is the measured delta, not a stale read — and the mutex above is what makes it sound.
        require(amountOut >= order.minAmountOut, Slippage());
        order.tokenOut.safeTransfer(msg.sender, amountOut);

        emit SwapExecuted(msg.sender, order.tokenIn, order.tokenOut, order.amountIn, amountOut);
    }

    /// @dev Constant-product amount-out with the 0.30% fee (Uniswap V2 formula).
    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256)
    {
        uint256 amountInWithFee = amountIn * (10_000 - FEE_BPS);
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 10_000 + amountInWithFee;
        return numerator / denominator;
    }
}
