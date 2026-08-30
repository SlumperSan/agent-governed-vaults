// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice Chainlink-style AggregatorV3 wrapper normalizing to WAD. One mechanism class among
/// several — pair with TWAP / pull-oracle sources for real independence (SF-1).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
