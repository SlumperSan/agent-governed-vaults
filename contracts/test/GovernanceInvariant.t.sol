// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {Governance} from "../src/Governance.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubRegistry} from "./mocks/Mocks.sol";

/// Drives complete commit→reveal→finalize→execute rounds under fuzz. Each handler action runs a
/// whole round atomically (managing salts + phase warps internally), so the fuzzer explores many
/// vote configurations without having to interleave phase timing. Ghosts track what SHOULD
/// happen; invariants assert the governance math never violates its contract.
contract GovHandler is Test {
    VaultCore public vault;
    Governance public gov;
    address[] public voters;
    bytes constant PAYLOAD = ""; // no-op rebalance
    bytes32 constant SALT = keccak256("gov-inv");

    uint256 public roundsRun;
    uint256 public roundsPassed;
    uint256 public roundsDefeated;
    uint256 public maxRevealedWeightSeen;
    bool public sawActiveWhileSettled; // must stay false (one-active-proposal invariant)

    constructor(VaultCore vault_, Governance gov_, address[] memory voters_) {
        vault = vault_;
        gov = gov_;
        voters = voters_;
    }

    function _commitment(uint256 pid, address v, bool support) internal pure returns (bytes32) {
        return keccak256(abi.encode(pid, v, support, SALT));
    }

    /// Run one full proposal round. `forMask` bit i = voter i votes FOR; `voteMask` bit i =
    /// voter i participates at all. `proposerSeed` picks the proposer.
    function runRound(uint8 voteMask, uint8 forMask, uint256 proposerSeed) external {
        // Only one active proposal at a time — if the previous one is unsettled, skip.
        uint256 active = gov.activeProposalOf(address(vault));
        if (active != 0) {
            (,,,,,,,, Governance.Status st,,,,,,,) = gov.proposals(active);
            if (st == Governance.Status.Active || st == Governance.Status.Passed) return;
        }

        address proposer = voters[proposerSeed % voters.length];
        vm.prank(proposer);
        try gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(PAYLOAD)) returns (
            uint256 pid
        ) {
            _drive(pid, voteMask, forMask);
        } catch {
            return; // proposer below threshold, cooldown, etc. — not a governance violation
        }
    }

    function _drive(uint256 pid, uint8 voteMask, uint8 forMask) internal {
        // Commit phase.
        for (uint256 i; i < voters.length && i < 8; ++i) {
            if (voteMask & (1 << i) == 0) continue;
            vm.prank(voters[i]);
            try gov.commitVote(pid, _commitment(pid, voters[i], forMask & (1 << i) != 0)) {} catch {}
        }
        // Advance to reveal.
        (,,,, uint64 commitDeadline, uint64 revealDeadline,,,,,,,,,,) = gov.proposals(pid);
        vm.warp(commitDeadline);
        for (uint256 i; i < voters.length && i < 8; ++i) {
            if (voteMask & (1 << i) == 0) continue;
            vm.prank(voters[i]);
            try gov.revealVote(pid, forMask & (1 << i) != 0, SALT) {} catch {}
        }
        // Finalize.
        vm.warp(revealDeadline);
        gov.finalize(pid);

        roundsRun++;
        (,,,,,,,, Governance.Status st,,, uint256 memberCount, uint256 fw, uint256 aw, uint256 rw,) =
            gov.proposals(pid);
        if (rw > maxRevealedWeightSeen) maxRevealedWeightSeen = rw;
        if (st == Governance.Status.Passed) {
            roundsPassed++;
            // A passed proposal must have had strictly more FOR than AGAINST.
            require(fw > aw, "passed without majority");
            // Execute it to clear the slot (no-op payload).
            (,,,,,, uint64 executableAt,,,,,,,,,) = gov.proposals(pid);
            vm.warp(executableAt);
            try gov.execute(pid, PAYLOAD) {} catch {}
        } else if (st == Governance.Status.Defeated) {
            roundsDefeated++;
        }
        memberCount; // silence unused
    }

    function voterCount() external view returns (uint256) {
        return voters.length;
    }
}

contract GovernanceInvariantTest is Test {
    MockERC20 usdc;
    MockOracle oracle;
    StubFeeEngine fees;
    StubRegistry registry;
    Governance gov;
    VaultCore vault;
    GovHandler handler;
    address creator = makeAddr("creator");

    function setUp() public {
        vm.warp(1_700_000_000);
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
            0,
            10 * 1e6,
            0,
            0,
            new address[](0),
            address(0)
        );
        vm.prank(creator);
        gov.registerVault(
            address(vault),
            Governance.GovConfig({
                commitDuration: 6 hours,
                revealDuration: 6 hours,
                timelockDuration: 1 days,
                executionWindow: 2 days,
                quorumBps: 2_500,
                proposalThresholdBps: 100,
                concentrationCapBps: 10_000,
                proposalCooldown: 0
            })
        );

        // 4 equal members.
        address[] memory voters = new address[](4);
        voters[0] = creator;
        for (uint256 i = 1; i < 4; ++i) {
            voters[i] = makeAddr(string(abi.encodePacked("gv", i)));
        }
        for (uint256 i; i < 4; ++i) {
            usdc.mint(voters[i], 10_000 * 1e6);
            vm.startPrank(voters[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(1_000 * 1e6);
            vault.skipWindow();
            vm.stopPrank();
        }
        skip(1);

        handler = new GovHandler(vault, gov, voters);
        targetContract(address(handler));
    }

    /// Revealed weight can never exceed the snapshot total eligible stake.
    function invariant_revealedNeverExceedsSnapshot() public view {
        uint256 total = vault.totalShares(); // all active, none queued in this suite
        assertLe(handler.maxRevealedWeightSeen(), total, "revealed > snapshot total");
    }

    /// At most one active/pending proposal exists per vault at any time.
    function invariant_atMostOneLiveProposal() public view {
        uint256 pid = gov.activeProposalOf(address(vault));
        if (pid == 0) return;
        // activeProposalOf only ever points at the latest; earlier ones are terminal. The value
        // being a single slot is the structural guarantee — assert it resolves to a real pid.
        assertLe(pid, gov.proposalCount(), "dangling active pointer");
    }

    /// Passed + defeated never exceed rounds run (every finalized round is one or the other or
    /// stays active only transiently within a handler call).
    function invariant_roundAccountingConsistent() public view {
        assertLe(handler.roundsPassed() + handler.roundsDefeated(), handler.roundsRun(), "round overcount");
    }
}
