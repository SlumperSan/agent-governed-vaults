// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
// The adapter refunds THIS ORDER'S OWN input delta, never its whole balance.
//
// WHY THIS IS ITS OWN FILE, and not more cases bolted onto `test/AdapterReentrancy.t.sol`.
// That file is the evidence record for #101: one finding, one mechanism — a nested
// `executeSwap` walks off with the outer order's in-flight input, and a mutex refuses the
// nesting. THIS finding needs NO REENTRANCY AT ALL. It is reachable by a stranger with a
// single `transfer`, it lands in a DIFFERENT contract (`VaultCore.executeRebalance`'s
// arithmetic), and reproducing it needs a vault-level harness that `AdapterReentrancy.t.sol`
// does not have and should not grow. Merging the two would make a reader of either disentangle
// which mechanism each assertion pins. `test/audit/Audit*.t.sol` is where findings-with-a-repro
// live, so this goes there and #101's file is left byte-for-byte alone.
//
// THE FINDING. `AggregationRouterAdapter.executeSwap` used to end:
//
//     uint256 leftover = IERC20Balance(order.tokenIn).balanceOf(address(this));
//     if (leftover > 0) order.tokenIn.safeTransfer(msg.sender, leftover);
//
// The adapter's WHOLE `tokenIn` balance, to whoever called. #101's `nonReentrant` made the
// cross-order theft unreachable; it did not make it impossible, and it left the donation
// untouched. Donate `d` units of `tokenIn` to the adapter and the next vault leg is refunded
// its own unspent input PLUS `d`. `VaultCore.executeRebalance` then computes, over ITS OWN
// balances, in the `Finding 3 (S6)` block of `VaultCore.executeRebalance` (locate it by the
// expression `spent = inBefore - inAfter`, never by a line number — see
// Rules/proof-cites-symbol-and-branch; this cited `VaultCore.sol:882-884` until a merge moved
// the block +51 lines onto an unrelated `@param`, with nothing going red):
//
//     uint256 spent = inBefore - inAfter;      // = pull - d
//
// which UNDERFLOWS — `Panic(0x11)` — as soon as `d` exceeds what the route actually pulled.
// Note the threshold: `d > pull`, NOT `d > 0`. #101's reviewers reproduced it at 401 units
// donated against a 400-unit route, which is exactly `d = pull + 1`; the fixture below uses
// those numbers for that reason. Below the threshold the same defect is quieter but still
// real — the vault silently over-credits `idleUsdc` by `d` — and that case is pinned too.
//
// The griefer then recovers the donation with a 1-unit order, so the attack costs gas. It is
// repeatable, and because `VaultCore.isAllowedAdapter` is CONSTRUCTOR-ONLY it is permanent for
// every vault ever built against that bytecode. That is what made it a mainnet-deploy gate.
//
// THE FIX is the shape the vault next door already carries (`VaultCore.executeRebalance`, S6
// Finding 3 / threat-model row E3): refund this order's own balance delta,
// `refund = min(amountIn, inAfter - inBefore)`.
//
// HARNESS NOTE. These tests drive `executeRebalance` with `vm.prank(address(gov))` against a
// `StubGovernance`, rather than running a commit/reveal/finalize proposal. `executeRebalance`'s
// only coupling to governance is the `msg.sender == address(governance)` check on its first
// line; everything under test here is that same `spent = inBefore - inAfter` accounting block.
// The full proposal path
// is already exercised by `Execution.t.sol::test_e2e_governedRebalance…` and
// `DirectPoolAdapter.t.sol::test_governedRebalanceThroughDirectPoolAdapter`, which prove a
// different claim (that governance and the venue abstraction work); repeating it here would
// bury the arithmetic this file exists to pin.
//
// EVERY test below names the mutation that makes it fail.
// ─────────────────────────────────────────────────────────────────────────────

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {AggregationRouterAdapter} from "../../src/AggregationRouterAdapter.sol";
import {IExecutionAdapter} from "../../src/interfaces/IExecutionAdapter.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {IOperatorRegistry} from "../../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockERC20, StubGovernance, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

