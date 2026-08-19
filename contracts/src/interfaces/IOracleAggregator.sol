// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice Multi-source median price oracle with staleness circuit breaker. Concrete in
/// Sprint 4. When the breaker is tripped, priceWad MUST revert — which by design freezes
/// every NAV-reading path in the vault, INCLUDING exits (threat model SF-2 / K-4, accepted:
/// an exit hatch during staleness is exactly the stale-price exit the breaker prevents).
interface IOracleAggregator {
    /// @notice USD price of one whole token (10**decimals base units), WAD-scaled (1e18).
    /// @dev MUST revert with StaleOracle() if the source set for `asset` fails freshness quorum.
    function priceWad(address asset) external view returns (uint256);

    error StaleOracle(address asset);
}
