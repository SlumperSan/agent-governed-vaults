// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// C-6 factory gate — "curated oracle" launch remediation.
//
// A vault's oracle is creator-supplied, and oracle safety CANNOT be enforced permissionlessly: the
// custom OracleAggregator lets two adversarial sources seize an asset's price (C-6), and even a
// ChainlinkOracle pointed at a creator-controlled FAKE AggregatorV3 prices whatever the creator
// wants — both pass every per-oracle constructor check, and there is no on-chain way for the
// factory to tell a genuine Chainlink feed from a fake. The launch resolution is CURATION: the
// factory carries an immutable allowlist of blessed oracle instances (ChainlinkOracle over verified
// genuine feeds), and createVault/createChildVault refuse any oracle not on it. An EMPTY allowlist
// disables enforcement (local/tests / a deliberately-permissionless post-audit deployment).
//
// This suite proves the gate both ways: with an allowlist, only the blessed oracle is accepted;
// with an empty allowlist, enforcement is off.

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {VaultFactory, IVaultDeployer} from "../../src/VaultFactory.sol";
import {VaultDeployer} from "../../src/VaultDeployer.sol";
import {SubVaultRegistry} from "../../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../../src/FeeEngine.sol";
import {Governance} from "../../src/Governance.sol";
import {IOperatorRegistry} from "../../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "../mocks/Mocks.sol";

contract AuditOracleAllowlistTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle blessed; // the curated / allowlisted oracle
    MockOracle rogue; // a creator-supplied oracle NOT on the allowlist (stands in for a weak/fake one)
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;

    address creator = makeAddr("creator");

    function _factory(address[] memory allowedOracles) internal returns (VaultFactory f) {
        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        gov = new Governance();
        f = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(subReg),
            IVaultDeployer(address(new VaultDeployer())),
            false, // root-only
            allowedOracles
        );
        registry.wire(address(f), address(fees));
        subReg.wire(address(f));
        gov.wireSubVaultRegistry(address(subReg));
    }

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        blessed = new MockOracle();
        rogue = new MockOracle();
        blessed.setPrice(address(weth), 2500e18);
        rogue.setPrice(address(weth), 2500e18);
    }

    function _params(address oracle) internal view returns (VaultFactory.VaultParams memory) {
        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        return VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: basket,
            oracle: IOracleAggregator(oracle),
            capacityCapUsdc: 0,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: 50,
            exitFeeDecayPeriod: 30 days,
            allowedAdapters: new address[](0)
        });
    }

    // ── enforcement ON: only the blessed oracle is accepted ───────────────────
    function test_remediated_c6_onlyAllowlistedOracleMayBackAVault() public {
        address[] memory allow = new address[](1);
        allow[0] = address(blessed);
        VaultFactory factory = _factory(allow);
        assertTrue(factory.oracleAllowlistEnforced(), "allowlist enforced");
        assertTrue(factory.isAllowedOracle(address(blessed)), "blessed is allowed");
        assertFalse(factory.isAllowedOracle(address(rogue)), "rogue is not allowed");

        // A creator-supplied oracle that is NOT blessed (a weak custom aggregator, or a
        // ChainlinkOracle over a fake feed) is refused — the C-6 vector is closed.
        vm.prank(creator);
        vm.expectRevert(VaultFactory.OracleNotAllowed.selector);
        factory.createVault(_params(address(rogue)));

        // The blessed oracle creates a vault fine.
        vm.prank(creator);
        address vault = factory.createVault(_params(address(blessed)));
        assertEq(address(VaultCore(vault).oracle()), address(blessed), "vault wired to the blessed oracle");
    }

    // ── enforcement OFF: an empty allowlist is permissive (tests / post-audit) ─
    function test_emptyAllowlistDisablesEnforcement() public {
        VaultFactory factory = _factory(new address[](0));
        assertFalse(factory.oracleAllowlistEnforced(), "empty allowlist => not enforced");

        // With enforcement off, any oracle is accepted.
        vm.prank(creator);
        address v1 = factory.createVault(_params(address(blessed)));
        vm.prank(creator);
        address v2 = factory.createVault(_params(address(rogue)));
        assertTrue(v1 != address(0) && v2 != address(0), "both oracles accepted when unenforced");
    }
}
