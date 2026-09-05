// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Operator identity, cross-vault (member, operator) high-water marks, aggregate leaderboard.
/// Concrete in Sprint 3. VaultCore holds an immutable reference from day one (commitment C-3):
/// the reference is load-bearing for HWM portability, leaderboard integrity, and anti-Sybil.
interface IOperatorRegistry {
    /// @notice Operator identity for a vault. Zero means unregistered (Sprint 1 stub).
    function operatorOf(address vault) external view returns (uint256 operatorId);

    /// @notice Record a realized gain/loss for (member, operator) — feeds the USDC-denominated
    /// loss carryforward that implements "marks follow operator identity across vaults" (§7).
    /// @param gainUsdc realized gain in USDC units (0 if loss)
    /// @param lossUsdc realized loss in USDC units (0 if gain)
    function recordRealization(address member, uint256 gainUsdc, uint256 lossUsdc) external;
}
