// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

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

interface IVaultDeployer {
    function deploy(bytes calldata ctorArgs) external returns (address vault);
}

interface IVaultBasket {
    function assetUnit(address a) external view returns (uint256);
    function usdc() external view returns (address);
    function creator() external view returns (address);
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
    /// @dev C-1 launch remediation (audit finding C-1, "root vaults only"). A funded sub-vault
    /// has an empty electorate — the GA-1 parent-non-voting exclusion means its only capital is
    /// the parent's allocation while its voting-eligible stake and holder count are both zero, so
    /// one `minDepositUsdc` buys sole governance control and the proposer-supplied `minAmountOut`
    /// turns capture into drain. There is no purely-internal fix (any voting denominator that
    /// excludes the parent lets a dust depositor govern the parent's allocation; including it makes
    /// the child ungovernable, since the parent has no vote path). The owner's decision is to ship
    /// launch with sub-vaults DISABLED at the contract level and defer the mechanism
    /// (parent-casts-child-vote) to a post-launch, post-audit release. When false: `createChildVault`
    /// reverts and every deployed vault is wired with `subVaultRegistry = address(0)`, so it is
    /// intrinsically root-only (`parentVault()` is `address(0)`, `allocateToChild` reverts, the
    /// look-through paths are dead). This closes C-1, H-5, H-6, H-7 and H-9 as a class. The sub-vault
    /// code is retained, not deleted, so a future factory can enable it once the mechanism ships.
    bool public immutable allowSubVaults;
    /// @dev The factory's ONLY vault construction path, pinned at construction (#10). See
    /// VaultDeployer: it exists because VaultCore's creation code alone exceeds EIP-170, and it
    /// holds no authority of its own — attestation stays factory-gated in OperatorRegistry.
    IVaultDeployer public immutable vaultDeployer;

    address[] public allVaults;

    event VaultCreated(address indexed vault, address indexed creator, address usdc, uint256 capacityCapUsdc);

    /// @param registry_ canonical OperatorRegistry (attestation target)
    /// @param governance_ governance module every deployed vault binds to
    /// @param feeEngine_ fee module every deployed vault binds to
    /// @param subVaultRegistry_ parent/child edge registry passed into every vault (only when
    /// `allowSubVaults_` is true; otherwise vaults are wired root-only, see `allowSubVaults`)
    /// @param vaultDeployer_ the VaultDeployer holding VaultCore's creation code (deploy it first)
    /// @param allowSubVaults_ C-1 launch switch. Pass FALSE for mainnet launch (root vaults only);
    /// pass true only once the parent-casts-child-vote mechanism has shipped and been audited.
    constructor(
        IOperatorRegistry registry_,
        IGovernance governance_,
        IFeeEngine feeEngine_,
        address subVaultRegistry_,
        IVaultDeployer vaultDeployer_,
        bool allowSubVaults_
    ) {
        registry = registry_;
        governance = governance_;
        feeEngine = feeEngine_;
        subVaultRegistry = subVaultRegistry_;
        vaultDeployer = vaultDeployer_;
        allowSubVaults = allowSubVaults_;
    }

    error BasketNotSubsetOfParent();
    error UsdcMismatch();
    error NotParentCreator();
    /// @dev C-1: sub-vault creation is disabled at launch (root vaults only).
    error SubVaultsDisabled();

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
        // C-1 (root vaults only): sub-vaults are disabled at launch. `registerChild` is
        // factory-only (SubVaultRegistry) and `allocateToChild` requires a registered edge, so
        // refusing creation here means no parent/child edge can ever exist, no vault can be funded
        // as a child, and the empty-electorate capture is unreachable. See `allowSubVaults`.
        require(allowSubVaults, SubVaultsDisabled());
        // L-1: this performed NO authorization on `parent`. Anyone could permanently attach an
        // arbitrary child under any vault — `registerChild` is creation-time-only with no
        // removal path — and, being the child's own creator, register its GovConfig with
        // `timelockDuration = 0`. That is what removed the parent's only race in C-1: the
        // parent's members could otherwise try to push a `redeemFromChild` proposal through
        // before the child's timelock elapsed. Low standalone, load-bearing in composition.
        require(msg.sender == IVaultBasket(parent).creator(), NotParentCreator());
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

    /// @dev Constructor arguments are encoded here and CREATEd by `vaultDeployer` — the same
    /// argument tuple `new VaultCore(...)` used to build, in the same order. The vault's code
    /// comes from the deployer's compile-time-pinned blob, never from a caller, and a failing
    /// VaultCore constructor still bubbles its own revert (e.g. `BadConfig`) through.
    function _deploy(VaultParams calldata p) internal returns (address vault) {
        vault = vaultDeployer.deploy(
            abi.encode(
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
                // C-1 belt-and-suspenders: at launch (allowSubVaults == false) every vault is
                // wired root-only, so allocateToChild reverts and parentVault() is address(0)
                // regardless of any registry state. When sub-vaults are enabled, the real edge
                // registry flows through unchanged.
                allowSubVaults ? subVaultRegistry : address(0)
            )
        );
    }

    /// @notice Number of vaults ever deployed by this factory.
    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
