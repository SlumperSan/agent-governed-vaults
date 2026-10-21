// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle, StubGovernance, StubFeeEngine, StubRegistry} from "./mocks/Mocks.sol";
import {OracleFillAdapter} from "./VaultLedgerInvariant.t.sol";

/// @notice Cloud R1 stateless fuzz properties for VaultCore: deposits, withdrawals, share
/// accounting, the oracle freeze, and access control on every governance-only entry point.
contract VaultPropertiesFuzzTest is Test {
    uint256 constant USDC_1 = 1e6;
    uint256 constant BPS = 10_000;

    VaultCore vault;
    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    OracleFillAdapter adapter;

    address creator = makeAddr("fz-creator");
    address alice = makeAddr("fz-alice");
    address bob = makeAddr("fz-bob");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("WETH", 18);
        oracle = new MockOracle();
        oracle.setPrice(address(weth), 3_000e18);
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();
        adapter = new OracleFillAdapter(oracle, address(usdc));

        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);

        vault = new VaultCore(
            address(usdc),
            basket,
            creator,
            registry,
            gov,
            fees,
            oracle,
            0,
            10 * USDC_1,
            100,
            30 days,
            adapters,
            address(0)
        );

        address[3] memory who = [creator, alice, bob];
        for (uint256 i; i < 3; ++i) {
            usdc.mint(who[i], 1_000_000_000 * USDC_1);
            vm.startPrank(who[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.skipWindow(); // mint immediately; the window has its own unit tests
            vm.stopPrank();
        }
    }

    function _deposit(address who, uint256 amt) internal {
        vm.prank(who);
        vault.deposit(amt);
    }

    /// Move `bps` of idle USDC into WETH at a fair oracle fill, so exits carry an in-kind leg.
    function _investFraction(uint256 bps) internal {
        uint256 amountIn = vault.idleUsdc() * bps / BPS;
        if (amountIn == 0) return;
        uint256 minOut = adapter.quote(address(usdc), address(weth), amountIn);
        IExecutionAdapter.SwapOrder[] memory o = new IExecutionAdapter.SwapOrder[](1);
        o[0] =
            IExecutionAdapter.SwapOrder(address(usdc), address(weth), amountIn, minOut, block.timestamp, "");
        vm.prank(address(gov));
        vault.executeRebalance(address(adapter), 200, o);
    }

    function _valueOf(address who) internal view returns (uint256) {
        return usdc.balanceOf(who) * 1e12 + weth.balanceOf(who) * oracle.price(address(weth)) / 1e18;
    }

    // ───────────────────────────── deposits ─────────────────────────────

    /// A deposit never dilutes existing holders: NAVps after >= NAVps before.
    function testFuzz_depositNeverDilutes(uint256 a, uint256 b, uint256 investBps, uint256 priceBps) public {
        a = bound(a, 10 * USDC_1, 50_000_000 * USDC_1);
        b = bound(b, 10 * USDC_1, 50_000_000 * USDC_1);
        _deposit(alice, a);
        _investFraction(bound(investBps, 0, BPS));
        oracle.setPrice(address(weth), 3_000e18 * bound(priceBps, 1_000, 50_000) / BPS);

        uint256 psBefore = vault.navPerShareWad();
        uint256 aliceShares = vault.sharesOf(alice);
        _deposit(bob, b);
        assertGe(vault.navPerShareWad(), psBefore, "deposit diluted NAVps");
        assertEq(vault.sharesOf(alice), aliceShares, "deposit touched another member");
        // The depositor's new position is worth no more than what they paid (rounds against them).
        uint256 bobValueWad = vault.navWad() * vault.sharesOf(bob) / vault.totalShares();
        assertLe(bobValueWad, b * 1e12, "depositor minted more value than paid");
    }

    /// Received USDC is what gets accounted, and the token balance moves by exactly that.
    function testFuzz_depositAccountsExactly(uint256 a) public {
        a = bound(a, 10 * USDC_1, 100_000_000 * USDC_1);
        uint256 idleBefore = vault.idleUsdc();
        uint256 balBefore = usdc.balanceOf(address(vault));
        _deposit(alice, a);
        assertEq(vault.idleUsdc() - idleBefore, a, "idle != received");
        assertEq(usdc.balanceOf(address(vault)) - balBefore, a, "balance != received");
        assertEq(vault.costBasisUsdc(alice), a, "cost basis != received");
    }

    /// A first-time depositor who has not skipped the window is escrowed: no shares, no NAV,
    /// and cancelPending returns exactly the escrow.
    function testFuzz_pendingEscrowRoundTrip(uint256 a) public {
        address carol = makeAddr("fz-carol");
        a = bound(a, 10 * USDC_1, 100_000_000 * USDC_1);
        usdc.mint(carol, a);
        vm.startPrank(carol);
        usdc.approve(address(vault), a);
        uint256 navBefore = vault.navWad();
        vault.deposit(a);
        assertEq(vault.sharesOf(carol), 0, "pending minted shares");
        assertEq(vault.navWad(), navBefore, "pending entered NAV");
        assertEq(vault.totalPendingUsdc(), a, "pending not escrowed");
        vault.cancelPending();
        vm.stopPrank();
        assertEq(usdc.balanceOf(carol), a, "cancel did not return escrow");
        assertEq(vault.totalPendingUsdc(), 0, "escrow left behind");
    }

    // ───────────────────────────── withdrawals ─────────────────────────────

    /// A deposit then exit at static prices never returns more value than was put in.
    function testFuzz_roundTripNoFreeValue(
        uint256 a,
        uint256 b,
        uint256 investBps,
        uint256 dt,
        uint256 burnBps
    ) public {
        a = bound(a, 10 * USDC_1, 50_000_000 * USDC_1);
        b = bound(b, 10 * USDC_1, 50_000_000 * USDC_1);
        _deposit(alice, a);
        _investFraction(bound(investBps, 0, BPS));
        uint256 bobBefore = _valueOf(bob);
        _deposit(bob, b);
        vm.warp(block.timestamp + bound(dt, 0, 60 days));

        uint256 held = vault.sharesOf(bob);
        uint256 burn = held * bound(burnBps, 1, BPS) / BPS;
        if (held - burn < vault.MIN_POSITION_SHARES()) burn = held;
        if (burn == 0) return;
        vm.prank(bob);
        vault.requestExit(burn);
        assertLe(_valueOf(bob), bobBefore, "round trip produced value");
    }

    /// An exit never lowers NAVps for the members who stay (exit fee and rounding stay inside).
    function testFuzz_exitNeverLowersNavPs(
        uint256 a,
        uint256 b,
        uint256 investBps,
        uint256 dt,
        uint256 burnBps
    ) public {
        a = bound(a, 10 * USDC_1, 50_000_000 * USDC_1);
        b = bound(b, 10 * USDC_1, 50_000_000 * USDC_1);
        _deposit(alice, a);
        _deposit(bob, b);
        _investFraction(bound(investBps, 0, BPS));
        vm.warp(block.timestamp + bound(dt, 0, 60 days));

        uint256 held = vault.sharesOf(bob);
        uint256 burn = held * bound(burnBps, 1, BPS) / BPS;
        if (held - burn < vault.MIN_POSITION_SHARES()) burn = held;
        if (burn == 0) return;
        uint256 psBefore = vault.navPerShareWad();
        uint256 aliceShares = vault.sharesOf(alice);
        vm.prank(bob);
        vault.requestExit(burn);
        // One WAD wei of nav rounding in the in-kind leg, scaled by 1e18 / remaining supply.
        assertGe(vault.navPerShareWad() + 1 + 1e18 / vault.totalShares(), psBefore, "exit lowered NAVps");
        assertEq(vault.sharesOf(alice), aliceShares, "exit touched another member");
    }

    /// Exiting debits internal accounting by exactly what left the vault's balances.
    function testFuzz_exitConservesTokens(uint256 a, uint256 investBps, uint256 burnBps) public {
        a = bound(a, 10 * USDC_1, 50_000_000 * USDC_1);
        _deposit(alice, a);
        _deposit(bob, a / 2 + 10 * USDC_1);
        _investFraction(bound(investBps, 0, BPS));
        uint256 held = vault.sharesOf(alice);
        uint256 burn = held * bound(burnBps, 1, BPS) / BPS;
        if (held - burn < vault.MIN_POSITION_SHARES()) burn = held;
        if (burn == 0) return;

        uint256 idle0 = vault.idleUsdc();
        uint256 weth0 = vault.assetBalance(address(weth));
        uint256 u0 = usdc.balanceOf(address(vault));
        uint256 w0 = weth.balanceOf(address(vault));
        vm.prank(alice);
        vault.requestExit(burn);
        assertEq(u0 - usdc.balanceOf(address(vault)), idle0 - vault.idleUsdc(), "usdc out != idle debit");
        assertEq(
            w0 - weth.balanceOf(address(vault)),
            weth0 - vault.assetBalance(address(weth)),
            "weth out != debit"
        );
    }

    /// A blacklisted exiter's payout is escrowed, not lost, and claimable once delisted.
    function testFuzz_blacklistedExitEscrows(uint256 a, uint256 investBps) public {
        a = bound(a, 10 * USDC_1, 50_000_000 * USDC_1);
        _deposit(alice, a);
        _deposit(bob, a);
        _investFraction(bound(investBps, 0, BPS));
        usdc.setBlacklisted(bob, true);
        weth.setBlacklisted(bob, true);
        uint256 idle0 = vault.idleUsdc();
        uint256 weth0 = vault.assetBalance(address(weth));
        uint256 held = vault.sharesOf(bob);
        vm.prank(bob);
        vault.requestExit(held);
        assertEq(vault.claimable(bob, address(usdc)), idle0 - vault.idleUsdc(), "usdc payout not escrowed");
        assertEq(
            vault.claimable(bob, address(weth)),
            weth0 - vault.assetBalance(address(weth)),
            "weth not escrowed"
        );

        usdc.setBlacklisted(bob, false);
        weth.setBlacklisted(bob, false);
        uint256 cu = vault.claimable(bob, address(usdc));
        uint256 ub = usdc.balanceOf(bob);
        if (cu > 0) {
            vm.prank(bob);
            vault.claimEscrowed(address(usdc));
            assertEq(usdc.balanceOf(bob) - ub, cu, "claim short");
            assertEq(vault.claimable(bob, address(usdc)), 0, "escrow not cleared");
        }
    }

    /// Whatever the fee module asks for, the vault withholds at most 10% of the realized gain,
    /// and the member plus the fee engine together receive exactly the payout.
    function testFuzz_performanceFeeClampedToTenthOfGain(
        uint256 a,
        uint256 investBps,
        uint256 upBps,
        uint256 ask
    ) public {
        a = bound(a, 10 * USDC_1, 50_000_000 * USDC_1);
        _deposit(alice, a);
        _investFraction(bound(investBps, 100, BPS));
        oracle.setPrice(address(weth), 3_000e18 * (BPS + bound(upBps, 1, 50_000)) / BPS);
        fees.setFeeToCharge(bound(ask, 0, type(uint128).max));
        vm.warp(block.timestamp + 31 days); // past exit-fee decay

        uint256 aliceBefore = _valueOf(alice);
        uint256 feeBefore = _valueOf(address(fees));
        uint256 held = vault.sharesOf(alice);
        vm.prank(alice);
        vault.requestExit(held);
        uint256 toAlice = _valueOf(alice) - aliceBefore;
        uint256 toFee = _valueOf(address(fees)) - feeBefore;
        uint256 payout = toAlice + toFee;
        if (payout <= a * 1e12) {
            assertEq(toFee, 0, "fee taken on a loss");
            return;
        }
        uint256 gainWad = payout - a * 1e12;
        // One USDC unit of slack: the vault floors the gain to USDC units before clamping.
        assertLe(toFee, gainWad / 10 + 1e12, "fee above 10% of gain");
    }

    // ───────────────────────────── oracle freeze ─────────────────────────────

    /// VaultCore has no pause switch; a stale oracle is its freeze. While it holds, deposits,
    /// exits and activations revert StaleOracle, state is untouched, and cancelPending still
    /// returns the escrow.
    function testFuzz_staleOracleFreezesValuePaths(uint256 a, uint256 investBps) public {
        a = bound(a, 10 * USDC_1, 50_000_000 * USDC_1);
        _deposit(alice, a);
        _investFraction(bound(investBps, 100, BPS));

        address carol = makeAddr("fz-carol");
        usdc.mint(carol, a);
        vm.prank(carol);
        usdc.approve(address(vault), a);
        vm.prank(carol);
        vault.deposit(a); // pending

        oracle.setStale(true);
        uint256 ts = vault.totalShares();
        uint256 idle = vault.idleUsdc();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(weth)));
        vault.deposit(a);

        uint256 held = vault.sharesOf(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(weth)));
        vault.requestExit(held);

        vm.warp(block.timestamp + vault.OBSERVATION_WINDOW());
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(weth)));
        vault.activate(carol);

        assertEq(vault.totalShares(), ts, "shares moved while frozen");
        assertEq(vault.idleUsdc(), idle, "idle moved while frozen");

        vm.prank(carol);
        vault.cancelPending();
        assertEq(usdc.balanceOf(carol), a, "cancel failed while frozen");
    }

    // ───────────────────────────── access control ─────────────────────────────

    /// Every governance-only entry point refuses every other caller with OnlyGovernance.
    function testFuzz_onlyGovernanceGates(address caller, address child, uint256 amt) public {
        vm.assume(caller != address(gov));
        _deposit(alice, 1_000 * USDC_1);
        IExecutionAdapter.SwapOrder[] memory o = new IExecutionAdapter.SwapOrder[](0);

        vm.prank(caller);
        vm.expectRevert(VaultCore.OnlyGovernance.selector);
        vault.executeRebalance(address(adapter), 100, o);

        vm.prank(caller);
        vm.expectRevert(VaultCore.OnlyGovernance.selector);
        vault.allocateToChild(child, amt);

        vm.prank(caller);
        vm.expectRevert(VaultCore.OnlyGovernance.selector);
        vault.redeemFromChild(child, amt);
    }

    /// Governance itself is bounded: a rebalance may only route through the allowlisted venue,
    /// only into USDC or basket assets, and only under a bound in (0, MAX_REBALANCE_SLIPPAGE_BPS].
    function testFuzz_governanceRebalanceBounded(address venue, address tokenOut, uint256 slip) public {
        _deposit(alice, 1_000 * USDC_1);
        IExecutionAdapter.SwapOrder[] memory o = new IExecutionAdapter.SwapOrder[](0);

        vm.assume(venue != address(adapter));
        vm.prank(address(gov));
        vm.expectRevert(VaultCore.AdapterNotAllowed.selector);
        vault.executeRebalance(venue, 100, o);

        uint256 max = vault.MAX_REBALANCE_SLIPPAGE_BPS();
        slip = slip % 2 == 0 ? 0 : bound(slip, max + 1, type(uint256).max);
        vm.prank(address(gov));
        vm.expectRevert(VaultCore.BadSlippageBound.selector);
        vault.executeRebalance(address(adapter), slip, o);

        vm.assume(tokenOut != address(usdc) && tokenOut != address(weth));
        IExecutionAdapter.SwapOrder[] memory bad = new IExecutionAdapter.SwapOrder[](1);
        bad[0] = IExecutionAdapter.SwapOrder(address(usdc), tokenOut, 100 * USDC_1, 1, block.timestamp, "");
        vm.prank(address(gov));
        vm.expectRevert(VaultCore.BadSwapToken.selector);
        vault.executeRebalance(address(adapter), 100, bad);
    }

    /// A rebalance whose minOut gives up more than the declared bound against the oracle is
    /// refused before any funds move.
    function testFuzz_rebalanceRefusesLooseMinOut(uint256 amountIn, uint256 slip, uint256 extraBps) public {
        _deposit(alice, 100_000 * USDC_1);
        amountIn = bound(amountIn, USDC_1, vault.idleUsdc());
        slip = bound(slip, 1, vault.MAX_REBALANCE_SLIPPAGE_BPS());
        extraBps = bound(extraBps, 1, BPS - slip);
        uint256 fairOut = adapter.quote(address(usdc), address(weth), amountIn);
        uint256 minOut = fairOut * (BPS - slip - extraBps) / BPS;
        IExecutionAdapter.SwapOrder[] memory o = new IExecutionAdapter.SwapOrder[](1);
        o[0] =
            IExecutionAdapter.SwapOrder(address(usdc), address(weth), amountIn, minOut, block.timestamp, "");
        uint256 idle = vault.idleUsdc();
        vm.prank(address(gov));
        vm.expectRevert(VaultCore.MinOutTooLow.selector);
        vault.executeRebalance(address(adapter), slip, o);
        assertEq(vault.idleUsdc(), idle, "funds moved on a refused rebalance");
    }

    /// Nobody can exit, claim or cancel on another member's behalf: each acts on msg.sender only.
    function testFuzz_memberActionsAreSelfOnly(address attacker, uint256 a) public {
        vm.assume(attacker != alice && attacker != address(0) && attacker != address(vault));
        a = bound(a, 10 * USDC_1, 50_000_000 * USDC_1);
        _deposit(alice, a);
        uint256 aliceShares = vault.sharesOf(alice);

        vm.prank(attacker);
        vm.expectRevert(VaultCore.InsufficientShares.selector);
        vault.requestExit(aliceShares);

        vm.prank(attacker);
        vm.expectRevert(VaultCore.NothingToClaim.selector);
        vault.claimEscrowed(address(usdc));

        vm.prank(attacker);
        vm.expectRevert(VaultCore.NoPending.selector);
        vault.cancelPending();

        assertEq(vault.sharesOf(alice), aliceShares, "attacker moved alice's shares");
    }
}
