// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {Governance} from "../src/Governance.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubRegistry} from "./mocks/Mocks.sol";

contract GovernanceTest is Test {
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
            new address[](0)
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

    // ── lifecycle ────────────────────────────────────────────────────────────

    function test_fullLifecycle_passAndExecute() public {
        uint256 pid = _propose();

        _commitAndReveal(pid, creator, true);
        _commitAndReveal(pid, alice, true);
        _revealPhase(pid);
        _reveal(pid, creator, true);
        _reveal(pid, alice, true);

        vm.warp(block.timestamp + 6 hours); // past reveal deadline
        gov.finalize(pid);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Passed));

        vm.expectRevert(Governance.TimelockActive.selector);
        gov.execute(pid, REBALANCE_PAYLOAD);

        vm.warp(block.timestamp + 1 days);
        gov.execute(pid, REBALANCE_PAYLOAD);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Executed));
        assertFalse(gov.hasPendingExecution(address(vault)));
    }

    function test_quorumFloorDefeats() public {
        uint256 pid = _propose();
        // Only creator (20% of stake) reveals — below the 25% floor.
        _commitAndReveal(pid, creator, true);
        _revealPhase(pid);
        _reveal(pid, creator, true);

        vm.warp(block.timestamp + 6 hours);
        gov.finalize(pid);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Defeated));
    }

    function test_unrevealedCommitIsForfeit() public {
        uint256 pid = _propose();
        _commitAndReveal(pid, creator, true);
        _commitAndReveal(pid, alice, true); // alice commits, never reveals (VO-6)
        _commitAndReveal(pid, bob, true);
        _revealPhase(pid);
        _reveal(pid, creator, true);
        _reveal(pid, bob, true);

        vm.warp(block.timestamp + 6 hours);
        gov.finalize(pid);
        (,,,,,,,,,,,,, uint256 againstW, uint256 revealedW,) = _p(pid);
        assertEq(revealedW, 2_000 * USDC_1 * 1e12, "alice's weight absent everywhere");
        assertEq(againstW, 0);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Passed), "40% quorum from revealers");
    }

    // ── flash-deposit defense (VO-9) ─────────────────────────────────────────

    function test_postCreationDepositHasZeroWeight() public {
        uint256 pid = _propose();

        // Attacker joins AFTER proposal creation with 100x the vault.
        address attacker = makeAddr("attacker");
        usdc.mint(attacker, 500_000 * USDC_1);
        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(500_000 * USDC_1);
        vault.skipWindow();
        // Commit requires snapshot weight — attacker has none at createdAt.
        vm.expectRevert(Governance.NoWeight.selector);
        gov.commitVote(pid, _commitment(pid, attacker, true));
        vm.stopPrank();
    }

    // ── standing defaults (VO-2/3/4, K-3) ────────────────────────────────────

    function test_defaultCountsInTallyNeverQuorum() public {
        vm.prank(carol);
        gov.setStandingDefault(address(vault), true);

        uint256 pid = _propose();
        _commitAndReveal(pid, creator, true);
        _revealPhase(pid);
        _reveal(pid, creator, true);
        gov.applyStandingDefault(pid, carol);

        vm.warp(block.timestamp + 6 hours);
        gov.finalize(pid);
        (,,,,,,,,,,,, uint256 forW,, uint256 revealedW,) = _p(pid);
        assertEq(forW, 2_000 * USDC_1 * 1e12, "default in tally");
        assertEq(revealedW, 1_000 * USDC_1 * 1e12, "default NOT in quorum");
        // 20% revealed < 25% floor ⇒ defeated even though tally was 2000-0 (K-3 by design).
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Defeated));
    }

    function test_defaultExpiresAfter72h() public {
        vm.prank(carol);
        gov.setStandingDefault(address(vault), true);
        skip(73 hours);

        uint256 pid = _propose();
        _revealPhase(pid);
        vm.expectRevert(Governance.DefaultUnavailable.selector);
        gov.applyStandingDefault(pid, carol);
    }

    function test_defaultOnlyForRebalanceType() public {
        vm.prank(carol);
        gov.setStandingDefault(address(vault), true);

        vm.prank(creator);
        uint256 pid =
            gov.propose(address(vault), Governance.ProposalType.RuleChange, keccak256(abi.encode(_cfg())));
        _revealPhase(pid);
        vm.expectRevert(Governance.NotRebalance.selector);
        gov.applyStandingDefault(pid, carol);
    }

    // ── delegation (VO-5) ────────────────────────────────────────────────────

    function test_delegationCranksOntoDelegateDirection() public {
        vm.prank(carol);
        gov.setDelegate(address(vault), alice);

        uint256 pid = _propose();
        _commitAndReveal(pid, creator, true);
        _commitAndReveal(pid, alice, false);
        _revealPhase(pid);
        _reveal(pid, creator, true);
        _reveal(pid, alice, false);
        gov.revealDelegated(pid, carol);

        (,,,,,,,,,,,, uint256 forW, uint256 againstW, uint256 revealedW,) = _p(pid);
        assertEq(againstW, 2_000 * USDC_1 * 1e12, "carol's weight follows alice");
        assertEq(forW, 1_000 * USDC_1 * 1e12);
        assertEq(revealedW, 3_000 * USDC_1 * 1e12, "delegated reveal counts in quorum");
    }

    function test_concentrationCapBlocksExcessDelegation() public {
        // alice + carol + dave = 3000 of 5000 = 60% > 40% cap once dave cranks.
        vm.prank(carol);
        gov.setDelegate(address(vault), alice);
        vm.prank(dave);
        gov.setDelegate(address(vault), alice);

        uint256 pid = _propose();
        _commitAndReveal(pid, alice, true);
        _revealPhase(pid);
        _reveal(pid, alice, true);
        gov.revealDelegated(pid, carol); // alice at 40% — exactly at cap
        vm.expectRevert(Governance.ConcentrationCap.selector);
        gov.revealDelegated(pid, dave); // would exceed
    }

    function test_selfVoteBeatsDelegation() public {
        vm.prank(carol);
        gov.setDelegate(address(vault), alice);

        uint256 pid = _propose();
        _commitAndReveal(pid, alice, true);
        _commitAndReveal(pid, carol, false); // carol participates herself
        _revealPhase(pid);
        _reveal(pid, alice, true);
        _reveal(pid, carol, false);
        vm.expectRevert(Governance.AlreadyCommitted.selector);
        gov.revealDelegated(pid, carol);
    }

    // ── signer-count regime (CM-7) ───────────────────────────────────────────

    function test_signerRegimeUnder5Members() public {
        // Shrink to 3 members: carol and dave exit fully.
        uint256 carolShares = vault.sharesOf(carol);
        vm.prank(carol);
        vault.requestExit(carolShares);
        uint256 daveShares = vault.sharesOf(dave);
        vm.prank(dave);
        vault.requestExit(daveShares);
        assertEq(vault.holderCount(), 3);
        skip(1); // strictly-before snapshot must see the post-exit member set

        uint256 pid = _propose();
        (,,,,,,,,,,, uint256 memberCount,,,,) = _p(pid);
        assertEq(memberCount, 3, "regime snapshot");

        // 2 of 3 signers reveal — strict majority regardless of stake distribution.
        _commitAndReveal(pid, creator, true);
        _commitAndReveal(pid, alice, true);
        _revealPhase(pid);
        _reveal(pid, creator, true);
        _reveal(pid, alice, true);

        vm.warp(block.timestamp + 6 hours);
        gov.finalize(pid);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Passed));
    }

    // ── rule change: full consensus (CM-8, K-2) ──────────────────────────────

    function test_ruleChangeRequiresFullConsensus() public {
        Governance.GovConfig memory newCfg = _cfg();
        newCfg.quorumBps = 5_000;
        bytes memory payload = abi.encode(newCfg);

        vm.prank(creator);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.RuleChange, keccak256(payload));

        // 4 of 5 reveal FOR — not full consensus.
        address[4] memory who = [creator, alice, bob, carol];
        for (uint256 i; i < 4; ++i) {
            _commitAndReveal(pid, who[i], true);
        }
        _revealPhase(pid);
        for (uint256 i; i < 4; ++i) {
            _reveal(pid, who[i], true);
        }
        vm.warp(block.timestamp + 6 hours);
        gov.finalize(pid);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Defeated), "one absent member vetoes");
    }

    function test_ruleChangeFullConsensusPassesAndApplies() public {
        Governance.GovConfig memory newCfg = _cfg();
        newCfg.quorumBps = 5_000;
        bytes memory payload = abi.encode(newCfg);

        vm.prank(creator);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.RuleChange, keccak256(payload));

        address[5] memory who = [creator, alice, bob, carol, dave];
        for (uint256 i; i < 5; ++i) {
            _commitAndReveal(pid, who[i], true);
        }
        _revealPhase(pid);
        for (uint256 i; i < 5; ++i) {
            _reveal(pid, who[i], true);
        }
        vm.warp(block.timestamp + 6 hours);
        gov.finalize(pid);
        vm.warp(block.timestamp + 1 days);
        gov.execute(pid, payload);

        (,,,, uint16 quorumBps,,,) = gov.configOf(address(vault));
        assertEq(quorumBps, 5_000, "config applied after full consensus + timelock");
    }

    // ── Mode-F integration with the real governance (VO-8, K-1, EE-10) ───────

    function test_exitDuringRevealPhaseIsForwardPriced() public {
        uint256 pid = _propose();
        assertFalse(gov.hasPendingExecution(address(vault)), "commit phase: Mode I");

        _commitAndReveal(pid, creator, true);
        _commitAndReveal(pid, alice, true);
        _revealPhase(pid);
        assertTrue(gov.hasPendingExecution(address(vault)), "reveal phase: Mode F");

        // bob exits during reveal — queued, not settled.
        uint256 bobShares = vault.sharesOf(bob);
        vm.prank(bob);
        vault.requestExit(bobShares);
        assertEq(vault.queuedExitShares(bob), bobShares, "queued");
        assertEq(vault.votingEligibleShares(bob), 0, "locked out of voting");

        _reveal(pid, creator, true);
        _reveal(pid, alice, true);
        vm.warp(block.timestamp + 6 hours);
        gov.finalize(pid);
        assertTrue(gov.hasPendingExecution(address(vault)), "passed: still Mode F");

        vm.expectRevert(VaultCore.ExecutionStillPending.selector);
        vault.settleQueuedExit(bob);

        vm.warp(block.timestamp + 1 days);
        gov.execute(pid, REBALANCE_PAYLOAD);
        uint256 bal = usdc.balanceOf(bob);
        vault.settleQueuedExit(bob); // settles at post-execution NAV
        assertGt(usdc.balanceOf(bob) - bal, 0, "forward-priced settlement");
    }

    function test_expiredProposalReleasesQueuedExits() public {
        uint256 pid = _propose();
        _commitAndReveal(pid, creator, true);
        _commitAndReveal(pid, alice, true);
        _revealPhase(pid);

        uint256 bobShares = vault.sharesOf(bob);
        vm.prank(bob);
        vault.requestExit(bobShares);

        _reveal(pid, creator, true);
        _reveal(pid, alice, true);
        vm.warp(block.timestamp + 6 hours);
        gov.finalize(pid);

        // Nobody executes; window lapses.
        vm.warp(block.timestamp + 1 days + 2 days + 1);
        assertFalse(gov.hasPendingExecution(address(vault)), "expiry releases Mode F");
        vault.settleQueuedExit(bob); // EE-10: no indefinite lock
        assertEq(vault.queuedExitShares(bob), 0);
    }

    // ── proposal rights & serialization (CM-6) ───────────────────────────────

    function test_proposalThresholdEnforced() public {
        address pauper = makeAddr("pauper");
        usdc.mint(pauper, 100 * USDC_1);
        vm.startPrank(pauper);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10 * USDC_1); // ~0.2% < 5% threshold
        vault.skipWindow();
        skip(1); // let the strictly-before snapshot see the stake
        vm.expectRevert(Governance.BelowProposalThreshold.selector);
        gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(REBALANCE_PAYLOAD));
        vm.stopPrank();
    }

    function test_oneActiveProposalPerVault() public {
        _propose();
        vm.prank(alice);
        vm.expectRevert(Governance.ProposalActive.selector);
        gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(REBALANCE_PAYLOAD));
    }

    function test_timelockHardCapEnforced() public {
        Governance.GovConfig memory bad = _cfg();
        bad.timelockDuration = 31 days;
        MockERC20 usdc2 = new MockERC20("USDC", 6);
        address[] memory basket = new address[](0);
        VaultCore v2 = new VaultCore(
            address(usdc2),
            basket,
            creator,
            registry,
            gov,
            fees,
            oracle,
            1e15,
            10 * USDC_1,
            100,
            30 days,
            new address[](0)
        );
        vm.prank(creator);
        vm.expectRevert(Governance.BadGovConfig.selector);
        gov.registerVault(address(v2), bad);
    }
}
