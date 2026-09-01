// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {Governance} from "../../src/Governance.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

/// @notice AUDIT ARTIFACT — pins the three `incorrect-equality` invariants that the class
/// dismissal in `docs/reviews/SLITHER-TRIAGE.md` asserted in prose and nothing executed.
///
/// Slither's `incorrect-equality` fires 13 times on `protocol/main`. All 13 were triaged row by
/// row (see the table in SLITHER-TRIAGE.md); none is REAL. Three of the arguments are load-bearing
/// enough that they should not rest on prose alone, and each test below is chosen so that the
/// mutation which would make its row real turns it red:
///
///  1. `ts == 0` (rows 1/4/9/11 — `navPerShareWad:377`, `convertToAssets:1086`, `_mintShares:480`,
///     `convertToShares:1079`). The classic ERC-4626 inflation attack needs a NAV a donor can move.
///     `navWad()` reads only internal accounting (EE-1), so donation is inert — and the reverse
///     shape, `totalShares == 0` with residual NAV, is unreachable because the last exiter is by
///     construction the sole holder, whose pro-rata legs are exact identities. Mutating `navWad`
///     to read `balanceOf`, or the exit legs to leave residue, turns these red.
///  2. `Checkpoints.push`'s same-second overwrite (row 7, `src/lib/Checkpoints.sol:23`). This is
///     deliberately a Governance-LEVEL test, not a `Checkpoints` unit test: the property that
///     matters is the composition with `propose`'s `nowTs - 1` read (VO-9). Mutating `nowTs - 1`
///     to `nowTs` turns it red; a `Checkpoints` unit test would not notice.
///  3. `_isSettled` (row 2, `src/Governance.sol:613`). The real question is not whether the enum
///     is exhaustive but whether a proposal can sit non-settled forever and freeze `propose` —
///     the DoS documented at `Governance.sol:57-67`. `finalize` is permissionless and makes no
///     external call, so `Active` always escapes.
contract AuditIncorrectEqualityRowsTest is Test {
    uint256 constant USDC_1 = 1e6;
    uint256 constant SCALAR = 1e12; // 1e18 / 1e6
    bytes32 constant SALT = keccak256("t2-salt");

    MockERC20 usdc;
    MockOracle oracle;
    StubFeeEngine fees;
    StubRegistry registry;
    Governance gov;
    VaultCore vault; // fee-free vault, registered with governance (rows 2 and 7)

    address creator = makeAddr("creator");
    address honest = makeAddr("honest");
    address attacker = makeAddr("attacker");
    address stranger = makeAddr("stranger"); // never a member, never registered

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function _cfg() internal pure returns (Governance.GovConfig memory) {
        return Governance.GovConfig({
            commitDuration: 6 hours,
            revealDuration: 6 hours,
            timelockDuration: 1 days,
            executionWindow: 2 days,
            quorumBps: 2_500,
            proposalThresholdBps: 500,
            concentrationCapBps: 5_000,
            proposalCooldown: 1 hours
        });
    }

    function _deployVault(uint256 exitFeeMaxBps, uint256 decayPeriod) internal returns (VaultCore v) {
        v = _deployVault(exitFeeMaxBps, decayPeriod, 10 * USDC_1);
    }

    function _deployVault(uint256 exitFeeMaxBps, uint256 decayPeriod, uint256 minDepositUsdc)
        internal
        returns (VaultCore v)
    {
        v = new VaultCore(
            address(usdc),
            new address[](0),
            creator,
            registry,
            gov,
            fees,
            oracle,
            1_000_000_000 * USDC_1,
            minDepositUsdc,
            exitFeeMaxBps,
            decayPeriod,
            new address[](0),
            address(0)
        );
    }

    function _fund(address who, uint256 amountUsdc) internal {
        usdc.mint(who, amountUsdc);
    }

    /// @dev Deposit and mint immediately (skipWindow is permissionless and unconditional).
    function _joinAndMint(VaultCore v, address who, uint256 amountUsdc) internal {
        vm.startPrank(who);
        usdc.approve(address(v), type(uint256).max);
        v.skipWindow();
        v.deposit(amountUsdc);
        vm.stopPrank();
    }

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        fees = new StubFeeEngine();
        registry = new StubRegistry();
        gov = new Governance();

        vault = _deployVault(0, 0);
        vm.prank(creator);
        gov.registerVault(address(vault), _cfg());

        _fund(honest, 100_000_000 * USDC_1);
        _fund(attacker, 100_000_000 * USDC_1);
        _fund(alice, 100_000_000 * USDC_1);
        _fund(bob, 100_000_000 * USDC_1);
        _fund(carol, 100_000_000 * USDC_1);

        _joinAndMint(vault, honest, 1_000 * USDC_1);
        skip(1);
    }

    // ─────────── rows 1 / 4 / 9 / 11 — `ts == 0`, and EE-1 checked per row ───────────

    /// @notice EE-1, executed rather than cited. A direct token donation moves NOTHING that any
    /// of the four `ts == 0` rows compares, and cannot dilute the next mint.
    ///
    /// This is the discriminating half: the donation happens while `totalShares > 0`, so if
    /// `navWad()` read `usdc.balanceOf(address(this))` instead of `idleUsdc`, bob's mint would be
    /// diluted by 6x and both assertions below would fail. In the `ts == 0` branch itself a
    /// donation is invisible either way, which is exactly why the branch has to be argued with a
    /// nonzero supply.
    function test_donationCannotMoveNavOrDiluteTheNextMint() public {
        VaultCore v = _deployVault(0, 0);
        _joinAndMint(v, alice, 1_000 * USDC_1);

        uint256 aliceShares = v.sharesOf(alice);
        assertEq(aliceShares, 1_000 * USDC_1 * SCALAR, "first mint is 1:1 through the ts==0 branch");
        assertEq(v.navWad(), 1_000 * USDC_1 * SCALAR, "NAV is the accounted deposit");

        // Donate 5x the vault's whole size, straight to the contract, bypassing `deposit`.
        vm.prank(carol);
        usdc.transfer(address(v), 5_000 * USDC_1);

        assertEq(usdc.balanceOf(address(v)), 6_000 * USDC_1, "the tokens really are there");
        assertEq(v.navWad(), 1_000 * USDC_1 * SCALAR, "NAV never reads balanceOf (EE-1)");
        assertEq(v.idleUsdc(), 1_000 * USDC_1, "and neither does the accounting");
        assertEq(v.navPerShareWad(), 1e18, "NAVps unmoved by the donation");

        // The next depositor is priced off internal NAV, so they are not diluted.
        _joinAndMint(v, bob, 1_000 * USDC_1);
        assertEq(v.sharesOf(bob), aliceShares, "equal deposits mint equal shares despite the donation");
    }

    /// @notice The reverse shape, which is the one the `ts == 0` branch actually depends on:
    /// `totalShares` can only reach 0 through the sole-holder exit, and that exit is EXACT.
    ///
    /// `memberShares == ts` (row 13) makes `feeBps = 0`, so `keepBps = BPS` and `burnKeep == tsBps`
    /// — both pro-rata legs collapse to identities (`VaultCore.sol:626-632`, `:649`) and nothing is
    /// floored away. The vault therefore never reaches `totalShares == 0` while still holding NAV,
    /// which is what makes the 1:1 re-open at `_mintShares:480` and the `WAD` answer at
    /// `navPerShareWad:377` correct rather than merely conventional.
    ///
    /// Also pins row 13 in the direction that matters: the sole holder pays no exit fee, so the
    /// fee cannot be stranded in a vault with zero shares (EE-8/EE-9).
    function test_soleHolderExitDrainsExactlyAndTheTsZeroBranchReopensClean() public {
        VaultCore v = _deployVault(100, 30 days); // 1% exit fee, the protocol cap
        _joinAndMint(v, alice, 1_000 * USDC_1);
        _joinAndMint(v, bob, 1_000 * USDC_1);

        // bob exits first and is NOT the sole holder: he pays the fee, which stays in the vault.
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 bobShares = v.sharesOf(bob); // read BEFORE the prank — vm.prank binds the next call
        vm.prank(bob);
        v.requestExit(bobShares);
        uint256 bobPaid = usdc.balanceOf(bob) - bobBefore;
        assertLt(bobPaid, 1_000 * USDC_1, "non-sole holder pays the exit fee");
        assertEq(v.holderCount(), 1, "alice is now the sole holder");
        assertGt(v.navPerShareWad(), 1e18, "the forfeited fee accrued to the remaining member");

        // alice exits as the SOLE holder: memberShares == ts, so the waiver fires and the legs
        // are exact identities.
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 navBefore = v.navWad();
        uint256 aliceShares = v.sharesOf(alice);
        assertEq(aliceShares, v.totalShares(), "row 13's comparand: alice IS the whole supply");
        vm.prank(alice);
        v.requestExit(aliceShares);

        assertEq(usdc.balanceOf(alice) - aliceBefore, navBefore / SCALAR, "sole holder takes the whole NAV");
        assertEq(
            usdc.balanceOf(alice) - aliceBefore, 2_000 * USDC_1 - bobPaid, "including bob's forfeited fee"
        );

        // THE POINT: zero shares and zero NAV, together. No residue for a `ts == 0` branch to
        // hand away, and nothing stranded.
        assertEq(v.totalShares(), 0, "supply fully burned");
        assertEq(v.idleUsdc(), 0, "idle accounting fully drained");
        assertEq(v.navWad(), 0, "NAV is exactly zero, not dust");
        assertEq(v.holderCount(), 0, "and no holders remain");
        assertEq(v.navPerShareWad(), 1e18, "navPerShareWad:377 returns WAD on an empty vault");

        // Rows 4 and 11: the two indicative 4626-shaped views take their OWN `ts == 0` branch
        // here, and it is the same invariant — with no NAV left, both collapse to the pure
        // decimal scaling, with no `navWad()` term to be wrong about.
        assertEq(v.convertToShares(1_000 * USDC_1), 1_000 * USDC_1 * SCALAR, "convertToShares:1079 ts==0 leg");
        assertEq(v.convertToAssets(1_000 * USDC_1 * SCALAR), 1_000 * USDC_1, "convertToAssets:1086 ts==0 leg");

        // Re-opening therefore prices at 1:1 against a genuinely empty vault, not against residue.
        _joinAndMint(v, carol, 1_000 * USDC_1);
        assertEq(v.sharesOf(carol), 1_000 * USDC_1 * SCALAR, "_mintShares:480 re-opens at 1:1");
        assertEq(v.navPerShareWad(), 1e18, "and NAVps is back at par");

        // And with supply back, both views leave the `ts == 0` branch and agree with it at par —
        // which is what makes the branch a continuation of the formula rather than a special case.
        assertEq(v.convertToShares(1_000 * USDC_1), 1_000 * USDC_1 * SCALAR, "convertToShares agrees at par");
        assertEq(v.convertToAssets(1_000 * USDC_1 * SCALAR), 1_000 * USDC_1, "convertToAssets agrees at par");
    }

    // ─────────── row 7 — `Checkpoints.push` same-second overwrite ───────────

    /// @notice The same-second overwrite cannot backfill weight onto a proposal created in that
    /// same second, and it does not lose the second's final value for later readers.
    ///
    /// Three writes land in ONE second `T`: a deposit (appends a checkpoint at `T`), the
    /// `propose` call (`createdAt == T`), and a second deposit (OVERWRITES the checkpoint at `T`,
    /// `Checkpoints.sol:23-24`). The vote's weight is read at `createdAt - 1`
    /// (`Governance._boundedWeight:338`), and the quorum denominators at `nowTs - 1`
    /// (`Governance.propose:287`, `:288`, `:304`) — all strictly before any of the three writes.
    ///
    /// Mutations that turn this red, both verified:
    ///   - `p.createdAt - 1` -> `p.createdAt` in `Governance._boundedWeight` (`:338`), the read
    ///     that actually prices a vote: `9000e18 != 1000e18`.
    ///   - `Checkpoints.push:23` `==` -> `<=` (always overwrite): `9000e18 != 1000e18` on
    ///     assertion (a), so this test discriminates on the `Checkpoints` side too.
    ///
    /// Deliberately NOT claimed: mutating the three `nowTs - 1` reads in `Governance.propose`
    /// (`:287`, `:288`, `:304`) leaves this test GREEN. Those feed `snapshotTotal` and
    /// `memberCount` (the quorum denominators), which this test never reads — it asserts on the
    /// FOR-weight, which comes from `_boundedWeight`. An earlier revision of this comment named
    /// that mutation; it was wrong, and PR #106's review caught it.
    function test_sameSecondCheckpointCannotBackfillProposalWeight() public {
        _joinAndMint(vault, attacker, 1_000 * USDC_1);
        uint256 baseline = vault.sharesOf(attacker);
        assertGt(baseline, 0, "attacker holds a baseline position");

        skip(1); // the baseline checkpoint is now strictly in the past
        uint64 T = uint64(block.timestamp);

        // ── all three writes happen inside second T ──
        vm.prank(attacker);
        vault.deposit(4_000 * USDC_1); // push #1 at T: APPENDS a checkpoint

        vm.prank(honest);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(""));

        vm.prank(attacker);
        vault.deposit(4_000 * USDC_1); // push #2 at T: OVERWRITES the checkpoint written above

        uint256 inflated = vault.sharesOf(attacker);
        assertEq(inflated, baseline * 9, "attacker is now 9x their snapshot position");

        // (a) The overwrite is invisible to the proposal: its read is at T - 1.
        assertEq(
            vault.pastVotingEligibleShares(attacker, T - 1),
            baseline,
            "propose reads strictly before second T (VO-9)"
        );

        // (b) The overwrite kept the END-of-second-T value — it did not freeze the first write of
        //     that second, which is the half of the OZ idiom that has to be true for `getAt` to
        //     mean what its NatSpec says.
        skip(1);
        assertEq(
            vault.pastVotingEligibleShares(attacker, T), inflated, "getAt(T) is the last value in second T"
        );

        // (c) The composition, end to end: the vote carries the SNAPSHOT weight, not the
        //     same-second position. min(snapshot, current) = baseline.
        vm.prank(attacker);
        gov.commitVote(pid, keccak256(abi.encode(pid, attacker, true, SALT)));
        skip(6 hours);
        vm.prank(attacker);
        gov.revealVote(pid, true, SALT);

        assertEq(
            _forWeight(pid), baseline, "8,000 USDC deposited in the proposal's own second bought no weight"
        );
        assertLt(_forWeight(pid), inflated, "and strictly less than what they hold");
    }

    // ─────────── row 2 — `_isSettled` on the Status enum ───────────

    /// @notice `_isSettled` enumerating only Defeated/Executed/Expired is safe because every
    /// NON-settled status has a permissionless, external-call-free exit. The failure this row
    /// would represent is a permanent freeze: `_isSettled` gates `propose`
    /// (`Governance.sol:278`) and `delegate` (`:494`), so a proposal stuck `Active` would block
    /// every future proposal INCLUDING the RuleChange that would unstick it
    /// (`Governance.sol:57-67`).
    ///
    /// `finalize` (`:506-558`) reads only `p.*` and `configOf[p.vault]`, is unauthenticated, and
    /// makes no external call — so a completely abandoned proposal is always resolvable by a
    /// party with no stake and no relationship to the vault.
    function test_abandonedProposalIsAlwaysSettleableByAStrangerAndUnblocksPropose() public {
        vm.prank(honest);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(""));

        // While Active, the vault genuinely cannot legislate — this is the state that would be
        // permanent if `Active` had no exit.
        skip(1 hours);
        vm.prank(honest);
        vm.expectRevert(Governance.ProposalActive.selector);
        gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256("second"));

        // Nobody commits, nobody reveals, the proposer walks away.
        skip(12 hours); // past commitDeadline + revealDuration

        // A stranger — not a member, not the proposer, not the creator — finalizes it.
        assertEq(vault.sharesOf(stranger), 0, "stranger has no stake whatsoever");
        vm.prank(stranger);
        gov.finalize(pid);
        assertEq(uint256(_status(pid)), uint256(Governance.Status.Defeated), "no quorum => Defeated");

        // And the vault can legislate again.
        vm.prank(honest);
        uint256 pid2 = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256("second"));
        assertGt(pid2, pid, "propose is unblocked");
        assertEq(uint256(_status(pid2)), uint256(Governance.Status.Active), "and the new proposal is live");
    }

    /// @notice The other non-settled status, `Passed`, drains too: `markExpired` is permissionless
    /// and `_refreshStatus` self-heals inside `propose`. Together with the test above this covers
    /// every status `_isSettled` returns false for (`None` is unreachable — `activeProposalOf` is
    /// `!= 0`-guarded at `Governance.sol:277`).
    function test_passedButUnexecutedProposalExpiresAndUnblocksPropose() public {
        vm.prank(honest);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(""));

        vm.prank(honest);
        gov.commitVote(pid, keccak256(abi.encode(pid, honest, true, SALT)));
        skip(6 hours);
        vm.prank(honest);
        gov.revealVote(pid, true, SALT);
        skip(6 hours);
        gov.finalize(pid);
        assertEq(uint256(_status(pid)), uint256(Governance.Status.Passed), "quorum met, proposal Passed");

        // Passed is NOT settled, so it blocks propose for as long as its window is open.
        vm.prank(honest);
        vm.expectRevert(Governance.ProposalActive.selector);
        gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256("second"));

        // Let the timelock + execution window lapse without executing.
        skip(1 days + 2 days + 1);
        vm.prank(stranger);
        gov.markExpired(pid);
        assertEq(uint256(_status(pid)), uint256(Governance.Status.Expired), "window lapsed => Expired");

        vm.prank(honest);
        uint256 pid2 = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256("second"));
        assertGt(pid2, pid, "propose is unblocked");
    }

    /// @notice The third leg of `_isSettled`, `Executed`, pinned directly. The two tests above
    /// drain `Active` and `Passed`; neither ever executes a proposal, so dropping
    /// `s == Status.Executed` from `_isSettled` (`Governance.sol:613`) left them both GREEN.
    ///
    /// A `RuleChange` executes entirely inside `Governance` — no vault machinery, no adapter — so
    /// it is the cheapest honest way to reach `Executed`. Mutation that turns this red: delete
    /// `s == Status.Executed` from `_isSettled`; the final `propose` then reverts
    /// `ProposalActive`, i.e. a vault that successfully legislated once could never legislate
    /// again.
    function test_executedProposalIsSettledAndUnblocksPropose() public {
        Governance.GovConfig memory newCfg = _cfg();
        newCfg.proposalCooldown = 2 hours; // any valid change; quorumBps stays at the 25% floor
        bytes memory payload = abi.encode(newCfg);

        vm.prank(honest);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.RuleChange, keccak256(payload));

        vm.prank(honest);
        gov.commitVote(pid, keccak256(abi.encode(pid, honest, true, SALT)));
        skip(6 hours);
        vm.prank(honest);
        gov.revealVote(pid, true, SALT);
        skip(6 hours);
        gov.finalize(pid);
        assertEq(uint256(_status(pid)), uint256(Governance.Status.Passed), "quorum met, proposal Passed");

        skip(1 days); // timelock, still inside the 2-day execution window
        gov.execute(pid, payload);
        assertEq(uint256(_status(pid)), uint256(Governance.Status.Executed), "proposal is Executed");

        // THE POINT: `Executed` is settled, so the vault can legislate again. Without that leg of
        // `_isSettled` this is a permanent freeze on the first successful proposal.
        vm.prank(honest);
        uint256 pid2 = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256("after"));
        assertGt(pid2, pid, "propose is unblocked after an Executed proposal");
        assertEq(uint256(_status(pid2)), uint256(Governance.Status.Active), "and the new proposal is live");
    }

    // ─────────── row 13, the adversarial direction — EE-8's real cost structure ───────────

    /// @notice CHARACTERISATION of current behaviour, not a defect claim: the last-member exit-fee
    /// prize (THREAT-MODEL EE-8) is **stake-independent**, so "bounded at 1%, self-limiting" is
    /// true of the RATE and false of the SIZE.
    ///
    /// The triage note for row 13 used to frame the squatter's cost as `minDepositUsdc` plus the
    /// observation window, making EE-8 look like a `minDepositUsdc` sizing question. It is not.
    /// `requestExit` (`VaultCore.sol:541`) enforces no minimum residual, so after one transient
    /// exit the squatter's locked capital is ONE WEI of shares, and when the incumbent leaves
    /// `memberShares == ts` (`:611`) is satisfied by that one wei — the whole stranded fee is
    /// theirs regardless of stake.
    ///
    /// The levers are `exitFeeMaxBps` (0 removes the prize), `exitFeeDecayPeriod`, or a code
    /// change (weighted tenure instead of resetting `lastDepositTime` on every top-up at `:491`,
    /// or a minimum residual position). NOT `minDepositUsdc`. Choosing among them is a
    /// launch-parameter decision and this test changes nothing — it only stops the note being
    /// re-derived wrong.
    function test_ee8LastMemberPrizeIsStakeIndependentNotSizedByMinDeposit() public {
        uint256 minDep = 1_000 * USDC_1; // a deliberately "meaningful" minimum deposit
        VaultCore v = _deployVault(100, 30 days, minDep); // 1% cap, 30-day decay

        // The incumbent has been in for a year: its tenure fee has fully decayed to zero.
        _joinAndMint(v, alice, 1_000_000 * USDC_1);
        skip(365 days);
        assertEq(v.sharesOf(alice), v.totalShares(), "incumbent is the sole holder");

        // The squatter pays the minimum in, clears the window, then exits all but ONE WEI.
        _joinAndMint(v, bob, minDep);
        uint256 sqShares = v.sharesOf(bob);
        uint256 sqBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        v.requestExit(sqShares - 1);
        uint256 squatterCost = minDep - (usdc.balanceOf(bob) - sqBefore);

        assertEq(v.sharesOf(bob), 1, "squatter's whole locked position is 1 wei of shares");
        assertEq(squatterCost, 10_000_001, "transient cost is one 1% exit fee on the minimum, not the minimum");
        assertLe(squatterCost, minDep / 100 + 1, "and it is bounded by exitFeeMaxBps of one deposit");

        // The incumbent tops up ONCE. `lastDepositTime` resets on every top-up (`:491`), so the
        // full 1% is re-armed against the WHOLE position, not just the new money.
        vm.prank(alice);
        v.deposit(minDep);
        uint256 wBefore = usdc.balanceOf(alice);
        uint256 wShares = v.sharesOf(alice);
        vm.prank(alice);
        v.requestExit(wShares);
        uint256 incumbentLoss = (1_001_000 * USDC_1) - (usdc.balanceOf(alice) - wBefore);
        assertEq(incumbentLoss, 10_000_100_000, "one top-up costs the incumbent ~1% of its ENTIRE position");

        // The squatter is now the sole holder on 1 wei, so the waiver fires for IT and the drain
        // is exact: it takes the incumbent's stranded fee AND recovers its own.
        assertEq(v.totalShares(), 1, "1 wei of supply left");
        uint256 sqBefore2 = usdc.balanceOf(bob);
        vm.prank(bob);
        v.requestExit(1);
        uint256 squatterTake = usdc.balanceOf(bob) - sqBefore2;

        assertEq(squatterTake, incumbentLoss + squatterCost, "squatter takes the whole stranded fee, plus its own back");
        assertEq(squatterTake, 10_010_100_001, "10,010.100001 USDC captured on a 1-wei position");
        assertEq(v.totalShares(), 0, "and the vault closes clean");
        assertEq(v.navWad(), 0, "with no residue for the ts == 0 branch to hand away");
    }

    /// @notice The other half of the same characterisation, and the reason EE-8 stays Accepted at
    /// L: the prize exists only while the incumbent is inside `exitFeeDecayPeriod`. An incumbent
    /// that does not top up pays nothing and the squat earns nothing — which is why the lever is
    /// the fee's parameters, not the deposit minimum.
    function test_ee8PrizeIsZeroWhenTheIncumbentTenureHasDecayed() public {
        VaultCore v = _deployVault(100, 30 days, 1_000 * USDC_1);
        _joinAndMint(v, alice, 1_000_000 * USDC_1);
        _joinAndMint(v, bob, 1_000 * USDC_1);
        skip(31 days); // past exitFeeDecayPeriod, and no top-up

        uint256 wBefore = usdc.balanceOf(alice);
        uint256 wShares = v.sharesOf(alice);
        vm.prank(alice);
        v.requestExit(wShares);
        assertEq(usdc.balanceOf(alice) - wBefore, 1_000_000 * USDC_1, "fully decayed tenure pays no exit fee");
    }

    /// @dev Proposal tuple order per src/Governance.sol:87-104.
    function _forWeight(uint256 pid) internal view returns (uint256 f) {
        (,,,,,,,,,,,, f,,,) = gov.proposals(pid);
    }

    function _status(uint256 pid) internal view returns (Governance.Status s) {
        (,,,,,,,, s,,,,,,,) = gov.proposals(pid);
    }
}
