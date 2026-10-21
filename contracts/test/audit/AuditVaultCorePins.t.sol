// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, stdError} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {IExecutionAdapter} from "../../src/interfaces/IExecutionAdapter.sol";
import {MockERC20, MockOracle, StubGovernance, StubRegistry} from "../mocks/Mocks.sol";
import {OracleFillAdapter} from "../VaultLedgerInvariant.t.sol";
import {RatchetPerfFeeEngine} from "./AuditExitFeeRatchet.t.sol";

/// @notice Pins three known VaultCore behaviours before the v2 freeze, so that changing any of
/// them is a deliberate edit of a named test and not a silent drift. None of them is a fix.
///
/// 1. NO TOTAL-SUPPLY FLOOR. `_checkPositionFloor` reads the exiter's own remainder, never
///    `totalShares - burnShares`. A holder whose position is below `MIN_POSITION_SHARES` can be
///    left alone in the vault after every other holder exits in full, so total supply falls below
///    the floor. PR 470 chose this over a supply floor because a supply floor traps honest members
///    (the full exit of the last large holder would revert); the test pins both halves: supply
///    does fall below the floor, and the sub-floor holder still leaves in full.
/// 2. NO SLIPPAGE BOUND ON ACTIVATION. A first deposit is escrowed pending and prices at
///    `activate`, which anyone may call once the window has elapsed and which takes no
///    `minSharesOut`. `minSharesOut` binds the immediate path only (M-15). The depositor's lever is
///    `cancelPending` before activation. Recorded as EE-13 in docs/THREAT-MODEL.md.
///    `AuditDepositSlippage.t.sol` covers the immediate path at 1:1 and the first-timer case; the
///    immediate-path test here does it after NAV per share has moved.
/// 3. NAV OF ZERO WITH SHARES OUTSTANDING. `_mintShares` divides by `navWad()`, so once NAV reads
///    zero while shares exist every mint panics (division by zero), and `cancelPending`, which
///    reads no NAV, still returns pending capital. Reached here through public entry points only:
///    a governance rebalance moves all idle USDC into an 8-decimal basket asset, then the oracle
///    reports a positive price small enough that the holding floors to zero WAD. Price zero itself
///    is refused by both oracles (MockOracle `no price`, ChainlinkOracle `answer <= 0`). On the Arc
///    launch configuration this state is not reachable for a nonzero holding: the BTC/USD feed has
///    8 decimals, so ChainlinkOracle scales every positive answer by 1e10 and a nonzero balance
///    values above zero. This is a pin of the code's boundary, not a live Arc finding.
///
/// Arc launch parameters as in `AuditExitFeeRatchet.t.sol` (capacityCapUsdc 0, minDepositUsdc
/// 100 USDC, exitFeeMaxBps 50, exitFeeDecayPeriod 604800). USDC has 6 decimals.
contract AuditVaultCorePins is Test {
    uint256 constant U = 1e6; // 1 USDC in units
    uint256 constant FLOOR = 1e18; // VaultCore.MIN_POSITION_SHARES
    bytes4 constant FLOOR_ERR = bytes4(keccak256("PositionBelowFloor()"));

    MockERC20 usdc;
    MockOracle oracle;
    StubGovernance gov;
    RatchetPerfFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address creator = makeAddr("creator"); // holds no shares
    address A = makeAddr("holderA"); // the large holder
    address B = makeAddr("cyclerB"); // the account whose exit fees move NAV per share
    address V = makeAddr("depositorV");
    address keeper = makeAddr("keeper"); // a third party with no position

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        gov = new StubGovernance();
        fees = new RatchetPerfFeeEngine();
        registry = new StubRegistry();
        vault = new VaultCore(
            address(usdc),
            new address[](0),
            creator,
            registry,
            gov,
            fees,
            oracle,
            0, // capacityCapUsdc: uncapped, as launched
            100 * U, // minDepositUsdc: Arc launch value
            50, // exitFeeMaxBps: Arc launch value
            604800, // exitFeeDecayPeriod: Arc launch value
            new address[](0),
            address(0)
        );
        address[3] memory who = [A, B, V];
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _aOpens(uint256 aSeed) internal {
        usdc.mint(A, aSeed);
        vm.startPrank(A);
        vault.deposit(aSeed);
        vault.skipWindow(); // pending deposit activates now, at 1:1 into an empty vault
        vm.stopPrank();
    }

    function _exitAll(address who) internal {
        uint256 n = vault.sharesOf(who);
        vm.prank(who);
        vault.requestExit(n);
    }

    /// B deposits and exits in full `cycles` times in one block: tenure 0, so each exit pays the
    /// full 50 bps fee, which stays in the vault and raises NAV per share for the other holders.
    function _feeCycles(uint256 bCapital, uint256 cycles) internal {
        usdc.mint(B, bCapital);
        vm.startPrank(B);
        for (uint256 i; i < cycles; ++i) {
            vault.deposit(usdc.balanceOf(B));
            if (i == 0) vault.skipWindow();
            vault.requestExit(vault.sharesOf(B));
        }
        vm.stopPrank();
    }

    // ───────────────────────── 1. no total-supply floor ─────────────────────────

    /// The state of `AuditExitFeeRatchet.test_trimToTheFloorThenRatchetIsHarmless`: V's first
    /// deposit pends, A trims to exactly the floor, B cycles 100 times, V activates into a
    /// position below the floor. A's full exit then leaves total supply at V's position, below
    /// `MIN_POSITION_SHARES`. If a total-supply floor is ever wanted, this test becomes its spec:
    /// A's exit would revert instead, and V's full exit is the case that must still pass.
    function test_supplyCanFallBelowFloorWithSubFloorHolder() public {
        uint256 victim = 190 * U;
        usdc.mint(B, 1000 * U);
        usdc.mint(V, victim);
        vm.prank(V);
        vault.deposit(victim);
        _aOpens(100 * U);
        uint256 ts = vault.totalShares();
        vm.prank(A);
        vault.requestExit(ts - FLOOR);
        assertEq(vault.totalShares(), FLOOR, "A sits exactly on the floor");
        for (uint256 i; i < 100; ++i) {
            vm.startPrank(B);
            if (i == 0) {
                vault.deposit(1000 * U);
                vault.skipWindow();
            } else {
                vault.deposit(usdc.balanceOf(B));
            }
            vault.requestExit(vault.sharesOf(B));
            vm.stopPrank();
        }
        skip(4 hours);
        vault.activate(V);
        uint256 sharesV = vault.sharesOf(V);
        assertGt(sharesV, 1, "V holds more than one share-wei");
        assertLt(sharesV, FLOOR, "V's position is below the floor");

        // The position floor still binds V: a partial exit of a sub-floor position is refused.
        vm.prank(V);
        vm.expectRevert(FLOOR_ERR);
        vault.requestExit(1);

        // No total-supply floor: A's full exit lands and leaves only V's sub-floor position.
        _exitAll(A);
        assertEq(vault.sharesOf(A), 0, "A left in full");
        assertEq(vault.totalShares(), sharesV, "supply is V's position alone");
        assertLt(vault.totalShares(), vault.MIN_POSITION_SHARES(), "total supply is below the floor");

        // And the sub-floor holder is not trapped: V, now the sole holder, leaves in full.
        _exitAll(V);
        assertEq(vault.totalShares(), 0, "V left in full");
    }

    // ───────────────────────── 2. entry slippage, both paths ─────────────────────────

    /// V's first deposit pends with a `minSharesOut` equal to what it would mint at the deposit-time
    /// price; that bound is ignored on this path. Exit fees then raise NAV per share inside the
    /// window, and a keeper with no position activates V at the new price. V receives fewer shares
    /// than the bound asked for and nothing reverts.
    function test_pendingActivationHasNoSlippageBound() public {
        _aOpens(100 * U); // 100e18 shares against 100 USDC of NAV
        uint256 dep = 1000 * U;
        uint256 atDeposit = dep * 1e12 * vault.totalShares() / vault.navWad();
        assertEq(atDeposit, 1000e18, "deposit-time price is 1:1");

        usdc.mint(V, dep);
        vm.prank(V);
        vault.deposit(dep, atDeposit); // first deposit: pending, the bound does not apply
        assertEq(vault.sharesOf(V), 0, "pending, no shares yet");
        (uint256 pending,) = vault.pendingDeposit(V);
        assertEq(pending, dep, "escrowed in full");

        _feeCycles(1000 * U, 4); // NAV per share rises while V waits
        skip(4 hours);

        uint256 expected = dep * 1e12 * vault.totalShares() / vault.navWad();
        assertLt(expected, atDeposit, "NAV per share moved against V inside the window");

        vm.prank(keeper);
        vault.activate(V); // permissionless, no slippage argument
        assertEq(vault.sharesOf(V), expected, "minted at activation-time NAV, floored");
        assertLt(vault.sharesOf(V), atDeposit, "below the bound V passed at deposit, and nothing reverted");
    }

    /// A returning depositor (immediate path) after NAV per share has moved: a bound one share-wei
    /// above what the deposit mints reverts `SlippageExceeded`, as does the stale 1:1 figure; the
    /// exact figure passes and mints exactly that.
    function test_immediateDepositHonoursMinSharesOut() public {
        _aOpens(100 * U);
        _feeCycles(1000 * U, 4);
        uint256 amt = 100 * U;
        usdc.mint(A, amt);
        uint256 expected = amt * 1e12 * vault.totalShares() / vault.navWad();
        assertLt(expected, amt * 1e12, "NAV per share moved: fewer than 1:1");

        vm.startPrank(A);
        vm.expectRevert(VaultCore.SlippageExceeded.selector);
        vault.deposit(amt, expected + 1);
        vm.expectRevert(VaultCore.SlippageExceeded.selector);
        vault.deposit(amt, amt * 1e12); // a quote taken at the old 1:1 price
        uint256 before = vault.sharesOf(A);
        vault.deposit(amt, expected);
        vm.stopPrank();
        assertEq(vault.sharesOf(A) - before, expected, "the exact bound passes and mints it");
    }
}

