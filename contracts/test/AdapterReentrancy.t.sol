// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AggregationRouterAdapter} from "../src/AggregationRouterAdapter.sol";
import {DirectPoolAdapter, IUniswapV2Pair} from "../src/DirectPoolAdapter.sol";
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";
import {MockERC20} from "./mocks/Mocks.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Slither `reentrancy-balance` (High) triage, 2026-09-01 — the ONE row of eight
// that is a real defect: `AggregationRouterAdapter.executeSwap`.
//
// Every `IExecutionAdapter` settles on a MEASURED balance delta (EX-3) while holding an
// order's funds transiently. A nested `executeSwap` therefore measures the OUTER order's
// in-flight balance. In the aggregation adapter that is directly monetisable, because the
// trailing "sweep unspent input back to the caller" returns `balanceOf(tokenIn)` — the
// adapter's WHOLE balance, including the outer order's unspent input — to the INNER call's
// `msg.sender`. The inner `safeApprove(router, 0)` also revokes the outer call's approval.
//
// The attacker is NOT the router. The router is pinned immutable (EX-2) and its selector is
// allowlisted (EX-1); it stays honest here. The attacker is a counterparty reached THROUGH
// the route — the maker side of a fill — which is exactly the position an aggregation router
// hands to arbitrary contracts.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Honest pinned aggregation router. Partially fills — pulls `pull` of the approved
/// input and hands back `deliver` of the output — and calls the counterparty in between,
/// which is where a real aggregator gives a maker contract control.
contract PartialFillRouter {
    HostileMaker public maker;

    function setMaker(HostileMaker m) external {
        maker = m;
    }

    function route(address tokenIn, address tokenOut, uint256 pull, uint256 deliver) external {
        address adapter = msg.sender;
        if (pull > 0) MockERC20(tokenIn).transferFrom(adapter, address(this), pull);
        if (address(maker) != address(0)) maker.onRoute();
        if (deliver > 0) MockERC20(tokenOut).mint(adapter, deliver);
    }
}

/// @dev The counterparty. Re-enters the adapter once, with a 1-unit order, purely so the
/// nested call's `leftover` sweep pays it the outer order's unspent input.
contract HostileMaker {
    AggregationRouterAdapter public adapter;
    MockERC20 public tokenIn;
    MockERC20 public tokenOut;
    bool public armed;
    bool public reentered;
    bytes4 public lastRevert;

    function arm(AggregationRouterAdapter a, MockERC20 tIn, MockERC20 tOut) external {
        adapter = a;
        tokenIn = tIn;
        tokenOut = tOut;
        armed = true;
        tIn.mint(address(this), 1);
        tIn.approve(address(a), type(uint256).max);
    }

    function onRoute() external {
        if (!armed) return;
        armed = false; // one shot; the nested route call must not recurse further
        IExecutionAdapter.SwapOrder memory o = IExecutionAdapter.SwapOrder({
            tokenIn: address(tokenIn),
            tokenOut: address(tokenOut),
            amountIn: 1,
            minAmountOut: 1,
            deadline: block.timestamp,
            routeData: abi.encodeCall(PartialFillRouter.route, (address(tokenIn), address(tokenOut), 1, 1))
        });
        try adapter.executeSwap(o) {
            reentered = true;
        } catch (bytes memory err) {
            lastRevert = bytes4(err);
        }
    }
}

/// @dev A pinned V2-style pair that re-enters on `swap`. `DirectPoolAdapter` has no
/// `leftover` sweep and never moves more than its own measured delta, so re-entry there was
/// NOT shown to extract value — it can only shrink the outer delta, which fails closed on
/// `Slippage`. The guard is pinned as an interface-level invariant, not as a loss fix.
contract ReentrantPair is IUniswapV2Pair {
    address public token0;
    address public token1;
    uint112 private r0;
    uint112 private r1;
    DirectPoolAdapter public adapter;
    bool public armed;
    bool public reentered;
    bytes4 public lastRevert;

    constructor(address t0, address t1, uint112 res0, uint112 res1) {
        token0 = t0;
        token1 = t1;
        r0 = res0;
        r1 = res1;
    }

    function arm(DirectPoolAdapter a) external {
        adapter = a;
        armed = true;
        MockERC20(token0).mint(address(this), 1_000e18);
        MockERC20(token0).approve(address(a), type(uint256).max);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, uint32(block.timestamp));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        if (armed) {
            armed = false;
            IExecutionAdapter.SwapOrder memory o = IExecutionAdapter.SwapOrder({
                tokenIn: token0,
                tokenOut: token1,
                amountIn: 1e18,
                minAmountOut: 1,
                deadline: block.timestamp,
                routeData: ""
            });
            try adapter.executeSwap(o) {
                reentered = true;
            } catch (bytes memory err) {
                lastRevert = bytes4(err);
            }
        }
        if (amount0Out > 0) MockERC20(token0).mint(to, amount0Out);
        if (amount1Out > 0) MockERC20(token1).mint(to, amount1Out);
    }
}

