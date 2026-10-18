// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VaultCore} from "./VaultCore.sol";
import {BoundedCall} from "./lib/BoundedCall.sol";
import {IOperatorRegistry} from "./interfaces/IOperatorRegistry.sol";
import {IGovernance} from "./interfaces/IGovernance.sol";
import {IFeeEngine} from "./interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "./interfaces/IOracleAggregator.sol";

/// @notice A VaultCore whose deposit path additionally requires the depositor to hold at least one
/// token on an ERC-8004 style identity registry, pinned at construction and read at the moment of
/// deposit. That is the entire change; every other path is VaultCore's, unmodified.
///
/// WHAT THE GATE ESTABLISHES: that `balanceOf(depositor)` on the pinned registry was nonzero when the
/// deposit was made. It does not establish that the depositor is autonomous or that no person
/// controls it: on a permissionless registry any address can register. With a registration fee of
/// zero that is one transaction; with a nonzero fee it takes a fee-token approval first and then
/// the registration, two transactions for an externally owned account.
///
/// WHAT IT NEVER TOUCHES: `activate`, `skipWindow`, `cancelPending`, `requestExit`,
/// `settleQueuedExit`, `claimEscrowed`, execution, governance hooks and every view. A holder who
/// later loses or transfers the identity keeps their shares, their vote and their exit; only a new
/// deposit (including a top-up) is refused. A registry that reverts, returns short data, returns
/// zero or burns its gas allowance blocks deposits and nothing else.
///
/// The vault has no setters, so the registry it trusts is the one it was deployed with.
contract AgentVaultCore is VaultCore {
    using BoundedCall for address;

    /// @notice ERC-8004 identity registry consulted on deposit, fixed at deployment.
    address public immutable identityRegistry;

    error NoAgentIdentity();

    constructor(
        address usdc_,
        address[] memory basketAssets_,
        address creator_,
        IOperatorRegistry operatorRegistry_,
        IGovernance governance_,
        IFeeEngine feeEngine_,
        IOracleAggregator oracle_,
        uint256 capacityCapUsdc_,
        uint256 minDepositUsdc_,
        uint256 exitFeeMaxBps_,
        uint256 exitFeeDecayPeriod_,
        address[] memory allowedAdapters_,
        address subVaultRegistry_,
        address identityRegistry_
    )
        VaultCore(
            usdc_,
            basketAssets_,
            creator_,
            operatorRegistry_,
            governance_,
            feeEngine_,
            oracle_,
            capacityCapUsdc_,
            minDepositUsdc_,
            exitFeeMaxBps_,
            exitFeeDecayPeriod_,
            allowedAdapters_,
            subVaultRegistry_
        )
    {
        require(identityRegistry_ != address(0) && identityRegistry_.code.length > 0, BadConfig());
        identityRegistry = identityRegistry_;
    }

    /// @dev Fails closed on entry only: a reverting, short-returning, zero-returning or gas-burning
    /// registry blocks the deposit and nothing else.
    function _deposit(uint256 amountUsdc, uint256 minSharesOut) internal override {
        (bool ok, uint256 held, uint256 retSize) = identityRegistry.boundedStaticCall(
            abi.encodeWithSelector(0x70a08231, msg.sender),
            MODULE_CALL_GAS // balanceOf(address)
        );
        require(ok && retSize == 32 && held > 0, NoAgentIdentity());
        super._deposit(amountUsdc, minSharesOut);
    }
}
