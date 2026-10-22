// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VaultCore} from "../../src/VaultCore.sol";
import {AgentVaultCore} from "../../src/AgentVaultCore.sol";
import {IOperatorRegistry} from "../../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {AllowAllRegistry} from "./RegistryMocks.sol";

/// @notice The seam that lets one existing VaultCore suite run unchanged against AgentVaultCore.
/// A suite inherits this and builds its vault with `_newVault(...)` in `setUp`; by default that is a
/// plain VaultCore, so the suite's own behaviour is untouched. A differential suite overrides
/// `_agentFlavor` to return true, which builds an AgentVaultCore pinned to a registry that admits
/// every address instead: the subclass must then behave exactly like VaultCore, gate aside.
abstract contract VaultHook {
    function _agentFlavor() internal view virtual returns (bool) {
        return false;
    }

    function _newVault(
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
        address subVaultRegistry_
    ) internal virtual returns (VaultCore) {
        if (_agentFlavor()) {
            return new AgentVaultCore(
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
                subVaultRegistry_,
                address(new AllowAllRegistry())
            );
        }
        return new VaultCore(
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
        );
    }
}
