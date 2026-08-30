// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {MockERC20, MockOracle, StubFeeEngine, StubGovernance, StubRegistry} from "../mocks/Mocks.sol";

/// @notice AUDIT ARTIFACT — Slither `divide-before-multiply`, `_settleExit` L574 / L595.
///
/// Both pro-rata legs of an exit used to be computed as `x * burnShares / ts * keepBps / BPS`:
/// the division by `ts` ran BEFORE the multiplication by `keepBps`, so the `x * burnShares mod ts`
/// remainder was discarded and could never contribute to the exiter's slice. Reordered to
/// `x * burnShares * keepBps / (ts * BPS)`, which divides once.
///
/// The recoverable amount is exactly 0 or 1 unit of the leg's smallest denomination per exit
/// (`new - old ∈ {0,1}`, since the recovered term `r*k/(ts*BPS) < k/BPS ≤ 1`). Truncation always
/// favoured the vault, so the old behaviour was never a solvency or loss risk — it was dust
/// stranded from the exiter. Both formulas still floor, so §4.6 (NAVps non-decreasing) is
/// unaffected either way.
///
/// The fix is a strict no-op when `keepBps == BPS`, so this fixture deliberately carries a live
/// tenure exit fee and an exiter who is neither the sole holder nor past the decay period.
contract AuditExitSliceRoundingTest is Test {
    using stdStorage for StdStorage;

    // An 18-decimal settlement token (DAI's shape; legal here — the constructor requires only
    // 6 ≤ decimals ≤ 18). This makes `usdcScalar == 1`, so the cash leg's rounding is visible in
    // the member's own balance instead of being floored away by USDC's 6-decimal granularity.
    uint256 constant D_CREATOR = 1_000e18;
    uint256 constant D_ALICE = 3_000e18;
    uint256 constant WETH_SEEDED = 1e18 + 7;

    // Derived from the fixture, verified in `test_fixtureShapeIsTheOneTheDefectNeeds`.
    uint256 constant TS_AT_EXIT = 1_599_999_999_999_999_996_640;
    uint256 constant ALICE_SHARES = 599_999_999_999_999_996_640;

    // keepBps = 9_900 (1% tenure fee, tenure 0). The two legs, computed both ways:
    uint256 constant CASH_DIVIDE_FIRST = 1_484_999_999_999_999_994_801; // old, loses 1
    uint256 constant CASH_DIVIDE_ONCE = 1_484_999_999_999_999_994_802; // new
    uint256 constant SLICE_DIVIDE_FIRST = 371_250_000_000_000_000; // old, loses 1
    uint256 constant SLICE_DIVIDE_ONCE = 371_250_000_000_000_001; // new

    MockERC20 dai; // settlement token, 18 decimals
    MockERC20 weth; // basket asset, 18 decimals
    MockOracle oracle;
    StubFeeEngine fees;
    StubGovernance gov;
    StubRegistry registry;
    VaultCore vault;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_000_000);
        dai = new MockERC20("DAI", 18);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        fees = new StubFeeEngine();
        gov = new StubGovernance();
        registry = new StubRegistry();
        oracle.setPrice(address(weth), 4_000e18);

        address[] memory basket = new address[](1);
        basket[0] = address(weth);

        vault = new VaultCore(
            address(dai),
            basket,
            creator,
            registry,
            gov,
            fees,
            oracle,
            0, // uncapped
            1e18, // min deposit
            100, // 1% tenure exit fee — without it keepBps == BPS and the fix is a no-op
            30 days,
            new address[](0),
            address(0)
        );

        for (uint160 i; i < 2; ++i) {
            address who = i == 0 ? creator : alice;
            dai.mint(who, 1_000_000e18);
            vm.prank(who);
            dai.approve(address(vault), type(uint256).max);
        }
    }

    function _join(address who, uint256 amount) internal {
        vm.startPrank(who);
        vault.deposit(amount);
        vault.skipWindow();
        vm.stopPrank();
    }

    /// @dev Stands in for the execution adapter: puts a basket position on the books together
    /// with the tokens backing it. Seeded BETWEEN the two deposits so NAV per share is no longer
    /// exactly 1 — that is what makes `assetBalance * burnShares` leave a remainder mod `ts`.
    function _seedBasket(uint256 amount) internal {
        weth.mint(address(vault), amount);
        stdstore.target(address(vault)).sig("assetBalance(address)").with_key(address(weth))
            .checked_write(amount);
    }

    function _setUpExitFixture() internal {
        _join(creator, D_CREATOR);
        _seedBasket(WETH_SEEDED);
        _join(alice, D_ALICE); // prices against the seeded NAV ⇒ ts != idle
    }

    /// @notice The fixture must actually reach the arithmetic corner, or the assertions below
    /// pass for free. Pins every input the two slice formulas read.
    function test_fixtureShapeIsTheOneTheDefectNeeds() public {
        _setUpExitFixture();

        assertEq(vault.totalShares(), TS_AT_EXIT, "ts");
        assertEq(vault.sharesOf(alice), ALICE_SHARES, "burnShares");
        assertEq(vault.idleUsdc(), D_CREATOR + D_ALICE, "idle");
        assertEq(vault.assetBalance(address(weth)), WETH_SEEDED, "basket");
        assertEq(vault.exitFeeBpsOf(alice), 100, "tenure fee live: keepBps = 9_900");
        assertTrue(vault.sharesOf(alice) < vault.totalShares(), "not the sole holder");

        uint256 ts = TS_AT_EXIT;
        uint256 b = ALICE_SHARES;
        uint256 keepBps = 9_900;
        uint256 bps = 10_000;

        // The cash leg: `usdcScalar == 1`, no children, so the target is idle * b/ts * keep/BPS.
        uint256 idleWad = D_CREATOR + D_ALICE;
        assertEq(idleWad * b / ts * keepBps / bps, CASH_DIVIDE_FIRST, "cash, divide-first");
        assertEq(idleWad * b * keepBps / (ts * bps), CASH_DIVIDE_ONCE, "cash, divide-once");

        assertEq(WETH_SEEDED * b / ts * keepBps / bps, SLICE_DIVIDE_FIRST, "in-kind, divide-first");
        assertEq(WETH_SEEDED * b * keepBps / (ts * bps), SLICE_DIVIDE_ONCE, "in-kind, divide-once");
    }

    /// @notice REGRESSION: both legs must be the divide-once value. Under the old ordering each
    /// is one unit lower and this fails on both assertions.
    function test_exitPaysTheDivideOnceSliceOnBothLegs() public {
        _setUpExitFixture();

        uint256 daiBefore = dai.balanceOf(alice);
        uint256 wethBefore = weth.balanceOf(alice);

        vm.prank(alice);
        vault.requestExit(ALICE_SHARES);

        // No performance fee is charged here (the exit realizes a loss against basis, and
        // StubFeeEngine charges 0 regardless), so the member receives each leg whole.
        assertEq(vault.claimable(alice, address(dai)), 0, "cash delivered, not escrowed");
        assertEq(vault.claimable(alice, address(weth)), 0, "in-kind delivered, not escrowed");

        assertEq(weth.balanceOf(alice) - wethBefore, SLICE_DIVIDE_ONCE, "in-kind leg");
        assertEq(dai.balanceOf(alice) - daiBefore, CASH_DIVIDE_ONCE, "cash leg");
    }

    /// @notice The property the reorder must not break: it still rounds DOWN, so the exiter never
    /// takes more than an exact pro-rata share net of the fee, and NAV per share for the members
    /// who stay is non-decreasing (§4.6). This is a DIRECTIONAL guard, not a regression test — it
    /// holds under both orderings by design. Do not tighten it into a copy of the test above.
    function test_reorderStillRoundsDownAndDoesNotDilateNavPerShare() public {
        _setUpExitFixture();

        uint256 daiBefore = dai.balanceOf(alice);
        uint256 wethBefore = weth.balanceOf(alice);
        uint256 navPsBefore = vault.navWad() * 1e18 / vault.totalShares();

        vm.prank(alice);
        vault.requestExit(ALICE_SHARES);

        assertLe(
            dai.balanceOf(alice) - daiBefore,
            (D_CREATOR + D_ALICE) * ALICE_SHARES * 9_900 / (TS_AT_EXIT * 10_000),
            "cash leg never exceeds the exact fee-netted pro-rata share"
        );
        assertLe(
            weth.balanceOf(alice) - wethBefore,
            WETH_SEEDED * ALICE_SHARES * 9_900 / (TS_AT_EXIT * 10_000),
            "in-kind leg never exceeds the exact fee-netted pro-rata share"
        );
        assertGe(vault.navWad() * 1e18 / vault.totalShares(), navPsBefore, "NAV per share non-decreasing");
    }
}
