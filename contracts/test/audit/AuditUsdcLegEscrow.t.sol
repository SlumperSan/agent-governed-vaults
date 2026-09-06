// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubGovernance, StubRegistry} from "../mocks/Mocks.sol";

/// @notice AUDIT ARTIFACT — not a protocol test. **M-2 IS REMEDIATED.**
///
/// The USDC settlement legs had no EE-6 escrow isolation, unlike every other transfer in the
/// contract: `:611`, `:642` and `:363` used the reverting `safeTransfer` while basket assets
/// used `tryTransfer` + escrow. Three consequences, in increasing order of severity:
///
///  1. A blacklisted member could not exit AT ALL, and lost their in-kind legs with it — the
///     precise outcome EE-6 exists to prevent, and a falsification of PX-1's claim that in-kind
///     redemption "keeps non-USDC basket assets exitable".
///  2. `cancelPending` was worse, being unconditional: a member blacklisted AFTER depositing had
///     their pending escrow permanently stranded, with no other path out. It is also the one
///     guaranteed action during an oracle freeze (K-4), so a revert there removed the only lever
///     the incident playbook can promise.
///  3. Systemically: `feeEngine` is a factory-wired singleton shared by EVERY vault, and exactly
///     the address class a stablecoin issuer blacklists. Once listed, every exit carrying a
///     positive performance fee, in every vault, reverted permanently.
contract AuditUsdcLegEscrowTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    StubFeeEngine fees;
    StubGovernance gov;
    StubRegistry registry;
    VaultCore vault;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        fees = new StubFeeEngine();
        gov = new StubGovernance();
        registry = new StubRegistry();
        oracle.setPrice(address(weth), 4_000e18);

        // A one-asset basket, so an exit produces BOTH a cash leg and an in-kind leg - the
        // asymmetry M-2 is about (in-kind escrowed, cash reverted) is only visible when both
        // are present.
        address[] memory basket = new address[](1);
        basket[0] = address(weth);

        vault = new VaultCore(
            address(usdc),
            basket,
            creator,
            registry,
            gov,
            fees,
            oracle,
            10_000_000 * USDC_1,
            1 * USDC_1,
            100, // 1% tenure exit fee - the only in-protocol way to raise NAV per share here
            30 days,
            new address[](0),
            address(0)
        );

        for (uint160 i; i < 3; ++i) {
            address who = i == 0 ? creator : (i == 1 ? alice : bob);
            usdc.mint(who, 1_000_000 * USDC_1);
            vm.prank(who);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _join(address who, uint256 amt) internal {
        vm.startPrank(who);
        vault.deposit(amt * USDC_1);
        vault.skipWindow();
        vm.stopPrank();
    }

    /// @notice M-2 FIXED: a member blacklisted mid-flight still exits. The cash leg degrades to
    /// escrow instead of reverting the whole settlement, and the shares are genuinely burned —
    /// the exit COMPLETES rather than being deferred.
    function test_remediated_blacklistedMemberStillExitsAndCashEscrows() public {
        _join(creator, 1_000);
        _join(alice, 1_000);

        uint256 shares = vault.sharesOf(alice);
        usdc.setBlacklisted(alice, true);

        vm.prank(alice);
        vault.requestExit(shares);

        assertEq(vault.sharesOf(alice), 0, "exit completed: shares burned");
        assertEq(usdc.balanceOf(alice), 999_000 * USDC_1, "no cash delivered yet");
        uint256 escrowed = vault.claimable(alice, address(usdc));
        assertGt(escrowed, 0, "cash escrowed, not lost");

        // And it is genuinely reclaimable once the listing is lifted.
        usdc.setBlacklisted(alice, false);
        vm.prank(alice);
        vault.claimEscrowed(address(usdc));
        assertEq(usdc.balanceOf(alice), 999_000 * USDC_1 + escrowed, "escrow delivered in full");
        assertEq(vault.claimable(alice, address(usdc)), 0, "escrow cleared");
    }

    /// @notice M-2's worst case: `cancelPending` was UNCONDITIONAL, so a member blacklisted after
    /// depositing had their pending escrow permanently stranded. It now escrows and is
    /// reclaimable — and it still works during an oracle freeze, which is the one promise the
    /// incident playbook makes about K-4.
    function test_remediated_cancelPendingEscrowsAndSurvivesAnOracleFreeze() public {
        vm.prank(alice);
        vault.deposit(500 * USDC_1); // pending, not activated

        usdc.setBlacklisted(alice, true);
        oracle.setStale(true); // K-4: every NAV path frozen

        vm.prank(alice);
        vault.cancelPending(); // must not revert

        assertEq(vault.claimable(alice, address(usdc)), 500 * USDC_1, "pending escrowed, not stranded");
        assertEq(vault.totalPendingUsdc(), 0, "pending accounting cleared");

        usdc.setBlacklisted(alice, false);
        vm.prank(alice);
        vault.claimEscrowed(address(usdc));
        assertEq(usdc.balanceOf(alice), 1_000_000 * USDC_1, "made whole");
    }

    /// @notice The systemic case. `feeEngine` is a factory-wired singleton shared by every vault.
    /// With it blacklisted, every exit carrying a positive performance fee used to revert
    /// permanently, in every vault. It now escrows to the engine's own claimable balance and the
    /// member's exit proceeds untouched.
    function test_remediated_blacklistedFeeEngineNoLongerBricksEveryFeeCarryingExit() public {
        _join(creator, 1_000);
        _join(alice, 1_000);

        _join(bob, 1_000);

        // Realize a gain for the remaining members the only way this harness can: bob exits
        // immediately and pays the full 1% tenure fee, which STAYS in the vault and lifts NAV
        // per share for everyone left. Alice's later exit therefore books a profit, and the
        // engine is owed a performance fee on it.
        // NB: read the shares BEFORE pranking - passing vault.sharesOf(bob) as the argument
        // is itself a call, and it consumes the prank.
        uint256 bobShares = vault.sharesOf(bob);
        vm.prank(bob);
        vault.requestExit(bobShares);
        // Let alice's OWN tenure fee decay to zero, or it cancels the gain bob just handed
        // her and there is no performance fee to escrow.
        skip(30 days);
        fees.setFeeToCharge(1 * USDC_1); // VaultCore clamps this at gain/10 regardless

        usdc.setBlacklisted(address(fees), true);

        uint256 shares = vault.sharesOf(alice);
        uint256 before = usdc.balanceOf(alice);

        vm.prank(alice);
        vault.requestExit(shares); // must not revert

        assertEq(vault.sharesOf(alice), 0, "exit completed");
        assertGt(usdc.balanceOf(alice) - before, 0, "member was paid");
        assertGt(vault.claimable(address(fees), address(usdc)), 0, "the fee escrowed rather than reverting");
    }

    /// @notice The behaviour that must NOT change: with nobody blacklisted, cash is delivered
    /// directly and nothing is escrowed. A fix that routed every exit through escrow would be a
    /// worse product than the bug.
    function test_remediated_happyPathStillPaysDirectlyWithNoEscrow() public {
        _join(creator, 1_000);
        _join(alice, 1_000);

        uint256 shares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(shares);

        assertGt(usdc.balanceOf(alice), 999_000 * USDC_1, "paid directly");
        assertEq(vault.claimable(alice, address(usdc)), 0, "nothing escrowed");
    }
}
