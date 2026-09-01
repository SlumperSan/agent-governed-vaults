// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {MockERC20, MockOracle, StubGovernance, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

/// @notice AUDIT ARTIFACT — pins two operator-facing consequences of the creator 5% withdrawal
/// gate that the code does not state and that `docs/NOW.md`'s trap list did not mention until
/// this file. Both are BY DESIGN (CM-1/CM-2): the gate binds creator ACTION while non-creator
/// members remain, and nothing re-checks the creator's fraction when others deposit. The
/// numbers below are Finance's (`Operator Capital Requirement.md`, 2026-08-29), cited not
/// re-derived: 5% (`CREATOR_MIN_STAKE_BPS = 500`), the 95% point of no return, and "$2,500 at
/// a 50k cap".
///
///  A. **The withdrawal-gate trap.** `_checkCreatorGate` requires
///     `(s - b) * 10_000 >= 500 * (T - b)`. For `s/T < 5%` the fraction `(s-b)/(T-b)` is
///     strictly DECREASING in `b`, so EVERY burn amount fails: a diluted creator cannot
///     withdraw even one share while a non-creator member remains. Dilution is passive (member
///     deposits grow `totalShares`), so the creator can arrive here without acting. They have
///     simultaneously lost proposal rights (the trap NOW.md already listed) and had their
///     remaining capital frozen (the trap it did not).
///
///  B. **The cap-race lockout.** `_deposit` enforces `nav + pending + amount <= capacityCapUsdc`
///     for the creator too. Once external fill `E > 0.95 * C`, even filling the vault to cap
///     leaves the creator at `K = C - E < 0.05 * C`: a top-up by deposit can never restore 5%.
///     At the 50k cap that is "once outsiders hold > $47,500". Recovery is a member exit or an
///     NAV drawdown reopening headroom; only the member-exit path is pinned here (an all-USDC
///     vault has no price to drop). The note's practical rule: seed the full 5%-of-cap from
///     day one ($2,500 at 50k) so the race never starts.
///
///  C. **L-1 corollary.** A Mode-F exit that passed the gate at QUEUE time is not re-gated at
///     settle (`_settleExit(.., fromQueue = true)`), even if members joined in between and the
///     creator is by then below 5%. Deliberate: re-checking could strand an un-cancellable
///     queued exit. The trap re-engages on the NEXT request. Not pinned elsewhere: the only
///     other `CreatorStakeGate` assertion in the suite is `VaultCore.t.sol`
///     `test_creatorCannotExitBelow5PctWhileMembersRemain`.
///
/// A floor on live stake was implemented, measured, and reverted (`AuditProposalThresholdFloor`)
/// because a constructor cannot observe live stake distribution. This file records the
/// consequence, not a defect. Nothing in `contracts/src` changes.
contract AuditCreatorGateTrapsTest is Test {
    uint256 constant USDC_1 = 1e6;
    uint256 constant WAD_PER_USDC = 1e12; // usdcScalar for a 6-decimal USDC
    uint256 constant BPS = 10_000;
    uint256 constant GATE_BPS = 500; // == VaultCore.CREATOR_MIN_STAKE_BPS
    uint256 constant CAP = 50_000 * USDC_1; // Finance's worked example: the 50k cap

    MockERC20 usdc;
    MockOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();

        // All-USDC basket: share fraction == value fraction exactly, no oracle in the way.
        vault = new VaultCore(
            address(usdc),
            new address[](0),
            creator,
            registry,
            gov,
            fees,
            oracle,
            CAP,
            10 * USDC_1, // min deposit
            0, // no exit fee, so the share arithmetic IS the note's arithmetic
            0,
            new address[](0),
            address(0)
        );
        assertEq(vault.CREATOR_MIN_STAKE_BPS(), GATE_BPS, "gate constant is the note's 5%");

        for (uint160 i; i < 3; ++i) {
            address who = [creator, alice, bob][i];
            usdc.mint(who, 1_000_000 * USDC_1);
            vm.prank(who);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /// First deposit enters the 4h observation window; activate it.
    function _join(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount);
        skip(4 hours);
        vault.activate(who);
    }

    /// Repeat deposits mint immediately (the top-up path).
    function _topUp(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount);
    }

    function _navUsdc() internal view returns (uint256) {
        return vault.navWad() / WAD_PER_USDC;
    }

    function _creatorBps() internal view returns (uint256) {
        return vault.sharesOf(creator) * BPS / vault.totalShares();
    }

    /// The gate's own inequality, evaluated off-chain for a hypothetical burn.
    function _gatePasses(uint256 burn) internal view returns (bool) {
        return (vault.sharesOf(creator) - burn) * BPS >= GATE_BPS * (vault.totalShares() - burn);
    }

    /// Largest burn that still satisfies the gate (only meaningful at or above 5%).
    function _maxBurn() internal view returns (uint256) {
        uint256 c = vault.sharesOf(creator);
        uint256 t = vault.totalShares();
        return (c * BPS - GATE_BPS * t) / (BPS - GATE_BPS);
    }

    function _expectGate(uint256 burn) internal {
        vm.prank(creator);
        vm.expectRevert(VaultCore.CreatorStakeGate.selector);
        vault.requestExit(burn);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // A — below 5%, no burn amount passes: the diluted creator is frozen
    // ─────────────────────────────────────────────────────────────────────────

    /// The note's timeline, steps 1-3: seed $500 into a fresh 50k-cap vault, members deposit
    /// $12,000, the creator is at 4.0% and cannot withdraw one share.
    function test_A_dilutedCreatorCannotWithdrawAnyShares() public {
        _join(creator, 500 * USDC_1);
        _join(alice, 12_000 * USDC_1);

        assertEq(vault.nonCreatorMemberCount(), 1, "a non-creator member remains");
        assertEq(_creatorBps(), 400, "4.0%: diluted passively, the creator did nothing");

        uint256 s = vault.sharesOf(creator);
        _expectGate(1); // one share
        _expectGate(s / 2); // half
        _expectGate(s); // everything

        // The reason: for s/T < 5% the post-burn fraction only falls as the burn grows.
        for (uint256 b = 1; b <= s; b += s / 7) {
            assertFalse(_gatePasses(b), "no burn amount satisfies the gate below 5%");
        }
    }

    /// Below 5% is a plateau, not a cliff: EXACTLY 5% also admits no withdrawal, because any
    /// burn takes the fraction below. The boundary case above 5% is `VaultCore.t.sol`
    /// `test_creatorCanExitPartiallyDownTo5Pct`.
    function test_A_exactlyFivePercentAdmitsNoBurn() public {
        _join(creator, 2_500 * USDC_1);
        _join(alice, 47_500 * USDC_1); // the vault is now full: 2,500 / 50,000
        assertEq(_creatorBps(), GATE_BPS, "exactly 5%");
        assertEq(_maxBurn(), 0, "the gate admits a burn of zero");
        _expectGate(1);
    }

    /// Timeline step 4: a $250 top-up restores ~5.9% of $12,750 and unfreezes withdrawals,
    /// but only down to the floor, and only while cap headroom exists (see B).
    function test_A_topUpRestoresWithdrawalDownToTheFloor() public {
        _join(creator, 500 * USDC_1);
        _join(alice, 12_000 * USDC_1);
        _topUp(creator, 250 * USDC_1);
        assertEq(_creatorBps(), 588, "750 / 12,750 = 5.88%");

        uint256 maxBurn = _maxBurn();
        assertGt(maxBurn, 0);
        _expectGate(maxBurn + 1);
        vm.prank(creator);
        vault.requestExit(maxBurn);
        assertGe(_creatorBps(), GATE_BPS, "back at the floor, not through it");
        _expectGate(1); // and now frozen again, at exactly the floor
    }

    /// Capital is locked, not spent: each member exit raises the creator's fraction passively,
    /// and once every non-creator member has left the gate no longer binds at all.
    function test_A_creatorRecoversEverythingOnceMembersAreGone() public {
        _join(creator, 500 * USDC_1);
        _join(alice, 12_000 * USDC_1);
        _join(bob, 3_000 * USDC_1);
        assertLt(_creatorBps(), GATE_BPS, "500 / 15,500 = 3.2%");
        _expectGate(1);

        uint256 aliceShares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(aliceShares);
        assertEq(vault.nonCreatorMemberCount(), 1, "bob remains");
        assertGt(_creatorBps(), GATE_BPS, "500 / 3,500 = 14.3%: unfrozen by alice leaving");
        _expectGate(vault.sharesOf(creator)); // a FULL exit is still gated while bob remains

        uint256 bobShares = vault.sharesOf(bob);
        vm.prank(bob);
        vault.requestExit(bobShares);
        assertEq(vault.nonCreatorMemberCount(), 0, "no non-creator member remains");

        uint256 creatorShares = vault.sharesOf(creator);
        vm.prank(creator);
        vault.requestExit(creatorShares);
        assertEq(vault.totalShares(), 0, "creator recovered everything");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // B — the cap race: external fill > 95% of cap makes 5% unreachable by deposit
    // ─────────────────────────────────────────────────────────────────────────

    /// External fill E > 0.95 * C  =>  max K = C - E < 0.05 * C. At the 50k cap: outsiders at
    /// $47,600 leave $1,900 of headroom; the creator's $500 seed + $1,900 = $2,400 < $2,500.
    function test_B_pastNinetyFivePercentFillTopUpCannotReachFivePercent() public {
        _join(creator, 500 * USDC_1);
        _join(alice, 47_600 * USDC_1); // E = 47,600 > 0.95 * 50,000 = 47,500

        uint256 headroom = CAP - _navUsdc();
        assertEq(headroom, 1_900 * USDC_1, "what is left under the cap");
        uint256 fivePctOfCap = CAP * GATE_BPS / BPS;
        assertEq(fivePctOfCap, 2_500 * USDC_1, "the note's $2,500 at 50k");
        assertLt(500 * USDC_1 + headroom, fivePctOfCap, "seed + ALL headroom < $2,500");

        _topUp(creator, headroom); // fill the vault to cap
        assertEq(_navUsdc(), CAP, "vault is at cap");
        assertEq(vault.sharesOf(creator), 2_400 * USDC_1 * WAD_PER_USDC, "K = C - E = $2,400");
        assertEq(_creatorBps(), 480, "4.8%: still below the gate");

        // No more deposits from anyone, creator included.
        vm.prank(creator);
        vm.expectRevert(VaultCore.CapacityExceeded.selector);
        vault.deposit(10 * USDC_1);

        // And nothing can be withdrawn either (A). Point of no return.
        _expectGate(1);
    }

    /// Below the point of no return the race is still winnable: at E = $47,000 the note's
    /// requirement is K >= E / 19 = $2,473.68, and the $2,500 of headroom covers it.
    function test_B_belowNinetyFivePercentTopUpStillReachesFivePercent() public {
        _join(creator, 500 * USDC_1);
        _join(alice, 47_000 * USDC_1); // E = 47,000 < 47,500

        assertEq(CAP - _navUsdc(), 2_500 * USDC_1, "headroom");
        _topUp(creator, 2_000 * USDC_1); // to $2,500, leaving $500 of headroom
        assertEq(_creatorBps(), 505, "2,500 / 49,500 = 5.05%: back above the gate");
        assertGe(vault.sharesOf(creator) * 19, vault.totalShares() - vault.sharesOf(creator), "K >= E / 19");
        vm.prank(creator);
        vault.requestExit(1); // and no longer frozen
    }

    /// Recovery path (a) from the note: a member exit burns shares, raising the creator's
    /// fraction passively, AND reopens cap headroom for a top-up.
    function test_B_memberExitReopensTheRace() public {
        _join(creator, 500 * USDC_1);
        _join(alice, 47_600 * USDC_1);
        _topUp(creator, 1_900 * USDC_1); // locked at $2,400 / $50,000 (previous test)
        assertLt(_creatorBps(), GATE_BPS);

        vm.prank(alice);
        vault.requestExit(4_000 * USDC_1 * WAD_PER_USDC); // alice: 47,600 -> 43,600
        // 2,400 / 46,000 = 5.2%: passively back above the floor, and $4,000 of headroom is back.
        assertGt(_creatorBps(), GATE_BPS, "member exit raised the creator's fraction");
        assertEq(CAP - _navUsdc(), 4_000 * USDC_1, "headroom reopened");
        _topUp(creator, 100 * USDC_1); // deposits work again
        vm.prank(creator);
        vault.requestExit(1); // and so do withdrawals
    }

    /// The note's practical rule: seed the full 5%-of-cap on day one and the race never
    /// starts. Outsiders fill the remaining 95% and the creator sits at exactly 5%.
    function test_B_seedingFivePercentOfCapRemovesTheRace() public {
        _join(creator, 2_500 * USDC_1); // $2,500 at 50k
        _join(alice, 40_000 * USDC_1);
        _join(bob, 7_500 * USDC_1);
        assertEq(_navUsdc(), CAP, "full");
        assertEq(_creatorBps(), GATE_BPS, "5% held with no top-up and no monitoring");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // C — L-1: gated at queue time, not at settle; the trap re-engages on the next request
    // ─────────────────────────────────────────────────────────────────────────

    function test_C_queuedModeFExitIsNotRegatedAtSettle() public {
        _join(creator, 1_000 * USDC_1);
        _join(alice, 9_000 * USDC_1); // creator 10%
        uint256 maxBurn = _maxBurn();

        gov.setPendingExecution(true); // Mode F
        vm.prank(creator);
        vault.requestExit(maxBurn); // passes the gate at queue time
        assertEq(vault.queuedExitShares(creator), maxBurn);

        // Members join with on-chain notice of the queue; the creator is now far below 5%.
        _join(bob, 40_000 * USDC_1);
        assertFalse(_gatePasses(maxBurn), "the same burn would fail the gate NOW");

        gov.setPendingExecution(false);
        vault.settleQueuedExit(creator); // not re-gated: settles anyway
        assertEq(vault.queuedExitShares(creator), 0, "queued exit settled");
        assertLt(_creatorBps(), GATE_BPS, "and the creator is below 5% afterwards");

        // The trap re-engages on the very next request, in either mode.
        _expectGate(1); // Mode I
        gov.setPendingExecution(true);
        _expectGate(1); // Mode F: evaluated at queue time, so nothing is stranded
        assertEq(vault.queuedExitShares(creator), 0, "no stranded queue");
    }
}
