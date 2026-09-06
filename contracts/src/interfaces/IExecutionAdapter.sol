// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Venue-agnostic execution (commitment C-2). Concrete adapters in Sprint 4, starting
/// with Base DEX aggregation. The adapter — never the router — enforces minOut and deadline
/// (threat model EX-1..EX-3): output-token identity and balance delta are verified against the
/// vault's own accounting, not the router's return value. Approvals are per-swap and revoked.
interface IExecutionAdapter {
    struct SwapOrder {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut; // mandatory, enforced by the adapter on measured balance delta
        uint256 deadline; // unix seconds, block.timestamp-compared (no block numbers, C-2)
        bytes routeData; // opaque venue routing payload, constrained by the adapter
    }

    /// @notice Execute a swap on behalf of the calling vault. MUST revert unless measured
    /// tokenOut delta ≥ minAmountOut and block.timestamp ≤ deadline.
    /// @return amountOut actual tokenOut received, measured by balance delta.
    function executeSwap(SwapOrder calldata order) external returns (uint256 amountOut);
}
