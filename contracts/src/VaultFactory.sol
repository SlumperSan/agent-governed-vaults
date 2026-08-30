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

    /// @dev C-6 launch remediation (audit finding C-6, "curated oracle"). A vault's oracle is
    /// creator-supplied, and oracle safety CANNOT be enforced permissionlessly: the retired custom
    /// {OracleAggregator} let two adversarial sources seize an asset's price (C-6), and even a
    /// {ChainlinkOracle} pointed at a creator-controlled FAKE `AggregatorV3` prices whatever the
    /// creator wants — both pass every per-oracle constructor check. There is no on-chain way for
    /// the factory to tell a genuine Chainlink feed from a fake, so the launch resolution is
    /// CURATION: the protocol blesses a fixed set of oracle instances (ChainlinkOracle over
    /// verified genuine Chainlink Data Feeds — see docs/audit/AI-AUDIT-REPORT.md C-6) and vaults may
    /// only be created against one of them. When the allowlist is NON-EMPTY at construction,
    /// `oracleAllowlistEnforced` is true and `createVault`/`createChildVault` require the vault's
    /// oracle to be allowlisted; an EMPTY allowlist disables enforcement (local/tests, or a
    /// deliberately-permissionless post-audit deployment). This bounds the launch asset universe to
    /// the blessed feeds — the same "curate what the code cannot verify" shape as `allowSubVaults`.
    bool public immutable oracleAllowlistEnforced;
    mapping(address => bool) public isAllowedOracle;

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
    /// @param allowedOracles_ C-6 curated-oracle allowlist. Pass the blessed oracle instances
    /// (ChainlinkOracle over verified genuine Chainlink feeds) for a mainnet launch; a NON-EMPTY
    /// list enforces that every vault use one of them. Pass EMPTY to disable enforcement
    /// (local/tests, or a deliberately-permissionless post-audit deployment).
    constructor(
        IOperatorRegistry registry_,
        IGovernance governance_,
        IFeeEngine feeEngine_,
        address subVaultRegistry_,
        IVaultDeployer vaultDeployer_,
        bool allowSubVaults_,
        address[] memory allowedOracles_
    ) {
        registry = registry_;
        governance = governance_;
        feeEngine = feeEngine_;
        subVaultRegistry = subVaultRegistry_;
        vaultDeployer = vaultDeployer_;
        allowSubVaults = allowSubVaults_;
        oracleAllowlistEnforced = allowedOracles_.length > 0;
        for (uint256 i; i < allowedOracles_.length; ++i) {
            // Reject a zero OR codeless entry (a typo'd BLESSED_ORACLES address). Without the
            // code check a typo would still pass Deploy.s.sol's non-empty guard, flip enforcement
            // on, and "bless" an address that can never price a vault — mirrors ChainlinkOracle's
            // own codeless-feed reject. (Audit Council follow-up.)
            require(allowedOracles_[i].code.length > 0, OracleNotAllowed());
            isAllowedOracle[allowedOracles_[i]] = true;
        }
    }

    error BasketNotSubsetOfParent();
    error UsdcMismatch();
    error NotParentCreator();
    /// @dev C-1: sub-vault creation is disabled at launch (root vaults only).
    error SubVaultsDisabled();
    /// @dev C-6: the vault's oracle is not on the factory's curated allowlist.
    error OracleNotAllowed();
    /// @dev The vault's oracle cannot price one of its basket assets — the vault would be a brick.
    error OracleMissingAsset(address asset);

    /// @dev C-6 gate: when the allowlist is enforced, a vault's oracle must be blessed. Verifying a
    /// genuine oracle on-chain is impossible (a fake AggregatorV3 or a weak custom aggregator both
    /// pass their own constructor checks), so curation is the only sound launch defence.
    function _requireAllowedOracle(address oracle) internal view {
        if (oracleAllowlistEnforced) require(isAllowedOracle[oracle], OracleNotAllowed());
    }

    /// @dev Prove at CREATION that the oracle prices every basket asset. Without this, blessing the
    /// oracle *instance* says nothing about whether it covers *this* basket: a creator could pair a
    /// fully-blessed oracle with an asset it does not list, deposit USDC fine (NAV skips zero
    /// balances), and then PERMANENTLY BRICK the vault on the first rebalance into that asset —
    /// every navWad/deposit/exit reverts StaleOracle forever, with the funds locked in an immutable
    /// contract. Fail-closed pricing turns a config mistake into an unrecoverable one, so the only
    /// safe place to catch it is before the vault exists.
    ///
    /// The probe is `priceWad(asset)` itself, so coverage is proven by the exact call NAV will make.
    /// A revert here means "this oracle cannot price this basket" — reject rather than deploy a
    /// vault that is one rebalance away from being frozen forever. Note this is a LIVENESS check at
    /// creation, not a guarantee for all time: a feed that later goes stale or gets deprecated still
    /// freezes the vault (the accepted single-provider tradeoff, K-4/SF-2). It closes the
    /// misconfiguration hole, not the oracle-outage one.
    function _requireOracleCoversBasket(IOracleAggregator oracle, address[] calldata basketAssets)
        internal
        view
    {
        for (uint256 i; i < basketAssets.length; ++i) {
            address asset = basketAssets[i];
            try oracle.priceWad(asset) returns (uint256 p) {
                require(p > 0, OracleMissingAsset(asset));
            } catch {
                revert OracleMissingAsset(asset);
            }
        }
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

    /// @notice Deploy and attest a root vault. Permissionless; `msg.sender` becomes the
    /// vault's creator (5% gate identity) and its attested operator.
    /// @param p the creator's immutable vault configuration
    /// @return vault the deployed VaultCore address
    function createVault(VaultParams calldata p) external returns (address vault) {
        _requireAllowedOracle(address(p.oracle)); // C-6: only a curated (blessed) oracle at launch
        vault = _deploy(p);
        // AFTER _deploy on purpose: VaultCore's constructor owns basket validity (cap, duplicates,
        // decimals -> BadConfig), so it must diagnose a malformed basket first; this check is the
        // last word and answers a different question — can this oracle actually price it. The vault
        // reverts out of existence either way, so nothing is deployed on failure.
        _requireOracleCoversBasket(p.oracle, p.basketAssets);
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
        _requireAllowedOracle(address(p.oracle)); // C-6: only a curated (blessed) oracle
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
        // The child's OWN oracle must price the child's basket (see createVault; after _deploy for
        // the same reason). Basket-subset-of-parent does not imply it: look-through prices child
        // assets through the PARENT's oracle, so the child's oracle is never exercised by that rule.
        _requireOracleCoversBasket(p.oracle, p.basketAssets);
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
