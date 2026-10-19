// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Create2ProxyFixture} from "./helpers/Create2ProxyFixture.sol";
import {ProtocolCreate2} from "../script/lib/ProtocolCreate2.sol";
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {FeeEngine} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";

/// @notice The same-address protocol set. Every singleton whose address must match across chains
/// takes no per-chain value in its initcode; per-chain values arrive afterwards through a one-shot
/// call gated on PROTOCOL_INITIALIZER. This suite proves, for the four edited contracts:
///   - only PROTOCOL_INITIALIZER can wire or initialise, and only once;
///   - an unwired or uninitialised singleton does nothing, and an uninitialised factory creates nothing;
///   - the whole set deploys through the Arachnid proxy to the predicted addresses, identically under
///     each of the five launch chain ids, while the per-chain allowlist still differs.
contract Create2ProtocolTest is Create2ProxyFixture {
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    Governance gov;
    VaultFactory factory;
    FeeEngine fees;
    VaultDeployer vaultDeployer;

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle blessed;
    MockOracle rogue;

    address creator = makeAddr("creator");

    function setUp() public {
        vm.warp(1_000_000);
        _etchCreate2Proxy();
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        blessed = new MockOracle();
        rogue = new MockOracle();
        blessed.setPrice(address(weth), 2500e18);
        rogue.setPrice(address(weth), 2500e18);
    }

    function _deploySet() internal {
        ProtocolCreate2.Set memory s = ProtocolCreate2.createAll();
        registry = OperatorRegistry(s.operatorRegistry);
        subReg = SubVaultRegistry(s.subVaultRegistry);
        fees = FeeEngine(s.feeEngine);
        gov = Governance(s.governance);
        vaultDeployer = VaultDeployer(s.vaultDeployer);
        factory = VaultFactory(s.vaultFactory);
    }

    function _oneOracle(address o) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = o;
    }

    function _wireAll() internal {
        vm.startPrank(PROTOCOL_INITIALIZER);
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));
        vm.stopPrank();
    }

    function _params(address oracle) internal view returns (VaultFactory.VaultParams memory) {
        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        return VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: basket,
            oracle: IOracleAggregator(oracle),
            capacityCapUsdc: 0,
            minDepositUsdc: 10e6,
            exitFeeMaxBps: 50,
            exitFeeDecayPeriod: 30 days,
            allowedAdapters: new address[](0)
        });
    }

    // ───────────────────────── the gate: only PROTOCOL_INITIALIZER ─────────────────────────

    function test_initializerIsTheArcDeployerEoa() public pure {
        assertEq(PROTOCOL_INITIALIZER, 0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35, "the owner-held key");
    }

    function test_deployerGettersReadTheConstant() public {
        _deploySet();
        assertEq(registry.deployer(), PROTOCOL_INITIALIZER);
        assertEq(subReg.deployer(), PROTOCOL_INITIALIZER);
        assertEq(gov.deployer(), PROTOCOL_INITIALIZER);
    }

    /// @notice The CREATE2 proxy is the `msg.sender` of every constructor. Under the old
    /// `deployer = msg.sender` gate that made the proxy the deployer and the wiring unreachable; now
    /// the proxy, the test contract and any other address are all refused.
    function testFuzz_wireRefusesEveryoneButInitializer(address caller) public {
        vm.assume(caller != PROTOCOL_INITIALIZER);
        _deploySet();
        vm.startPrank(caller);
        vm.expectRevert(OperatorRegistry.OnlyDeployer.selector);
        registry.wire(address(factory), address(fees));
        vm.expectRevert(SubVaultRegistry.OnlyDeployer.selector);
        subReg.wire(address(factory));
        vm.expectRevert(Governance.OnlyDeployer.selector);
        gov.wireSubVaultRegistry(address(subReg));
        vm.stopPrank();
        assertFalse(registry.initialized() || subReg.initialized() || gov.initialized(), "nothing wired");
    }

    function test_proxyAndThisContractAreRefused() public {
        _deploySet();
        address[2] memory callers = [ProtocolCreate2.PROXY, address(this)];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(OperatorRegistry.OnlyDeployer.selector);
            registry.wire(address(factory), address(fees));
            vm.expectRevert(SubVaultRegistry.OnlyDeployer.selector);
            subReg.wire(address(factory));
            vm.expectRevert(Governance.OnlyDeployer.selector);
            gov.wireSubVaultRegistry(address(subReg));
            vm.expectRevert(VaultFactory.OnlyInitializer.selector);
            factory.initialize(new address[](0));
            vm.stopPrank();
        }
    }

    function testFuzz_factoryInitializeRefusesEveryoneButInitializer(address caller) public {
        vm.assume(caller != PROTOCOL_INITIALIZER);
        _deploySet();
        vm.prank(caller);
        vm.expectRevert(VaultFactory.OnlyInitializer.selector);
        factory.initialize(_oneOracle(address(blessed)));
        assertFalse(factory.initialized(), "still uninitialised");
    }

    // ───────────────────────── once only ─────────────────────────

    function test_wireIsOnceOnlyForEachRegistry() public {
        _deploySet();
        _wireAll();
        vm.startPrank(PROTOCOL_INITIALIZER);
        vm.expectRevert(OperatorRegistry.AlreadyWired.selector);
        registry.wire(address(1), address(2));
        vm.expectRevert(SubVaultRegistry.AlreadyWired.selector);
        subReg.wire(address(1));
        vm.expectRevert(Governance.AlreadyWiredSubRegistry.selector);
        gov.wireSubVaultRegistry(address(1));
        vm.stopPrank();
        assertEq(registry.factory(), address(factory), "first wiring stands");
        assertEq(subReg.factory(), address(factory), "first wiring stands");
        assertEq(gov.subVaultRegistry(), address(subReg), "first wiring stands");
    }

    function test_factoryInitializeIsOnceOnly() public {
        _deploySet();
        vm.startPrank(PROTOCOL_INITIALIZER);
        factory.initialize(_oneOracle(address(blessed)));
        vm.expectRevert(VaultFactory.AlreadyInitialized.selector);
        factory.initialize(_oneOracle(address(rogue)));
        vm.expectRevert(VaultFactory.AlreadyInitialized.selector);
        factory.initialize(new address[](0));
        vm.stopPrank();
        assertTrue(factory.isAllowedOracle(address(blessed)), "first allowlist stands");
        assertFalse(factory.isAllowedOracle(address(rogue)), "second call changed nothing");
        assertTrue(factory.oracleAllowlistEnforced(), "enforcement not switched off by a second call");
    }

    // ───────────────────────── initialized() views ─────────────────────────

    function test_initializedViewsFlipOnTheCall() public {
        _deploySet();
        assertFalse(registry.initialized(), "registry before");
        assertFalse(subReg.initialized(), "subReg before");
        assertFalse(gov.initialized(), "gov before");
        assertFalse(factory.initialized(), "factory before");

        vm.prank(PROTOCOL_INITIALIZER);
        factory.initialize(_oneOracle(address(blessed)));
        assertTrue(factory.initialized(), "factory after");

        vm.prank(PROTOCOL_INITIALIZER);
        registry.wire(address(factory), address(fees));
        assertTrue(registry.initialized(), "registry after");
        assertFalse(subReg.initialized(), "subReg still before");

        vm.prank(PROTOCOL_INITIALIZER);
        subReg.wire(address(factory));
        assertTrue(subReg.initialized(), "subReg after");
        assertFalse(gov.initialized(), "gov still before");

        vm.prank(PROTOCOL_INITIALIZER);
        gov.wireSubVaultRegistry(address(subReg));
        assertTrue(gov.initialized(), "gov after");
    }

    // ───────────────────────── uninitialised refusal ─────────────────────────

    /// @notice An uninitialised factory has its oracle allowlist OFF (`oracleAllowlistEnforced` false),
    /// the C-6-open state. It must create nothing, not even with a rogue oracle that would pass an
    /// unenforced allowlist.
    function test_uninitialisedFactoryCreatesNothing() public {
        _deploySet();
        assertFalse(factory.oracleAllowlistEnforced(), "C-6-open state before initialize");
        vm.prank(creator);
        vm.expectRevert(VaultFactory.NotInitialized.selector);
        factory.createVault(_params(address(rogue)));
        vm.prank(creator);
        vm.expectRevert(VaultFactory.NotInitialized.selector);
        factory.createChildVault(_params(address(rogue)), address(0xBEEF));
        assertEq(factory.vaultCount(), 0, "no vault exists");
    }

    function test_uninitialisedFactoryRefusesEvenWhenTheRegistryIsWired() public {
        _deploySet();
        _wireAll(); // the hazard: the registry points at a factory that was never initialised
        vm.prank(creator);
        vm.expectRevert(VaultFactory.NotInitialized.selector);
        factory.createVault(_params(address(rogue)));
        assertEq(registry.operatorCount(), 0, "no operator attested");
    }

    function test_unwiredRegistriesAttestAndRegisterNothing() public {
        _deploySet();
        // factory-only entry points: the factory is unset, so no caller qualifies, the initializer included.
        address[3] memory callers = [PROTOCOL_INITIALIZER, address(factory), address(this)];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(OperatorRegistry.OnlyFactory.selector);
            registry.attestVault(address(0x1234), creator);
            vm.expectRevert(OperatorRegistry.OnlyFeeEngine.selector);
            registry.recordFeeCollected(1, 1);
            vm.expectRevert(SubVaultRegistry.OnlyFactory.selector);
            subReg.registerChild(address(0x1), address(0x2), 50);
            vm.stopPrank();
        }
        assertEq(registry.operatorCount(), 0, "nothing attested");
        assertEq(subReg.depthOf(address(0x2)), 0, "nothing registered");
    }

    function test_initializeRejectsZeroAndCodelessOracles() public {
        _deploySet();
        vm.startPrank(PROTOCOL_INITIALIZER);
        vm.expectRevert(VaultFactory.OracleNotAllowed.selector);
        factory.initialize(_oneOracle(address(0)));
        vm.expectRevert(VaultFactory.OracleNotAllowed.selector);
        factory.initialize(_oneOracle(address(0xDEAD)));
        vm.stopPrank();
        assertFalse(factory.initialized(), "a rejected call leaves the factory uninitialised");
        assertFalse(factory.oracleAllowlistEnforced(), "and the flag unset");
    }

    // ───────────────────────── initialised: behaves as before ─────────────────────────

    function test_initialisedFactoryEnforcesTheAllowlist() public {
        _deploySet();
        vm.prank(PROTOCOL_INITIALIZER);
        factory.initialize(_oneOracle(address(blessed)));
        _wireAll();
        assertTrue(factory.oracleAllowlistEnforced(), "enforced");
        vm.prank(creator);
        vm.expectRevert(VaultFactory.OracleNotAllowed.selector);
        factory.createVault(_params(address(rogue)));
        vm.prank(creator);
        address v = factory.createVault(_params(address(blessed)));
        assertEq(address(VaultCore(v).oracle()), address(blessed), "vault built on the blessed oracle");
        assertEq(registry.operatorOf(v), registry.operatorIdOf(creator), "attested to its creator");
    }

    function test_initialisedFactoryWithEmptyListLeavesEnforcementOff() public {
        _deploySet();
        vm.prank(PROTOCOL_INITIALIZER);
        factory.initialize(new address[](0));
        _wireAll();
        assertFalse(factory.oracleAllowlistEnforced(), "empty list: enforcement off, as before");
        vm.prank(creator);
        factory.createVault(_params(address(rogue)));
        assertEq(factory.vaultCount(), 1, "created");
    }

    // ───────────────────────── the recipe: same address on every chain ─────────────────────────

    function test_deploySetLandsAtPredictedAddresses() public {
        ProtocolCreate2.Set memory p = ProtocolCreate2.predict();
        assertEq(p.operatorRegistry.code.length, 0, "empty before");
        _deploySet();
        assertEq(address(registry), p.operatorRegistry);
        assertEq(address(subReg), p.subVaultRegistry);
        assertEq(address(fees), p.feeEngine);
        assertEq(address(gov), p.governance);
        assertEq(address(vaultDeployer), p.vaultDeployer);
        assertEq(address(factory), p.vaultFactory);
        assertGt(address(factory).code.length, 0, "factory has code");
        assertEq(address(factory.vaultDeployer()), p.vaultDeployer, "factory pins the predicted deployer");
        assertEq(address(factory.registry()), p.operatorRegistry, "and the predicted registry");
    }

    /// @notice Same salts, same initcode, five chain ids: one address set, one runtime codehash set.
    /// The per-chain allowlist differs between chains and does not move the factory.
    function test_sameAddressesAndCodeOnEveryLaunchChain() public {
        uint256[5] memory ids = [uint256(5042), 8453, 42161, 1, 137];
        ProtocolCreate2.Set memory expected = ProtocolCreate2.predict();
        bytes32 factoryHash;
        for (uint256 i; i < ids.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.chainId(ids[i]);
            assertEq(block.chainid, ids[i], "chain id set");
            ProtocolCreate2.Set memory s = ProtocolCreate2.predict();
            assertEq(s.vaultFactory, expected.vaultFactory, "prediction independent of chain id");
            _deploySet();
            assertEq(address(factory), expected.vaultFactory, "factory address");
            assertEq(address(registry), expected.operatorRegistry, "registry address");
            if (i == 0) factoryHash = address(factory).codehash;
            assertEq(address(factory).codehash, factoryHash, "factory runtime identical");
            // a different oracle list on each chain
            MockOracle perChain = new MockOracle();
            vm.prank(PROTOCOL_INITIALIZER);
            factory.initialize(_oneOracle(address(perChain)));
            assertTrue(factory.isAllowedOracle(address(perChain)), "this chain's oracle");
            assertEq(address(factory), expected.vaultFactory, "initialize moves no address");
            vm.revertToState(snap);
        }
    }

    /// @notice Code squatting: anyone may deploy our exact initcode to our address, and gets nothing
    /// they can use. A second deploy to the same salt reverts, and the squatter cannot initialise.
    function test_squattedSingletonsCannotBeInitialisedByTheSquatter() public {
        address squatter = makeAddr("squatter");
        vm.startPrank(squatter);
        ProtocolCreate2.Set memory s = ProtocolCreate2.createAll();
        vm.stopPrank();
        vm.prank(squatter);
        vm.expectRevert(VaultFactory.OnlyInitializer.selector);
        VaultFactory(s.vaultFactory).initialize(_oneOracle(address(blessed)));
        vm.prank(squatter);
        vm.expectRevert(OperatorRegistry.OnlyDeployer.selector);
        OperatorRegistry(s.operatorRegistry).wire(squatter, squatter);
        vm.expectRevert(bytes("ProtocolCreate2: CREATE2 through the proxy failed"));
        this.redeploy{gas: 5_000_000}();
    }

    function redeploy() external {
        ProtocolCreate2.create(
            ProtocolCreate2.SALT_OPERATOR_REGISTRY, ProtocolCreate2.initcodeOperatorRegistry()
        );
    }
}
