// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
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
        // Fee model A1: nobody but PROTOCOL_INITIALIZER can set the FeeEngine treasury.
        vm.prank(squatter);
        vm.expectRevert(FeeEngine.OnlyInitializer.selector);
        FeeEngine(s.feeEngine).initialize(squatter);
        vm.expectRevert(bytes("ProtocolCreate2: CREATE2 through the proxy failed"));
        this.redeploy{gas: 5_000_000}();
    }

    function redeploy() external {
        ProtocolCreate2.create(
            ProtocolCreate2.SALT_OPERATOR_REGISTRY, ProtocolCreate2.initcodeOperatorRegistry()
        );
    }

    // ───────────────────────── guards the suite above did not reach ─────────────────────────

    /// @dev Every log the factory emitted since `vm.recordLogs()` was last called.
    function _factoryLogs() internal returns (Vm.Log[] memory out) {
        Vm.Log[] memory all = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (all[i].emitter == address(factory)) ++n;
        }
        out = new Vm.Log[](n);
        n = 0;
        for (uint256 i; i < all.length; ++i) {
            if (all[i].emitter == address(factory)) out[n++] = all[i];
        }
    }

    function _threeOracles() internal returns (address[] memory a) {
        a = new address[](3);
        for (uint256 i; i < 3; ++i) {
            a[i] = address(new MockOracle());
        }
    }

    /// @notice `scripts/lib/protocol-initialize-preflight.mjs` reads `Initialized(address[])` as the only
    /// on-chain record of what `initialize` was given, and refuses a chain on it. Nothing else ties that
    /// reader to the contract, so the topic, the layout and the order are pinned here: exactly one
    /// log from the factory, one topic (the array is not indexed), the data decoding to the input in order.
    function test_initializeEmitsTheAllowlistInOrder() public {
        _deploySet();
        address[] memory list = _threeOracles();
        vm.recordLogs();
        vm.prank(PROTOCOL_INITIALIZER);
        factory.initialize(list);
        Vm.Log[] memory logs = _factoryLogs();
        assertEq(logs.length, 1, "exactly one log from the factory");
        assertEq(logs[0].topics.length, 1, "the array is not indexed");
        assertEq(logs[0].topics[0], keccak256("Initialized(address[])"), "topic0");
        address[] memory seen = abi.decode(logs[0].data, (address[]));
        assertEq(seen.length, list.length, "all entries");
        for (uint256 i; i < list.length; ++i) {
            assertEq(seen[i], list[i], "entry in input order");
            assertTrue(factory.isAllowedOracle(list[i]), "and each is marked allowed");
        }
    }

    /// @notice An empty list is a real choice (enforcement off); the event must still record it, because
    /// "no event" and "initialized with nothing" would otherwise read the same to the preflight.
    function test_initializeWithAnEmptyListStillEmits() public {
        _deploySet();
        vm.recordLogs();
        vm.prank(PROTOCOL_INITIALIZER);
        factory.initialize(new address[](0));
        Vm.Log[] memory logs = _factoryLogs();
        assertEq(logs.length, 1, "exactly one log from the factory");
        assertEq(logs[0].topics.length, 1);
        assertEq(logs[0].topics[0], keccak256("Initialized(address[])"), "topic0");
        assertEq(abi.decode(logs[0].data, (address[])).length, 0, "empty array recorded");
    }

    /// @notice The codeless check runs on every entry, not only the first. A bad entry at position 0, 1
    /// or 2 of a list reverts the whole call, leaves the factory uninitialised, and marks nothing.
    function test_initializeRejectsACodelessOracleAtAnyPosition() public {
        _deploySet();
        for (uint256 bad; bad < 3; ++bad) {
            address[] memory list = _threeOracles();
            list[bad] = address(0xDEAD);
            vm.prank(PROTOCOL_INITIALIZER);
            vm.expectRevert(VaultFactory.OracleNotAllowed.selector);
            factory.initialize(list);
            assertFalse(factory.initialized(), "a rejected call leaves the factory uninitialised");
            assertFalse(factory.oracleAllowlistEnforced(), "and the flag unset");
            for (uint256 i; i < 3; ++i) {
                assertFalse(factory.isAllowedOracle(list[i]), "and marks nothing");
            }
        }
        // a zero entry behind a good one is refused too
        address[] memory withZero = new address[](2);
        withZero[0] = address(blessed);
        vm.prank(PROTOCOL_INITIALIZER);
        vm.expectRevert(VaultFactory.OracleNotAllowed.selector);
        factory.initialize(withZero);
        assertFalse(factory.initialized(), "still uninitialised");
    }

    /// @notice The three one-shot wires refuse a zero argument, and a refused call changes nothing: the
    /// registry stays unwired and the correct call still goes through afterwards. A registry left with
    /// a nonzero factory and a zero fee engine could never be wired again (`AlreadyWired` reads the
    /// factory), and would have no caller able to record fees.
    function test_operatorRegistryWireRefusesAZeroAddressAndStaysCallable() public {
        _deploySet();
        vm.startPrank(PROTOCOL_INITIALIZER);
        vm.expectRevert(OperatorRegistry.ZeroAddress.selector);
        registry.wire(address(factory), address(0));
        vm.expectRevert(OperatorRegistry.ZeroAddress.selector);
        registry.wire(address(0), address(fees));
        vm.expectRevert(OperatorRegistry.ZeroAddress.selector);
        registry.wire(address(0), address(0));
        assertFalse(registry.initialized(), "registry still unwired");
        assertEq(registry.factory(), address(0), "factory slot untouched");
        assertEq(registry.feeEngine(), address(0), "fee engine slot untouched");

        registry.wire(address(factory), address(fees)); // the wire is still available, and good arguments take
        vm.stopPrank();
        assertTrue(registry.initialized(), "wired");
        assertEq(registry.feeEngine(), address(fees), "fee engine set by the good call");
    }

    function test_subVaultRegistryWireRefusesAZeroAddressAndStaysCallable() public {
        _deploySet();
        vm.startPrank(PROTOCOL_INITIALIZER);
        vm.expectRevert(SubVaultRegistry.ZeroAddress.selector);
        subReg.wire(address(0));
        assertFalse(subReg.initialized(), "sub-vault registry still unwired");
        subReg.wire(address(factory));
        vm.stopPrank();
        assertTrue(subReg.initialized(), "wired by the good call");
    }

    function test_governanceWireRefusesAZeroAddressAndStaysCallable() public {
        _deploySet();
        vm.startPrank(PROTOCOL_INITIALIZER);
        vm.expectRevert(Governance.ZeroSubRegistry.selector);
        gov.wireSubVaultRegistry(address(0));
        assertFalse(gov.initialized(), "governance still unwired");
        gov.wireSubVaultRegistry(address(subReg));
        vm.stopPrank();
        assertTrue(gov.initialized(), "wired by the good call");
    }

    /// @notice Each one-shot wire leaves an event, so an indexer can see bring-up happen without
    /// reading storage. `OperatorRegistry.wire` always did; the other two were found silent by the
    /// 2026-10-21 static analysis pass (docs/audits/2026-10-21-static-analysis.md, TP-2).
    function test_everyWireEmitsItsTarget() public {
        _deploySet();
        vm.startPrank(PROTOCOL_INITIALIZER);

        vm.expectEmit(true, false, false, false, address(registry));
        emit OperatorRegistry.FactorySet(address(factory));
        vm.expectEmit(true, false, false, false, address(registry));
        emit OperatorRegistry.FeeEngineSet(address(fees));
        registry.wire(address(factory), address(fees));

        vm.expectEmit(true, false, false, false, address(subReg));
        emit SubVaultRegistry.FactorySet(address(factory));
        subReg.wire(address(factory));

        vm.expectEmit(true, false, false, false, address(gov));
        emit Governance.SubVaultRegistrySet(address(subReg));
        gov.wireSubVaultRegistry(address(subReg));

        vm.stopPrank();
    }

    /// @notice VaultCore's defensive clamp on the performance fee is the same rate FeeEngine charges.
    /// It used to be the literal `gain / 10`, which nothing tied to `PERF_FEE_BPS`.
    function test_vaultFeeCapMatchesTheFeeEngineRate() public {
        _deploySet();
        vm.prank(PROTOCOL_INITIALIZER);
        factory.initialize(_oneOracle(address(blessed)));
        _wireAll();
        vm.prank(creator);
        VaultCore vault = VaultCore(factory.createVault(_params(address(blessed))));
        assertEq(vault.PERF_FEE_CAP_BPS(), fees.PERF_FEE_BPS(), "clamp rate == engine rate");
    }

    /// @notice Bring-up order in `Deploy.s.sol`: `initialize` runs before the registry is wired, so an
    /// initialised factory with an unwired registry is a real state. `createVault` must revert there
    /// (the registry's `attestVault` is factory-only and the factory is unset), not register an
    /// unattested vault.
    function test_initialisedFactoryWithAnUnwiredRegistryCreatesNothing() public {
        _deploySet();
        vm.prank(PROTOCOL_INITIALIZER);
        factory.initialize(_oneOracle(address(blessed)));
        assertTrue(factory.initialized() && !registry.initialized(), "initialised, registry not wired");
        vm.prank(creator);
        vm.expectRevert(OperatorRegistry.OnlyFactory.selector);
        factory.createVault(_params(address(blessed)));
        assertEq(factory.vaultCount(), 0, "no vault registered");
        assertEq(registry.operatorCount(), 0, "no operator attested");
    }

    // ───────────────────────── VaultDeployer failure paths ─────────────────────────

    /// @notice A VaultCore constructor that fails with NO revert data (truncated constructor arguments
    /// make the ABI decoder revert empty) surfaces as the named `DeployFailed`, not as an opaque empty
    /// revert that every factory caller would have to guess at.
    function test_deployWithAnEmptyConstructorRevertIsDeployFailed() public {
        _deploySet();
        vm.expectRevert(abi.encodeWithSelector(VaultDeployer.DeployFailed.selector));
        vaultDeployer.deploy("");
        vm.expectRevert(abi.encodeWithSelector(VaultDeployer.DeployFailed.selector));
        vaultDeployer.deploy(hex"00");
    }

    /// @notice The deployer's constructor writes two code chunks with CREATE. If either lands on an
    /// address that already has code, CREATE returns zero and the constructor must revert
    /// `ChunkWriteFailed`; without that check the deployer would be built with a zero chunk address and
    /// every later `deploy` would read the creation code from nowhere. The collision is staged by
    /// etching code at the address CREATE will pick (the deployer's nonce is 1 for the first chunk, 2
    /// for the second). A collision burns all the gas the inner CREATE was given, so each chunk gets its
    /// own test rather than sharing one gas budget.
    function _expectChunkCollision(uint64 chunkNonce) internal {
        // control: with no collision the same constructor succeeds
        VaultDeployer ok = new VaultDeployer();
        assertTrue(ok.codeChunkA() != address(0) && ok.codeChunkB() != address(0), "both chunks written");

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.etch(vm.computeCreateAddress(predicted, chunkNonce), hex"00");
        vm.expectRevert(abi.encodeWithSelector(VaultDeployer.ChunkWriteFailed.selector));
        new VaultDeployer();
    }

    function test_deployerConstructorRefusesAFirstChunkCollision() public {
        _expectChunkCollision(1);
    }

    function test_deployerConstructorRefusesASecondChunkCollision() public {
        _expectChunkCollision(2);
    }
}
