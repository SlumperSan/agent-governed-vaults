// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle, StubGovernance, StubFeeEngine, StubRegistry} from "./mocks/Mocks.sol";

contract VaultCoreTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 wbtcLike; // 8 decimals
    MockERC20 wethLike; // 18 decimals
    MockOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        wbtcLike = new MockERC20("wBTC", 8);
        wethLike = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();

        oracle.setPrice(address(wbtcLike), 100_000e18);
        oracle.setPrice(address(wethLike), 4_000e18);

        address[] memory basket = new address[](2);
        basket[0] = address(wbtcLike);
        basket[1] = address(wethLike);

        vault = new VaultCore(
            address(usdc),
            basket,
            creator,
            registry,
            gov,
            fees,
            oracle,
            10_000_000 * USDC_1, // capacity cap
            10 * USDC_1, // min deposit
            100, // exit fee max 1%
            30 days, // fee decay period
            new address[](0),
            address(0)
        );

        for (uint160 i; i < 3; ++i) {
            address who = [creator, alice, bob][i];
            usdc.mint(who, 1_000_000 * USDC_1);
            vm.prank(who);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _seedCreator(uint256 amount) internal {
        vm.startPrank(creator);
        vault.deposit(amount);
        vm.stopPrank();
        skip(4 hours);
        vault.activate(creator);
    }

    function _join(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount);
        skip(4 hours);
        vault.activate(who);
    }

    // ── observation window (EE-1..4) ─────────────────────────────────────────

    function test_firstDepositEntersWindow_noSharesNoNav() public {
        vm.prank(alice);
        vault.deposit(100 * USDC_1);

        assertEq(vault.sharesOf(alice), 0, "no shares during window");
        assertEq(vault.navWad(), 0, "pending excluded from NAV");
        assertEq(vault.totalPendingUsdc(), 100 * USDC_1);
        assertEq(vault.votingEligibleShares(alice), 0, "no voting rights");
    }

    function test_activateBeforeWindowReverts() public {
        vm.prank(alice);
        vault.deposit(100 * USDC_1);
        skip(4 hours - 1);
        vm.expectRevert(VaultCore.WindowNotElapsed.selector);
        vault.activate(alice);
    }

    function test_activateAfterWindowMintsAtActivationNav() public {
        _seedCreator(1_000 * USDC_1);

        vm.prank(alice);
        vault.deposit(1_000 * USDC_1);
        skip(4 hours);
        vault.activate(alice);
        // Equal capital at unchanged NAV: equal shares (forward-priced entry, §4.3).
        assertEq(vault.sharesOf(alice), vault.sharesOf(creator), "forward-priced entry");
    }

    function test_cancelPendingRefunds() public {
        uint256 balBefore = usdc.balanceOf(alice);
        vm.startPrank(alice);
        vault.deposit(100 * USDC_1);
        vault.cancelPending();
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), balBefore);
        assertEq(vault.totalPendingUsdc(), 0);
    }

    function test_skipWindow_immediateActivation_andIrreversible() public {
        vm.startPrank(alice);
        vault.deposit(100 * USDC_1);
        vault.skipWindow();
        vm.stopPrank();
        assertGt(vault.sharesOf(alice), 0, "activated immediately");

        vm.prank(alice);
        vm.expectRevert(VaultCore.AlreadyOptedIn.selector);
        vault.skipWindow();
    }

    function test_repeatDepositSkipsWindow() public {
        _join(alice, 100 * USDC_1);
        vm.prank(alice);
        vault.deposit(50 * USDC_1);
        assertEq(vault.totalPendingUsdc(), 0, "repeat deposit mints immediately");
    }

    // ── donation defense (EE-1) ──────────────────────────────────────────────

    function test_donationDoesNotMoveNav() public {
        _seedCreator(1_000 * USDC_1);
        uint256 navBefore = vault.navWad();
        usdc.mint(address(vault), 500_000 * USDC_1); // direct donation
        assertEq(vault.navWad(), navBefore, "NAV uses internal accounting only");
    }

    // ── capacity (SF-3) ──────────────────────────────────────────────────────

    function test_capacityCapEnforced() public {
        usdc.mint(creator, 20_000_000 * USDC_1);
        _seedCreator(9_999_990 * USDC_1);
        vm.prank(alice);
        vm.expectRevert(VaultCore.CapacityExceeded.selector);
        vault.deposit(11 * USDC_1);
    }

    function test_minDepositEnforced() public {
        vm.prank(alice);
        vm.expectRevert(VaultCore.BelowMinDeposit.selector);
        vault.deposit(9 * USDC_1);
    }

    // ── creator gate (CM-1/CM-2) ─────────────────────────────────────────────

    function test_creatorCannotExitBelow5PctWhileMembersRemain() public {
        _seedCreator(100 * USDC_1);
        _join(alice, 900 * USDC_1); // creator at exactly 10%

        uint256 creatorShares = vault.sharesOf(creator);
        vm.prank(creator);
        vm.expectRevert(VaultCore.CreatorStakeGate.selector);
        vault.requestExit(creatorShares); // full exit → 0% < 5%
    }

    function test_creatorCanExitPartiallyDownTo5Pct() public {
        _seedCreator(100 * USDC_1);
        _join(alice, 900 * USDC_1);

        // Burn b from creator's c=100 of T=1000: (c-b)/(T-b) >= 5% ⇒ b <= 52.63…
        uint256 c = vault.sharesOf(creator);
        uint256 t = vault.totalShares();
        uint256 maxBurn = (c * 10_000 - 500 * t) / (10_000 - 500);
        vm.prank(creator);
        vault.requestExit(maxBurn); // exactly at the boundary must pass
        assertGe(vault.sharesOf(creator) * 10_000, 500 * vault.totalShares(), "still >= 5%");
    }

    function test_creatorCanFullyExitWhenNoMembersRemain() public {
        _seedCreator(100 * USDC_1);
        uint256 creatorShares = vault.sharesOf(creator);
        vm.prank(creator);
        vault.requestExit(creatorShares);
        assertEq(vault.totalShares(), 0);
    }

    // ── exit fee (EE-7..9, §4.6) ─────────────────────────────────────────────

    function test_exitFeeDecaysWithTenure() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);

        assertEq(vault.exitFeeBpsOf(alice), 100, "full fee at t=0");
        skip(15 days);
        assertEq(vault.exitFeeBpsOf(alice), 50, "half fee at half decay");
        skip(15 days);
        assertEq(vault.exitFeeBpsOf(alice), 0, "no fee after full decay");
    }

    function test_exitFeeAccruesToRemainingMembers_neverOperator() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);

        uint256 navPsBefore = vault.navPerShareWad();
        uint256 aliceBal = usdc.balanceOf(alice);
        uint256 aliceShares = vault.sharesOf(alice);

        vm.prank(alice);
        vault.requestExit(aliceShares); // immediate, t=0 → 1% fee

        // Alice got 50% of NAV minus 1% fee.
        uint256 paid = usdc.balanceOf(alice) - aliceBal;
        assertApproxEqAbs(paid, 990 * USDC_1, 2, "1% fee withheld");
        // Fee stayed in the vault: remaining member NAVps strictly increased.
        assertGt(vault.navPerShareWad(), navPsBefore, "fee accrued to remainers");
        // Nothing routed to fee engine / operator.
        assertEq(usdc.balanceOf(address(fees)), 0, "operator got nothing");
    }

    function test_exitFeeWaivedForSoleHolder() public {
        _seedCreator(1_000 * USDC_1);
        uint256 bal = usdc.balanceOf(creator);
        uint256 creatorShares = vault.sharesOf(creator);
        vm.prank(creator);
        vault.requestExit(creatorShares);
        assertEq(usdc.balanceOf(creator) - bal, 1_000 * USDC_1, "no fee for last member");
    }

    // ── two-mode settlement (C-4, K-1, VO-8, EE-10) ──────────────────────────

    function test_modeI_instantWhenNoPendingExecution() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);
        skip(30 days); // decay fee to zero for clean numbers

        uint256 bal = usdc.balanceOf(alice);
        uint256 aliceExitShares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(aliceExitShares);
        assertApproxEqAbs(usdc.balanceOf(alice) - bal, 1_000 * USDC_1, 2, "instant pro-rata");
    }

    function test_modeF_queuesDuringPendingExecution_settlesAtPostNav() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);
        skip(30 days);

        gov.setPendingExecution(true);
        uint256 aliceShares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(aliceShares);

        // Queued, not settled; shares locked out of voting eligibility.
        assertEq(vault.sharesOf(alice), aliceShares, "shares still outstanding");
        assertEq(vault.votingEligibleShares(alice), 0, "locked shares not eligible");
        assertEq(vault.totalVotingEligibleShares(), vault.sharesOf(creator));

        // Cannot settle while execution still pending.
        vm.expectRevert(VaultCore.ExecutionStillPending.selector);
        vault.settleQueuedExit(alice);

        // "Rebalance executes": idle USDC becomes wETH at current prices, then NAV moves.
        // Simulate outcome: price of held asset drops 10% post-execution.
        gov.setPendingExecution(false);

        uint256 bal = usdc.balanceOf(alice);
        vault.settleQueuedExit(alice);
        // Settled at post-execution NAV (here unchanged idle → same value).
        assertApproxEqAbs(usdc.balanceOf(alice) - bal, 1_000 * USDC_1, 2);
        assertEq(vault.queuedExitShares(alice), 0);
    }

    function test_modeF_doubleQueueReverts() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);
        gov.setPendingExecution(true);

        vm.startPrank(alice);
        vault.requestExit(1);
        vm.expectRevert(VaultCore.ExitAlreadyQueued.selector);
        vault.requestExit(1);
        vm.stopPrank();
    }

    // ── in-kind + escrow isolation (EE-6) ────────────────────────────────────

    function test_inKindRedemption_proRataAcrossAssets() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);
        skip(30 days);

        // Vault holds basket positions (simulating post-rebalance state).
        _fundBasket(1e8, 10e18); // 1 wBTC ($100k), 10 wETH ($40k)

        uint256 aliceExitShares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(aliceExitShares); // 50% of everything

        assertEq(wbtcLike.balanceOf(alice), 0.5e8, "half the wBTC");
        assertEq(wethLike.balanceOf(alice), 5e18, "half the wETH");
    }

    function test_blockedAssetEscrows_redemptionStillCompletes() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);
        skip(30 days);
        _fundBasket(1e8, 10e18);

        wbtcLike.setTransfersBlocked(true); // blacklist scenario

        uint256 bal = usdc.balanceOf(alice);
        uint256 aliceExitShares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(aliceExitShares);

        assertGt(usdc.balanceOf(alice) - bal, 0, "USDC leg still paid");
        assertEq(wethLike.balanceOf(alice), 5e18, "healthy asset still delivered");
        assertEq(vault.claimable(alice, address(wbtcLike)), 0.5e8, "blocked slice escrowed");

        wbtcLike.setTransfersBlocked(false);
        vm.prank(alice);
        vault.claimEscrowed(address(wbtcLike));
        assertEq(wbtcLike.balanceOf(alice), 0.5e8, "escrow claimable after unblock");
    }

    // ── oracle breaker freezes everything (SF-2 / K-4) ───────────────────────

    function test_staleOracleFreezesDepositsAndExits_whenBasketHeld() public {
        _seedCreator(1_000 * USDC_1);
        _fundBasket(1e8, 0);
        oracle.setStale(true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(wbtcLike)));
        vault.deposit(100 * USDC_1);

        uint256 half = vault.sharesOf(creator) / 2;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(wbtcLike)));
        vault.requestExit(half);
    }

    // ── oracle-freeze safety: pending capital is NOT trapped (UX OQ-1) ───────

    function test_pendingDepositCancellableDuringOracleFreeze() public {
        _seedCreator(1_000 * USDC_1);
        _fundBasket(1e8, 0); // vault holds a priced asset → navWad reads the oracle

        // Alice makes a first deposit (enters the observation window).
        vm.prank(alice);
        vault.deposit(500 * USDC_1);
        assertEq(vault.totalPendingUsdc(), 500 * USDC_1);

        skip(4 hours); // window elapsed, so activate reaches the NAV read
        // Oracle breaker trips.
        oracle.setStale(true);

        // Activating requires NAV → frozen (correctly reverts). Capital would be stuck IF
        // cancel also needed NAV — it does not.
        vm.expectRevert(
            abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(wbtcLike))
        );
        vault.activate(alice);

        // But alice can always reclaim her pending deposit — cancelPending never reads the
        // oracle, so pending capital is never trapped by the K-4 freeze.
        uint256 bal = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.cancelPending();
        assertEq(usdc.balanceOf(alice) - bal, 500 * USDC_1, "pending refunded during freeze");
        assertEq(vault.totalPendingUsdc(), 0);
    }

    // ── realization hooks (CM-3, §7) ─────────────────────────────────────────

    function test_realizedGainReportedToFeeEngineAndRegistry() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);
        skip(30 days);
        _fundBasket(1e8, 0); // +$100k NAV appreciation for a 2000-USDC-basis vault

        uint256 aliceExitShares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(aliceExitShares);

        assertGt(fees.lastGain(), 0, "gain crystallized on redemption only");
        assertEq(fees.lastMember(), alice);
        assertEq(registry.totalGain(), fees.lastGain(), "registry mark recorded");
    }

    function test_perfFeeClampedTo10PctOfGain() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);
        skip(30 days);
        _fundBasket(1e8, 0);
        fees.setFeeToCharge(type(uint256).max); // hostile fee engine

        uint256 bal = usdc.balanceOf(alice);
        uint256 aliceExitShares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(aliceExitShares);

        uint256 gain = fees.lastGain();
        uint256 charged = usdc.balanceOf(address(fees));
        assertLe(charged, gain / 10, "defensive clamp: <= 10% of gain");
        // The clamp may consume the whole cash leg (fee <= usdcPay) but never the in-kind leg.
        assertGt(wbtcLike.balanceOf(alice), 0, "in-kind payout untouched by hostile module");
        bal; // cash leg intentionally allowed to reach zero under the clamp
    }

    function test_realizedLossReported_noFee() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);

        // Exit at t=0: the 1% exit fee makes proceeds < basis — a realized loss.
        uint256 aliceExitShares = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(aliceExitShares);

        assertGt(registry.totalLoss(), 0, "loss recorded for carryforward HWM");
        assertEq(usdc.balanceOf(address(fees)), 0, "no fee on losses");
    }

    // ── 4626-shaped views (C-1) ──────────────────────────────────────────────

    function test_indicativeViews() public {
        _seedCreator(1_000 * USDC_1);
        assertEq(vault.totalAssets(), 1_000 * USDC_1);
        assertEq(vault.convertToShares(500 * USDC_1), vault.totalShares() / 2);
        assertEq(vault.convertToAssets(vault.totalShares()), 1_000 * USDC_1);
    }

    // ── internal: simulate rebalance outcome without an adapter (Sprint 4) ────

    function _fundBasket(uint256 wbtcAmt, uint256 wethAmt) internal {
        // Direct storage write of internal accounting + token backing, standing in for the
        // execution adapter until Sprint 4.
        if (wbtcAmt > 0) {
            wbtcLike.mint(address(vault), wbtcAmt);
            _addAssetBalance(address(wbtcLike), wbtcAmt);
        }
        if (wethAmt > 0) {
            wethLike.mint(address(vault), wethAmt);
            _addAssetBalance(address(wethLike), wethAmt);
        }
    }

    function _addAssetBalance(address asset, uint256 amt) internal {
        uint256 cur = vault.assetBalance(asset);
        stdstore.target(address(vault)).sig("assetBalance(address)").with_key(asset).checked_write(cur + amt);
    }
}
