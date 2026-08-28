// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

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

/// DoS / griefing pass — exit-path liveness.
///
///  A. Governance duration ceilings: `_validateConfig` caps `timelockDuration` at 30 days but
///     puts only LOWER bounds on commit/reveal/execution windows. A `revealDuration` of
///     type(uint32).max pins `hasPendingExecution` true forever, so every exit is queued Mode-F
///     and `settleQueuedExit` can never succeed. No cancel path exists for queued shares.
///
///  B. SV-5 child unwind is sized GROSS but repaid NET of the child's own exit/performance fee,
///     so `require(shortfallWad <= SHORTFALL_DUST_WAD)` is structurally unsatisfiable — not the
///     "bounded retry" E4/E5 claim.
contract AuditDosExitLivenessTest is Test {
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
    address bob = makeAddr("bob");

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
        usdc.mint(bob, 100_000_000 * USDC_1);
    }

    /// via_ir CSEs `block.timestamp`, so always re-read the cheatcode clock.
    function _fwd(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _params(uint256 exitFeeBps) internal view returns (VaultFactory.VaultParams memory) {
        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        return VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: basket,
            oracle: IOracleAggregator(address(oracle)),
            capacityCapUsdc: 0,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: exitFeeBps,
            exitFeeDecayPeriod: exitFeeBps == 0 ? 0 : 30 days,
            allowedAdapters: new address[](0)
        });
    }

    function _join(VaultCore v, address who, uint256 amt) internal {
        vm.startPrank(who);
        usdc.approve(address(v), type(uint256).max);
        v.deposit(amt);
        v.skipWindow();
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FINDING A — unbounded revealDuration permanently freezes every exit
    // ─────────────────────────────────────────────────────────────────────────

    function test_remediated_A_unboundedRevealDurationFreezesAllExitsForever() public {
        vm.prank(operator);
        VaultCore v = VaultCore(factory.createVault(_params(0)));

        // 1. Members join BEFORE any governance config exists on chain. Nothing hostile to
        //    inspect: registerVault has not been called, so exits settle Mode I.
        _join(v, operator, 1_000 * USDC_1);
        _join(v, alice, 1_000 * USDC_1);
        _join(v, bob, 1_000 * USDC_1);
        assertFalse(gov.vaultRegistered(address(v)), "unregistered at deposit time");

        _fwd(1 days);

        // Mode-I exit demonstrably works right now.
        uint256 bobShares = v.sharesOf(bob);
        vm.prank(bob);
        v.requestExit(bobShares / 10);
        assertEq(v.queuedExitShares(bob), 0, "Mode I settled instantly");

        // 2. Creator registers governance with revealDuration = type(uint32).max. Every other
        //    parameter is inside its documented bound; only the missing ceiling is abused.
        Governance.GovConfig memory cfg = Governance.GovConfig({
            commitDuration: 1 hours,
            revealDuration: type(uint32).max, // ~136 years; no upper bound in _validateConfig
            timelockDuration: 0,
            executionWindow: 1 hours,
            quorumBps: 2_500,
            proposalThresholdBps: 100, // M-6 floor (1%)
            concentrationCapBps: 5_000, // M-6 ceiling (50%)
            proposalCooldown: 1 hours // M-6 floor
        });
        vm.prank(operator);
        // REMEDIATED (C-2): the phase-duration hard caps now reject this config outright,
        // so the freeze below is unreachable. The original exploit is preserved in git
        // history and described in docs/audit/AI-AUDIT-REPORT.md C-2.
        vm.expectRevert(Governance.BadGovConfig.selector);
        gov.registerVault(address(v), cfg);
        return;

        // 3. One proposal springs the trap.
        vm.prank(operator);
        uint256 pid = gov.propose(address(v), Governance.ProposalType.Rebalance, keccak256("noop"));

        _fwd(1 hours + 1); // past commitDeadline ⇒ hasPendingExecution
        assertTrue(gov.hasPendingExecution(address(v)), "reveal phase pins the flag");

        // 4. Every exit is now queued and can never settle.
        uint256 aliceShares = v.sharesOf(alice);
        vm.prank(alice);
        v.requestExit(aliceShares);
        assertEq(v.queuedExitShares(alice), aliceShares, "forced into Mode F");
        assertEq(v.votingEligibleShares(alice), 0, "and stripped of its vote");

        vm.expectRevert(VaultCore.ExecutionStillPending.selector);
        v.settleQueuedExit(alice);

        // No crank clears it: finalize needs revealDeadline, markExpired needs Passed.
        vm.expectRevert(Governance.WrongPhase.selector);
        gov.finalize(pid);
        vm.expectRevert(Governance.WrongPhase.selector);
        gov.markExpired(pid);
        // And no new proposal can ever be opened to replace the active one.
        vm.prank(operator);
        vm.expectRevert(Governance.ProposalActive.selector);
        gov.propose(address(v), Governance.ProposalType.RuleChange, keccak256("rescue"));

        // 5. Still frozen a century later. There is no cancel path for queuedExitShares.
        _fwd(100 * 365 days);
        vm.expectRevert(VaultCore.ExecutionStillPending.selector);
        v.settleQueuedExit(alice);

        // Un-queued holders fare no better: a fresh request just queues too.
        uint256 bobLeft = v.sharesOf(bob);
        vm.prank(bob);
        v.requestExit(bobLeft);
        assertEq(v.queuedExitShares(bob), bobLeft, "bob also trapped");
        vm.expectRevert(VaultCore.ExecutionStillPending.selector);
        v.settleQueuedExit(bob);

        // Deposits still work — new capital keeps flowing into the trap.
        address carol = makeAddr("carol");
        usdc.mint(carol, 1_000 * USDC_1);
        _join(v, carol, 500 * USDC_1);
        assertGt(v.sharesOf(carol), 0, "trap keeps accepting deposits");
    }

    /// Same trap via `executionWindow` (also unbounded) once the proposal has passed.
    function test_remediated_A2_unboundedExecutionWindowFreezesExitsForever() public {
        vm.prank(operator);
        VaultCore v = VaultCore(factory.createVault(_params(0)));
        _join(v, operator, 1_000 * USDC_1);
        _join(v, alice, 1_000 * USDC_1);

        Governance.GovConfig memory cfg = Governance.GovConfig({
            commitDuration: 1 hours,
            revealDuration: 1 hours,
            timelockDuration: 0,
            executionWindow: type(uint32).max, // ~136 years
            quorumBps: 2_500,
            proposalThresholdBps: 100, // M-6 floor (1%)
            concentrationCapBps: 5_000, // M-6 ceiling (50%)
            proposalCooldown: 1 hours // M-6 floor
        });
        vm.prank(operator);
        // REMEDIATED (C-2): rejected by EXECUTION_WINDOW_HARD_CAP; the freeze below is
        // unreachable. Original exploit in git history / AI-AUDIT-REPORT.md C-2.
        vm.expectRevert(Governance.BadGovConfig.selector);
        gov.registerVault(address(v), cfg);
        return;
        _fwd(1 days);

        vm.prank(operator);
        uint256 pid = gov.propose(address(v), Governance.ProposalType.Rebalance, keccak256("noop"));

        bytes32 salt = keccak256("s");
        vm.prank(operator);
        gov.commitVote(pid, keccak256(abi.encode(pid, operator, true, salt)));
        vm.prank(alice);
        gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, salt)));
        _fwd(1 hours);
        vm.prank(operator);
        gov.revealVote(pid, true, salt);
        vm.prank(alice);
        gov.revealVote(pid, true, salt);
        _fwd(1 hours);
        gov.finalize(pid);

        // Passed, and never executed. hasPendingExecution stays true for the whole window.
        _fwd(50 * 365 days);
        assertTrue(gov.hasPendingExecution(address(v)), "still pending 50 years later");

        uint256 aliceShares = v.sharesOf(alice);
        vm.prank(alice);
        v.requestExit(aliceShares);
        vm.expectRevert(VaultCore.ExecutionStillPending.selector);
        v.settleQueuedExit(alice);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FINDING B — child unwind sized gross, repaid net ⇒ unsatisfiable require
    // ─────────────────────────────────────────────────────────────────────────

    /// B1: the child charges an exit fee. No oracle move, no pending execution anywhere, the
    /// child is fully liquid — and the parent member still cannot exit.
    function test_B1_childExitFeeMakesParentExitUnsatisfiable() public {
        vm.prank(operator);
        VaultCore parent = VaultCore(factory.createVault(_params(0))); // parent fee 0
        vm.prank(operator);
        VaultCore child = VaultCore(factory.createChildVault(_params(100), address(parent))); // 1%

        _join(parent, operator, 1_000 * USDC_1);
        _join(parent, alice, 1_000 * USDC_1);

        // Governance allocates 1,900 of the 2,000 idle into the child.
        vm.prank(address(gov));
        parent.allocateToChild(address(child), 1_900 * USDC_1);
        assertEq(parent.idleUsdc(), 100 * USDC_1);

        // A dust non-parent holder in the child, so the sole-holder fee waiver cannot fire.
        _join(child, bob, 10 * USDC_1);

        // Nothing is pending anywhere; the child holds 1,910 USDC of idle cash.
        assertFalse(gov.hasPendingExecution(address(child)));
        assertEq(child.idleUsdc(), 1_910 * USDC_1);
        assertEq(child.exitFeeBpsOf(address(parent)), 100, "child charges the parent 1%");

        uint256 aliceShares = parent.sharesOf(alice);
        vm.prank(alice);
        vm.expectRevert(VaultCore.ExitNeedsChildSettlement.selector);
        parent.requestExit(aliceShares);

        // "Bounded retry" does not help — the fee is structural, not transient.
        _fwd(7 days);
        vm.prank(alice);
        vm.expectRevert(VaultCore.ExitNeedsChildSettlement.selector);
        parent.requestExit(aliceShares);

        // Control: once the child's exit fee has fully decayed the identical call succeeds,
        // proving the fee — not liquidity, oracles, or pending execution — is the blocker.
        _fwd(31 days);
        assertEq(child.exitFeeBpsOf(address(parent)), 0);
        vm.prank(alice);
        parent.requestExit(aliceShares);
        assertEq(parent.sharesOf(alice), 0, "exit only possible at zero child fee");
    }

    /// A3 x E4: a CHILD frozen by the same unbounded-duration trap makes the PARENT's exit
    /// permanently unsatisfiable — and closes the `redeemFromChild` governance escape hatch
    /// too. E4's documented bound ("retry after the child settles, bounded by its timelock")
    /// does not hold: the child never settles.
    function test_remediated_A3_frozenChildGovernancePermanentlyStrandsParentExit() public {
        vm.prank(operator);
        VaultCore parent = VaultCore(factory.createVault(_params(0)));
        vm.prank(operator);
        VaultCore child = VaultCore(factory.createChildVault(_params(0), address(parent)));

        _join(parent, operator, 1_000 * USDC_1);
        _join(parent, alice, 1_000 * USDC_1);
        vm.prank(address(gov));
        parent.allocateToChild(address(child), 1_900 * USDC_1);

        // Someone with weight in the child (the parent's own stake is non-voting by GA-1).
        _join(child, bob, 1_000 * USDC_1);

        // Child creator registers the child with an unbounded reveal window.
        Governance.GovConfig memory cfg = Governance.GovConfig({
            commitDuration: 1 hours,
            revealDuration: type(uint32).max,
            timelockDuration: 0,
            executionWindow: 1 hours,
            quorumBps: 2_500,
            proposalThresholdBps: 100, // M-6 floor (1%)
            concentrationCapBps: 5_000, // M-6 ceiling (50%)
            proposalCooldown: 1 hours // M-6 floor
        });
        vm.prank(operator);
        // REMEDIATED (C-2): the phase-duration hard caps now reject this config outright,
        // so the freeze below is unreachable. The original exploit is preserved in git
        // history and described in docs/audit/AI-AUDIT-REPORT.md C-2.
        vm.expectRevert(Governance.BadGovConfig.selector);
        gov.registerVault(address(child), cfg);
        return;
        _fwd(1 days);
        vm.prank(bob);
        gov.propose(address(child), Governance.ProposalType.Rebalance, keccak256("noop"));
        _fwd(1 hours + 1);
        assertTrue(gov.hasPendingExecution(address(child)), "child pinned pending forever");

        // Parent member cannot exit: the only child covering the shortfall is skipped.
        uint256 aliceShares = parent.sharesOf(alice);
        vm.prank(alice);
        vm.expectRevert(VaultCore.ExitNeedsChildSettlement.selector);
        parent.requestExit(aliceShares);

        _fwd(100 * 365 days);
        vm.prank(alice);
        vm.expectRevert(VaultCore.ExitNeedsChildSettlement.selector);
        parent.requestExit(aliceShares);

        // Governance rescue is closed as well: the child queues the parent's redemption.
        uint256 pcs = child.sharesOf(address(parent));
        vm.prank(address(gov));
        vm.expectRevert(VaultCore.ChildSettlementPending.selector);
        parent.redeemFromChild(address(child), pcs);
    }

    /// B2: the harder case — the child charges NO exit fee to the parent (parent is its sole
    /// holder, so the waiver fires) but the child is PROFITABLE, so the 10% performance fee
    /// withheld from the parent's redemption leaves the same unsatisfiable residue. A
    /// profitable sub-vault is the normal case, not a config edge.
    function test_B2_profitableChildMakesParentExitUnsatisfiable() public {
        vm.prank(operator);
        VaultCore parent = VaultCore(factory.createVault(_params(0)));
        vm.prank(operator);
        VaultCore child = VaultCore(factory.createChildVault(_params(100), address(parent)));

        _join(parent, operator, 1_000 * USDC_1);
        _join(parent, alice, 1_000 * USDC_1);
        vm.prank(address(gov));
        parent.allocateToChild(address(child), 1_900 * USDC_1);

        // Make the child profitable for the parent: bob joins the child and leaves; his 1%
        // exit fee stays behind and lifts the child's NAV per share (§4.6).
        _join(child, bob, 1_000 * USDC_1);
        uint256 bobChildShares = child.sharesOf(bob);
        vm.prank(bob);
        child.requestExit(bobChildShares);
        assertEq(child.sharesOf(bob), 0, "bob out");
        assertEq(child.idleUsdc(), 1_910 * USDC_1, "fee retained: parent sits on a gain");

        // Parent is now the child's sole holder ⇒ the child's exit fee is waived for it.
        // Let every fee clock run out anyway; only the performance fee remains.
        _fwd(60 days);
        assertEq(child.exitFeeBpsOf(address(parent)), 0, "no exit fee left");

        uint256 aliceShares = parent.sharesOf(alice);
        vm.prank(alice);
        vm.expectRevert(VaultCore.ExitNeedsChildSettlement.selector);
        parent.requestExit(aliceShares);

        // Still impossible a year later.
        _fwd(365 days);
        vm.prank(alice);
        vm.expectRevert(VaultCore.ExitNeedsChildSettlement.selector);
        parent.requestExit(aliceShares);

        // Escapes that DO exist, for severity calibration:
        //  (a) a partial exit small enough to be covered by parent idle alone;
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        parent.requestExit(aliceShares / 40);
        assertGt(usdc.balanceOf(alice), before, "small partial exit works");

        //  (b) a governance ChildAllocation redeem, i.e. alice needs a passing vote to leave.
        uint256 parentChildShares = child.sharesOf(address(parent));
        vm.prank(address(gov));
        parent.redeemFromChild(address(child), parentChildShares);
        uint256 rest = parent.sharesOf(alice);
        vm.prank(alice);
        parent.requestExit(rest);
        assertEq(parent.sharesOf(alice), 0, "only governance can liberate the position");
    }
}
