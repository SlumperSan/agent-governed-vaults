// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {VaultFactory, IVaultDeployer} from "../../src/VaultFactory.sol";
import {VaultDeployer} from "../../src/VaultDeployer.sol";
import {SubVaultRegistry} from "../../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../../src/FeeEngine.sol";
import {Governance} from "../../src/Governance.sol";
import {IOperatorRegistry} from "../../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {IExecutionAdapter} from "../../src/interfaces/IExecutionAdapter.sol";
import {MockERC20, MockOracle} from "../mocks/Mocks.sol";

/// Slither `reentrancy-no-eth` on `VaultCore.executeRebalance`: internal accounting is debited
/// for a leg's input before `adapter.executeSwap` and credited with the measured output after,
/// so for the duration of that external call the vault's own accounting UNDERSTATES its NAV.
///
/// `nonReentrant` blocks the classic re-entry, but the vault's state is readable from inside
/// the swap, and a PARENT prices this vault by look-through (`_fullNavWad` reads the child's
/// `idleUsdc`/`assetBalance` directly). A swap routed through a hostile venue therefore lets an
/// attacker mint parent shares against a child valued at a fraction of its real worth.
///
/// The fix: `_fullNavWad` refuses to price a vault whose reentrancy lock is engaged. A locked
/// vault is observable only from inside its own call stack, so honest callers never see it.
contract AuditLookThroughReadOnlyReentrancyTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 wbtc; // 8 dec
    MockERC20 weth; // 18 dec
    MockOracle oracle;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultFactory factory;

    address operator = makeAddr("operator");
    address alice = makeAddr("alice");

    VaultCore parent;
    VaultCore child;
    ReentrantAdapter mal;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        wbtc = new MockERC20("wBTC", 8);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        oracle.setPrice(address(wbtc), 100_000e18);
        oracle.setPrice(address(weth), 4_000e18);

        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        gov = new Governance();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(subReg),
            IVaultDeployer(address(new VaultDeployer())),
            true, // sub-vaults enabled for this suite
            new address[](0) // C-6: no oracle allowlist (permissive)
        );
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));

        mal = new ReentrantAdapter(address(usdc), address(weth));

        usdc.mint(operator, 10_000_000 * USDC_1);
        usdc.mint(alice, 10_000_000 * USDC_1);
        usdc.mint(address(mal), 10_000_000 * USDC_1);
        weth.mint(address(mal), 1_000e18); // the adapter's swap inventory

        address[] memory pBasket = new address[](2);
        pBasket[0] = address(wbtc);
        pBasket[1] = address(weth);
        vm.prank(operator);
        parent = VaultCore(factory.createVault(_params(pBasket, new address[](0))));

        // The child allowlists the hostile adapter at creation — the allowlist is immutable,
        // so this is the only shape in which a rebalance can reach a hostile venue at all.
        address[] memory cBasket = new address[](1);
        cBasket[0] = address(weth);
        address[] memory cAdapters = new address[](1);
        cAdapters[0] = address(mal);
        vm.prank(operator);
        child = VaultCore(factory.createChildVault(_params(cBasket, cAdapters), address(parent)));

        mal.wire(parent);

        // Fund the parent, then push every dollar of it into the child so the child's
        // valuation is the whole of the parent's NAV.
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? operator : alice;
            vm.startPrank(who);
            usdc.approve(address(parent), type(uint256).max);
            parent.deposit(1_000 * USDC_1);
            parent.skipWindow();
            vm.stopPrank();
        }
        vm.prank(address(gov));
        parent.allocateToChild(address(child), 2_000 * USDC_1);

        // The attacker is an existing member of the parent, so its re-entrant deposit takes the
        // IMMEDIATE-mint path (priced at `navWad()`) rather than the pending-escrow path.
        vm.startPrank(address(mal));
        usdc.approve(address(parent), type(uint256).max);
        parent.skipWindow();
        vm.stopPrank();
    }

    function _params(address[] memory basket, address[] memory adapters)
        internal
        view
        returns (VaultFactory.VaultParams memory)
    {
        return VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: basket,
            oracle: IOracleAggregator(address(oracle)),
            capacityCapUsdc: 1_000_000_000 * USDC_1,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: 0,
            exitFeeDecayPeriod: 0,
            allowedAdapters: adapters
        });
    }

    /// One leg: 1,000 USDC of the child's idle into wETH at the oracle price (no slippage), so
    /// the swap itself is entirely honest — only the re-entry is hostile.
    function _leg() internal view returns (IExecutionAdapter.SwapOrder[] memory orders) {
        orders = new IExecutionAdapter.SwapOrder[](1);
        orders[0] = IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: 1_000 * USDC_1,
            minAmountOut: 0.25e18, // $1,000 at $4,000/wETH
            deadline: block.timestamp + 1 hours,
            routeData: ""
        });
    }

    // ── the finding ──────────────────────────────────────────────────────────

    /// A hostile venue re-enters the PARENT while the child sits between a leg's debit and its
    /// credit. Without the `_fullNavWad` lock check the parent prices the child at half its
    /// real value and mints the attacker roughly double the shares their USDC is worth.
    function test_parentCannotPriceAChildMidSwap() public {
        uint256 sharesBefore = parent.sharesOf(address(mal));
        uint256 navBefore = parent.navWad();

        mal.arm(1_000 * USDC_1);
        vm.prank(address(gov));
        child.executeRebalance(address(mal), _leg());

        assertFalse(mal.navReadOk(), "parent NAV was readable while the child was mid-swap");
        assertFalse(mal.depositOk(), "attacker minted parent shares against a mid-swap child");
        // The reason matters as much as the outcome: a bare assertFalse cannot distinguish
        // "the guard fired" from "reverted for some unrelated reason", and a regression test
        // that passes for the wrong reason is worse than none.
        assertEq(
            mal.navRevert(), VaultCore.Reentrancy.selector, "NAV read failed, but not on the reentrancy guard"
        );
        assertEq(
            mal.depositRevert(),
            VaultCore.Reentrancy.selector,
            "deposit failed, but not on the reentrancy guard"
        );
        assertEq(parent.sharesOf(address(mal)), sharesBefore, "attacker gained shares");

        // The rebalance itself still completed: the guard rejects the re-entrant read, not the
        // swap. Value is conserved — 1,000 USDC of child idle became $1,000 of wETH.
        assertEq(child.assetBalance(address(weth)), 0.25e18, "leg did not settle");
        assertEq(parent.navWad(), navBefore, "look-through NAV moved across an at-par swap");
    }

    /// The observation the guard rests on, made explicit: the lock is only ever engaged from
    /// inside the vault's own call stack, so it is invisible to every honest caller.
    function test_lockIsInvisibleOutsideTheCallStack() public {
        assertFalse(child.locked(), "child reported locked at rest");
        assertFalse(parent.locked(), "parent reported locked at rest");

        mal.arm(1_000 * USDC_1);
        vm.prank(address(gov));
        child.executeRebalance(address(mal), _leg());

        assertTrue(mal.sawChildLocked(), "child was not locked during its own swap");
        assertFalse(child.locked(), "lock not released after the swap");
    }

    // ── the guard does not cost honest flow anything ─────────────────────────

    /// Same rebalance, no re-entry: look-through pricing, deposits and exits all still work.
    function test_honestRebalanceLeavesLookThroughIntact() public {
        uint256 navBefore = parent.navWad();

        vm.prank(address(gov));
        child.executeRebalance(address(mal), _leg()); // `arm` not called: adapter behaves

        assertEq(parent.navWad(), navBefore, "NAV moved across an at-par swap");

        uint256 aliceBefore = parent.sharesOf(alice);
        vm.prank(alice);
        parent.deposit(1_000 * USDC_1);
        assertGt(parent.sharesOf(alice) - aliceBefore, 0, "honest deposit blocked");

        uint256 exitShares = parent.sharesOf(operator) / 2;
        uint256 cashBefore = usdc.balanceOf(operator);
        vm.prank(operator);
        parent.requestExit(exitShares);
        assertGt(usdc.balanceOf(operator) - cashBefore, 0, "honest exit blocked");
    }
}

