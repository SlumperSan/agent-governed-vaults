// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IOperatorRegistry} from "./interfaces/IOperatorRegistry.sol";
import {IGovernance} from "./interfaces/IGovernance.sol";
import {IFeeEngine} from "./interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "./interfaces/IOracleAggregator.sol";
import {PROTOCOL_INITIALIZER} from "./lib/ProtocolInitializer.sol";

interface IRegistryAttest {
    function attestVault(address vault, address operator) external;
}

interface ISubRegistryChild {
    function registerChild(address parent, address child, uint256 childExitFeeMaxBps) external;
}

interface IVaultDeployer {
    function deploy(bytes calldata ctorArgs) external returns (address vault);
}

/// @dev The one read the creator gate makes: the ERC-721 balance of the creator on the pinned agent
/// registry.
interface IAgentIdentityBalance {
    function balanceOf(address owner) external view returns (uint256);
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
/// Same address on every chain. Everything fixed in this contract's constructor is identical on every
/// chain (the registry, governance, fee engine, sub-vault registry and vault deployer are themselves
/// same-address CREATE2 singletons, and `allowSubVaults` is policy), so its initcode and therefore its
/// CREATE2 address match across chains. The one per-chain input, the oracle allowlist, moved out of the
/// constructor into a one-shot {initialize} gated on {PROTOCOL_INITIALIZER}; until that call lands
/// `createVault` and `createChildVault` revert {NotInitialized}.
///
/// Agent vaults. {createAgentVault} is the second creation path: the creator must hold at least one
/// agent ID in the registry pinned by {initializeAgentPath}, and the vault it builds is an
/// {AgentVaultCore} (deposits require an agent ID on that same registry) built by a second pinned
/// deployer. In every other respect it is `createVault`: the same curated-oracle gate, the same
/// covers-basket probe, the same attestation of the creator in OperatorRegistry (so the creator earns
/// the creator fee share exactly as a regular vault's creator does) and the same `allVaults` entry.
/// The agent ID check is a provenance tag: the registry is permissive (an ID costs a fee and one
/// address may hold many IDs), so holding an ID says that the registry minted one to the creator, by
/// registration, import or attested mirror, and nothing about who or what the creator is.
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
    /// VaultDeployer: VaultCore's creation code is under EIP-170 by itself, but not once a
    /// factory's own logic is added — which is why construction lives there rather than here. It
    /// holds no authority of its own — attestation stays factory-gated in OperatorRegistry.
    ///
    /// This said "VaultCore's creation code alone exceeds EIP-170" until 2026-09-03. That was the
    /// same figure #151 corrected one file away in VaultDeployer.sol, and it survived here because
    /// the correction was applied to the instance in view rather than to every instance of the
    /// shape. VaultDeployer's corrected paragraph predicted exactly this: "nothing walks `.sol` for
    /// stale figures, which is how the old one lasted." Something does now —
    /// scripts/test/contracts-size-truth.test.mjs resolves this sentence against the build
    /// artifact on every run, so it cannot go stale again without going red.
    IVaultDeployer public immutable vaultDeployer;

    /// @dev C-6 launch remediation (audit finding C-6, "curated oracle"). A vault's oracle is
    /// creator-supplied, and oracle safety CANNOT be enforced permissionlessly: the retired custom
    /// {OracleAggregator} let two adversarial sources seize an asset's price (C-6), and even a
    /// {ChainlinkOracle} pointed at a creator-controlled FAKE `AggregatorV3` prices whatever the
    /// creator wants — both pass every per-oracle constructor check. There is no on-chain way for
    /// the factory to tell a genuine Chainlink feed from a fake, so the launch resolution is
    /// CURATION: the protocol blesses a fixed set of oracle instances (ChainlinkOracle over
    /// verified genuine Chainlink Data Feeds — see docs/audit/AI-AUDIT-REPORT.md C-6) and vaults may
    /// only be created against one of them. When the allowlist is NON-EMPTY at {initialize},
    /// `oracleAllowlistEnforced` is true and `createVault`/`createChildVault` require the vault's
    /// oracle to be allowlisted; an EMPTY allowlist disables enforcement (local/tests, or a
    /// deliberately-permissionless post-audit deployment). This bounds the launch asset universe to
    /// the blessed feeds — the same "curate what the code cannot verify" shape as `allowSubVaults`.
    ///
    /// Storage, not an immutable, since 2026-10-18: the allowlist is per chain (oracle addresses
    /// differ because oracle config differs), so it is set by the one-shot {initialize} instead of the
    /// constructor. Reads before {initialize} see `false`, which is the C-6-open state; {NotInitialized}
    /// is what keeps that state from creating anything.
    bool public oracleAllowlistEnforced;
    /// @notice True once {initialize} has run. `createVault` and `createChildVault` revert before it.
    bool public initialized;
    mapping(address => bool) public isAllowedOracle;

