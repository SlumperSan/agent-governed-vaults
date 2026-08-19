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

interface ISubRegistryChild {
    function registerChild(address parent, address child, uint256 childExitFeeMaxBps) external;
}

interface IVaultBasket {
    function assetUnit(address a) external view returns (uint256);
    function usdc() external view returns (address);
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
    address public immutable subVaultRegistry;

    address[] public allVaults;

    event VaultCreated(address indexed vault, address indexed creator, address usdc, uint256 capacityCapUsdc);

    /// @param registry_ canonical OperatorRegistry (attestation target)
    /// @param governance_ governance module every deployed vault binds to
    /// @param feeEngine_ fee module every deployed vault binds to
    /// @param subVaultRegistry_ parent/child edge registry passed into every vault
    constructor(
        IOperatorRegistry registry_,
        IGovernance governance_,
        IFeeEngine feeEngine_,
        address subVaultRegistry_
    ) {
        registry = registry_;
        governance = governance_;
        feeEngine = feeEngine_;
        subVaultRegistry = subVaultRegistry_;
    }

    error BasketNotSubsetOfParent();
    error UsdcMismatch();

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

    /// @notice Deploy and attest a root vault. Permissionless; `msg.sender` becomes the
    /// vault's creator (5% gate identity) and its attested operator.
    /// @param p the creator's immutable vault configuration
    /// @return vault the deployed VaultCore address
    function createVault(VaultParams calldata p) external returns (address vault) {
        vault = _deploy(p);
        IRegistryAttest(address(registry)).attestVault(vault, msg.sender);
        allVaults.push(vault);
        emit VaultCreated(vault, msg.sender, p.usdc, p.capacityCapUsdc);
    }

    /// @notice Deploy a CHILD vault under `parent` (SV-1). The edge is creation-time only —
    /// cycles are structurally impossible. The child's basket must be a subset of the
    /// parent's (same USDC), so in-kind child redemptions always map into parent accounting
    /// and look-through pricing (SV-7) is always possible.
    /// @param p the child's immutable vault configuration (same USDC, basket ⊆ parent's)
    /// @param parent the parent vault to register the creation-time edge under
    /// @return vault the deployed child VaultCore address
    function createChildVault(VaultParams calldata p, address parent) external returns (address vault) {
        require(IVaultBasket(parent).usdc() == p.usdc, UsdcMismatch());
        for (uint256 i; i < p.basketAssets.length; ++i) {
            require(IVaultBasket(parent).assetUnit(p.basketAssets[i]) != 0, BasketNotSubsetOfParent());
        }
        vault = _deploy(p);
        ISubRegistryChild(subVaultRegistry).registerChild(parent, vault, p.exitFeeMaxBps);
        IRegistryAttest(address(registry)).attestVault(vault, msg.sender);
        allVaults.push(vault);
        emit VaultCreated(vault, msg.sender, p.usdc, p.capacityCapUsdc);
    }

    function _deploy(VaultParams calldata p) internal returns (address vault) {
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
                p.allowedAdapters,
                subVaultRegistry
            )
        );
    }

    /// @notice Number of vaults ever deployed by this factory.
    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