/// A venue that pays out honestly but re-enters the caller's PARENT mid-swap — the shape a
/// permissionless aggregator pool can take without any governance compromise.
contract ReentrantAdapter is IExecutionAdapter {
    MockERC20 immutable tokenInERC;
    MockERC20 immutable tokenOutERC;
    VaultCore parent;

    uint256 public armedAmount;
    bool public navReadOk;
    bool public depositOk;
    bool public sawChildLocked;
    uint256 public navSeen;
    /// Revert selectors, captured so the assertions can tell the guard firing from any other
    /// revert. `assertFalse(navReadOk())` alone would pass if `navWad()` failed for an
    /// unrelated reason, and this test is the sole evidence the defect is closed.
    bytes4 public navRevert;
    bytes4 public depositRevert;

    constructor(address usdc_, address weth_) {
        tokenInERC = MockERC20(usdc_);
        tokenOutERC = MockERC20(weth_);
    }

    function wire(VaultCore parent_) external {
        parent = parent_;
    }

    function arm(uint256 amount) external {
        armedAmount = amount;
    }

    function executeSwap(SwapOrder calldata o) external returns (uint256 amountOut) {
        tokenInERC.transferFrom(msg.sender, address(this), o.amountIn);

        // msg.sender (the child) is now between the debit of `amountIn` and the credit of the
        // output: its accounting understates its NAV by the whole in-transit leg.
        sawChildLocked = VaultCore(msg.sender).locked();
        try parent.navWad() returns (uint256 n) {
            navReadOk = true;
            navSeen = n;
        } catch (bytes memory err) {
            navReadOk = false;
            navRevert = err.length >= 4 ? bytes4(err) : bytes4(0);
        }
        if (armedAmount > 0) {
            try parent.deposit(armedAmount, 0) {
                depositOk = true;
            } catch (bytes memory err) {
                depositOk = false;
                depositRevert = err.length >= 4 ? bytes4(err) : bytes4(0);
            }
        }

        amountOut = o.minAmountOut;
        tokenOutERC.transfer(msg.sender, amountOut);
    }
}