/// @notice Pin 3 from the header of `AuditVaultCorePins`: NAV of zero with shares outstanding.
contract AuditVaultCoreNavZeroPin is Test {
    uint256 constant U = 1e6;

    MockERC20 usdc;
    MockERC20 btc; // 8 decimals, like cirBTC
    MockOracle oracle;
    StubGovernance gov;
    RatchetPerfFeeEngine fees;
    StubRegistry registry;
    OracleFillAdapter adapter;
    VaultCore vault;

    address creator = makeAddr("creator");
    address A = makeAddr("holderA");
    address V = makeAddr("depositorV");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        btc = new MockERC20("BTC", 8);
        oracle = new MockOracle();
        oracle.setPrice(address(btc), 100_000e18);
        gov = new StubGovernance();
        fees = new RatchetPerfFeeEngine();
        registry = new StubRegistry();
        adapter = new OracleFillAdapter(oracle, address(usdc));
        address[] memory basket = new address[](1);
        basket[0] = address(btc);
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
            100 * U,
            50,
            604800,
            adapters,
            address(0)
        );
        vm.prank(A);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(V);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// A holds every share; V's first deposit pends. A governance rebalance moves every idle unit
    /// into BTC (1e5 units at 100,000 USD), then the oracle reports 1 wei WAD per BTC: positive, and
    /// 1e5 * 1 / 1e8 floors to zero. NAV is zero with 100e18 shares outstanding. A's deposit, a
    /// keeper's `activate(V)` and V's `skipWindow` all panic on the division in `_mintShares`;
    /// `cancelPending` still returns V's escrow in full.
    function test_navZeroWithSharesRevertsDeposit() public {
        usdc.mint(A, 200 * U);
        vm.startPrank(A);
        vault.deposit(100 * U);
        vault.skipWindow();
        vm.stopPrank();
        usdc.mint(V, 100 * U);
        vm.prank(V);
        vault.deposit(100 * U); // pending

        uint256 idle = vault.idleUsdc();
        assertEq(idle, 100 * U, "only A's capital is in NAV");
        IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](1);
        orders[0] = IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(btc),
            amountIn: idle,
            minAmountOut: adapter.quote(address(usdc), address(btc), idle),
            deadline: block.timestamp,
            routeData: ""
        });
        vm.prank(address(gov));
        vault.executeRebalance(address(adapter), 200, orders);
        assertEq(vault.idleUsdc(), 0, "no idle USDC left");
        assertEq(vault.assetBalance(address(btc)), 1e5, "0.001 BTC held");
        assertGt(vault.navWad(), 0, "priced at 100,000 USD the holding has value");

        oracle.setPrice(address(btc), 1); // positive: zero itself is refused by the oracle
        assertEq(vault.navWad(), 0, "the holding floors to zero WAD");
        assertEq(vault.totalShares(), 100e18, "shares are outstanding");

        vm.prank(A);
        vm.expectRevert(stdError.divisionError);
        vault.deposit(100 * U); // returning holder: immediate mint

        skip(4 hours);
        vm.expectRevert(stdError.divisionError);
        vault.activate(V);
        vm.prank(V);
        vm.expectRevert(stdError.divisionError);
        vault.skipWindow();

        uint256 before = usdc.balanceOf(V);
        vm.prank(V);
        vault.cancelPending(); // reads no NAV
        assertEq(usdc.balanceOf(V) - before, 100 * U, "pending capital returned in full");
        (uint256 pending,) = vault.pendingDeposit(V);
        assertEq(pending, 0, "nothing left pending");
    }
}
