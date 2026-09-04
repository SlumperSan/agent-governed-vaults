// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {VaultFactory, IVaultDeployer} from "../../src/VaultFactory.sol";
import {VaultDeployer} from "../../src/VaultDeployer.sol";
import {SubVaultRegistry} from "../../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../../src/FeeEngine.sol";
import {Governance} from "../../src/Governance.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {IOperatorRegistry} from "../../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockERC20} from "../mocks/Mocks.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

/// @notice Structural-maximum evidence for Slither `calls-loop` cluster A (the recursive
/// look-through NAV walk: `VaultCore.navWad` -> `_childValueWad` -> `_holdingValueWad` ->
/// `_fullNavWad`, which itself loops every child again). `NavGas.t.sol` only measures a
/// realistic depth-3 / 1-child / 1-grandchild / 3-asset fixture. This file measures the actual
/// CODE-ENFORCED ceiling: `MAX_CHILDREN` (8) fan-out at every level, a full `MAX_BASKET_ASSETS`
/// (10) basket at every vault, down to the two descendant levels `SubVaultRegistry` actually
/// allows to be registered (73 vaults total: 1 root + 8 children + 64 grandchildren).
///
/// NON-LAUNCH CONFIGURATION: this file builds with `allowSubVaults = true`. At launch (see
/// `VaultFactory.allowSubVaults`, audit finding C-1) sub-vaults are disabled entirely and every
/// deployed vault is root-only, so this whole fan-out tree is UNREACHABLE in production today.
/// It exists to bound the recursive code path for whenever sub-vaults do ship (the code and the
/// `MAX_CHILDREN`/`MAX_LOOKTHROUGH_DEPTH` constants already exist and are load-bearing then), and
/// to prove which of the two independent caps — the code-level look-through depth or the
/// registry's own nesting cap — is the one actually binding real deployments.
contract AuditCallsLoopMaxBoundTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;
    uint256 constant N_ASSETS = 10;
    uint256 constant N_CHILDREN = 8;

    /// @dev Measured 2026-09-01 on this repo's `via_ir`, optimizer-800 build, against
    /// `protocol/main` @ 52d10aee: navWad() at the full 8x8x10 structural maximum (73 vaults,
    /// 72 descendants, 10-asset basket at every level) costs 10,402,702 gas.
    ///
    /// This number was first recorded as 10,108,782 and went stale inside a day: merging
    /// `protocol/main` moved it +2.9% and nothing turned red, because the only assertion was
    /// against the ceiling, which has 7.7% of slack. `NAV_GAS_MEASURED` below is the fix — the
    /// prose number is now itself asserted, so it cannot drift away from what the test prints.
    uint256 constant NAV_GAS_MEASURED = 10_402_702;

    /// @dev A COARSE regression fence, not a pin: a round number chosen to sit under the block
    /// limit, ~7.7% above the real measurement. It catches a shape change (a bump to
    /// MAX_CHILDREN or MAX_LOOKTHROUGH_DEPTH) and nothing smaller. The pin is
    /// `NAV_GAS_MEASURED` and the 1% band asserted against it; do not read this constant as
    /// evidence that a regression under ~797k gas would be caught.
    uint256 constant NAV_GAS_CEILING = 11_200_000;

    MockERC20 usdc;
    MockERC20[N_ASSETS] assets;
    MockAggregatorV3[N_ASSETS] feeds;
    ChainlinkOracle oracle;

    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultFactory factory;

    VaultCore root;
    VaultCore[N_CHILDREN] children;
    VaultCore[N_CHILDREN][N_CHILDREN] grandchildren;

    address operator = makeAddr("operator");
    uint256 internal BAL_SLOT;
    bool internal balSlotFound;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);

        address[] memory oAssets = new address[](N_ASSETS);
        address[] memory oFeeds = new address[](N_ASSETS);
        uint32[] memory oHb = new uint32[](N_ASSETS);
        uint256[] memory oMin = new uint256[](N_ASSETS);
        uint256[] memory oMax = new uint256[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            assets[i] = new MockERC20("A", 18);
            feeds[i] = new MockAggregatorV3(8, 2000e8, block.timestamp);
            oAssets[i] = address(assets[i]);
            oFeeds[i] = address(feeds[i]);
            oHb[i] = 1 hours; // within [MIN_HEARTBEAT, MAX_HEARTBEAT]
        }
        oracle = new ChainlinkOracle(oAssets, oFeeds, oHb, oMin, oMax, address(usdc), address(0));

        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        gov = new Governance();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(subReg),
            IVaultDeployer(address(new VaultDeployer())),
            true, // NON-LAUNCH: sub-vaults enabled to reach the structural maximum
            new address[](0) // C-6: no oracle allowlist (permissive, matches NavGas.t.sol)
        );
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));

        address[] memory basket = _fullBasket();

        // Every vault uses the SAME full 10-asset basket (a subset of the parent's, and equal
        // counts as a subset) — this maximises per-vault navWad cost at every level.
        vm.startPrank(operator);
        root = VaultCore(factory.createVault(_params(basket)));
        for (uint256 c; c < N_CHILDREN; ++c) {
            children[c] = VaultCore(factory.createChildVault(_params(basket), address(root)));
            for (uint256 g; g < N_CHILDREN; ++g) {
                grandchildren[c][g] =
                    VaultCore(factory.createChildVault(_params(basket), address(children[c])));
            }
        }
        vm.stopPrank();

        // Fund root and cascade allocations down both levels, with headroom at every hop so
        // every allocateToChild call has enough idleUsdc.
        uint256 rootDeposit = 1_000_000_000 * USDC_1; // 1e15
        uint256 childAlloc = 100_000_000 * USDC_1; // 1e14; 8x = 8e14 <= rootDeposit
        uint256 grandAlloc = 10_000_000 * USDC_1; // 1e13; 8x = 8e13 <= childAlloc

        usdc.mint(operator, rootDeposit);
        vm.startPrank(operator);
        usdc.approve(address(root), type(uint256).max);
        root.deposit(rootDeposit);
        root.skipWindow(); // activates the pending deposit immediately
        vm.stopPrank();

        for (uint256 c; c < N_CHILDREN; ++c) {
            vm.prank(address(gov));
            root.allocateToChild(address(children[c]), childAlloc);
            for (uint256 g; g < N_CHILDREN; ++g) {
                vm.prank(address(gov));
                children[c].allocateToChild(address(grandchildren[c][g]), grandAlloc);
            }
        }

        _fundAllAssetBalances();
    }

    function _params(address[] memory basket) internal view returns (VaultFactory.VaultParams memory) {
        return VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: basket,
            oracle: IOracleAggregator(address(oracle)),
            capacityCapUsdc: 0,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: 0,
            exitFeeDecayPeriod: 0,
            allowedAdapters: new address[](0)
        });
    }

    function _fullBasket() internal view returns (address[] memory basket) {
        basket = new address[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            basket[i] = address(assets[i]);
        }
    }

    /// @dev Sets a NON-ZERO assetBalance for every (vault, asset) pair across all 73 vaults x 10
    /// assets = 730 combinations, WITHOUT calling stdstore 730 times (its slot search is O(storage)
    /// per call and is unusably slow at this scale). One stdstore write locates the mapping's base
    /// storage slot by writing a known value and scanning candidate slot indices for the one whose
    /// keccak256(key, slot) address holds it; every other write goes straight through vm.store.
    function _fundAllAssetBalances() internal {
        // NOT 1e18: assetUnit[a] == 10**decimals == 1e18 for every 18-decimal basket asset
        // already, before any write here, so a 1e18 seed would make the slot-scan below match
        // assetUnit's slot instead of assetBalance's on a pure value coincidence.
        uint256 seedVal = 123_456_789_012_345_678;

        stdstore.target(address(root)).sig("assetBalance(address)").with_key(address(assets[0]))
            .checked_write(seedVal);
        require(root.assetBalance(address(assets[0])) == seedVal, "stdstore seed write failed");

        for (uint256 s; s < 200; ++s) {
            bytes32 v = vm.load(address(root), keccak256(abi.encode(address(assets[0]), s)));
            if (uint256(v) == seedVal) {
                BAL_SLOT = s;
                balSlotFound = true;
                break;
            }
        }
        assertTrue(balSlotFound, "assetBalance storage slot not found by scan");

        for (uint256 i; i < N_ASSETS; ++i) {
            _setBal(address(root), address(assets[i]), seedVal);
        }
        for (uint256 c; c < N_CHILDREN; ++c) {
            for (uint256 i; i < N_ASSETS; ++i) {
                _setBal(address(children[c]), address(assets[i]), seedVal);
            }
            for (uint256 g; g < N_CHILDREN; ++g) {
                for (uint256 i; i < N_ASSETS; ++i) {
                    _setBal(address(grandchildren[c][g]), address(assets[i]), seedVal);
                }
            }
        }

        // Read-back verification on the root, one child and one grandchild.
        for (uint256 i; i < N_ASSETS; ++i) {
            assertEq(root.assetBalance(address(assets[i])), seedVal, "root balance readback");
            assertEq(children[0].assetBalance(address(assets[i])), seedVal, "child[0] balance readback");
            assertEq(
                grandchildren[0][0].assetBalance(address(assets[i])),
                seedVal,
                "grandchild[0][0] balance readback"
            );
        }
    }

    function _setBal(address vault, address asset, uint256 amt) internal {
        vm.store(vault, keccak256(abi.encode(asset, BAL_SLOT)), bytes32(amt));
    }

    /// @notice Slither calls-loop cluster A. `root.navWad()` recurses through
    /// `_holdingValueWad` -> `_fullNavWad` -> `childVaultCount`/`childVaults` for up to
    /// `MAX_LOOKTHROUGH_DEPTH` levels, at every level re-looping the FULL basket. This pins the
    /// gas cost at the code-enforced structural maximum: 8 children, 8 grandchildren per child
    /// (73 vaults total, 72 descendants), each with the full 10-asset basket funded. Raising
    /// `MAX_CHILDREN` or `MAX_LOOKTHROUGH_DEPTH` changes this fixture's shape and must move the
    /// measured gas enough to trip `NAV_GAS_CEILING` below.
    function test_navWadGasAtStructuralMaxFanOut() public {
        uint256 g0 = gasleft();
        uint256 nav = root.navWad();
        uint256 used = g0 - gasleft();

        assertGt(nav, 0, "nav computed");
        emit log_named_uint("navWad gas @ 8x8x10 (max fan-out)", used);
        emit log_named_uint(
            "descendant vault count (children + grandchildren)", N_CHILDREN + N_CHILDREN * N_CHILDREN
        );

        assertLt(used, NAV_GAS_CEILING, "navWad gas regression at structural max fan-out");

        // The measured number is quoted in this file's @dev comment and in
        // docs/reviews/SLITHER-TRIAGE.md, and M-5's whole substance is how large it is. A
        // measured number in prose is a citation like any other, so pin it: 1% is far wider than
        // forge's run-to-run variance (there is none for a fixed build) and far narrower than the
        // 2.9% drift that went unnoticed under the ceiling alone.
        assertApproxEqRel(
            used,
            NAV_GAS_MEASURED,
            0.01e18,
            "navWad gas moved away from the recorded measurement - re-read the logged number "
            "above and update NAV_GAS_MEASURED, this file's @dev comment and "
            "docs/reviews/SLITHER-TRIAGE.md together"
        );

        // Structure guards so this fixture cannot silently shrink out from under the ceiling.
        assertEq(root.childVaultCount(), N_CHILDREN, "root fan-out");
        assertEq(VaultCore(root.childVaults(0)).childVaultCount(), N_CHILDREN, "child fan-out");
        assertEq(root.MAX_CHILDREN(), N_CHILDREN, "MAX_CHILDREN constant");
        assertEq(root.MAX_BASKET_ASSETS(), N_ASSETS, "MAX_BASKET_ASSETS constant");
        assertEq(root.MAX_LOOKTHROUGH_DEPTH(), 3, "MAX_LOOKTHROUGH_DEPTH constant");
        assertEq(root.basketLength(), N_ASSETS, "basket length");
    }

    /// @notice Slither calls-loop cluster A, the other half of the bound. The code-level
    /// look-through recursion guard (`MAX_LOOKTHROUGH_DEPTH = 3`) admits three pricing levels
    /// (root's own basket plus two descendant levels — depth 0,1,2), which would in principle
    /// allow a 4th vault generation (1 + 8 + 64 + 512 = 584 nodes) if the registry ever let one
    /// register. It never can: `SubVaultRegistry.MAX_DEPTH = 3` requires `parentDepth + 1 <
    /// MAX_DEPTH`, so only depths 0, 1, 2 are registrable — exactly the two descendant levels
    /// this file builds (72 nodes). A great-grandchild registration must revert `DepthExceeded`.
    /// If the registry's cap were ever loosened without a matching code-level check, this test
    /// would start failing where the gas-ceiling test above would not — it is the one place a
    /// 4th-level regression is caught.
    function test_registryCapsDescendantLevelsAtTwo_soLookthroughDepthThreeIsSlack() public {
        address grandchild = address(grandchildren[0][0]);
        assertEq(subReg.depthOf(grandchild), 2, "grandchild depth");
        assertEq(subReg.MAX_DEPTH(), 3, "registry MAX_DEPTH");

        address[] memory basket = _fullBasket();
        vm.prank(operator);
        vm.expectRevert(SubVaultRegistry.DepthExceeded.selector);
        factory.createChildVault(_params(basket), grandchild);
    }

    /// @notice Slither calls-loop cluster A's fan-out bound is only real if childVaults growth
    /// is access-controlled AND capped. An untrusted caller able to call `allocateToChild` could
    /// register children past `MAX_CHILDREN` (governance is the only allowed caller) or, if the
    /// cap itself were missing, blow the navWad recursion past this file's measured ceiling. Both
    /// guards are pinned here: an arbitrary EOA is refused `OnlyGovernance`, and governance
    /// itself is refused `TooManyChildren` once the vault already holds MAX_CHILDREN registered
    /// children — even though `createChildVault` (registry registration) itself has no fan-out
    /// cap and happily creates a 9th vault under root.
    function test_childVaultsCannotBeGrownByAnUntrustedCaller() public {
        address randomEOA = makeAddr("randomEOA");
        vm.prank(randomEOA);
        vm.expectRevert(VaultCore.OnlyGovernance.selector);
        root.allocateToChild(address(children[0]), 1);

        // registerChild has no fan-out cap of its own; a 9th child vault registers fine.
        address[] memory basket = _fullBasket();
        vm.prank(operator);
        address ninthChild = factory.createChildVault(_params(basket), address(root));

        // allocateToChild is where MAX_CHILDREN actually bites.
        vm.prank(address(gov));
        vm.expectRevert(VaultCore.TooManyChildren.selector);
        root.allocateToChild(ninthChild, 1);
    }
}
