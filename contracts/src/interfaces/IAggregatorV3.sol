// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice The minimal read surface of a Chainlink-style `AggregatorV3` feed: the raw round data
/// and the feed's own `decimals()`. This interface itself neither scales nor validates — the answer
/// is in the feed's native decimals and may be zero, negative, or stale. Consumers normalize to WAD
/// against `decimals()` and apply their own sign/staleness checks; see {ChainlinkOracle}.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