interface ICounterparty {
    function onRoute() external;
}

/// @dev An HONEST pinned aggregation router (EX-2: the router is never the attacker here). It
/// pulls `pull` of the approved input, hands back `deliver` of the output, and — like any real
/// aggregator — gives a counterparty control in between. `pull < amountIn` is an ordinary
/// partial fill.
contract FixtureRouter {
    address public counterparty;

    function setCounterparty(address c) external {
        counterparty = c;
    }

    function route(address tokenIn, address tokenOut, uint256 pull, uint256 deliver) external {
        address adapter = msg.sender;
        if (pull > 0) MockERC20(tokenIn).transferFrom(adapter, address(this), pull);
        if (counterparty != address(0)) ICounterparty(counterparty).onRoute();
        if (deliver > 0) MockERC20(tokenOut).mint(adapter, deliver);
    }
}

/// @dev The maker side of a fill, reached THROUGH the route. It does not re-enter (the mutex
/// already refuses that, and this finding does not need it) — it simply PUSHES `tokenIn` at the
/// adapter while the adapter is mid-order, so the adapter's balance goes UP across the route.
contract PushBackCounterparty is ICounterparty {
    MockERC20 public token;
    address public adapter;
    uint256 public amount;

    function arm(MockERC20 t, address a, uint256 amt) external {
        token = t;
        adapter = a;
        amount = amt;
        t.mint(address(this), amt);
    }

    function onRoute() external {
        uint256 amt = amount;
        if (amt > 0) {
            amount = 0; // one shot
            token.transfer(adapter, amt);
        }
    }
}

/// @dev A fee-on-transfer `tokenIn`. Deliberately LOCAL to this file rather than a mode added to
/// the shared `MockERC20`: a new branch in a mock every suite uses would move gas rows across the
/// whole snapshot and bury this PR's own +961/+1,158 in noise. `mint` is fee-free so a stranded
/// balance can be placed exactly; every real transfer burns 1%.
contract MockFeeOnTransferERC20 {
    string public name = "FOT";
    uint8 public constant decimals = 6;
    uint256 public constant FEE_BPS = 100; // 1%
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allow");
        allowance[from][msg.sender] -= amount;
        return _move(from, to, amount);
    }

    /// @dev The sender is debited the FULL amount; the recipient is credited `amount - fee`.
    function _move(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "bal");
        uint256 fee = amount * FEE_BPS / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        return true;
    }
}

