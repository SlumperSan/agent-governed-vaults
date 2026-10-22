# Test gap audit, 2026-10-20

Describes contracts and tests at f2ce11f91 (2026-10-20); protocol/main has moved since, FeeEngine in particular (fee split), re-verify before building any proposal.

Report only. No contract, test or script file was changed. Every Foundry test below is a proposal in a
code block, uncompiled and unrun, and none is committed as a test file.

## Read this first: what was and was not measured

- **`forge coverage` was not obtained.** Foundry 1.5.1 and solc 0.8.26 were installed and `forge build` succeeds.
  Plain coverage fails because the repo needs viaIR. The ir-minimum flag fails with a Yul "stack too deep"
  error, which comes from the 16 field public getter `Governance.proposals` (ABI encoder). Fixing that needs a
  `.sol` edit, which is outside a report-only audit. A run against a patched scratch copy was not run.
- **So there are no line or branch percentages in this report.** Gaps are found by reading every contract in
  `contracts/src/` and grepping `contracts/test/` (including `test/audit/`, excluding `test/retired/`) for each
  custom error, function and modifier. "No test" means a grep for the identifier found none. A selector hit via a
  bare `vm.expectRevert()` would be missed.
- Next step to get real numbers: a one-line, owner-approved change to make `proposals` an explicit view returning
  a struct (or a `forge coverage` run in an environment that allows it), then rerun with the ir-minimum flag.

## Coverage summary (static assessment, NOT forge output)

| Contract | Existing test files | Top gap | Worst rank |
|---|---|---|---|
| VaultCore | VaultCore, VaultCoreInvariant, Execution, Sprint6Fixes, ModuleHardening, many audit | SwapSlippage untested; invariant vault has empty basket, no children, zero perf fee | CRITICAL |
| FeeEngine | FeesAndRegistry, FeeCarryInvariant, AuditFeeEngineReentrancy | nominal fee credit with no balance backing | HIGH |
| OperatorRegistry | FeesAndRegistry | registerOperator, AlreadyOperator, pullEscrowed never run against real VaultCore | MED |
| IdentityGate | IdentityGate | malformed registry return behaviour vs its natspec | LOW (claims) |
| SubVaultRegistry | SubVaults | 250 boundary, depth 2 fee stack, AlreadyRegistered | LOW |
| Governance | Governance, GovernanceInvariant, 7 audit files, Execution, SubVaults | ChildAllocation, replay and window guards, parent floor on update | HIGH |
| VaultFactory | Deploy, Eip170, Create2 suites, audit oracle suites | child path gates with enforcement on, attestation arguments | HIGH |
| VaultDeployer | Eip170 | DeployFailed and ChunkWriteFailed | LOW |
| ChainlinkOracle | ChainlinkOracle, Fuzz, SequencerFork, audit | sequencer startedAt vs updatedAt swap survives all unit tests | HIGH |
| UniswapV3Adapter | UniswapV3Adapter, UniswapV3AdapterInvariant | refund path and nonReentrant | HIGH |
| AggregationRouterAdapter | Execution, AdapterReentrancy, AuditAdapterScopedSweep | RouterCallFailed, BadOrder, constructor, no fuzz | MED |
| DirectPoolAdapter | DirectPoolAdapter, AdapterReentrancy | reverse direction, Expired, no fuzz | MED |
| BoundedCall | none direct | whole library | HIGH |
| SafeTransferLib | AuditSafeTransferBounded | non-canonical bool returns, codeless token | LOW |
| Checkpoints | none direct | uint192 bound, same second overwrite | LOW |
| ProtocolInitializer | Create2Protocol | constant only, script level check | n/a |

## Top 10 gaps by funds at risk

| # | Contract | Gap | Rank |
|---|---|---|---|
| 1 | VaultCore | SwapSlippage measured-delta check never tested | CRITICAL |
| 2 | FeeEngine | Unbacked claimableFees credit, no balance check (pre-split, see section 2) | HIGH |
| 3 | VaultCore | Short-receipt (fee-on-transfer) USDC deposit | HIGH |
| 4 | VaultCore | Exit conservation with perf fee and two basket legs, fuzzed | HIGH |
| 5 | UniswapV3Adapter | Partial-fill refund, clamp, approval revoke, nonReentrant | HIGH |
| 6 | BoundedCall | Library has no direct test | HIGH |
| 7 | Governance | execute replay, window over, tie, NoCommit, BadReveal, double reveal | HIGH |
| 8 | Governance | ChildAllocation never run through gov.execute | HIGH |
| 9 | Governance | RuleChange update path skips the parent quorum floor test | HIGH |
| 10 | VaultFactory | Child path C-6 allowlist and coverage gates, attestation and order | HIGH |

Also worth building next (code in the per contract appendices): ChainlinkOracle sequencer field swap and
constructor guards (HIGH), fee math boundary and overflow fuzz (MED), invariants that are not fuzzed
(VaultCore basket and escrow solvency, Governance weight counted once).

Funds at risk caveats: sub-vaults are disabled at launch, which lowers items 8, 9 and 10. Governance holds no
funds, so its rank reflects bypass of the vote, window or payload hash.

## The 10 tests

### 1. VaultCore: SwapSlippage measured-delta check never tested (CRITICAL)

src/VaultCore.sol L978. The only defence against an adapter that reports success but delivers less than minAmountOut. A regression would let a lying adapter drain rebalanced capital. Add to test/VaultCore.t.sol.

```solidity
// ---- G1: lying adapter, SwapSlippage (EX-3). Needs imports: IExecutionAdapter, IOperatorRegistry etc. as in file.
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";

contract LyingAdapter is IExecutionAdapter {
    uint256 public deliver; // wbtc-like units to mint to caller
    MockERC20 public tokenOut;
    constructor(MockERC20 t) { tokenOut = t; }
    function setDeliver(uint256 d) external { deliver = d; }
    function executeSwap(SwapOrder calldata) external returns (uint256) {
        if (deliver > 0) tokenOut.mint(msg.sender, deliver);
        return type(uint256).max; // claims a huge output regardless; vault must ignore it
    }
}

// inside VaultCoreTest:
function _vaultWithAdapter(address adapter) internal returns (VaultCore v) {
    address[] memory basket = new address[](1);
    basket[0] = address(wbtcLike);
    address[] memory adapters = new address[](1);
    adapters[0] = adapter;
    v = new VaultCore(address(usdc), basket, creator, registry, gov, fees, oracle,
        10_000_000 * USDC_1, 10 * USDC_1, 0, 0, adapters, address(0));
    vm.startPrank(creator);
    usdc.approve(address(v), type(uint256).max);
    v.deposit(10_000 * USDC_1);
    v.skipWindow(); // activates the pending deposit immediately
    vm.stopPrank();
}

function test_gap_executeRebalance_shortDeliveryRevertsSwapSlippage() public {
    LyingAdapter lie = new LyingAdapter(wbtcLike);
    VaultCore v = _vaultWithAdapter(address(lie));
    // 1000 USDC -> 0.01 BTC (1e6 units at $100k). minOut sits exactly at fair value.
    IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](1);
    orders[0] = IExecutionAdapter.SwapOrder({
        tokenIn: address(usdc), tokenOut: address(wbtcLike), amountIn: 1_000 * USDC_1,
        minAmountOut: 1e6, deadline: block.timestamp + 1 hours, routeData: ""
    });
    uint256 idleBefore = v.idleUsdc();

    lie.setDeliver(1e6 - 1); // one unit short, adapter still returns max uint
    vm.prank(address(gov));
    vm.expectRevert(VaultCore.SwapSlippage.selector);
    v.executeRebalance(address(lie), 200, orders);
    assertEq(v.idleUsdc(), idleBefore, "revert rolled the debit back");
    assertEq(v.assetBalance(address(wbtcLike)), 0, "nothing credited");

    lie.setDeliver(1e6); // exactly minOut passes, and credit is the MEASURED delta, not the claimed one
    vm.prank(address(gov));
    v.executeRebalance(address(lie), 200, orders);
    assertEq(v.assetBalance(address(wbtcLike)), 1e6, "credited measured delta");
    assertEq(v.idleUsdc(), idleBefore - 1_000 * USDC_1 + 1_000 * USDC_1, "unspent input refunded: adapter pulled none");
}
```


### 2. FeeEngine: Unbacked claimableFees credit, no balance check (HIGH)

Pre-split: this gap and test 2 below describe FeeEngine at f2ce11f91, before protocol/main split every collected fee between treasury and vault creator. The credit target, `operatorAddressOf` and the "credit to operator" assertions no longer describe main, and the test as written does not compile against it. Re-derive both before building.

src/FeeEngine.sol L120 and onFeeCollected credit the nominal amount. One pooled balance per token, so an over-credit lets one operator claim another operator's tokens. New file test/FeeEngineGaps.t.sol (gaps A and B, includes the reentrancy and negative access tests).

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {SafeTransferLib} from "../src/lib/SafeTransferLib.sol";
import {MockERC20} from "./mocks/Mocks.sol";

contract GapRegistry is IRegistryView {
    mapping(address => uint256) public opOf;
    mapping(uint256 => address) public addrOf;

    function set(address vault, uint256 opId, address opAddr) external {
        opOf[vault] = opId;
        addrOf[opId] = opAddr;
    }

    function operatorOf(address v) external view returns (uint256) { return opOf[v]; }
    function carryOf(address, uint256) external pure returns (uint256) { return 0; }
    function operatorAddressOf(uint256 id) external view returns (address) { return addrOf[id]; }
    function recordFeeCollected(uint256, uint256) external {}
}

/// Token that fires one arbitrary call from ITSELF to `target` in the middle of `transfer`.
contract HookToken {
    mapping(address => uint256) public balanceOf;
    address public target;
    bytes public payload;
    bool public armed;
    bool public hookOk;
    bytes public hookRet;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
        armed = true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        if (armed) {
            armed = false;
            (hookOk, hookRet) = target.call(payload);
        }
        return true;
    }
}

contract FeeEngineGapsTest is Test {
    FeeEngine engine;
    GapRegistry reg;
    MockERC20 token;
    HookToken hook;

    address vaultA = makeAddr("vaultA");
    address vaultB = makeAddr("vaultB");
    address opA = makeAddr("opA");
    address opB = makeAddr("opB");
    address member = makeAddr("member");

    function setUp() public {
        reg = new GapRegistry();
        engine = new FeeEngine(IRegistryView(address(reg)));
        token = new MockERC20("T", 18);
        hook = new HookToken();
        reg.set(vaultA, 1, opA);
        reg.set(vaultB, 2, opB);
    }

    // ---- Gap A: nominal credit is not balance-checked; operators share one pooled balance ----
    /// Characterization test of CURRENT behaviour. If the engine later credits balance deltas,
    /// flip the expectations: A's credit would be 40e18 and both claims would succeed.
    function test_overCreditedOperatorDrainsAnotherOperatorsFees() public {
        // Vault B legitimately delivers 60; vault A "delivers" 40 (fee-on-transfer) but reports 100.
        token.mint(address(engine), 40e18 + 60e18);
        vm.prank(vaultB);
        engine.onFeeCollectedAsset(member, address(token), 60e18);
        vm.prank(vaultA);
        engine.onFeeCollectedAsset(member, address(token), 100e18);

        uint256 credits = engine.claimableFees(opA, address(token)) + engine.claimableFees(opB, address(token));
        assertGt(credits, token.balanceOf(address(engine)), "credits exceed backing: solvency invariant broken");

        vm.prank(opA);
        engine.claimFees(address(token)); // A takes all 100, including B's 60
        assertEq(token.balanceOf(opA), 100e18);

        vm.prank(opB);
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TransferFailed.selector, address(token)));
        engine.claimFees(address(token)); // B is owed 60, engine holds 0
    }

    // ---- Gap B1: claimFees reentrancy through a token hook ----
    function test_claimFees_hookReentryIntoClaimOrPullIsRefused() public {
        hook.mint(address(engine), 100e18);
        vm.prank(vaultA);
        engine.onFeeCollectedAsset(member, address(hook), 100e18);

        hook.arm(address(engine), abi.encodeCall(FeeEngine.claimFees, (address(hook))));
        vm.prank(opA);
        engine.claimFees(address(hook));
        assertFalse(hook.hookOk(), "nested claimFees must fail");
        assertEq(bytes4(hook.hookRet()), FeeEngine.Reentrancy.selector);
        assertEq(hook.balanceOf(opA), 100e18, "paid exactly once");

        // lock released: a fresh credit is claimable again
        hook.mint(address(engine), 5e18);
        vm.prank(vaultA);
        engine.onFeeCollectedAsset(member, address(hook), 5e18);
        hook.arm(address(engine), abi.encodeCall(FeeEngine.pullEscrowed, (vaultB, address(hook))));
        vm.prank(opA);
        engine.claimFees(address(hook));
        assertFalse(hook.hookOk(), "nested pullEscrowed must fail");
        assertEq(bytes4(hook.hookRet()), FeeEngine.Reentrancy.selector);
        assertEq(hook.balanceOf(opA), 105e18);
    }

    // ---- Gap B2: negative access / empty-claim paths ----
    function test_unattestedCallersAndEmptyClaimsRevert() public {
        address rogue = makeAddr("rogue");
        vm.startPrank(rogue);
        vm.expectRevert(FeeEngine.UnattestedVault.selector);
        engine.onFeeCollected(member, 1);
        vm.expectRevert(FeeEngine.UnattestedVault.selector);
        engine.onFeeCollectedAsset(member, address(token), 1);
        vm.expectRevert(FeeEngine.UnattestedVault.selector);
        engine.pullEscrowed(rogue, address(token));
        vm.expectRevert(FeeEngine.NothingToClaim.selector);
        engine.claimFees(address(token));
        vm.stopPrank();

        // an operator cannot claim another operator's balance
        token.mint(address(engine), 10e18);
        vm.prank(vaultA);
        engine.onFeeCollectedAsset(member, address(token), 10e18);
        vm.prank(opB);
        vm.expectRevert(FeeEngine.NothingToClaim.selector);
        engine.claimFees(address(token));
    }
}
```


### 3. VaultCore: Short-receipt (fee-on-transfer) USDC deposit (HIGH)

src/VaultCore.sol L441-444. Crediting requested instead of received is an insolvency vector. No test uses a short-delivering USDC. Add to test/VaultCore.t.sol.

```solidity
// ---- G2: short-receipt (fee-on-transfer) USDC deposit. Local token; 6 decimals, 1% burned on transferFrom.
contract FotUsdc {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a - a / 100; return true;
    }
}

