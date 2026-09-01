// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice Pins the exact second on each side of every non-governance deadline in the protocol:
/// the deposit observation window (VaultCore), the exit-fee decay period (VaultCore), the
/// Chainlink heartbeat (ChainlinkOracle), the execution-adapter order deadline (both
/// IExecutionAdapter implementations), and the same-second overwrite / inclusive `getAt`
/// semantics that the Checkpoints library rests on. Every one of these is a `<=`/`>=` guard
/// somewhere in `src/` — flipping any one of them to a strict `<`/`>` (or vice versa) should
/// turn one of these tests red.
import {Test} from "forge-std/Test.sol";

import {VaultCore} from "../../src/VaultCore.sol";
import {MockERC20, MockOracle, StubGovernance, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

import {AggregationRouterAdapter} from "../../src/AggregationRouterAdapter.sol";
import {DirectPoolAdapter, IUniswapV2Pair} from "../../src/DirectPoolAdapter.sol";
import {IExecutionAdapter} from "../../src/interfaces/IExecutionAdapter.sol";

import {Checkpoints} from "../../src/lib/Checkpoints.sol";

/// Minimal aggregation-router stand-in, mirroring Execution.t.sol's MockRouter: swaps at a
/// settable 1:1-by-default rate, selector `swap(...)`.
contract MockRouter {
    uint256 public rateWad = 1e18;

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint8 decIn, uint8 decOut) external {
        MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * rateWad / 1e18;
        if (decOut > decIn) out *= 10 ** (decOut - decIn);
        else if (decIn > decOut) out /= 10 ** (decIn - decOut);
        MockERC20(tokenOut).mint(msg.sender, out);
    }
}

/// A minimal constant-product V2 pair for two mock tokens, mirroring DirectPoolAdapter.t.sol's
/// MockV2Pair.
contract MockV2Pair is IUniswapV2Pair {
    address public token0;
    address public token1;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function seed(address tk, uint256 amt) external {
        MockERC20(tk).mint(address(this), amt);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (
            uint112(MockERC20(token0).balanceOf(address(this))),
            uint112(MockERC20(token1).balanceOf(address(this))),
            0
        );
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        if (amount0Out > 0) MockERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) MockERC20(token1).transfer(to, amount1Out);
    }
}

/// Exposes `Checkpoints.History` (an `internal` library) through an external surface so the
/// boundary test can drive `push`/`getAt`/`latest` and read the raw array length.
contract CheckpointsHarness {
    using Checkpoints for Checkpoints.History;

    Checkpoints.History internal h;

    function push(uint256 value) external {
        h.push(value);
    }

    function latest() external view returns (uint256) {
        return h.latest();
    }

    function getAt(uint64 ts) external view returns (uint256) {
        return h.getAt(ts);
    }

    function length() external view returns (uint256) {
        return h.arr.length;
    }
}

