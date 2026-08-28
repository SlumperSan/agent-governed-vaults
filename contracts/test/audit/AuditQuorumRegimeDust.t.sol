// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// H-8 regression — the `<5`-member quorum regime is stake-blind and its boundary is purchasable
// for dust. `holderCount` increments for ANY address with `sharesOf > 0` regardless of size, and it
// alone selects the quorum regime (`memberCount < SIGNER_REGIME_BELOW`) and is the signer-regime
// denominator (`revealedVoterCount * 2 > memberCount`). The proposer picks the block, so membership
// can be arranged before a proposal. Two independent, opposite attacks follow (AI-AUDIT-REPORT H-8):
//
//   (a) BUY INTO THE STAKE REGIME. A 40% holder in a 4-holder vault is in the signer regime and
//       cannot act alone (needs 3 of 4 revealers). One dust deposit from a fresh address pushes
//       memberCount to 5 → stake regime → the 40% holder passes alone (40% >= 25% quorum).
//   (b) DUST GRIEFS THE SIGNER DENOMINATOR. Dust holders raise the signer-regime denominator so a
//       legitimate dominant-stake member can no longer reach `revealedVoterCount * 2 > memberCount`.
//       A 1-member vault is made ungovernable for ~$3 of dust while it stays under 5 members.
//
// This finding was PLAUSIBLE (source derivation, no executing test) in the report. These tests make
// it CONFIRMED. The fix is delicate — the naive "floor on holderCount membership" repeats M-6's
// reverted `proposalThresholdBps` mistake (a bound on a live-distribution quantity → liveness
// cliff) — so this file is the specification the fix must satisfy without breaking legitimate use.

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {Governance} from "../../src/Governance.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