function test_gap_feeOnTransferUsdcCreditsReceivedNotRequested() public {
    FotUsdc fot = new FotUsdc();
    VaultCore v = new VaultCore(address(fot), new address[](0), creator, registry, gov, fees, oracle,
        0, 10 * USDC_1, 0, 0, new address[](0), address(0));
    fot.mint(alice, 1_000 * USDC_1);
    vm.startPrank(alice);
    fot.approve(address(v), type(uint256).max);
    v.deposit(100 * USDC_1);
    (uint256 pend,) = v.pendingDeposit(alice);
    assertEq(pend, 99 * USDC_1, "escrow records the 99 received, not the 100 requested");
    assertEq(v.totalPendingUsdc(), 99 * USDC_1);
    assertGe(fot.balanceOf(address(v)), v.idleUsdc() + v.totalPendingUsdc(), "solvent");
    vm.stopPrank();
    // A deposit whose RECEIPT falls under the minimum reverts even though the request met it.
    vm.prank(alice);
    vm.expectRevert(VaultCore.BelowMinDeposit.selector);
    v.deposit(10 * USDC_1); // 10 requested -> 9.9 received < min 10
}
```


### 4. VaultCore: Exit conservation with perf fee and two basket legs, fuzzed (HIGH)

src/VaultCore.sol L741-803. Only fixed examples exist (AuditExitSliceRounding L141). Rounding drift or a double pay across the USDC, fee and escrow legs moves member funds. Add to test/VaultCore.t.sol.

```solidity
// ---- G3: exit conservation with perf fee + two basket legs, fuzzed price gain.
function testFuzz_gap_exitConservesAllLegsWithPerfFee(uint256 gainBps, uint256 feeSeed) public {
    gainBps = bound(gainBps, 1, 5_000); // up to +50%
    _seedCreator(1_000 * USDC_1);
    _join(alice, 1_000 * USDC_1);
    _fundBasket(1e8, 10e18);
    skip(30 days);
    oracle.setPrice(address(wbtcLike), 100_000e18 * (10_000 + gainBps) / 10_000);
    oracle.setPrice(address(wethLike), 4_000e18 * (10_000 + gainBps) / 10_000);
    fees.setFeeToCharge(bound(feeSeed, 0, type(uint128).max)); // hostile: clamp at gain/10 must hold

    uint256 totalBtc = wbtcLike.balanceOf(address(vault));
    uint256 totalEth = wethLike.balanceOf(address(vault));
    uint256 burn = vault.sharesOf(alice);
    uint256 psBefore = vault.navPerShareWad();
    vm.prank(alice);
    vault.requestExit(burn);

    // Every wei of each basket asset is in exactly one place: vault accounting, member, fee engine, or escrow.
    uint256 btcOut = wbtcLike.balanceOf(alice) + wbtcLike.balanceOf(address(fees)) + vault.claimable(alice, address(wbtcLike));
    uint256 ethOut = wethLike.balanceOf(alice) + wethLike.balanceOf(address(fees)) + vault.claimable(alice, address(wethLike));
    assertEq(btcOut + vault.assetBalance(address(wbtcLike)), totalBtc, "wbtc conserved");
    assertEq(ethOut + vault.assetBalance(address(wethLike)), totalEth, "weth conserved");
    assertGe(vault.navPerShareWad() + 1, psBefore, "NAVps non-decreasing for remaining members");
    assertGe(usdc.balanceOf(address(vault)), vault.idleUsdc() + vault.totalPendingUsdc(), "usdc solvent");
}
```


### 5. UniswapV3Adapter: Partial-fill refund, clamp, approval revoke, nonReentrant (HIGH)

src/UniswapV3Adapter.sol L113-118 and L202-208. The invariant handler only ever sets 100% spend and AdapterReentrancy.t.sol never touches this adapter. New file test/UniswapV3AdapterRefundReentrancy.t.sol.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {UniswapV3Adapter, ISwapRouter02} from "../src/UniswapV3Adapter.sol";
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";
contract PartialV3Router {
    uint256 public pull;
    uint256 public deliver;
    uint256 public pushBack;
    bool public reenter;
    bool public reentered;
    bytes4 public lastRevert;
    address public usdc;
    address public weth;
    function configure(address usdc_, address weth_, uint256 pull_, uint256 deliver_, uint256 pushBack_, bool re) external {
        (usdc, weth, pull, deliver, pushBack, reenter) = (usdc_, weth_, pull_, deliver_, pushBack_, re);
        MockERC20(usdc_).mint(address(this), 1e6 + pushBack_);
    }
    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external returns (uint256) {
        if (pull > 0) MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), pull);
        if (pushBack > 0) MockERC20(p.tokenIn).transfer(msg.sender, pushBack);
        if (reenter) {
            reenter = false;
            MockERC20(usdc).approve(msg.sender, type(uint256).max);
            IExecutionAdapter.SwapOrder memory o = IExecutionAdapter.SwapOrder({
                tokenIn: usdc, tokenOut: weth, amountIn: 1e6, minAmountOut: 0.0005e18,
                deadline: block.timestamp, routeData: ""
            });
            try UniswapV3Adapter(msg.sender).executeSwap(o) {
                reentered = true;
            } catch (bytes memory err) {
                lastRevert = bytes4(err);
            }
        }
        MockERC20(p.tokenOut).mint(p.recipient, deliver);
        return deliver;
    }
}
contract UniswapV3AdapterRefundReentrancyTest is Test {
    uint256 constant AMOUNT_IN = 10_000e6;
    uint256 constant DELIVER = 4.2e18; // above 99% of $10,000 at $2,400
    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    PartialV3Router router;
    UniswapV3Adapter adapter;
    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("WETH", 18);
        oracle = new MockOracle();
        oracle.setPrice(address(usdc), 1e18);
        oracle.setPrice(address(weth), 2400e18);
        router = new PartialV3Router();
        UniswapV3Adapter.FeeTierEntry[] memory t = new UniswapV3Adapter.FeeTierEntry[](1);
        t[0] = UniswapV3Adapter.FeeTierEntry(address(usdc), address(weth), 500);
        adapter = new UniswapV3Adapter(address(router), IOracleAggregator(address(oracle)), address(usdc), 100, t);
        usdc.mint(address(this), AMOUNT_IN);
        usdc.approve(address(adapter), type(uint256).max);
    }
    function _order() internal view returns (IExecutionAdapter.SwapOrder memory) {
        return IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc), tokenOut: address(weth), amountIn: AMOUNT_IN,
            minAmountOut: DELIVER, deadline: block.timestamp + 1 hours, routeData: ""
        });
    }
    function test_partialFillRefundsExactUnspentAndRevokesApproval() public {
        router.configure(address(usdc), address(weth), 4_000e6, DELIVER, 0, false);
        adapter.executeSwap(_order());
        assertEq(usdc.balanceOf(address(this)), 6_000e6, "refund = amountIn - pulled");
        assertEq(weth.balanceOf(address(this)), DELIVER);
        assertEq(usdc.balanceOf(address(adapter)), 0, "adapter empty");
        assertEq(usdc.allowance(address(adapter), address(router)), 0, "approval revoked");
    }
    function test_pushBackAboveAmountInIsClampedAndStrandedNotRefunded() public {
        router.configure(address(usdc), address(weth), 0, DELIVER, AMOUNT_IN + 500e6, false);
        adapter.executeSwap(_order());
        assertEq(usdc.balanceOf(address(this)), AMOUNT_IN, "refund clamped at amountIn");
        assertEq(usdc.balanceOf(address(adapter)), 500e6, "excess push strands");
    }
    function test_nestedSwapRevertsReentrancyAndLockReleases() public {
        router.configure(address(usdc), address(weth), 4_000e6, DELIVER, 0, true);
        adapter.executeSwap(_order());
        assertEq(router.lastRevert(), UniswapV3Adapter.Reentrancy.selector, "guard fired");
        assertFalse(router.reentered());
        assertEq(usdc.balanceOf(address(this)), 6_000e6, "outer refund intact");
        // lock released: a second plain order must work
        usdc.mint(address(this), AMOUNT_IN);
        router.configure(address(usdc), address(weth), AMOUNT_IN, DELIVER, 0, false);
        adapter.executeSwap(_order());
        assertEq(weth.balanceOf(address(this)), DELIVER * 2);
    }
}
```


### 6. BoundedCall: Library has no direct test (HIGH)

src/lib/BoundedCall.sol. Guards member exit liveness against creator-chosen modules. Untested: gas burn against the 300k cap, returndata bomb on success, 1 to 31 byte returndata (L-3 dirty memory fix), codeless target. New file test/BoundedCall.t.sol.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {BoundedCall} from "../src/lib/BoundedCall.sol";
contract Burner { fallback() external { while (true) {} } }
contract ShortRet { fallback(bytes calldata) external returns (bytes memory) { return hex"ab"; } }
contract BigRet {
    uint256 public immutable words;
    constructor(uint256 w) { words = w; }
    fallback(bytes calldata) external returns (bytes memory r) {
        r = new bytes(words * 32);
        assembly { mstore(add(r, 0x20), 7) }
    }
}
contract Quiet { fallback() external {} }
contract Harness {
    function call_(address t, uint256 g) external returns (bool, uint256, uint256) {
        assembly { mstore(mload(0x40), not(0)) } // dirty the scratch word the library copies into
        return BoundedCall.boundedCall(t, hex"deadbeef", g);
    }
    function static_(address t, uint256 g) external view returns (bool, uint256, uint256) {
        assembly { mstore(mload(0x40), not(0)) }
        return BoundedCall.boundedStaticCall(t, hex"deadbeef", g);
    }
}
contract BoundedCallTest is Test {
    Harness h = new Harness();
    function test_gasBurnerIsCappedAndReportsFailure() public {
        address b = address(new Burner());
        uint256 g0 = gasleft();
        (bool ok,,) = h.call_(b, 300_000);
        assertFalse(ok);
        assertLt(g0 - gasleft(), 400_000, "caller pays at most the cap plus overhead");
        (ok,,) = h.static_(b, 300_000);
        assertFalse(ok);
    }
    function test_shortReturnWordIsZeroPaddedNotDirtyMemory() public {
        address s = address(new ShortRet());
        (bool ok, uint256 w, uint256 n) = h.call_(s, 100_000);
        assertTrue(ok);
        assertEq(n, 1);
        assertEq(w, uint256(0xab) << 248, "L-3: low bytes must be zero, not 0xff junk");
        (ok, w, n) = h.static_(s, 100_000);
        assertEq(w, uint256(0xab) << 248);
    }
    function test_successfulBombIsReadAsOneWordAndCheap() public {
        address bomb = address(new BigRet(2_000)); // 64 KB
        uint256 g0 = gasleft();
        (bool ok, uint256 w, uint256 n) = h.call_(bomb, 5_000_000);
        uint256 used = g0 - gasleft();
        assertTrue(ok);
        assertEq(n, 64_000);
        assertEq(w, 7);
        assertLt(used, 120_000, "caller does not pay to copy the buffer");
    }
    function test_noReturnAndCodelessTargets() public {
        (bool ok, uint256 w, uint256 n) = h.call_(address(new Quiet()), 100_000);
        assertTrue(ok); assertEq(n, 0); assertEq(w, 0);
        (ok, w, n) = h.call_(address(0xBEEF), 100_000); // codeless: success, empty
        assertTrue(ok); assertEq(n, 0);
    }
}
```


### 7. Governance: execute replay, window over, tie, NoCommit, BadReveal, double reveal (HIGH)

src/Governance.sol L691-693 and the reveal path. A replayable or late execute re-spends vault funds, and only TimelockActive is asserted today. Add to test/Governance.t.sol.

```solidity
function _passRebalanceToExecutable() internal returns (uint256 pid) {
    pid = _propose();
    _commitAndReveal(pid, creator, true);
    _commitAndReveal(pid, alice, true);
    _revealPhase(pid);
    _reveal(pid, creator, true);
    _reveal(pid, alice, true);
    vm.warp(block.timestamp + 6 hours);
    gov.finalize(pid);
    vm.warp(block.timestamp + 1 days);
}

function test_gap_executeReplay() public {
    uint256 pid = _passRebalanceToExecutable();
    gov.execute(pid, REBALANCE_PAYLOAD);
    vm.expectRevert(Governance.NotPassed.selector); // replay
    gov.execute(pid, REBALANCE_PAYLOAD);
}

function test_gap_executeAfterWindow() public {
    uint256 pid = _passRebalanceToExecutable();
    (,,,,,,, uint64 expiresAt,,,,,,,,) = _p(pid);
    vm.warp(uint256(expiresAt) + 1);
    vm.expectRevert(Governance.ExecutionWindowOver.selector);
    gov.execute(pid, REBALANCE_PAYLOAD);
}

function test_gap_tieDefeats_andRevealGuards() public {
    uint256 pid = _propose();
    _commitAndReveal(pid, creator, true);
    _commitAndReveal(pid, alice, false);
    _revealPhase(pid);
    vm.prank(bob);
    vm.expectRevert(Governance.NoCommit.selector);
    gov.revealVote(pid, true, SALT);
    vm.prank(creator);
    vm.expectRevert(Governance.BadReveal.selector);
    gov.revealVote(pid, false, SALT); // committed true
    _reveal(pid, creator, true);
    vm.prank(creator);
    vm.expectRevert(Governance.AlreadyRevealed.selector);
    gov.revealVote(pid, true, SALT);
    _reveal(pid, alice, false);
    vm.warp(block.timestamp + 6 hours);
    gov.finalize(pid); // 1000 FOR == 1000 AGAINST, quorum 2000/5000 >= 25%
    assertEq(uint8(_status(pid)), uint8(Governance.Status.Defeated), "tie defeats");
}
```


### 8. Governance: ChildAllocation never run through gov.execute (HIGH)

src/Governance.sol L702-706. Tests call allocateToChild with a pranked governance address and bypass the payload decode, the ordering and the zero guards. Add to test/SubVaults.t.sol.

```solidity
function test_gap_childAllocation_executesThroughGovernance() public {
    vm.prank(operator);
    gov.registerVault(address(parent), _gcfg(2_500));
    skip(1);
    uint256 allocate = 300 * USDC_1;
    bytes memory payload = abi.encode(address(child), allocate, uint256(0));

    vm.prank(operator);
    uint256 pid = gov.propose(address(parent), Governance.ProposalType.ChildAllocation, keccak256(payload));
    bytes32 s = keccak256("s");
    vm.prank(operator);
    gov.commitVote(pid, keccak256(abi.encode(pid, operator, true, s)));
    vm.prank(alice);
    gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, s)));
    (,,,, uint64 cd, uint64 rd,,,,,,,,,,) = gov.proposals(pid);
    vm.warp(cd);
    vm.prank(operator);
    gov.revealVote(pid, true, s);
    vm.prank(alice);
    gov.revealVote(pid, true, s);
    vm.warp(rd);
    gov.finalize(pid);

    // Wrong payload (different amount) must not execute; hash binds the allocation.
    vm.warp(block.timestamp + 1 days);
    vm.expectRevert(Governance.BadPayload.selector);
    gov.execute(pid, abi.encode(address(child), allocate + 1, uint256(0)));

    gov.execute(pid, payload);
    assertGt(child.sharesOf(address(parent)), 0, "parent holds child shares");

    // Replay must fail.
    vm.expectRevert(Governance.NotPassed.selector);
    gov.execute(pid, payload);
}
```


### 9. Governance: RuleChange update path skips the parent quorum floor test (HIGH)

src/Governance.sol L700 (_requireParentQuorumFloor has zero hits in test/). Only registration time SV-6 is tested. Add to test/SubVaults.t.sol.

```solidity
function test_gap_ruleChangeCannotUndercutParentQuorumFloor() public {
    vm.startPrank(operator);
    gov.registerVault(address(parent), _gcfg(4_000));
    gov.registerVault(address(child), _gcfg(4_000));
    vm.stopPrank();

    vm.startPrank(alice);
    usdc.approve(address(child), type(uint256).max);
    child.deposit(1_000 * USDC_1);
    child.skipWindow();
    vm.stopPrank();
    skip(1);

    bytes memory payload = abi.encode(_gcfg(3_000)); // below parent's 4000
    vm.prank(alice);
    uint256 pid = gov.propose(address(child), Governance.ProposalType.RuleChange, keccak256(payload));
    bytes32 s = keccak256("s");
    vm.prank(alice);
    gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, s)));
    (,,,, uint64 cd, uint64 rd,,,,,,,,,,) = gov.proposals(pid);
    vm.warp(cd);
    vm.prank(alice);
    gov.revealVote(pid, true, s);
    vm.warp(rd);
    gov.finalize(pid);
    vm.warp(block.timestamp + 1 days);

    vm.expectRevert(Governance.BadGovConfig.selector);
    gov.execute(pid, payload);
    (,,,, uint16 q,,,) = gov.configOf(address(child));
    assertEq(q, 4_000, "child quorum unchanged");
}
```


### 10. VaultFactory: Child path C-6 allowlist and coverage gates, attestation and order (HIGH)

src/VaultFactory.sol L246, L254, L262. Every allowlist suite runs with allowSubVaults=false, and VaultCreated and attestation operator arguments are never asserted. Mitigated while sub-vaults stay disabled. New file test/audit/AuditFactoryChildGates.t.sol.

```solidity
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
import {MockERC20, MockOracle} from "../mocks/Mocks.sol";
import {PROTOCOL_INITIALIZER} from "../../src/lib/ProtocolInitializer.sol";

