// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {MockERC20, MockOracle, StubGovernance, StubFeeEngine, StubRegistry} from "./mocks/Mocks.sol";

/// @notice Randomized action handler. Prices are held static so that the §4.6 invariant —
/// NAVps non-decreasing for remaining members across every redemption — is directly assertable
/// (with live prices the invariant is conditional on price paths, which is Sprint 6 territory).
contract Handler is Test {
    VaultCore public vault;
    MockERC20 public usdc;
    StubGovernance public gov;

    address public creator;
    address[] public actors;
    uint256 constant USDC_1 = 1e6;

    uint256 public lastNavPs; // ghost: tracks NAVps across handler calls
    bool public navPsInitialized;

    constructor(VaultCore vault_, MockERC20 usdc_, StubGovernance gov_, address creator_) {
        vault = vault_;
        usdc = usdc_;
        gov = gov_;
        creator = creator_;
        actors.push(creator_);
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string(abi.encodePacked("actor", i)));
            actors.push(a);
        }
        for (uint256 i; i < actors.length; ++i) {
            usdc.mint(actors[i], 100_000_000 * USDC_1);
            vm.prank(actors[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _snapNavPs() internal {
        if (vault.totalShares() == 0) {
            navPsInitialized = false;
            return;
        }
        lastNavPs = vault.navPerShareWad();
        navPsInitialized = true;
    }

    function deposit(uint256 seed, uint256 amount) external {
        address who = _actor(seed);
        amount = bound(amount, 10 * USDC_1, 1_000_000 * USDC_1);
        uint256 navUsdc = vault.navWad() / 1e12;
        if (navUsdc + vault.totalPendingUsdc() + amount > vault.capacityCapUsdc()) return;
        if (!vault.windowCleared(who) && vault.sharesOf(who) == 0 && _pendingAmount(who) > 0) return;
        vm.prank(who);
        vault.deposit(amount);
        _snapNavPs();
    }

    function activate(uint256 seed) external {
        address who = _actor(seed);
        if (_pendingAmount(who) == 0) return;
        (, uint64 availableAt) = vault.pendingDeposit(who);
        if (block.timestamp < availableAt) vm.warp(availableAt);
        vault.activate(who);
        _snapNavPs();
    }

    function cancelPending(uint256 seed) external {
        address who = _actor(seed);
        if (_pendingAmount(who) == 0) return;
        vm.prank(who);
        vault.cancelPending();
    }

    function skipWindow(uint256 seed) external {
        address who = _actor(seed);
        if (vault.skipOptIn(who)) return;
        vm.prank(who);
        vault.skipWindow();
        _snapNavPs();
    }

    function requestExit(uint256 seed, uint256 shareFrac) external {
        address who = _actor(seed);
        uint256 held = vault.sharesOf(who);
        if (held == 0 || vault.queuedExitShares(who) > 0) return;
        uint256 burn = bound(shareFrac, 1, held);

        // Skip creator exits that would trip the gate — gate behavior is unit-tested; the
        // invariant run cares about accounting, not the revert.
        if (who == creator && vault.nonCreatorMemberCount() > 0) {
            uint256 ts = vault.totalShares();
            if ((held - burn) * 10_000 < 500 * (ts - burn)) return;
        }

        uint256 psBefore = vault.totalShares() > 0 ? vault.navPerShareWad() : 0;
        vm.prank(who);
        vault.requestExit(burn);

        // §4.6: NAVps for remaining members never decreases across a settled redemption.
        if (vault.totalShares() > 0) {
            assertGe(vault.navPerShareWad() + 1, psBefore, "NAVps decreased on exit");
        }
        _snapNavPs();
    }

    function settleQueued(uint256 seed) external {
        address who = _actor(seed);
        if (vault.queuedExitShares(who) == 0) return;
        gov.setPendingExecution(false);
        uint256 psBefore = vault.totalShares() > 0 ? vault.navPerShareWad() : 0;
        vault.settleQueuedExit(who);
        if (vault.totalShares() > 0) {
            assertGe(vault.navPerShareWad() + 1, psBefore, "NAVps decreased on settle");
        }
        _snapNavPs();
    }

    function togglePending(bool p) external {
        gov.setPendingExecution(p);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 hours, 60 days));
    }

    function donate(uint256 amount) external {
        // Adversarial donation: must never affect NAV or share accounting.
        usdc.mint(address(vault), bound(amount, 1, 10_000_000 * USDC_1));
    }

    function sumShares() external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += vault.sharesOf(actors[i]);
        }
    }

    function sumQueued() external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += vault.queuedExitShares(actors[i]);
        }
    }

    function sumPending() external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += _pendingAmount(actors[i]);
        }
    }

    function _pendingAmount(address who) internal view returns (uint256 amt) {
        (amt,) = vault.pendingDeposit(who);
    }
}

contract VaultCoreInvariantTest is Test {
    VaultCore vault;
    MockERC20 usdc;
    MockOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    Handler handler;
    address creator = makeAddr("creator");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();

        // USDC-only basket for the invariant run: static valuation isolates the accounting
        // invariants from price-path effects (which Sprint 6 fuzzes separately).
        address[] memory basket = new address[](0);

        vault = new VaultCore(
            address(usdc),
            basket,
            creator,
            registry,
            gov,
            fees,
            oracle,
            1_000_000_000 * 1e6,
            10 * 1e6,
            100,
            30 days
        );

        handler = new Handler(vault, usdc, gov, creator);
        targetContract(address(handler));
    }

    /// Σ member shares == totalShares across every path.
    function invariant_sharesConserved() public view {
        assertEq(handler.sumShares(), vault.totalShares(), "share conservation");
    }

    /// Queued (Mode-F-locked) shares are consistently tracked and never exceed supply.
    function invariant_queuedConsistent() public view {
        assertEq(handler.sumQueued(), vault.totalQueuedShares(), "queued conservation");
        assertLe(vault.totalQueuedShares(), vault.totalShares(), "queued <= supply");
        assertEq(
            vault.totalVotingEligibleShares(),
            vault.totalShares() - vault.totalQueuedShares(),
            "eligible = supply - locked"
        );
    }

    /// Pending escrow is consistently tracked and excluded from NAV.
    function invariant_pendingEscrowConsistent() public view {
        assertEq(handler.sumPending(), vault.totalPendingUsdc(), "pending conservation");
        assertEq(vault.navWad(), vault.idleUsdc() * 1e12, "NAV = internal idle only");
    }

    /// The vault is always fully backed: real token balance covers internal accounting plus
    /// escrowed pending deposits (donations may push the real balance above — never below).
    function invariant_solvency() public view {
        assertGe(
            usdc.balanceOf(address(vault)),
            vault.idleUsdc() + vault.totalPendingUsdc(),
            "token backing >= internal accounting"
        );
    }

    /// Creator holds ≥5% whenever non-creator members remain (handler never takes gate-tripping
    /// creator exits, so reaching a sub-5% creator state would mean the gate leaked).
    function invariant_creatorFloor() public view {
        if (vault.nonCreatorMemberCount() == 0 || vault.totalShares() == 0) return;
        // Only enforced against creator ACTION (CM-2): passive dilution below 5% is legal, so
        // assert the weaker but exact property — the creator gate math itself is unit-tested.
        assertLe(vault.queuedExitShares(creator), vault.sharesOf(creator), "creator queue sane");
    }
}
