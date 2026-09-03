// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice Governance module: proposals, commit-reveal, quorum, standing defaults, delegation,
/// timelock. Concrete in Sprint 2. VaultCore consumes only the two signals below.
interface IGovernance {
    /// @notice True from the moment the vault's active proposal enters its reveal phase
    /// (`block.timestamp >= commitDeadline`) — BEFORE any tally — and on through a passed
    /// proposal's execution window, until it is executed, defeated, or expires. It filters on
    /// neither outcome nor proposal TYPE: a proposal that will be defeated, and a RuleChange or
    /// ChildAllocation, all read true exactly as a Rebalance does. See the implementation in
    /// Governance.sol (`Status.Active && block.timestamp >= commitDeadline`, or `Status.Passed &&
    /// block.timestamp <= expiresAt`). While true, `requestExit` queues in Mode F and settles at
    /// post-execution NAV (architecture §4.4, resolves K-1) — so an exit taken from reveal start
    /// onward cannot escape the pending action at a pre-execution price.
    function hasPendingExecution(address vault) external view returns (bool);

    /// @notice True if `account` is authorized to drive execution-settlement callbacks on the
    /// vault (rebalance execution → settle queued Mode-F exits).
    function isExecutor(address vault, address account) external view returns (bool);
}