contract AuditFactoryChildGatesTest is Test {
    uint256 constant USDC_1 = 1e6;
    event VaultCreated(address indexed vault, address indexed creator, address usdc, uint256 capacityCapUsdc);

    MockERC20 usdc;
    MockERC20 usdc2;
    MockERC20 weth;
    MockOracle blessed;
    MockOracle rogue;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    VaultFactory factory;
    address creator = makeAddr("creator");
    address other = makeAddr("other");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USDC", 6);
        usdc2 = new MockERC20("USDC2", 6);
        weth = new MockERC20("wETH", 18);
        blessed = new MockOracle();
        rogue = new MockOracle();
        blessed.setPrice(address(weth), 2500e18);
        rogue.setPrice(address(weth), 2500e18);

        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        FeeEngine fees = new FeeEngine(IRegistryView(address(registry)));
        Governance gov = new Governance();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(subReg),
            IVaultDeployer(address(new VaultDeployer())),
            true // sub-vaults ENABLED: the only configuration where the child gates are reachable
        );
        address[] memory allow = new address[](1);
        allow[0] = address(blessed);
        vm.prank(PROTOCOL_INITIALIZER);
        factory.initialize(allow);
        vm.prank(PROTOCOL_INITIALIZER);
        registry.wire(address(factory), address(fees));
        vm.prank(PROTOCOL_INITIALIZER);
        subReg.wire(address(factory));
        vm.prank(PROTOCOL_INITIALIZER);
        gov.wireSubVaultRegistry(address(subReg));
    }

    function _p(address usdc_, address oracle) internal view returns (VaultFactory.VaultParams memory) {
        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        return VaultFactory.VaultParams({
            usdc: usdc_,
            basketAssets: basket,
            oracle: IOracleAggregator(oracle),
            capacityCapUsdc: 0,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: 50,
            exitFeeDecayPeriod: 30 days,
            allowedAdapters: new address[](0)
        });
    }

    // G2: the C-6 allowlist must bind the CHILD path too.
    function test_childPathEnforcesOracleAllowlist() public {
        vm.prank(creator);
        address parent = factory.createVault(_p(address(usdc), address(blessed)));
        vm.prank(creator);
        vm.expectRevert(VaultFactory.OracleNotAllowed.selector);
        factory.createChildVault(_p(address(usdc), address(rogue)), parent);
        assertEq(factory.vaultCount(), 1, "rogue child left nothing behind");
        assertEq(subReg.depthOf(parent), 0);
    }

    // G1: UsdcMismatch, ordered after the creator check.
    function test_childPathRejectsDifferentUsdc() public {
        vm.prank(creator);
        address parent = factory.createVault(_p(address(usdc), address(blessed)));
        vm.prank(creator);
        vm.expectRevert(VaultFactory.UsdcMismatch.selector);
        factory.createChildVault(_p(address(usdc2), address(blessed)), parent);
        vm.prank(other); // creator check precedes the usdc check
        vm.expectRevert(VaultFactory.NotParentCreator.selector);
        factory.createChildVault(_p(address(usdc2), address(blessed)), parent);
    }

    // G3: the child's own oracle must price the child's basket (parent's pricing is irrelevant).
    function test_childPathEnforcesOracleCoversBasket() public {
        vm.prank(creator);
        address parent = factory.createVault(_p(address(usdc), address(blessed)));
        blessed.setPrice(address(weth), 0); // oracle stops pricing weth after parent exists
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.OracleMissingAsset.selector, address(weth)));
        factory.createChildVault(_p(address(usdc), address(blessed)), parent);
        assertEq(factory.vaultCount(), 1);
    }

    // G4-G7: events, allVaults order, attestation identity, child attestation and edge.
    function test_attestsMsgSenderAndRecordsInOrder() public {
        vm.expectEmit(false, true, false, true, address(factory));
        emit VaultCreated(address(0), creator, address(usdc), 0);
        vm.prank(creator);
        address parent = factory.createVault(_p(address(usdc), address(blessed)));

        uint256 opId = registry.operatorIdOf(creator);
        assertGt(opId, 0, "creator registered as operator");
        assertEq(registry.operatorOf(parent), opId, "vault attested to msg.sender, not someone else");
        assertEq(registry.operatorIdOf(address(factory)), 0, "factory is not an operator");

        vm.prank(creator);
        address child = factory.createChildVault(_p(address(usdc), address(blessed)), parent);
        assertEq(registry.operatorOf(child), opId, "child attested to creator");
        assertEq(subReg.parentOf(child), parent, "edge registered");

        assertEq(factory.vaultCount(), 2);
        assertEq(factory.allVaults(0), parent, "order: parent first");
        assertEq(factory.allVaults(1), child, "order: child second");
    }
}
```


## Appendices: per contract findings

Each appendix is the analysis per contract, lightly edited. The test blocks inside them are
repeated for completeness where they are not in the top 10.

## Appendix A: VaultCore

### Test-gap analysis: src/VaultCore.sol (1143 lines)
Method: full read of the contract; grep of contracts/test (incl test/audit, excluding test/retired) for
error selectors, function names and modifiers. Nothing was compiled or run (no forge). "No test" below
means a grep for the identifier found no reference in a test. Coverage % was NOT measured. Greps are by
name, so an error exercised only through a bare `vm.expectRevert()` would be missed; none was seen.

#### 1) Uncovered / likely-uncovered functions and branches

Custom errors with ZERO references in test/ (grep `\bName\b` returns nothing, or only a comment):
- `PendingExists` (src 451): second first-time deposit while pending. No test.
- `NoPending` (464, 471): `activate(member)` / `cancelPending()` with nothing pending. No test.
- `NoQueuedExit` (618): `settleQueuedExit` for a member with no queue. No test.
- `NothingToClaim` (1053): `claimEscrowed` with empty escrow. No test.
- `InsufficientShares` (578, 646): `requestExit` above balance. Only a comment in AuditDelegatedQuorum:414.
- `ZeroAmount` (430, 508, 577): zero deposit, zero exit, and the mint-rounds-to-zero branch (508). Only a comment.
- `InsufficientAssetBalance` (827, 965, 969): allocate above idle, rebalance leg above idle / assetBalance.
- `SwapSlippage` (978): measured output below `minAmountOut` (the EX-3 lying-adapter defence). No test.
- `TooManyChildren` (830): the MAX_CHILDREN = 8 cap. No test (`MAX_CHILDREN` never referenced either).
- `MAX_BASKET_ASSETS` is only hit via the factory in Sprint6Fixes:137 (11 assets). Boundary of exactly 10 untested.

Functions with no direct test:
- `pullChildEscrow` (903-911): grep finds only the ABI-register string in AuditReentrancyGuardCoverage:56.
  Both branches (asset == usdc vs basket asset), `BadSwapToken`, `NotRegisteredChild` untested.

Branches likely uncovered (no test found):
- Constructor (277-319): `usdc_==0`, `creator_==0`, `minDeposit==0`, `exitFeeMaxBps>0 && decay==0`,
  basket entry == usdc, duplicate basket entry, zero basket entry, basket asset decimals > 18, USDC
  decimals > 18. Only seen: decimals < 6 (Sprint6Fixes:143 style), an `exitFeeMaxBps` of 101 as a test input over `EXIT_FEE_CAP_BPS` (Eip170:216),
  11-asset basket (Sprint6Fixes:137). Verify with a constructor-revert sweep.
- `_deposit` 444: `received < minDepositUsdc` after a fee-on-transfer USDC (fee-on-transfer mocks exist only
  for `tokenIn` of a swap, AuditAdapterScopedSweep:127). No fee-on-transfer USDC deposit test.
- `_settleExit` 676: `usdcPay > idleUsdc` clamp (cash target above idle because child value inflates it)
  only reachable with children; covered indirectly by SubVaults:258 only for the unwind, not the clamp edge.
- `_settleExit` 705-729: shortfall unwind with `_childPendingExecution(child)==true` (skip), `cv==0`,
  `cs==0`, multi-child iteration, partial-delivery (`receivedWad < shortfallWad`) loop continuing to the
  next child. Only AuditDosExitLiveness B1/B2/A3 touch this, one child each.
- `_settleExit` 742-745: `feeEngine.onRealize` reverting on the GAIN path (ModuleHardening:112 asserts the
  event once; the loss-path `else` at 755 emitting ModuleCallFailed is untested).
- `_settleExit` 770-784: `_payOrEscrow` to feeEngine returning false for a BASKET-asset fee slice
  (794-803). USDC fee leg escrow is covered (AuditUsdcLegEscrow:139); the in-kind fee leg escrow is not.
- `_settleExit` 783 / 801: `onFeeCollected` / `onFeeCollectedAsset` reverting (`collectOk`/`assetOk` false).
- `executeRebalance` 990-994: refund of unspent input is touched by AuditAdapterScopedSweep (fee-on-transfer
  tokenIn) only; the multi-order loop with mixed USDC/basket legs and `orders.length == 0` event is thin.
- `parentVault()` (529-533): only the "no parent" result is asserted (AuditRootVaultsOnly:182). The cached
  parent path (`_cachedParentVault`) and `_snapshot` with `pv != 0` are exercised only if allowSubVaults
  tests run (launch has it false); grep shows no test asserting `votingEligibleShares(parent)==0`.

#### 2) Invariants not fuzzed (test/VaultCoreInvariant.t.sol, FeeCarryInvariant, SystemInvariant)

Existing: sharesConserved, queuedConsistent, pendingEscrowConsistent, solvency (USDC only), creatorFloor
(weak: only asserts queue <= shares), plus NAVps-nondecreasing asserted inline in the handler.
Config of VaultCoreInvariantTest (lines 174-198): EMPTY basket, no adapters, no children, `StubFeeEngine`
fee 0, exit fee 1%. So the following are NOT fuzzed anywhere:
- Basket-asset conservation: `assetBalance[a] <= IERC20(a).balanceOf(vault)` and in-kind slice
  conservation (member + fee + escrow == slice). No basket in the invariant vault.
- Full solvency incl. claimable: `balanceOf(usdc) >= idleUsdc + totalPendingUsdc + sum(claimable[*][usdc])`
  (the current invariant omits the escrow term, so an escrow bug that double counts would not be seen).
- `holderCount` == count of addresses with shares > 0, and `nonCreatorMemberCount` == holders minus creator.
  Handler tracks neither. (AuditCreatorGateTraps:266 is a unit test, not a fuzz.)
- Checkpoint consistency: `pastTotalVotingEligibleShares(now) == totalVotingEligibleShares()` and
  `pastVotingEligibleShares(m, now) == votingEligibleShares(m)`; `pastHolderCount(now) == holderCount`.
- Performance fee bound: feeEngine receives <= 10% of gain per exit (FeeCarryInvariant checks the engine
  side with its own ghost, not VaultCore's clamp with a hostile engine returning type(uint256).max).
- Rebalance: NAV change per `executeRebalance` bounded by `maxSlippageBps` of leg value (no handler action
  calls executeRebalance; only fixed-example tests do).
- Mode F: `settleQueuedExit` after deposit-between-queue-and-settle (AuditExitFeeRatchet:424 is a unit test).
- Price-moving fuzz: prices are static by design (comment line ~175), so NAVps monotonicity under oracle
  moves, and gain/loss branch selection (741 vs 751), are not fuzzed.
- `MIN_POSITION_SHARES`: only `testFuzz_noExitLeavesADustPosition` (AuditExitFeeRatchet:480); no
  invariant "every holder balance is 0 or >= 1e18 unless it arrived by mint".

#### 3) Access-controlled paths lacking a negative test

VaultCore has exactly one auth pattern: `require(msg.sender == address(governance), OnlyGovernance())`.
| function | src line | negative test found? |
|---|---|---|
| `allocateToChild` | 821 | Yes: SubVaults:332 `test_childFlowsAreGovernanceOnly` (confirm it covers allocate AND redeem) |
| `redeemFromChild` | 859 | Same test (SubVaults:332); not asserted separately |
| `executeRebalance` | 935 | Yes: Execution.t.sol:365 `test_rebalanceOnlyThroughGovernance` |
| `pullChildEscrow` | none | PERMISSIONLESS by design (903); no test of caller-independence or of non-registered child |
| `activate`, `settleQueuedExit` | none | permissionless by design; no test that a third party cannot change the beneficiary (it pays `member`) |
Missing: `executeRebalance` called by the CREATOR / a voting majority holder directly (expects OnlyGovernance).
Missing: after a governance contract is wired as `StubGovernance`, no test that `address(0)` governance
(immutable zero) bricks nothing; constructor does not reject `governance_ == 0` (277 only checks usdc, creator).

#### 4) Reentrancy edge cases missing

Covered: AuditReentrancyGuardCoverage (ABI register of mutating externals), AuditLookThroughReadOnlyReentrancy
(child mid-swap), AuditFeeEngineReentrancy, AdapterReentrancy, AuditSafeTransferBounded.
Not found by grep:
- Token callback re-entering `deposit`/`requestExit` from the USDC `transferFrom` (ERC-777 style hook) during
  `_deposit` at 442 (balance read before/after is the only guard besides the lock).
- Re-entry from `_payOrEscrow` -> `tryTransfer` recipient (member contract with a hook) into `claimEscrowed`
  or `cancelPending` mid-`_settleExit` pass 2 (lock should block; no test with a hooked basket asset).
- Re-entry from `feeEngine.onFeeCollected*` (bounded, 300k gas) into the vault: AuditFeeEngineReentrancy tests the
  engine's own mutex, not VaultCore's lock rejecting a callback to `requestExit`.
- Re-entry from `operatorRegistry.recordRealization` into `deposit` (boundedCall swallows revert, so a
  Reentrancy revert becomes a silent `ModuleCallFailed`; nothing asserts that).
- `executeRebalance` adapter calling back `vault.deposit` / `requestExit` mid-leg to mint at the understated NAV
  (the direct, non-look-through version of H-9; lock should block, one test exists only via parent pricing).
- `claimEscrowed` of an asset whose transfer re-enters `claimEscrowed` (CEI is zero-before-transfer at 1054; untested).

#### 5) Fee-math / rounding edge cases missing

- `feeFracWad` (765): `payoutValueWad == 0` branch; `perfFee * usdcScalar * WAD` overflow bound with a hostile
  engine is clamped at 748 first (gain/10) but the clamp itself has only `test_perfFeeClampedTo10PctOfGain` at one point.
- Sum conservation per exit: usdcFee + usdcPay_after + per-slice (feePart + memberPart) == pre-fee legs, for
  fuzzed `feeFracWad` and 6/8/18-decimal slices (AuditExitSliceRounding:141 is two fixed examples).
- `gain` where `payoutValueUsdc == basisRemoved` (neither gain nor loss; falls to the loss `else` with loss 0): no test.
- `gain/10` rounding when gain < 10 wei-units (cap = 0, perfFee forced 0, but `_recordRealization` still
  records full gain): not asserted.
- `basisRemoved = costBasis * burn / memberShares` rounding to 0 on tiny burns, repeated tiny exits draining
  fee-free gain (floor division favors the exiter on basis). No fuzz of N small exits vs one big exit.
- `_exitFeeBps`: boundaries tenure == period - 1, == period, and `lastDepositTime` reset on top-up deposit
  (`test_exitFeeDecaysWithTenure`, VaultCore.t.sol:234, is a single decay check). Sole-holder waiver `memberShares == ts` (657) with queued shares.

#### 6) Ranking by funds at risk

| # | gap | rank | reason |
|---|---|---|---|
| G1 | `SwapSlippage` / measured-delta check (978) has no test | CRITICAL | the only defence against an adapter that reports success but delivers nothing; a regression drains rebalanced capital |
| G2 | Fee-on-transfer / short-receipt USDC deposit (441-444) and `received` accounting | HIGH | overcrediting shares vs real receipt is an insolvency vector; no test with a short-delivering token |
| G3 | Exit payout conservation under fees with basket legs (fuzz) incl. escrowed fee slice (794-803) | HIGH | rounding drift or double-pay across 3 legs moves member funds; only fixed examples exist |
| G4 | `pullChildEscrow` untested (903) | HIGH | credits accounting from a balance delta with no direct test; sub-vaults off at launch lowers urgency |
| G5 | `claimEscrowed` empty/re-entrant/zero-before-transfer | MED | CEI is correct on read; no regression test |
| G6 | Missing basket + escrow terms in solvency invariant | MED | would catch G3/G5 classes automatically |
| G7 | Constructor BadConfig sweep | MED | immutable misconfig is permanent; only factory-level partial coverage |
| G8 | `TooManyChildren`, `InsufficientAssetBalance`, `InsufficientShares`, `NoPending`, `NoQueuedExit`, `PendingExists`, `NothingToClaim`, `ZeroAmount` | LOW | all revert safely before state change; cheap one-liners |

#### Concrete tests for G1, G2, G3 (add to contracts/test/VaultCore.t.sol; reuse its setUp, `usdc`, `wbtcLike`,
#### `oracle`, `gov`, `fees`, `registry`, `_seedCreator`, `_join`, `_fundBasket`). NOT compiled or run.

```solidity
// ---- G1: lying adapter, SwapSlippage (EX-3). Needs imports: IExecutionAdapter, IOperatorRegistry etc. as in file.
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";

contract LyingAdapter is IExecutionAdapter {
    uint256 public deliver; // wbtc-like units to mint to caller
    MockERC20 public tokenOut;
    constructor(MockERC20 t) { tokenOut = t; }
    function setDeliver(uint256 d) external { deliver = d; }
    function executeSwap(SwapOrder calldata) external returns (uint256) {
        if (deliver > 0) tokenOut.mint(msg.sender, deliver);
        return type(uint256).max; // claims a huge output regardless; vault must ignore it
    }
}

// inside VaultCoreTest:
function _vaultWithAdapter(address adapter) internal returns (VaultCore v) {
    address[] memory basket = new address[](1);
    basket[0] = address(wbtcLike);
    address[] memory adapters = new address[](1);
    adapters[0] = adapter;
    v = new VaultCore(address(usdc), basket, creator, registry, gov, fees, oracle,
        10_000_000 * USDC_1, 10 * USDC_1, 0, 0, adapters, address(0));
    vm.startPrank(creator);
    usdc.approve(address(v), type(uint256).max);
    v.deposit(10_000 * USDC_1);
    v.skipWindow(); // activates the pending deposit immediately
    vm.stopPrank();
}

function test_gap_executeRebalance_shortDeliveryRevertsSwapSlippage() public {
    LyingAdapter lie = new LyingAdapter(wbtcLike);
    VaultCore v = _vaultWithAdapter(address(lie));
    // 1000 USDC -> 0.01 BTC (1e6 units at $100k). minOut sits exactly at fair value.
    IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](1);
    orders[0] = IExecutionAdapter.SwapOrder({
        tokenIn: address(usdc), tokenOut: address(wbtcLike), amountIn: 1_000 * USDC_1,
        minAmountOut: 1e6, deadline: block.timestamp + 1 hours, routeData: ""
    });
    uint256 idleBefore = v.idleUsdc();

    lie.setDeliver(1e6 - 1); // one unit short, adapter still returns max uint
    vm.prank(address(gov));
    vm.expectRevert(VaultCore.SwapSlippage.selector);
    v.executeRebalance(address(lie), 200, orders);
    assertEq(v.idleUsdc(), idleBefore, "revert rolled the debit back");
    assertEq(v.assetBalance(address(wbtcLike)), 0, "nothing credited");

    lie.setDeliver(1e6); // exactly minOut passes, and credit is the MEASURED delta, not the claimed one
    vm.prank(address(gov));
    v.executeRebalance(address(lie), 200, orders);
    assertEq(v.assetBalance(address(wbtcLike)), 1e6, "credited measured delta");
    assertEq(v.idleUsdc(), idleBefore - 1_000 * USDC_1 + 1_000 * USDC_1, "unspent input refunded: adapter pulled none");
}

