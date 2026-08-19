// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice Performance fee: 10% of realized profit per member, HWM per (member, operator) via
/// the OperatorRegistry loss carryforward. Concrete in Sprint 3. Crystallization happens ONLY
/// on member redemption (threat model CM-3: never on rebalance, so operators cannot churn to
/// crystallize early).
interface IFeeEngine {
    /// @notice Called by the vault at redemption settlement with the member's realized P&L.
    /// @param member the redeeming member
    /// @param gainUsdc realized gain in USDC units (0 if loss)
    /// @param lossUsdc realized loss in USDC units (0 if gain)
    /// @return feeUsdc performance fee to withhold from the payout, in USDC units.
    ///         MUST be 0 when gainUsdc is 0. MUST be ≤ 10% of gainUsdc net of carryforward.
    function onRealize(address member, uint256 gainUsdc, uint256 lossUsdc) external returns (uint256 feeUsdc);
}
