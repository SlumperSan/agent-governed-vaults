// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IExecutionAdapter} from "./interfaces/IExecutionAdapter.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

/// @title AggregationRouterAdapter — Base DEX-aggregation execution (0x/1inch-style)
/// @notice Sprint 4 adapter (EX-1..EX-3). Hardened against the arbitrary-calldata exploit
/// class (SwapNet/Aperture 2026, Dexible 2023, Unizen 2024, LI.FI — see RESEARCH-SPRINT1.md):
///
///  - The router address is PINNED immutable — routeData cannot choose its own target (EX-2).
///  - routeData's selector must be on the construction-time allowlist (EX-1).
///  - minAmountOut and deadline are enforced HERE on measured balance deltas — never trusted
///    from router return values or calldata-embedded slippage params (EX-3).
///  - Approvals are granted per-swap and revoked after; THIS ORDER'S OWN unspent input is
///    refunded to the caller afterwards — never the adapter's whole `tokenIn` balance.
///
/// The adapter is stateless and is designed to hold nothing of the protocol's between calls.
/// Anyone may nonetheless push tokens at it. Two consequences, both deliberate:
///
///  - A `tokenIn` donation STAYS STRANDED here. It is excluded from every refund by the
///    balance-delta measurement in `executeSwap`, and there is no rescue function: adding one
///    would be a new external surface on a contract many vaults share, guarding value that is
///    never the protocol's. Donating to this address is burning.
///  - A `tokenOut` donation landing DURING the route is measured inside `outBefore..balanceOf`
///    and is therefore over-delivered to the caller. That is not a defect and is not "fixed"
///    here: the caller (`VaultCore.executeRebalance`) credits its own measured `tokenOut`
///    delta, so the surplus becomes vault assets, and its `received >= o.minAmountOut` check
///    can only be helped by a larger delta. A donation before the call is excluded by
///    `outBefore` outright.
///
/// Venue-agnostic posture (C-2): this contract is one adapter behind IExecutionAdapter —
/// other chains/venues implement the same interface; VaultCore knows only the interface.
contract AggregationRouterAdapter is IExecutionAdapter {
    using SafeTransferLib for address;

    address public immutable router;
    mapping(bytes4 => bool) public allowedSelector;

    event SwapExecuted(
        address indexed vault, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut
    );

    error Expired();
    error SelectorNotAllowed();
    error RouterCallFailed();
    error Slippage();
    error BadOrder();
    error Reentrancy();

    uint256 private _lock = 1;

    /// @dev The adapter settles on MEASURED balance deltas while holding an order's funds
    /// transiently, so a nested `executeSwap` measures the outer order's in-flight balance.
    /// It once paid for that directly: the refund below used to be `balanceOf(tokenIn)` — the
    /// adapter's WHOLE balance — so a nested call handed the outer order's unspent input to
    /// its own `msg.sender`. Reachable with an HONEST pinned router and a hostile counterparty
    /// inside the route. Same shape as `VaultCore._lock`.
    ///
    /// KEEP THIS GUARD even though the refund is now scoped to the order's own delta and that
    /// theft is therefore impossible rather than merely blocked. It still buys two things the
    /// scoping does not: a nested call's `safeApprove(router, 0)` would otherwise revoke the
    /// OUTER call's approval mid-route, and `outBefore`/`inBefore` remain balance snapshots
    /// spanning an external call — the property Slither's `reentrancy-balance` names, and the
    /// one the interface promises every other integrator. Defence in depth, different attacker.
    modifier nonReentrant() {
        require(_lock == 1, Reentrancy());
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param router_ the aggregation router this adapter is permanently pinned to (EX-2)
    /// @param selectors_ the router function selectors routeData may invoke (EX-1)
    constructor(address router_, bytes4[] memory selectors_) {
        require(router_ != address(0) && selectors_.length > 0, BadOrder());
        router = router_;
        for (uint256 i; i < selectors_.length; ++i) {
            allowedSelector[selectors_[i]] = true;
        }
    }

    /// @inheritdoc IExecutionAdapter
    function executeSwap(SwapOrder calldata order) external nonReentrant returns (uint256 amountOut) {
        require(block.timestamp <= order.deadline, Expired());
        require(order.minAmountOut > 0, BadOrder()); // minOut is mandatory, never optional
        require(order.tokenIn != order.tokenOut && order.amountIn > 0, BadOrder());
        require(
            order.routeData.length >= 4 && allowedSelector[bytes4(order.routeData[0:4])], SelectorNotAllowed()
        );

        // Read BEFORE the pull, so the refund below tracks what actually ARRIVED for this order
        // rather than what the order claimed: on a fee-on-transfer `tokenIn`, snapshotting after
        // the pull would refund `amountIn` worth of a balance that only grew by `amountIn - fee`,
        // which is the whole-balance sweep again in a smaller costume.
        uint256 inBefore = IERC20Balance(order.tokenIn).balanceOf(address(this));

        order.tokenIn.safeTransferFrom(msg.sender, address(this), order.amountIn);
        order.tokenIn.safeApprove(router, order.amountIn);

        uint256 outBefore = IERC20Balance(order.tokenOut).balanceOf(address(this));
        (bool ok,) = router.call(order.routeData);
        require(ok, RouterCallFailed());
        amountOut = IERC20Balance(order.tokenOut).balanceOf(address(this)) - outBefore;

        // The check that matters: measured delta versus caller-supplied floor (EX-3).
        // Slither `reentrancy-balance` flags this: `outBefore` is read before the call. That is
        // the measured delta, not a stale read — and the mutex above is what makes it sound.
        require(amountOut >= order.minAmountOut, Slippage());

        // Refund THIS order's own unspent input, measured as the adapter's `tokenIn` balance
        // delta ACROSS THE ROUTE — never `balanceOf(tokenIn)`, which was the whole balance.
        // Same shape, and the same reason, as `VaultCore.sol:880-888` (S6 Finding 3 / E3):
        // `spent = (inBefore + amountIn) - inAfter`, `refund = amountIn - spent`, which reduces
        // to `inAfter - inBefore`. TWO clauses, closing TWO different attacks — neither is
        // redundant with the other:
        //
        //  1. `inAfter - inBefore` excludes `tokenIn` that was ALREADY sitting here. Under the
        //     old sweep a donation of N units was handed to the next caller on top of its own
        //     refund; `VaultCore.executeRebalance` then computed `spent = inBefore - inAfter`
        //     over ITS balances and UNDERFLOWED — `Panic(0x11)` — whenever N exceeded what the
        //     route actually pulled. Cost to the griefer: gas, repeatable, and permanent, since
        //     `VaultCore.isAllowedAdapter` is constructor-only. The same clause is what makes
        //     the nested cross-order theft the mutex above forbids IMPOSSIBLE rather than
        //     merely unreachable: there is no longer a sum for a nested call to walk off with.
        //  2. The `> order.amountIn` cap. A counterparty inside the route can PUSH `tokenIn`
        //     back at the adapter, so the delta can exceed what this order brought in; refunded
        //     unclamped it would underflow the caller's `spent` exactly as (1) did. Clamped,
        //     the caller's `spent = amountIn - refund >= 0` holds by construction for any router
        //     and any counterparty. A push beyond `amountIn` strands here, per the donation
        //     note on the contract.
        //
        // The `inAfter > inBefore` ternary is the saturating floor: a `tokenIn` that shrinks
        // balances (rebasing, fee-on-transfer on the router's own pull) must refund 0, not
        // revert the vault's rebalance.
        uint256 inAfter = IERC20Balance(order.tokenIn).balanceOf(address(this));
        uint256 refund = inAfter > inBefore ? inAfter - inBefore : 0;
        if (refund > order.amountIn) refund = order.amountIn;

        order.tokenIn.safeApprove(router, 0); // revoke residual approval (EX-2)
        order.tokenOut.safeTransfer(msg.sender, amountOut);
        if (refund > 0) order.tokenIn.safeTransfer(msg.sender, refund);

        emit SwapExecuted(msg.sender, order.tokenIn, order.tokenOut, order.amountIn, amountOut);
    }
}