contract AuditAdapterScopedSweepTest is Test {
    uint256 constant USDC_1 = 1e6;

    // The order under test, and the numbers the reviewers used.
    uint256 constant AMOUNT_IN = 1_000 * USDC_1; // vault sends 1,000 USDC
    uint256 constant PULL = 400 * USDC_1; // the route consumes 400 — a partial fill
    uint256 constant DELIVER = 0.4e18; // 0.4 wETH @ $2,500 == $1,000, so MinOutTooLow passes
    uint256 constant MIN_OUT = 0.4e18;
    uint256 constant DONATION = 401 * USDC_1; // PULL + 1 — the underflow threshold
    uint256 constant SEED_DEPOSIT = 1_000_000 * USDC_1;

    MockERC20 usdc; // 6dp
    MockERC20 weth; // 18dp
    MockAggregatorV3 feed;
    ChainlinkOracle oracle;
    FixtureRouter router;
    AggregationRouterAdapter adapter;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address alice = makeAddr("alice");
    address griefer = makeAddr("griefer");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);

        feed = new MockAggregatorV3(8, 2_500e8, block.timestamp); // wETH/USD @ $2,500
        address[] memory assets = new address[](1);
        assets[0] = address(weth);
        address[] memory feeds = new address[](1);
        feeds[0] = address(feed);
        uint32[] memory hb = new uint32[](1);
        hb[0] = 3600;
        uint256[] memory noBounds = new uint256[](1); // sane-price band disabled for this fixture
        oracle = new ChainlinkOracle(assets, feeds, hb, noBounds, noBounds, address(usdc), address(0));

        router = new FixtureRouter();
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = FixtureRouter.route.selector;
        adapter = new AggregationRouterAdapter(address(router), sels);

        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();

        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        vault = new VaultCore(
            address(usdc),
            basket,
            address(this),
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            IOracleAggregator(address(oracle)),
            0, // uncapped
            10 * USDC_1,
            0,
            0,
            adapters,
            address(0)
        );

        usdc.mint(alice, SEED_DEPOSIT);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(SEED_DEPOSIT);
        vault.skipWindow();
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _order(uint256 amountIn, uint256 pull, uint256 deliver)
        internal
        view
        returns (IExecutionAdapter.SwapOrder memory)
    {
        return IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: amountIn,
            minAmountOut: MIN_OUT,
            deadline: block.timestamp + 1 hours,
            routeData: abi.encodeCall(FixtureRouter.route, (address(usdc), address(weth), pull, deliver))
        });
    }

    /// @dev NAV the vault should report, rebuilt from its own two accounting fields. Asserting
    /// this rather than "NAV is unchanged" is deliberate: `MinOutTooLow` bounds `minAmountOut`
    /// against the FULL `amountIn`, so an order that is only partially filled must still
    /// deliver ~100% of the order's value to be legal at all. `FixtureRouter` therefore hands
    /// back $1,000 of wETH for 400 USDC pulled, and NAV legitimately RISES by $600. That is a
    /// property of the fixture, not of the fix — so the assertion checks that NAV equals idle
    /// plus basket, which is the claim that would break if the refund were mis-sized.
    function _expectedNavWad() internal view returns (uint256) {
        return vault.idleUsdc() * 1e12 + vault.assetBalance(address(weth)) * 2_500e18 / 1e18;
    }

    function _rebalance(IExecutionAdapter.SwapOrder memory o) internal {
        IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](1);
        orders[0] = o;
        vm.prank(address(gov));
        vault.executeRebalance(address(adapter), orders);
    }

    /// @dev Anyone can do this. No approval, no privilege, no reentrancy — one `transfer`.
    function _donate(uint256 amount) internal {
        usdc.mint(griefer, amount);
        vm.prank(griefer);
        usdc.transfer(address(adapter), amount);
    }

    // ── 1. the donation DoS — THE discriminating test ────────────────────────

    /// A stranger donates 401 USDC to the shared adapter. The vault's next rebalance leg
    /// consumes 400 of its 1,000-unit order.
    ///
    /// ON `origin/protocol/main` THIS TEST FAILS: the old sweep returns `1000 - 400 + 401`, so
    /// the vault's `tokenIn` balance ends HIGHER than it started, `spent = inBefore - inAfter`
    /// underflows and `executeRebalance` reverts
    /// `panic: arithmetic underflow or overflow (0x11)`. Governance-approved rebalancing is
    /// dead for every vault allow-listing that adapter, permanently — `isAllowedAdapter` is
    /// constructor-only.
    ///
    /// MUTATION: restore the sweep to
    /// `uint256 refund = IERC20Balance(order.tokenIn).balanceOf(address(this));` (i.e. drop the
    /// `- inBefore` subtraction) and this test fails with that panic.
    function test_donationCannotBrickTheVaultsRebalance() public {
        _donate(DONATION);
        assertGt(DONATION, PULL, "the panic needs donation > route pull, not merely donation > 0");

        uint256 idleBefore = vault.idleUsdc();

        _rebalance(_order(AMOUNT_IN, PULL, DELIVER));

        // The leg settled on ITS OWN numbers: 400 spent, 600 refunded, 0.4 wETH credited.
        assertEq(vault.idleUsdc(), idleBefore - PULL, "idle debited by exactly what the route spent");
        assertEq(vault.assetBalance(address(weth)), DELIVER, "wETH credited from the measured delta");
        assertEq(vault.navWad(), _expectedNavWad(), "NAV is idle + basket, both self-reported");

        // The donation never entered the protocol and is not the vault's to take.
        assertEq(usdc.balanceOf(address(adapter)), DONATION, "donation stays stranded in the adapter");
        assertEq(usdc.balanceOf(address(vault)), vault.idleUsdc(), "vault holds exactly its accounting");
    }

    /// The quieter half of the same defect, below the underflow threshold. With `d <= pull`
    /// main does NOT panic — it hands the donation to the vault, which credits it as though the
    /// route had spent that much less. Accounting drift rather than a revert, and it is the
    /// reason "it panics" is an incomplete statement of the finding.
    ///
    /// MUTATION: same as above — main over-credits `idleUsdc` by 100 USDC and this fails on
    /// `idle debited by exactly what the route spent`.
    function test_donationBelowThePullDoesNotDriftTheVaultsAccounting() public {
        uint256 small = 100 * USDC_1;
        assertLt(small, PULL, "this case is deliberately BELOW the underflow threshold");
        _donate(small);

        uint256 idleBefore = vault.idleUsdc();
        _rebalance(_order(AMOUNT_IN, PULL, DELIVER));

        assertEq(vault.idleUsdc(), idleBefore - PULL, "idle debited by exactly what the route spent");
        assertEq(usdc.balanceOf(address(adapter)), small, "donation stays stranded in the adapter");
    }

    // ── 2. the griefer cannot get the donation back ──────────────────────────

    /// The attack is only cheap if the donation is recoverable. It is not: a 1-unit order
    /// refunds the griefer its own 1 unit of unspent input at most, never the pool it donated.
    /// Donating to this adapter is burning, which is the property the natspec now states.
    ///
    /// MUTATION: RESTORE `protocol/main`'s adapter (both clauses gone,
    /// `refund = balanceOf(tokenIn)`) and the griefer walks away with `DONATION + 1`, emptying
    /// the adapter. Naming the narrower single-clause mutation here would be WRONG, and was:
    /// dropping only `- inBefore` while KEEPING the clamp leaves this test PASSING, because the
    /// clamp caps the sweep at `amountIn == 1`. It is the two clauses TOGETHER that this test
    /// discriminates; `test_midRoutePushBackIsCappedAtAmountIn` is the clamp's own single-clause
    /// test, and `test_adapterRefundNeverIncludesPreExistingBalance` is `- inBefore`'s.
    function test_griefersOneUnitOrderCannotExtractTheDonation() public {
        _donate(DONATION);

        // A 1-unit order the route does not consume at all: worst case for the fix, because
        // the whole 1 unit is legitimately refundable and sits next to the donation.
        usdc.mint(griefer, 1);
        vm.startPrank(griefer);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.executeSwap(_order(1, 0, MIN_OUT));
        vm.stopPrank();

        assertEq(usdc.balanceOf(griefer), 1, "griefer gets back only its own unspent unit");
        assertEq(usdc.balanceOf(address(adapter)), DONATION, "the donation is not recoverable");
        assertEq(weth.balanceOf(griefer), MIN_OUT, "the swap itself still settled normally");
    }

    // ── 3. partial fills still refund exactly amountIn - spent ───────────────

    /// The behaviour the fix must not break, asserted on the VAULT's accounting rather than on
    /// raw balances: a partial fill debits `idleUsdc` by what was spent and nothing more, and
    /// credits `assetBalance` from the measured output delta.
    ///
    /// MUTATION: change the refund to `refund = 0` (never refund) and `idle debited by exactly
    /// what the route spent` fails at `999,000e6 != 999,600e6`; change it to
    /// `refund = order.amountIn` (always refund the whole order) and it fails the other way.
    function test_partialFillRefundsExactlyAmountInMinusSpent() public {
        uint256 idleBefore = vault.idleUsdc();

        _rebalance(_order(AMOUNT_IN, PULL, DELIVER));

        assertEq(vault.idleUsdc(), idleBefore - PULL, "idle debited by exactly what the route spent");
        assertEq(vault.assetBalance(address(weth)), DELIVER, "assetBalance credited by the measured delta");
        assertEq(usdc.balanceOf(address(vault)), vault.idleUsdc(), "real USDC matches internal idle");
        assertEq(weth.balanceOf(address(vault)), DELIVER, "real wETH matches internal assetBalance");
        assertEq(usdc.balanceOf(address(adapter)), 0, "adapter is stateless between orders");
        assertEq(vault.navWad(), _expectedNavWad(), "NAV is idle + basket, both self-reported");
    }

    /// The degenerate end of the same range: the route pulls NOTHING. The whole order must come
    /// back and the vault's accounting must be a no-op.
    ///
    /// MUTATION: remove the `if (refund > order.amountIn) refund = order.amountIn;` clamp and
    /// this still passes (the clamp binds only on a push-back) — it is
    /// `test_midRoutePushBackIsCappedAtAmountIn` that kills the clamp mutation.
    function test_routerPullingNothingRefundsTheWholeOrder() public {
        uint256 idleBefore = vault.idleUsdc();

        _rebalance(_order(AMOUNT_IN, 0, DELIVER));

        assertEq(vault.idleUsdc(), idleBefore, "nothing spent, nothing debited");
        assertEq(usdc.balanceOf(address(adapter)), 0, "the whole order came back");
    }

    // ── 4. a mid-route push-back cannot underflow the caller ─────────────────

    /// A counterparty inside the route PUSHES `tokenIn` at the adapter mid-order, so the
    /// adapter's balance across the route goes UP by more than this order brought in. The
    /// refund must stay capped at `amountIn`, or the caller's `spent = amountIn - refund`
    /// underflows exactly as the donation did — the same `Panic(0x11)`, reached from inside the
    /// call rather than before it. This is the case the `min(…, amountIn)` clamp exists for,
    /// and it is why the clamp is not redundant with the `- inBefore` subtraction.
    ///
    /// MUTATION: remove the `if (refund > order.amountIn) refund = order.amountIn;` line and
    /// this test fails with `panic: arithmetic underflow or overflow (0x11)` inside
    /// `executeRebalance`. (It also fails on `origin/protocol/main`, for the same reason.)
    function test_midRoutePushBackIsCappedAtAmountIn() public {
        uint256 pushed = 900 * USDC_1; // > PULL, so the adapter ends the route holding more
        PushBackCounterparty cp = new PushBackCounterparty();
        cp.arm(usdc, address(adapter), pushed);
        router.setCounterparty(address(cp));

        uint256 idleBefore = vault.idleUsdc();
        uint256 vaultUsdcBefore = usdc.balanceOf(address(vault));

        _rebalance(_order(AMOUNT_IN, PULL, DELIVER));

        // Refund clamped at AMOUNT_IN ⇒ the vault got back at most what it sent, so its
        // `spent` is >= 0 by construction and there is nothing to underflow.
        assertEq(usdc.balanceOf(address(vault)), vaultUsdcBefore, "vault got back exactly what it sent");
        assertEq(vault.idleUsdc(), idleBefore, "internal idle matches: spent 0, refunded the order");
        assertEq(usdc.balanceOf(address(vault)), vault.idleUsdc(), "real USDC matches internal idle");
        assertEq(vault.assetBalance(address(weth)), DELIVER, "output credited normally");

        // The excess the counterparty pushed strands in the adapter — deliberate, per the
        // donation note on the contract: the adapter holds nothing of the protocol's, so a
        // rescue function would be new external surface guarding someone else's mistake.
        assertEq(usdc.balanceOf(address(adapter)), pushed - PULL, "the excess push strands, unclaimed");
    }

    /// The adapter-level statement of the same invariant, with no vault in the picture: a
    /// caller is never handed `tokenIn` that was already sitting in the adapter.
    ///
    /// MUTATION: drop `- inBefore` (keeping the clamp) and `refund excludes the pre-existing
    /// balance` fails at `1,000e6 != 600e6` — clamped to `amountIn`, NOT the `1,001e6` an
    /// unclamped sweep would return. This is the single-clause test for `- inBefore`: it is one
    /// of the three that the narrow mutation kills.
    function test_adapterRefundNeverIncludesPreExistingBalance() public {
        _donate(DONATION);

        address caller = makeAddr("caller");
        usdc.mint(caller, AMOUNT_IN);
        vm.startPrank(caller);
        usdc.approve(address(adapter), type(uint256).max);
        adapter.executeSwap(_order(AMOUNT_IN, PULL, DELIVER));
        vm.stopPrank();

        assertEq(usdc.balanceOf(caller), AMOUNT_IN - PULL, "refund excludes the pre-existing balance");
        assertEq(usdc.balanceOf(address(adapter)), DONATION, "pre-existing balance untouched");
    }

    // ── 8. the THIRD guard on the refund line: the saturating floor ──────────
    //
    // Added after review. The PR body claimed "both clauses are load-bearing and each has its
    // own executing test". There are THREE guards on those two lines, and the third —
    // `inAfter > inBefore ? … : 0` — had NO test: it could be deleted and all 7 tests here
    // stayed green. Both reviewers found this independently, and the second initially recorded
    // the branch as UNREACHABLE before constructing the case below. Reachability is the point:
    // an unreachable guard invites a later "prove it dead from coverage" deletion.

    /// A `tokenIn` whose balance SHRINKS across the route, which is what drives `inAfter` BELOW
    /// `inBefore` and makes the saturating floor do work.
    ///
    /// The mechanism is that the adapter approves the router for `order.amountIn` — what the
    /// order CLAIMED — not the smaller amount that actually arrived after the transfer fee. An
    /// honest router pulling its full approval therefore eats the difference out of whatever was
    /// already stranded here:
    ///
    ///     stranded (minted fee-free)                =  1,000e6  -> inBefore = 1,000e6
    ///     caller sends amountIn = 10,000e6, 1% fee  -> adapter gets 9,900e6, holds 10,900e6
    ///     adapter approves the router for amountIn  = 10,000e6
    ///     honest router pulls the full 10,000e6     -> inAfter  =    900e6  <  inBefore
    ///
    /// MUTATION: `uint256 refund = inAfter - inBefore;` (drop the ternary) and this test fails
    /// with `panic: arithmetic underflow or overflow (0x11)` INSIDE `executeSwap` — i.e. every
    /// such leg reverts. No other test in the repo fails under that mutation.
    function test_saturatingFloorIsReachableWithAFeeOnTransferTokenIn() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20();
        uint256 stranded = 1_000 * USDC_1;
        uint256 amountIn = 10_000 * USDC_1;

        fot.mint(address(adapter), stranded); // fee-free: places the stranded balance exactly

        address caller = makeAddr("fotCaller");
        fot.mint(caller, amountIn);

        IExecutionAdapter.SwapOrder memory o = IExecutionAdapter.SwapOrder({
            tokenIn: address(fot),
            tokenOut: address(weth),
            amountIn: amountIn,
            minAmountOut: MIN_OUT,
            deadline: block.timestamp + 1 hours,
            // an HONEST router that pulls its full approval
            routeData: abi.encodeCall(FixtureRouter.route, (address(fot), address(weth), amountIn, DELIVER))
        });

        vm.startPrank(caller);
        fot.approve(address(adapter), type(uint256).max);
        uint256 amountOut = adapter.executeSwap(o); // must NOT revert
        vm.stopPrank();

        assertEq(amountOut, DELIVER, "output is the measured tokenOut delta");
        assertEq(weth.balanceOf(caller), DELIVER, "caller received the output");
        assertEq(fot.balanceOf(caller), 0, "refund saturated to 0 - nothing was owed back");
        // 1,000e6 stranded + 9,900e6 arrived - 10,000e6 pulled = 900e6. The fee came out of the
        // stranded donation, which is the donor's loss and never the protocol's.
        assertEq(fot.balanceOf(address(adapter)), 900 * USDC_1, "balance fell across the route");
    }

    // ── 9. the clamp ON its threshold, not 500e6 away from it ────────────────

    /// Added after review. `test_midRoutePushBackIsCappedAtAmountIn` drives a route delta of
    /// 1,500e6 against a 1,000e6 cap — 500e6 clear of the boundary. The boundary is
    /// `delta == amountIn + 1`, and nothing sat on it, so a ONE-UNIT weakening of the predicate
    /// re-opened the exact DoS this PR exists to close, with the whole suite green.
    ///
    /// Pushing `PULL + 1` makes `refund_raw = AMOUNT_IN - PULL + (PULL + 1) = AMOUNT_IN + 1`,
    /// so the clamp binds by EXACTLY one unit and exactly one unit strands.
    ///
    /// MUTATION: `if (refund > order.amountIn + 1) refund = order.amountIn;` — a plausible
    /// off-by-one — and this test fails with `panic: arithmetic underflow or overflow (0x11)`
    /// inside `executeRebalance`, because the vault is refunded `amountIn + 1` for an
    /// `amountIn` order. Before this test, that mutation survived the entire suite.
    function test_clampBindsAtExactlyAmountInPlusOne() public {
        uint256 pushed = PULL + 1; // => refund_raw == AMOUNT_IN + 1, one unit over the cap
        PushBackCounterparty cp = new PushBackCounterparty();
        cp.arm(usdc, address(adapter), pushed);
        router.setCounterparty(address(cp));

        uint256 idleBefore = vault.idleUsdc();
        uint256 vaultUsdcBefore = usdc.balanceOf(address(vault));

        _rebalance(_order(AMOUNT_IN, PULL, DELIVER));

        assertEq(usdc.balanceOf(address(vault)), vaultUsdcBefore, "vault got back exactly what it sent");
        assertEq(vault.idleUsdc(), idleBefore, "spent == 0; nothing to underflow");
        assertEq(usdc.balanceOf(address(vault)), vault.idleUsdc(), "real USDC matches internal idle");
        assertEq(usdc.balanceOf(address(adapter)), 1, "the clamp bound by exactly one unit");
        assertEq(vault.navWad(), _expectedNavWad(), "NAV is idle + basket, unchanged by the push");
    }

    // ── 10. the tokenOut half of "never its whole balance" ───────────────────

    /// Added after review. The thesis of this fix is a PRINCIPLE — the adapter pays out only what
    /// it measured for THIS order — and the contract enforces it on BOTH payout legs:
    /// `amountOut = balanceOf(tokenOut) - outBefore` as well as the refund. Only the refund leg
    /// had a test, so the `tokenOut` leg could regress to a whole-balance sweep silently.
    ///
    /// If it ever did, a `tokenOut` donation would become claimable by any caller — the exact
    /// mirror of the griefer-recovery leg this PR closes on the `tokenIn` side — and worse,
    /// `require(amountOut >= order.minAmountOut)` could be satisfied by the adapter's stale
    /// balance rather than by the route, which would stop EX-3 being a measured-delta check.
    ///
    /// MUTATION: delete `- outBefore` from the `amountOut` assignment and this test fails — the
    /// vault credits `donation + DELIVER` instead of `DELIVER`.
    function test_preExistingTokenOutIsNotSweptIntoTheOrdersOutput() public {
        uint256 donation = 5e18; // wETH pushed at the shared adapter by a stranger
        weth.mint(address(adapter), donation);

        _rebalance(_order(AMOUNT_IN, PULL, DELIVER));

        assertEq(vault.assetBalance(address(weth)), DELIVER, "vault credits only the route delta");
        assertEq(weth.balanceOf(address(vault)), DELIVER, "and physically holds only that");
        assertEq(weth.balanceOf(address(adapter)), donation, "the tokenOut donation strands, unclaimed");
        assertEq(vault.navWad(), _expectedNavWad(), "NAV is idle + basket; the donation is not in it");
    }
}