/// ─────────────────────────────────────────────────────────────────────────────
/// DEPTH 2 — the guard must sit at the RECURSION, not at the first hop.
///
/// The three tests above build exactly one parent/child pair, so they pin the guard at depth 1
/// only. Moving `require(!v.locked())` up out of `_fullNavWad` into `_childValueWad` passes all
/// three of them — `_childValueWad` is the depth-1 entry point — while leaving every grandchild
/// exploitable, because `_fullNavWad`'s own recursion through `_holdingValueWad` never
/// re-checks. This suite closes that gap: the hostile venue re-enters the ROOT while the
/// GRANDCHILD is mid-swap, two levels down.
///
/// **Depth 3 is out of scope by construction, not by omission.** `_fullNavWad`'s `depth`
/// argument equals the callee's `SubVaultRegistry.depthOf`, and `registerChild` requires
/// `parentDepth + 1 < MAX_DEPTH` with `MAX_DEPTH = 3` — so `depthOf` is only ever 0, 1 or 2 and
/// the factory cannot construct a great-grandchild to test against. `MAX_LOOKTHROUGH_DEPTH = 3`
/// is a defensive backstop one level past what the registry admits, and the iteration it bounds
/// is unreachable through any factory-created tree. Depths 1 and 2 are therefore every reachable
/// level, and the guard runs on entry to EVERY `_fullNavWad`, so covering both covers the whole
/// traversal.
contract AuditLookThroughDepth2Test is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 wbtc; // 8 dec
    MockERC20 weth; // 18 dec
    MockOracle oracle;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultFactory factory;

    address operator = makeAddr("operator");
    address alice = makeAddr("alice");

    VaultCore root;
    VaultCore mid; // depth 1 — the INTERMEDIATE vault, which is never itself locked
    VaultCore leaf; // depth 2 — the vault that actually goes mid-swap
    DepthTwoAdapter mal;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        wbtc = new MockERC20("wBTC", 8);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        oracle.setPrice(address(wbtc), 100_000e18);
        oracle.setPrice(address(weth), 4_000e18);

        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        gov = new Governance();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(subReg),
            IVaultDeployer(address(new VaultDeployer())),
            true, // sub-vaults enabled for this suite
            new address[](0) // C-6: no oracle allowlist (permissive)
        );
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));

        mal = new DepthTwoAdapter(address(usdc), address(weth));

        usdc.mint(operator, 10_000_000 * USDC_1);
        usdc.mint(alice, 10_000_000 * USDC_1);
        usdc.mint(address(mal), 10_000_000 * USDC_1);
        weth.mint(address(mal), 1_000e18); // the adapter's swap inventory

        address[] memory rBasket = new address[](2);
        rBasket[0] = address(wbtc);
        rBasket[1] = address(weth);
        address[] memory oneWeth = new address[](1);
        oneWeth[0] = address(weth);

        // Only the LEAF allowlists the hostile adapter, and `createChildVault` requires
        // `msg.sender == parent.creator()`, so the whole chain is built by the same operator.
        address[] memory leafAdapters = new address[](1);
        leafAdapters[0] = address(mal);

        vm.startPrank(operator);
        root = VaultCore(factory.createVault(_params(rBasket, new address[](0))));
        mid = VaultCore(factory.createChildVault(_params(oneWeth, new address[](0)), address(root)));
        leaf = VaultCore(factory.createChildVault(_params(oneWeth, leafAdapters), address(mid)));
        vm.stopPrank();

        mal.wire(root, mid);

        // Three members of the root, 1,000 USDC each. The adapter is one of them, so its
        // re-entrant deposit takes the IMMEDIATE-mint path and its re-entrant exit has shares
        // to burn.
        _join(operator);
        _join(alice);
        _join(address(mal));

        // 1,500 down each level; 1,500 stays idle at the root. That idle leg is load-bearing:
        // it keeps the attacker's exit cash target inside the root's own idle balance, so
        // `_settleExit` prices children once at `:599` and never enters the SV-5 shortfall
        // unwind. A fully invested root would reach the leaf through the MID vault's own
        // `_childValueWad` during the unwind, and would then revert with the same selector for
        // an incidental reason even under the mutation this suite exists to catch.
        vm.prank(address(gov));
        root.allocateToChild(address(mid), 1_500 * USDC_1);
        vm.prank(address(gov));
        mid.allocateToChild(address(leaf), 1_500 * USDC_1);

        // The rig is only meaningful if the traversal actually reaches the leaf.
        // `_holdingValueWad` returns 0 WITHOUT entering `_fullNavWad` when the holder owns no
        // shares, so a mis-wired chain would make every assertion below pass vacuously.
        assertEq(subReg.depthOf(address(mid)), 1, "mid is not at depth 1");
        assertEq(subReg.depthOf(address(leaf)), 2, "leaf is not at depth 2");
        assertGt(root.childVaultCount(), 0, "root registered no child");
        assertGt(mid.childVaultCount(), 0, "mid registered no child");
        assertGt(mid.sharesOf(address(root)), 0, "root holds no mid shares");
        assertGt(leaf.sharesOf(address(mid)), 0, "mid holds no leaf shares");
        assertGt(root.sharesOf(address(mal)), 0, "the attacker holds no root shares");
    }

    function _join(address who) internal {
        vm.startPrank(who);
        usdc.approve(address(root), type(uint256).max);
        root.deposit(1_000 * USDC_1);
        root.skipWindow();
        vm.stopPrank();
    }

    function _params(address[] memory basket, address[] memory adapters)
        internal
        view
        returns (VaultFactory.VaultParams memory)
    {
        return VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: basket,
            oracle: IOracleAggregator(address(oracle)),
            capacityCapUsdc: 1_000_000_000 * USDC_1,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: 0,
            exitFeeDecayPeriod: 0,
            allowedAdapters: adapters
        });
    }

    /// One leg: 1,000 USDC of the LEAF's idle into wETH at the oracle price (no slippage), so
    /// the swap itself is entirely honest — only the re-entry is hostile.
    function _leg() internal view returns (IExecutionAdapter.SwapOrder[] memory orders) {
        orders = new IExecutionAdapter.SwapOrder[](1);
        orders[0] = IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: 1_000 * USDC_1,
            minAmountOut: 0.25e18, // $1,000 at $4,000/wETH
            deadline: block.timestamp + 1 hours,
            routeData: ""
        });
    }

    // ── the finding, two levels down ─────────────────────────────────────────

    /// The root refuses to price a GRANDCHILD that is mid-swap. Every consumer of look-through
    /// NAV is checked by selector: the bare read, the mint path and the burn path.
    function test_rootCannotPriceAGrandchildMidSwap() public {
        uint256 sharesBefore = root.sharesOf(address(mal));
        uint256 navBefore = root.navWad();
        uint256 cashBefore = usdc.balanceOf(address(mal));

        mal.arm(500 * USDC_1, sharesBefore / 2);
        vm.prank(address(gov));
        leaf.executeRebalance(address(mal), _leg());

        assertTrue(mal.probed(), "the adapter never ran its probes");

        assertFalse(mal.navOk(), "root NAV was readable while the GRANDCHILD was mid-swap");
        assertEq(mal.navRevert(), VaultCore.Reentrancy.selector, "NAV read failed, but not on the guard");

        assertFalse(mal.depositOk(), "attacker minted root shares against a mid-swap grandchild");
        assertEq(mal.depositRevert(), VaultCore.Reentrancy.selector, "deposit failed, but not on the guard");

        assertFalse(mal.exitOk(), "attacker exited the root against a mid-swap grandchild");
        assertEq(mal.exitRevert(), VaultCore.Reentrancy.selector, "exit failed, but not on the guard");

        assertEq(root.sharesOf(address(mal)), sharesBefore, "the attacker's root shares moved");
        // The adapter paid 1,000 USDC of the leaf's idle out and received it as `amountIn`; a
        // successful re-entrant mint or burn would move this by more than the leg.
        assertEq(usdc.balanceOf(address(mal)), cashBefore + 1_000 * USDC_1, "the attacker extracted value");

        // The rebalance itself still completed: the guard rejects the re-entrant read, not the
        // swap. Value is conserved two levels down and at the root.
        assertEq(leaf.assetBalance(address(weth)), 0.25e18, "leg did not settle");
        assertEq(root.navWad(), navBefore, "look-through NAV moved across an at-par swap");
    }

    /// The negative half, and the one that makes this a test about the RECURSION rather than a
    /// test that "something reverted": while the leaf is mid-swap the INTERMEDIATE vault is not
    /// locked, and neither is the root. Nothing at depth 0 or 1 can explain the revert above —
    /// only a check that ran at depth 2 can.
    function test_onlyTheGrandchildIsFlagged() public {
        assertFalse(root.locked(), "root reported locked at rest");
        assertFalse(mid.locked(), "mid reported locked at rest");
        assertFalse(leaf.locked(), "leaf reported locked at rest");

        mal.arm(0, 0); // observe only — no re-entrant mint or burn
        vm.prank(address(gov));
        leaf.executeRebalance(address(mal), _leg());

        assertTrue(mal.sawLeafLocked(), "the leaf was not locked during its own swap");
        assertFalse(mal.sawMidLocked(), "the INTERMEDIATE vault was flagged; it is not itself locked");
        assertFalse(mal.sawRootLocked(), "the root was flagged; it is not itself locked");

        // And the root's read failed anyway — so the only vault that can account for it is the
        // one two levels down.
        assertEq(mal.navRevert(), VaultCore.Reentrancy.selector, "root priced a mid-swap grandchild");

        assertFalse(leaf.locked(), "lock not released after the swap");
    }

    // ── the guard is not a DoS at depth 2 ────────────────────────────────────

    /// Honest nesting still works end to end: an at-par rebalance two levels down leaves the
    /// root's look-through NAV intact, and capital still flows DOWN (allocate through both
    /// levels) and back UP (a governance redeem whose cash target unwinds the leaf, plus a
    /// member deposit and exit priced through the full two-level traversal).
    function test_honestDepth2FlowsAreUnaffected() public {
        uint256 navBefore = root.navWad();

        vm.prank(address(gov));
        leaf.executeRebalance(address(mal), _leg()); // `arm` not called: the adapter behaves

        assertEq(root.navWad(), navBefore, "NAV moved across an at-par swap");

        // Down: another allocation through both levels.
        vm.prank(address(gov));
        root.allocateToChild(address(mid), 500 * USDC_1);
        vm.prank(address(gov));
        mid.allocateToChild(address(leaf), 500 * USDC_1);
        assertEq(root.navWad(), navBefore, "allocating down moved NAV");

        // Up: a governance redemption from the mid vault, whose own cash target is covered by
        // unwinding the leaf — the recursive path in the opposite direction.
        uint256 midShares = mid.sharesOf(address(root)) / 4;
        uint256 rootIdleBefore = root.idleUsdc();
        vm.prank(address(gov));
        root.redeemFromChild(address(mid), midShares);
        assertGt(root.idleUsdc(), rootIdleBefore, "redeeming up returned nothing");
        assertApproxEqRel(root.navWad(), navBefore, 1e12, "redeeming up moved NAV materially");

        uint256 aliceBefore = root.sharesOf(alice);
        vm.prank(alice);
        root.deposit(1_000 * USDC_1);
        assertGt(root.sharesOf(alice) - aliceBefore, 0, "honest deposit blocked");

        uint256 cashBefore = usdc.balanceOf(alice);
        uint256 exitShares = root.sharesOf(alice) / 2; // resolved BEFORE the prank, which is
        vm.prank(alice); // single-use and would otherwise be spent on `sharesOf`
        root.requestExit(exitShares);
        assertGt(usdc.balanceOf(alice) - cashBefore, 0, "honest exit blocked");
    }
}