// ---- G2: short-receipt (fee-on-transfer) USDC deposit. Local token; 6 decimals, 1% burned on transferFrom.
contract FotUsdc {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a - a / 100; return true;
    }
}

function test_gap_feeOnTransferUsdcCreditsReceivedNotRequested() public {
    FotUsdc fot = new FotUsdc();
    VaultCore v = new VaultCore(address(fot), new address[](0), creator, registry, gov, fees, oracle,
        0, 10 * USDC_1, 0, 0, new address[](0), address(0));
    fot.mint(alice, 1_000 * USDC_1);
    vm.startPrank(alice);
    fot.approve(address(v), type(uint256).max);
    v.deposit(100 * USDC_1);
    (uint256 pend,) = v.pendingDeposit(alice);
    assertEq(pend, 99 * USDC_1, "escrow records the 99 received, not the 100 requested");
    assertEq(v.totalPendingUsdc(), 99 * USDC_1);
    assertGe(fot.balanceOf(address(v)), v.idleUsdc() + v.totalPendingUsdc(), "solvent");
    vm.stopPrank();
    // A deposit whose RECEIPT falls under the minimum reverts even though the request met it.
    vm.prank(alice);
    vm.expectRevert(VaultCore.BelowMinDeposit.selector);
    v.deposit(10 * USDC_1); // 10 requested -> 9.9 received < min 10
}

// ---- G3: exit conservation with perf fee + two basket legs, fuzzed price gain.
function testFuzz_gap_exitConservesAllLegsWithPerfFee(uint256 gainBps, uint256 feeSeed) public {
    gainBps = bound(gainBps, 1, 5_000); // up to +50%
    _seedCreator(1_000 * USDC_1);
    _join(alice, 1_000 * USDC_1);
    _fundBasket(1e8, 10e18);
    skip(30 days);
    oracle.setPrice(address(wbtcLike), 100_000e18 * (10_000 + gainBps) / 10_000);
    oracle.setPrice(address(wethLike), 4_000e18 * (10_000 + gainBps) / 10_000);
    fees.setFeeToCharge(bound(feeSeed, 0, type(uint128).max)); // hostile: clamp at gain/10 must hold

    uint256 totalBtc = wbtcLike.balanceOf(address(vault));
    uint256 totalEth = wethLike.balanceOf(address(vault));
    uint256 burn = vault.sharesOf(alice);
    uint256 psBefore = vault.navPerShareWad();
    vm.prank(alice);
    vault.requestExit(burn);

    // Every wei of each basket asset is in exactly one place: vault accounting, member, fee engine, or escrow.
    uint256 btcOut = wbtcLike.balanceOf(alice) + wbtcLike.balanceOf(address(fees)) + vault.claimable(alice, address(wbtcLike));
    uint256 ethOut = wethLike.balanceOf(alice) + wethLike.balanceOf(address(fees)) + vault.claimable(alice, address(wethLike));
    assertEq(btcOut + vault.assetBalance(address(wbtcLike)), totalBtc, "wbtc conserved");
    assertEq(ethOut + vault.assetBalance(address(wethLike)), totalEth, "weth conserved");
    assertGe(vault.navPerShareWad() + 1, psBefore, "NAVps non-decreasing for remaining members");
    assertGe(usdc.balanceOf(address(vault)), vault.idleUsdc() + vault.totalPendingUsdc(), "usdc solvent");
}
```


## Appendix B: Governance

### Test-gap analysis: src/Governance.sol (+ src/lib/Checkpoints.sol)
Method: read both files; grepped contracts/test (incl audit/, excl retired/). Nothing run (no forge).
"No test" means no grep hit; line numbers are src/Governance.sol unless noted.
Existing suites: test/Governance.t.sol, test/GovernanceInvariant.t.sol, test/audit/Audit{DelegatedQuorum,
QuorumRegimeDust,VoteAfterExit,StandingDefaultTtlVsCommit,DosExitLiveness,ExecutionWindowFreeze}.t.sol,
Execution.t.sol, SubVaults.t.sol.

#### 1) Uncovered / likely-uncovered functions and branches

Error selectors with ZERO test references (grep `-rl` over test/ returned nothing):
- `AlreadyRegistered` (L232), `NotVaultCreator` (L233): registerVault double-register and
  non-creator caller. (SubVaults.t.sol only registers once as creator.)
- `ZeroSubRegistry` (L67): wireSubVaultRegistry(address(0)).
- `NoCommit` (L417), `BadReveal` (L419), `AlreadyRevealed` (L418, L451, L545): reveal without
  commit, wrong support/salt, double reveal, and the `defaultApplied` consumed-flag replays on
  revealDelegated / applyStandingDefault.
- `HasDelegate` (L544), `DelegateNotRevealed` (L452): default blocked by delegation;
  crank before delegate reveals.
- `NotPassed` (L691), `ExecutionWindowOver` (L693): execute on Active/Defeated/Executed
  (replay!) and execute after expiresAt.
- `CannotDelegateDuringProposal` (L575): setDelegate while a proposal is live.
- `Checkpoints.ValueOverflow` (Checkpoints L21): no test touches the uint192 bound.
- `Cooldown` (L328): no hit for `Governance.Cooldown` (only the config field name appears).
- `WrongPhase` is asserted only at AuditDosExitLiveness L168/170 (finalize early, markExpired early);
  never for commit after deadline or reveal/crank/default outside the reveal phase.

Functions/branches never reached end to end:
- `execute` ChildAllocation branch (L702-706): the only mention of `ChildAllocation` in test/ is
  a comment (AuditDosExitLiveness L404). SubVaults.t.sol and Sprint6Fixes.t.sol call
  `allocateToChild`/`redeemFromChild` through `vm.prank(address(gov))`, bypassing the abi.decode
  of `(child, allocateUsdc, redeemShares)`, the allocate-then-redeem ordering, and the
  `> 0` guards. No proposal of type ChildAllocation is ever proposed in any test.
- `execute` RuleChange branch's `_requireParentQuorumFloor` (L700, F2 S6): no test lowers a child's
  quorum below its parent's via RuleChange (zero grep hits). Registration-time SV-6 is covered
  (SubVaults.t.sol L174-189); the update-time check is not.
- `execute` RuleChange/ChildAllocation with wrong payload (BadPayload) is untested; BadPayload is
  only asserted for Rebalance (Execution.t.sol L524).
- `markExpired` happy path: called in AuditDosExitLiveness/AuditExecutionWindowFreeze (not verified post-expiry).
- `isExecutor` (L760): real impl never called (only a mock, Mocks.sol L96); `clearStandingDefault` has no references.
- `finalize` tie (`forWeight == againstWeight`) -> Defeated: no explicit test found.

#### 2) Invariants not fuzzed (test/GovernanceInvariant.t.sol reviewed in full)

The handler (GovHandler.runRound) only drives: Rebalance type, 4 equal members (always the
sub-five regime), plain commit/reveal, empty payload. It never calls: RuleChange or
ChildAllocation proposals, revealDelegated, applyStandingDefault, setDelegate, setStandingDefault,
markExpired, deposits/exits between phases, or time warps outside the exact deadlines. It wraps
every action in try/catch, so failures are silent. Existing invariants are weak:
- `invariant_revealedNeverExceedsSnapshot` compares the handler's max revealedWeight to the
  vault's *current* totalShares, not to that proposal's own `snapshotTotal`.
- `invariant_atMostOneLiveProposal` only asserts `pid <= proposalCount` (tautology; does not
  assert the slot is exclusive).
- `invariant_roundAccountingConsistent` is a handler bookkeeping check, not a protocol property.
Missing properties worth fuzzing: (a) `delegatedForWeight[pid] <= forWeight` (claimed L162, underflow-
critical at L645); (b) per pid `revealedWeight <= snapshotTotal` and `for+against <= snapshotTotal`;
(c) revealDelegated/applyStandingDefault never change `revealedWeight` (VO-2b); (d) delegateAccrued
within cap; (e) a member counted once across reveal/default/crank; (f) status monotonicity;
(g) config always within `_validateConfig` bounds after RuleChanges; (h) Checkpoints: getAt monotone,
same-second push overwrites (the library has no direct test at all).

#### 3) Access-controlled paths lacking a negative test

- registerVault: `NotVaultCreator` and `AlreadyRegistered` untested; wireSubVaultRegistry
  `ZeroSubRegistry` untested (OnlyDeployer/AlreadyWired covered in Deploy.t.sol, Create2Protocol.t.sol).
- propose / setStandingDefault / setDelegate on an unregistered vault (`NotRegistered`): no
  Governance.t.sol assertion (hits are only SubVaults.t.sol and AuditRootVaultsOnly.t.sol).
- execute is permissionless by design; its gates (NotPassed, ExecutionWindowOver, BadPayload for
  RuleChange/ChildAllocation) lack negatives. Only TimelockActive (Governance.t.sol L149) and
  BadPayload for Rebalance (Execution.t.sol L524) exist. Vault-side `OnlyGovernance` is covered.

#### 4) Reentrancy edge cases missing

Governance has no guard; `execute` is CEI-correct (status = Executed at L696 before the vault call)
but nothing tests it. AdapterReentrancy.t.sol and AuditReentrancyGuardCoverage.t.sol make zero
`gov.propose|commitVote|revealVote|execute` calls.
- re-enter `gov.execute(pid, payload)` from an adapter/child callback inside `executeRebalance` /
  `allocateToChild`: should hit `NotPassed`. Untested.
- re-enter `gov.propose` inside execute: status is already Executed so `_isSettled` is true and a new
  proposal is accepted mid-execution. Intended? Untested.
- read-only reentrancy: propose/commit/reveal read vault views (`pastVotingEligibleShares`,
  `votingEligibleShares`) possibly while the vault lock is held. AuditLookThroughReadOnlyReentrancy
  covers parent look-through reads, not voting-weight reads.

#### 5) Rounding / quorum / threshold edge cases missing

Governance has no fee math (the 10% performance fee lives in FeeEngine); numerics are bps
cross-multiplications (no truncation). Missing:
- exact-boundary asserts on `>=`/`<=`: quorum equality (L669), threshold equality (L338), TTL
  `== setAt + DEFAULT_TTL` (L551), exact commit/reveal/expiresAt seconds. Only cap equality is
  tested (Governance.t.sol L289, AuditDelegatedQuorum L574).
- `forWeight == againstWeight` tie -> Defeated; sub-five regime at each memberCount 1..4 and 4/5/6.
- >= 5 regime where a member exits after snapshot (numerator shrinks, `snapshotTotal` fixed): only the
  sub-five variant is isolated (AuditDelegatedQuorum L370). RuleChange permanent veto by a leaver
  (`revealedWeight == snapshotTotal` unreachable) is documented, untested.
#### 6) Funds-at-risk ranking (Governance holds no funds; it gates executeRebalance/allocateToChild/
redeemFromChild, so risk = bypass of vote, window or hash)

| # | Gap | Rank | Why |
|---|-----|------|-----|
| G1 | ChildAllocation execute branch never run through gov.execute | HIGH | moves parent USDC into a child / redeems shares; decode, order and `>0` guards unverified |
| G2 | execute guards: NotPassed replay, ExecutionWindowOver, BadPayload for RuleChange/ChildAllocation, tie, execute reentrancy | HIGH | a replayable or late execute of a Rebalance/Allocation re-spends vault funds; only TimelockActive tested |
| G3 | F2 parent-quorum floor on RuleChange update (L700) | HIGH | lets a child be made easier to pass than its parent, then redeemFromChild drains parent stake |
| G4 | revealVote double-reveal / BadReveal / NoCommit; defaultApplied replay (AlreadyRevealed) | MED | double counting weight swings tally (money moves via Rebalance); implementation looks right but unasserted |
| G5 | Invariants a)-e) (weight counted once, delegatedFor <= for, quorum untouched by cranks) | MED | catches future regressions of VO-2b, the exact bug class already shipped once |
| G6 | registerVault NotVaultCreator / AlreadyRegistered | MED | a third party registering a hostile config on someone's vault (cooldown, quorum floor) |
| G7 | Cooldown, per-phase WrongPhase, CannotDelegateDuringProposal, HasDelegate | MED | liveness and mid-proposal manipulation, no direct funds |
| G8 | clearStandingDefault, isExecutor real impl, markExpired happy path, Checkpoints direct, dead errors | LOW | indirect coverage; hygiene |

No CRITICAL gap was found in Governance itself. G1 to G3 are the places where a bug in the vote, window or payload checks would be silent.

#### Concrete Foundry tests for G1, G2, G3

Conventions: SubVaultsTest (test/SubVaults.t.sol) setUp builds factory+parent(operator creator)+child,
wires gov, funds parent with operator and alice 1000 USDC each. GovernanceTest
(test/Governance.t.sol) has 5 equal members, `_cfg()`, `_propose()`, `_commitAndReveal`,
`_reveal`, `_revealPhase`, `_status`, and `SALT`. Add each test inside the named contract so the
helpers resolve. All imports already present in those files. Not compiled (forge not run).
`_gcfg` has timelock 1 day, window 2 days, commit/reveal 6h; setUp does not register vaults with gov.

##### G1 (add to SubVaultsTest): ChildAllocation through Governance.execute

```solidity
function test_gap_childAllocation_executesThroughGovernance() public {
    vm.prank(operator);
    gov.registerVault(address(parent), _gcfg(2_500));
    skip(1);
    uint256 allocate = 300 * USDC_1;
    bytes memory payload = abi.encode(address(child), allocate, uint256(0));

    vm.prank(operator);
    uint256 pid = gov.propose(address(parent), Governance.ProposalType.ChildAllocation, keccak256(payload));
    bytes32 s = keccak256("s");
    vm.prank(operator);
    gov.commitVote(pid, keccak256(abi.encode(pid, operator, true, s)));
    vm.prank(alice);
    gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, s)));
    (,,,, uint64 cd, uint64 rd,,,,,,,,,,) = gov.proposals(pid);
    vm.warp(cd);
    vm.prank(operator);
    gov.revealVote(pid, true, s);
    vm.prank(alice);
    gov.revealVote(pid, true, s);
    vm.warp(rd);
    gov.finalize(pid);

    // Wrong payload (different amount) must not execute; hash binds the allocation.
    vm.warp(block.timestamp + 1 days);
    vm.expectRevert(Governance.BadPayload.selector);
    gov.execute(pid, abi.encode(address(child), allocate + 1, uint256(0)));

    gov.execute(pid, payload);
    assertGt(child.sharesOf(address(parent)), 0, "parent holds child shares");

    // Replay must fail.
    vm.expectRevert(Governance.NotPassed.selector);
    gov.execute(pid, payload);
}
```

##### G2 (add to GovernanceTest): replay, window over, tie, NoCommit, BadReveal, double reveal

```solidity
function _passRebalanceToExecutable() internal returns (uint256 pid) {
    pid = _propose();
    _commitAndReveal(pid, creator, true);
    _commitAndReveal(pid, alice, true);
    _revealPhase(pid);
    _reveal(pid, creator, true);
    _reveal(pid, alice, true);
    vm.warp(block.timestamp + 6 hours);
    gov.finalize(pid);
    vm.warp(block.timestamp + 1 days);
}

function test_gap_executeReplay() public {
    uint256 pid = _passRebalanceToExecutable();
    gov.execute(pid, REBALANCE_PAYLOAD);
    vm.expectRevert(Governance.NotPassed.selector); // replay
    gov.execute(pid, REBALANCE_PAYLOAD);
}

function test_gap_executeAfterWindow() public {
    uint256 pid = _passRebalanceToExecutable();
    (,,,,,,, uint64 expiresAt,,,,,,,,) = _p(pid);
    vm.warp(uint256(expiresAt) + 1);
    vm.expectRevert(Governance.ExecutionWindowOver.selector);
    gov.execute(pid, REBALANCE_PAYLOAD);
}

