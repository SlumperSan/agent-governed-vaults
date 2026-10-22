// SPDX-License-Identifier: MIT
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
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";

/// @notice The factory's floor on `minDepositUsdc` (owner decision 2026-10-21, A4 freeze review
/// finding 3): every creation path refuses a minimum below 100 USDC and accepts exactly 100 USDC.
/// One revert test and one pass test per path, so removing the check from either path turns that
/// path's revert test red while the other path's tests stay green.
contract FactoryMinDepositTest is Test {
    uint256 constant FLOOR = 100_000_000; // 100 USDC in 6-decimal base units

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    Governance gov;
    VaultFactory factory;

    address operator = makeAddr("operator");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        oracle.setPrice(address(weth), 4_000e18);

        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        FeeEngine fees = new FeeEngine(IRegistryView(address(registry)));
        vm.prank(PROTOCOL_INITIALIZER);
        fees.initialize(address(0x7EA5));
        gov = new Governance();
        // allowSubVaults true so the child path reaches the floor check; the CREATE2 recipe fixes it
        // false, where createChildVault reverts SubVaultsDisabled before any parameter is read.
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(subReg),
            IVaultDeployer(address(new VaultDeployer())),
            true
        );
        vm.prank(PROTOCOL_INITIALIZER);
        factory.initialize(new address[](0));
        vm.prank(PROTOCOL_INITIALIZER);
        registry.wire(address(factory), address(fees));
        vm.prank(PROTOCOL_INITIALIZER);
        subReg.wire(address(factory));
        vm.prank(PROTOCOL_INITIALIZER);
        gov.wireSubVaultRegistry(address(subReg));
    }

    function _params(uint256 minDepositUsdc) internal view returns (VaultFactory.VaultParams memory) {
        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        return VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: basket,
            oracle: IOracleAggregator(address(oracle)),
            capacityCapUsdc: 0,
            minDepositUsdc: minDepositUsdc,
            exitFeeMaxBps: 50,
            exitFeeDecayPeriod: 30 days,
            allowedAdapters: new address[](0)
        });
    }

    function _parent() internal returns (address parent) {
        vm.prank(operator);
        parent = factory.createVault(_params(FLOOR));
    }

    function test_floorIs100Usdc() public view {
        assertEq(factory.MIN_DEPOSIT_FLOOR_USDC(), FLOOR, "floor is 100 USDC in base units");
    }

    // ── createVault ───────────────────────────────────────────────────────────

    function test_createVault_revertsOneUnitBelowFloor() public {
        vm.prank(operator);
        vm.expectRevert(VaultFactory.MinDepositBelowFloor.selector);
        factory.createVault(_params(FLOOR - 1));
        assertEq(factory.vaultCount(), 0, "nothing deployed");
    }

    function test_createVault_acceptsExactlyTheFloor() public {
        vm.prank(operator);
        address v = factory.createVault(_params(FLOOR));
        assertEq(VaultCore(v).minDepositUsdc(), FLOOR, "vault carries the floor");
        assertEq(factory.vaultCount(), 1, "deployed");
    }

    // ── createChildVault ──────────────────────────────────────────────────────

    function test_createChildVault_revertsOneUnitBelowFloor() public {
        address parent = _parent();
        vm.prank(operator);
        vm.expectRevert(VaultFactory.MinDepositBelowFloor.selector);
        factory.createChildVault(_params(FLOOR - 1), parent);
        assertEq(factory.vaultCount(), 1, "only the parent exists");
    }

    function test_createChildVault_acceptsExactlyTheFloor() public {
        address parent = _parent();
        vm.prank(operator);
        address child = factory.createChildVault(_params(FLOOR), parent);
        assertEq(VaultCore(child).minDepositUsdc(), FLOOR, "child carries the floor");
        assertEq(subReg.parentOf(child), parent, "edge registered");
    }
}