/// A venue that pays out honestly but re-enters the ROOT of a three-level tree from inside the
/// LEAF's swap — the depth-2 shape of the same hostile aggregator pool.
contract DepthTwoAdapter is IExecutionAdapter {
    MockERC20 immutable tokenInERC;
    MockERC20 immutable tokenOutERC;
    VaultCore root;
    VaultCore mid;

    uint256 public armedDeposit;
    uint256 public armedExitShares;
    bool public probed;

    bool public sawLeafLocked;
    bool public sawMidLocked;
    bool public sawRootLocked;

    bool public navOk;
    bool public depositOk;
    bool public exitOk;
    /// Revert selectors, captured so the assertions can tell the guard firing from any other
    /// revert. A bare `assertFalse(navOk())` would pass if `navWad()` failed for an unrelated
    /// reason, and these tests are the sole evidence the defect is closed below depth 1.
    bytes4 public navRevert;
    bytes4 public depositRevert;
    bytes4 public exitRevert;

    constructor(address usdc_, address weth_) {
        tokenInERC = MockERC20(usdc_);
        tokenOutERC = MockERC20(weth_);
    }

    function wire(VaultCore root_, VaultCore mid_) external {
        root = root_;
        mid = mid_;
        tokenInERC.approve(address(root_), type(uint256).max);
    }

    function arm(uint256 depositAmount, uint256 exitShares) external {
        armedDeposit = depositAmount;
        armedExitShares = exitShares;
    }

    function executeSwap(SwapOrder calldata o) external returns (uint256 amountOut) {
        tokenInERC.transferFrom(msg.sender, address(this), o.amountIn);

        // msg.sender is the LEAF, two levels below `root`: it sits between the debit of
        // `amountIn` and the credit of the measured output, so its accounting understates its
        // NAV by the whole in-transit leg. Nothing above it is locked.
        sawLeafLocked = VaultCore(msg.sender).locked();
        sawMidLocked = mid.locked();
        sawRootLocked = root.locked();

        try root.navWad() returns (uint256) {
            navOk = true;
        } catch (bytes memory err) {
            navOk = false;
            navRevert = err.length >= 4 ? bytes4(err) : bytes4(0);
        }
        if (armedDeposit > 0) {
            try root.deposit(armedDeposit, 0) {
                depositOk = true;
            } catch (bytes memory err) {
                depositOk = false;
                depositRevert = err.length >= 4 ? bytes4(err) : bytes4(0);
            }
        }
        if (armedExitShares > 0) {
            try root.requestExit(armedExitShares) {
                exitOk = true;
            } catch (bytes memory err) {
                exitOk = false;
                exitRevert = err.length >= 4 ? bytes4(err) : bytes4(0);
            }
        }
        probed = true;

        amountOut = o.minAmountOut;
        tokenOutERC.transfer(msg.sender, amountOut);
    }
}
