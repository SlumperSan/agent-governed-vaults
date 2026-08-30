// SPDX-License-Identifier: BUSL-1.1
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
        } catch {
            navReadOk = false;
        }
        if (armedAmount > 0) {
            try parent.deposit(armedAmount, 0) {
                depositOk = true;
            } catch {
                depositOk = false;
            }
        }

        amountOut = o.minAmountOut;
        tokenOutERC.transfer(msg.sender, amountOut);
    }
}
