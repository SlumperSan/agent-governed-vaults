// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {AgentVaultCore} from "../src/AgentVaultCore.sol";
import {RWAllyAgentRegistry} from "../src/RWAllyAgentRegistry.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle, StubGovernance, StubFeeEngine, StubRegistry} from "./mocks/Mocks.sol";
import {ModeRegistry} from "./mocks/RegistryMocks.sol";
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";

/// A sub-vault edge table: `parentOf(child)`, as `VaultCore.allocateToChild` reads it.
contract EdgesStub {
    mapping(address => address) public parentOf;

    function set(address c, address p) external {
        parentOf[c] = p;
    }
}

/// The deposit gate and the ungated exits of AgentVaultCore, against a registry whose answer the
/// test controls. Every hostile answer must block a deposit and nothing else.
contract AgentVaultCoreTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 wbtcLike;
    MockOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry opRegistry;
    ModeRegistry idReg;
    AgentVaultCore vault;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address nobody = makeAddr("nobody");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        wbtcLike = new MockERC20("wBTC", 8);
        oracle = new MockOracle();
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        opRegistry = new StubRegistry();
        idReg = new ModeRegistry();
        oracle.setPrice(address(wbtcLike), 100_000e18);

        address[] memory basket = new address[](1);
        basket[0] = address(wbtcLike);
        vault = new AgentVaultCore(
            address(usdc),
            basket,
            creator,
            opRegistry,
            gov,
            fees,
            oracle,
            10_000_000 * USDC_1,
            10 * USDC_1,
            100,
            30 days,
            new address[](0),
            address(0),
            address(idReg)
        );

        address[5] memory who = [creator, alice, bob, carol, nobody];
        for (uint256 i; i < who.length; ++i) {
            usdc.mint(who[i], 1_000_000 * USDC_1);
            vm.prank(who[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
        idReg.setHeld(creator, true);
        idReg.setHeld(alice, true);
        idReg.setHeld(bob, true);
        idReg.setHeld(carol, true);
        // `nobody` holds no identity.
    }

    // -- helpers ----------------------------------------------------------------

    function _join(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount);
        skip(4 hours);
        vault.activate(who);
    }

    function _members() internal {
        _join(creator, 1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);
        skip(30 days); // exit fee decayed to zero
    }

    function _hostileModes() internal pure returns (ModeRegistry.Mode[6] memory m) {
        m = [
            ModeRegistry.Mode.Revert,
            ModeRegistry.Mode.Revert32,
            ModeRegistry.Mode.Short,
            ModeRegistry.Mode.Zero,
            ModeRegistry.Mode.Burn,
            ModeRegistry.Mode.Big
        ];
    }

    /// Run `check` once per hostile registry mode, each from the same starting state.
    function _eachHostileMode(function() internal check) internal {
        ModeRegistry.Mode[6] memory modes = _hostileModes();
        for (uint256 i; i < modes.length; ++i) {
            uint256 snap = vm.snapshotState();
            idReg.setMode(modes[i]);
            check();
            vm.revertToState(snap);
        }
    }

    // -- construction -----------------------------------------------------------

    function test_constructor_pinsRegistry() public view {
        assertEq(vault.identityRegistry(), address(idReg));
    }

    function test_constructor_rejectsZeroAndCodelessRegistry() public {
        address[] memory basket = new address[](0);
        vm.expectRevert(VaultCore.BadConfig.selector);
        new AgentVaultCore(
            address(usdc),
            basket,
            creator,
            opRegistry,
            gov,
            fees,
            oracle,
            0,
            10 * USDC_1,
            100,
            30 days,
            new address[](0),
            address(0),
            address(0)
        );
        vm.expectRevert(VaultCore.BadConfig.selector);
        new AgentVaultCore(
            address(usdc),
            basket,
            creator,
            opRegistry,
            gov,
            fees,
            oracle,
            0,
            10 * USDC_1,
            100,
            30 days,
            new address[](0),
            address(0),
            makeAddr("an eoa")
        );
    }

    // -- the deposit gate ---------------------------------------------------------

    function test_holderDeposits_bothOverloads() public {
        vm.startPrank(alice);
        vault.deposit(100 * USDC_1);
        vault.skipWindow();
        vault.deposit(100 * USDC_1, 1); // a top-up is gated again, and admitted
        vm.stopPrank();
        assertGt(vault.sharesOf(alice), 0);
    }

    function test_nonHolderRefused_bothOverloads_noFundsMove() public {
        uint256 bal = usdc.balanceOf(nobody);
        vm.startPrank(nobody);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        vault.deposit(100 * USDC_1);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        vault.deposit(100 * USDC_1, 0);
        vm.stopPrank();
        assertEq(usdc.balanceOf(nobody), bal);
        assertEq(vault.totalPendingUsdc(), 0);
    }

    /// The gate asks "holds at least one", not "holds exactly one": a wallet may hold many identities
    /// (the registry is soulbound and one wallet registers as many as it likes), and a balance of 2
    /// or of type(uint256).max admits just as a balance of 1 does.
    function test_gate_admitsAnyNonzeroBalance_notOnlyExactlyOne() public {
        idReg.setHeldCount(alice, 2);
        vm.prank(alice);
        vault.deposit(100 * USDC_1);
        assertEq(vault.totalPendingUsdc(), 100 * USDC_1);

        idReg.setHeldCount(bob, 20);
        vm.prank(bob);
        vault.deposit(100 * USDC_1);

        idReg.setHeldCount(carol, type(uint256).max);
        vm.prank(carol);
        vault.deposit(100 * USDC_1);
        assertEq(vault.totalPendingUsdc(), 300 * USDC_1);

        // Top-ups too.
        vm.prank(alice);
        vault.skipWindow();
        vm.prank(alice);
        vault.deposit(100 * USDC_1, 1);

        // And a zero balance is still refused.
        idReg.setHeldCount(nobody, 0);
        vm.prank(nobody);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        vault.deposit(100 * USDC_1);
    }

    /// A parent vault allocating into an AgentVaultCore child is the depositor the gate sees, so the
    /// parent needs an identity of its own and a refusal rolls the whole allocation back, including the
    /// child's `skipWindow` opt-in. On the real `RWAllyAgentRegistry` a VaultCore parent can never hold an
    /// identity (nothing in VaultCore calls `register` or `importAgent`, and the registry is soulbound),
    /// so an AgentVaultCore child cannot receive allocations; that is reachable only once `allowSubVaults`
    /// is true.
    function test_allocateToChild_parentWithoutIdentity_isRefused_andRollsBack() public {
        EdgesStub edges = new EdgesStub();
        VaultCore parent = new VaultCore(
            address(usdc),
            new address[](0),
            creator,
            opRegistry,
            gov,
            fees,
            oracle,
            0,
            10 * USDC_1,
            100,
            30 days,
            new address[](0),
            address(edges)
        );
        AgentVaultCore child = new AgentVaultCore(
            address(usdc),
            new address[](0),
            creator,
            opRegistry,
            gov,
            fees,
            oracle,
            0,
            10 * USDC_1,
            100,
            30 days,
            new address[](0),
            address(0),
            address(idReg)
        );
        edges.set(address(child), address(parent));

        vm.startPrank(alice);
        usdc.approve(address(parent), type(uint256).max);
        parent.deposit(1_000 * USDC_1);
        parent.skipWindow();
        vm.stopPrank();
        uint256 idleBefore = parent.idleUsdc();
        assertEq(idleBefore, 1_000 * USDC_1);

        vm.prank(address(gov));
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        parent.allocateToChild(address(child), 100 * USDC_1);

        assertEq(parent.idleUsdc(), idleBefore);
        assertFalse(parent.isChildVault(address(child)));
        assertFalse(child.skipOptIn(address(parent)));
        assertFalse(child.windowCleared(address(parent)));
        assertEq(usdc.balanceOf(address(child)), 0);

        idReg.setHeld(address(parent), true);
        vm.prank(address(gov));
        parent.allocateToChild(address(child), 100 * USDC_1);
        assertGt(child.sharesOf(address(parent)), 0);
        assertTrue(parent.isChildVault(address(child)));
        assertEq(parent.idleUsdc(), idleBefore - 100 * USDC_1);
    }

    function test_creatorHoldingNoIdentityCannotDeposit_noExemption() public {
        idReg.setHeld(creator, false);
        vm.prank(creator);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        vault.deposit(100 * USDC_1);
    }

    /// The gate reads the depositor's own balance, not another address's.
    function test_gateReadsTheDepositor() public {
        vm.prank(nobody);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        vault.deposit(100 * USDC_1);
        idReg.setHeld(nobody, true);
        vm.prank(nobody);
        vault.deposit(100 * USDC_1);
        assertEq(vault.totalPendingUsdc(), 100 * USDC_1);
    }

    function test_hostileRegistry_refusesDeposit_failClosed() public {
        _eachHostileMode(_depositRefused);
    }

    function _depositRefused() internal {
        vm.prank(alice);
        // Cap the gas so a Burn registry cannot take the whole transaction with it.
        (bool ok, bytes memory ret) =
            address(vault).call{gas: 5_000_000}(abi.encodeWithSignature("deposit(uint256)", 100 * USDC_1));
        assertFalse(ok, "deposit admitted by a hostile registry");
        assertEq(bytes4(ret), AgentVaultCore.NoAgentIdentity.selector, "wrong failure");
        assertEq(vault.totalPendingUsdc(), 0);
    }

    /// The registry is called with a fixed allowance, so a registry that burns gas costs the
    /// depositor at most that allowance plus the vault's own overhead, never the whole tx.
    function test_burnRegistry_costsAtMostTheBoundedAllowance() public {
        idReg.setMode(ModeRegistry.Mode.Burn);
        vm.prank(alice);
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) =
            address(vault).call{gas: 5_000_000}(abi.encodeWithSignature("deposit(uint256)", 100 * USDC_1));
        uint256 used = g0 - gasleft();
        assertFalse(ok);
        assertEq(bytes4(ret), AgentVaultCore.NoAgentIdentity.selector);
        assertLt(used, 400_000, "registry was given more than MODULE_CALL_GAS");
        assertGt(used, 290_000, "the burn mock was not actually consulted");
    }

    // -- exits and every non-deposit path never consult the registry --------------

    function test_instantExit_withHostileRegistry() public {
        _members();
        _eachHostileMode(_instantExit);
    }

    function _instantExit() internal {
        uint256 bal = usdc.balanceOf(alice);
        uint256 shares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(shares);
        assertApproxEqAbs(usdc.balanceOf(alice) - bal, 1_000 * USDC_1, 2, "instant pro-rata exit");
        assertEq(vault.sharesOf(alice), 0);
    }

    function test_queuedExitAndSettle_withHostileRegistry() public {
        _members();
        _eachHostileMode(_queuedExit);
    }

    function _queuedExit() internal {
        gov.setPendingExecution(true);
        uint256 shares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(shares);
        assertEq(vault.queuedExitShares(alice), shares, "queued");
        gov.setPendingExecution(false);
        uint256 bal = usdc.balanceOf(alice);
        vault.settleQueuedExit(alice);
        assertApproxEqAbs(usdc.balanceOf(alice) - bal, 1_000 * USDC_1, 2, "settled");
    }

    function test_activate_withHostileRegistry() public {
        _members();
        vm.prank(bob);
        vault.deposit(100 * USDC_1);
        skip(4 hours);
        _eachHostileMode(_activate);
    }

    function _activate() internal {
        vault.activate(bob);
        assertGt(vault.sharesOf(bob), 0, "pending deposit activated");
    }

    function test_skipWindow_withHostileRegistry() public {
        _members();
        vm.prank(bob);
        vault.deposit(100 * USDC_1);
        _eachHostileMode(_skipWindow);
    }

    function _skipWindow() internal {
        vm.prank(bob);
        vault.skipWindow();
        assertGt(vault.sharesOf(bob), 0, "window skipped");
    }

    function test_cancelPending_withHostileRegistry() public {
        _members();
        vm.prank(bob);
        vault.deposit(100 * USDC_1);
        _eachHostileMode(_cancelPending);
    }

    function _cancelPending() internal {
        uint256 bal = usdc.balanceOf(bob);
        vm.prank(bob);
        vault.cancelPending();
        assertEq(usdc.balanceOf(bob) - bal, 100 * USDC_1, "pending refunded");
        assertEq(vault.totalPendingUsdc(), 0);
    }

    function test_claimEscrowed_withHostileRegistry() public {
        _members();
        // The vault holds a basket position whose transfers are blocked, so the exit escrows it.
        wbtcLike.mint(address(vault), 1e8);
        stdstore.target(address(vault)).sig("assetBalance(address)").with_key(address(wbtcLike))
            .checked_write(1e8);
        wbtcLike.setTransfersBlocked(true);
        uint256 aliceShares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(aliceShares);
        assertGt(vault.claimable(alice, address(wbtcLike)), 0, "escrowed");
        wbtcLike.setTransfersBlocked(false);
        _eachHostileMode(_claimEscrowed);
    }

    function _claimEscrowed() internal {
        uint256 owed = vault.claimable(alice, address(wbtcLike));
        vm.prank(alice);
        vault.claimEscrowed(address(wbtcLike));
        assertEq(wbtcLike.balanceOf(alice), owed, "escrow paid");
    }

    /// A top-up is a deposit, so it is refused under a hostile registry; the exit beside it is not.
    function test_topUpRefused_exitAllowed_underHostileRegistry() public {
        _members();
        _eachHostileMode(_topUpRefusedExitAllowed);
    }

    function _topUpRefusedExitAllowed() internal {
        vm.startPrank(alice);
        (bool ok, bytes memory ret) =
            address(vault).call{gas: 5_000_000}(abi.encodeWithSignature("deposit(uint256)", 50 * USDC_1));
        assertFalse(ok);
        assertEq(bytes4(ret), AgentVaultCore.NoAgentIdentity.selector);
        uint256 shares = vault.sharesOf(alice);
        vault.requestExit(shares / 2);
        vm.stopPrank();
        assertEq(vault.sharesOf(alice), shares - shares / 2);
    }

    /// A holder who stops being one keeps shares and voting weight; only new deposits are refused.
    function test_losingTheIdentity_keepsSharesAndWeight() public {
        _members();
        uint256 shares = vault.sharesOf(alice);
        uint256 weight = vault.votingEligibleShares(alice);
        idReg.setHeld(alice, false);
        assertEq(vault.sharesOf(alice), shares);
        assertEq(vault.votingEligibleShares(alice), weight);
        assertGt(weight, 0);
        vm.prank(alice);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        vault.deposit(10 * USDC_1);
        vm.prank(alice);
        vault.requestExit(shares);
        assertEq(vault.sharesOf(alice), 0);
    }
}

