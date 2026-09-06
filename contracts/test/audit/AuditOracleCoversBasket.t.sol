// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Oracle-covers-basket gate — closes the "creatable permanent brick" hole found by the pre-mainnet
// adversarial review of the C-6 pivot.
//
// The C-6 allowlist blesses an oracle INSTANCE; it never proved that instance can price the vault's
// BASKET. A creator could therefore pair a fully-blessed oracle with a basket asset that oracle does
// not list. Nothing failed at creation, and nothing failed on a USDC deposit either (navWad reads
// priceWad only for non-zero balances). The first rebalance INTO that asset then made every
// NAV-reading path -- navWad, deposit, activate, and EXIT -- revert StaleOracle forever, with the
// funds sealed inside an immutable contract. Fail-closed pricing is the right posture, but it turns
// this particular misconfiguration into an unrecoverable one, so the only safe place to catch it is
// before the vault exists.
//
// VaultFactory now probes `priceWad(asset)` for every basket asset at creation (the exact call NAV
// will make) and reverts OracleMissingAsset if the oracle cannot price it. This suite proves the
// gate for both shapes of "cannot price": a REVERTING oracle (ChainlinkOracle's unlisted-asset
// behaviour) and a ZERO-returning one, plus that a fully-covered basket still creates fine and that
// the check does not preempt VaultCore's own basket validation.

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

/// @dev An oracle that REVERTS StaleOracle for any asset it does not list — the ChainlinkOracle
/// shape (its `feedOf[asset].feed == address(0)` sentinel reverts rather than returning 0).
contract RevertingUnlistedOracle is IOracleAggregator {
    mapping(address => uint256) public price;

    function setPrice(address asset, uint256 p) external {
        price[asset] = p;
    }

    function priceWad(address asset) external view returns (uint256) {
        uint256 p = price[asset];
        if (p == 0) revert StaleOracle(asset); // unlisted => breaker, never zero
        return p;
    }
}

contract AuditOracleCoversBasketTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 unpriced; // a basket asset the oracle does NOT list

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
            false, // root-only (C-1)
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
        unpriced = new MockERC20("UNPRICED", 18);
    }

    function _params(address oracle, address[] memory basket)
        internal
        view
        returns (VaultFactory.VaultParams memory)
    {
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

    function _basket2() internal view returns (address[] memory b) {
        b = new address[](2);
        b[0] = address(weth);
        b[1] = address(unpriced);
    }

    // ── the brick is unreachable: a REVERTING (ChainlinkOracle-shaped) oracle ──────────────
    function test_remediated_revertingOracleCannotBackAnUnpricedBasketAsset() public {
        RevertingUnlistedOracle oracle = new RevertingUnlistedOracle();
        oracle.setPrice(address(weth), 2500e18); // WETH listed; `unpriced` deliberately is not
        address[] memory allow = new address[](1);
        allow[0] = address(oracle);
        VaultFactory factory = _factory(allow);

        // The oracle IS blessed — the C-6 allowlist is satisfied and says nothing about coverage.
        assertTrue(factory.isAllowedOracle(address(oracle)), "oracle is blessed");

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.OracleMissingAsset.selector, address(unpriced)));
        factory.createVault(_params(address(oracle), _basket2()));
    }

    // ── the brick is unreachable: an oracle that returns ZERO for an unlisted asset ────────
    function test_remediated_zeroReturningOracleCannotBackAnUnpricedBasketAsset() public {
        MockOracle oracle = new MockOracle(); // returns 0 for anything unset
        oracle.setPrice(address(weth), 2500e18);
        address[] memory allow = new address[](1);
        allow[0] = address(oracle);
        VaultFactory factory = _factory(allow);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.OracleMissingAsset.selector, address(unpriced)));
        factory.createVault(_params(address(oracle), _basket2()));
    }

    // ── control: a fully-covered basket still creates, and prices ─────────────────────────
    function test_control_fullyCoveredBasketCreatesNormally() public {
        MockOracle oracle = new MockOracle();
        oracle.setPrice(address(weth), 2500e18);
        oracle.setPrice(address(unpriced), 7e18); // now covered too
        address[] memory allow = new address[](1);
        allow[0] = address(oracle);
        VaultFactory factory = _factory(allow);

        vm.prank(creator);
        address vault = factory.createVault(_params(address(oracle), _basket2()));
        assertEq(address(VaultCore(vault).oracle()), address(oracle), "vault wired to the oracle");
        // And the vault can actually price its own basket - the property the gate exists to ensure.
        assertEq(VaultCore(vault).navWad(), 0, "fresh vault prices to zero NAV without reverting");
    }

    // ── the gate also applies with the allowlist DISABLED (empty = permissive) ────────────
    // Coverage is a correctness property of the vault itself, not of the C-6 curation regime, so it
    // must hold on a permissive factory too.
    function test_remediated_coverageEnforcedEvenWhenAllowlistDisabled() public {
        MockOracle oracle = new MockOracle();
        oracle.setPrice(address(weth), 2500e18);
        VaultFactory factory = _factory(new address[](0)); // empty => enforcement off
        assertFalse(factory.oracleAllowlistEnforced(), "allowlist disabled");

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.OracleMissingAsset.selector, address(unpriced)));
        factory.createVault(_params(address(oracle), _basket2()));
    }

    // ── ordering: VaultCore still diagnoses a malformed basket first ──────────────────────
    // The coverage probe runs AFTER _deploy so VaultCore's constructor keeps ownership of basket
    // validity (duplicates/zero/USDC/decimals/cap -> BadConfig). A duplicate-asset basket must still
    // surface as BadConfig, not as OracleMissingAsset.
    function test_vaultCoreBasketValidationStillSpeaksFirst() public {
        MockOracle oracle = new MockOracle();
        oracle.setPrice(address(weth), 2500e18);
        VaultFactory factory = _factory(new address[](0));

        address[] memory dup = new address[](2);
        dup[0] = address(weth);
        dup[1] = address(weth); // duplicate — VaultCore's own BadConfig
        vm.prank(creator);
        vm.expectRevert(VaultCore.BadConfig.selector);
        factory.createVault(_params(address(oracle), dup));
    }
}