    /// @notice The smallest `minDepositUsdc` any vault this factory creates may carry: 100 USDC, in
    /// the 6-decimal base units of the chain's canonical USDC. Owner decision 2026-10-21.
    /// @dev Why a floor at all (A4 freeze review, finding 3): VaultCore only requires
    /// `minDepositUsdc > 0`, so before this the factory would deploy a vault whose first mint could be
    /// 1e12 share-wei (a 1-unit minimum, a millionth of one share), and against so small a supply a
    /// second member's fee-bearing entries and exits ratchet NAV per share-wei upward. At 100 USDC the
    /// first mint is at least 100e18 share-wei, the launch value in contracts/config/arc-mainnet.json.
    /// It also prices each H-8 regime-flip seat at no less than 100 USDC; a creator may still choose
    /// more, and should relative to capacity. `p.usdc` is creator-supplied, so the floor ASSUMES 6 decimals rather than reading
    /// them. It binds vaults built here, which are the only attested ones; a VaultCore deployed
    /// directly (for example through the permissionless VaultDeployer) is never attested.
    uint256 public constant MIN_DEPOSIT_FLOOR_USDC = 100_000_000;

    /// @notice The agent ID registry every agent vault pins and the creator gate reads. Set once by
    /// {initializeAgentPath}; zero before that.
    /// @dev Storage rather than a constructor argument, on purpose. The registry is a vanity-salted
    /// CREATE2 singleton whose salt is mined only once its bytecode is frozen, so its address is not
    /// known when this factory's initcode is fixed, and this factory must have the same address on
    /// every chain: an address in the constructor would move the factory's address with every change
    /// to the registry. It is one-shot and {PROTOCOL_INITIALIZER}-gated like {initialize}, and it
    /// requires code at the address so a typo cannot permanently strand the agent path.
    address public agentRegistry;
    /// @notice The deployer that builds every agent vault. Set once by {initializeAgentPath}.
    /// @dev Storage, unlike the immutable `vaultDeployer`, to keep the constructor at six arguments
    /// and both agent wirings in one place; its address is knowable at compile time, so this is not
    /// about an unknown address. Same trust position as `vaultDeployer`: it holds no authority, and
    /// the factory can only ever CREATE an agent vault through it.
    IVaultDeployer public agentVaultDeployer;
    /// @notice True once {initializeAgentPath} has run. {initialized} does NOT imply it: a factory can
    /// be initialized for regular vaults and still have no agent path, and `createAgentVault` reverts
    /// {AgentPathNotInitialized} until it is set.
    bool public agentPathInitialized;

    /// @notice The vault kind carried by {AgentVaultCreated}. A regular vault has no kind field: its
    /// {VaultCreated} event is the kind.
    uint8 public constant VAULT_KIND_AGENT = 1;

    address[] public allVaults;

    event VaultCreated(address indexed vault, address indexed creator, address usdc, uint256 capacityCapUsdc);
    /// @notice Emitted INSTEAD of {VaultCreated} for a vault built by {createAgentVault}, never in
    /// addition to it. {VaultCreated} is unchanged for regular vaults, so every existing consumer keeps
    /// working and counts regular vaults only; a consumer that wants agent vaults reads this event too.
    /// @param identityRegistry the agent registry the vault pinned (the factory's {agentRegistry})
    /// @param kind {VAULT_KIND_AGENT}
    event AgentVaultCreated(
        address indexed vault,
        address indexed creator,
        address usdc,
        uint256 capacityCapUsdc,
        address identityRegistry,
        uint8 kind
    );
    event Initialized(address[] allowedOracles);
    event AgentPathInitialized(address indexed agentRegistry, address indexed agentVaultDeployer);

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

