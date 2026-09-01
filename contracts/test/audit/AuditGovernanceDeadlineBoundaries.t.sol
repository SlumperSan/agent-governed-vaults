// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {Governance} from "../../src/Governance.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

/// @notice AUDIT ARTIFACT — pins the exact second at which each governance phase opens and
/// closes: commit close / reveal open, reveal close, the timelock boundary (executableAt), the
/// execution-window boundary (expiresAt) against BOTH `execute` and `markExpired`, the proposal
/// cooldown, and the 72h standing-default TTL. Every assertion here targets a `<` vs `<=` (or
/// `>=` vs `>`) choice in a phase guard in Governance.sol — flip any one of those operators and
/// the corresponding test in this file goes red. Modeled on test/Governance.t.sol's setUp,
/// helpers, and 5-equal-member fixture.
contract AuditGovernanceDeadlineBoundaries is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockOracle oracle;
    StubFeeEngine fees;
    StubRegistry registry;
    Governance gov;
    VaultCore vault;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    bytes32 constant SALT = keccak256("salt");
    bytes constant REBALANCE_PAYLOAD = ""; // no-op rebalance; real orders in Execution.t.sol

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        fees = new StubFeeEngine();
        registry = new StubRegistry();
        gov = new Governance();

        address[] memory basket = new address[](0);
        vault = new VaultCore(
            address(usdc),
            basket,
            creator,
            registry,
            gov,
            fees,
            oracle,
            1_000_000_000 * USDC_1,
            10 * USDC_1,
            100,
            30 days,
            new address[](0),
            address(0)
        );

        vm.prank(creator);
        gov.registerVault(address(vault), _cfg());

        address[5] memory who = [creator, alice, bob, carol, dave];
        for (uint256 i; i < who.length; ++i) {
            usdc.mint(who[i], 10_000_000 * USDC_1);
            vm.startPrank(who[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(1_000 * USDC_1);
            vault.skipWindow(); // immediate activation for test setup
            vm.stopPrank();
        }
        // 5 equal members, 1000 USDC each ⇒ stake-quorum regime.
        skip(1); // snapshots are strictly-before-creation; separate setup from proposals
    }

    function _cfg() internal pure returns (Governance.GovConfig memory) {
        return Governance.GovConfig({
            commitDuration: 6 hours,
            revealDuration: 6 hours,
            timelockDuration: 1 days,
            executionWindow: 2 days,
            quorumBps: 2_500,
            proposalThresholdBps: 500, // 5% to propose
            concentrationCapBps: 4_000, // 40% delegate cap
            proposalCooldown: 1 hours
        });
    }

    function _commitment(uint256 pid, address voter, bool support) internal pure returns (bytes32) {
        return keccak256(abi.encode(pid, voter, support, SALT));
    }

    function _propose() internal returns (uint256 pid) {
        vm.prank(creator);
        pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(REBALANCE_PAYLOAD));
    }

    function _commitAndReveal(uint256 pid, address voter, bool support) internal {
        vm.prank(voter);
        gov.commitVote(pid, _commitment(pid, voter, support));
    }

    function _revealPhase(uint256 pid) internal {
        (,,,, uint64 commitDeadline,,,,,,,,,,,) = _p(pid);
        if (block.timestamp < commitDeadline) vm.warp(commitDeadline);
    }

    function _reveal(uint256 pid, address voter, bool support) internal {
        vm.prank(voter);
        gov.revealVote(pid, support, SALT);
    }

    function _p(uint256 pid)
        internal
        view
        returns (
            address v,
            Governance.ProposalType pt,
            address proposer,
            uint64 createdAt,
            uint64 commitDeadline,
            uint64 revealDeadline,
            uint64 executableAt,
            uint64 expiresAt,
            Governance.Status status,
            bytes32 actionHash,
            uint256 snapshotTotal,
            uint256 memberCount,
            uint256 forW,
            uint256 againstW,
            uint256 revealedW,
            uint256 revealedCount
        )
    {
        return gov.proposals(pid);
    }

    function _status(uint256 pid) internal view returns (Governance.Status s) {
        (,,,,,,,, s,,,,,,,) = _p(pid);
    }

    function _createdAt(uint256 pid) internal view returns (uint64 t) {
        (,,, t,,,,,,,,,,,,) = _p(pid);
    }

    function _commitDeadline(uint256 pid) internal view returns (uint64 t) {
        (,,,, t,,,,,,,,,,,) = _p(pid);
    }

    function _revealDeadline(uint256 pid) internal view returns (uint64 t) {
        (,,,,, t,,,,,,,,,,) = _p(pid);
    }

    function _executableAt(uint256 pid) internal view returns (uint64 t) {
        (,,,,,, t,,,,,,,,,) = _p(pid);
    }

    function _expiresAt(uint256 pid) internal view returns (uint64 t) {
        (,,,,,,, t,,,,,,,,) = _p(pid);
    }

    function _forWeight(uint256 pid) internal view returns (uint256 w) {
        (,,,,,,,,,,,, w,,,) = _p(pid);
    }

    // ── 1. commitDeadline: commit closes / reveal opens ────────────────────────

    function test_commitDeadline_partitionsExactly() public {
        uint256 pid = _propose();
        uint64 commitDeadline = _commitDeadline(pid);

        // Last second of the commit phase: a fresh voter can still commit.
        vm.warp(commitDeadline - 1);
        _commitAndReveal(pid, bob, true);
        assertFalse(gov.hasPendingExecution(address(vault)), "commit phase: Mode I");

        // First second after: commit is closed for a fresh voter.
        vm.warp(commitDeadline);
        vm.prank(carol);
        vm.expectRevert(Governance.WrongPhase.selector);
        gov.commitVote(pid, _commitment(pid, carol, true));
        assertTrue(gov.hasPendingExecution(address(vault)), "reveal phase open: Mode F");

        // Back at commitDeadline - 1: reveal is not yet open, even for bob who already holds a
        // valid commitment from above — the revert must be the phase guard, not NoCommit.
        vm.warp(commitDeadline - 1);
        vm.prank(bob);
        vm.expectRevert(Governance.WrongPhase.selector);
        gov.revealVote(pid, true, SALT);

        // At commitDeadline exactly: reveal opens.
        vm.warp(commitDeadline);
        _reveal(pid, bob, true);
    }

    // ── 2. revealDeadline: reveal closes / finalize opens ──────────────────────

    function test_revealDeadline_partitionsExactly() public {
        uint256 pid = _propose();
        uint64 commitDeadline = _commitDeadline(pid);
        uint64 revealDeadline = _revealDeadline(pid);

        // All three voters commit during the commit phase.
        _commitAndReveal(pid, creator, true);
        _commitAndReveal(pid, alice, true);
        _commitAndReveal(pid, bob, true);

        vm.warp(commitDeadline);
        _reveal(pid, creator, true);

        // Last second of the reveal phase: finalize is not yet open, but a second voter can
        // still reveal at this exact same second.
        vm.warp(revealDeadline - 1);
        vm.expectRevert(Governance.WrongPhase.selector);
        gov.finalize(pid);
        _reveal(pid, alice, true);

        // First second after: reveal closes for a fresh voter, and finalize opens.
        vm.warp(revealDeadline);
        vm.prank(bob);
        vm.expectRevert(Governance.WrongPhase.selector);
        gov.revealVote(pid, true, SALT);
        gov.finalize(pid);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Passed), "creator+alice FOR clears 25% quorum");
    }

    // ── 3. executableAt: the timelock boundary ─────────────────────────────────

    function test_executableAt_boundary() public {
        uint256 pid = _propose();
        _commitAndReveal(pid, creator, true);
        _commitAndReveal(pid, alice, true);
        _revealPhase(pid);
        _reveal(pid, creator, true);
        _reveal(pid, alice, true);

        vm.warp(_revealDeadline(pid));
        gov.finalize(pid);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Passed));

        uint64 executableAt = _executableAt(pid);

        vm.warp(executableAt - 1);
        vm.expectRevert(Governance.TimelockActive.selector);
        gov.execute(pid, REBALANCE_PAYLOAD);

        vm.warp(executableAt);
        gov.execute(pid, REBALANCE_PAYLOAD);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Executed));
    }

    // ── 4. expiresAt: execute vs markExpired — no gap, no overlap ──────────────

    /// @notice The single most important test in this file: it pins that there is no second in
    /// which both `execute` and expiry (`markExpired`) are open, and no second in which neither
    /// is. Two mutating branches (execute vs markExpired) need to start from the same Passed
    /// state, so this snapshots right after finalize and uses `vm.revertToState` between
    /// branches rather than standing up separate proposals.
    function test_expiresAt_partitionsExactly_executeVsMarkExpired() public {
        uint256 pid = _propose();
        _commitAndReveal(pid, creator, true);
        _commitAndReveal(pid, alice, true);
        _revealPhase(pid);
        _reveal(pid, creator, true);
        _reveal(pid, alice, true);

        vm.warp(_revealDeadline(pid));
        gov.finalize(pid);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Passed));

        uint64 expiresAt = _expiresAt(pid);
        uint256 snap = vm.snapshotState();

        // ── At expiresAt exactly: still inside the execution window (Mode F still active). ──
        vm.warp(expiresAt);
        vm.expectRevert(Governance.WrongPhase.selector);
        gov.markExpired(pid);
        assertTrue(gov.hasPendingExecution(address(vault)), "still Mode F at expiresAt");

        vm.revertToState(snap);
        vm.warp(expiresAt);
        gov.execute(pid, REBALANCE_PAYLOAD); // succeeds at the exact boundary second
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Executed));

        vm.revertToState(snap);

        // ── At expiresAt + 1: the window has closed. ──
        vm.warp(expiresAt + 1);
        vm.expectRevert(Governance.ExecutionWindowOver.selector);
        gov.execute(pid, REBALANCE_PAYLOAD);
        gov.markExpired(pid);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Expired));
        assertFalse(gov.hasPendingExecution(address(vault)), "expiry releases Mode F");
    }

    // ── 5. proposalCooldown: measured from lastProposalAt (== createdAt) ───────

    function test_proposalCooldown_boundary() public {
        uint256 pid1 = _propose();
        uint64 createdAt = _createdAt(pid1);

        // Settle pid1 with zero reveals — 0% revealed can never clear the 25% stake quorum
        // floor, so this must land Defeated.
        vm.warp(_revealDeadline(pid1));
        gov.finalize(pid1);
        assertEq(uint8(_status(pid1)), uint8(Governance.Status.Defeated), "no reveals => defeated");

        // One second short of the cooldown (measured from createdAt, not from settlement):
        // creator's second proposal reverts.
        vm.warp(createdAt + 1 hours - 1);
        vm.expectRevert(Governance.Cooldown.selector);
        _propose();

        // Exactly at the cooldown boundary: succeeds.
        vm.warp(createdAt + 1 hours);
        uint256 pid2 = _propose();
        assertTrue(pid2 != 0);
    }

    // ── 6. standing-default 72h TTL ─────────────────────────────────────────────

    function test_standingDefaultTtl_boundary() public {
        vm.prank(carol);
        gov.setStandingDefault(address(vault), true);
        uint64 t0 = uint64(block.timestamp);

        uint256 snap = vm.snapshotState();

        // ── Case A: reveal window opens at exactly t0 + 72h (setAt + DEFAULT_TTL). ──
        // commitDuration = 6h, so proposing at t0 + 72h - 6h makes commitDeadline == t0 + 72h,
        // the first second of the reveal window.
        vm.warp(t0 + gov.DEFAULT_TTL() - 6 hours);
        uint256 pidA = _propose();
        vm.warp(_commitDeadline(pidA));
        assertEq(_commitDeadline(pidA), t0 + gov.DEFAULT_TTL(), "reveal window opens exactly at TTL");

        uint256 forBefore = _forWeight(pidA);
        gov.applyStandingDefault(pidA, carol);
        uint256 forAfter = _forWeight(pidA);
        assertGt(forAfter, forBefore, "default applied: forWeight increased");
        assertEq(forAfter - forBefore, 1_000 * USDC_1 * 1e12, "carol's full weight applied");

        // ── Case B: identical, but the reveal window opens one second past the TTL. ──
        vm.revertToState(snap);
        vm.warp(t0 + gov.DEFAULT_TTL() - 6 hours + 1);
        uint256 pidB = _propose();
        vm.warp(_commitDeadline(pidB));
        assertEq(_commitDeadline(pidB), t0 + gov.DEFAULT_TTL() + 1, "reveal window opens one second past TTL");

        vm.expectRevert(Governance.DefaultUnavailable.selector);
        gov.applyStandingDefault(pidB, carol);
    }
}
