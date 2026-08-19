// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title SubVaultRegistry — parent/child edges, depth cap, fee stacking, quorum inheritance
/// @notice Sprint 5 module (SV-1..SV-7). Structural properties:
///
/// - **Edges are creation-time only:** a vault becomes a child ONLY at factory deployment,
///   never retroactively — so cycles are impossible by construction (a pre-existing vault can
///   never be re-registered as someone's child) and vault-to-vault deposits are permitted
///   solely along registered parent→child edges (SV-3, checked by VaultCore.allocateToChild).
/// - **Depth is hard-capped at 3** (root = depth 0; deepest child = depth 2 ⇒ 3 levels).
/// - **Fee stacking is capped:** cumulative exit-fee ceiling across the ancestor chain must
///   stay under STACKED_EXIT_FEE_CAP; the stacked performance fee (protocol-fixed 10% per
///   level) is exposed as a view for display (SV-4) and bounded by the depth cap itself.
/// - **Quorum floors inherit** (SV-6): Governance consults `parentOf` at registration and
///   requires child quorum ≥ parent quorum.
contract SubVaultRegistry {
    uint256 public constant MAX_DEPTH = 3; // levels including root
    uint256 public constant STACKED_EXIT_FEE_CAP_BPS = 250; // 2.5% cumulative ceiling
    uint256 public constant PERF_FEE_BPS = 1_000; // mirrors FeeEngine, per level

    address public factory; // one-shot wiring
    address public immutable deployer;

    mapping(address => address) public parentOf; // child ⇒ parent (0 = root)
    mapping(address => uint256) public depthOf; // root = 0

    event ChildRegistered(address indexed parent, address indexed child, uint256 depth);

    error OnlyDeployer();
    error AlreadyWired();
    error OnlyFactory();
    error DepthExceeded();
    error AlreadyRegistered();
    error ExitFeeStackExceeded();

    constructor() {
        deployer = msg.sender;
    }

    function wire(address factory_) external {
        require(msg.sender == deployer, OnlyDeployer());
        require(factory == address(0), AlreadyWired());
        factory = factory_;
    }

    /// @notice Register a freshly deployed child under `parent`. Factory-only, creation-time
    /// only. `childExitFeeMaxBps` is the child's exit-fee ceiling, used for the stack cap.
    function registerChild(address parent, address child, uint256 childExitFeeMaxBps) external {
        require(msg.sender == factory, OnlyFactory());
        require(parentOf[child] == address(0) && depthOf[child] == 0, AlreadyRegistered());

        uint256 parentDepth = depthOf[parent];
        require(parentDepth + 1 < MAX_DEPTH, DepthExceeded()); // depth 0,1,2 allowed

        // SV-4: cumulative exit-fee ceiling across the whole ancestor chain.
        uint256 stacked = childExitFeeMaxBps;
        address a = parent;
        while (a != address(0)) {
            stacked += IVaultFees(a).exitFeeMaxBps();
            a = parentOf[a];
        }
        require(stacked <= STACKED_EXIT_FEE_CAP_BPS, ExitFeeStackExceeded());

        parentOf[child] = parent;
        depthOf[child] = parentDepth + 1;
        emit ChildRegistered(parent, child, parentDepth + 1);
    }

    /// @notice Cumulative effective performance fee across the ancestor chain, for display
    /// (SV-4): 1 − (1 − f)^levels, in bps. Depth-capped by construction.
    function stackedPerfFeeBps(address vault) external view returns (uint256 bps) {
        uint256 levels = depthOf[vault] + 1;
        uint256 keep = 10_000;
        for (uint256 i; i < levels; ++i) {
            keep = keep * (10_000 - PERF_FEE_BPS) / 10_000;
        }
        return 10_000 - keep;
    }

    /// @notice Cumulative exit-fee ceiling across the ancestor chain, in bps (SV-4 display).
    function stackedExitFeeCapBps(address vault) external view returns (uint256 bps) {
        address a = vault;
        while (a != address(0)) {
            bps += IVaultFees(a).exitFeeMaxBps();
            a = parentOf[a];
        }
    }
}

interface IVaultFees {
    function exitFeeMaxBps() external view returns (uint256);
}
