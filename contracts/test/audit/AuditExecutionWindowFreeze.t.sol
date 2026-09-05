// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {Governance} from "../../src/Governance.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

/// @notice AUDIT ARTIFACT — not a protocol test. **C-2 IS REMEDIATED.**
///
/// This file originally carried four tests demonstrating the freeze. Three of them asserted the
/// UNFIXED behaviour ("still pending a decade later", "blocks all future proposals", "freezes
/// exits with no vote at all") and were removed once the hard caps landed — their failure was
/// the proof the fix works, and a permanently-red suite is not evidence, it is noise. The
/// exploits are preserved in git history and described in full in docs/audit/AI-AUDIT-REPORT.md
/// C-2; the fix is pinned by Governance.t.sol::test_phaseDurationHardCapsEnforced (which checks
/// each bound independently, the uint32 ceiling, and that a config exactly ON each cap is still
/// accepted) and by the three test_remediated_* cases in AuditDosExitLiveness.t.sol.
///
/// `Governance._validateConfig` caps `timelockDuration` at `TIMELOCK_HARD_CAP` (30 days) but
/// applies only a FLOOR to `executionWindow` (`src/Governance.sol:203-204`):
///
///     require(cfg.timelockDuration <= TIMELOCK_HARD_CAP, BadGovConfig());
///     require(cfg.executionWindow >= 1 hours, BadGovConfig());
///
/// `executionWindow` is `uint32`, so it may be set to ~136 years. A proposal that PASSES but can
/// never be executed then holds the vault in Mode F forever, because:
///   - `hasPendingExecution` is true while `status == Passed && now <= expiresAt`
///     (`src/Governance.sol:522-523`);
///   - `VaultCore.requestExit` queues instead of settling while that holds (`src/VaultCore.sol:445`);
///   - `VaultCore.settleQueuedExit` reverts `ExecutionStillPending` (`src/VaultCore.sol:477`);
///   - `markExpired` requires `now > expiresAt` (`src/Governance.sol:492`);
///   - `execute` requires the payload preimage of `actionHash` (`src/Governance.sol:465`), which
///     only the proposer knows — `propose` never validates that `actionHash` corresponds to
///     anything at all (`src/Governance.sol:219`).
///
/// And because `_isSettled` counts only Defeated/Executed/Expired (`src/Governance.sol:504-506`),
/// a stuck `Passed` proposal ALSO blocks every future proposal on that vault
/// (`src/Governance.sol:223-226`) — so governance cannot RuleChange its way out either.
///
/// Net effect on an immutable protocol with no pause and no admin: total, permanent loss of
/// every member's capital in that vault.
contract AuditExecutionWindowFreezeTest is Test {
    uint256 constant USDC_1 = 1e6;
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

    /// @dev Identical to the project's own Governance.t.sol fixture EXCEPT `executionWindow`,
    /// which is set to the uint32 maximum. Every other parameter is the project's own value, so
    /// nothing else about this vault is unusual.
    function _cfg() internal pure returns (Governance.GovConfig memory) {
        return Governance.GovConfig({
            commitDuration: 6 hours,
            revealDuration: 6 hours,
            timelockDuration: 1 days,
            executionWindow: type(uint32).max, // ← the only change. ~136 years.
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
            100,
            30 days,
            new address[](0),
            address(0)
        );

        // REMEDIATED (C-2). setUp originally registered `_cfg()` with
        // executionWindow = type(uint32).max, which the validator accepted — that acceptance WAS
        // the finding. The phase-duration hard caps now reject it, so setUp registers a valid
        // config and the tests below assert the rejection instead of the freeze. The original
        // exploit is in git history and docs/audit/AI-AUDIT-REPORT.md C-2.
        Governance.GovConfig memory bad = _cfg();
        vm.prank(creator);
        vm.expectRevert(Governance.BadGovConfig.selector);
        gov.registerVault(address(vault), bad);

        Governance.GovConfig memory ok = _cfg();
        ok.executionWindow = 1 days;
        vm.prank(creator);
        gov.registerVault(address(vault), ok);

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

    /// @notice The premise of C-2 was that the validator ACCEPTED an unbounded window. It no longer does.
    function test_remediated_validatorRejectsAnUnboundedExecutionWindow() public view {
        // setUp() proved type(uint32).max is now REJECTED and registered 1 days instead.
        (,,, uint32 executionWindow,,,,) = gov.configOf(address(vault));
        assertLe(
            uint256(executionWindow), gov.EXECUTION_WINDOW_HARD_CAP(), "stored window must respect the cap"
        );
        // For contrast, the sibling parameter IS capped.
        assertEq(gov.TIMELOCK_HARD_CAP(), 30 days, "timelock is hard-capped; executionWindow is not");
    }
}
