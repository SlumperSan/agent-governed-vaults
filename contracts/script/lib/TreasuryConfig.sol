// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @title TreasuryConfig - the per-chain RWAlly treasury passed to `FeeEngine.initialize`
/// @notice Fee model A1 credits 10% of every performance fee to a treasury address that is chosen
/// once per chain. It comes from the `FEE_TREASURY` environment variable. On any real chain the
/// variable is required and must be non-zero, and the script refuses before anything is sent; the
/// engine itself also refuses a zero treasury. Only the local test chain (31337) falls back to a
/// fixed placeholder, so the deploy tests need no process-global env var (forge runs suites in
/// parallel and env vars are shared across them).
library TreasuryConfig {
    uint256 internal constant LOCAL_CHAIN_ID = 31337;
    /// @dev Placeholder used only on chain 31337.
    address internal constant LOCAL_TREASURY =
        address(uint160(uint256(keccak256("rwally.local.fee-treasury"))));

    function read(Vm vm) internal view returns (address treasury) {
        treasury = vm.envOr("FEE_TREASURY", address(0));
        if (treasury == address(0) && block.chainid == LOCAL_CHAIN_ID) treasury = LOCAL_TREASURY;
        require(
            treasury != address(0),
            "FeeEngine: a real-chain deploy requires a non-zero FEE_TREASURY (the per-chain treasury, set once)"
        );
    }
}