function test_gap_tieDefeats_andRevealGuards() public {
    uint256 pid = _propose();
    _commitAndReveal(pid, creator, true);
    _commitAndReveal(pid, alice, false);
    _revealPhase(pid);
    vm.prank(bob);
    vm.expectRevert(Governance.NoCommit.selector);
    gov.revealVote(pid, true, SALT);
    vm.prank(creator);
    vm.expectRevert(Governance.BadReveal.selector);
    gov.revealVote(pid, false, SALT); // committed true
    _reveal(pid, creator, true);
    vm.prank(creator);
    vm.expectRevert(Governance.AlreadyRevealed.selector);
    gov.revealVote(pid, true, SALT);
    _reveal(pid, alice, false);
    vm.warp(block.timestamp + 6 hours);
    gov.finalize(pid); // 1000 FOR == 1000 AGAINST, quorum 2000/5000 >= 25%
    assertEq(uint8(_status(pid)), uint8(Governance.Status.Defeated), "tie defeats");
}
```

##### G3 (add to SubVaultsTest): RuleChange cannot lower a child below the parent floor

```solidity
function test_gap_ruleChangeCannotUndercutParentQuorumFloor() public {
    vm.startPrank(operator);
    gov.registerVault(address(parent), _gcfg(4_000));
    gov.registerVault(address(child), _gcfg(4_000));
    vm.stopPrank();

    vm.startPrank(alice);
    usdc.approve(address(child), type(uint256).max);
    child.deposit(1_000 * USDC_1);
    child.skipWindow();
    vm.stopPrank();
    skip(1);

    bytes memory payload = abi.encode(_gcfg(3_000)); // below parent's 4000
    vm.prank(alice);
    uint256 pid = gov.propose(address(child), Governance.ProposalType.RuleChange, keccak256(payload));
    bytes32 s = keccak256("s");
    vm.prank(alice);
    gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, s)));
    (,,,, uint64 cd, uint64 rd,,,,,,,,,,) = gov.proposals(pid);
    vm.warp(cd);
    vm.prank(alice);
    gov.revealVote(pid, true, s);
    vm.warp(rd);
    gov.finalize(pid);
    vm.warp(block.timestamp + 1 days);

    vm.expectRevert(Governance.BadGovConfig.selector);
    gov.execute(pid, payload);
    (,,,, uint16 q,,,) = gov.configOf(address(child));
    assertEq(q, 4_000, "child quorum unchanged");
}
```
VaultFactory does not call registerVault (grep), so registering by hand is required.


## Appendix C: VaultFactory

### Test-gap analysis: VaultFactory, VaultDeployer, ProtocolInitializer (read-only, no forge run)

Method: read the three contracts in full, grep -rnE test/ (excl. test/retired) per error, event, function.
Already covered (not gaps): initialize OnlyInitializer (Create2Protocol:129,139,340, fuzzed :135),
AlreadyInitialized (:166), NotInitialized on both create paths (:213-225), codeless/zero allowlist entry
(Create2Protocol:248, AuditOracleAllowlist:117), C-6 root path, OracleMissingAsset root path
(AuditOracleCoversBasket), SubVaultsDisabled (AuditRootVaultsOnly:176), NotParentCreator
(SubVaults:352), BasketNotSubsetOfParent (SubVaults:140), BadConfig bubbling (Eip170:214), direct
deployer bypass unattested (Eip170:183), chunks reassemble (Eip170:155-170).

#### 1. VaultFactory.sol

Uncovered / likely uncovered (grep evidence):
- G1 `UsdcMismatch` (src 254): `grep -rn UsdcMismatch test` = 0 hits. Revert never asserted.
- G2 createChildVault C-6 gate (src 246) never run with enforcement ON: no `createChildVault` call in
  AuditOracleAllowlist.t.sol or AuditOracleCoversBasket.t.sol (only a comment at AllowlistT:12). The
  allowlist suites use `false` for allowSubVaults, and SubVaults.t.sol initializes with an empty list.
- G3 createChildVault `_requireOracleCoversBasket` (src 262): 0 child-path OracleMissingAsset tests.
- G4 Events: `grep -rn "VaultCreated\|Initialized(" test` = 0 hits (only unrelated navPsInitialized).
  No expectEmit on VaultCreated (src 229, 266) or Initialized (src 148). Indexers and the frontend key off these.
- G5 `allVaults` public array (src 100): 0 hits. Only `vaultCount()` length is asserted (Create2Protocol,
  FeesAndRegistry); element identity and order are never checked, nor that a reverted create leaves length unchanged
  in the OracleMissingAsset / NotAllowed cases (Create2Protocol:225 checks 0 only for NotInitialized).
- G6 Attestation identity: Eip170:195 only asserts `operatorOf(vault) > 0`. No test that the operator id equals
  `operatorIdOf[msg.sender]` (src 227/264 pass `msg.sender`), nor that `statsOf.vaultCount` increments.
- G7 Child path: attestVault after registerChild (src 263-264) and child `allVaults.push`: no assertion.
- G8 Missing-contract parent: `createChildVault(p, EOA)` (src 253) reverts with empty data; untested.
- G9 initialize loop (src 140-147): no test with a valid entry followed by a codeless one (all-or-nothing, state
  rolled back), nor duplicate entries, nor large list. Event payload untested (G4).
- G10 `p.oracle` codeless/zero with enforcement OFF: factory forwards to try/catch (src 195) so reverts as
  OracleMissingAsset; no test that address(0) oracle fails closed when allowlist empty.
- G11 Empty basketAssets: `_requireOracleCoversBasket` loop skips; only VaultCore ctor limits matter. No test
  of a zero-asset basket through the factory (grep "new address\[\](0)" is used for adapters, not baskets).

#### 2. Invariants not fuzzed
- No invariant or fuzz on VaultFactory itself (`grep -n "invariant_\|testFuzz" test/Create2*.t.sol test/Eip170.t.sol`
  only hits the initialize caller fuzz). Missing:
  a) `vaultCount == allVaults.length == registry.operator vault counts summed` and every `allVaults[i]` has
     `operatorOf > 0` (CM-5, the factory's whole purpose).
  b) `forall v in allVaults: v.creator() is attested operator` (handler: random creators/params).
  c) When `oracleAllowlistEnforced`, `forall v: isAllowedOracle[v.oracle()]`.
  d) `allowSubVaults == false => forall v: v.subVaultRegistry() == 0` (AuditRootVaultsOnly is example-based).
  e) `initialized` monotonic, `isAllowedOracle` never changes after initialize (handler tries initialize again).
- Fuzz of VaultParams (decimals, caps, exitFee bounds) through the factory: none.

#### 3. Access-controlled paths lacking a negative test
- `initialize`: covered. `createChildVault` parent-creator: covered, but only with allowlist empty (G2).
- `VaultFactory` has no owner; nothing else gated. Negative missing: attacker-supplied `parent` contract that lies about
  `creator()`/`usdc()`/`assetUnit()` (src 253-256 trust whatever the parent returns). Impact is bounded because
  `registerChild` then reads parent exitFeeMaxBps, but a fake parent returning msg.sender as creator can register a
  child under an address that is not a vault. grep "fakeParent\|FakeParent" test = 0 hits.
- Registry/SubVaultRegistry `OnlyFactory` is tested for attest (Eip170:198) but `registerChild` OnlyFactory from the
  deployer/strangers: check SubVaultRegistry tests, not in this scope.

#### 4. Reentrancy edge cases missing
- Untrusted external calls happen INSIDE `_deploy` (src 274): VaultCore ctor calls `usdc.decimals()` and each
  `asset.decimals()` (VaultCore src 284, 316) on creator-supplied tokens. A hostile token can reenter
  `factory.createVault` / `createChildVault` mid-construction, before attest (src 227) and `allVaults.push` (228).
  Effect: nested vault is pushed before its outer vault (order inversion), and the outer vault's creator/operator
  differ (token calls with its own msg.sender). No state is corrupted by design (no balances held), but nothing tests it.
  grep "reenter" in test touching the factory = 0 (AdapterReentrancy, AuditFeeEngineReentrancy are VaultCore/FeeEngine).
- `oracle.priceWad` is wrapped in try/catch (src 195) and the interface function is `view` so it is STATICCALL: no
  reentry possible, but an oracle burning all gas (returns after 63/64) is untested (does the catch survive OOG? revert
  becomes OracleMissingAsset or bubbles OOG).
- `parent.creator()/usdc()/assetUnit()` (src 253-256) are view calls to an arbitrary address: staticcall, safe.

#### 5. Fee / rounding edge cases missing
- Factory does no arithmetic. Pass-through bounds only: `exitFeeMaxBps` passed to `registerChild` (src 263) for the
  stacked cap. Missing: stack exactly at STACKED_EXIT_FEE_CAP_BPS boundary and +1 via the factory (SubVaults:163 covers one
  over; no at-cap success). `exitFeeMaxBps` > cap: BadConfig bubbling only tested with one param set (Eip170:214).
- usdc decimals boundaries (<6, 18, 19) through the factory: VaultCore tests cover, no factory-path test.

#### 6. Funds-at-risk rank
| Gap | Rank | Reason |
|---|---|---|
| G2 child path C-6 gate with enforcement ON | HIGH | Un-blessed oracle on a child = oracle-priced share theft; only mitigated while allowSubVaults=false (launch). A refactor deleting src 246 passes the whole suite. |
| G6/G5/G7 attestation identity and allVaults integrity | HIGH | Attestation is the carry/leaderboard trust root; wrong operator arg or missing push passes `operatorOf>0`. |
| G3 child path coverage gate | MED | Permanent brick of a child vault on first rebalance; child only. |
| Reentrancy via hostile decimals() (sec 4) | MED | No fund loss found by reading, but order and attestation invariants untested. |
| Fake parent (sec 3) | MED | Child edge under non-vault; no member funds, pollutes registry. |
| G1 UsdcMismatch | MED | Wrong-USDC child would break look-through accounting; reverts today, no regression guard. |
| G4 events | LOW | Indexer/offchain only. |
| G9, G10, G11 | LOW | Fail closed already; regression guards only. |
| Fuzz/invariants (sec 2) | MED | Closes class of G5/G6. |

#### 2. VaultDeployer.sol

Uncovered:
- D1 `DeployFailed` (src 341, 373-375): `grep -rn DeployFailed test` = 0. Trigger: `deploy("")` makes VaultCore ctor
  abi-decode fail with empty returndata, so the 4-byte selector path should fire; never exercised.
- D2 `ChunkWriteFailed` (src 340, 404): 0 hits. Practically unreachable in the ctor (only OOG/oversize); needs
  an initcode-size or gas-limited deploy test, or document as unreachable.
- D3 Revert-data forwarding of non-empty data tested only for BadConfig (Eip170:214). Panic/custom errors from
  deeper in ctor not tested.
- D4 Odd-length creation code: `half = len/2`, chunk B gets the extra byte (src 345-347). Eip170:155 checks equality
  of the real code only (a fixed length). Property "any split reassembles" cannot be varied without a mock.
- D5 Cross-version: chunk contracts are ownerless data with leading STOP; test `test_codeChunksAreInertData`
  (Eip170:162) exists. Calling a chunk with value or selfdestruct: not tested (EIP-6780 makes moot).
- D6 `deploy` with value: function is non-payable, no test (LOW).
- D7 Gas: createVault gas ceiling (block-limit fitting on L2s) - grep "gasleft\|gasUsed" in Eip170 = none.

Invariants not fuzzed: `deploy(args)` output runtime == fixed VaultCore runtime modulo immutables, for fuzzed
ctor args; no fuzz in Eip170.t.sol. Access control: none by design (Eip170:183 asserts this). Reentrancy: none
(no state, CREATE from fresh args); but ctor reentrancy into deployer is harmless. Fees: n/a.
Rank: D1 LOW (fail-closed; bad error surface), D2 LOW, D3 LOW, D4 LOW. No funds-at-risk.

#### 3. lib/ProtocolInitializer.sol (constant PROTOCOL_INITIALIZER)
- Pure constant, no branches. Uses: 106 test lines reference it for pranks.
- P1 No test that the constant matches `script/` and `docs/` deployment address (a typo bricks all chains; the
  comment at src 427-431 says "lost key = chain uninitialisable"). grep over test/ for a literal
  `0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35` outside src: check Create2Determinism/Deploy scripts; no assertion
  that PROTOCOL_INITIALIZER != address(0) and != the CREATE2 proxy (Create2Protocol:121 tests the proxy is refused,
  which implies it). Rank LOW (guard exists in scripts), CRITICAL only if constant is wrong at mainnet (all 5 chains
  uninitialisable); that is a deploy-time check, not a unit gap.
- Invariants/reentrancy/fees: n/a.

#### Concrete tests for the two highest gaps (compile against repo helpers; conventions copied from AuditOracleAllowlist / AuditOracleCoversBasket)

File: test/audit/AuditFactoryChildGates.t.sol  (NOT created; proposed text)

```solidity
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
import {MockERC20, MockOracle} from "../mocks/Mocks.sol";
import {PROTOCOL_INITIALIZER} from "../../src/lib/ProtocolInitializer.sol";

contract AuditFactoryChildGatesTest is Test {
    uint256 constant USDC_1 = 1e6;
    event VaultCreated(address indexed vault, address indexed creator, address usdc, uint256 capacityCapUsdc);

    MockERC20 usdc;
    MockERC20 usdc2;
    MockERC20 weth;
    MockOracle blessed;
    MockOracle rogue;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    VaultFactory factory;
    address creator = makeAddr("creator");
    address other = makeAddr("other");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USDC", 6);
        usdc2 = new MockERC20("USDC2", 6);
        weth = new MockERC20("wETH", 18);
        blessed = new MockOracle();
        rogue = new MockOracle();
        blessed.setPrice(address(weth), 2500e18);
        rogue.setPrice(address(weth), 2500e18);

        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        FeeEngine fees = new FeeEngine(IRegistryView(address(registry)));
        Governance gov = new Governance();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(subReg),
            IVaultDeployer(address(new VaultDeployer())),
            true // sub-vaults ENABLED: the only configuration where the child gates are reachable
        );
        address[] memory allow = new address[](1);
        allow[0] = address(blessed);
        vm.prank(PROTOCOL_INITIALIZER);
        factory.initialize(allow);
        vm.prank(PROTOCOL_INITIALIZER);
        registry.wire(address(factory), address(fees));
        vm.prank(PROTOCOL_INITIALIZER);
        subReg.wire(address(factory));
        vm.prank(PROTOCOL_INITIALIZER);
        gov.wireSubVaultRegistry(address(subReg));
    }

    function _p(address usdc_, address oracle) internal view returns (VaultFactory.VaultParams memory) {
        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        return VaultFactory.VaultParams({
            usdc: usdc_,
            basketAssets: basket,
            oracle: IOracleAggregator(oracle),
            capacityCapUsdc: 0,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: 50,
            exitFeeDecayPeriod: 30 days,
            allowedAdapters: new address[](0)
        });
    }

    // G2: the C-6 allowlist must bind the CHILD path too.
    function test_childPathEnforcesOracleAllowlist() public {
        vm.prank(creator);
        address parent = factory.createVault(_p(address(usdc), address(blessed)));
        vm.prank(creator);
        vm.expectRevert(VaultFactory.OracleNotAllowed.selector);
        factory.createChildVault(_p(address(usdc), address(rogue)), parent);
        assertEq(factory.vaultCount(), 1, "rogue child left nothing behind");
        assertEq(subReg.depthOf(parent), 0);
    }

    // G1: UsdcMismatch, ordered after the creator check.
    function test_childPathRejectsDifferentUsdc() public {
        vm.prank(creator);
        address parent = factory.createVault(_p(address(usdc), address(blessed)));
        vm.prank(creator);
        vm.expectRevert(VaultFactory.UsdcMismatch.selector);
        factory.createChildVault(_p(address(usdc2), address(blessed)), parent);
        vm.prank(other); // creator check precedes the usdc check
        vm.expectRevert(VaultFactory.NotParentCreator.selector);
        factory.createChildVault(_p(address(usdc2), address(blessed)), parent);
    }

    // G3: the child's own oracle must price the child's basket (parent's pricing is irrelevant).
    function test_childPathEnforcesOracleCoversBasket() public {
        vm.prank(creator);
        address parent = factory.createVault(_p(address(usdc), address(blessed)));
        blessed.setPrice(address(weth), 0); // oracle stops pricing weth after parent exists
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.OracleMissingAsset.selector, address(weth)));
        factory.createChildVault(_p(address(usdc), address(blessed)), parent);
        assertEq(factory.vaultCount(), 1);
    }

    // G4-G7: events, allVaults order, attestation identity, child attestation and edge.
    function test_attestsMsgSenderAndRecordsInOrder() public {
        vm.expectEmit(false, true, false, true, address(factory));
        emit VaultCreated(address(0), creator, address(usdc), 0);
        vm.prank(creator);
        address parent = factory.createVault(_p(address(usdc), address(blessed)));

        uint256 opId = registry.operatorIdOf(creator);
        assertGt(opId, 0, "creator registered as operator");
        assertEq(registry.operatorOf(parent), opId, "vault attested to msg.sender, not someone else");
        assertEq(registry.operatorIdOf(address(factory)), 0, "factory is not an operator");

        vm.prank(creator);
        address child = factory.createChildVault(_p(address(usdc), address(blessed)), parent);
        assertEq(registry.operatorOf(child), opId, "child attested to creator");
        assertEq(subReg.parentOf(child), parent, "edge registered");

        assertEq(factory.vaultCount(), 2);
        assertEq(factory.allVaults(0), parent, "order: parent first");
        assertEq(factory.allVaults(1), child, "order: child second");
    }
}
```

Second proposed test (VaultDeployer D1, drop into Eip170.t.sol, same helpers `vaultDeployer`):

```solidity
    function test_deployWithEmptyArgsRevertsDeployFailed() public {
        vm.expectRevert(VaultDeployer.DeployFailed.selector);
        vaultDeployer.deploy("");
    }