contract AuditTimestampBoundaries is Test {
    uint256 constant USDC_1 = 1e6;

    // ── VaultCore fixture (observation window + exit fee) ───────────────────────

    MockERC20 usdc;
    MockOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();

        address[] memory basket = new address[](0);
        vault = new VaultCore(
            address(usdc),
            basket,
            creator,
            registry,
            gov,
            fees,
            oracle,
            10_000_000 * USDC_1, // capacity cap
            10 * USDC_1, // min deposit
            100, // exit fee max 1%
            30 days, // fee decay period
            new address[](0),
            address(0)
        );

        for (uint160 i; i < 3; ++i) {
            address who = [creator, alice, bob][i];
            usdc.mint(who, 1_000_000 * USDC_1);
            vm.prank(who);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _seedCreator(uint256 amount) internal {
        vm.startPrank(creator);
        vault.deposit(amount);
        vm.stopPrank();
        skip(4 hours);
        vault.activate(creator);
    }

    function _join(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount);
        skip(4 hours);
        vault.activate(who);
    }

    // ── 1. observation window: the boundary second belongs to the elapsed side ──

    function test_observationWindow_partitionsExactly() public {
        vm.prank(alice);
        vault.deposit(100 * USDC_1);
        (, uint64 availableAt) = vault.pendingDeposit(alice);

        // One second before: still inside the window.
        vm.warp(availableAt - 1);
        vm.expectRevert(VaultCore.WindowNotElapsed.selector);
        vault.activate(alice);

        // Exactly at the boundary: elapsed, succeeds.
        vm.warp(availableAt);
        vault.activate(alice);
        assertGt(vault.sharesOf(alice), 0, "activated exactly at availableAt");

        // Fresh depositor, one second past the boundary: the window has no upper edge.
        vm.prank(bob);
        vault.deposit(100 * USDC_1);
        (, uint64 availableAt2) = vault.pendingDeposit(bob);
        vm.warp(availableAt2 + 1);
        vault.activate(bob);
        assertGt(vault.sharesOf(bob), 0, "activated one second past availableAt");
    }

    // ── 2. exit-fee decay: continuous through the boundary, positive well before it ─

    function test_exitFeeDecay_boundaryIsContinuous() public {
        _seedCreator(1_000 * USDC_1);
        _join(alice, 1_000 * USDC_1);
        uint256 t0 = block.timestamp; // lastDepositTime[alice] was just set to this instant

        // Every target timestamp is computed ONCE, up front, from the single captured `t0` —
        // never re-derived from `t0` (or `block.timestamp`) interleaved with `vm.warp` calls.
        // via-IR can CSE-cache/merge such chained relative expressions across a warp (see the
        // identical warning in Execution.t.sol's `_deadlines` comment), which silently produced
        // a corrupted (~2x) timestamp here when the expressions were computed inline instead.
        uint256 oneSecBeforeFull = t0 + 30 days - 1;
        uint256 exactlyFull = t0 + 30 days;
        uint256 oneSecAfterFull = t0 + 30 days + 1;
        uint256 oneDayBeforeFull = t0 + 30 days - 1 days;

        assertEq(vault.exitFeeBpsOf(alice), 100, "sanity: full fee at t0");

        // One second before full decay: formula floors 100 * 1 / 30 days to 0.
        vm.warp(oneSecBeforeFull);
        assertEq(vault.exitFeeBpsOf(alice), 0, "t0 + period - 1: floors to zero");

        // Exactly at full decay.
        vm.warp(exactlyFull);
        assertEq(vault.exitFeeBpsOf(alice), 0, "t0 + period: zero");

        // One second past full decay.
        vm.warp(oneSecAfterFull);
        assertEq(vault.exitFeeBpsOf(alice), 0, "t0 + period + 1: zero");

        // One day before full decay, the fee must still be strictly positive — otherwise the
        // three zeros above would be trivially true regardless of whether decay works at all.
        vm.warp(oneDayBeforeFull);
        assertGt(vault.exitFeeBpsOf(alice), 0, "t0 + period - 1 day: still decaying");
    }

    // ── 3. Chainlink heartbeat: exactly-at-heartbeat is fresh, one second past is stale ──

    address constant WETH = address(0xE7);

    function test_heartbeat_partitionsExactly() public {
        vm.warp(1_000_000); // clock comfortably larger than the heartbeat

        uint32 heartbeat = 3600;
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);

        address[] memory assets = new address[](1);
        assets[0] = WETH;
        address[] memory feedsArr = new address[](1);
        feedsArr[0] = address(feed);
        uint32[] memory hb = new uint32[](1);
        hb[0] = heartbeat;
        uint256[] memory z = new uint256[](1); // bounds disabled
        ChainlinkOracle chainlinkOracle =
            new ChainlinkOracle(assets, feedsArr, hb, z, z, address(0), address(0));

        // One second inside the heartbeat: fresh.
        feed.set(2500e8, block.timestamp - heartbeat + 1);
        assertEq(chainlinkOracle.priceWad(WETH), 2500e18, "one second inside heartbeat: fresh");

        // Exactly at the heartbeat: still fresh (inclusive boundary).
        feed.set(2500e8, block.timestamp - heartbeat);
        assertEq(chainlinkOracle.priceWad(WETH), 2500e18, "exactly at heartbeat: fresh");

        // One second past the heartbeat: stale.
        feed.set(2500e8, block.timestamp - heartbeat - 1);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, WETH));
        chainlinkOracle.priceWad(WETH);

        // A future timestamp is never fresh, regardless of the heartbeat window — pins the
        // :280 guard that prevents the :283 subtraction from ever seeing a future stamp.
        feed.set(2500e8, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, WETH));
        chainlinkOracle.priceWad(WETH);
    }

    // ── 4. adapter order deadline: the boundary second is inside the valid window ──

    function test_adapterOrderDeadline_partitionsExactly() public {
        vm.warp(1_700_000_000);

        MockERC20 tIn = new MockERC20("USDC", 6);
        MockERC20 tOut = new MockERC20("wETH", 18);

        // -- AggregationRouterAdapter --
        MockRouter router = new MockRouter();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockRouter.swap.selector;
        AggregationRouterAdapter aggAdapter = new AggregationRouterAdapter(address(router), selectors);

        tIn.mint(address(this), 200 * USDC_1);
        tIn.approve(address(aggAdapter), type(uint256).max);

        IExecutionAdapter.SwapOrder memory aggOrder = IExecutionAdapter.SwapOrder({
            tokenIn: address(tIn),
            tokenOut: address(tOut),
            amountIn: 100 * USDC_1,
            minAmountOut: 1,
            deadline: block.timestamp, // exactly now: must NOT revert Expired
            routeData: abi.encodeCall(MockRouter.swap, (address(tIn), address(tOut), 100 * USDC_1, 6, 18))
        });
        uint256 aggOut = aggAdapter.executeSwap(aggOrder);
        assertGt(aggOut, 0, "agg adapter: deadline == now completes");

        aggOrder.deadline = block.timestamp - 1; // one second past: must revert Expired
        vm.expectRevert(AggregationRouterAdapter.Expired.selector);
        aggAdapter.executeSwap(aggOrder);

        // -- DirectPoolAdapter --
        MockV2Pair pair = new MockV2Pair(address(tIn), address(tOut));
        pair.seed(address(tIn), 4_000_000 * USDC_1);
        pair.seed(address(tOut), 1_000e18);
        DirectPoolAdapter directAdapter = new DirectPoolAdapter(IUniswapV2Pair(address(pair)));

        tIn.mint(address(this), 80_000 * USDC_1);
        tIn.approve(address(directAdapter), type(uint256).max);

        IExecutionAdapter.SwapOrder memory directOrder = IExecutionAdapter.SwapOrder({
            tokenIn: address(tIn),
            tokenOut: address(tOut),
            amountIn: 40_000 * USDC_1,
            minAmountOut: 9e18,
            deadline: block.timestamp, // exactly now: must NOT revert Expired
            routeData: ""
        });
        uint256 directOut = directAdapter.executeSwap(directOrder);
        assertGt(directOut, 0, "direct pool adapter: deadline == now completes");

        directOrder.deadline = block.timestamp - 1; // one second past: must revert Expired
        vm.expectRevert(DirectPoolAdapter.Expired.selector);
        directAdapter.executeSwap(directOrder);
    }

    // ── 5. Checkpoints: same-second overwrite, and getAt's inclusive <= semantics ──

    function test_checkpointsSameSecondOverwriteIsLastWriteWins() public {
        vm.warp(1_000_000);
        uint64 t = uint64(block.timestamp);

        CheckpointsHarness h = new CheckpointsHarness();

        h.push(100);
        h.push(200); // same second: must overwrite, not append
        assertEq(h.length(), 1, "same-second push overwrites, no new entry");
        assertEq(h.latest(), 200, "latest reflects the overwrite");

        assertEq(h.getAt(t), 200, "getAt(T) is inclusive of a write made exactly at T");
        assertEq(h.getAt(t - 1), 0, "getAt(T-1) sees nothing recorded yet");

        vm.warp(t + 1);
        h.push(300);
        assertEq(h.length(), 2, "a new second appends rather than overwriting");
        assertEq(h.getAt(t), 200, "getAt(T) still returns the T-checkpoint, unaffected by T+1");
        assertEq(h.getAt(t + 1), 300, "getAt(T+1) is inclusive of a write made exactly at T+1");
    }
}
