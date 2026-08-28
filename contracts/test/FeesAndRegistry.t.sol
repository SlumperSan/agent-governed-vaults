// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {VaultFactory, IVaultDeployer} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";

contract FeesAndRegistryTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 wbtcLike;
    MockOracle oracle;
    OperatorRegistry registry;
    FeeEngine fees;
    Governance gov;
    VaultFactory factory;

    address operator = makeAddr("operator"); // vault creator = operator identity
    address alice = makeAddr("alice");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        wbtcLike = new MockERC20("wBTC", 8);
        oracle = new MockOracle();
        oracle.setPrice(address(wbtcLike), 100_000e18);

        registry = new OperatorRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        gov = new Governance();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(0),
            IVaultDeployer(address(new VaultDeployer())),
            false // root-only; this suite never touches sub-vaults
        );
        registry.wire(address(factory), address(fees));

        usdc.mint(operator, 100_000_000 * USDC_1);
        usdc.mint(alice, 100_000_000 * USDC_1);
    }

    function _createVault(address[] memory basket) internal returns (VaultCore v) {
        vm.prank(operator);
        v = VaultCore(
            factory.createVault(
                VaultFactory.VaultParams({
                    usdc: address(usdc),
                    basketAssets: basket,
                    oracle: IOracleAggregator(address(oracle)),
                    capacityCapUsdc: 1_000_000_000 * USDC_1,
                    minDepositUsdc: 10 * USDC_1,
                    exitFeeMaxBps: 0, // isolate performance-fee math from exit fees
                    exitFeeDecayPeriod: 0,
                    allowedAdapters: new address[](0)
                })
            )
        );
        vm.startPrank(operator);
        usdc.approve(address(v), type(uint256).max);
        v.deposit(1_000 * USDC_1);
        v.skipWindow();
        vm.stopPrank();
        vm.startPrank(alice);
        usdc.approve(address(v), type(uint256).max);
        v.deposit(1_000 * USDC_1);
        v.skipWindow();
        vm.stopPrank();
    }

    /// Simulate an executed rebalance: all idle USDC becomes wBTC exposure (adapter lands S4).
    function _drainIdleToBasket(VaultCore v, uint256 wbtcAmt) internal {
        stdstore.target(address(v)).sig("idleUsdc()").checked_write(uint256(0));
        _fundBasket(v, wbtcAmt);
    }

    function _fundBasket(VaultCore v, uint256 wbtcAmt) internal {
        wbtcLike.mint(address(v), wbtcAmt);
        uint256 cur = v.assetBalance(address(wbtcLike));
        stdstore.target(address(v)).sig("assetBalance(address)").with_key(address(wbtcLike))
            .checked_write(cur + wbtcAmt);
    }

    function _exitAll(VaultCore v, address who) internal returns (uint256 usdcReceived) {
        uint256 bal = usdc.balanceOf(who);
        uint256 shares = v.sharesOf(who);
        vm.prank(who);
        v.requestExit(shares);
        usdcReceived = usdc.balanceOf(who) - bal;
    }

    // ── attestation & identity ───────────────────────────────────────────────

    function test_factoryAttestsAndAutoRegistersOperator() public {
        VaultCore v = _createVault(new address[](0));
        uint256 opId = registry.operatorOf(address(v));
        assertEq(opId, 1, "auto-registered");
        assertEq(registry.operatorAddressOf(opId), operator);
        (,,, uint256 vaultCount) = registry.statsOf(opId);
        assertEq(vaultCount, 1);
    }

    function test_unattestedVaultCannotRecordOrBeFeeAssessed() public {
        vm.expectRevert(OperatorRegistry.OnlyAttestedVault.selector);
        registry.recordRealization(alice, 100, 0);

        vm.expectRevert(FeeEngine.UnattestedVault.selector);
        fees.onRealize(alice, 100, 0);
    }

    function test_onlyFactoryAttests() public {
        vm.expectRevert(OperatorRegistry.OnlyFactory.selector);
        registry.attestVault(address(0xdead), operator);
    }

    function test_wireIsOneShot() public {
        vm.expectRevert(OperatorRegistry.AlreadyWired.selector);
        registry.wire(address(this), address(this));
    }

    // ── performance fee: 10% of realized net gain ────────────────────────────

    function test_tenPercentOfRealizedGain() public {
        address[] memory basket = new address[](1);
        basket[0] = address(wbtcLike);
        VaultCore v = _createVault(basket);
        _fundBasket(v, 1e8); // +$100k appreciation on $2k basis

        uint256 opId = registry.operatorOf(address(v));
        _exitAll(v, alice);

        // Alice's realized gain ≈ 50% of ($2k idle + $100k basket) − $1k basis = $50k.
        (uint256 g,, uint256 feesCollected,) = registry.statsOf(opId);
        assertApproxEqRel(g, 50_000 * USDC_1, 0.02e18, "gain recorded");
        assertGt(feesCollected, 0, "fee collected recorded");
        assertEq(fees.claimableFees(operator, address(usdc)), feesCollected, "credited = collected");
        // Fee ≤ 10% of gain always (cash-leg clamp may bind below).
        assertLe(feesCollected, g / 10 + 1);
    }

    function test_operatorClaimsFees() public {
        address[] memory basket = new address[](1);
        basket[0] = address(wbtcLike);
        VaultCore v = _createVault(basket);
        _fundBasket(v, 1e8);
        _exitAll(v, alice);

        uint256 claimable = fees.claimableFees(operator, address(usdc));
        uint256 bal = usdc.balanceOf(operator);
        vm.prank(operator);
        fees.claimFees(address(usdc));
        assertEq(usdc.balanceOf(operator) - bal, claimable);
        assertEq(fees.claimableFees(operator, address(usdc)), 0);
    }

    // ── the marquee mechanic: cross-vault HWM carryforward (§7, CM-4/CM-5) ───

    function test_lossInVaultA_offsetsFeeInVaultB_sameOperator() public {
        // Vault A: alice realizes a loss (exit fee-free vault, loss via price collapse).
        address[] memory basket = new address[](1);
        basket[0] = address(wbtcLike);
        VaultCore vaultA = _createVault(basket);
        _drainIdleToBasket(vaultA, 0.02e8); // $2k idle → 0.02 wBTC ($2k at entry)
        oracle.setPrice(address(wbtcLike), 1e18); // $100k → $1: basket collapses

        _exitAll(vaultA, alice); // realized loss ≈ $1000 (basis 1000, payout ≈ $0)
        uint256 opId = registry.operatorOf(address(vaultA));
        uint256 carry = registry.carryOf(alice, opId);
        assertGt(carry, 0, "loss carried forward");

        // Vault B, SAME operator: alice gains — fee only on gain net of vault-A loss.
        oracle.setPrice(address(wbtcLike), 100_000e18);
        VaultCore vaultB = _createVault(basket);
        assertEq(registry.operatorOf(address(vaultB)), opId, "same identity");

        // Small appreciation: gain LESS than the carried loss ⇒ zero fee.
        _fundBasket(vaultB, 100); // 1e-6 wBTC ≈ $0.1... use small but nonzero gain
        uint256 collectedBefore = fees.claimableFees(operator, address(usdc));
        _exitAll(vaultB, alice);
        assertEq(
            fees.claimableFees(operator, address(usdc)),
            collectedBefore,
            "no fee while under water cross-vault"
        );
        assertLt(registry.carryOf(alice, opId), carry, "carry partially consumed by gain");
    }

    function test_carryFullyConsumedThenFeesResume() public {
        address[] memory basket = new address[](1);
        basket[0] = address(wbtcLike);
        VaultCore vaultA = _createVault(basket);
        _drainIdleToBasket(vaultA, 0.02e8);
        oracle.setPrice(address(wbtcLike), 1e18);
        _exitAll(vaultA, alice); // build carry ≈ $1000

        uint256 opId = registry.operatorOf(address(vaultA));
        uint256 carry = registry.carryOf(alice, opId);

        // Vault B: gain far exceeding carry ⇒ fee on (gain − carry).
        oracle.setPrice(address(wbtcLike), 100_000e18);
        VaultCore vaultB = _createVault(basket);
        _fundBasket(vaultB, 1e8); // alice gain ≈ $50k >> carry
        _exitAll(vaultB, alice);

        assertEq(registry.carryOf(alice, opId), 0, "carry exhausted");
        (uint256 g,, uint256 feesCollected,) = registry.statsOf(opId);
        // Fee should be ~10% of (gain − carry): strictly less than 10% of the summed gains.
        assertLt(feesCollected, g / 10, "carry visibly reduced the fee");
        assertGt(feesCollected, 0);
    }

    function test_carryIsPerOperator_freshIdentityGetsNoOffset() public {
        // Loss under operator 1.
        address[] memory basket = new address[](1);
        basket[0] = address(wbtcLike);
        VaultCore vaultA = _createVault(basket);
        _drainIdleToBasket(vaultA, 0.02e8);
        oracle.setPrice(address(wbtcLike), 1e18);
        _exitAll(vaultA, alice);
        uint256 op1 = registry.operatorOf(address(vaultA));
        assertGt(registry.carryOf(alice, op1), 0);

        // A DIFFERENT operator's vault: alice's op-1 carry gives no fee shelter (CM-4: the
        // mark follows the operator identity; a fresh identity restarts from zero).
        oracle.setPrice(address(wbtcLike), 100_000e18);
        address operator2 = makeAddr("operator2");
        usdc.mint(operator2, 1_000_000 * USDC_1);
        vm.prank(operator2);
        VaultCore vaultC = VaultCore(
            factory.createVault(
                VaultFactory.VaultParams({
                    usdc: address(usdc),
                    basketAssets: basket,
                    oracle: IOracleAggregator(address(oracle)),
                    capacityCapUsdc: 1_000_000_000 * USDC_1,
                    minDepositUsdc: 10 * USDC_1,
                    exitFeeMaxBps: 0,
                    exitFeeDecayPeriod: 0,
                    allowedAdapters: new address[](0)
                })
            )
        );
        uint256 op2 = registry.operatorOf(address(vaultC));
        assertEq(registry.carryOf(alice, op2), 0, "no carry under fresh identity");
        (,,, uint256 vc2) = registry.statsOf(op2);
        assertEq(vc2, 1, "fresh identity starts with zero history +1 new vault");
    }

    // ── leaderboard integrity (SF-4/SF-5) ────────────────────────────────────

    function test_statsAreMonotone_closedVaultHistoryRetained() public {
        address[] memory basket = new address[](1);
        basket[0] = address(wbtcLike);
        VaultCore v = _createVault(basket);
        _fundBasket(v, 1e8);
        uint256 opId = registry.operatorOf(address(v));

        _exitAll(v, alice);
        (uint256 g1, uint256 l1,, uint256 vc1) = registry.statsOf(opId);

        // Operator winds the vault down completely — history must persist (SF-5).
        _exitAll(v, operator);
        assertEq(v.totalShares(), 0, "vault emptied");
        (uint256 g2, uint256 l2,, uint256 vc2) = registry.statsOf(opId);
        assertGe(g2, g1, "gains never restated");
        assertGe(l2, l1, "losses never restated");
        assertEq(vc2, vc1, "vault count never decremented");
    }
}
