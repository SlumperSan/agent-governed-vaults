// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {UniswapV3Adapter} from "../src/UniswapV3Adapter.sol";
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";

/// @dev Configurable mock router for invariant fuzzing.
contract FuzzRouter {
    uint256 public spendFrac; // 0..1e18 fraction of amountIn to actually spend
    uint256 public outFrac; // 0..1e18 fraction of amountIn expressed as tokenOut

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function setFractions(uint256 spendFrac_, uint256 outFrac_) external {
        spendFrac = spendFrac_;
        outFrac = outFrac_;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256) {
        // Spend a fraction of amountIn
        uint256 toSpend = params.amountIn * spendFrac / 1e18;
        if (toSpend > 0) {
            MockERC20(params.tokenIn).transferFrom(msg.sender, address(this), toSpend);
        }
        // Return a fraction of amountIn expressed in tokenOut decimals
        // Simplified: return outFrac units of tokenOut
        uint256 toReturn = outFrac;
        if (toReturn > 0) {
            MockERC20(params.tokenOut).transfer(params.recipient, toReturn);
        }
        return toReturn;
    }
}

/// @dev Handler that drives executeSwap with random-ish params.
contract SwapHandler is Test {
    UniswapV3Adapter public adapter;
    MockERC20 public tokenIn;
    MockERC20 public tokenOut;
    FuzzRouter public fuzzRouter;
    MockOracle public oracle;

    uint256 public constant PRICE_WAD = 2000e18; // tokenIn = $2000

    constructor(
        UniswapV3Adapter adapter_,
        MockERC20 tokenIn_,
        MockERC20 tokenOut_,
        FuzzRouter fuzzRouter_,
        MockOracle oracle_
    ) {
        adapter = adapter_;
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        fuzzRouter = fuzzRouter_;
        oracle = oracle_;
    }

    /// @dev Drive a swap with fuzzed amounts. The handler keeps minOut comfortably inside the
    ///      adapter's oracle VALUE bound so the bound is never what reverts — this suite is about
    ///      fund custody, and a swap rejected at the gate would never exercise the refund path.
    ///
    ///      The bound is `value(tokenOut, minOut) >= value(tokenIn, amountIn) * (1 - 200bps)`,
    ///      with tokenIn 18-decimal at $2,000 and tokenOut the par-priced 6-decimal USDC. Fair
    ///      output is therefore `amountIn * 2000e6 / 1e18`; 99% of it leaves a full point of
    ///      headroom inside the 2% tolerance rather than landing on the boundary, where the
    ///      truncating division could put it a wei under and revert.
    function executeSwap(uint256 amountIn, uint256 outFrac_) public {
        amountIn = bound(amountIn, 1e15, 10e18); // 0.001 .. 10 tokenIn
        uint256 minOut = amountIn * 1980e6 / 1e18; // 99% of oracle-fair value
        if (minOut == 0) minOut = 1;

        // Configure router: spend all, return at least minOut
        outFrac_ = bound(outFrac_, minOut, minOut * 2); // return 1x..2x minOut
        fuzzRouter.setFractions(1e18, outFrac_); // spend 100%, return outFrac_ units

        // Ensure tokenOut reserve in router
        tokenOut.mint(address(fuzzRouter), outFrac_);
        // Ensure tokenIn in caller
        tokenIn.mint(address(this), amountIn);
        tokenIn.approve(address(adapter), amountIn);

        adapter.executeSwap(
            IExecutionAdapter.SwapOrder({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                minAmountOut: minOut,
                deadline: block.timestamp + 1 hours,
                routeData: ""
            })
        );
    }
}

/// @title UniswapV3AdapterInvariantTest
/// @notice Invariant: after any sequence of executeSwap calls, the adapter holds
///         zero tokenIn and zero tokenOut (all funds flow through, none are stranded).
contract UniswapV3AdapterInvariantTest is StdInvariant, Test {
    MockERC20 internal tokenIn; // 18-decimal
    MockERC20 internal tokenOut; // 6-decimal (USDC-like)
    MockOracle internal oracle;
    FuzzRouter internal fuzzRouter;
    UniswapV3Adapter internal adapter;
    SwapHandler internal handler;

    function setUp() public {
        tokenIn = new MockERC20("TokenA", 18);
        tokenOut = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        oracle.setPrice(address(tokenIn), 2000e18);

        fuzzRouter = new FuzzRouter();

        UniswapV3Adapter.FeeTierEntry[] memory tiers = new UniswapV3Adapter.FeeTierEntry[](1);
        tiers[0] = UniswapV3Adapter.FeeTierEntry(address(tokenIn), address(tokenOut), 3000);

        adapter = new UniswapV3Adapter(
            address(fuzzRouter),
            oracle,
            address(tokenOut), // tokenOut is USDC (par)
            200, // 2% max divergence
            tiers
        );

        handler = new SwapHandler(adapter, tokenIn, tokenOut, fuzzRouter, oracle);

        targetContract(address(handler));
    }

    /// @notice After any swap sequence the adapter must hold nothing.
    function invariant_AdapterHoldsNoFunds() public view {
        assertEq(tokenIn.balanceOf(address(adapter)), 0, "adapter holds tokenIn");
        assertEq(tokenOut.balanceOf(address(adapter)), 0, "adapter holds tokenOut");
    }
}
