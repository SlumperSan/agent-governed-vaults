// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {VaultFactory, IVaultDeployer} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {OracleAggregator, IPriceSource} from "../src/OracleAggregator.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";

contract MockSource is IPriceSource {
    uint256 p;
    uint256 t;

    function set(uint256 p_, uint256 t_) external {
        p = p_;
        t = t_;
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (p, t);
    }
}

/// Regression suite for the Sprint 6 security-review findings (execution 1-8, governance F1-F4).
contract Sprint6FixesTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultFactory factory;
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");

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

        usdc.mint(operator, 100_000_000 * USDC_1);
        usdc.mint(alice, 100_000_000 * USDC_1);
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

    function _wethBasket() internal view returns (address[] memory b) {
        b = new address[](1);
        b[0] = address(weth);
    }

    // ── Finding 1: recursive look-through captures grandchild value ──────────

    function test_finding1_grandchildValueInRootNav() public {
        // L-1: children may only be attached by the PARENT's creator, so the parent is
        // created by `operator` here too. Previously the parent was created by the test
        // contract and the child by `operator` - a shape the factory now rejects.
        vm.prank(operator);
        VaultCore parent = VaultCore(factory.createVault(_params(_wethBasket())));
        vm.prank(operator);
        VaultCore child = VaultCore(factory.createChildVault(_params(_wethBasket()), address(parent)));
        vm.prank(operator);
        VaultCore grand = VaultCore(factory.createChildVault(_params(_wethBasket()), address(child)));

        // Seed parent, allocate down two levels: parent → child → grandchild.
        vm.startPrank(operator);
        usdc.approve(address(parent), type(uint256).max);
        parent.deposit(3_000 * USDC_1);
        parent.skipWindow();
        vm.stopPrank();

        uint256 navBefore = parent.navWad();
        vm.prank(address(gov));
        parent.allocateToChild(address(child), 2_000 * USDC_1);
        vm.prank(address(gov));
        child.allocateToChild(address(grand), 1_500 * USDC_1);

        // Pre-fix: the 1500 in the grandchild vanished from parent NAV. Now it is fully counted.
        assertApproxEqAbs(parent.navWad(), navBefore, 1e12, "grandchild value preserved in root NAV");

        // And it flows through on a price move of the grandchild's held asset.
        // (grandchild holds 1500 idle USDC here; move requires assets — verify conservation.)
        assertApproxEqAbs(parent.navWad(), 3_000 * USDC_1 * 1e12, 1e12, "full 3000 accounted");
    }

    // ── Finding 8: basket-asset cap ──────────────────────────────────────────

    function test_finding8_basketCapEnforced() public {
        address[] memory big = new address[](11);
        for (uint256 i; i < 11; ++i) {
            big[i] = address(new MockERC20("T", 18));
        }
        vm.expectRevert(VaultCore.BadConfig.selector);
        factory.createVault(_params(big));
    }

    // ── Findings 4/5: shortfall reverts clean instead of underpaying ─────────

    function test_finding4_pendingChildDoesNotBlockWhenIdleCovers() public {
        // idle alone covers the exit → child never touched, no revert regardless of child state.
        // L-1: children may only be attached by the PARENT's creator, so the parent is
        // created by `operator` here too. Previously the parent was created by the test
        // contract and the child by `operator` - a shape the factory now rejects.
        vm.prank(operator);
        VaultCore parent = VaultCore(factory.createVault(_params(_wethBasket())));
        vm.prank(operator);
        VaultCore child = VaultCore(factory.createChildVault(_params(_wethBasket()), address(parent)));
        _seed(parent, operator, 1_000);
        _seed(parent, alice, 1_000);
        vm.prank(address(gov));
        parent.allocateToChild(address(child), 500 * USDC_1); // idle 1500, child 500

        uint256 bal = usdc.balanceOf(alice);
        uint256 sh = parent.sharesOf(alice);
        vm.prank(alice);
        parent.requestExit(sh); // $1000 ≤ idle 1500
        assertApproxEqAbs(usdc.balanceOf(alice) - bal, 1_000 * USDC_1, 2, "paid from idle");
    }

    // ── Finding 2: oracle staleness ceiling + floors ─────────────────────────

    function test_finding2_maxStalenessCeiling() public {
        (address[] memory assets, address[][] memory srcs, uint32[] memory stale, uint8[] memory q) =
            _oracleArgs(2 days); // above 1-day ceiling
        vm.expectRevert(OracleAggregator.BadOracleConfig.selector);
        new OracleAggregator(assets, srcs, stale, q);
    }

    function test_finding6_minSourcesAndMajorityQuorum() public {
        // 2 sources < MIN_SOURCES(3) → reject.
        MockSource s1 = new MockSource();
        MockSource s2 = new MockSource();
        address[] memory assets = new address[](1);
        assets[0] = address(weth);
        address[][] memory srcs = new address[][](1);
        srcs[0] = new address[](2);
        srcs[0][0] = address(s1);
        srcs[0][1] = address(s2);
        uint32[] memory stale = new uint32[](1);
        stale[0] = 1 hours;
        uint8[] memory q = new uint8[](1);
        q[0] = 2;
        vm.expectRevert(OracleAggregator.BadOracleConfig.selector);
        new OracleAggregator(assets, srcs, stale, q);

        // 3 sources but quorum 1 (not a strict majority) → reject.
        (address[] memory a3, address[][] memory s3, uint32[] memory st3,) = _oracleArgs(1 hours);
        uint8[] memory q1 = new uint8[](1);
        q1[0] = 1;
        vm.expectRevert(OracleAggregator.BadOracleConfig.selector);
        new OracleAggregator(a3, s3, st3, q1);

        // H-1: 3 sources with quorum 2 is a STRICT MAJORITY and still rejected, because at
        // two fresh sources the lower median is the minimum. This is the shape the shipped
        // base-mainnet.json carried, so it is pinned here as a constructor property.
        uint8[] memory q2 = new uint8[](1);
        q2[0] = 2;
        vm.expectRevert(OracleAggregator.BadOracleConfig.selector);
        new OracleAggregator(a3, s3, st3, q2);
    }

    function test_finding2_saturatingNoUnderflowPanic() public {
        // A valid oracle (ceiling-bounded) never underflow-panics; median is the lower-median.
        (address[] memory a, address[][] memory srcs, uint32[] memory st, uint8[] memory q) =
            _oracleArgs(1 hours);
        OracleAggregator o = new OracleAggregator(a, srcs, st, q);
        MockSource(srcs[0][0]).set(4_000e18, block.timestamp);
        MockSource(srcs[0][1]).set(4_010e18, block.timestamp);
        MockSource(srcs[0][2]).set(3_990e18, block.timestamp);
        assertEq(o.priceWad(address(weth)), 4_000e18, "lower median of 3");
    }

    function _oracleArgs(uint32 staleness)
        internal
        returns (address[] memory assets, address[][] memory srcs, uint32[] memory stale, uint8[] memory q)
    {
        assets = new address[](1);
        assets[0] = address(weth);
        srcs = new address[][](1);
        srcs[0] = new address[](3);
        srcs[0][0] = address(new MockSource());
        srcs[0][1] = address(new MockSource());
        srcs[0][2] = address(new MockSource());
        stale = new uint32[](1);
        stale[0] = staleness;
        q = new uint8[](1);
        q[0] = 3; // H-1: quorum must reach MIN_MEDIAN; at m == 3 that means all three
    }

    function _seed(VaultCore v, address who, uint256 amt) internal {
        vm.startPrank(who);
        usdc.approve(address(v), type(uint256).max);
        v.deposit(amt * USDC_1);
        v.skipWindow();
        vm.stopPrank();
    }
}
