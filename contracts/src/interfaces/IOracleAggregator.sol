// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The price surface a vault reads: a USD price per basket asset, or a revert.
/// The LAUNCH implementation is {ChainlinkOracle} — one genuine Chainlink Data Feed per asset,
/// with no median and no quorum. The interface name predates the C-6 pivot: it was written for a
/// bespoke multi-source median aggregator, which is retired to `contracts/test/retired/` and is
/// not on the launch path. Every implementation MUST fail CLOSED — when it cannot produce a
/// trustworthy price it MUST revert, which by design freezes every NAV-reading path in the vault,
/// INCLUDING exits (threat model SF-2 / K-4, accepted: an exit hatch during staleness is exactly
/// the stale-price exit the breaker prevents).
interface IOracleAggregator {
    /// @notice USD price of one whole token (10**decimals base units), WAD-scaled (1e18).
    /// @dev MUST revert with StaleOracle() if `asset` is unlisted or no trustworthy price is
    /// available for it. MUST NEVER return 0, and MUST NEVER return a stale price.
    function priceWad(address asset) external view returns (uint256);

    error StaleOracle(address asset);
}