    /// @notice One-shot, {PROTOCOL_INITIALIZER}-only: set this chain's C-6 curated-oracle allowlist.
    /// Pass the blessed oracle instances (ChainlinkOracle over verified genuine Chainlink feeds) for a
    /// mainnet launch; a NON-EMPTY list enforces that every vault use one of them. Pass EMPTY to
    /// disable enforcement (local/tests, or a deliberately-permissionless post-audit deployment);
    /// `Deploy.s.sol` refuses an empty list on every chain but the local one.
    /// @param allowedOracles_ the blessed oracle instances for this chain
    function initialize(address[] calldata allowedOracles_) external {
        require(msg.sender == PROTOCOL_INITIALIZER, OnlyInitializer());
        require(!initialized, AlreadyInitialized());
        initialized = true;
        oracleAllowlistEnforced = allowedOracles_.length > 0;
        for (uint256 i; i < allowedOracles_.length; ++i) {
            // Reject a zero OR codeless entry (a typo'd BLESSED_ORACLES address). Without the
            // code check a typo would still pass Deploy.s.sol's non-empty guard, flip enforcement
            // on, and "bless" an address that can never price a vault — mirrors ChainlinkOracle's
            // own codeless-feed reject. (Audit Council follow-up.)
            require(allowedOracles_[i].code.length > 0, OracleNotAllowed());
            isAllowedOracle[allowedOracles_[i]] = true;
        }
        emit Initialized(allowedOracles_);
    }

    /// @notice One-shot, {PROTOCOL_INITIALIZER}-only: pin the agent ID registry and the agent vault
    /// deployer, which switches {createAgentVault} on. Both must already carry code, so the registry
    /// is deployed before this call on every chain (a typo here is permanent, and the registry cannot
    /// be changed afterwards). See {agentRegistry} for why this is a call and not a constructor
    /// argument. It sits beside {initialize} rather than inside it so that `initialize`'s signature and
    /// its `Initialized` event, which the deploy preflight and the indexers read, do not change.
    /// @param agentRegistry_ the agent ID registry (RWAllyAgentRegistry) on this chain
    /// @param agentVaultDeployer_ the AgentVaultDeployer holding AgentVaultCore's creation code
    function initializeAgentPath(address agentRegistry_, IVaultDeployer agentVaultDeployer_) external {
        require(msg.sender == PROTOCOL_INITIALIZER, OnlyInitializer());
        require(!agentPathInitialized, AgentPathAlreadyInitialized());
        require(agentRegistry_.code.length > 0, InvalidAgentRegistry());
        require(address(agentVaultDeployer_).code.length > 0, InvalidAgentVaultDeployer());
        agentPathInitialized = true;
        agentRegistry = agentRegistry_;
        agentVaultDeployer = agentVaultDeployer_;
        emit AgentPathInitialized(agentRegistry_, address(agentVaultDeployer_));
    }

