// SPDX-License-Identifier: MIT
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

    /// @notice Called by the vault AFTER transferring the (possibly clamped) fee, with the
    /// amount actually sent — the engine must credit the operator from this figure, never from
    /// its own onRealize return value (the vault's defensive clamp may reduce it; an
    /// undercollected fee is forgiven in the member's favor, not carried as debt).
    function onFeeCollected(address member, uint256 amountUsdc) external;

    /// @notice Like onFeeCollected, for the in-kind leg: called per basket asset after the
    /// vault transfers `amount` of `asset` to the engine (M-2: fees are withheld uniformly
    /// across cash and in-kind payouts).
    function onFeeCollectedAsset(address member, address asset, uint256 amount) external;
}