contract AuditQuorumRegimeDustTest is Test {
    uint256 constant USDC_1 = 1e6;
    bytes32 constant SALT = keccak256("salt");

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
            new address[](0), // no basket assets — a pure-USDC vault suffices for governance
            creator,
            registry,
            gov,
            fees,
            oracle,
            10_000_000 * USDC_1,
            1 * USDC_1, // minDepositUsdc = 1 USDC — the repo's worked config; this is the attack cost
            0,
            0,
            new address[](0),
            address(0)
        );

        // proposalThresholdBps = 0 so any holder may open a proposal; the finding is about QUORUM,
        // not the proposal threshold (that is M-6). concentrationCapBps only bounds DELEGATED
        // accrual, so self-votes are unaffected — set it wide open to keep the test about H-8 only.
        vm.prank(creator);
        gov.registerVault(
            address(vault),
            Governance.GovConfig({
                commitDuration: 1 hours,
                revealDuration: 1 hours,
                timelockDuration: 1 hours,
                executionWindow: 1 days,
                quorumBps: 2_500,
                proposalThresholdBps: 0,
                concentrationCapBps: 5_000, // ceiling; irrelevant here (self-votes, not delegated)
                proposalCooldown: 1 hours // floor; rounds are spaced well past it
            })
        );
    }

    function _deposit(address who, uint256 amountUsdc) internal {
        usdc.mint(who, amountUsdc);
        vm.startPrank(who);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(amountUsdc);
        vault.skipWindow();
        vm.stopPrank();
    }

    /// Drive a full commit→reveal→finalize round: `proposer` opens it and every address in
    /// `forVoters` votes FOR. Returns the resulting proposal status.
    function _round(address proposer, address[] memory forVoters) internal returns (Governance.Status) {
        skip(1); // snapshots read createdAt - 1
        vm.prank(proposer);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256("payload"));

        for (uint256 i; i < forVoters.length; ++i) {
            vm.prank(forVoters[i]);
            gov.commitVote(pid, keccak256(abi.encode(pid, forVoters[i], true, SALT)));
        }
        // Warp to the actual deadlines read from the proposal (robust against arithmetic drift).
        (,,,, uint64 commitDeadline, uint64 revealDeadline,,,,,,,,,,) = gov.proposals(pid);
        vm.warp(commitDeadline); // reveal phase is [commitDeadline, revealDeadline)
        for (uint256 i; i < forVoters.length; ++i) {
            vm.prank(forVoters[i]);
            gov.revealVote(pid, true, SALT);
        }
        vm.warp(revealDeadline); // finalize requires >= revealDeadline
        gov.finalize(pid);

        (,,,,,,,, Governance.Status status,,,,,,,) = gov.proposals(pid);
        return status;
    }

    function _solo(address voter) internal returns (Governance.Status) {
        address[] memory a = new address[](1);
        a[0] = voter;
        return _round(voter, a);
    }

    // ── Attack (a): buy into the stake regime — RESIDUAL, config-mitigated ────
    // This is the one direction WITHOUT a code fix: crossing the memberCount<5 boundary costs a
    // real `minDepositUsdc`, so it is mitigated by requiring a meaningful minimum deposit (config
    // layer), not by a contract floor (which would repeat M-6's liveness cliff). The test asserts
    // the residual STILL works at minDepositUsdc = 1 USDC, i.e. it documents the accepted residual.
    function test_finding_h8a_regimeFlipResidual_configMitigated() public {
        address a = makeAddr("a"); // 40%
        _deposit(a, 400 * USDC_1);
        _deposit(makeAddr("b"), 200 * USDC_1);
        _deposit(makeAddr("c"), 200 * USDC_1);
        _deposit(makeAddr("d"), 200 * USDC_1);
        assertEq(vault.holderCount(), 4, "signer regime: 4 members");

        // Signer regime (memberCount 4 < 5): A (40%) alone still cannot pass — no head-count
        // majority and no >50% stake majority. The fix preserves this protection.
        assertEq(uint8(_solo(a)), uint8(Governance.Status.Defeated), "signer regime still protects the 60%");

        // One dust deposit pushes memberCount to 5 → stake regime, where 40% >= 25% quorum passes.
        _deposit(makeAddr("dust"), 1 * USDC_1);
        assertEq(vault.holderCount(), 5, "stake regime: dust bought the 5th seat");
        assertEq(
            uint8(_solo(a)),
            uint8(Governance.Status.Passed),
            "H-8(a) RESIDUAL: buying the regime flip still works; mitigated by a meaningful minDepositUsdc"
        );
    }

    // ── Attack (b): dust griefing the signer denominator — REMEDIATED ─────────
    // Pre-fix: 3 dust holders made memberCount 4, so a dominant member alone failed `1*2 > 4` and
    // was locked out. Post-fix: the additive FOR-stake-majority branch lets a >50% member pass
    // REGARDLESS of head count, so dust can no longer inflate the denominator into a lockout.
    function test_remediated_h8b_dominantStakeMemberGovernsDespiteDust() public {
        address m = makeAddr("m");
        _deposit(m, 1_000 * USDC_1);
        _deposit(makeAddr("dust1"), 1 * USDC_1);
        _deposit(makeAddr("dust2"), 1 * USDC_1);
        _deposit(makeAddr("dust3"), 1 * USDC_1);
        assertEq(vault.holderCount(), 4, "dust inflated the denominator, still signer regime");

        // M holds ~99.7% (> 50% of snapshotTotal), so the FOR-stake-majority branch passes it.
        assertEq(
            uint8(_solo(m)),
            uint8(Governance.Status.Passed),
            "H-8(b) FIXED: a >50% member governs despite dust inflating the head count"
        );
    }

    // ── Attack (c): near-zero-stake sybils passing an arbitrary rebalance — REMEDIATED ──
    // Pre-fix: against a single-holder vault, 3 dust sybils gave `3*2 > 4` and passed an arbitrary
    // Rebalance on ~zero stake while the incumbent stayed silent — a theft primitive. Post-fix: the
    // head-count branch now also requires the FOR side to clear the stake quorum, which ~0% cannot.
    function test_remediated_h8c_zeroStakeSybilsCannotPassArbitraryRebalance() public {
        _deposit(makeAddr("incumbent"), 1_000 * USDC_1); // holds ~all stake, stays silent
        address s1 = makeAddr("sybil1");
        address s2 = makeAddr("sybil2");
        address s3 = makeAddr("sybil3");
        _deposit(s1, 1 * USDC_1);
        _deposit(s2, 1 * USDC_1);
        _deposit(s3, 1 * USDC_1);
        assertEq(vault.holderCount(), 4, "incumbent + 3 sybils");

        address[] memory sybils = new address[](3);
        (sybils[0], sybils[1], sybils[2]) = (s1, s2, s3);

        // `3*2 > 4` head count holds, but the 3 dust sybils are ~0.3% of stake — far under the 25%
        // FOR-stake quorum the fix now requires on the head-count branch, and nowhere near a 50%
        // majority. The arbitrary rebalance is defeated.
        assertEq(
            uint8(_round(s1, sybils)),
            uint8(Governance.Status.Defeated),
            "H-8(c) FIXED: zero-stake sybils can no longer pass a rebalance via head count"
        );
    }
}
