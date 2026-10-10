// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UniswapV3Adapter, ISwapRouter02} from "../src/UniswapV3Adapter.sol";
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";

/// A SwapRouter02 stand-in that fills at a rate the test dictates, in whole-token terms.
/// `rateWad` is "whole tokenOut per whole tokenIn, WAD-scaled", so a test can express an
/// execution price independently of either token's decimals.
contract MockSwapRouter {
    uint256 public rateWad;
    bool public reverts;

    function setRateWad(uint256 r) external {
        rateWad = r;
    }

    function setReverts(bool v) external {
        reverts = v;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p)
        external
        returns (uint256 amountOut)
    {
        require(!reverts, "router down");
        MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);

        uint256 inUnit = 10 ** uint256(MockERC20(p.tokenIn).decimals());
        uint256 outUnit = 10 ** uint256(MockERC20(p.tokenOut).decimals());
        amountOut = (p.amountIn * rateWad * outUnit) / (inUnit * 1e18);

        MockERC20(p.tokenOut).mint(p.recipient, amountOut);
    }
}

/// @notice Tests for the oracle value bound in {UniswapV3Adapter}.
///
/// THESE TESTS EXIST BECAUSE THE FIRST VERSION OF THEM DID NOT WORK. That version compared a
/// WAD-scaled implied ratio against an oracle ratio scaled by tokenOutUnit/tokenInUnit, so the
/// guard never fired on any realistic decimal pair — and the tests written alongside it asserted
/// that silence, calling it "an inherent limitation of the integer ratio". Every case below is
/// therefore written to FAIL against that formula. If a change makes them all pass again while
/// the guard is broken, the change has removed the only thing these tests are for.
///
/// Coverage is deliberately over both decimal orderings, because the broken formula failed
/// differently in each: 6->18 merely mis-scaled, while 18->6 integer-divided the oracle side to
/// exactly 0, making the branch unreachable for every possible input.
contract UniswapV3AdapterOracleBoundTest is Test {
    uint256 constant BPS = 10_000;
    uint256 constant DIVERGENCE_BPS = 100; // 1%

    MockSwapRouter router;
    MockOracle oracle;
    UniswapV3Adapter adapter;

    MockERC20 usdc; // 6 decimals
    MockERC20 weth; // 18 decimals
    MockERC20 wbtc; // 8 decimals — realistic basket pairing (cbBTC-like)
    MockERC20 dai; // 18 decimals — for the equal-decimals case

    function setUp() public {
        router = new MockSwapRouter();
        oracle = new MockOracle();

        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("WETH", 18);
        wbtc = new MockERC20("WBTC", 8);
        dai = new MockERC20("DAI", 18);

        oracle.setPrice(address(usdc), 1e18); // $1
        oracle.setPrice(address(weth), 2400e18); // $2,400
        oracle.setPrice(address(wbtc), 60_000e18); // $60,000
        oracle.setPrice(address(dai), 1e18); // $1

        UniswapV3Adapter.FeeTierEntry[] memory tiers = new UniswapV3Adapter.FeeTierEntry[](8);
        tiers[0] = UniswapV3Adapter.FeeTierEntry(address(usdc), address(weth), 500);
        tiers[1] = UniswapV3Adapter.FeeTierEntry(address(weth), address(usdc), 500);
        tiers[2] = UniswapV3Adapter.FeeTierEntry(address(usdc), address(wbtc), 500);
        tiers[3] = UniswapV3Adapter.FeeTierEntry(address(wbtc), address(usdc), 500);
        tiers[4] = UniswapV3Adapter.FeeTierEntry(address(dai), address(weth), 3000);
        tiers[5] = UniswapV3Adapter.FeeTierEntry(address(weth), address(dai), 3000);
        tiers[6] = UniswapV3Adapter.FeeTierEntry(address(weth), address(wbtc), 3000);
        tiers[7] = UniswapV3Adapter.FeeTierEntry(address(wbtc), address(weth), 3000);

        adapter = new UniswapV3Adapter(
            address(router), IOracleAggregator(address(oracle)), address(usdc), DIVERGENCE_BPS, tiers
        );
    }

    /// @dev The output amount that is worth exactly as much as `amountIn` at oracle prices.
    function _fairOut(MockERC20 tokenIn, uint256 amountIn, MockERC20 tokenOut)
        internal
        view
        returns (uint256)
    {
        uint256 inUnit = 10 ** uint256(tokenIn.decimals());
        uint256 outUnit = 10 ** uint256(tokenOut.decimals());
        uint256 valueWad = (amountIn * oracle.priceWad(address(tokenIn))) / inUnit;
        return (valueWad * outUnit) / oracle.priceWad(address(tokenOut));
    }

    function _order(MockERC20 tokenIn, uint256 amountIn, MockERC20 tokenOut, uint256 minOut)
        internal
        view
        returns (IExecutionAdapter.SwapOrder memory)
    {
        return IExecutionAdapter.SwapOrder({
            tokenIn: address(tokenIn),
            tokenOut: address(tokenOut),
            amountIn: amountIn,
            minAmountOut: minOut,
            deadline: block.timestamp + 1 hours,
            routeData: ""
        });
    }

    /// @dev The oracle-fair execution rate: whole tokenOut per whole tokenIn, WAD-scaled.
    function _fairRateWad(MockERC20 tokenIn, MockERC20 tokenOut) internal view returns (uint256) {
        return (oracle.priceWad(address(tokenIn)) * 1e18) / oracle.priceWad(address(tokenOut));
    }

    /// @dev Stages funds and an order demanding `bps` basis points of the oracle-fair output.
    /// The router is set to fill generously (twice fair) so the post-swap balance-delta check can
    /// never be what reverts — any revert in these cases is the oracle bound, which is the point.
    function _prepare(MockERC20 tokenIn, uint256 amountIn, MockERC20 tokenOut, uint256 bps)
        internal
        returns (IExecutionAdapter.SwapOrder memory o)
    {
        uint256 minOut = (_fairOut(tokenIn, amountIn, tokenOut) * bps) / BPS;
        tokenIn.mint(address(this), amountIn);
        tokenIn.approve(address(adapter), amountIn);
        router.setRateWad(_fairRateWad(tokenIn, tokenOut) * 2);
        o = _order(tokenIn, amountIn, tokenOut, minOut);
    }

    /// @dev Asserts the oracle bound rejects an order demanding `bps` of oracle-fair value.
    function _expectBoundRejects(MockERC20 tokenIn, uint256 amountIn, MockERC20 tokenOut, uint256 bps)
        internal
    {
        IExecutionAdapter.SwapOrder memory o = _prepare(tokenIn, amountIn, tokenOut, bps);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3Adapter.OraclePriceDeviation.selector,
                _valueWadOf(tokenOut, o.minAmountOut),
                (_valueWadOf(tokenIn, amountIn) * (BPS - DIVERGENCE_BPS)) / BPS
            )
        );
        adapter.executeSwap(o);
    }

    /// @dev Mirrors the adapter's own _valueWad so the expected revert args are derived, not copied.
    function _valueWadOf(MockERC20 token, uint256 amount) internal view returns (uint256) {
        return (amount * oracle.priceWad(address(token))) / (10 ** uint256(token.decimals()));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Honest trades must PASS
    // ─────────────────────────────────────────────────────────────────────────

    function test_AtOracleValue_Passes_UsdcToWeth() public {
        adapter.executeSwap(_prepare(usdc, 10_000e6, weth, BPS));
    }

    function test_AtOracleValue_Passes_WethToUsdc() public {
        adapter.executeSwap(_prepare(weth, 5e18, usdc, BPS));
    }

    function test_AtOracleValue_Passes_UsdcToWbtc() public {
        adapter.executeSwap(_prepare(usdc, 120_000e6, wbtc, BPS));
    }

    function test_AtOracleValue_Passes_WbtcToUsdc() public {
        adapter.executeSwap(_prepare(wbtc, 2e8, usdc, BPS));
    }

    function test_AtOracleValue_Passes_EqualDecimals_DaiToWeth() public {
        adapter.executeSwap(_prepare(dai, 4800e18, weth, BPS));
    }

    /// @dev Just inside the 1% bound: 99.5% of fair value.
    function test_JustInsideBound_Passes_UsdcToWeth() public {
        adapter.executeSwap(_prepare(usdc, 10_000e6, weth, 9950));
    }

    function test_JustInsideBound_Passes_WethToUsdc() public {
        adapter.executeSwap(_prepare(weth, 5e18, usdc, 9950));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bad trades must REVERT — these are the cases the broken formula let through
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Just outside the 1% bound: 98.5% of fair value.
    function test_JustOutsideBound_Reverts_UsdcToWeth() public {
        _expectBoundRejects(usdc, 10_000e6, weth, 9850);
    }

    function test_JustOutsideBound_Reverts_WethToUsdc() public {
        _expectBoundRejects(weth, 5e18, usdc, 9850);
    }

    function test_HalfOfOracleValue_Reverts_UsdcToWeth() public {
        _expectBoundRejects(usdc, 10_000e6, weth, 5000);
    }

    function test_HalfOfOracleValue_Reverts_WethToUsdc() public {
        _expectBoundRejects(weth, 5e18, usdc, 5000);
    }

    function test_OnePercentOfOracleValue_Reverts_UsdcToWeth() public {
        _expectBoundRejects(usdc, 10_000e6, weth, 100);
    }

    /// @dev The direction where the broken oracleRatio integer-divided to exactly 0, leaving the
    /// branch unreachable for every possible input. No vault rebalance could reach that state —
    /// `VaultCore.MinOutTooLow` bounds the same inputs first — which is precisely why this case
    /// has to be proven here rather than assumed to be covered elsewhere.
    function test_OnePercentOfOracleValue_Reverts_WethToUsdc() public {
        _expectBoundRejects(weth, 5e18, usdc, 100);
    }

    function test_HalfOfOracleValue_Reverts_WbtcToUsdc() public {
        _expectBoundRejects(wbtc, 2e8, usdc, 5000);
    }

    function test_HalfOfOracleValue_Reverts_UsdcToWbtc() public {
        _expectBoundRejects(usdc, 120_000e6, wbtc, 5000);
    }

    function test_HalfOfOracleValue_Reverts_EqualDecimals_DaiToWeth() public {
        _expectBoundRejects(dai, 4800e18, weth, 5000);
    }

    /// @dev Both legs are non-USDC and 18/8 decimals — no par-priced token anywhere in the check.
    function test_HalfOfOracleValue_Reverts_WethToWbtc() public {
        _expectBoundRejects(weth, 25e18, wbtc, 5000);
    }

    /// @dev The revert is specifically the oracle bound, with the values it compared.
    function test_RevertIsOraclePriceDeviation_WithComparedValues() public {
        uint256 amountIn = 5e18;
        uint256 minOut = _fairOut(weth, amountIn, usdc) / 2;

        uint256 outValueWad = (minOut * 1e18) / 1e6;
        uint256 minRequiredValueWad = (((amountIn * 2400e18) / 1e18) * (BPS - DIVERGENCE_BPS)) / BPS;

        weth.mint(address(this), amountIn);
        weth.approve(address(adapter), amountIn);
        router.setRateWad(type(uint128).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3Adapter.OraclePriceDeviation.selector, outValueWad, minRequiredValueWad
            )
        );
        adapter.executeSwap(_order(weth, amountIn, usdc, minOut));
    }

    /// @dev The bound scales with the configured tolerance rather than being decorative.
    function testFuzz_BoundIsEnforcedAtTheConfiguredThreshold(uint256 bps) public {
        bps = bound(bps, 1, BPS);
        uint256 amountIn = 5e18;
        uint256 minOut = (_fairOut(weth, amountIn, usdc) * bps) / BPS;

        weth.mint(address(this), amountIn);
        weth.approve(address(adapter), amountIn);
        router.setRateWad(type(uint128).max);

        uint256 outValueWad = (minOut * 1e18) / 1e6;
        uint256 minRequiredValueWad = (((amountIn * 2400e18) / 1e18) * (BPS - DIVERGENCE_BPS)) / BPS;

        if (outValueWad < minRequiredValueWad) {
            vm.expectRevert();
            adapter.executeSwap(_order(weth, amountIn, usdc, minOut));
        } else {
            adapter.executeSwap(_order(weth, amountIn, usdc, minOut));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Surrounding behaviour
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The measured-delta check is a separate defence from the oracle bound: an order that
    /// passes the oracle bound must still revert when the router under-delivers.
    function test_UnderDeliveryReverts_EvenWhenOracleBoundPasses() public {
        uint256 amountIn = 10_000e6;
        uint256 minOut = _fairOut(usdc, amountIn, weth);

        usdc.mint(address(this), amountIn);
        usdc.approve(address(adapter), amountIn);
        // Fill at half the oracle-fair rate: the order's minOut is fair, so the measured delta
        // falls short even though minOut itself sits exactly on the oracle bound.
        router.setRateWad(_fairRateWad(usdc, weth) / 2);

        vm.expectRevert(UniswapV3Adapter.Slippage.selector);
        adapter.executeSwap(_order(usdc, amountIn, weth, minOut));
    }

    /// @dev USDC is valued at PAR by the adapter, not by the oracle. Every other test sets the
    /// mock's USDC price to 1e18, so both branches agree and the special case is never actually
    /// distinguished. Here the oracle is made to disagree: if `_valueWad` ever started consulting
    /// it for USDC, the output would be valued at a tenth of par, fall under the bound, and revert.
    function test_UsdcIsValuedAtPar_NotFromTheOracle() public {
        oracle.setPrice(address(usdc), 0.1e18); // oracle says $0.10; the adapter must still say $1

        uint256 amountIn = 1e18; // 1 WETH = $2,400
        uint256 minOut = 2400e6; // exactly fair at par
        weth.mint(address(this), amountIn);
        weth.approve(address(adapter), amountIn);
        // Set the fill explicitly rather than from _fairRateWad, which would read the skewed price.
        router.setRateWad(5000e18); // 5,000 USDC per WETH: comfortably covers minOut

        adapter.executeSwap(_order(weth, amountIn, usdc, minOut));
    }

    function test_UnregisteredPairReverts() public {
        MockERC20 other = new MockERC20("OTHER", 18);
        oracle.setPrice(address(other), 1e18);
        usdc.mint(address(this), 1000e6);
        usdc.approve(address(adapter), 1000e6);

        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UnregisteredPair.selector, address(usdc), address(other))
        );
        adapter.executeSwap(_order(usdc, 1000e6, other, 1));
    }

    /// @dev The directed fee-tier map is a real deploy footgun: registering only one direction
    /// leaves the reverse leg of a rebalance unexecutable.
    function test_FeeTierIsDirected_ReverseLegRevertsWhenUnregistered() public {
        UniswapV3Adapter.FeeTierEntry[] memory oneWay = new UniswapV3Adapter.FeeTierEntry[](1);
        oneWay[0] = UniswapV3Adapter.FeeTierEntry(address(usdc), address(weth), 500);
        UniswapV3Adapter oneWayAdapter = new UniswapV3Adapter(
            address(router), IOracleAggregator(address(oracle)), address(usdc), DIVERGENCE_BPS, oneWay
        );

        weth.mint(address(this), 1e18);
        weth.approve(address(oneWayAdapter), 1e18);

        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UnregisteredPair.selector, address(weth), address(usdc))
        );
        oneWayAdapter.executeSwap(_order(weth, 1e18, usdc, 1));
    }

    function test_ExpiredDeadlineReverts() public {
        usdc.mint(address(this), 1000e6);
        usdc.approve(address(adapter), 1000e6);

        IExecutionAdapter.SwapOrder memory o = _order(usdc, 1000e6, weth, 1);
        o.deadline = block.timestamp - 1;

        vm.expectRevert(UniswapV3Adapter.Expired.selector);
        adapter.executeSwap(o);
    }

    function test_NonEmptyRouteDataReverts() public {
        usdc.mint(address(this), 1000e6);
        usdc.approve(address(adapter), 1000e6);

        IExecutionAdapter.SwapOrder memory o = _order(usdc, 1000e6, weth, 1);
        o.routeData = hex"deadbeef";

        vm.expectRevert(UniswapV3Adapter.BadOrder.selector);
        adapter.executeSwap(o);
    }

    function test_RouterFailureReverts() public {
        uint256 amountIn = 10_000e6;
        uint256 minOut = _fairOut(usdc, amountIn, weth);

        usdc.mint(address(this), amountIn);
        usdc.approve(address(adapter), amountIn);
        router.setReverts(true);

        vm.expectRevert(UniswapV3Adapter.RouterCallFailed.selector);
        adapter.executeSwap(_order(usdc, amountIn, weth, minOut));
    }

    function test_Constructor_RejectsDivergenceZero() public {
        UniswapV3Adapter.FeeTierEntry[] memory empty = new UniswapV3Adapter.FeeTierEntry[](0);
        vm.expectRevert(UniswapV3Adapter.BadConfig.selector);
        new UniswapV3Adapter(address(router), IOracleAggregator(address(oracle)), address(usdc), 0, empty);
    }

    function test_Constructor_RejectsDivergenceAbove1000() public {
        UniswapV3Adapter.FeeTierEntry[] memory empty = new UniswapV3Adapter.FeeTierEntry[](0);
        vm.expectRevert(UniswapV3Adapter.BadConfig.selector);
        new UniswapV3Adapter(address(router), IOracleAggregator(address(oracle)), address(usdc), 1001, empty);
    }

    /// @dev A reverting oracle must fail CLOSED, per IOracleAggregator's contract.
    function test_StaleOracleFailsClosed() public {
        MockERC20 unpriced = new MockERC20("UNP", 18);
        UniswapV3Adapter.FeeTierEntry[] memory tiers = new UniswapV3Adapter.FeeTierEntry[](1);
        tiers[0] = UniswapV3Adapter.FeeTierEntry(address(usdc), address(unpriced), 500);
        UniswapV3Adapter a = new UniswapV3Adapter(
            address(router), IOracleAggregator(address(oracle)), address(usdc), DIVERGENCE_BPS, tiers
        );

        usdc.mint(address(this), 1000e6);
        usdc.approve(address(a), 1000e6);

        vm.expectRevert();
        a.executeSwap(_order(usdc, 1000e6, unpriced, 1));
    }
}
