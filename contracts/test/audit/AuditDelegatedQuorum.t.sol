// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// VO-2b — CRANKED DELEGATED WEIGHT COUNTS TOWARD THE TALLY AND NEVER TOWARD QUORUM.
//
// The defect, as confirmed by this file's own pre-fix run rather than argued: at the SHIPPED
// `quorumBps` 2500 / `concentrationCapBps` 4000 (both `arc-mainnet.json` and `base-mainnet.json`),
// ONE member's single reveal plus a stranger cranking offline delegators reached quorum, PASSED and
// EXECUTED. `revealDelegated` is permissionless and wrote cranked weight into `p.revealedWeight` on
// the delegate's own direction, so `againstWeight` stayed 0 and the for/against gate was free.
//
// WHY THE CONCENTRATION CAP CANNOT CLOSE IT. The cap binds RECEIVED weight; a delegate's own weight
// is never capped (F1), so it stacks on top — 1000e18 own + 2000e18 capped received = 3000e18
// against a 1250e18 quorum, a 2.4x overshoot, with the cap engaging 1500bps AFTER quorum is already
// crossed. The binding quantity is `ownStakeBps + concentrationCapBps < quorumBps`, and
// `ownStakeBps` is LIVE DISTRIBUTION a constructor cannot see — the identical argument this repo
// accepted when it implemented, measured and then REVERTED the `proposalThresholdBps` floor
// (`AuditProposalThresholdFloor.t.sol`). A config value also cannot survive `RuleChange`: one live
// voter was demonstrated passing a full-consensus rule change that raised the cap straight back.
//
// WHY NOT A DISTINCT-REVEALER FLOOR. A head count ("at least two members must reveal") is free to
// defeat: split one deposit across two addresses. Quorum measured in SELF-REVEALED STAKE cannot be
// inflated that way, because splitting stake does not create stake. That is the discriminator.
//
// AND IT WAS NOT GATED AT THE FIFTH MEMBER, which is how it was first scoped. The sub-five regime
// carries the same attack on a DIFFERENT quantity: `forStakeMajority` reads `p.forWeight`, which is
// a TALLY quantity, so at THREE members one reveal (1000e18) plus one crank (1000e18) made
// `forWeight * 2 = 4000e18 > 3000e18` and passed with `revealedVoterCount == 1`. Both sub-five
// stake terms therefore measure SELF-DIRECTED FOR weight (`forWeight - delegatedForWeight[pid]`).
//
// WHAT IS DELIBERATELY UNCHANGED, and the distinction is the point: APPLIED STANDING DEFAULTS still
// carry the sub-five FOR-majority branch with zero live reveals (Audit Council, accepted). A default
// is the member's OWN direction, Rebalance-only, must pre-date the proposal and expires in 72h — a
// >50% default majority is a real mandate. A crank carries the DELEGATE's direction, has no TTL and
// applies to every proposal type: a >50% cranked majority is one person's decision wearing four
// members' stake. Same weight, different number of deciders. `test_defaultsStillCarrySubFive...`
// pins the half that stays.
//
// THE LIVENESS COST, stated rather than buried: `RuleChange` full consensus is `revealedWeight ==
// snapshotTotal`, so it now requires every member to self-reveal — delegation was the only path for
// a vault with an absent member to change its own rules. It does not self-lock (a Defeated
// RuleChange settles, so the next proposal is not blocked — contrast C-2).

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {Governance} from "../../src/Governance.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

