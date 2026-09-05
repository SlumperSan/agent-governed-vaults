// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {Governance} from "../../src/Governance.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

/// @notice AUDIT ARTIFACT — not a protocol test. This file exists to record a remediation that
/// was ATTEMPTED, MEASURED, AND REVERTED, because shipping it would have introduced C-2's shape
/// into `propose` while the same commit was removing C-2's shape from `proposalCooldown`.
///
/// M-6's finding is that every named CM-6/VO-5 defence is optional and the repo's only worked
/// config disabled all three. The obvious fix is a contract-level FLOOR on
/// `proposalThresholdBps`. It is the wrong instrument, and this is why:
///
/// `propose` requires `own * BPS >= proposalThresholdBps * total`. The threshold is a fraction
/// of *live stake distribution*, which the constructor cannot see. In a vault with 101 roughly
/// equal members nobody holds 1%, so **no member can open any proposal at all** — and the
/// RuleChange that would lower the threshold is itself a proposal. Self-locking.
///
/// Recovery exists but is not in any single member's hands: exits shrink `total`, which raises
/// everyone else's fraction, so the vault regains governance only once enough members have left.
/// At the 1% floor with 101 members that is ~2 members exiting; at a realistic launch (50,000
/// USDC cap, 1 USDC minimum deposit) the distribution can be far flatter and the required
/// exodus far larger. Meanwhile the vault cannot rebalance, and governance is the only route to
/// `executeRebalance`.
///
/// So the floor trades a configuration weakness for a liveness cliff whose trigger is member
/// distribution — exactly the trade rejected for C-1's suggested fix (`pHeld = 0`), which broke
/// a legitimate parent+1-member child to raise attacker cost from one dust deposit to two.
///
/// **What shipped instead:** the concentration ceiling and the `proposalCooldown` bounds, which
/// have no such cliff, plus corrected reference configs. M-6's real defect was that the shipped
/// configs disabled their own defences; that is fixed where it lives, in the configs.
contract AuditProposalThresholdFloorTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockOracle oracle;
    StubFeeEngine fees;
    StubRegistry registry;
    Governance gov;
    VaultCore vault;

    address creator = makeAddr("creator");

    function setUp() public {
        vm.warp(1_000_000);
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
            10_000_000 * USDC_1,
            1 * USDC_1,
            0,
            0,
            new address[](0),
            address(0)
        );
    }

    function _cfg(uint16 thresholdBps) internal pure returns (Governance.GovConfig memory) {
        return Governance.GovConfig({
            commitDuration: 6 hours,
            revealDuration: 6 hours,
            timelockDuration: 1 days,
            executionWindow: 2 days,
            quorumBps: 2_500,
            proposalThresholdBps: thresholdBps,
            concentrationCapBps: 4_000,
            proposalCooldown: 1 hours
        });
    }

    /// @dev `n` members with identical stake, so each holds exactly 1/n of eligible supply.
    function _flatMembership(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            address who = address(uint160(0x1000 + i));
            usdc.mint(who, 100 * USDC_1);
            vm.startPrank(who);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(100 * USDC_1);
            vault.skipWindow();
            vm.stopPrank();
        }
        skip(1); // snapshots read createdAt - 1
    }

    /// @notice THE REASON THE FLOOR WAS NOT SHIPPED. With 101 equal members each holds 0.990%,
    /// which is under a 1% threshold, so EVERY member is refused. Governance is the only route
    /// to `executeRebalance`, and the RuleChange that would lower the threshold is itself a
    /// proposal — so the vault cannot legislate its way out. That is C-2's shape.
    function test_aFlatMembershipCannotProposeAtAOnePercentThreshold() public {
        vm.prank(creator);
        gov.registerVault(address(vault), _cfg(100)); // the floor that was considered
        _flatMembership(101);

        for (uint256 i; i < 5; ++i) {
            address who = address(uint160(0x1000 + i));
            assertGt(vault.votingEligibleShares(who), 0, "holds stake");
            vm.prank(who);
            vm.expectRevert(Governance.BelowProposalThreshold.selector);
            gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256("x"));
        }
    }

    /// @notice And the same membership governs perfectly well at the shipped threshold of 0 —
    /// which is what makes this a self-inflicted freeze rather than an inherent limit.
    function test_theSameMembershipGovernsFineWithoutTheFloor() public {
        vm.prank(creator);
        gov.registerVault(address(vault), _cfg(0));
        _flatMembership(101);

        address who = address(uint160(0x1000));
        vm.prank(who);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256("x"));
        assertGt(pid, 0, "a 0.99% holder can open a proposal");
    }

    /// @notice The recovery path, recorded so the severity is not overstated: exits shrink the
    /// denominator, so the vault regains governance once enough members leave. It is real, but it
    /// is not in any single member's hands — which is the difference between "degraded" and
    /// "recoverable by the party who needs it".
    function test_exitsShrinkTheDenominatorAndEventuallyRestoreGovernance() public {
        vm.prank(creator);
        gov.registerVault(address(vault), _cfg(100));
        _flatMembership(101);

        address survivor = address(uint160(0x1000));
        vm.prank(survivor);
        vm.expectRevert(Governance.BelowProposalThreshold.selector);
        gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256("x"));

        // Two members leave; the survivors now hold 1/99 = 1.01% each.
        for (uint256 i = 99; i < 101; ++i) {
            address who = address(uint160(0x1000 + i));
            uint256 sh = vault.sharesOf(who);
            vm.prank(who);
            vault.requestExit(sh);
        }
        skip(1);

        vm.prank(survivor);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256("x"));
        assertGt(pid, 0, "governance returns once the denominator shrinks");
    }
}
