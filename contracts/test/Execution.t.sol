// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {Governance} from "../src/Governance.sol";
import {
    OracleAggregator,
    IPriceSource,
    ChainlinkSourceAdapter,
    IAggregatorV3
} from "../src/OracleAggregator.sol";
import {AggregationRouterAdapter} from "../src/AggregationRouterAdapter.sol";
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, StubFeeEngine, StubRegistry} from "./mocks/Mocks.sol";

// ── fixtures ─────────────────────────────────────────────────────────────────

contract MockPriceSource is IPriceSource {
    uint256 public price;
    uint256 public updatedAt;
    bool public broken;

    function set(uint256 p, uint256 t) external {
        price = p;
        updatedAt = t;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function latestPrice() external view returns (uint256, uint256) {
        require(!broken, "source down");
        return (price, updatedAt);
    }
}

/// Minimal aggregation-router stand-in: swaps at a settable rate, selector `swap(...)`.
contract MockRouter {
    uint256 public rateWad = 1e18; // tokenOut per tokenIn, WAD
    uint256 public skim; // portion of output withheld (simulates bad route / sandwich)

    function setRate(uint256 r) external {
        rateWad = r;
    }

    function setSkim(uint256 bps) external {
        skim = bps;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint8 decIn, uint8 decOut) external {
        MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * rateWad / 1e18;
        // decimal rescale: out is in tokenIn units; convert to tokenOut units
        if (decOut > decIn) out *= 10 ** (decOut - decIn);
        else if (decIn > decOut) out /= 10 ** (decIn - decOut);
        out = out * (10_000 - skim) / 10_000;
        MockERC20(tokenOut).mint(msg.sender, out);
    }
}

contract MockChainlinkFeed is IAggregatorV3 {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 d) {
        decimals = d;
    }

    function set(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

// ── tests ────────────────────────────────────────────────────────────────────

contract ExecutionTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth; // 18 dec
    MockPriceSource s1;
    MockPriceSource s2;
    MockPriceSource s3;
    OracleAggregator oracle;
    MockRouter router;
    AggregationRouterAdapter adapter;
    Governance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant SALT = keccak256("salt");

    function setUp() public {
        vm.warp(1_700_000_000); // realistic clock for staleness math

        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);

        s1 = new MockPriceSource();
        s2 = new MockPriceSource();
        s3 = new MockPriceSource();
        _setAllSources(4_000e18);

        address[] memory assets = new address[](1);
        assets[0] = address(weth);
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](3);
        sources[0][0] = address(s1);
        sources[0][1] = address(s2);
        sources[0][2] = address(s3);
        uint32[] memory maxStale = new uint32[](1);
        maxStale[0] = 1 hours;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 2;
        oracle = new OracleAggregator(assets, sources, maxStale, quorum);

        router = new MockRouter();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockRouter.swap.selector;
        adapter = new AggregationRouterAdapter(address(router), selectors);

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
            adapters
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

        address[3] memory who = [creator, alice, bob];
        for (uint256 i; i < 3; ++i) {
            usdc.mint(who[i], 1_000_000 * USDC_1);
            vm.startPrank(who[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(1_000 * USDC_1);
            vault.skipWindow();
            vm.stopPrank();
        }
        skip(1); // strictly-before snapshots
    }

    /// via-IR legally CSE-caches the TIMESTAMP opcode within a test, so chained relative
    /// `vm.warp(block.timestamp + ...)` calls can read stale time. Warp to ABSOLUTE deadlines
    /// read from proposal storage instead.
    function _deadlines(uint256 pid) internal view returns (uint64 commitD, uint64 revealD, uint64 execAt) {
        (,,,, commitD, revealD, execAt,,,,,,,,,) = gov.proposals(pid);
    }

    function _setAllSources(uint256 p) internal {
        s1.set(p, block.timestamp);
        s2.set(p + 1e18, block.timestamp); // slight dispersion — median must handle
        s3.set(p - 1e18, block.timestamp);
    }

    // ── oracle: median + breaker (SF-1/SF-2) ─────────────────────────────────

    function test_medianOfThree() public view {
        assertEq(oracle.priceWad(address(weth)), 4_000e18, "median of dispersed set");
    }

    function test_oneDeadSourceStillQuorum() public {
        s1.setBroken(true); // reverting source ≠ breaker while quorum holds
        uint256 p = oracle.priceWad(address(weth));
        assertEq(p, (4_001e18 + 3_999e18) / 2, "median of remaining two");
    }

    function test_belowQuorumTripsBreaker() public {
        s1.setBroken(true);
        skip(2 hours); // s2, s3 now stale
        s1; // (s1 broken, others stale ⇒ 0 fresh < 2)
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(weth)));
        oracle.priceWad(address(weth));
    }

    function test_manipulatedOutlierAbsorbedByMedian() public {
        s2.set(1e18, block.timestamp); // one compromised source reports garbage
        assertEq(oracle.priceWad(address(weth)), 3_999e18, "median resists single outlier");
    }

    function test_chainlinkAdapterNormalizes8Decimals() public {
        MockChainlinkFeed feed = new MockChainlinkFeed(8);
        feed.set(4_000e8, block.timestamp);
        ChainlinkSourceAdapter cl = new ChainlinkSourceAdapter(IAggregatorV3(address(feed)));
        (uint256 p, uint256 t) = cl.latestPrice();
        assertEq(p, 4_000e18);
        assertEq(t, block.timestamp);
    }

    // ── adapter hardening (EX-1..3) ──────────────────────────────────────────

    function _order(uint256 amountInUsdc, uint256 minOutWeth)
        internal
        view
        returns (IExecutionAdapter.SwapOrder memory)
    {
        return IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: amountInUsdc,
            minAmountOut: minOutWeth,
            deadline: block.timestamp + 1 hours,
            routeData: abi.encodeCall(MockRouter.swap, (address(usdc), address(weth), amountInUsdc, 6, 18))
        });
    }

    function test_adapterRejectsUnknownSelector() public {
        IExecutionAdapter.SwapOrder memory o = _order(100 * USDC_1, 1);
        o.routeData = abi.encodeWithSelector(bytes4(0xdeadbeef), "");
        usdc.mint(address(this), 100 * USDC_1);
        usdc.approve(address(adapter), type(uint256).max);
        vm.expectRevert(AggregationRouterAdapter.SelectorNotAllowed.selector);
        adapter.executeSwap(o);
    }

    function test_adapterEnforcesMinOutOnMeasuredDelta() public {
        router.setSkim(5_000); // route delivers half of what calldata promises
        // Rate 1:1 in value: 100 USDC → wETH at $4000 ⇒ router rate must be set accordingly.
        router.setRate(0.00025e18); // 1 USDC-unit ⇒ 0.00025 wETH-units before rescale
        IExecutionAdapter.SwapOrder memory o = _order(100 * USDC_1, 0.024e18);
        usdc.mint(address(this), 100 * USDC_1);
        usdc.approve(address(adapter), type(uint256).max);
        vm.expectRevert(AggregationRouterAdapter.Slippage.selector);
        adapter.executeSwap(o);
    }

    function test_adapterEnforcesDeadline() public {
        IExecutionAdapter.SwapOrder memory o = _order(100 * USDC_1, 1);
        o.deadline = block.timestamp - 1;
        vm.expectRevert(AggregationRouterAdapter.Expired.selector);
        adapter.executeSwap(o);
    }

    function test_adapterRequiresMinOut() public {
        IExecutionAdapter.SwapOrder memory o = _order(100 * USDC_1, 0);
        vm.expectRevert(AggregationRouterAdapter.BadOrder.selector);
        adapter.executeSwap(o);
    }

    // ── the flagship: governed rebalance end-to-end + forward-priced exit ────

    function test_e2e_governedRebalance_modeFExitSettlesAtPostNav() public {
        // Proposal: convert 1500 USDC of idle into wETH at ~$4000.
        router.setRate(0.00025e18);
        IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](1);
        orders[0] = IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: 1_500 * USDC_1,
            minAmountOut: 0.37e18, // ~0.375 expected
            deadline: block.timestamp + 30 days,
            routeData: abi.encodeCall(MockRouter.swap, (address(usdc), address(weth), 1_500 * USDC_1, 6, 18))
        });
        bytes memory payload = abi.encode(address(adapter), orders);

        vm.prank(creator);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(payload));

        // Vote: creator + alice commit & reveal FOR.
        vm.prank(creator);
        gov.commitVote(pid, keccak256(abi.encode(pid, creator, true, SALT)));
        vm.prank(alice);
        gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, SALT)));
        (uint64 commitD, uint64 revealD,) = _deadlines(pid);
        vm.warp(commitD); // reveal phase

        // bob exits DURING the reveal phase → Mode F queue (VO-8).
        uint256 bobShares = vault.sharesOf(bob);
        vm.prank(bob);
        vault.requestExit(bobShares);
        assertEq(vault.queuedExitShares(bob), bobShares, "queued");

        vm.prank(creator);
        gov.revealVote(pid, true, SALT);
        vm.prank(alice);
        gov.revealVote(pid, true, SALT);
        vm.warp(revealD);
        gov.finalize(pid);
        (,, uint64 execAt) = _deadlines(pid);
        vm.warp(execAt); // timelock served

        // Keep sources fresh across the warps.
        _setAllSources(4_000e18);

        uint256 navBefore = vault.navWad();
        gov.execute(pid, payload);

        // Vault now holds ~0.375 wETH + 1500 idle; NAV ≈ unchanged (swap at fair rate).
        assertGt(vault.assetBalance(address(weth)), 0.37e18, "basket credited");
        assertEq(vault.idleUsdc(), 1_500 * USDC_1, "idle debited");
        assertApproxEqRel(vault.navWad(), navBefore, 0.01e18, "fair-rate swap keeps NAV");

        // Price doubles post-execution — bob's queued exit settles at POST-rebalance NAV,
        // sharing the appreciation (and the exposure) with everyone else. K-1 resolved: no
        // free option to exit at pre-rebalance prices with post-rebalance knowledge.
        _setAllSources(8_000e18);
        uint256 balUsdc = usdc.balanceOf(bob);
        vault.settleQueuedExit(bob);
        uint256 gotUsdc = usdc.balanceOf(bob) - balUsdc;
        uint256 gotWeth = weth.balanceOf(bob);
        // bob's third: ~500 idle + ~0.125 wETH (now worth ~$1000).
        assertApproxEqRel(gotUsdc, 500 * USDC_1, 0.02e18, "cash leg");
        assertApproxEqRel(gotWeth, 0.125e18, 0.02e18, "in-kind leg at post-rebalance basket");
    }

    function test_rebalanceOnlyThroughGovernance() public {
        IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](0);
        vm.expectRevert(VaultCore.OnlyGovernance.selector);
        vault.executeRebalance(address(adapter), orders);
    }

    function test_rebalanceRejectsUnlistedAdapter() public {
        // A second adapter not on the vault's allowlist — even governance can't use it (EX-1).
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = MockRouter.swap.selector;
        AggregationRouterAdapter rogue = new AggregationRouterAdapter(address(router), sels);

        IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](0);
        bytes memory payload = abi.encode(address(rogue), orders);

        vm.prank(creator);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(payload));
        vm.prank(creator);
        gov.commitVote(pid, keccak256(abi.encode(pid, creator, true, SALT)));
        vm.prank(alice);
        gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, SALT)));
        (uint64 commitD, uint64 revealD,) = _deadlines(pid);
        vm.warp(commitD);
        vm.prank(creator);
        gov.revealVote(pid, true, SALT);
        vm.prank(alice);
        gov.revealVote(pid, true, SALT);
        vm.warp(revealD);
        gov.finalize(pid);
        (,, uint64 execAt) = _deadlines(pid);
        vm.warp(execAt);

        vm.expectRevert(VaultCore.AdapterNotAllowed.selector);
        gov.execute(pid, payload);
    }

    function test_rebalanceRejectsRogueOutputToken() public {
        MockERC20 rogueToken = new MockERC20("RUG", 18);
        IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](1);
        orders[0] = IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(rogueToken), // not USDC, not basket (EX-3)
            amountIn: 100 * USDC_1,
            minAmountOut: 1,
            deadline: block.timestamp + 30 days,
            routeData: abi.encodeCall(
                MockRouter.swap, (address(usdc), address(rogueToken), 100 * USDC_1, 6, 18)
            )
        });
        bytes memory payload = abi.encode(address(adapter), orders);

        vm.prank(creator);
        uint256 pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, keccak256(payload));
        vm.prank(creator);
        gov.commitVote(pid, keccak256(abi.encode(pid, creator, true, SALT)));
        vm.prank(alice);
        gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, SALT)));
        (uint64 commitD, uint64 revealD,) = _deadlines(pid);
        vm.warp(commitD);
        vm.prank(creator);
        gov.revealVote(pid, true, SALT);
        vm.prank(alice);
        gov.revealVote(pid, true, SALT);
        vm.warp(revealD);
        gov.finalize(pid);
        (,, uint64 execAt) = _deadlines(pid);
        vm.warp(execAt);

        vm.expectRevert(VaultCore.BadSwapToken.selector);
        gov.execute(pid, payload);
    }
}
