// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice Governance module: proposals, commit-reveal, quorum, standing defaults, delegation,
/// timelock. Concrete in Sprint 2. VaultCore consumes only the two signals below.
interface IGovernance {
    /// @notice True while a rebalance proposal has passed its vote but has not yet executed
    /// (nor expired). While true, exit requests queue in Mode F and settle at post-execution
    /// NAV (architecture §4.4, resolves K-1).
    function hasPendingExecution(address vault) external view returns (bool);

    /// @notice True if `account` is authorized to drive execution-settlement callbacks on the
    /// vault (rebalance execution → settle queued Mode-F exits).
    function isExecutor(address vault, address account) external view returns (bool);
}