```
Caveat: assumes VaultCore ctor decode of empty args reverts with empty returndata; if forge shows a
different selector, adjust the expectation (read-only analysis, not executed).

Assumptions not verified (no forge run): `OperatorRegistry.statsOf` layout, that `MockOracle` with price 0
reverts (it does: `require(p != 0, "no price")`, Mocks.sol:77-83), and `factory.allVaults(i)` public getter
(public array, src 100).


## Appendix D: ChainlinkOracle

### Test gaps: src/oracle/ChainlinkOracle.sol (367 lines), read-only, forge not run

Grepped: test/audit/{ChainlinkOracle,ChainlinkOracleFuzz,ChainlinkOracleSequencerFork,ChainlinkOracleVaultIntegration,
AuditOracleParamBounds,AuditFeedDenomination,AuditAggregatorSwapDrift,AuditOracleCoversBasket}.t.sol, DeployChainlinkOracle.t.sol,
DeployTestnet.t.sol. OracleFuzz.t.sol and MixedOracleSources.t.sol have zero ChainlinkOracle hits (retired OracleAggregator only).
Mock: MockAggregatorV3 (test/mocks/OracleSourceMocks.sol) returns (1, answer, updatedAt, updatedAt, 1): startedAt == updatedAt always.
Well covered (not gaps): wad scaling, unlisted/stale/zero/neg/unset/future reads, heartbeat boundary, band edges, sequencer
down/grace/boundary/startedAt 0/revert, USDC pin, heartbeat floor/ceiling, band ratio, description suffix, decimals != 8, codeless feed,
zero asset, duplicate asset, usdc also listed, sequencer decode-proof.

#### 1) Uncovered functions / branches
- L176-180 n==0 and array-length mismatch: grep `Mismatch|Empty|Length` in oracle suites = 0 test names; helpers always build equal arrays.
- L184 `feed == address(0)`: only zero ASSET and codeless 0xDEAD are tested (redundant with L189, but unkilled).
- L198 uint128 guard: grep `1 << 128|uint128).max` = only ParamBounds:233 (dies at L199 ratio, not L198) and a fuzz answer bound.
- L252 `answer > 0` at construction with a band: no test builds with answer <= 0 and a non-zero band (non-positive tests set it after).
- L327 false arm (timestamp <= heartbeat): every suite warps to 1_000_000 or 2_000_000 and MAX_HEARTBEAT is 90_000, so unreachable.
- L360 `startedAt > now`: only `testFork_mockedStartedAtInFuture_failsClosed` (needs RPC). No unit test.
- L358 `answer != 0`: only answer == 1 tried. No 2, -1 or int256.max.
- ABI-decode failure / Panic path (L225-227 comment): grep `Panic|0x4e487b71|stdError` = 0.
- roundId / answeredInRound ignored by design; no test pins it (grep `answeredInRound` = fork decode test only).
#### 2) Invariants not fuzzed
grep `invariant_` in oracle suites = 0. ChainlinkOracleFuzz has 5 single-axis fuzzes with heartbeat fixed at 3600. Missing:
- Joint (answer, updatedAt, heartbeat, now): never 0, never older than heartbeat.
- Heartbeat in [600, 90_000] at the `updatedAt == now - hb` boundary.
- Sequencer (startedAt, answer, now) vs `answer == 0 && startedAt != 0 && now - startedAt > 3600`.
- Constructor accept/reject predicate over (lo, hi, answer, heartbeat); description suffix predicate over random tails.
- Answers above uint256.max/1e10 (fuzz bounds to uint128.max).
#### 3) Access-controlled paths lacking a negative test
None exist: no owner, no setter, constructor-only config, view-only priceWad. Residual LOW gap: no selector probe asserting that
setter-like selectors (setFeed, transferOwnership) revert; `test_c6_noQuorumSurfaceToGameOrMisconfigure` is structural only.
#### 4) Reentrancy edge cases
priceWad is view, so state reentry is impossible, but nothing pins it. grep `Reenter|reentr` in oracle suites = 0 (hits are vault-side
files). Missing: feed that attempts SSTORE or value call inside latestRoundData (STATICCALL reverts, must map to StaleOracle);
feed that burns all gas (63/64 rule); returndata bomb; constructor callback feed. Needs a hostile feed past the factory allowlist.
#### 5) Price / decimals / staleness / rounding edge cases missing
- A1 Sequencer reads startedAt but the mock ties it to updatedAt, so swapping the two fields (L356-362) survives every unit test;
  only the fork test kills it.
- A2 L198 truncation guard and L252 are unkilled (see 1). Without L198 a floor of 2^128 stores as uint128(lo) = 0 at L261.
- B1 answer > uint256.max/1e10 with band disabled: L330 overflows to raw Panic(0x11), not StaleOracle, against the L31-36 contract.
- B4 Multi-asset independence: only the duplicate test uses n=2; no test that asset A stale leaves asset B priced, or that bands differ.
- B5 Same feed listed for two assets (allowed by L190) untested.

#### 6) Funds-at-risk rank (oracle fails closed; risk = wrong-NAV mint/exit or frozen exit)
| Rank | Gap | Risk | Reason |
|---|---|---|---|
| 1 | A1 sequencer startedAt vs updatedAt | HIGH | Grace gate is the only guard vs pre-outage prices on Base; a field swap lets stale prices flow in grace or freezes exits. Only RPC fork test catches it. |
| 2 | L198 uint128 truncation, L252, length arms | HIGH (deploy-time) | Truncated floor silently weakens the immutable sane-price band (C-6 clamp defence); bad deploy is permanent. |
| 3 | B1 overflow Panic not StaleOracle | MED | Still reverts, but breaks the single-selector contract; hostile-feed only. |
| 4 | Sequencer answer other than 1 | MED | A mutant `answer == 1` passes the current suite and treats status 2 or -1 as up. |
| 5 | Gas-burning / state-writing feed | MED-LOW | Could brick NAV for one vault; needs allowlist bypass. |
| 6 | Multi-asset independence, same feed twice | LOW | Per-asset struct storage. |
| 7 | L327 saturating arm, L360 unit test | LOW | Defensive; second covered by fork. |


##### Test for rank 1 (new file test/audit/ChainlinkOracleSeqFields.t.sol)
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

/// Uptime feed with independent startedAt / updatedAt, like a real round.
contract DivergentSeqFeed is IAggregatorV3 {
    int256 a; uint256 s; uint256 u;
    function set(int256 a_, uint256 s_, uint256 u_) external { (a, s, u) = (a_, s_, u_); }
    function decimals() external pure returns (uint8) { return 0; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (7, a, s, u, 7);
    }
}

contract ChainlinkOracleSeqFieldsTest is Test {
    address constant WETH = address(0xE7);
    uint256 constant GRACE = 3600;

    function setUp() public { vm.warp(1_000_000); }

    function _oracle(address seq) internal returns (ChainlinkOracle) {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        address[] memory a = new address[](1); a[0] = WETH;
        address[] memory f = new address[](1); f[0] = address(feed);
        uint32[] memory hb = new uint32[](1); hb[0] = 3600;
        uint256[] memory z = new uint256[](1);
        return new ChainlinkOracle(a, f, hb, z, z, address(0), seq);
    }

    function _stale(ChainlinkOracle o) internal {
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, WETH));
        o.priceWad(WETH);
    }

    /// Grace runs from startedAt: a recent updatedAt must not hold the oracle shut.
    function test_graceUsesStartedAt_pricesFlow() public {
        DivergentSeqFeed seq = new DivergentSeqFeed();
        seq.set(0, block.timestamp - GRACE - 1, block.timestamp);
        assertEq(_oracle(address(seq)).priceWad(WETH), 2500e18);
    }

    /// An ancient updatedAt must not wave a just-restarted sequencer through.
    function test_graceUsesStartedAt_failsClosed() public {
        DivergentSeqFeed seq = new DivergentSeqFeed();
        seq.set(0, block.timestamp - 100, block.timestamp - 10 * GRACE);
        _stale(_oracle(address(seq)));
    }

    /// Any non-zero status is down, not only 1.
    function testFuzz_anyNonZeroAnswerFailsClosed(int256 a) public {
        vm.assume(a != 0);
        DivergentSeqFeed seq = new DivergentSeqFeed();
        seq.set(a, block.timestamp - GRACE - 1, block.timestamp - GRACE - 1);
        _stale(_oracle(address(seq)));
    }

    /// startedAt in the future fails closed at unit level (today only a fork test covers it).
    function test_futureStartedAtFailsClosed() public {
        DivergentSeqFeed seq = new DivergentSeqFeed();
        seq.set(0, block.timestamp + 1, block.timestamp);
        _stale(_oracle(address(seq)));
    }
}
```

##### Test for rank 2 (new file test/audit/ChainlinkOracleCtorGaps.t.sol)
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

