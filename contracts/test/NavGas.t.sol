// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {OracleAggregator, IPriceSource} from "../src/OracleAggregator.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20} from "./mocks/Mocks.sol";

contract Src is IPriceSource {
    uint256 immutable px;

    constructor(uint256 p) {
        px = p;
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (px, block.timestamp);
    }
}

/// Empirically bounds navWad gas at a deep (depth-3) sub-vault config with a real multi-source
/// oracle, closing Finding 8 (the recursive look-through must stay gas-bounded) and guarding
/// against any future regression that makes NAV reads unboundedly expensive — a DoS surface,
/// since navWad runs on the deposit and exit paths.
contract NavGasTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20[3] assets;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultFactory factory;
    OracleAggregator oracle;
    VaultCore parent;
    VaultCore child;
    VaultCore grand;
    address operator = makeAddr("operator");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        address[] memory oAssets = new address[](3);
        address[][] memory oSrcs = new address[][](3);
        uint32[] memory stale = new uint32[](3);
        uint8[] memory quorum = new uint8[](3);
        for (uint256 i; i < 3; ++i) {
            assets[i] = new MockERC20("A", 18);
            oAssets[i] = address(assets[i]);
            // 5 sources per asset (realistic-heavy) — the median loops all of them.
            oSrcs[i] = new address[](5);
            for (uint256 j; j < 5; ++j) {
                oSrcs[i][j] = address(new Src(2000e18 + j));
            }
            stale[i] = 1 hours;
            quorum[i] = 3;
        }
        oracle = new OracleAggregator(oAssets, oSrcs, stale, quorum);

        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        gov = new Governance();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)), IGovernance(address(gov)), IFeeEngine(address(fees)), address(subReg)
        );
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));

        // Baskets: parent {A,B,C}, child {A,B}, grandchild {A} — each a subset of its parent.
        address[] memory pB = new address[](3);
        pB[0] = address(assets[0]);
        pB[1] = address(assets[1]);
        pB[2] = address(assets[2]);
        address[] memory cB = new address[](2);
        cB[0] = address(assets[0]);
        cB[1] = address(assets[1]);
        address[] memory gB = new address[](1);
        gB[0] = address(assets[0]);

        vm.startPrank(operator);
        parent = VaultCore(factory.createVault(_p(pB)));
        child = VaultCore(factory.createChildVault(_p(cB), address(parent)));
        grand = VaultCore(factory.createChildVault(_p(gB), address(child)));
        vm.stopPrank();

        // Fund + allocate down all three levels, and give each a live basket balance so every
        // priceWad path is exercised.
        usdc.mint(operator, 10_000_000 * USDC_1);
        vm.startPrank(operator);
        usdc.approve(address(parent), type(uint256).max);
        parent.deposit(1_000_000 * USDC_1);
        parent.skipWindow();
        vm.stopPrank();

        vm.prank(address(gov));
        parent.allocateToChild(address(child), 600_000 * USDC_1);
        vm.prank(address(gov));
        child.allocateToChild(address(grand), 300_000 * USDC_1);

        // Simulate held basket balances at each level (as if rebalanced).
        for (uint256 i; i < 3; ++i) {
            _hold(parent, address(assets[i]), 10e18);
        }
        _hold(child, address(assets[0]), 5e18);
        _hold(child, address(assets[1]), 5e18);
        _hold(grand, address(assets[0]), 3e18);
    }

    function _p(address[] memory basket) internal view returns (VaultFactory.VaultParams memory) {
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

    function _hold(VaultCore v, address a, uint256 amt) internal {
        // write assetBalance[a] = amt directly (simulating a settled rebalance holding).
        stdstore.target(address(v)).sig("assetBalance(address)").with_key(a).checked_write(amt);
        require(v.assetBalance(a) == amt, "slot guard");
    }

    function test_navWadGasBoundedAtDepthThree() public {
        uint256 g0 = gasleft();
        uint256 nav = parent.navWad();
        uint256 used = g0 - gasleft();
        assertGt(nav, 0, "nav computed");
        // Depth-3, 3-asset parent basket, 5 sources/asset, recursive look-through. Ceiling is
        // generous but far below the block limit — a regression that blows up NAV cost fails here.
        assertLt(used, 600_000, "navWad gas regression"); // ~237k actual, 2.5x headroom
        emit log_named_uint("navWad gas @ depth-3", used);
    }
}