/// A contract account that registers an identity and deposits from itself.
contract SmartAgent {
    MockERC20 public usdc;
    AgentVaultCore public vault;
    RWAllyAgentRegistry public reg;

    constructor(MockERC20 usdc_, AgentVaultCore vault_, RWAllyAgentRegistry reg_) {
        usdc = usdc_;
        vault = vault_;
        reg = reg_;
    }

    function register() external returns (uint256) {
        usdc.approve(address(reg), type(uint256).max);
        return reg.register();
    }

    function deposit(uint256 amt) external {
        usdc.approve(address(vault), amt);
        vault.deposit(amt);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// The same gate against the real RWAllyAgentRegistry, initialised with a 1 USDC fee: registration
/// admits, an identity cannot be transferred, a wallet holding many identities is admitted, a
/// smart-account depositor works, the owner has no power to stop a deposit, and nothing else changes.
contract AgentVaultCoreRealRegistryTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry opRegistry;
    RWAllyAgentRegistry idReg;
    AgentVaultCore vault;

    address multisig = makeAddr("multisig");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address human = makeAddr("human");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        opRegistry = new StubRegistry();
        idReg = new RWAllyAgentRegistry();
        vm.prank(idReg.INITIALIZER());
        idReg.initialize(multisig, address(usdc), makeAddr("treasury"), USDC_1, address(0), 0);
        vault = new AgentVaultCore(
            address(usdc),
            new address[](0),
            creator,
            opRegistry,
            gov,
            fees,
            oracle,
            10_000_000 * USDC_1,
            10 * USDC_1,
            0,
            0,
            new address[](0),
            address(0),
            address(idReg)
        );
        address[4] memory who = [alice, bob, human, creator];
        for (uint256 i; i < who.length; ++i) {
            usdc.mint(who[i], 1_000_000 * USDC_1);
            vm.startPrank(who[i]);
            usdc.approve(address(vault), type(uint256).max);
            usdc.approve(address(idReg), type(uint256).max);
            vm.stopPrank();
        }
    }

    function test_unregisteredRefused_registeredAdmitted() public {
        vm.prank(human);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        vault.deposit(100 * USDC_1);

        vm.prank(alice);
        idReg.register();
        assertEq(usdc.balanceOf(makeAddr("treasury")), USDC_1, "the fee went to the treasury");
        vm.prank(alice);
        vault.deposit(100 * USDC_1);
        assertEq(vault.totalPendingUsdc(), 100 * USDC_1);
    }

    /// Documents the limit rather than hiding it: a person who registers is admitted.
    function test_aPersonWhoRegistersIsAdmitted() public {
        vm.startPrank(human);
        idReg.register("ipfs://human");
        vault.deposit(100 * USDC_1);
        vm.stopPrank();
        assertEq(vault.totalPendingUsdc(), 100 * USDC_1);
    }

    function test_smartAccountDepositorHoldingAnIdentity() public {
        SmartAgent a = new SmartAgent(usdc, vault, idReg);
        usdc.mint(address(a), 500 * USDC_1);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        a.deposit(100 * USDC_1);
        a.register();
        a.deposit(100 * USDC_1);
        assertEq(vault.totalPendingUsdc(), 100 * USDC_1);
    }

    function _aliceIn() internal returns (uint256 id) {
        vm.prank(alice);
        id = idReg.register();
        vm.prank(alice);
        vault.deposit(1_000 * USDC_1);
        skip(4 hours);
        vault.activate(alice);
    }

    /// P5: the identity is soulbound, so an agent cannot pass its token to another depositor, and
    /// holding on to it leaves the holder's access to the vault exactly as it was.
    function test_tokenCannotBeTransferred_holderKeepsTopUpAndExit_otherStaysRefused() public {
        uint256 id = _aliceIn();
        uint256 shares = vault.sharesOf(alice);
        uint256 weight = vault.votingEligibleShares(alice);

        vm.startPrank(alice);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        idReg.transferFrom(alice, bob, id);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        idReg.safeTransferFrom(alice, bob, id);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        idReg.approve(bob, id);
        vm.stopPrank();

        assertEq(idReg.ownerOf(id), alice);
        assertEq(vault.sharesOf(alice), shares);
        assertEq(vault.votingEligibleShares(alice), weight);

        // The would-be recipient holds nothing and is still refused.
        vm.prank(bob);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        vault.deposit(100 * USDC_1);

        // The holder still tops up, and still exits.
        vm.prank(alice);
        vault.deposit(10 * USDC_1);
        uint256 all = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(all);
        assertEq(vault.sharesOf(alice), 0);
    }

    /// One wallet registers many identities and is admitted on any of them.
    function test_aWalletHoldingManyIdentities_isAdmitted() public {
        vm.startPrank(alice);
        for (uint256 i; i < 20; ++i) {
            idReg.register();
        }
        vault.deposit(100 * USDC_1);
        vm.stopPrank();
        assertEq(idReg.balanceOf(alice), 20);
        assertEq(vault.totalPendingUsdc(), 100 * USDC_1);
    }

    /// The registry owner has no power over an identity: raising the fee to the cap, handing the
    /// registry to someone else and renouncing change what a new registrant pays, never whether an
    /// existing holder can deposit, hold or exit.
    function test_ownerPowers_doNotTouchAnExistingHolder() public {
        uint256 id = _aliceIn();
        uint256 shares = vault.sharesOf(alice);
        vm.startPrank(multisig);
        idReg.setFee(idReg.MAX_FEE());
        idReg.setTreasury(makeAddr("newTreasury"));
        idReg.renounceOwnership();
        vm.stopPrank();

        assertEq(idReg.ownerOf(id), alice);
        vm.prank(alice);
        vault.deposit(10 * USDC_1); // a top-up still works
        assertGe(vault.sharesOf(alice), shares);
        uint256 all = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(all);
        assertEq(vault.sharesOf(alice), 0);
    }

    /// The creator may hold nothing: no path in the vault needs the creator to hold an identity.
    function test_creatorHoldingNothing_othersUnaffected() public {
        vm.prank(alice);
        idReg.register();
        vm.prank(alice);
        vault.deposit(100 * USDC_1);
        assertEq(vault.creator(), creator);
        assertEq(vault.sharesOf(creator), 0);
    }
}

