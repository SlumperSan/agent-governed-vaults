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
///  3. `_isSettled` (row 2, `src/Governance.sol:634`). The real question is not whether the enum
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
        v = new VaultCore(
            address(usdc),
            new address[](0),
            creator,
            registry,
            gov,
            fees,
            oracle,
            1_000_000_000 * USDC_1,
            10 * USDC_1,
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

        // Re-opening therefore prices at 1:1 against a genuinely empty vault, not against residue.
        _joinAndMint(v, carol, 1_000 * USDC_1);
        assertEq(v.sharesOf(carol), 1_000 * USDC_1 * SCALAR, "_mintShares:480 re-opens at 1:1");
        assertEq(v.navPerShareWad(), 1e18, "and NAVps is back at par");
    }

    // ─────────── row 7 — `Checkpoints.push` same-second overwrite ───────────

    /// @notice The same-second overwrite cannot backfill weight onto a proposal created in that
    /// same second, and it does not lose the second's final value for later readers.
    ///
    /// Three writes land in ONE second `T`: a deposit (appends a checkpoint at `T`), the
    /// `propose` call (`createdAt == T`), and a second deposit (OVERWRITES the checkpoint at `T`,
    /// `Checkpoints.sol:23-24`). The proposal reads `pastVotingEligibleShares(voter, T - 1)`
    /// (`Governance.propose:297-298`, `Governance._boundedWeight:348`), which is strictly before any of them.
    ///
    /// Mutation that turns this red: `nowTs - 1` -> `nowTs` in `Governance.propose`. That is the
    /// mutation that would make row 7 a real flash-stake finding, and it is invisible to a
    /// `Checkpoints`-only unit test.
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
    /// (`Governance.sol:288`) and `delegate` (`:515`), so a proposal stuck `Active` would block
    /// every future proposal INCLUDING the RuleChange that would unstick it
    /// (`Governance.sol:57-67`).
    ///
    /// `finalize` (`:527-579`) reads only `p.*` and `configOf[p.vault]`, is unauthenticated, and
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
    /// `!= 0`-guarded at `Governance.sol:286`).
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

    /// @dev Proposal tuple order per src/Governance.sol:110-127.
    function _forWeight(uint256 pid) internal view returns (uint256 f) {
        (,,,,,,,,,,,, f,,,) = gov.proposals(pid);
    }

    function _status(uint256 pid) internal view returns (Governance.Status s) {
        (,,,,,,,, s,,,,,,,) = gov.proposals(pid);
    }
}
