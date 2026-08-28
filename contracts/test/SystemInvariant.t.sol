// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {VaultFactory, IVaultDeployer} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";

/// Full-system handler: a parent vault with a child, real fee engine + registry, static
/// prices (price-path effects are out of scope for the accounting invariants — they are
/// argued analytically in the security reviews). Exercises deposits, exits, and
/// governance-driven child allocation/redemption to prove system-level conservation.
contract SystemHandler is Test {
    VaultCore public parent;
    VaultCore public child;
    MockERC20 public usdc;
    Governance public gov;
    address[] public actors;

    uint256 constant USDC_1 = 1e6;
    uint256 public ghostNavPsFloor; // NAVps must never fall below this for remaining members

    constructor(
        VaultCore parent_,
        VaultCore child_,
        MockERC20 usdc_,
        Governance gov_,
        address[] memory actors_
    ) {
        parent = parent_;
        child = child_;
        usdc = usdc_;
        gov = gov_;
        actors = actors_;
        for (uint256 i; i < actors.length; ++i) {
            usdc.mint(actors[i], 100_000_000 * USDC_1);
            vm.prank(actors[i]);
            usdc.approve(address(parent), type(uint256).max);
        }
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function deposit(uint256 seed, uint256 amt) external {
        address who = _actor(seed);
        amt = bound(amt, 10 * USDC_1, 500_000 * USDC_1);
        uint256 nav = parent.navWad() / 1e12;
        if (nav + parent.totalPendingUsdc() + amt > parent.capacityCapUsdc()) return;
        if (!parent.windowCleared(who) && parent.sharesOf(who) == 0) {
            (uint256 pend,) = parent.pendingDeposit(who);
            if (pend > 0) return;
        }
        vm.prank(who);
        parent.deposit(amt);
        if (!parent.windowCleared(who)) {
            vm.prank(who);
            parent.skipWindow();
        }
    }

    function exit(uint256 seed, uint256 frac) external {
        address who = _actor(seed);
        uint256 held = parent.sharesOf(who);
        if (held == 0 || parent.queuedExitShares(who) > 0) return;
        uint256 burn = bound(frac, 1, held);
        // avoid the creator gate reverting the fuzz run
        if (who == parent.creator() && parent.nonCreatorMemberCount() > 0) {
            uint256 ts = parent.totalShares();
            if ((held - burn) * 10_000 < 500 * (ts - burn)) return;
        }
        uint256 psBefore = parent.totalShares() > 0 ? parent.navPerShareWad() : 0;
        vm.prank(who);
        try parent.requestExit(burn) {
            if (parent.totalShares() > 0) {
                // §4.6 with children present: NAVps must not decrease for remainers.
                assertGe(parent.navPerShareWad() + 2, psBefore, "NAVps decreased on exit");
            }
        } catch {}
    }

    function allocate(uint256 amt) external {
        amt = bound(amt, USDC_1, 100_000 * USDC_1);
        if (parent.idleUsdc() < amt) return;
        vm.prank(address(gov));
        try parent.allocateToChild(address(child), amt) {} catch {}
    }

    function redeem(uint256 frac) external {
        uint256 held = child.sharesOf(address(parent));
        if (held == 0) return;
        uint256 sh = bound(frac, 1, held);
        vm.prank(address(gov));
        try parent.redeemFromChild(address(child), sh) {} catch {}
    }

    function sumParentShares() external view returns (uint256 s) {
        for (uint256 i; i < actors.length; ++i) {
            s += parent.sharesOf(actors[i]);
        }
    }
}

contract SystemInvariantTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultFactory factory;
    VaultCore parent;
    VaultCore child;
    SystemHandler handler;

    address operator = makeAddr("operator");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        oracle.setPrice(address(weth), 4_000e18);

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
            true, // exercises sub-vaults (createChildVault)
            new address[](0) // C-6: no oracle allowlist (permissive)
        );
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));

        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        vm.prank(operator);
        parent = VaultCore(factory.createVault(_params(basket)));
        vm.prank(operator);
        child = VaultCore(factory.createChildVault(_params(basket), address(parent)));

        // Seed the creator so the vault is never empty at start.
        usdc.mint(operator, 10_000 * USDC_1);
        vm.startPrank(operator);
        usdc.approve(address(parent), type(uint256).max);
        parent.deposit(1_000 * USDC_1);
        parent.skipWindow();
        vm.stopPrank();

        address[] memory actors = new address[](4);
        actors[0] = operator;
        for (uint256 i = 1; i < 4; ++i) {
            actors[i] = makeAddr(string(abi.encodePacked("a", i)));
        }
        handler = new SystemHandler(parent, child, usdc, gov, actors);
        targetContract(address(handler));
    }

    function _params(address[] memory basket) internal view returns (VaultFactory.VaultParams memory) {
        return VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: basket,
            oracle: IOracleAggregator(address(oracle)),
            capacityCapUsdc: 1_000_000_000 * USDC_1,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: 0,
            exitFeeDecayPeriod: 0,
            allowedAdapters: new address[](0)
        });
    }

    /// Parent share conservation across deposit/exit/allocate/redeem.
    function invariant_parentShareConservation() public view {
        assertEq(handler.sumParentShares(), parent.totalShares(), "share conservation");
    }

    /// Parent is always solvent: real USDC ≥ internal idle + escrowed pending. Child value is
    /// held as child shares, not parent USDC, so it is excluded here by design.
    function invariant_parentSolvency() public view {
        assertGe(
            usdc.balanceOf(address(parent)),
            parent.idleUsdc() + parent.totalPendingUsdc(),
            "parent USDC backing"
        );
    }

    /// Child fully backs the parent's position (parent is the only child member here).
    function invariant_childBacksParent() public view {
        if (child.totalShares() == 0) return;
        assertLe(child.sharesOf(address(parent)), child.totalShares(), "no phantom child shares");
    }

    /// The parent's child-share holding equals the child's tracked supply minus any other
    /// holders (only the parent ever deposits into the child in this system).
    function invariant_childHasOnlyParent() public view {
        assertEq(child.sharesOf(address(parent)), child.totalShares(), "parent is sole child member");
    }
}