contract AdapterReentrancyTest is Test {
    MockERC20 tokenIn; // 6-dec, USDC-shaped
    MockERC20 tokenOut; // 18-dec
    PartialFillRouter router;
    AggregationRouterAdapter adapter;
    HostileMaker maker;

    uint256 constant AMOUNT_IN = 1_000e6;
    uint256 constant PULLED = 400e6; // the route only needs 400; 600 must come back
    uint256 constant DELIVERED = 1e18;
    uint256 constant EXPECTED_REFUND = AMOUNT_IN - PULLED;

    function setUp() public {
        vm.warp(1_700_000_000);
        tokenIn = new MockERC20("USDC", 6);
        tokenOut = new MockERC20("wETH", 18);
        router = new PartialFillRouter();

        bytes4[] memory sels = new bytes4[](1);
        sels[0] = PartialFillRouter.route.selector;
        adapter = new AggregationRouterAdapter(address(router), sels);

        maker = new HostileMaker();

        tokenIn.mint(address(this), AMOUNT_IN);
        tokenIn.approve(address(adapter), type(uint256).max);
    }

    function _order() internal view returns (IExecutionAdapter.SwapOrder memory) {
        return IExecutionAdapter.SwapOrder({
            tokenIn: address(tokenIn),
            tokenOut: address(tokenOut),
            amountIn: AMOUNT_IN,
            minAmountOut: DELIVERED,
            deadline: block.timestamp + 1 hours,
            routeData: abi.encodeCall(
                PartialFillRouter.route, (address(tokenIn), address(tokenOut), PULLED, DELIVERED)
            )
        });
    }

    /// The honest baseline the fix must not break: a partial fill refunds the unspent input.
    function test_partialFillRefundsUnspentInput() public {
        adapter.executeSwap(_order());
        assertEq(tokenIn.balanceOf(address(this)), EXPECTED_REFUND, "refund");
        assertEq(tokenOut.balanceOf(address(this)), DELIVERED, "output");
        assertEq(tokenIn.balanceOf(address(adapter)), 0, "adapter holds no input");
    }

    /// THE FINDING. Without the guard the nested `executeSwap` sweeps the outer order's
    /// unspent 600 USDC to the counterparty and the caller is refunded nothing. With it, the
    /// nested call reverts `Reentrancy()` and the refund survives.
    ///
    /// Verified by mutation: remove `nonReentrant` from
    /// `AggregationRouterAdapter.executeSwap` and this test fails on `lastRevert`, then again
    /// on `refund survives` (0 instead of 600e6) and on `counterparty gained nothing`.
    function test_nestedSwapCannotSweepTheOuterOrdersInput() public {
        maker.arm(adapter, tokenIn, tokenOut);
        router.setMaker(maker);

        adapter.executeSwap(_order());

        // The loss first — that is the finding.
        assertEq(tokenIn.balanceOf(address(this)), EXPECTED_REFUND, "refund survives");
        assertEq(tokenIn.balanceOf(address(maker)), 1, "counterparty gained nothing");
        assertEq(tokenOut.balanceOf(address(this)), DELIVERED, "output still delivered");
        // Then the mechanism — a bare "it reverted" would not distinguish the guard.
        assertEq(
            maker.lastRevert(),
            AggregationRouterAdapter.Reentrancy.selector,
            "nested call must revert with Reentrancy, not merely revert"
        );
        assertFalse(maker.reentered(), "nested executeSwap must not complete");
    }

    /// The lock must release even though the nested revert was swallowed by the attacker.
    function test_lockReleasesAfterASwallowedNestedRevert() public {
        maker.arm(adapter, tokenIn, tokenOut);
        router.setMaker(maker);
        adapter.executeSwap(_order());

        router.setMaker(HostileMaker(address(0)));
        tokenIn.mint(address(this), AMOUNT_IN);
        adapter.executeSwap(_order());
        assertEq(tokenOut.balanceOf(address(this)), DELIVERED * 2, "adapter still usable");
    }

    /// A new mutex on a SHARED singleton is only safe if it releases on every path: the
    /// aggregation adapter is allowlisted by many vaults, so a stuck `_lock` would brick all of
    /// them. Revert the outer call, then swap again on the same instance.
    function test_lockReleasesAfterAnOuterRevert() public {
        IExecutionAdapter.SwapOrder memory bad = _order();
        bad.minAmountOut = DELIVERED + 1; // route under-delivers ⇒ Slippage
        vm.expectRevert(AggregationRouterAdapter.Slippage.selector);
        adapter.executeSwap(bad);

        adapter.executeSwap(_order());
        assertEq(tokenOut.balanceOf(address(this)), DELIVERED, "adapter still usable after a revert");
        assertEq(tokenIn.balanceOf(address(this)), EXPECTED_REFUND, "refund path intact");
    }

    /// `DirectPoolAdapter` carries the same interface-level invariant.
    function test_directPoolAdapterRefusesNestedSwap() public {
        MockERC20 a = new MockERC20("A", 18);
        MockERC20 b = new MockERC20("B", 18);
        (address t0, address t1) =
            address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        ReentrantPair pair = new ReentrantPair(t0, t1, 1_000_000e18, 1_000_000e18);
        DirectPoolAdapter dpa = new DirectPoolAdapter(IUniswapV2Pair(address(pair)));
        pair.arm(dpa);

        MockERC20(t0).mint(address(this), 10e18);
        MockERC20(t0).approve(address(dpa), type(uint256).max);

        dpa.executeSwap(
            IExecutionAdapter.SwapOrder({
                tokenIn: t0,
                tokenOut: t1,
                amountIn: 10e18,
                minAmountOut: 1,
                deadline: block.timestamp + 1 hours,
                routeData: ""
            })
        );

        assertEq(pair.lastRevert(), DirectPoolAdapter.Reentrancy.selector, "nested call must be refused");
        assertFalse(pair.reentered(), "nested executeSwap must not complete");
    }
}
