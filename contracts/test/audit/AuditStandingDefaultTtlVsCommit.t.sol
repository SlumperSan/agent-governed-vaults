// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {Governance} from "../../src/Governance.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

/// @title T-1 — a standing default must outlive the commit phase
/// @notice Finding T-1 (Low) from the Slither `timestamp` triage (Team4-Timestamp, 2026-09-01).
///
/// `applyStandingDefault` is callable only from `p.commitDeadline` (its reveal-phase guard), and
/// it measures the VO-3 TTL against `block.timestamp`. The TTL is therefore never evaluated
/// earlier than `p.createdAt + cfg.commitDuration`, so a standing default's USABLE life is
/// `DEFAULT_TTL - cfg.commitDuration`. `_validateConfig` bounded `commitDuration` to
/// `[1 hours, 30 days]` and never related it to `DEFAULT_TTL = 72 hours`, so a vault registered
/// with `commitDuration >= 72h` — legal, silent, no event — had EVERY standing default provably
/// expired before its reveal window opened. VO-3 was unconditionally dead for that vault.
///
/// FIX (this PR): `COMMIT_HARD_CAP = DEFAULT_TTL - 1`. The dead configuration is unrepresentable
/// at both `_validateConfig` call sites (`registerVault` and `execute`'s RuleChange branch), and
/// no runtime path changed for any config that remains legal.
///
/// REJECTED: re-anchoring the TTL to `p.createdAt`. That would let a default be applied up to
/// `DEFAULT_TTL + cfg.commitDuration` after being set, and VO-3's accepted disposition is exactly
/// the upper bound on that staleness (`docs/THREAT-MODEL.md` row VO-3;
/// `docs/reviews/SPRINT6-GOVERNANCE-ACCEPTED-ROWS.md` Area 2). See `docs/vault/mediums-and-lows.md`.
contract AuditStandingDefaultTtlVsCommitTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockOracle oracle;
    StubFeeEngine fees;
    StubRegistry registry;
    Governance gov;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        fees = new StubFeeEngine();
        registry = new StubRegistry();
        gov = new Governance();
    }

    function _cfg(uint32 commitDuration) internal pure returns (Governance.GovConfig memory) {
        return Governance.GovConfig({
            commitDuration: commitDuration,
            revealDuration: 6 hours,
            timelockDuration: 1 days,
            executionWindow: 2 days,
            quorumBps: 2_500,
            proposalThresholdBps: 500,
            concentrationCapBps: 4_000,
            proposalCooldown: 1 hours
        });
    }

    function _newVault() internal returns (VaultCore v) {
        address[] memory basket = new address[](0);
        v = new VaultCore(
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
    }

    /// Five equal members so the vault sits in the stake-quorum regime, matching Governance.t.sol.
    function _fund(VaultCore v) internal {
        address[5] memory who = [creator, alice, bob, carol, dave];
        for (uint256 i; i < who.length; ++i) {
            usdc.mint(who[i], 10_000_000 * USDC_1);
            vm.startPrank(who[i]);
            usdc.approve(address(v), type(uint256).max);
            v.deposit(1_000 * USDC_1);
            v.skipWindow();
            vm.stopPrank();
        }
        skip(1); // snapshots are strictly-before-creation
    }

    function _registeredVault(uint32 commitDuration) internal returns (VaultCore v) {
        v = _newVault();
        vm.prank(creator);
        gov.registerVault(address(v), _cfg(commitDuration));
        _fund(v);
    }

    function _commitDeadline(uint256 pid) internal view returns (uint64 d) {
        (,,,, d,,,,,,,,,,,) = gov.proposals(pid);
    }

    function _forWeight(uint256 pid) internal view returns (uint256 w) {
        (,,,,,,,,,,,, w,,,) = gov.proposals(pid);
    }

    function _revealDeadline(uint256 pid) internal view returns (uint64 d) {
        (,,,,, d,,,,,,,,,,) = gov.proposals(pid);
    }

    // ── 1. Control ───────────────────────────────────────────────────────────
    //
    // Team4's control, unchanged. It is the discriminator for the tests below: the identical
    // sequence must succeed at a commit phase well under DEFAULT_TTL, so a revert in tests 2-4 is
    // the TTL relation and not a broken fixture.
    //
    // MUTATION: `applyStandingDefault`'s reveal-phase lower bound `>= p.commitDeadline` -> `>`
    // turns this red with `WrongPhase()` (the warp lands exactly on the deadline) — verified.
    function test_T1_control_shortCommitPhase_defaultApplies() public {
        VaultCore v = _registeredVault(6 hours);
        vm.prank(carol);
        gov.setStandingDefault(address(v), true);
        skip(1); // F4: the default must predate the proposal

        vm.prank(creator);
        uint256 pid = gov.propose(address(v), Governance.ProposalType.Rebalance, keccak256(""));
        vm.warp(_commitDeadline(pid));

        gov.applyStandingDefault(pid, carol);
        assertGt(_forWeight(pid), 0, "control: the default landed in the tally");
    }

    // ── 2. The finding, now unrepresentable ──────────────────────────────────
    //
    // Team4's exploit case. On `protocol/main` `commitDuration = 4 days` registered silently and
    // every subsequent `applyStandingDefault` reverted `DefaultUnavailable()` for the whole reveal
    // window. Re-pointed at the fix: the config is rejected where a bad config belongs, at
    // `_validateConfig`, so the dead vault cannot be created in the first place.
    //
    // MUTATION: revert `COMMIT_HARD_CAP` to `30 days`, or drop the cap conjunct at
    // `_validateConfig` entirely, and this goes red at `registerVault` — both verified.
    function test_T1_commitPhaseLongerThanTtl_isRejectedAtRegistration() public {
        VaultCore v = _newVault();
        vm.prank(creator);
        vm.expectRevert(Governance.BadGovConfig.selector);
        gov.registerVault(address(v), _cfg(4 days));
        assertFalse(gov.vaultRegistered(address(v)), "a vault that kills VO-3 must not register");
    }

    // ── 2b. …and RuleChange cannot legislate back into it ────────────────────
    //
    // `_validateConfig` is called at BOTH `registerVault` and `execute`'s RuleChange branch, so a
    // creator cannot register at 1h and then legislate to 4 days. Driving a whole proposal to
    // reach `execute` would make this a test of the proposal machinery; instead it pins the fact
    // the bypass would need — that the cap the RuleChange path reads is the same constant.
    //
    // MUTATION: this is the value pin, and it catches every move of the cap that the boundary
    // partition in test 4 cannot see — `30 days`, `DEFAULT_TTL`, `DEFAULT_TTL - 2`,
    // `DEFAULT_TTL + 1`, and `71 hours` (the right value, decoupled from the TTL). All five
    // verified red.
    function test_T1_theCapIsPinnedToTheTtl() public view {
        assertEq(gov.COMMIT_HARD_CAP(), gov.DEFAULT_TTL() - 1, "the cap is derived from the TTL");
        assertEq(gov.COMMIT_HARD_CAP(), 72 hours - 1, "and the TTL is still 72h");
    }

    // ── 3. The shortened window, asserted as designed rather than as a defect ─
    //
    // Team4's T-1(b): with the SHIPPED commit phase (base-mainnet.json and base-sepolia.json both
    // use `commitDuration: 3600`), a default set 71h30m before the proposal is live at creation
    // and dead 30 minutes into the reveal window.
    //
    // THIS ASSERTION IS INVERTED RELATIVE TO TEAM4'S DRAFT, deliberately. Team4 asserted the
    // default should still apply, which is fix shape (b) — re-anchoring the TTL to `p.createdAt`.
    // That shape was rejected: it stretches the maximum staleness of an APPLIED default to
    // `DEFAULT_TTL + cfg.commitDuration`, and VO-3's accepted disposition IS the upper bound on
    // that staleness. Under the shape that shipped, the expiry here is correct-by-design; what
    // T-1 fixes is that the shortening is now BOUNDED (`commitDuration < DEFAULT_TTL`, so the
    // usable window is never empty) and DOCUMENTED (the NatSpec no longer claims a full 72h).
    //
    // MUTATION: re-anchor the guard to `p.createdAt <= d.setAt + DEFAULT_TTL` and this goes red,
    // alone in the suite — which is exactly its job: it pins WHICH of the two fix shapes shipped.
    // Verified. (`>= p.commitDeadline` -> `>` also reddens it, on a different selector.)
    function test_T1b_commitPhaseConsumesPartOfTheTtl_bounded() public {
        VaultCore v = _registeredVault(1 hours); // the shipped commitDuration
        vm.prank(carol);
        gov.setStandingDefault(address(v), true);
        skip(71 hours + 30 minutes);

        vm.prank(creator);
        uint256 pid = gov.propose(address(v), Governance.ProposalType.Rebalance, keccak256(""));
        // The default was live at creation: setAt + 72h > createdAt.
        vm.warp(_commitDeadline(pid)); // reveal opens at setAt + 72h30m — past the TTL

        vm.expectRevert(Governance.DefaultUnavailable.selector);
        gov.applyStandingDefault(pid, carol);

        // Shortened, not empty: the same member refreshing inside the bound still lands. Without
        // this leg the assertion above would also pass under a mutation that broke defaults
        // entirely. CM-6 serializes proposals per vault, so settle the first one first; nothing
        // revealed, so it finalizes Defeated, and `alice` proposes to sidestep the per-proposer
        // cooldown rather than warping past it.
        vm.warp(_revealDeadline(pid));
        gov.finalize(pid);

        vm.prank(carol);
        gov.setStandingDefault(address(v), true);
        skip(1);
        vm.prank(alice);
        uint256 pid2 = gov.propose(address(v), Governance.ProposalType.Rebalance, keccak256(""));
        vm.warp(_commitDeadline(pid2));
        gov.applyStandingDefault(pid2, carol);
        assertGt(_forWeight(pid2), 0, "a refreshed default still has a usable window");
    }

    // ── 4. The boundary the new cap creates ──────────────────────────────────
    //
    // The cap partitions two adjacent seconds exactly: at it registers, one past it reverts. The
    // cap is read DYNAMICALLY, so this test pins the partition and says nothing about the value —
    // the value is test 2b's job. That split is deliberate: it is what makes the two mutation
    // results below distinguishable instead of both tests dying on the same assertion.
    //
    // MUTATION: `require(... <= COMMIT_HARD_CAP)` -> `<` turns case A red; -> `!=`/removal turns
    // case B red. Moving the cap's VALUE (`DEFAULT_TTL - 1` -> `DEFAULT_TTL`, `- 2`, `71 hours`)
    // leaves this test green BY DESIGN and is caught by test 2b and test 6 — verified, not assumed.
    function test_T1_commitDurationCapBoundary_partitionsExactly() public {
        // Hoisted: an argument-position `gov.X()` is an external call that would consume the
        // `vm.prank` before `registerVault` ever saw it.
        uint32 atCap = uint32(gov.COMMIT_HARD_CAP());

        // A — exactly at the cap registers.
        VaultCore vOk = _newVault();
        vm.prank(creator);
        gov.registerVault(address(vOk), _cfg(atCap));
        assertTrue(gov.vaultRegistered(address(vOk)), "a config exactly at the cap must register");

        // B — one second past it reverts.
        VaultCore vBad = _newVault();
        vm.prank(creator);
        vm.expectRevert(Governance.BadGovConfig.selector);
        gov.registerVault(address(vBad), _cfg(atCap + 1));
        assertFalse(gov.vaultRegistered(address(vBad)), "one second past the cap must revert");
    }

    // ── 5. Narrowing from above did not disturb the floor ────────────────────
    //
    // Narrowing a range from above can silently invert it. The C-2 floor is unchanged and binds.
    //
    // MUTATION: drop the `>= 1 hours` conjunct at `_validateConfig` and this goes red.
    function test_T1_commitDurationFloorStillBinds() public {
        VaultCore v = _newVault();
        vm.prank(creator);
        vm.expectRevert(Governance.BadGovConfig.selector);
        gov.registerVault(address(v), _cfg(1 hours - 1));
    }

    // ── 6. A vault at the new cap can still complete a default-bearing round ─
    //
    // The cap is only worth having if the configuration AT it works end to end: a default set one
    // second before the proposal must still be applicable when the reveal window opens, which is
    // the invariant `COMMIT_HARD_CAP < DEFAULT_TTL` exists to buy. This is the positive form of
    // test 2 and the one that would catch a cap that is under the TTL but still too long.
    //
    // MUTATION: it is the broadest killer in the file — `30 days`, `DEFAULT_TTL`, `DEFAULT_TTL + 1`
    // and the TTL comparison `<=` -> `<` all turn it red with `DefaultUnavailable()` (a config
    // that registers but cannot use a default), and the cap operator `<=` -> `<` turns it red with
    // `BadGovConfig()` (a cap the config at it cannot reach). All five verified.
    function test_T1_aVaultAtTheCapStillHasAUsableDefaultWindow() public {
        VaultCore v = _registeredVault(uint32(gov.COMMIT_HARD_CAP()));
        vm.prank(carol);
        gov.setStandingDefault(address(v), true);
        skip(1); // F4: the default must predate the proposal

        vm.prank(creator);
        uint256 pid = gov.propose(address(v), Governance.ProposalType.Rebalance, keccak256(""));
        vm.warp(_commitDeadline(pid)); // setAt + 72h exactly — the last second of the TTL

        gov.applyStandingDefault(pid, carol);
        assertGt(_forWeight(pid), 0, "at the cap the usable window is one second, not zero");
    }

    // ── 7. A COVERAGE GAP the mutation gate found, pinned here ───────────────
    //
    // NOT part of the T-1 fix — no source line changed for it. Flipping F4's lower bound
    // `d.setAt < p.createdAt` to `<=` survived the ENTIRE contracts suite (395 tests, 0 failed).
    // That bound is load-bearing and documented as such: it is the Sprint-6 fix for tally-aware
    // post-hoc defaulting, and `docs/reviews/SPRINT6-GOVERNANCE-ACCEPTED-ROWS.md` Area 2 asserts
    // in prose that it "has no off-by-one that reopens tally-aware defaults" — while nothing
    // executable held the strictness. `test_defaultCountsInTallyNeverQuorum` and the other
    // default tests all `skip(1)` first, so they pass under either operator.
    //
    // Why `<=` is materially weaker, not cosmetic: at `setAt == createdAt` the member is setting
    // the default in the SAME BLOCK as the proposal, so they choose its direction already knowing
    // the proposal exists and knowing its `actionHash`. The accepted VO-3/F4 property is that a
    // default is a BLIND pre-declaration ("necessarily chosen before any reveal existed... so its
    // direction is blind to the proposal"). Same-block reaction is not blind.
    //
    // MUTATION: `<` -> `<=` turns this red. It is the only test in the repo that does.
    function test_T1_f4LowerBoundIsStrict_sameSecondDefaultIsRejected() public {
        VaultCore v = _registeredVault(6 hours);

        vm.prank(creator);
        uint256 pid = gov.propose(address(v), Governance.ProposalType.Rebalance, keccak256(""));

        // Same second as creation — no `skip`. This is the boundary the strict `<` excludes.
        vm.prank(carol);
        gov.setStandingDefault(address(v), true);

        vm.warp(_commitDeadline(pid));
        vm.expectRevert(Governance.DefaultUnavailable.selector);
        gov.applyStandingDefault(pid, carol);
        assertEq(_forWeight(pid), 0, "a same-second default must not reach the tally");
    }
}