contract ChainlinkOracleCtorGapsTest is Test {
    address constant WETH = address(0xE7);

    function setUp() public { vm.warp(1_000_000); }

    function _build(address feed, uint256 lo, uint256 hi) internal returns (ChainlinkOracle) {
        address[] memory a = new address[](1); a[0] = WETH;
        address[] memory f = new address[](1); f[0] = feed;
        uint32[] memory hb = new uint32[](1); hb[0] = 3600;
        uint256[] memory mn = new uint256[](1); mn[0] = lo;
        uint256[] memory mx = new uint256[](1); mx[0] = hi;
        return new ChainlinkOracle(a, f, hb, mn, mx, address(0), address(0));
    }

    /// L198: lo = 2^128 passes the ratio and live-price checks, so only the uint128 guard
    /// stops the stored floor truncating to a tiny value.
    function test_bandAboveUint128IsRejected() public {
        uint256 lo = uint256(1) << 128;
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(lo / 1e10 + 1), block.timestamp);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        _build(address(feed), lo, lo * 2);
    }

    /// L252: enabled band + non-positive live answer is rejected at construction.
    function test_enabledBandWithNonPositiveAnswerIsRejected() public {
        int256[3] memory bad = [int256(0), -1, type(int256).min];
        for (uint256 i; i < bad.length; ++i) {
            MockAggregatorV3 feed = new MockAggregatorV3(8, bad[i], block.timestamp);
            vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
            _build(address(feed), 1000e18, 5000e18);
        }
    }

    /// L176-180: empty config and each mismatched array length are rejected.
    function test_emptyAndMismatchedArraysRejected() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        address[] memory a = new address[](1); a[0] = WETH;
        address[] memory f = new address[](1); f[0] = address(feed);
        uint32[] memory hb = new uint32[](1); hb[0] = 3600;
        uint256[] memory z = new uint256[](1);
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        new ChainlinkOracle(new address[](0), new address[](0), new uint32[](0), new uint256[](0), new uint256[](0), address(0), address(0));
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        new ChainlinkOracle(a, new address[](2), hb, z, z, address(0), address(0));
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        new ChainlinkOracle(a, f, new uint32[](2), z, z, address(0), address(0));
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        new ChainlinkOracle(a, f, hb, new uint256[](2), z, address(0), address(0));
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
        new ChainlinkOracle(a, f, hb, z, new uint256[](2), address(0), address(0));
    }

    /// B1 pin: a huge answer with the band disabled overflows the scale multiply and reverts
    /// (today Panic 0x11, not StaleOracle). Flip the selector if the contract is hardened.
    function test_overflowingAnswerReverts() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, 2500e8, block.timestamp);
        ChainlinkOracle o = _build(address(feed), 0, 0);
        feed.set(type(int256).max, block.timestamp);
        vm.expectRevert();
        o.priceWad(WETH);
    }
}
```
Not compiled (forge not run, per instructions).


## Appendix E: Adapters

### Adapter test-gap analysis (read-only; nothing run, forge not invoked)

Scope: contracts/src/{UniswapV3Adapter,AggregationRouterAdapter,DirectPoolAdapter}.sol, src/lib/{BoundedCall,SafeTransferLib}.sol.
Existing evidence read: test/{AdapterReentrancy,UniswapV3Adapter,UniswapV3AdapterInvariant,DirectPoolAdapter,Execution}.t.sol,
test/audit/{AuditAdapterScopedSweep,AuditSafeTransferBounded,AuditReentrancyGuardCoverage}.t.sol, test/ModuleHardening.t.sol, test/mocks/Mocks.sol.
Convention: `Test`, `MockERC20(name,decimals)` with `mint`, `MockOracle.setPrice(token, wad)`, local hostile routers per file, `vm.expectRevert(Contract.Err.selector)`, `bytes4(err)` capture via try/catch.
Only invariant suite touching adapters: UniswapV3AdapterInvariant (grep `function invariant_` over test/ = 5 files; none for Aggregation/DirectPool).

#### 1. UniswapV3Adapter.sol
1) Uncovered functions/branches
- Refund block L202-208 (inAfter/inBefore, clamp L204, `safeApprove(router,0)` L206, refund transfer L208): `grep -n refund test/UniswapV3Adapter.t.sol` = no hits; invariant FuzzRouter has `spendFrac` but the handler only ever calls `setFractions(1e18, ..)` (Invariant.t.sol:~83), so partial fill never runs. Refund path executes with refund==0 only.
- `nonReentrant` L113-118 / `Reentrancy` error: `grep -rn "UniswapV3Adapter" test/AdapterReentrancy.t.sol test/audit/AuditReentrancyGuardCoverage.t.sol` = no hits. AdapterReentrancy covers only Aggregation + DirectPool.
- `BadOrder` branches L156-157: only routeData non-empty tested (UniswapV3Adapter.t.sol:369). No test for tokenIn==tokenOut, amountIn==0, minAmountOut==0.
- Constructor `BadConfig` L132, L143-147: only divergence 0 and 1001 tested (L385,391). Untested: zero router/oracle/usdc, tokenA==tokenB, zero token, fee==0, duplicate entry (last wins).
- `TransferFromFailed` (no allowance / insufficient balance on L170): grep `TransferFromFailed` hits only AuditSafeTransferBounded (library level), no adapter-level test.
- `SwapExecuted` event: `grep -rn SwapExecuted test/` = 0 hits for all three adapters (no expectEmit).
2) Invariants not fuzzed
- Caller conservation: callerIn_before + ... == callerIn_after + refund + spent, never negative; refund <= amountIn.
- Router allowance to adapter == 0 after every call (incl. partial fill). Only "adapter holds 0" is fuzzed.
- `amountOut == tokenOut.balanceOf(caller) delta` and `>= minAmountOut` fuzzed only for spend=100%.
3) Access control: no privileged roles by design (constructor-only config, no setter). Missing negative test: nothing asserts `feeTierOf` cannot be changed / no setter selector (low value). Direct-caller path (no VaultCore) has no test with a caller lacking allowance.
4) Reentrancy: nested executeSwap from router (gap, see 1); lock release after revert (gap; Aggregation has it AdapterReentrancy:213,227); ERC777-style tokenOut hook on L207 `safeTransfer(msg.sender)` while `_lock==2` (gap); tokenIn FOT: adapter holds < amountIn so router pull reverts -> RouterCallFailed (gap, `grep -n "FeeOnTransfer" test/UniswapV3Adapter*` none); tokenOut FOT: caller receives < amountOut, delta check passes on adapter side (gap). Router returndata: catch has no binding so revert data is not copied (good) but success path decode with short/huge returndata untested.
5) Slippage/rounding: `outBefore` underflow when tokenOut is rebasing-down during route (L196 checked-sub Panic, fail-closed) untested. Boundary `outValue == minRequired` exact equality: only fuzz at L264 (check it hits exact bps). minOut=1 with 18->6 decimals floor to value 0 on out side tested only for revert. USDC par vs `usdc` token with decimals != 6 untested.

#### 2. AggregationRouterAdapter.sol
1) Uncovered
- `RouterCallFailed` L124: `grep -rn RouterCallFailed test/` hits only UniswapV3Adapter.t.sol. Aggregation router revert path untested.
- `BadOrder` L104 (tokenIn==tokenOut, amountIn==0): `test_adapterRequiresMinOut` (Execution.t.sol:293) covers only minOut==0.
- `SelectorNotAllowed` with routeData.length < 4 (L106 short-circuit): only 0xdeadbeef tested (`test_adapterRejectsUnknownSelector`, Execution.t.sol:266).
- Constructor L93 (router==0, empty selectors, duplicates): `grep -rn "new AggregationRouterAdapter" test/` = 5 sites, all valid configs; no revert test.
- `TransferFromFailed` on missing allowance: not at adapter level.
2) Not fuzzed: no `testFuzz_` and no invariant for this adapter (`grep testFuzz` over AdapterReentrancy, Execution, AuditAdapterScopedSweep = 0). Refund/clamp are example-tested only (AuditAdapterScopedSweep:375-564, good depth, but fixed constants). Missing: for all (amountIn, pull, pushBack, preDonation): refund == clamp(delta); caller never loses > spent; adapter balance == donations only.
3) Access control: selector allowlist negative tested once; router pinning (EX-2) has no test that routeData cannot name another target (target is not in calldata, so structural). No test that selector collision with ERC20 `transfer`/`approve` selectors in allowlist is refused: constructor does not forbid it. A deployer allowlisting `approve(address,uint256)` (0x095ea7b3) would let routeData make the adapter call router.approve; router is pinned so limited. Untested config hazard.
4) Reentrancy: covered well (AdapterReentrancy:193-239). Missing: token callback on L166-167 transfers; router returndata bomb: `(bool ok,) = router.call(...)` L123 still copies returndata to memory (solc does not elide), so a router/forwarded-hop bomb OOGs the adapter. `grep -rni bomb test/` hits only SafeTransfer/Decode-brick files, none for this adapter. Router is pinned/trusted so MED-LOW.
5) Slippage/rounding: amountOut underflow when tokenOut shrinks in route (L125) untested. FOT tokenOut: caller receives less than `amountOut` reported (untested, VaultCore delta saves). Pre-existing `outBefore` donation excluded (AuditAdapterScopedSweep:564 covers).

#### 3. DirectPoolAdapter.sol
1) Uncovered
- Reverse direction (`order.tokenIn == token1`, L265, `pair.swap(quoted,0,..)` L279): `grep` of DirectPoolAdapter.t.sol shows only usdc->weth orders (L173-240); which branch runs depends on address ordering of two mocks. weth->usdc leg never asserted.
- `Expired` L259, `BadOrder` L260-261 (amountIn==0, minOut==0, tokenIn==tokenOut): `grep -n "Expired\|BadOrder" test/DirectPoolAdapter.t.sol` = 0.
- `_amountOut` L292-301 has no direct/fuzz test; only 1 example swap vs NAV (assertApproxEqRel 0.5%).
2) Not fuzzed: no `testFuzz`/invariant at all (grep = 0). Missing: out < reserveOut, k non-decreasing after swap, adapter ends with 0 of both tokens, caller delta == amountOut.
3) Access control: none (stateless, pinned immutable pair). No test that a non-pair address cannot be targeted (TokenNotInPair tested once, tokenIn side only; tokenIn valid + tokenOut foreign untested).
4) Reentrancy: only pair re-entry (AdapterReentrancy:239). Missing: tokenIn FOT -> L277 `safeTransfer(pair, amountIn)` reverts (adapter holds less); tokenOut FOT on L286; V2 pair with callback `data` is passed "" (fine). No refund path exists: if pair consumes less than amountIn (impossible for honest V2) the remainder strands; untested hostile pair that ignores input.
5) Slippage/rounding: quoted==0 for tiny amountIn (real V2 reverts INSUFFICIENT_OUTPUT_AMOUNT; mock does not enforce) untested; stale-reserve quote (donation to pair before swap) untested; `amountIn*9970*reserveOut` overflow for huge inputs (Panic) untested.

#### 4. lib/BoundedCall.sol
1) Uncovered: library has no direct test. `grep -rn "boundedCall\|boundedStaticCall\|BoundedCall" test/` = 0 hits. Indirect only via VaultCore with `RevertingGovernance/FeeEngine/Registry` (plain revert, ModuleHardening:73-117). Never exercised: gas exhaustion by callee (infinite loop vs MODULE_CALL_GAS=300_000), returndata bomb on a SUCCESSFUL call, 1-31 byte returndata (L-3 zeroing, lines 253/272), retSize==0 success, target without code.
2) Fuzz: none. Property: `word` equals first 32 bytes zero-padded for any returndata length 0..N, independent of dirty free memory.
3) Access: internal library, n/a.
4) Reentrancy: boundedCall forwards `gasLimit`, value 0; callee may reenter VaultCore (covered by AuditFeeEngineReentrancy for fee engine only; grep).
5) Edge: gasLimit > gasleft*63/64 (call silently gets less, `ok=false`) untested; gasLimit==0.

#### 5. lib/SafeTransferLib.sol
Covered well by AuditSafeTransferBounded (bomb, bomb-true, short return, no-return, false, good). Gaps:
- `safeTransferFrom` and `safeApprove` with bomb/short/false: test_remediated_bothOtherShapesAreBoundedToo (L126) touches them; no `TransferFromFailed`/`ApproveFailed` assertion for the 1-31 byte shape on them individually (grep `TransferFromFailed` = 1 file, check lines 126-139 only for some shapes).
- Codeless address returns success (L162 documents, not fixed). Adapters rely on balanceOf(tokenIn/out) reverting for codeless tokens; V3 adapter `decimals()` call reverts; Aggregation `balanceOf` reverts: OK but no adapter-level test with a codeless token proving fail-closed.
- `tryTransfer` gasLimit enforcement for gas-guzzling token: grep AuditSafeTransferBounded shows bomb only; infinite-loop token not present.
- Token returning `2` (nonzero, not 1) or a word with high bits set: `eq(word,1)` rejects; untested (USDT-like non-canonical bools).

#### 6. Funds-at-risk ranking
| # | Gap | Rank | Reason |
|---|-----|------|--------|
| 1 | UniswapV3Adapter refund/clamp/approval-revoke never run with partial fill or push-back (no test, invariant spend fixed 100%) | HIGH | Production adapter (pinned SwapRouter02); logic duplicated from Aggregation with a regression history (donation Panic(0x11), whole-balance sweep). A regression strands or over-refunds vault input and can brick executeRebalance. |
| 2 | UniswapV3Adapter nonReentrant untested | HIGH | Removing guard passes whole suite; nested call revokes outer approval mid-route. Protected by delta scoping, so theft not shown; stranding/DoS plausible. |
| 3 | BoundedCall wholly untested (gas burn, success-bomb, short return dirty memory) | HIGH | Guards member exit liveness (H-1) and fee/registry reads in VaultCore; a regression turns creator-chosen module into exit DoS (user funds locked). |
| 4 | DirectPoolAdapter no fuzz/invariant, reverse direction untested | MED | Pair is trusted venue; out is on-chain quote, but `inIs0` swap (weth->usdc) is a live branch with zero coverage. |
| 5 | Aggregation RouterCallFailed / BadOrder / constructor / short-routeData untested | MED | Fail-closed branches; regression would admit malformed orders. Selector-allowlist-hazard (approve selector) is config risk. |
| 6 | Router returndata bomb on `router.call` (Aggregation L123) | MED-LOW | Needs hostile hop returning via pinned router; self-DoS of one swap. |
| 7 | FOT / rebasing tokenOut across all adapters (underflow Panic, short delivery) | MED | Fail-closed on adapter, but caller gets less than `amountOut`; VaultCore re-measures so low residual. |
| 8 | SwapExecuted never asserted; non-canonical bool returns; codeless token e2e | LOW | Off-chain indexer / documented behaviour. |

#### 7. Test code for the top 3 gaps (compile-oriented, not run; drop in test/, new files)

##### 7.1 test/UniswapV3AdapterRefundReentrancy.t.sol (gaps 1 and 2)
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {UniswapV3Adapter, ISwapRouter02} from "../src/UniswapV3Adapter.sol";
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";
contract PartialV3Router {
    uint256 public pull;
    uint256 public deliver;
    uint256 public pushBack;
    bool public reenter;
    bool public reentered;
    bytes4 public lastRevert;
    address public usdc;
    address public weth;
    function configure(address usdc_, address weth_, uint256 pull_, uint256 deliver_, uint256 pushBack_, bool re) external {
        (usdc, weth, pull, deliver, pushBack, reenter) = (usdc_, weth_, pull_, deliver_, pushBack_, re);
        MockERC20(usdc_).mint(address(this), 1e6 + pushBack_);
    }
    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external returns (uint256) {
        if (pull > 0) MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), pull);
        if (pushBack > 0) MockERC20(p.tokenIn).transfer(msg.sender, pushBack);
        if (reenter) {
            reenter = false;
            MockERC20(usdc).approve(msg.sender, type(uint256).max);
            IExecutionAdapter.SwapOrder memory o = IExecutionAdapter.SwapOrder({
                tokenIn: usdc, tokenOut: weth, amountIn: 1e6, minAmountOut: 0.0005e18,
                deadline: block.timestamp, routeData: ""
            });
            try UniswapV3Adapter(msg.sender).executeSwap(o) {
                reentered = true;
            } catch (bytes memory err) {
                lastRevert = bytes4(err);
            }
        }
        MockERC20(p.tokenOut).mint(p.recipient, deliver);
        return deliver;
    }
}
contract UniswapV3AdapterRefundReentrancyTest is Test {
    uint256 constant AMOUNT_IN = 10_000e6;
    uint256 constant DELIVER = 4.2e18; // above 99% of $10,000 at $2,400
    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    PartialV3Router router;
    UniswapV3Adapter adapter;
    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("WETH", 18);
        oracle = new MockOracle();
        oracle.setPrice(address(usdc), 1e18);
        oracle.setPrice(address(weth), 2400e18);
        router = new PartialV3Router();
        UniswapV3Adapter.FeeTierEntry[] memory t = new UniswapV3Adapter.FeeTierEntry[](1);
        t[0] = UniswapV3Adapter.FeeTierEntry(address(usdc), address(weth), 500);
        adapter = new UniswapV3Adapter(address(router), IOracleAggregator(address(oracle)), address(usdc), 100, t);
        usdc.mint(address(this), AMOUNT_IN);
        usdc.approve(address(adapter), type(uint256).max);
    }
    function _order() internal view returns (IExecutionAdapter.SwapOrder memory) {
        return IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc), tokenOut: address(weth), amountIn: AMOUNT_IN,
            minAmountOut: DELIVER, deadline: block.timestamp + 1 hours, routeData: ""
        });
    }
    function test_partialFillRefundsExactUnspentAndRevokesApproval() public {
        router.configure(address(usdc), address(weth), 4_000e6, DELIVER, 0, false);
        adapter.executeSwap(_order());
        assertEq(usdc.balanceOf(address(this)), 6_000e6, "refund = amountIn - pulled");
        assertEq(weth.balanceOf(address(this)), DELIVER);
        assertEq(usdc.balanceOf(address(adapter)), 0, "adapter empty");
        assertEq(usdc.allowance(address(adapter), address(router)), 0, "approval revoked");
    }
    function test_pushBackAboveAmountInIsClampedAndStrandedNotRefunded() public {
        router.configure(address(usdc), address(weth), 0, DELIVER, AMOUNT_IN + 500e6, false);
        adapter.executeSwap(_order());
        assertEq(usdc.balanceOf(address(this)), AMOUNT_IN, "refund clamped at amountIn");
        assertEq(usdc.balanceOf(address(adapter)), 500e6, "excess push strands");
    }
    function test_nestedSwapRevertsReentrancyAndLockReleases() public {
        router.configure(address(usdc), address(weth), 4_000e6, DELIVER, 0, true);
        adapter.executeSwap(_order());
        assertEq(router.lastRevert(), UniswapV3Adapter.Reentrancy.selector, "guard fired");
        assertFalse(router.reentered());
        assertEq(usdc.balanceOf(address(this)), 6_000e6, "outer refund intact");
        // lock released: a second plain order must work
        usdc.mint(address(this), AMOUNT_IN);
        router.configure(address(usdc), address(weth), AMOUNT_IN, DELIVER, 0, false);
        adapter.executeSwap(_order());
        assertEq(weth.balanceOf(address(this)), DELIVER * 2);
    }
}
```

