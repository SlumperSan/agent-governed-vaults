// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {VaultCore} from "./VaultCore.sol";
import {IOperatorRegistry} from "./interfaces/IOperatorRegistry.sol";
import {IGovernance} from "./interfaces/IGovernance.sol";
import {IFeeEngine} from "./interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "./interfaces/IOracleAggregator.sol";

interface IRegistryAttest {
    function attestVault(address vault, address operator) external;
}

/// @title VaultFactory — permissionless canonical deployment + attestation
/// @notice The canonical factory is what makes the registry trustworthy (CM-5, SF-4, PX-3):
/// only vaults deployed here are attested, so carry marks and leaderboard rows can only be
/// produced by real, visible, protocol-shaped vaults. Creation stays fully permissionless —
/// anyone can deploy; attestation is automatic and identity-keyed, never curated.
///
/// Two-step bring-up (documented UX, not a trust gap): after creation the creator registers
/// the vault's GovConfig with Governance in a second transaction; until then no proposals can
/// exist and exits settle in Mode I.
contract VaultFactory {
    IOperatorRegistry public immutable registry;
    IGovernance public immutable governance;
    IFeeEngine public immutable feeEngine;

    address[] public allVaults;

    event VaultCreated(address indexed vault, address indexed creator, address usdc, uint256 capacityCapUsdc);

    constructor(IOperatorRegistry registry_, IGovernance governance_, IFeeEngine feeEngine_) {
        registry = registry_;
        governance = governance_;
        feeEngine = feeEngine_;
    }

    struct VaultParams {
        address usdc;
        address[] basketAssets;
        IOracleAggregator oracle;
        uint256 capacityCapUsdc;
        uint256 minDepositUsdc;
        uint256 exitFeeMaxBps;
        uint256 exitFeeDecayPeriod;
        address[] allowedAdapters;
    }

    function createVault(VaultParams calldata p) external returns (address vault) {
        vault = address(
            new VaultCore(
                p.usdc,
                p.basketAssets,
                msg.sender, // creator — the 5% lock and gate bind to this identity
                registry,
                governance,
                feeEngine,
                p.oracle,
                p.capacityCapUsdc,
                p.minDepositUsdc,
                p.exitFeeMaxBps,
                p.exitFeeDecayPeriod,
                p.allowedAdapters
            )
        );
        IRegistryAttest(address(registry)).attestVault(vault, msg.sender);
        allVaults.push(vault);
        emit VaultCreated(vault, msg.sender, p.usdc, p.capacityCapUsdc);
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
