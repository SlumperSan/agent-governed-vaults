// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {AgentVaultCore} from "../src/AgentVaultCore.sol";
import {VaultFactory, IVaultDeployer} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {AgentVaultDeployer} from "../src/AgentVaultDeployer.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {RWAllyAgentRegistry} from "../src/RWAllyAgentRegistry.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";
import {ModeRegistry} from "./mocks/RegistryMocks.sol";
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";

/// @notice `VaultFactory.createAgentVault` and the one-shot `initializeAgentPath` that wires it.
/// The creator gate is a provenance tag (the creator holds at least one agent ID in the pinned
/// registry), so these tests never claim it screens who the creator is: a person who registers
/// passes it, and `test_aPersonWhoRegistersCanCreate` records that.
contract CreateAgentVaultTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;
    bytes32 constant TOPIC_AGENT_VAULT_CREATED =
        keccak256("AgentVaultCreated(address,address,address,uint256,address,uint8)");
    bytes32 constant TOPIC_VAULT_CREATED = keccak256("VaultCreated(address,address,address,uint256)");
    bytes32 constant TOPIC_AGENT_PATH_INITIALIZED = keccak256("AgentPathInitialized(address,address)");

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    OperatorRegistry opReg;
    FeeEngine fees;
    Governance gov;
    VaultDeployer vaultDeployer;
    AgentVaultDeployer agentDeployer;
    RWAllyAgentRegistry idReg;
    VaultFactory factory;

    address multisig = makeAddr("multisig");
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent"); // holds an ID
    address agent2 = makeAddr("agent2"); // holds an ID
    address human = makeAddr("human"); // holds no ID
    address alice = makeAddr("alice"); // a depositor who registers

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        oracle.setPrice(address(weth), 4_000e18);
        vaultDeployer = new VaultDeployer();
        agentDeployer = new AgentVaultDeployer();
        idReg = new RWAllyAgentRegistry();
        vm.prank(idReg.INITIALIZER());
        idReg.initialize(multisig, address(usdc), treasury, USDC_1, address(0), 0);

        (factory, opReg, fees, gov) = _stack(new address[](0), address(idReg), true);

        address[5] memory who = [agent, agent2, human, alice, address(this)];
        for (uint256 i; i < who.length; ++i) {
            usdc.mint(who[i], 100_000_000 * USDC_1);
            vm.prank(who[i]);
            usdc.approve(address(idReg), type(uint256).max);
        }
        vm.prank(agent);
        idReg.register();
        vm.prank(agent2);
        idReg.register();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _stack(address[] memory allow, address agentRegistry, bool wireAgentPath)
        internal
        returns (VaultFactory f, OperatorRegistry r, FeeEngine fe, Governance g)
    {
        r = new OperatorRegistry();
        fe = new FeeEngine(IRegistryView(address(r)));
        g = new Governance();
        f = new VaultFactory(
            IOperatorRegistry(address(r)),
            IGovernance(address(g)),
            IFeeEngine(address(fe)),
            address(0),
            IVaultDeployer(address(vaultDeployer)),
            false // root-only (C-1)
        );
        vm.prank(PROTOCOL_INITIALIZER);
        f.initialize(allow);
        if (wireAgentPath) {
            vm.prank(PROTOCOL_INITIALIZER);
            f.initializeAgentPath(agentRegistry, IVaultDeployer(address(agentDeployer)));
        }
        vm.prank(PROTOCOL_INITIALIZER);
        r.wire(address(f), address(fe));
    }

    function _basket() internal view returns (address[] memory b) {
        b = new address[](1);
        b[0] = address(weth);
    }

    function _params() internal view returns (VaultFactory.VaultParams memory p) {
        p = VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: _basket(),
            oracle: IOracleAggregator(address(oracle)),
            capacityCapUsdc: 1_000_000 * USDC_1,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: 0,
            exitFeeDecayPeriod: 0,
            allowedAdapters: new address[](0)
        });
    }

    function _create(address who) internal returns (AgentVaultCore v) {
        vm.prank(who);
        v = AgentVaultCore(factory.createAgentVault(_params()));
    }

    // ── the creator gate ─────────────────────────────────────────────────────

    function test_refusesACreatorWithNoAgentId() public {
        vm.prank(human);
        vm.expectRevert(VaultFactory.NoAgentIdentity.selector);
        factory.createAgentVault(_params());
        assertEq(factory.vaultCount(), 0, "nothing was created");
    }

    function test_acceptsACreatorHoldingAnAgentId() public {
        AgentVaultCore v = _create(agent);
        assertEq(v.creator(), agent, "creator is the sender");
        assertEq(v.identityRegistry(), address(idReg), "pinned registry");
        assertEq(factory.vaultCount(), 1);
    }

    /// The registry is permissive (many IDs per address): the gate is a count above zero, so a
    /// creator holding several IDs passes exactly as one holding one does.
    function test_acceptsACreatorHoldingManyIds() public {
        vm.startPrank(agent);
        for (uint256 i; i < 5; ++i) {
            idReg.register();
        }
        vm.stopPrank();
        assertEq(idReg.balanceOf(agent), 6);
        assertEq(_create(agent).creator(), agent);
    }

    /// Documents the limit rather than hiding it: the ID is a provenance tag, so a person who
    /// registers passes the creator gate.
    function test_aPersonWhoRegistersCanCreate() public {
        vm.prank(human);
        idReg.register("ipfs://human");
        assertEq(_create(human).creator(), human);
    }

    /// A smart-account creator (a contract holding an ID) passes: the gate reads `msg.sender` only.
    function test_aContractAccountHoldingAnIdCanCreate() public {
        SmartCreator a = new SmartCreator(usdc, idReg, factory);
        usdc.mint(address(a), 10 * USDC_1);
        a.register();
        AgentVaultCore v = AgentVaultCore(a.create(_params()));
        assertEq(v.creator(), address(a));
    }

    function test_aRevertingRegistryRefusesTheCreator() public {
        ModeRegistry m = new ModeRegistry();
        (VaultFactory f,,,) = _stack(new address[](0), address(m), true);
        m.setAllowAll(true);
        assertTrue(_tryCreate(f, human), "an admitting registry admits");
        m.setMode(ModeRegistry.Mode.Revert);
        assertFalse(_tryCreate(f, human), "a reverting registry refuses");
        m.setMode(ModeRegistry.Mode.Zero);
        vm.prank(human);
        vm.expectRevert(VaultFactory.NoAgentIdentity.selector);
        f.createAgentVault(_params());
    }

    function _tryCreate(VaultFactory f, address who) internal returns (bool ok) {
        vm.prank(who);
        try f.createAgentVault(_params()) returns (address) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    // ── the vault it builds ──────────────────────────────────────────────────

    function test_theVaultPinsTheFactoryRegistry_notAValueFromTheCaller() public {
        AgentVaultCore v = _create(agent);
        assertEq(v.identityRegistry(), factory.agentRegistry());
        assertEq(v.identityRegistry(), address(idReg));
    }

    function test_theVaultBindsTheSameSingletonsAsARegularVault() public {
        vm.prank(agent);
        VaultCore reg = VaultCore(factory.createVault(_params()));
        AgentVaultCore ag = _create(agent);
        assertEq(address(ag.operatorRegistry()), address(reg.operatorRegistry()), "operator registry");
        assertEq(address(ag.governance()), address(reg.governance()), "governance");
        assertEq(address(ag.feeEngine()), address(reg.feeEngine()), "fee engine");
        assertEq(address(ag.oracle()), address(reg.oracle()), "oracle");
        assertEq(ag.subVaultRegistry(), reg.subVaultRegistry(), "sub-vault registry");
        assertEq(ag.usdc(), reg.usdc(), "usdc");
        assertEq(ag.capacityCapUsdc(), reg.capacityCapUsdc(), "cap");
        assertEq(ag.minDepositUsdc(), reg.minDepositUsdc(), "min deposit");
        assertEq(ag.exitFeeMaxBps(), reg.exitFeeMaxBps(), "exit fee");
        assertEq(ag.exitFeeDecayPeriod(), reg.exitFeeDecayPeriod(), "decay");
        assertEq(ag.assetUnit(address(weth)), reg.assetUnit(address(weth)), "basket");
    }

    function test_aVaultConstructorRevertBubblesThroughTheAgentPath() public {
        VaultFactory.VaultParams memory p = _params();
        p.exitFeeMaxBps = 101; // over EXIT_FEE_CAP_BPS
        vm.prank(agent);
        vm.expectRevert(VaultCore.BadConfig.selector);
        factory.createAgentVault(p);
    }

    // ── event, list, attestation ─────────────────────────────────────────────

    function test_emitsAgentVaultCreated_andNotVaultCreated() public {
        vm.recordLogs();
        AgentVaultCore v = _create(agent);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 fromFactory;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(factory)) continue;
            ++fromFactory;
            assertEq(
                logs[i].topics[0], TOPIC_AGENT_VAULT_CREATED, "only AgentVaultCreated, never VaultCreated"
            );
            assertEq(address(uint160(uint256(logs[i].topics[1]))), address(v), "vault");
            assertEq(address(uint160(uint256(logs[i].topics[2]))), agent, "creator");
            (address u, uint256 cap, address ir, uint8 kind) =
                abi.decode(logs[i].data, (address, uint256, address, uint8));
            assertEq(u, address(usdc), "usdc");
            assertEq(cap, 1_000_000 * USDC_1, "cap");
            assertEq(ir, address(idReg), "identity registry");
            assertEq(kind, factory.VAULT_KIND_AGENT(), "kind");
            assertEq(kind, 1, "kind is 1");
        }
        assertEq(fromFactory, 1, "exactly one factory event");
    }

    function test_aRegularVaultStillEmitsTheUnchangedVaultCreated() public {
        vm.recordLogs();
        vm.prank(human); // no ID needed for a regular vault
        address v = factory.createVault(_params());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 fromFactory;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(factory)) continue;
            ++fromFactory;
            assertEq(logs[i].topics[0], TOPIC_VAULT_CREATED, "VaultCreated, signature unchanged");
            assertEq(address(uint160(uint256(logs[i].topics[1]))), v);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), human);
        }
        assertEq(fromFactory, 1);
        (bool ok,) = v.staticcall(abi.encodeWithSignature("identityRegistry()"));
        assertFalse(ok, "a regular vault has no identity registry");
    }

    function test_pushesToAllVaults_inCreationOrder() public {
        vm.prank(human);
        address r = factory.createVault(_params());
        AgentVaultCore a1 = _create(agent);
        AgentVaultCore a2 = _create(agent2);
        assertEq(factory.vaultCount(), 3);
        assertEq(factory.allVaults(0), r);
        assertEq(factory.allVaults(1), address(a1));
        assertEq(factory.allVaults(2), address(a2));
    }

    function test_attestsTheCreator_andSharesItsIdentityWithItsRegularVaults() public {
        vm.prank(agent);
        address r = factory.createVault(_params());
        AgentVaultCore a = _create(agent);
        uint256 opId = opReg.operatorOf(address(a));
        assertGt(opId, 0, "attested");
        assertEq(opReg.operatorAddressOf(opId), agent, "operator is the creator");
        assertEq(opReg.operatorOf(r), opId, "same operator identity across kinds");
        (,,, uint256 vaultCount) = opReg.statsOf(opId);
        assertEq(vaultCount, 2, "both vaults counted");
    }

    // ── bring-up order and the curated oracle gate ───────────────────────────

    function test_refusedBeforeInitialize() public {
        VaultFactory f = new VaultFactory(
            IOperatorRegistry(address(opReg)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(0),
            IVaultDeployer(address(vaultDeployer)),
            false
        );
        vm.prank(agent);
        vm.expectRevert(VaultFactory.NotInitialized.selector);
        f.createAgentVault(_params());
    }

    function test_refusedUntilTheAgentPathIsInitialized() public {
        (VaultFactory f,,,) = _stack(new address[](0), address(idReg), false);
        assertFalse(f.agentPathInitialized());
        vm.prank(agent);
        vm.expectRevert(VaultFactory.AgentPathNotInitialized.selector);
        f.createAgentVault(_params());
        // A regular vault is unaffected by the agent path being unset.
        vm.prank(agent);
        f.createVault(_params());
    }

    function test_theAgentPathEnforcesTheOracleAllowlist() public {
        MockOracle blessed = new MockOracle();
        blessed.setPrice(address(weth), 4_000e18);
        address[] memory allow = new address[](1);
        allow[0] = address(blessed);
        (VaultFactory f,,,) = _stack(allow, address(idReg), true);

        vm.prank(agent);
        vm.expectRevert(VaultFactory.OracleNotAllowed.selector);
        f.createAgentVault(_params()); // `oracle` is not blessed

        VaultFactory.VaultParams memory p = _params();
        p.oracle = IOracleAggregator(address(blessed));
        vm.prank(agent);
        assertTrue(f.createAgentVault(p) != address(0), "a blessed oracle is accepted");
    }

    function test_theAgentPathRequiresTheOracleToCoverTheBasket() public {
        MockERC20 unpriced = new MockERC20("UNPRICED", 18);
        VaultFactory.VaultParams memory p = _params();
        address[] memory b = new address[](1);
        b[0] = address(unpriced);
        p.basketAssets = b;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.OracleMissingAsset.selector, address(unpriced)));
        factory.createAgentVault(p);
    }

    // ── initializeAgentPath ──────────────────────────────────────────────────

    function _fresh() internal returns (VaultFactory f) {
        f = new VaultFactory(
            IOperatorRegistry(address(opReg)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(0),
            IVaultDeployer(address(vaultDeployer)),
            false
        );
    }

    function test_initializeAgentPath_storesBothAndEmits() public {
        VaultFactory f = _fresh();
        vm.recordLogs();
        vm.prank(PROTOCOL_INITIALIZER);
        f.initializeAgentPath(address(idReg), IVaultDeployer(address(agentDeployer)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], TOPIC_AGENT_PATH_INITIALIZED);
        assertEq(address(uint160(uint256(logs[0].topics[1]))), address(idReg));
        assertEq(address(uint160(uint256(logs[0].topics[2]))), address(agentDeployer));
        assertEq(f.agentRegistry(), address(idReg));
        assertEq(address(f.agentVaultDeployer()), address(agentDeployer));
        assertTrue(f.agentPathInitialized());
    }

    function test_initializeAgentPath_onlyTheProtocolInitializer() public {
        VaultFactory f = _fresh();
        vm.prank(human);
        vm.expectRevert(VaultFactory.OnlyInitializer.selector);
        f.initializeAgentPath(address(idReg), IVaultDeployer(address(agentDeployer)));
        assertFalse(f.agentPathInitialized());
    }

    function test_initializeAgentPath_isOneShot() public {
        vm.prank(PROTOCOL_INITIALIZER);
        vm.expectRevert(VaultFactory.AgentPathAlreadyInitialized.selector);
        factory.initializeAgentPath(address(idReg), IVaultDeployer(address(agentDeployer)));
        // The first values still stand.
        assertEq(factory.agentRegistry(), address(idReg));
    }

    function test_initializeAgentPath_refusesAZeroOrCodelessRegistry() public {
        VaultFactory f = _fresh();
        vm.startPrank(PROTOCOL_INITIALIZER);
        vm.expectRevert(VaultFactory.InvalidAgentRegistry.selector);
        f.initializeAgentPath(address(0), IVaultDeployer(address(agentDeployer)));
        vm.expectRevert(VaultFactory.InvalidAgentRegistry.selector);
        f.initializeAgentPath(makeAddr("typo"), IVaultDeployer(address(agentDeployer)));
        vm.stopPrank();
        assertFalse(f.agentPathInitialized(), "a refused call leaves the one shot unspent");
    }

    function test_initializeAgentPath_refusesAZeroOrCodelessDeployer() public {
        VaultFactory f = _fresh();
        vm.startPrank(PROTOCOL_INITIALIZER);
        vm.expectRevert(VaultFactory.InvalidAgentVaultDeployer.selector);
        f.initializeAgentPath(address(idReg), IVaultDeployer(address(0)));
        vm.expectRevert(VaultFactory.InvalidAgentVaultDeployer.selector);
        f.initializeAgentPath(address(idReg), IVaultDeployer(makeAddr("typo")));
        vm.stopPrank();
        assertFalse(f.agentPathInitialized());
    }

    // ── the deposit gate, end to end through the factory ─────────────────────

    function test_depositGate_endToEnd() public {
        AgentVaultCore v = _create(agent);
        vm.prank(agent);
        usdc.approve(address(v), type(uint256).max);
        vm.prank(alice);
        usdc.approve(address(v), type(uint256).max);
        vm.prank(human);
        usdc.approve(address(v), type(uint256).max);

        // No ID: refused. Registered: admitted, activates, exits.
        vm.prank(human);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        v.deposit(100 * USDC_1);

        vm.prank(alice);
        idReg.register();
        vm.startPrank(alice);
        v.deposit(100 * USDC_1);
        v.skipWindow();
        vm.stopPrank();
        uint256 shares = v.sharesOf(alice);
        assertGt(shares, 0, "alice is a member");

        vm.prank(alice);
        v.requestExit(shares);
        assertEq(v.sharesOf(alice), 0, "exit is ungated and settled");
    }

    /// The creator earns the creator fee like any other creator (Q5): a member's realized gain
    /// credits the agent creator's address, which claims it.
    function test_theAgentCreatorEarnsTheCreatorFee() public {
        AgentVaultCore v = _create(agent);
        vm.prank(agent);
        idReg.register(); // a further ID changes nothing
        address[2] memory who = [agent, alice];
        vm.prank(alice);
        idReg.register();
        for (uint256 i; i < who.length; ++i) {
            vm.startPrank(who[i]);
            usdc.approve(address(v), type(uint256).max);
            v.deposit(1_000 * USDC_1);
            v.skipWindow();
            vm.stopPrank();
        }
        // Appreciation: 25 wETH at 4,000 USD, credited to the vault's basket balance.
        weth.mint(address(v), 25e18);
        uint256 cur = v.assetBalance(address(weth));
        stdstore.target(address(v)).sig("assetBalance(address)").with_key(address(weth))
            .checked_write(cur + 25e18);

        uint256 opId = opReg.operatorOf(address(v));
        uint256 shares = v.sharesOf(alice);
        vm.prank(alice);
        v.requestExit(shares);

        (uint256 gain,, uint256 collected,) = opReg.statsOf(opId);
        assertGt(gain, 0, "gain recorded");
        assertGt(collected, 0, "fee collected");
        assertEq(fees.claimableFees(agent, address(usdc)), collected, "credited to the agent creator");
        uint256 bal = usdc.balanceOf(agent);
        vm.prank(agent);
        fees.claimFees(address(usdc));
        assertEq(usdc.balanceOf(agent) - bal, collected, "the creator claims it");
    }
}

/// A contract account that registers an ID and creates an agent vault, the shape an ERC-4337 or
/// ERC-7579 agent account takes.
contract SmartCreator {
    MockERC20 usdc;
    RWAllyAgentRegistry reg;
    VaultFactory factory;

    constructor(MockERC20 usdc_, RWAllyAgentRegistry reg_, VaultFactory factory_) {
        usdc = usdc_;
        reg = reg_;
        factory = factory_;
    }

    function register() external returns (uint256) {
        usdc.approve(address(reg), type(uint256).max);
        return reg.register();
    }

    function create(VaultFactory.VaultParams calldata p) external returns (address) {
        return factory.createAgentVault(p);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