/// Spec 5.1 item 9: deployed directly, the vault is unattested; its exits still settle, charge no
/// performance fee, and emit ModuleCallFailed for the bookkeeping modules.
contract AgentVaultCoreUnattestedTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;

    event ModuleCallFailed(bytes32 indexed module, address indexed member);

    MockERC20 usdc;
    MockERC20 wbtcLike;
    MockOracle oracle;
    OperatorRegistry opRegistry;
    FeeEngine feeEngine;
    Governance governance;
    ModeRegistry idReg;
    AgentVaultCore vault;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        wbtcLike = new MockERC20("wBTC", 8);
        oracle = new MockOracle();
        oracle.setPrice(address(wbtcLike), 100_000e18);
        opRegistry = new OperatorRegistry();
        feeEngine = new FeeEngine(IRegistryView(address(opRegistry)));
        vm.prank(PROTOCOL_INITIALIZER);
        opRegistry.wire(makeAddr("some factory"), address(feeEngine));
        governance = new Governance();
        idReg = new ModeRegistry();
        idReg.setAllowAll(true);

        address[] memory basket = new address[](1);
        basket[0] = address(wbtcLike);
        vault = new AgentVaultCore(
            address(usdc),
            basket,
            creator,
            IOperatorRegistry(address(opRegistry)),
            IGovernance(address(governance)),
            IFeeEngine(address(feeEngine)),
            IOracleAggregator(address(oracle)),
            0,
            10 * USDC_1,
            0,
            0,
            new address[](0),
            address(0),
            address(idReg)
        );
        usdc.mint(alice, 1_000_000 * USDC_1);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function test_governanceRegistrationByCreatorWorks_withNoParent() public {
        vm.prank(creator);
        governance.registerVault(
            address(vault),
            Governance.GovConfig({
                commitDuration: 1 days,
                revealDuration: 1 days,
                timelockDuration: 0,
                executionWindow: 1 days,
                quorumBps: 2_500,
                proposalThresholdBps: 500,
                concentrationCapBps: 4_000,
                proposalCooldown: 1 hours
            })
        );
        assertTrue(governance.vaultRegistered(address(vault)));
    }

    function test_unattestedExit_withGain_settles_chargesNoPerformanceFee_andEmitsModuleCallFailed() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC_1);
        vm.prank(alice);
        vault.skipWindow();
        // $100k of basket value appears in the vault: alice's exit realises a large gain.
        wbtcLike.mint(address(vault), 1e8);
        stdstore.target(address(vault)).sig("assetBalance(address)").with_key(address(wbtcLike))
            .checked_write(1e8);

        assertEq(opRegistry.operatorOf(address(vault)), 0, "direct deploy is not attested");

        vm.expectEmit(true, true, false, false);
        emit ModuleCallFailed("feeEngine.onRealize", alice);
        uint256 shares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(shares);

        assertEq(vault.sharesOf(alice), 0, "exit settled");
        assertEq(
            usdc.balanceOf(alice), 1_000_000 * USDC_1 + 0, "no performance fee withheld from the USDC leg"
        );
        assertEq(wbtcLike.balanceOf(alice), 1e8, "in-kind leg delivered whole");
    }
}
