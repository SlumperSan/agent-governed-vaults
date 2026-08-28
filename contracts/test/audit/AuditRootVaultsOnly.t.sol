// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// C-1 regression — "root vaults only" launch remediation.
//
// C-1: a sub-vault whose only capital is its parent's allocation has an EMPTY ELECTORATE. The
// GA-1 fix excludes the parent from both voting-eligible stake and holder count, so a funded
// child reports pastTotalVotingEligibleShares == 0 and pastHolderCount == 0 while holding real
// money. `deposit` is permissionless, so one `minDepositUsdc` makes an attacker the SOLE
// eligible voter; every governance gate then passes trivially and the proposer-supplied
// `minAmountOut` turns capture into drain (see AI-AUDIT-REPORT.md C-1).
//
// There is no purely-internal fix: any voting denominator that excludes the parent lets a dust
// depositor govern the parent's allocation, and including the parent makes the child ungovernable
// (the parent is a contract with no vote path). The owner's decision is to ship launch with
// sub-vaults DISABLED at the contract level (VaultFactory.allowSubVaults == false) and defer the
// mechanism to a post-launch, post-audit release.
//
// This suite proves BOTH directions in one harness:
//   * test_finding_* — with sub-vaults ENABLED, the empty electorate is real and one dust deposit
//     buys sole control. This is the live vulnerability, and the reason the launch switch exists.
//     NOTE: this reproduction is reachable ONLY in the sub-vaults-ENABLED configuration
//     (allowSubVaults == true), which the test builds explicitly. At launch the factory ships
//     allowSubVaults == false, so this path cannot be reached on a real deployment — it documents
//     why sub-vaults are disabled, it is not a live exploit against the launch config.
//   * test_remediated_* — with sub-vaults DISABLED (the launch config), no child can be created or
//     funded, so the empty-electorate precondition is UNREACHABLE — C-1 is closed as a class.

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

contract AuditRootVaultsOnlyTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth; // 18 dec
    MockOracle oracle;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultFactory factory;

    address operator = makeAddr("operator"); // honest parent creator
    address attacker = makeAddr("attacker");

    /// @dev Build a full wired system with sub-vaults on or off. Called per-test so each test
    /// picks the launch switch it exercises.
    function _deploySystem(bool allowSubVaults) internal {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
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
            allowSubVaults
        );
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));

        usdc.mint(operator, 100_000_000 * USDC_1);
        usdc.mint(attacker, 100_000_000 * USDC_1);
    }

    function _params(address[] memory basket) internal view returns (VaultFactory.VaultParams memory) {
        return VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: basket,
            oracle: IOracleAggregator(address(oracle)),
            capacityCapUsdc: 1_000_000_000 * USDC_1,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: 50,
            exitFeeDecayPeriod: 30 days,
            allowedAdapters: new address[](0)
        });
    }

    function _basket() internal view returns (address[] memory b) {
        b = new address[](1);
        b[0] = address(weth);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The live vulnerability (enabled path): funded child ⇒ empty electorate ⇒
    // one dust deposit is sole control.
    // ─────────────────────────────────────────────────────────────────────────
    function test_finding_c1_fundedChildHasEmptyElectorate_dustBuysSoleControl() public {
        _deploySystem(true); // sub-vaults enabled — the pre-launch / future-release configuration

        vm.prank(operator);
        VaultCore parent = VaultCore(factory.createVault(_params(_basket())));

        vm.prank(operator);
        VaultCore child = VaultCore(factory.createChildVault(_params(_basket()), address(parent)));

        // Fund the parent, then allocate real capital into the child (as governance does).
        vm.startPrank(operator);
        usdc.approve(address(parent), type(uint256).max);
        parent.deposit(1_000_000 * USDC_1);
        parent.skipWindow();
        vm.stopPrank();

        vm.prank(address(gov));
        parent.allocateToChild(address(child), 1_000_000 * USDC_1);

        // The child now holds ~$1M of real value...
        vm.warp(block.timestamp + 1);
        assertGt(child.navWad(), 0, "child holds real money");
        // ...but its electorate is EMPTY: the parent (its only holder) is excluded by GA-1.
        assertEq(
            child.pastTotalVotingEligibleShares(uint64(block.timestamp)), 0, "empty voting-eligible stake"
        );
        assertEq(child.pastHolderCount(uint64(block.timestamp)), 0, "empty electorate");

        // One minimum deposit makes the attacker the SOLE eligible voter over the whole pool.
        vm.startPrank(attacker);
        usdc.approve(address(child), type(uint256).max);
        child.deposit(child.minDepositUsdc());
        child.skipWindow();
        vm.stopPrank();

        vm.warp(block.timestamp + 1);
        uint256 attackerElig = child.votingEligibleShares(attacker);
        assertGt(attackerElig, 0, "attacker holds eligible stake");
        assertEq(
            child.pastTotalVotingEligibleShares(uint64(block.timestamp)),
            attackerElig,
            "attacker is the ENTIRE electorate"
        );
        assertEq(child.pastHolderCount(uint64(block.timestamp)), 1, "attacker is the sole eligible holder");
        // From here every governance gate passes for the attacker (own == total), and the
        // proposer-supplied minAmountOut turns that capture into a drain of the parent's $1M.
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The launch remediation (root vaults only): the precondition is unreachable.
    // ─────────────────────────────────────────────────────────────────────────
    function test_remediated_c1_rootVaultsOnly_noChildCanBeCreatedOrFunded() public {
        _deploySystem(false); // launch configuration — sub-vaults disabled

        vm.prank(operator);
        VaultCore parent = VaultCore(factory.createVault(_params(_basket())));

        // 1. No child can be created — so no parent/child edge can ever be registered
        //    (registerChild is factory-only), and with no edge no vault can be funded as a child.
        vm.prank(operator);
        vm.expectRevert(VaultFactory.SubVaultsDisabled.selector);
        factory.createChildVault(_params(_basket()), address(parent));

        // 2. Belt-and-suspenders: every launch vault is wired root-only, so even the funding call
        //    itself is dead. The parent has no sub-vault registry and no parent of its own.
        assertEq(parent.subVaultRegistry(), address(0), "launch vault is intrinsically root-only");
        assertEq(parent.parentVault(), address(0), "launch vault has no parent");

        vm.startPrank(operator);
        usdc.approve(address(parent), type(uint256).max);
        parent.deposit(1_000_000 * USDC_1);
        parent.skipWindow();
        vm.stopPrank();

        // allocateToChild reverts for any target — there is no registered child and no registry.
        vm.prank(address(gov));
        vm.expectRevert(VaultCore.NotRegisteredChild.selector);
        parent.allocateToChild(address(0xdead), 1 * USDC_1);

        // With no funded child in existence, the empty-electorate capture of the finding above has
        // no target. C-1 is closed as a class at launch.
    }
}