##### 7.2 test/BoundedCall.t.sol (gap 3)
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {BoundedCall} from "../src/lib/BoundedCall.sol";
contract Burner { fallback() external { while (true) {} } }
contract ShortRet { fallback(bytes calldata) external returns (bytes memory) { return hex"ab"; } }
contract BigRet {
    uint256 public immutable words;
    constructor(uint256 w) { words = w; }
    fallback(bytes calldata) external returns (bytes memory r) {
        r = new bytes(words * 32);
        assembly { mstore(add(r, 0x20), 7) }
    }
}
contract Quiet { fallback() external {} }
contract Harness {
    function call_(address t, uint256 g) external returns (bool, uint256, uint256) {
        assembly { mstore(mload(0x40), not(0)) } // dirty the scratch word the library copies into
        return BoundedCall.boundedCall(t, hex"deadbeef", g);
    }
    function static_(address t, uint256 g) external view returns (bool, uint256, uint256) {
        assembly { mstore(mload(0x40), not(0)) }
        return BoundedCall.boundedStaticCall(t, hex"deadbeef", g);
    }
}
contract BoundedCallTest is Test {
    Harness h = new Harness();
    function test_gasBurnerIsCappedAndReportsFailure() public {
        address b = address(new Burner());
        uint256 g0 = gasleft();
        (bool ok,,) = h.call_(b, 300_000);
        assertFalse(ok);
        assertLt(g0 - gasleft(), 400_000, "caller pays at most the cap plus overhead");
        (ok,,) = h.static_(b, 300_000);
        assertFalse(ok);
    }
    function test_shortReturnWordIsZeroPaddedNotDirtyMemory() public {
        address s = address(new ShortRet());
        (bool ok, uint256 w, uint256 n) = h.call_(s, 100_000);
        assertTrue(ok);
        assertEq(n, 1);
        assertEq(w, uint256(0xab) << 248, "L-3: low bytes must be zero, not 0xff junk");
        (ok, w, n) = h.static_(s, 100_000);
        assertEq(w, uint256(0xab) << 248);
    }
    function test_successfulBombIsReadAsOneWordAndCheap() public {
        address bomb = address(new BigRet(2_000)); // 64 KB
        uint256 g0 = gasleft();
        (bool ok, uint256 w, uint256 n) = h.call_(bomb, 5_000_000);
        uint256 used = g0 - gasleft();
        assertTrue(ok);
        assertEq(n, 64_000);
        assertEq(w, 7);
        assertLt(used, 120_000, "caller does not pay to copy the buffer");
    }
    function test_noReturnAndCodelessTargets() public {
        (bool ok, uint256 w, uint256 n) = h.call_(address(new Quiet()), 100_000);
        assertTrue(ok); assertEq(n, 0); assertEq(w, 0);
        (ok, w, n) = h.call_(address(0xBEEF), 100_000); // codeless: success, empty
        assertTrue(ok); assertEq(n, 0);
    }
}
```

(Gap 4, DirectPool fuzz: testFuzz over `bool dir`, bounded reserves, assert k non-decreasing, adapter empty, both token orderings. Not written out to stay under the line budget.)

## Appendix F: FeeRegistryIdentity

### Test-gap analysis: FeeEngine, OperatorRegistry, IdentityGate, SubVaultRegistry

Read-only. forge not run; the code blocks in section 6 are UNCOMPILED. Paths are relative to
`contracts/`. "Covered" means a grep of `test/` (incl. `test/audit`)
found an exercising test. Existing suites: `FeesAndRegistry.t.sol` (10 tests), `FeeCarryInvariant.t.sol`
(3 invariants, registry+engine only), `audit/AuditFeeEngineReentrancy.t.sol` (2), `IdentityGate.t.sol`
(17), `SubVaults.t.sol`, `Create2Protocol.t.sol` (wiring), `SystemInvariant.t.sol` (no fee/registry invariant).

#### 1. FeeEngine (`src/FeeEngine.sol`)

Uncovered (grep evidence):
- `claimFees` revert `NothingToClaim` (L163): `grep NothingToClaim test/` hits only VaultCore. Also no test of a non-operator caller.
- `claimFees` `TransferFailed` path (L165, engine under-funded): no hit for `TransferFailed` against the engine.
- `onFeeCollectedAsset` (L110-124) with the REAL engine: only a stub impl in `mocks/Mocks.sol:126` and the empty `onFeeCollectedAsset` of `RatchetPerfFeeEngine` (`AuditExitFeeRatchet.t.sol:23`). `grep claimableFees test/` shows only the usdc key; no test asserts `claimableFees[op][wbtc]` after an in-kind exit.
- `onFeeCollected` / `onFeeCollectedAsset` `UnattestedVault` (L102, L119): the only `UnattestedVault` test is `onRealize` (`FeesAndRegistry:125`).
- `pullEscrowed` against a real `VaultCore` (L144-154): the only callers are stub vaults (`AuditFeeEngineReentrancy:81,140,155`). `UnattestedVault` on `pullEscrowed` untested; `received == 0` branch (L150) untested; USDC (6 dec) escrow case untested.
- `onRealize` `gainUsdc == 0` branch (L83) is hit only through VaultCore loss path; no direct assertion that fee is 0 and no event emitted.
- Registry stats desync: `pullEscrowed` credits `claimableFees` but never calls `registry.recordFeeCollected` (L151 vs L105), so `lifetimeFeesUsdc` omits escrowed-then-pulled USDC fees. No test pins this either way.

#### 2. FeeEngine / registry invariants not fuzzed
- Engine solvency: `token.balanceOf(engine) >= sum(claimableFees[*][token])`. Not asserted anywhere (the M-3 test checks it once, sequentially, with stubs).
- `lifetimeFeesUsdc <= lifetimeGainUsdc / 10` per operator, with the real vault.
- `lifetimeFeesUsdc == sum of cash-leg credits` (breaks after `pullEscrowed`, see above).
- `FeeCarryInvariant`: handler uses ONE opId, ONE vault, amounts bounded to 1e12 (`bound(.., 0, 1_000_000e6)`), never calls gain and loss in the same call, never calls `attestVault`/`registerOperator`/`recordFeeCollected`. The fee invariant probes a single fixed gain (500_000e6). So cross-operator carry isolation and `operatorCount`/`operatorIdOf`/`operatorAddressOf` bijection are not fuzzed.
- `SystemInvariant.t.sol` has four invariants (share conservation, solvency, child backing); none touches fees, carry or stats.

#### 3. Access-controlled paths lacking a negative test (OperatorRegistry)
- `wire` `ZeroAddress` (L251): `grep ZeroAddress test/` hits no OperatorRegistry/SubVaultRegistry case. `OnlyDeployer` and `AlreadyWired` ARE covered (`Create2Protocol:108,150`).
- `registerOperator` `AlreadyOperator` (L266) and the permissionless direct call: `grep "AlreadyOperator\|registerOperator" test/` = 0 hits.
- `recordFeeCollected` `OnlyFeeEngine`: covered only while unwired (`Create2Protocol:238`); no test from an attested vault, a random caller, or the operator after wiring.
- `attestVault`: re-attesting an existing vault to a different operator silently overwrites `_vaultOperator` and bumps `vaultCount` (L280-281). Factory-gated, untested, no guard. `leaderboardEntry` (L329): 0 hits.
- FeeEngine: see section 1 (`onFeeCollected*`, `pullEscrowed` from unattested vault, `claimFees` by non-operator).

#### 4. Reentrancy edge cases missing
- `claimFees` re-entering `claimFees` / `pullEscrowed` through a token hook during `safeTransfer`: the M-3 test covers only the `pullEscrowed -> pullEscrowed` shape. CEI plus mutex hold by reading, but no test.
- `pullEscrowed` where `claimEscrowed` re-enters `claimFees` (cross-function) or `onFeeCollectedAsset` (not guarded by `nonReentrant`: a vault mid-`claimEscrowed` could credit an unmeasured amount that the outer frame then ALSO measures from the balance delta). Untested; `onFeeCollected*` carry no mutex.
- `recordRealization` / `registerChild`: no external call except `IVaultFees.exitFeeMaxBps()` (view, staticcall) so reentrancy is not reachable; not worth a test.
- IdentityGate: `recordActivity` / views make no state change; only gas griefing (see section 5).

#### 5. Fee-math and edge cases missing
- HWM boundary: `gain == carry` and `gain == carry + 1` never executed (fuzz hits equality with probability ~0). Branches at `FeeEngine:87` and `OperatorRegistry:306` (`>=`).
- Rounding: fee is `floor(net*1000/10000)`; `gain < 10` yields 0 fee. Not asserted. VaultCore clamps at `gain/10` (VaultCore L747-749) but no test shows the engine never exceeds it for `net <= gain`.
- Both gain and loss nonzero in one `recordRealization` (interface permits it; loss is applied first). Untested; handler never does it.
- Zero supply / zero gain: `onRealize(member, 0, 0)` direct call untested.
- Huge values: `netGain * 1000` overflows above `type(uint256).max / 1000`: `onRealize` panics; VaultCore `boundedCall` swallows it so the fee silently becomes 0 (fail open). `carry += lossUsdc` overflow likewise swallowed, so the loss is NOT recorded. No test for either. Unrealistic with 6-decimal USDC but untested.
- Share price below HWM: protocol HWM is a realized-loss carry, not a share-price mark. Same-vault loss-then-gain for one member (carry built and consumed inside ONE vault) is not tested; only cross-vault (`FeesAndRegistry:177,207`). Partial redemptions (several `recordRealization` calls per member) not tested.
- Fee-on-transfer / rebasing basket asset: `onFeeCollectedAsset` credits the NOMINAL `amount` (L120), never a balance delta, unlike `pullEscrowed`. No test; see Gap A.
- SubVaultRegistry: `stackedPerfFeeBps` tested at depth 0 and 1 only (`SubVaults:168-169`); depth 2 (2710 bps) untested. Exit-stack boundary `stacked == 250` (L199 `<=`) untested (only 200 ok, 300 revert). `AlreadyRegistered` (L187), `ZeroAddress` on `wire` (L176) and `registerChild` with `parent == address(0)` or a non-contract parent (call to `exitFeeMaxBps` reverts) all have 0 hits.
- IdentityGate: no test with a registry returning < 32 bytes, an EOA/no-code registry, or oversized returndata. `reputationSummary` uses try/catch: by Solidity semantics a short or malformed return, or a no-code `reputationRegistry` (extcodesize check), reverts in the CALLER and is not caught, contradicting the natspec "fails open ... malformed response returns zeroed". Unverified (not run); worth a test. `hasIdentity` with `bal == type(uint256).max` fine.

#### 6. Funds-at-risk ranking

| Rank | Gap | Reason |
|---|---|---|
| HIGH | A. Unbacked `claimableFees` credit (`onFeeCollectedAsset`/`onFeeCollected` credit nominal, no balance check; one pooled balance per token) | A single over-credit (fee-on-transfer or rebasing basket asset, or any attested vault misreporting) lets operator A claim operator B's tokens; last claimer's `claimFees` reverts. Needs a hostile/quirky asset but the engine is a shared singleton across all vaults. |
| MED | B. `claimFees` / cross-function reentrancy with hook token; negative access on `onFeeCollected*` and `pullEscrowed` | CEI and the mutex look right by reading; only one shape tested. Funds impact if a guard is ever removed. |
| MED | C. Fee/carry boundary + overflow fuzz (gain==carry, both legs, huge values, floor rounding) | Wrong boundary under- or over-charges the 10% fee; overflow fails open silently (fee 0, loss unrecorded), eroding HWM. |
| MED (integrity, not funds) | D. `pullEscrowed` with real VaultCore never calls `recordFeeCollected` | Leaderboard `lifetimeFeesUsdc` understated after a blacklist/escrow episode; also zero test with real vault. |
| LOW | E. SubVaultRegistry boundaries (`==250`, depth-2 perf bps, `AlreadyRegistered`, `ZeroAddress`) | Factory-gated; a regression would weaken the member-protection fee cap but moves no funds directly. |
| LOW (claims) | F. IdentityGate malformed-return behaviour | No funds; read-only. But the natspec fail-open claim is likely false for short returns/no-code registry (CLAUDE.md claims-accuracy rule). |
| LOW | G. `registerOperator`/`attestVault` re-attest, `leaderboardEntry`, `initialized()` pre-wire for FeeEngine-side | Registry identity hygiene; gated by factory. |

Compilable-intent Foundry tests for A, B+access, C follow. Conventions copied from `FeesAndRegistry.t.sol`,
`FeeCarryInvariant.t.sol` and `audit/AuditFeeEngineReentrancy.t.sol`: pragma 0.8.26, `forge-std/Test.sol`,
`MockERC20` from `./mocks/Mocks.sol`, `PROTOCOL_INITIALIZER` prank to `wire`, `vm.expectRevert(Contract.Err.selector)`.
Suggested files: `test/FeeEngineGaps.t.sol` (A, B) and `test/FeeMathBoundary.t.sol` (C). UNCOMPILED.

##### Gap A + B: `test/FeeEngineGaps.t.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {SafeTransferLib} from "../src/lib/SafeTransferLib.sol";
import {MockERC20} from "./mocks/Mocks.sol";

contract GapRegistry is IRegistryView {
    mapping(address => uint256) public opOf;
    mapping(uint256 => address) public addrOf;

    function set(address vault, uint256 opId, address opAddr) external {
        opOf[vault] = opId;
        addrOf[opId] = opAddr;
    }

    function operatorOf(address v) external view returns (uint256) { return opOf[v]; }
    function carryOf(address, uint256) external pure returns (uint256) { return 0; }
    function operatorAddressOf(uint256 id) external view returns (address) { return addrOf[id]; }
    function recordFeeCollected(uint256, uint256) external {}
}

/// Token that fires one arbitrary call from ITSELF to `target` in the middle of `transfer`.
contract HookToken {
    mapping(address => uint256) public balanceOf;
    address public target;
    bytes public payload;
    bool public armed;
    bool public hookOk;
    bytes public hookRet;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
        armed = true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        if (armed) {
            armed = false;
            (hookOk, hookRet) = target.call(payload);
        }
        return true;
    }
}

contract FeeEngineGapsTest is Test {
    FeeEngine engine;
    GapRegistry reg;
    MockERC20 token;
    HookToken hook;

    address vaultA = makeAddr("vaultA");
    address vaultB = makeAddr("vaultB");
    address opA = makeAddr("opA");
    address opB = makeAddr("opB");
    address member = makeAddr("member");

    function setUp() public {
        reg = new GapRegistry();
        engine = new FeeEngine(IRegistryView(address(reg)));
        token = new MockERC20("T", 18);
        hook = new HookToken();
        reg.set(vaultA, 1, opA);
        reg.set(vaultB, 2, opB);
    }

    // ---- Gap A: nominal credit is not balance-checked; operators share one pooled balance ----
    /// Characterization test of CURRENT behaviour. If the engine later credits balance deltas,
    /// flip the expectations: A's credit would be 40e18 and both claims would succeed.
    function test_overCreditedOperatorDrainsAnotherOperatorsFees() public {
        // Vault B legitimately delivers 60; vault A "delivers" 40 (fee-on-transfer) but reports 100.
        token.mint(address(engine), 40e18 + 60e18);
        vm.prank(vaultB);
        engine.onFeeCollectedAsset(member, address(token), 60e18);
        vm.prank(vaultA);
        engine.onFeeCollectedAsset(member, address(token), 100e18);

        uint256 credits = engine.claimableFees(opA, address(token)) + engine.claimableFees(opB, address(token));
        assertGt(credits, token.balanceOf(address(engine)), "credits exceed backing: solvency invariant broken");

        vm.prank(opA);
        engine.claimFees(address(token)); // A takes all 100, including B's 60
        assertEq(token.balanceOf(opA), 100e18);

        vm.prank(opB);
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TransferFailed.selector, address(token)));
        engine.claimFees(address(token)); // B is owed 60, engine holds 0
    }

    // ---- Gap B1: claimFees reentrancy through a token hook ----
    function test_claimFees_hookReentryIntoClaimOrPullIsRefused() public {
        hook.mint(address(engine), 100e18);
        vm.prank(vaultA);
        engine.onFeeCollectedAsset(member, address(hook), 100e18);

        hook.arm(address(engine), abi.encodeCall(FeeEngine.claimFees, (address(hook))));
        vm.prank(opA);
        engine.claimFees(address(hook));
        assertFalse(hook.hookOk(), "nested claimFees must fail");
        assertEq(bytes4(hook.hookRet()), FeeEngine.Reentrancy.selector);
        assertEq(hook.balanceOf(opA), 100e18, "paid exactly once");

        // lock released: a fresh credit is claimable again
        hook.mint(address(engine), 5e18);
        vm.prank(vaultA);
        engine.onFeeCollectedAsset(member, address(hook), 5e18);
        hook.arm(address(engine), abi.encodeCall(FeeEngine.pullEscrowed, (vaultB, address(hook))));
        vm.prank(opA);
        engine.claimFees(address(hook));
        assertFalse(hook.hookOk(), "nested pullEscrowed must fail");
        assertEq(bytes4(hook.hookRet()), FeeEngine.Reentrancy.selector);
        assertEq(hook.balanceOf(opA), 105e18);
    }

    // ---- Gap B2: negative access / empty-claim paths ----
    function test_unattestedCallersAndEmptyClaimsRevert() public {
        address rogue = makeAddr("rogue");
        vm.startPrank(rogue);
        vm.expectRevert(FeeEngine.UnattestedVault.selector);
        engine.onFeeCollected(member, 1);
        vm.expectRevert(FeeEngine.UnattestedVault.selector);
        engine.onFeeCollectedAsset(member, address(token), 1);
        vm.expectRevert(FeeEngine.UnattestedVault.selector);
        engine.pullEscrowed(rogue, address(token));
        vm.expectRevert(FeeEngine.NothingToClaim.selector);
        engine.claimFees(address(token));
        vm.stopPrank();

        // an operator cannot claim another operator's balance
        token.mint(address(engine), 10e18);
        vm.prank(vaultA);
        engine.onFeeCollectedAsset(member, address(token), 10e18);
        vm.prank(opB);
        vm.expectRevert(FeeEngine.NothingToClaim.selector);
        engine.claimFees(address(token));
    }
}
```
Note: `onFeeCollected` (usdc leg) calls `IVaultUsdc(msg.sender).usdc()` after the attestation check, so the unattested revert comes first; for an attested stub it would need a `usdc()` function (omit from the test above).

##### Gap C: `test/FeeMathBoundary.t.sol` (fuzz + boundaries + overflow)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";

contract FeeMathBoundaryTest is Test {
    OperatorRegistry registry;
    FeeEngine fees;
    address vault = makeAddr("vault");
    address operator = makeAddr("operator");
    address m = makeAddr("member");
    uint256 opId;

    function setUp() public {
        registry = new OperatorRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        vm.prank(PROTOCOL_INITIALIZER);
        registry.wire(address(this), address(fees));
        registry.attestVault(vault, operator);
        opId = registry.operatorOf(vault);
    }

    function _loss(uint256 a) internal {
        vm.prank(vault);
        registry.recordRealization(m, 0, a);
    }

    /// Exact fee formula and exact carry update, including gain and loss in ONE call.
    function testFuzz_feeAndCarryExact(uint256 pre, uint256 gain, uint256 loss) public {
        pre = bound(pre, 0, type(uint128).max);
        gain = bound(gain, 0, type(uint128).max);
        loss = bound(loss, 0, type(uint128).max);
        _loss(pre);
        assertEq(registry.carryOf(m, opId), pre);

        vm.prank(vault);
        uint256 fee = fees.onRealize(m, gain, 0);
        uint256 net = gain > pre ? gain - pre : 0;
        assertEq(fee, net * 1_000 / 10_000, "fee == floor(10% of net)");
        assertLe(fee, gain / 10, "never above the vault's clamp");
        if (gain == 0) assertEq(fee, 0);

        vm.prank(vault);
        registry.recordRealization(m, gain, loss); // loss applied first, then gain
        uint256 c = pre + loss;
        assertEq(registry.carryOf(m, opId), gain >= c ? 0 : c - gain);
    }

    /// gain == carry and gain == carry + 1 (the two branch edges), plus floor rounding.
    function test_boundary_gainEqualsCarry() public {
        _loss(1_000e6);
        vm.prank(vault);
        assertEq(fees.onRealize(m, 1_000e6, 0), 0, "gain == carry: no fee");
        vm.prank(vault);
        assertEq(fees.onRealize(m, 1_000e6 + 1, 0), 0, "net 1 wei: floor(0.1) == 0");
        vm.prank(vault);
        assertEq(fees.onRealize(m, 1_000e6 + 10, 0), 1, "net 10: fee 1");

        vm.prank(vault);
        registry.recordRealization(m, 1_000e6, 0);
        assertEq(registry.carryOf(m, opId), 0, "gain == carry consumes exactly");
    }

    function test_zeroGainZeroLoss_isNoop() public {
        _loss(5);
        vm.prank(vault);
        assertEq(fees.onRealize(m, 0, 0), 0);
        vm.prank(vault);
        registry.recordRealization(m, 0, 0);
        assertEq(registry.carryOf(m, opId), 5);
    }

    /// Characterizes the overflow behaviour VaultCore's boundedCall would swallow (fee -> 0).
    function test_hugeValues_revertWithPanic_notWrap() public {
        bytes memory panic = abi.encodeWithSignature("Panic(uint256)", uint256(0x11));
        vm.prank(vault);
        vm.expectRevert(panic);
        fees.onRealize(m, type(uint256).max, 0); // netGain * 1000 overflows

        _loss(type(uint256).max);
        vm.prank(vault);
        vm.expectRevert(panic);
        registry.recordRealization(m, 0, 1); // carry += loss overflows
        assertEq(registry.carryOf(m, opId), type(uint256).max, "state untouched by the panic");
    }

    function test_registerOperator_isPermissionlessAndOneShotPerAddress() public {
        address fresh = makeAddr("fresh");
        vm.prank(makeAddr("anyone"));
        uint256 id = registry.registerOperator(fresh);
        assertEq(registry.operatorAddressOf(id), fresh);
        vm.expectRevert(OperatorRegistry.AlreadyOperator.selector);
        registry.registerOperator(fresh);
    }
}
```

Gap D sketch (not coded): use `AuditUsdcLegEscrow` setUp but with the real `FeeEngine` + `OperatorRegistry` via `FeesAndRegistry._createVault`, `usdc.setBlacklisted(address(fees), true)`, exit alice with a gain, `fees.pullEscrowed(vault, usdc)`, then assert `claimableFees[operator][usdc] > 0` and `statsOf(opId).lifetimeFeesUsdc == 0` (documents the desync) after un-blacklisting.
Gap F sketch: `vm.etch(address(rep), hex"")` / a mock returning 1 byte, then `vm.expectRevert()` (or assert zeros if the natspec is meant to hold) on `gate.reputationSummary(1, clients, "", "")`; same for `hasIdentity` with a 31-byte return (that one already returns false by the `data.length < 32` check).

