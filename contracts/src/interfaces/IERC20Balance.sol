// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The one ERC-20 read a measured-balance-delta settlement needs. Declared once here and
/// imported by {FeeEngine} and {AggregationRouterAdapter}, which previously each declared their own
/// copy under the same name.
interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}
