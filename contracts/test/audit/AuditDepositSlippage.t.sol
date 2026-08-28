// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// M-15 regression — deposit-side slippage protection.
//
// M-15: `deposit` had no `minSharesOut`, so a depositor whose transaction lands against an
// anomalous NAV (H-1/H-2 price manipulation, or the general market-order risk) had no
// transaction-level defence — the user-side half of C-4/H-1/H-2. `_mintShares` mints
// `amountWad * totalShares / navWad()`, so an INFLATED NAV mints FEWER shares than a fair one:
// that is the direction that cheats an honest depositor. The fix adds an opt-in overload
// `deposit(amountUsdc, minSharesOut)` that reverts `SlippageExceeded` if the immediate-mint path
// would mint fewer than `minSharesOut`. The original `deposit(amountUsdc)` is unchanged
// (minSharesOut = 0), so existing callers and the off-chain stack are untouched.
//
// Scope, matching the fix: the check binds ONLY the immediate-mint path (returning / window-cleared
// depositor). A first-time deposit is escrowed pending and prices at activation-time NAV (the
// documented forward-pricing entry, ARCHITECTURE §4.3), so `minSharesOut` does not apply there and
// is ignored. The exit side (minValueOut) was dropped for the byte budget — see the report.

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {MockERC20, MockOracle, StubGovernance, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

contract AuditDepositSlippageTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();

        vault = new VaultCore(
            address(usdc),
            new address[](0), // pure-USDC vault: NAV == idle, so mint is exactly proportional
            address(this),
            registry,
            gov,
            fees,
            oracle,
            0, // uncapped
            1 * USDC_1,
            0,
            0,
            new address[](0),
            address(0)
        );

        usdc.mint(alice, 1_000_000 * USDC_1);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev A returning depositor on the immediate-mint path. Returns shares minted by a plain
    /// (opt-out) deposit of `amount`, so the test can assert against the exact figure.
    function _depositOptOut(uint256 amount) internal returns (uint256 minted) {
        uint256 before = vault.sharesOf(alice);
        vm.prank(alice);
        vault.deposit(amount);
        minted = vault.sharesOf(alice) - before;
    }

    function test_remediated_m15_minSharesOutBoundsTheImmediateMint() public {
        // First deposit escrows pending; skipWindow activates it and marks alice window-cleared,
        // so every later deposit takes the immediate-mint path.
        vm.startPrank(alice);
        vault.deposit(100 * USDC_1);
        vault.skipWindow();
        vm.stopPrank();

        // Measure the shares an immediate deposit of 100 USDC mints at the current (fair) NAV.
        uint256 minted = _depositOptOut(100 * USDC_1);
        assertGt(minted, 0, "immediate deposit mints");

        // Asking for MORE than the path can mint reverts — this is the honest depositor's defence
        // against landing at an anomalous NAV that would short their shares.
        vm.prank(alice);
        vm.expectRevert(VaultCore.SlippageExceeded.selector);
        vault.deposit(100 * USDC_1, minted + 1);

        // Asking for exactly what it mints succeeds.
        uint256 shBefore = vault.sharesOf(alice);
        vm.prank(alice);
        vault.deposit(100 * USDC_1, minted);
        assertEq(vault.sharesOf(alice) - shBefore, minted, "deposit with a satisfiable bound mints");

        // Opt-out (0) is the original behaviour.
        vm.prank(alice);
        vault.deposit(100 * USDC_1, 0);
    }

    /// @notice The bound applies only to the immediate path: a FIRST-time depositor's deposit is
    /// escrowed pending regardless of `minSharesOut`, which is ignored (no revert), because pending
    /// deposits price at activation, not now.
    function test_remediated_m15_firstTimeDepositIgnoresMinSharesOut() public {
        address bob = makeAddr("bob");
        usdc.mint(bob, 100 * USDC_1);
        vm.startPrank(bob);
        usdc.approve(address(vault), type(uint256).max);
        // An absurd minSharesOut does NOT revert — bob is a first-timer, so this escrows pending.
        vault.deposit(100 * USDC_1, type(uint256).max);
        vm.stopPrank();

        assertEq(vault.sharesOf(bob), 0, "first-time deposit is pending, not minted");
        (uint256 pendingAmt,) = vault.pendingDeposit(bob);
        assertEq(pendingAmt, 100 * USDC_1, "escrowed pending, minSharesOut ignored on this path");
    }
}
