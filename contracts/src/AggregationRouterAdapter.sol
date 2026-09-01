// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IExecutionAdapter} from "./interfaces/IExecutionAdapter.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

/// @title AggregationRouterAdapter — Base DEX-aggregation execution (0x/1inch-style)
/// @notice Sprint 4 adapter (EX-1..EX-3). Hardened against the arbitrary-calldata exploit
/// class (SwapNet/Aperture 2026, Dexible 2023, Unizen 2024, LI.FI — see RESEARCH-SPRINT1.md):
///
///  - The router address is PINNED immutable — routeData cannot choose its own target (EX-2).
///  - routeData's selector must be on the construction-time allowlist (EX-1).
///  - minAmountOut and deadline are enforced HERE on measured balance deltas — never trusted
///    from router return values or calldata-embedded slippage params (EX-3).
///  - Approvals are granted per-swap and revoked after; leftovers swept back to the caller.
///
/// Venue-agnostic posture (C-2): this contract is one adapter behind IExecutionAdapter —
/// other chains/venues implement the same interface; VaultCore knows only the interface.
contract AggregationRouterAdapter is IExecutionAdapter {
    using SafeTransferLib for address;

    address public immutable router;
    mapping(bytes4 => bool) public allowedSelector;

    event SwapExecuted(
        address indexed vault, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut
    );

    error Expired();
    error SelectorNotAllowed();
    error RouterCallFailed();
    error Slippage();
    error BadOrder();
    error Reentrancy();

    uint256 private _lock = 1;

    /// @dev The adapter settles on MEASURED balance deltas while holding an order's funds
    /// transiently, so a nested `executeSwap` measures the outer order's in-flight balance:
    /// the `leftover` sweep below returns the adapter's WHOLE `tokenIn` balance to its own
    /// `msg.sender`, and `safeApprove(router, 0)` revokes the outer call's approval. Reachable
    /// with an HONEST pinned router and a hostile counterparty inside the route. Same shape as
    /// `VaultCore._lock`.
    modifier nonReentrant() {
        require(_lock == 1, Reentrancy());
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param router_ the aggregation router this adapter is permanently pinned to (EX-2)
    /// @param selectors_ the router function selectors routeData may invoke (EX-1)
    constructor(address router_, bytes4[] memory selectors_) {
        require(router_ != address(0) && selectors_.length > 0, BadOrder());
        router = router_;
        for (uint256 i; i < selectors_.length; ++i) {
            allowedSelector[selectors_[i]] = true;
        }
    }

    /// @inheritdoc IExecutionAdapter
    function executeSwap(SwapOrder calldata order) external nonReentrant returns (uint256 amountOut) {
        require(block.timestamp <= order.deadline, Expired());
        require(order.minAmountOut > 0, BadOrder()); // minOut is mandatory, never optional
        require(order.tokenIn != order.tokenOut && order.amountIn > 0, BadOrder());
        require(
            order.routeData.length >= 4 && allowedSelector[bytes4(order.routeData[0:4])], SelectorNotAllowed()
        );

        order.tokenIn.safeTransferFrom(msg.sender, address(this), order.amountIn);
        order.tokenIn.safeApprove(router, order.amountIn);

        uint256 outBefore = IERC20Balance(order.tokenOut).balanceOf(address(this));
        (bool ok,) = router.call(order.routeData);
        require(ok, RouterCallFailed());
        amountOut = IERC20Balance(order.tokenOut).balanceOf(address(this)) - outBefore;

        // The check that matters: measured delta versus caller-supplied floor (EX-3).
        require(amountOut >= order.minAmountOut, Slippage());

        order.tokenIn.safeApprove(router, 0); // revoke residual approval (EX-2)
        order.tokenOut.safeTransfer(msg.sender, amountOut);

        // Sweep unspent input back to the caller — partial fills never strand funds here.
        uint256 leftover = IERC20Balance(order.tokenIn).balanceOf(address(this));
        if (leftover > 0) order.tokenIn.safeTransfer(msg.sender, leftover);

        emit SwapExecuted(msg.sender, order.tokenIn, order.tokenOut, order.amountIn, amountOut);
    }
}
