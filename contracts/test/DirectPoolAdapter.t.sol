// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {Governance} from "../src/Governance.sol";
import {DirectPoolAdapter, IUniswapV2Pair} from "../src/DirectPoolAdapter.sol";
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";
import {OracleAggregator, IPriceSource} from "../src/OracleAggregator.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, StubFeeEngine, StubRegistry} from "./mocks/Mocks.sol";

/// A minimal constant-product V2 pair for two mock tokens.
contract MockV2Pair is IUniswapV2Pair {
    address public token0;
    address public token1;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    /// Seed liquidity by token identity (address-ordering safe); reserves derive from balances.
    function seed(address tk, uint256 amt) external {
        MockERC20(tk).mint(address(this), amt);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return
            (
                uint112(MockERC20(token0).balanceOf(address(this))),
                uint112(MockERC20(token1).balanceOf(address(this))),
                0
            );
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        // Assumes the caller already transferred the input token in (V2 semantics).
        if (amount0Out > 0) MockERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) MockERC20(token1).transfer(to, amount1Out);
    }
}

contract PriceSrc is IPriceSource {
    uint256 p;
    uint256 t;

    function set(uint256 p_, uint256 t_) external {
        p = p_;
        t = t_;
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (p, t);
    }
}

/// Proves VaultCore.executeRebalance works through a SECOND, structurally-different adapter
/// (a direct V2 pool) exactly as it does through the aggregation router — the venue-agnostic
/// claim (C-2 / EX abstraction) demonstrated, not just asserted.
contract DirectPoolAdapterTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc; // 6dp
    MockERC20 weth; // 18dp
    OracleAggregator oracle;
    MockV2Pair pair;
    DirectPoolAdapter adapter;
    Governance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;
    PriceSrc s1;
    PriceSrc s2;
    PriceSrc s3;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    bytes32 constant SALT = keccak256("s");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);

        // Oracle: 3 sources, majority quorum, prices wETH at $4000, USDC treated as $1 elsewhere.
        s1 = new PriceSrc();
        s2 = new PriceSrc();
        s3 = new PriceSrc();
        _refreshOracle();
        address[] memory assets = new address[](1);
        assets[0] = address(weth);
        address[][] memory srcs = new address[][](1);
        srcs[0] = new address[](3);
        srcs[0][0] = address(s1);
        srcs[0][1] = address(s2);
        srcs[0][2] = address(s3);
        uint32[] memory stale = new uint32[](1);
        stale[0] = 1 hours;
        uint8[] memory q = new uint8[](1);
        q[0] = 2;
        oracle = new OracleAggregator(assets, srcs, stale, q);

        // Pool: 1000 wETH / 4,000,000 USDC ($4000/wETH), deep enough for low slippage.
        pair = new MockV2Pair(address(usdc), address(weth));
        pair.seed(address(usdc), 4_000_000 * USDC_1);
        pair.seed(address(weth), 1_000e18);
        adapter = new DirectPoolAdapter(IUniswapV2Pair(address(pair)));

        gov = new Governance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();

        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        vault = new VaultCore(
            address(usdc),
            basket,
            creator,
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            IOracleAggregator(address(oracle)),
            1_000_000_000 * USDC_1,
            10 * USDC_1,
            0,
            0,
            adapters,
            address(0)
        );

        vm.prank(creator);
        gov.registerVault(
            address(vault),
            Governance.GovConfig({
                commitDuration: 6 hours,
                revealDuration: 6 hours,
                timelockDuration: 1 days,
                executionWindow: 2 days,
                quorumBps: 2_500,
                proposalThresholdBps: 500,
                concentrationCapBps: 10_000,
                proposalCooldown: 1 hours
            })
        );

        usdc.mint(creator, 1_000_000 * USDC_1);
        usdc.mint(alice, 1_000_000 * USDC_1);
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? creator : alice;
            vm.startPrank(who);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(100_000 * USDC_1);
            vault.skipWindow();
            vm.stopPrank();
        }
        skip(1);
    }

    function _refreshOracle() internal {
        s1.set(4_000e18, block.timestamp);
        s2.set(4_000e18, block.timestamp);
        s3.set(4_000e18, block.timestamp);
    }

    function test_governedRebalanceThroughDirectPoolAdapter() public {
        // Convert 40,000 USDC of idle into wETH via the V2 pool (~10 wETH at $4000, minus fee).
        IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](1);
        orders[0] = IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: 40_000 * USDC_1,
            minAmountOut: 9.8e18,
            deadline: block.timestamp + 30 days,
            routeData: ""
        });
        bytes memory payload = abi.encode(address(adapter), orders);

        uint256 navBefore = vault.navWad();

        vm.prank(creator);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(payload));
        vm.prank(creator);
        gov.commitVote(pid, keccak256(abi.encode(pid, creator, true, SALT)));
        vm.prank(alice);
        gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, SALT)));
        (,,,, uint64 cd, uint64 rd,,,,,,,,,,) = gov.proposals(pid);
        vm.warp(cd);
        vm.prank(creator);
        gov.revealVote(pid, true, SALT);
        vm.prank(alice);
        gov.revealVote(pid, true, SALT);
        vm.warp(rd);
        gov.finalize(pid);
        (,,,,,, uint64 execAt,,,,,,,,,) = gov.proposals(pid);
        vm.warp(execAt);
        _refreshOracle(); // sources went stale across the governance timelock warps

        gov.execute(pid, payload);

        // Basket credited from the vault's OWN measured delta (not the pool's quote).
        assertGt(vault.assetBalance(address(weth)), 9.8e18, "wETH credited via direct pool");
        assertEq(vault.idleUsdc(), 160_000 * USDC_1, "idle debited by 40k");
        // Fair-rate swap (deep pool) keeps NAV roughly flat, minus the 0.30% pool fee.
        assertApproxEqRel(vault.navWad(), navBefore, 0.005e18, "NAV preserved through the swap");
    }

    function test_directAdapterEnforcesMinOutOnMeasuredDelta() public {
        // Demand more out than the pool can give → adapter reverts Slippage on the measured delta.
        usdc.mint(address(this), 40_000 * USDC_1);
        usdc.approve(address(adapter), type(uint256).max);
        IExecutionAdapter.SwapOrder memory o = IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: 40_000 * USDC_1,
            minAmountOut: 100e18,
            deadline: block.timestamp + 1 hours,
            routeData: ""
        });
        vm.expectRevert(DirectPoolAdapter.Slippage.selector);
        adapter.executeSwap(o);
    }

    function test_directAdapterRejectsTokenNotInPair() public {
        MockERC20 other = new MockERC20("OTHER", 18);
        IExecutionAdapter.SwapOrder memory o = IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(other),
            amountIn: 1,
            minAmountOut: 1,
            deadline: block.timestamp + 1 hours,
            routeData: ""
        });
        vm.expectRevert(DirectPoolAdapter.TokenNotInPair.selector);
        adapter.executeSwap(o);
    }
}