contract AuditDelegatedQuorumTest is Test {
    uint256 constant USDC_1 = 1e6;
    uint256 constant ONE_MEMBER = 1_000 * USDC_1 * 1e12; // 1000 USDC of shares, 18dp
    bytes32 constant SALT = keccak256("salt");

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
    address stranger = makeAddr("stranger"); // no stake, no delegation — the permissionless cranker

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
            vault.skipWindow();
            vm.stopPrank();
        }
        skip(1);
    }

    /// The values SHIPPED in contracts/config/arc-mainnet.json and base-mainnet.json — the point of
    /// this suite is that the attack was reachable at the CONFIGURATION WE INTEND TO LAUNCH, not at
    /// some adversarial one.
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

    function _propose() internal returns (uint256 pid) {
        vm.prank(creator);
        pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(""));
    }

    function _commit(uint256 pid, address voter, bool support) internal {
        vm.prank(voter);
        gov.commitVote(pid, keccak256(abi.encode(pid, voter, support, SALT)));
    }

    function _revealPhase(uint256 pid) internal {
        (,,,, uint64 commitDeadline,,,,,,,,,,,) = gov.proposals(pid);
        if (block.timestamp < commitDeadline) vm.warp(commitDeadline);
    }

    function _reveal(uint256 pid, address voter, bool support) internal {
        vm.prank(voter);
        gov.revealVote(pid, support, SALT);
    }

    function _finalize(uint256 pid) internal returns (Governance.Status s) {
        vm.warp(block.timestamp + 6 hours);
        gov.finalize(pid);
        (,,,,,,,, s,,,,,,,) = gov.proposals(pid);
    }

    function _tally(uint256 pid)
        internal
        view
        returns (
            uint256 snapshotTotal,
            uint256 memberCount,
            uint256 forW,
            uint256 againstW,
            uint256 revealedW,
            uint256 voters
        )
    {
        (,,,,,,,,,, snapshotTotal, memberCount, forW, againstW, revealedW, voters) = gov.proposals(pid);
    }

    function _shrinkToThree() internal {
        uint256 carolShares = vault.sharesOf(carol);
        vm.prank(carol);
        vault.requestExit(carolShares);
        uint256 daveShares = vault.sharesOf(dave);
        vm.prank(dave);
        vault.requestExit(daveShares);
        assertEq(vault.holderCount(), 3, "membership shrunk into the sub-five regime");
        skip(1);
    }

    // ═════════════ the attack, in each of the three quorum regimes ═════════════

    /// Regime 3 (`memberCount >= 5`): the numerator is `revealedWeight`.
    function test_ATTACK_geFive_oneLiveVoterCannotReachQuorum() public {
        vm.prank(bob);
        gov.setDelegate(address(vault), alice);

        uint256 pid = _propose();
        _commit(pid, alice, true);
        _revealPhase(pid);
        _reveal(pid, alice, true);

        // ONE decision by one member. Everything after this line is a stranger with no stake.
        vm.prank(stranger);
        gov.revealDelegated(pid, bob);

        // THE CLAIM FIRST, so a mutation reds on the outcome and not on a diagnostic read.
        assertEq(uint8(_finalize(pid)), uint8(Governance.Status.Defeated), "one live voter cannot pass");

        (uint256 snap, uint256 members, uint256 forW,, uint256 revealedW, uint256 voters) = _tally(pid);
        assertEq(members, 5, "stake-quorum regime");
        assertEq(voters, 1, "exactly one member revealed");
        // The crank still MOVED THE TALLY — the fix withdraws quorum, not delegation.
        assertEq(forW, 2 * ONE_MEMBER, "cranked weight still counts in the tally");
        assertEq(revealedW, ONE_MEMBER, "cranked weight does NOT count in quorum");
        assertLt(revealedW * 10_000, 2_500 * snap, "self-revealed stake is below quorum");
    }

    /// Regime 2 (`memberCount < 5`): the numerator is FOR-stake, so removing the crank from
    /// `revealedWeight` alone does NOT reach this branch. Measured at THREE members.
    function test_ATTACK_subFive_oneLiveVoterCannotCarryForStakeMajority() public {
        _shrinkToThree();
        vm.prank(bob);
        gov.setDelegate(address(vault), alice);

        uint256 pid = _propose();
        _commit(pid, alice, true);
        _revealPhase(pid);
        _reveal(pid, alice, true);
        vm.prank(stranger);
        gov.revealDelegated(pid, bob);

        // THE CLAIM FIRST, so a mutation reds on the outcome and not on a diagnostic read.
        assertEq(uint8(_finalize(pid)), uint8(Governance.Status.Defeated), "one live voter cannot pass");

        (uint256 snap, uint256 members, uint256 forW,,, uint256 voters) = _tally(pid);
        assertEq(members, 3, "sub-five regime");
        assertEq(voters, 1, "exactly one member revealed");
        assertFalse(voters * 2 > members, "the head-majority branch is not what is being tested");
        // The pre-fix numerator WOULD have passed; the self-directed one does not. Both stated, so a
        // later reader can see the exact quantity that changed.
        assertTrue(forW * 2 > snap, "the OLD numerator (raw forWeight) still clears a FOR majority");
        assertEq(gov.delegatedForWeight(pid), ONE_MEMBER, "one crank landed on the FOR side");
        assertFalse((forW - gov.delegatedForWeight(pid)) * 2 > snap, "self-directed FOR does not");
    }

    /// Regime 1 (`RuleChange`): full consensus is `revealedWeight == snapshotTotal`. This is the
    /// DURABILITY half - it is why no config VALUE could ever have been the fix: one live voter was
    /// demonstrated passing the rule change that raises the cap straight back.
    ///
    /// The distribution is deliberately NOT the 5-equal-members fixture. With five equal members a
    /// 4000bps received cap stops the third crank, so `revealedWeight` never reaches `snapshotTotal`
    /// and the RuleChange fails for a reason that has nothing to do with this fix - the assertion
    /// would have passed with and without the defect. 60% own + 40% received under a 5000bps cap is
    /// the distribution where the attack actually completes, so it is the one pinned here.
    function test_ATTACK_ruleChange_cranksCannotManufactureFullConsensus() public {
        Governance.GovConfig memory cfg = _cfg();
        cfg.concentrationCapBps = 5_000; // the ceiling; 40% received must be permitted to land
        VaultCore v2 = new VaultCore(
            address(usdc),
            new address[](0),
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
        gov.registerVault(address(v2), cfg);

        // alice 6000, the other four 1000 each: snapshotTotal 10000, received 4000 = 40% <= cap.
        address[5] memory who = [alice, creator, bob, carol, dave];
        uint256[5] memory amt = [uint256(6_000), 1_000, 1_000, 1_000, 1_000];
        for (uint256 i; i < 5; ++i) {
            vm.startPrank(who[i]);
            usdc.approve(address(v2), type(uint256).max);
            v2.deposit(amt[i] * USDC_1);
            v2.skipWindow();
            vm.stopPrank();
        }
        address[4] memory delegators = [creator, bob, carol, dave];
        for (uint256 i; i < 4; ++i) {
            vm.prank(delegators[i]);
            gov.setDelegate(address(v2), alice);
        }
        skip(1);

        Governance.GovConfig memory raised = cfg;
        raised.concentrationCapBps = 5_000;
        bytes memory payload = abi.encode(raised);
        vm.prank(alice);
        uint256 pid = gov.propose(address(v2), Governance.ProposalType.RuleChange, keccak256(payload));

        vm.prank(alice);
        gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, SALT)));
        _revealPhase(pid);
        vm.prank(alice);
        gov.revealVote(pid, true, SALT);
        for (uint256 i; i < 4; ++i) {
            vm.prank(stranger);
            gov.revealDelegated(pid, delegators[i]); // every crank lands: 4000 == the 5000bps cap
        }

        assertEq(uint8(_finalize(pid)), uint8(Governance.Status.Defeated), "no single-voter rule change");

        (,,,,,,,,,, uint256 snap,, uint256 forW,, uint256 revealedW,) = gov.proposals(pid);
        // The tally reached FULL CONSENSUS on one decision - this is the attack, intact, minus quorum.
        assertEq(forW, snap, "every unit of stake is on the FOR side of the tally");
        assertEq(revealedW, 6_000 * USDC_1 * 1e12, "quorum counts only alice's own 60%");
        assertLt(revealedW, snap, "full consensus is unreachable without every member revealing");
    }

    /// Splitting one deposit across two addresses is the cheap way to beat a distinct-REVEALER
    /// floor. It must not beat a stake quorum, because splitting stake does not create stake.
    function test_ATTACK_sybilSplitDoesNotManufactureQuorum() public {
        address sybilA = makeAddr("sybilA");
        address sybilB = makeAddr("sybilB");
        // Two fresh seats at the vault minimum — enough to be members, nowhere near quorum.
        address[2] memory sybils = [sybilA, sybilB];
        for (uint256 i; i < 2; ++i) {
            usdc.mint(sybils[i], 10_000 * USDC_1);
            vm.startPrank(sybils[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(10 * USDC_1);
            vault.skipWindow();
            vm.stopPrank();
        }
        // TWO delegators, not one. With a single crank the pre-fix tally reaches only 1020e18
        // against a 1255e18 quorum, so this test PASSED WITH THE DEFECT FULLY RESTORED -- vacuous,
        // and vacuous on the assertion that carries the whole design argument for a stake rule over
        // a two-revealer floor. Two cranks reach 2020e18, over quorum and still inside the 2008e18
        // received cap, so the pre-fix path genuinely passes and the post-fix path genuinely does not.
        vm.prank(bob);
        gov.setDelegate(address(vault), sybilA);
        vm.prank(carol);
        gov.setDelegate(address(vault), sybilA);
        skip(1);

        uint256 pid = _propose();
        _commit(pid, sybilA, true);
        _commit(pid, sybilB, true);
        _revealPhase(pid);
        _reveal(pid, sybilA, true);
        _reveal(pid, sybilB, true);
        vm.prank(stranger);
        gov.revealDelegated(pid, bob);
        vm.prank(stranger);
        gov.revealDelegated(pid, carol);

        // THE CLAIM FIRST, so a mutation reds on the outcome and not on a diagnostic read.
        assertEq(uint8(_finalize(pid)), uint8(Governance.Status.Defeated), "stake quorum is not Sybil-able");

        (uint256 snap,, uint256 forW,, uint256 revealedW, uint256 voters) = _tally(pid);
        assertEq(voters, 2, "TWO distinct revealers: a head-count floor would be satisfied here");
        assertLt(revealedW * 10_000, 2_500 * snap, "their own stake is nowhere near quorum");
        // NON-VACUITY, stated as an assertion rather than trusted: the tally DID cross quorum, so a
        // rule that counted cranked weight would have passed this. That is what makes the Defeated
        // above evidence for the stake rule rather than an accident of the fixture.
        assertGe(forW * 10_000, 2_500 * snap, "the pre-fix numerator would have cleared quorum here");
    }

    /// BRANCH 1 (`headMajorityWithStake`), which r1 hardened and left with ZERO coverage: r1's own
    /// comment in `finalize` called the term "reachable, not demonstrated ... consistency hardening",
    /// the reviewer demonstrated it, and that comment has since been replaced by one naming THIS test
    /// -- so do not go looking for the quoted wording in Governance.sol. Mutating the branch-1
    /// subtraction back to raw `p.forWeight` survived the entire forge suite until this test existed,
    /// and reds here now.
    ///
    /// The gap is exactly the one the code names: `_boundedWeight` is `min(snapshot, current)`, so a
    /// POST-SNAPSHOT EXIT shrinks a member's contribution while `snapshotTotal` stays fixed, leaving
    /// weight accounted to neither side. That is what lets a head majority coexist with a FOR side
    /// under 50%, which is the condition under which branch 1 can pass while branch 2 cannot -- and
    /// therefore the only shape where the branch-1 term is load-bearing.
    ///
    /// 4 members at 100/100/100/1700. Quorum 2500bps of 2000e18 = 500e18. Three self-reveals are
    /// 300e18, short of it. dave settles out to 300 USDC during the commit phase, so his cranked
    /// weight is 300e18 (and fits the 800e18 received cap, which his full 1700e18 would not).
    /// Pre-fix `forWeight` 600e18 clears 500e18 and branch 1 passes; `forWeight * 2 = 1200e18` does
    /// NOT exceed 2000e18, so branch 2 is false and cannot be what carried it.
    function test_ATTACK_subFive_branchOne_isNotCarriedByCrankedWeight() public {
        VaultCore v2 = new VaultCore(
            address(usdc),
            new address[](0),
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
        gov.registerVault(address(v2), _cfg());

        address[4] memory who = [creator, alice, bob, dave];
        uint256[4] memory amt = [uint256(100), 100, 100, 1_700];
        for (uint256 i; i < 4; ++i) {
            vm.startPrank(who[i]);
            usdc.approve(address(v2), type(uint256).max);
            v2.deposit(amt[i] * USDC_1);
            v2.skipWindow();
            vm.stopPrank();
        }
        vm.prank(dave);
        gov.setDelegate(address(v2), creator);
        skip(1);

        vm.prank(creator);
        uint256 pid = gov.propose(address(v2), Governance.ProposalType.Rebalance, keccak256(""));
        (,,,,,,,,,, uint256 snap, uint256 members,,,,) = gov.proposals(pid);
        assertEq(members, 4, "sub-five regime");
        assertEq(snap, 2_000 * USDC_1 * 1e12, "snapshotTotal is fixed at creation");

        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            gov.commitVote(pid, keccak256(abi.encode(pid, who[i], true, SALT)));
        }
        // dave leaves most of his stake DURING the commit phase: the weight that goes unaccounted.
        // Read BEFORE the prank: `vm.prank` applies to the next call, and a view call consumes it --
        // which sent the requestExit from the test contract and reverted InsufficientShares.
        uint256 daveExit = v2.sharesOf(dave) * 1_400 / 1_700;
        vm.prank(dave);
        v2.requestExit(daveExit);

        _revealPhase(pid);
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            gov.revealVote(pid, true, SALT);
        }
        vm.prank(stranger);
        gov.revealDelegated(pid, dave);

        assertEq(
            uint8(_finalize(pid)),
            uint8(Governance.Status.Defeated),
            "branch 1 must not be carried by a crank"
        );

        (,,,,,,,,,,,, uint256 forW, uint256 againstW, uint256 revealedW, uint256 voters) = gov.proposals(pid);
        uint256 cranked = gov.delegatedForWeight(pid);
        assertEq(voters, 3, "a head majority of 4 members DID reveal -- branch 1's head gate is satisfied");
        assertTrue(voters * 2 > members, "so the head gate is not what defeats this");
        assertGt(cranked, 0, "a crank landed, or this test proves nothing");
        // Branch 2 cannot be what carried it: the FOR side is under half the snapshot either way.
        assertFalse(forW * 2 > snap, "branch 2 (forStakeMajority) is false with AND without the crank");
        // Pre-fix branch 1 would have passed; the self-directed term does not.
        assertGe(forW * 10_000, 2_500 * snap, "the raw forWeight numerator clears branch 1's stake gate");
        assertLt((forW - cranked) * 10_000, 2_500 * snap, "self-directed FOR does not");
        // And the weight neither side accounts for is what makes this shape reachable at all. Both
        // sides SUMMED must fall short of the snapshot -- `forW < snap` alone is implied by branch 2
        // being false above and would assert nothing new here.
        assertLt(forW + againstW, snap, "some snapshot weight is accounted to neither side");
        assertGt(revealedW, 0, "and the self-revealed figure is real, not an empty tally");
    }

    // ═════════════════ the legitimate paths, which must still work ═════════════════

    function test_twoMembersSelfRevealingStillPasses() public {
        uint256 pid = _propose();
        _commit(pid, alice, true);
        _commit(pid, bob, true);
        _revealPhase(pid);
        _reveal(pid, alice, true);
        _reveal(pid, bob, true);

        (uint256 snap,,,, uint256 revealedW,) = _tally(pid);
        assertGe(revealedW * 10_000, 2_500 * snap, "two members clear the 2500bps quorum");
        assertEq(uint8(_finalize(pid)), uint8(Governance.Status.Passed), "genuine participation passes");
    }

    function test_subFiveHeadMajorityStillPasses() public {
        _shrinkToThree();
        uint256 pid = _propose();
        _commit(pid, creator, true);
        _commit(pid, alice, true);
        _revealPhase(pid);
        _reveal(pid, creator, true);
        _reveal(pid, alice, true);
        assertEq(uint8(_finalize(pid)), uint8(Governance.Status.Passed), "2 of 3 signers still pass");
    }

    /// THE HALF THAT DOES NOT CHANGE. Standing defaults still carry the sub-five FOR-majority branch
    /// with zero live reveals — the Audit Council accepted that explicitly, and a default is the
    /// member's own direction rather than a delegate's.
    function test_defaultsStillCarrySubFiveWithZeroLiveReveals() public {
        _shrinkToThree();
        vm.prank(creator);
        gov.setStandingDefault(address(vault), true);
        vm.prank(alice);
        gov.setStandingDefault(address(vault), true);
        skip(1); // a default must pre-date the proposal (F4)

        uint256 pid = _propose();
        _revealPhase(pid);
        gov.applyStandingDefault(pid, creator);
        gov.applyStandingDefault(pid, alice);

        (uint256 snap,, uint256 forW,,, uint256 voters) = _tally(pid);
        assertEq(voters, 0, "zero live reveals");
        assertEq(gov.delegatedForWeight(pid), 0, "no cranked weight - defaults are not delegations");
        assertTrue(forW * 2 > snap, ">50% pre-declared FOR mandate");
        assertEq(uint8(_finalize(pid)), uint8(Governance.Status.Passed), "a default majority is a mandate");
    }

    /// The `support` field on `DelegatedRevealed`, pinned in SOLIDITY.
    ///
    /// The field exists because the indexer branched on `args.support` while the event did not carry
    /// it, so every cranked delegation was booked AGAINST whichever way the delegate voted. Adding
    /// the field fixed the projection -- and nothing on this side pinned it: emitting `!support`
    /// left the WHOLE Solidity suite green, so the contract could start lying and only a hand-written
    /// JS fixture would notice. `expectEmit` is the convention here (4 sites repo-wide).
    function test_delegatedRevealedCarriesTheDirectionItApplied() public {
        vm.prank(carol);
        gov.setDelegate(address(vault), alice);
        vm.prank(dave);
        gov.setDelegate(address(vault), bob);

        uint256 pid = _propose();
        _commit(pid, alice, true);
        _commit(pid, bob, false);
        _revealPhase(pid);
        _reveal(pid, alice, true);
        _reveal(pid, bob, false);

        // Both directions, because a mutation to `!support` has to red on one of them whichever way
        // a single-direction test happened to point.
        vm.expectEmit(true, true, true, true, address(gov));
        emit Governance.DelegatedRevealed(pid, carol, alice, true, ONE_MEMBER);
        vm.prank(stranger);
        gov.revealDelegated(pid, carol);

        vm.expectEmit(true, true, true, true, address(gov));
        emit Governance.DelegatedRevealed(pid, dave, bob, false, ONE_MEMBER);
        vm.prank(stranger);
        gov.revealDelegated(pid, dave);

        // And the tally agrees with what was emitted, so the event cannot drift from the state.
        (,, uint256 forW, uint256 againstW,,) = _tally(pid);
        assertEq(forW, 2 * ONE_MEMBER, "alice + carol");
        assertEq(againstW, 2 * ONE_MEMBER, "bob + dave");
        assertEq(gov.delegatedForWeight(pid), ONE_MEMBER, "only carol's crank is on the FOR side");
    }

    /// Delegation still does the job it is sold for: it changes WHICH WAY a proposal goes.
    function test_cranksStillDecideDirection() public {
        vm.prank(carol);
        gov.setDelegate(address(vault), bob);

        uint256 pid = _propose();
        _commit(pid, alice, true);
        _commit(pid, bob, false);
        _revealPhase(pid);
        _reveal(pid, alice, true);
        _reveal(pid, bob, false);
        // Quorum is already met by alice + bob (2000e18 >= 1250e18). Carol's delegated weight is
        // what flips the OUTCOME: 1000 FOR vs 2000 AGAINST.
        vm.prank(stranger);
        gov.revealDelegated(pid, carol);

        (uint256 snap,, uint256 forW, uint256 againstW, uint256 revealedW,) = _tally(pid);
        assertGe(revealedW * 10_000, 2_500 * snap, "quorum from the two self-reveals alone");
        assertEq(forW, ONE_MEMBER);
        assertEq(againstW, 2 * ONE_MEMBER, "carol's weight follows bob");
        assertEq(uint8(_finalize(pid)), uint8(Governance.Status.Defeated), "the crank decided this");
    }

    function test_concentrationCapStillBindsReceivedWeight() public {
        address[3] memory who = [bob, carol, dave];
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            gov.setDelegate(address(vault), alice);
        }
        uint256 pid = _propose();
        _commit(pid, alice, true);
        _revealPhase(pid);
        _reveal(pid, alice, true);
        vm.prank(stranger);
        gov.revealDelegated(pid, bob);
        vm.prank(stranger);
        gov.revealDelegated(pid, carol); // received 2000e18 — exactly at the 4000bps cap
        vm.prank(stranger);
        vm.expectRevert(Governance.ConcentrationCap.selector);
        gov.revealDelegated(pid, dave);
    }
}
