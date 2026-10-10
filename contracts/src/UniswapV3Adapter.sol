// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IExecutionAdapter} from "./interfaces/IExecutionAdapter.sol";
import {IOracleAggregator} from "./interfaces/IOracleAggregator.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}

/// @title UniswapV3Adapter — single-hop Uniswap V3 execution behind IExecutionAdapter
/// @notice Executes swaps through a PINNED SwapRouter02. Like {AggregationRouterAdapter}, minOut
/// and deadline are enforced HERE on measured balance deltas, never trusted from the router's
/// return value (threat model EX-3), approvals are per-swap and revoked, and this order's own
/// unspent input is refunded by delta rather than by sweeping the adapter's balance.
///
/// WHAT THE ORACLE BOUND HERE IS, AND WHAT IT IS NOT — read before changing it.
///
/// The protocol's slippage bound is `VaultCore.executeRebalance`'s `MinOutTooLow`: oracle-priced,
/// pre-execution, `MAX_REBALANCE_SLIPPAGE_BPS`, and no donation can move it. It runs BEFORE this
/// adapter is ever called and reads the SAME inputs (`o.amountIn`, `o.minAmountOut`) against the
/// SAME oracle. For any swap reaching this contract through a vault, the check below is therefore
/// REDUNDANT with it and is not what protects member funds.
///
/// It is kept for one narrow reason, stated plainly rather than dressed up: this adapter is a
/// shared, stateless contract that anyone may call directly, and a direct caller gets no
/// `VaultCore` in front of them. Such a caller risks only their own funds — `isAllowedAdapter` is
/// constructor-only in VaultCore and the adapter holds nothing of the protocol's between calls —
/// so this is a courtesy to integrators, NOT a protocol control. Do not cite it as one, and do not
/// let it drift to a different dimensional model than `VaultCore._valueWad`: the two expressions
/// disagreeing is precisely how the unit error described below got in.
///
/// The comparison is on USD VALUE (WAD) on both sides, exactly as `VaultCore._valueWad` does it,
/// multiplication before division so truncation matches:
///
///     value(tokenOut, minAmountOut) * BPS >= value(tokenIn, amountIn) * (BPS - divergenceBps)
///
/// HISTORY — the first version of this contract compared a WAD-scaled `impliedRatio` against an
/// `oracleRatio` scaled by `tokenOutUnit / tokenInUnit` instead of by 1e18. The two sides were in
/// different units, so the guard never fired: a caller could demand 1% of oracle value in either
/// direction and pass, and in the 18-decimals-in / 6-decimals-out direction the oracle side
/// integer-divided to exactly 0, making the branch unreachable for every possible input. The
/// accompanying tests asserted that silence and called it "an inherent limitation of the integer
/// ratio". It was not a limitation; it was a unit error. `_priceWad` is already a price per WHOLE
/// token, so token units never belonged in that expression.
contract UniswapV3Adapter is IExecutionAdapter {
    using SafeTransferLib for address;

    uint256 private constant BPS = 10_000;

    /// @notice Fee tier registration for a directed pair.
    struct FeeTierEntry {
        address tokenA;
        address tokenB;
        uint24 fee;
    }

    /// @notice Pinned Uniswap V3 router.
    ISwapRouter02 public immutable router;

    /// @notice Pinned oracle used for the courtesy value bound.
    IOracleAggregator public immutable oracle;

    /// @notice Pinned USDC address, valued at par (1e18 WAD per whole token).
    address public immutable usdc;

    /// @notice Maximum tolerated shortfall of output value versus input value, in basis points.
    uint256 public immutable maxOracleDivergenceBps;

    /// @notice Directed fee tier lookup: tokenIn => tokenOut => fee.
    /// @dev DIRECTED and constructor-only. A rebalancing vault both buys and sells, so BOTH
    /// directions of every tradeable pair must be registered at construction or the reverse leg
    /// reverts {UnregisteredPair}. There is no setter by design.
    mapping(address => mapping(address => uint24)) public feeTierOf;

    /// @notice Emitted after a successful swap execution.
    event SwapExecuted(
        address indexed vault, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut
    );

    error Expired();
    error BadOrder();
    error UnregisteredPair(address tokenIn, address tokenOut);
    /// @param outValueWad USD value (WAD) of the requested minimum output.
    /// @param minRequiredValueWad USD value (WAD) the output must at least be worth.
    error OraclePriceDeviation(uint256 outValueWad, uint256 minRequiredValueWad);
    error Slippage();
    error RouterCallFailed();
    error Reentrancy();
    error BadConfig();

    uint256 private _lock = 1;

    /// @dev Same shape and the same reason as {AggregationRouterAdapter}'s guard: the refund and
    /// the out-delta are balance snapshots spanning an external call, and a nested call's
    /// `safeApprove(router, 0)` would otherwise revoke the OUTER call's approval mid-route.
    modifier nonReentrant() {
        require(_lock == 1, Reentrancy());
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param router_ Uniswap V3 SwapRouter02 address (immutable, non-zero).
    /// @param oracle_ Oracle surface used for the value bound (immutable, non-zero).
    /// @param usdc_ USDC token address, valued at par.
    /// @param maxOracleDivergenceBps_ Maximum tolerated value shortfall in bps (1..1000).
    /// @param feeTiers_ Directed fee-tier registrations; register BOTH directions per pair.
    constructor(
        address router_,
        IOracleAggregator oracle_,
        address usdc_,
        uint256 maxOracleDivergenceBps_,
        FeeTierEntry[] memory feeTiers_
    ) {
        require(router_ != address(0) && address(oracle_) != address(0) && usdc_ != address(0), BadConfig());
        require(maxOracleDivergenceBps_ > 0 && maxOracleDivergenceBps_ <= 1000, BadConfig());

        router = ISwapRouter02(router_);
        oracle = oracle_;
        usdc = usdc_;
        maxOracleDivergenceBps = maxOracleDivergenceBps_;

        uint256 len = feeTiers_.length;
        for (uint256 i; i < len; ++i) {
            FeeTierEntry memory entry = feeTiers_[i];
            require(
                entry.tokenA != address(0) && entry.tokenB != address(0) && entry.tokenA != entry.tokenB
                    && entry.fee > 0,
                BadConfig()
            );
            feeTierOf[entry.tokenA][entry.tokenB] = entry.fee;
        }
    }

    /// @inheritdoc IExecutionAdapter
    /// @dev routeData must be empty for this adapter. The router call is built internally.
    function executeSwap(SwapOrder calldata order) external nonReentrant returns (uint256 amountOut) {
        require(block.timestamp <= order.deadline, Expired());
        require(order.routeData.length == 0, BadOrder());
        require(order.tokenIn != order.tokenOut && order.amountIn > 0 && order.minAmountOut > 0, BadOrder());

        uint24 fee = feeTierOf[order.tokenIn][order.tokenOut];
        if (fee == 0) revert UnregisteredPair(order.tokenIn, order.tokenOut);

        // USD value on both sides, WAD. Multiplication precedes division at both call sites so
        // rounding matches `VaultCore._assetValueWad` exactly.
        uint256 outValueWad = _valueWad(order.tokenOut, order.minAmountOut);
        uint256 minRequiredValueWad =
            (_valueWad(order.tokenIn, order.amountIn) * (BPS - maxOracleDivergenceBps)) / BPS;
        if (outValueWad < minRequiredValueWad) revert OraclePriceDeviation(outValueWad, minRequiredValueWad);

        uint256 inBefore = IERC20Meta(order.tokenIn).balanceOf(address(this));
        order.tokenIn.safeTransferFrom(msg.sender, address(this), order.amountIn);
        order.tokenIn.safeApprove(address(router), order.amountIn);

        uint256 outBefore = IERC20Meta(order.tokenOut).balanceOf(address(this));

        // amountOutMinimum is left at 0 DELIBERATELY: settlement is the measured balance delta
        // below, which is sound for fee-on-transfer and rebasing output tokens where the router's
        // own floor would compare against a number the token will not honour. The delta check is
        // strictly the tighter of the two for every token where they differ.
        ISwapRouter02.ExactInputSingleParams memory params = ISwapRouter02.ExactInputSingleParams({
            tokenIn: order.tokenIn,
            tokenOut: order.tokenOut,
            fee: fee,
            recipient: address(this),
            amountIn: order.amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });

        try router.exactInputSingle(params) {
        // Deliberately ignore the router's return value; settlement is balance-delta based.
        }
        catch {
            revert RouterCallFailed();
        }

        amountOut = IERC20Meta(order.tokenOut).balanceOf(address(this)) - outBefore;
        require(amountOut >= order.minAmountOut, Slippage());

        // Refund THIS order's own unspent input, measured across the route — never the adapter's
        // whole balance. Clamped at amountIn so a counterparty pushing tokenIn back cannot make
        // the caller's `spent` underflow. See {AggregationRouterAdapter} for the full argument.
        uint256 inAfter = IERC20Meta(order.tokenIn).balanceOf(address(this));
        uint256 refund = inAfter > inBefore ? inAfter - inBefore : 0;
        if (refund > order.amountIn) refund = order.amountIn;

        order.tokenIn.safeApprove(address(router), 0);
        order.tokenOut.safeTransfer(msg.sender, amountOut);
        if (refund > 0) order.tokenIn.safeTransfer(msg.sender, refund);

        emit SwapExecuted(msg.sender, order.tokenIn, order.tokenOut, order.amountIn, amountOut);
    }

    /// @notice USD value of `amount` base units of `token`, WAD-scaled.
    /// @dev Mirrors `VaultCore._valueWad`: USDC at par, everything else priced by the oracle,
    /// multiplication before division.
    function _valueWad(address token, uint256 amount) internal view returns (uint256) {
        if (token == usdc) return (amount * 1e18) / _tokenUnit(token);
        return (amount * oracle.priceWad(token)) / _tokenUnit(token);
    }

    /// @notice Returns one whole-token unit for the asset (10 ** decimals).
    function _tokenUnit(address token) internal view returns (uint256 unit) {
        unit = 10 ** uint256(IERC20Meta(token).decimals());
    }
}