    /// @dev {initialize} or {initializeAgentPath} was called by something other than {PROTOCOL_INITIALIZER}.
    error OnlyInitializer();
    /// @dev {initializeAgentPath} has already run on this factory.
    error AgentPathAlreadyInitialized();
    /// @dev {createAgentVault} was called before {initializeAgentPath}: there is no registry to gate on
    /// and no deployer to build with.
    error AgentPathNotInitialized();
    /// @dev {initializeAgentPath} was given an address with no code as the agent registry.
    error InvalidAgentRegistry();
    /// @dev {initializeAgentPath} was given an address with no code as the agent vault deployer.
    error InvalidAgentVaultDeployer();
    /// @dev The caller of {createAgentVault} holds no agent ID in the pinned registry.
    error NoAgentIdentity();
    /// @dev {initialize} has already run on this factory.
    error AlreadyInitialized();
    /// @dev A vault was requested before {initialize}: the oracle allowlist is not set, so the C-6
    /// gate would be open. Creating nothing is the only safe answer.
    error NotInitialized();
    error BasketNotSubsetOfParent();
    error UsdcMismatch();
    error NotParentCreator();
    /// @dev C-1: sub-vault creation is disabled at launch (root vaults only).
    error SubVaultsDisabled();
    /// @dev C-6: the vault's oracle is not on the factory's curated allowlist.
    error OracleNotAllowed();
    /// @dev The vault's oracle cannot price one of its basket assets — the vault would be a brick.
    error OracleMissingAsset(address asset);
    /// @dev The requested `minDepositUsdc` is below {MIN_DEPOSIT_FLOOR_USDC}.
    error MinDepositBelowFloor();

    /// @dev Every vault creation path calls this before it deploys anything. See
    /// {MIN_DEPOSIT_FLOOR_USDC}.
    function _requireMinDepositFloor(uint256 minDepositUsdc) internal pure {
        require(minDepositUsdc >= MIN_DEPOSIT_FLOOR_USDC, MinDepositBelowFloor());
    }

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
        require(initialized, NotInitialized());
        _requireMinDepositFloor(p.minDepositUsdc);
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

    /// @notice Deploy and attest a root AGENT vault: `createVault` for a creator that holds an agent ID.
    /// `msg.sender` becomes the vault's creator and its attested operator, and the deployed vault is an
    /// {AgentVaultCore} pinned to {agentRegistry}, so its deposits require an agent ID there.
    /// @dev The creator gate reads `balanceOf(msg.sender) > 0` on the pinned registry directly, and
    /// not through the bounded call AgentVaultCore uses on deposits: creating a vault moves no
    /// funds, the caller alone pays for a registry that burns gas, and a registry that reverts or
    /// returns short data failing the creation is the right outcome. The registry address is the
    /// factory's own storage and never a field of `p`; a creator-supplied registry would make the
    /// deposit gate meaningless. The registry check is a provenance tag, see the contract notes.
    /// Everything after the gate mirrors `createVault` step for step, including the order (the
    /// covers-basket probe runs after the deploy so the vault constructor diagnoses a malformed basket
    /// first).
    /// @param p the creator's immutable vault configuration
    /// @return vault the deployed AgentVaultCore address
    function createAgentVault(VaultParams calldata p) external returns (address vault) {
        require(initialized, NotInitialized());
        require(agentPathInitialized, AgentPathNotInitialized());
        address registry_ = agentRegistry;
        require(IAgentIdentityBalance(registry_).balanceOf(msg.sender) > 0, NoAgentIdentity());
        // This path builds its own constructor tuple and never reaches `_deploy`, so the floor is
        // called here as well; a check added only to `_deploy` would skip agent vaults.
        _requireMinDepositFloor(p.minDepositUsdc);
        _requireAllowedOracle(address(p.oracle)); // C-6: the same curated oracle gate as createVault
        vault = agentVaultDeployer.deploy(
            abi.encode(
                p.usdc,
                p.basketAssets,
                msg.sender, // creator: the 5% lock and gate bind to this identity
                registry,
                governance,
                feeEngine,
                p.oracle,
                p.capacityCapUsdc,
                p.minDepositUsdc,
                p.exitFeeMaxBps,
                p.exitFeeDecayPeriod,
                p.allowedAdapters,
                allowSubVaults ? subVaultRegistry : address(0),
                registry_ // the pinned identity registry, from this contract's storage
            )
        );
        _requireOracleCoversBasket(p.oracle, p.basketAssets);
        IRegistryAttest(address(registry)).attestVault(vault, msg.sender);
        allVaults.push(vault);
        emit AgentVaultCreated(vault, msg.sender, p.usdc, p.capacityCapUsdc, registry_, VAULT_KIND_AGENT);
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
        require(initialized, NotInitialized());
        require(allowSubVaults, SubVaultsDisabled());
        _requireMinDepositFloor(p.minDepositUsdc);
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
