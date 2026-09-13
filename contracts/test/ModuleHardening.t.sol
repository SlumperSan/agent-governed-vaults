// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {
    MockERC20,
    MockOracle,
    StubGovernance,
    StubFeeEngine,
    StubRegistry,
    RevertingGovernance,
    RevertingFeeEngine,
    RevertingRegistry,
    MalformedReturnToken
} from "./mocks/Mocks.sol";

/// Regression suite for security review findings H-1, H-2, M-1, M-2
/// (docs/reviews/SPRINT1-SECURITY-REVIEW.md): hostile or broken creator-chosen modules and
/// misbehaving basket tokens must never block member exits; the perf fee must reach the
/// engine even when the payout is almost entirely in-kind.
contract ModuleHardeningTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockOracle oracle;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
    }

    function _newVault(address gov, address fees, address registry, address[] memory basket)
        internal
        returns (VaultCore v)
    {
        v = new VaultCore(
            address(usdc),
            basket,
            creator,
            IOperatorRegistry(registry),
            IGovernance(gov),
            IFeeEngine(fees),
            oracle,
            1_000_000_000 * USDC_1,
            10 * USDC_1,
            0, // no exit fee — isolate module behavior
            0,
            new address[](0),
            address(0)
        );
        address[2] memory who = [creator, alice];
        for (uint256 i; i < 2; ++i) {
            usdc.mint(who[i], 1_000_000 * USDC_1);
            vm.startPrank(who[i]);
            usdc.approve(address(v), type(uint256).max);
            v.deposit(1_000 * USDC_1);
            v.skipWindow();
            vm.stopPrank();
        }
    }

    // ── H-1: hostile modules can never block exits ───────────────────────────

    function test_h1_revertingFeeEngineAndRegistry_exitStillSettles() public {
        VaultCore v = _newVault(
            address(new StubGovernance()),
            address(new RevertingFeeEngine()),
            address(new RevertingRegistry()),
            new address[](0)
        );

        uint256 bal = usdc.balanceOf(alice);
        uint256 shares = v.sharesOf(alice);
        vm.prank(alice);
        v.requestExit(shares); // must NOT revert
        assertEq(usdc.balanceOf(alice) - bal, 1_000 * USDC_1, "full payout, zero fee fallback");
    }

    function test_h1_revertingGovernance_fallsBackToModeI() public {
        VaultCore v = _newVault(
            address(new RevertingGovernance()),
            address(new StubFeeEngine()),
            address(new StubRegistry()),
            new address[](0)
        );

        uint256 bal = usdc.balanceOf(alice);
        uint256 shares = v.sharesOf(alice);
        vm.prank(alice);
        v.requestExit(shares); // documented fallback: instant Mode-I settlement
        assertEq(usdc.balanceOf(alice) - bal, 1_000 * USDC_1, "Mode I fallback, no lockup");
    }

    function test_h1_moduleFailureEmitsEvent() public {
        VaultCore v = _newVault(
            address(new StubGovernance()),
            address(new RevertingFeeEngine()),
            address(new RevertingRegistry()),
            new address[](0)
        );
        uint256 shares = v.sharesOf(alice);
        vm.expectEmit(true, true, false, false);
        emit VaultCore.ModuleCallFailed("feeEngine.onRealize", alice);
        vm.prank(alice);
        v.requestExit(shares);
    }

    // ── H-2: malformed-returndata basket token degrades to escrow ────────────

    function test_h2_malformedReturnTokenEscrows_exitCompletes() public {
        MalformedReturnToken bad = new MalformedReturnToken();
        oracle.setPrice(address(bad), 1e18);
        address[] memory basket = new address[](1);
        basket[0] = address(bad);

        VaultCore v = _newVault(
            address(new StubGovernance()), address(new StubFeeEngine()), address(new StubRegistry()), basket
        );
        // Simulate held position of the malformed token.
        bad.mint(address(v), 100e18);
        stdstore.target(address(v)).sig("assetBalance(address)").with_key(address(bad))
            .checked_write(uint256(100e18));
        assertEq(v.assetBalance(address(bad)), 100e18, "slot guard");

        uint256 bal = usdc.balanceOf(alice);
        uint256 shares = v.sharesOf(alice);
        vm.prank(alice);
        v.requestExit(shares); // must NOT revert despite 1-byte returndata

        assertGt(usdc.balanceOf(alice) - bal, 0, "cash leg delivered");
        assertEq(v.claimable(alice, address(bad)), 50e18, "malformed token escrowed");
    }

    // ── M-2: fee collected from in-kind leg on a fully invested vault ────────

    function test_m2_fullyInvestedVault_feeStillCollected() public {
        MockERC20 wbtc = new MockERC20("wBTC", 8);
        oracle.setPrice(address(wbtc), 100_000e18);
        address[] memory basket = new address[](1);
        basket[0] = address(wbtc);

        StubFeeEngine fees = new StubFeeEngine();
        VaultCore v =
            _newVault(address(new StubGovernance()), address(fees), address(new StubRegistry()), basket);

        // Fully invested: ALL idle converted to wBTC which then appreciated.
        stdstore.target(address(v)).sig("idleUsdc()").checked_write(uint256(0));
        assertEq(v.idleUsdc(), 0, "slot guard");
        wbtc.mint(address(v), 1e8);
        stdstore.target(address(v)).sig("assetBalance(address)").with_key(address(wbtc))
            .checked_write(uint256(1e8));
        assertEq(v.assetBalance(address(wbtc)), 1e8, "slot guard");

        fees.setFeeToCharge(type(uint256).max); // engine asks max; clamp gives 10% of gain

        uint256 shares = v.sharesOf(alice);
        vm.prank(alice);
        v.requestExit(shares);

        // Alice's payout is 100% in-kind (~$50k of wBTC, gain ~$49k). Pre-fix the fee was
        // clamped to the cash leg (= 0). Now ~10% of the wBTC leg goes to the engine.
        uint256 engineWbtc = wbtc.balanceOf(address(fees));
        assertGt(engineWbtc, 0, "in-kind fee collected");
        assertApproxEqRel(engineWbtc, 0.049e8, 0.05e18, "~10% of gain, in kind");
        assertEq(fees.lastAssetCollected(), engineWbtc, "engine notified of asset fee");
        // Member got the rest.
        assertApproxEqRel(wbtc.balanceOf(alice), 0.451e8, 0.05e18, "member slice net of fee");
    }
}
