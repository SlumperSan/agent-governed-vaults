// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";

contract SubVaultsTest is Test {
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
            IOperatorRegistry(address(registry)), IGovernance(address(gov)), IFeeEngine(address(fees)), address(subReg)
        );
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));

        usdc.mint(operator, 100_000_000 * USDC_1);
        usdc.mint(alice, 100_000_000 * USDC_1);

        // Parent basket: wBTC + wETH. Child basket: wETH only (subset).
        address[] memory pBasket = new address[](2);
        pBasket[0] = address(wbtc);
        pBasket[1] = address(weth);
        parent = VaultCore(factory.createVault(_params(pBasket, 50)));

        address[] memory cBasket = new address[](1);
        cBasket[0] = address(weth);
        vm.prank(operator);
        child = VaultCore(factory.createChildVault(_params(cBasket, 50), address(parent)));

        // Fund parent: operator + alice.
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? operator : alice;
            vm.startPrank(who);
            usdc.approve(address(parent), type(uint256).max);
            parent.deposit(1_000 * USDC_1);
            parent.skipWindow();
            vm.stopPrank();
        }
    }

    function _params(address[] memory basket, uint256 exitFeeBps)
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
            exitFeeMaxBps: exitFeeBps,
            exitFeeDecayPeriod: exitFeeBps == 0 ? 0 : 30 days,
            allowedAdapters: new address[](0)
        });
    }

    /// Drive an allocation through the vault as governance would (gov contract is the caller).
    function _allocate(uint256 amount) internal {
        vm.prank(address(gov));
        parent.allocateToChild(address(child), amount);
    }

    // ── structure: depth, cycles, subsets, fee stack (SV-2/3/4) ──────────────

    function test_depthCapAtThreeLevels() public {
        address[] memory cBasket = new address[](1);
        cBasket[0] = address(weth);
        vm.prank(operator);
        address grandchild = factory.createChildVault(_params(cBasket, 50), address(child));
        assertEq(subReg.depthOf(grandchild), 2, "level 3 ok");

        vm.prank(operator);
        vm.expectRevert(SubVaultRegistry.DepthExceeded.selector);
        factory.createChildVault(_params(cBasket, 50), grandchild); // level 4 blocked
    }

    function test_basketMustBeSubsetOfParent() public {
        MockERC20 rogue = new MockERC20("ROGUE", 18);
        address[] memory bad = new address[](1);
        bad[0] = address(rogue);
        vm.prank(operator);
        vm.expectRevert(VaultFactory.BasketNotSubsetOfParent.selector);
        factory.createChildVault(_params(bad, 50), address(parent));
    }

    function test_allocationOnlyAlongRegisteredEdges() public {
        // A standalone vault is NOT a child — allocation reverts (SV-3).
        address[] memory b = new address[](1);
        b[0] = address(weth);
        address standalone = factory.createVault(_params(b, 50));
        vm.prank(address(gov));
        vm.expectRevert(VaultCore.NotRegisteredChild.selector);
        parent.allocateToChild(standalone, 100 * USDC_1);
    }

    function test_exitFeeStackCapEnforced() public {
        // 1% + 1% = 2% ok; a third 1% level crosses the 2.5% stack cap (SV-4).
        address[] memory b = new address[](1);
        b[0] = address(weth);
        address p2 = factory.createVault(_params(b, 100));
        vm.prank(operator);
        address c2 = factory.createChildVault(_params(b, 100), p2); // stacked 2% ok
        vm.prank(operator);
        vm.expectRevert(SubVaultRegistry.ExitFeeStackExceeded.selector);
        factory.createChildVault(_params(b, 100), c2); // 3% > 2.5%
    }

    function test_stackedFeeViews() public view {
        assertEq(subReg.stackedPerfFeeBps(address(parent)), 1_000, "10% at root");
        assertEq(subReg.stackedPerfFeeBps(address(child)), 1_900, "19% at level 2 (SV-4)");
        assertEq(subReg.stackedExitFeeCapBps(address(child)), 100, "0.5%+0.5%");
    }

    // ── quorum inheritance (SV-6) ────────────────────────────────────────────

    function test_childQuorumFloorInheritsFromParent() public {
        Governance.GovConfig memory pCfg = _gcfg(4_000);
        gov.registerVault(address(parent), pCfg); // parent creator = this test contract

        Governance.GovConfig memory low = _gcfg(3_000); // below parent's 40%
        vm.prank(operator);
        vm.expectRevert(Governance.BadGovConfig.selector);
        gov.registerVault(address(child), low);

        Governance.GovConfig memory ok = _gcfg(4_000);
        vm.prank(operator);
        gov.registerVault(address(child), ok); // max(child, parent) satisfied
    }

    function _gcfg(uint16 quorum) internal pure returns (Governance.GovConfig memory) {
        return Governance.GovConfig({
            commitDuration: 6 hours,
            revealDuration: 6 hours,
            timelockDuration: 1 days,
            executionWindow: 2 days,
            quorumBps: quorum,
            proposalThresholdBps: 500,
            concentrationCapBps: 10_000,
            proposalCooldown: 1 hours
        });
    }

    // ── allocation, look-through NAV (SV-7) ──────────────────────────────────

    function test_allocatePreservesParentNav() public {
        uint256 navBefore = parent.navWad();
        _allocate(800 * USDC_1);

        assertEq(parent.idleUsdc(), 1_200 * USDC_1, "idle debited");
        assertEq(child.sharesOf(address(parent)), child.totalShares(), "parent owns child");
        // Look-through: child holds 800 idle → parent NAV unchanged.
        assertApproxEqAbs(parent.navWad(), navBefore, 1e12, "NAV preserved through allocation");
    }

    function test_lookThroughTracksChildAssets() public {
        _allocate(800 * USDC_1);
        // Child "invests" its idle into wETH (simulated executed rebalance).
        deal_weth_to_child(0.2e18); // 0.2 wETH = $800

        uint256 nav = parent.navWad();
        // Parent NAV = 1200 idle + child(0.2 wETH @ $4000) = 1200 + 800 = 2000 USDC.
        assertApproxEqAbs(nav, 2_000 * USDC_1 * 1e12, 1e12, "look-through at asset level");

        // Child asset appreciates 2x → parent NAV rises through look-through.
        oracle.setPrice(address(weth), 8_000e18);
        assertApproxEqAbs(parent.navWad(), 2_800 * USDC_1 * 1e12, 1e12, "price flows through");
    }

    function deal_weth_to_child(uint256 amt) internal {
        weth.mint(address(child), amt);
        vm.record();
        child.assetBalance(address(weth));
        (bytes32[] memory reads,) = vm.accesses(address(child));
        vm.store(address(child), reads[0], bytes32(amt));
        // consume child idle correspondingly (0.2 wETH @$4000 = $800 =全idle)
        vm.record();
        child.idleUsdc();
        (bytes32[] memory reads2,) = vm.accesses(address(child));
        vm.store(address(child), reads2[0], bytes32(uint256(0)));
    }

    // ── SV-5: idle-first exits, shortfall unwind ─────────────────────────────

    function test_exitDrawsIdleFirst_childUntouched() public {
        _allocate(500 * USDC_1); // idle 1500, child 500
        skip(30 days); // decay exit fees away for clean numbers

        uint256 childSharesBefore = child.sharesOf(address(parent));
        uint256 bal = usdc.balanceOf(alice);
        uint256 shares = parent.sharesOf(alice);
        vm.prank(alice);
        parent.requestExit(shares); // alice's 50% = $1000 ≤ idle 1500

        assertApproxEqAbs(usdc.balanceOf(alice) - bal, 1_000 * USDC_1, 2, "paid from idle");
        assertEq(child.sharesOf(address(parent)), childSharesBefore, "child untouched (SV-5)");
    }

    function test_exitShortfallUnwindsChild() public {
        _allocate(1_600 * USDC_1); // idle 400, child 1600
        skip(30 days);

        uint256 childSharesBefore = child.sharesOf(address(parent));
        uint256 bal = usdc.balanceOf(alice);
        uint256 shares = parent.sharesOf(alice);
        vm.prank(alice);
        parent.requestExit(shares); // alice's $1000 > idle 400 → unwind ~$600 of child

        // Alice receives idle (400) + child unwind proceeds (~600, in child's USDC).
        assertApproxEqAbs(usdc.balanceOf(alice) - bal, 1_000 * USDC_1, 5 * USDC_1, "made whole");
        assertLt(child.sharesOf(address(parent)), childSharesBefore, "child partially unwound");
        // Remaining member (operator) keeps: idle ≈ 0, child ≈ 1000.
        assertApproxEqAbs(parent.navWad(), 1_000 * USDC_1 * 1e12, 5e18, "remainer NAV intact");
    }

    // ── governance redemption (SV-1) ─────────────────────────────────────────

    function test_governanceRedeemsFromChild() public {
        _allocate(800 * USDC_1);
        uint256 half = child.sharesOf(address(parent)) / 2;
        vm.prank(address(gov));
        parent.redeemFromChild(address(child), half);
        assertApproxEqAbs(parent.idleUsdc(), 1_600 * USDC_1, 2, "USDC back to idle");
        assertApproxEqAbs(parent.navWad(), 2_000 * USDC_1 * 1e12, 2e12, "NAV preserved");
    }

    // ── Governance re-review Area 1: parent vault is a NON-voting member ─────

    function test_childRuleChangePassesAfterParentAllocates() public {
        // Register governance on both, allocate parent capital into the child, then run a
        // full-consensus RuleChange on the CHILD. Pre-fix the parent's non-voting shares made
        // revealedWeight == snapshotTotal unreachable → config permanently frozen.
        gov.registerVault(address(parent), _gcfg(4_000));
        vm.prank(operator);
        gov.registerVault(address(child), _gcfg(4_000));

        // A human member joins the child directly (EOA), plus the parent allocates.
        usdc.mint(alice, 1_000 * USDC_1);
        vm.startPrank(alice);
        usdc.approve(address(child), type(uint256).max);
        child.deposit(1_000 * USDC_1);
        child.skipWindow();
        vm.stopPrank();
        vm.prank(address(gov));
        parent.allocateToChild(address(child), 800 * USDC_1); // parent now holds child shares

        // Parent is excluded from the child's voting-eligible stake.
        assertEq(child.votingEligibleShares(address(parent)), 0, "parent non-voting");
        assertEq(child.totalVotingEligibleShares(), child.sharesOf(alice), "only alice is eligible");
        skip(1);

        // Alice alone is now 100% of eligible stake → full consensus reachable.
        Governance.GovConfig memory newCfg = _gcfg(5_000);
        bytes memory payload = abi.encode(newCfg);
        vm.prank(alice);
        uint256 pid = gov.propose(address(child), Governance.ProposalType.RuleChange, keccak256(payload));
        vm.prank(alice);
        gov.commitVote(pid, keccak256(abi.encode(pid, alice, true, keccak256("s"))));
        (,,,, uint64 cd, uint64 rd,,,,,,,,,,) = gov.proposals(pid);
        vm.warp(cd);
        vm.prank(alice);
        gov.revealVote(pid, true, keccak256("s"));
        vm.warp(rd);
        gov.finalize(pid);
        vm.warp(block.timestamp + 1 days);
        gov.execute(pid, payload);

        (,,,, uint16 q,,,) = gov.configOf(address(child));
        assertEq(q, 5_000, "child RuleChange executed despite parent membership");
    }

    function test_childFlowsAreGovernanceOnly() public {
        vm.expectRevert(VaultCore.OnlyGovernance.selector);
        parent.allocateToChild(address(child), 100 * USDC_1);
        vm.expectRevert(VaultCore.OnlyGovernance.selector);
        parent.redeemFromChild(address(child), 1);
    }
}
