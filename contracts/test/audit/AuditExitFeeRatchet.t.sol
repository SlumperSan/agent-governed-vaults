// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {IFeeEngine} from "../../src/interfaces/IFeeEngine.sol";
import {MockERC20, MockOracle, StubGovernance, StubRegistry} from "../mocks/Mocks.sol";

/// @dev Real fee-engine behaviour for the one number that matters here: 10% of realised gain,
/// which is what FeeEngine.onRealize returns with no carryforward and the vault's own clamp
/// (gain / 10) never lowers. StubFeeEngine returns 0, which would flatter the attacker.
contract RatchetPerfFeeEngine is IFeeEngine {
    uint256 public collected;

    function onRealize(address, uint256 gainUsdc, uint256) external pure returns (uint256) {
        return gainUsdc / 10;
    }

    function onFeeCollected(address, uint256 amountUsdc) external {
        collected += amountUsdc;
    }

    function onFeeCollectedAsset(address, address, uint256) external {}
}

/// @notice Exit-fee share-price ratchet (confirmed by forge on protocol/main, 2026-10-18), and the
/// position floor that closes it.
///
/// THE ATTACK. With the Arc launch parameters (exit fee 50 bps, no dead shares, no supply floor) an
/// outsider (A) becomes the first holder of an empty vault, skips the observation window, and
/// burns all but ONE share-wei. A second account (B) then cycles deposit and full exit: B is not
/// the sole holder so it pays the tenure exit fee, which stays in the vault and so accrues to A's
/// single share-wei. NAV rises while totalShares stays 1, so one share-wei becomes worth tens of
/// USDC. A depositor (V) whose deposit or `activate` lands in `[p, 2p)` mints floor(V/p) = 1
/// share-wei and A takes half of the vault on exit: V loses up to a quarter of the deposit
/// (190 USDC victim: 46.59 USDC lost, 15 cycles).
///
/// THE FIX. `_checkPositionFloor` (called from `_settleExit` on the immediate path and from the Mode F
/// queue branch of `requestExit`) reverts `PositionBelowFloor` when the EXITER's remainder is nonzero
/// and below `MIN_POSITION_SHARES` (1e18 share-wei, one share at the 1:1 first mint). It reads the
/// exiter's own remainder, not the pool, and is not repeated at `settleQueuedExit`. The creator gate,
/// the stale-oracle revert and the sub-vault unwind (`child.requestExit` with the parent as the exiter;
/// `allowSubVaults` is false at launch) are separate paths and are not exercised here.
///
/// This file drives the real VaultCore with the Arc launch parameters from
/// `contracts/config/arc-mainnet.json` (capacityCapUsdc 0, minDepositUsdc 100 USDC, exitFeeMaxBps 50,
/// exitFeeDecayPeriod 604800; OBSERVATION_WINDOW is the contract's 4 hours). Empty basket (basket
/// assets only add dust). USDC has 6 decimals.
///
/// All tests are green with the fix. Run against the unfixed contract (with `test_pinsMatchTheContract`,
/// which names `VaultCore.PositionBelowFloor`, removed so the file compiles), seven of the other twelve tests written before the generalised section
/// are red: test_trimToOneWeiIsRefused, test_victimLossIsBoundedAgainstTheOriginalAttack,
/// test_floorBoundaryIsExact, test_noMemberIsTrappedByAnotherMembersDust,
/// test_creatorSoleHolderCannotTrimToDust, test_modeFQueuedTrimIsRefusedAtQueueTime and
/// testFuzz_noExitLeavesADustPosition. The other five (test_soleHolderFullExitIsUnaffected,
/// test_trimToTheFloorThenRatchetIsHarmless, test_modeFQueuedExitsThatClearTheFloorSettle,
/// test_modeFQueuedExitIsNotStrandedByASubFloorTopUp, test_modeFQueuedFullExitIsNotTrappedByADustPeer)
/// pass either way: they pin behaviour that has to hold with the floor in place. `PositionBelowFloor`
/// is matched by selector; `test_pinsMatchTheContract` pins that the local selector and floor are the
/// contract's own.
///
/// The two `testFuzz_` tests at the end (added 2026-10-19) check the headline claim, a depositor's loss
/// of at most one USDC unit, over a band of parameters around the Arc launch values, and the floor over
/// random exit shapes across two holders in both settlement modes. Both are red when the immediate-path
/// floor check is removed, and the exit-shape test is red when only the Mode F queue-time check is.
contract AuditExitFeeRatchet is Test {
    uint256 constant U = 1e6; // 1 USDC in units
    uint256 constant FLOOR = 1e18; // VaultCore.MIN_POSITION_SHARES
    bytes4 constant FLOOR_ERR = bytes4(keccak256("PositionBelowFloor()"));

    MockERC20 usdc;
    MockOracle oracle;
    StubGovernance gov;
    RatchetPerfFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address creator = makeAddr("creator"); // holds no shares: an outsider can be the first depositor
    address A = makeAddr("attackerA"); // the dust holder
    address B = makeAddr("attackerB"); // the cycling account
    address V = makeAddr("victim");

    function setUp() public virtual {
        usdc = new MockERC20("USDC", 6);
        oracle = new MockOracle();
        gov = new StubGovernance();
        fees = new RatchetPerfFeeEngine();
        registry = new StubRegistry();
        vault = _deployVault(100 * U);
        _approveAll(vault);
    }

    /// @dev Overridable so a vault with a different constructor surface (for example the agent-only
    /// vault, which inherits `_settleExit`) can run this whole suite unchanged.
    function _deployVault(uint256 minDeposit) internal virtual returns (VaultCore) {
        return new VaultCore(
            address(usdc),
            new address[](0),
            creator,
            registry,
            gov,
            fees,
            oracle,
            0, // capacityCapUsdc: uncapped, as launched
            minDeposit,
            50, // exitFeeMaxBps: Arc launch value
            604800, // exitFeeDecayPeriod: Arc launch value
            new address[](0),
            address(0)
        );
    }

    function _approveAll(VaultCore v) internal {
        address[4] memory who = [A, B, V, creator];
        for (uint256 i; i < 4; ++i) {
            vm.prank(who[i]);
            usdc.approve(address(v), type(uint256).max);
        }
    }

    // price of one share-wei, in WAD (only meaningful while totalShares is tiny)
    function _p() internal view returns (uint256) {
        return vault.navWad() / vault.totalShares();
    }

    function _exitAll(address who) internal {
        uint256 n = vault.sharesOf(who);
        vm.prank(who);
        vault.requestExit(n);
    }

    function _cycleB(uint256 d) internal {
        vm.startPrank(B);
        vault.deposit(d);
        vault.requestExit(vault.sharesOf(B)); // same block: tenure 0, full 50 bps fee
        vm.stopPrank();
    }

    /// Attacker step 1 (A): deposit, skip the window, burn down to `keep` share-wei.
    function _aOpens(uint256 aSeed) internal {
        usdc.mint(A, aSeed);
        vm.startPrank(A);
        vault.deposit(aSeed);
        vault.skipWindow(); // pending deposit activates immediately; irreversible, open to anyone
        vm.stopPrank();
    }

    /// Attacker step 2 (B): cycle deposit + full exit until one share-wei is worth more than half
    /// of `victim`, but never more than `victim` (above that the victim activation reverts and the
    /// attack degrades to a refundable DoS). Only meaningful while totalShares is 1.
    function _ratchetToOneWei(uint256 victim, uint256 bCapital, uint256 minDep)
        internal
        returns (uint256 cycles)
    {
        vm.startPrank(B);
        vault.deposit(bCapital);
        vault.skipWindow();
        vault.requestExit(vault.sharesOf(B));
        vm.stopPrank();
        uint256[6] memory sizes = [uint256(5000 * U), 2000 * U, 1000 * U, 500 * U, 250 * U, 100 * U];
        uint256 vWad = victim * 1e12;
        while (_p() * 2 <= vWad && cycles < 400) {
            uint256 pOld = _p();
            bool done;
            for (uint256 i; i < sizes.length && !done; ++i) {
                uint256 d = sizes[i];
                uint256 bal = usdc.balanceOf(B);
                if (d > bal) d = bal;
                if (d < minDep || d * 1e12 < pOld) continue;
                uint256 snap = vm.snapshotState();
                _cycleB(d);
                if (_p() <= vWad && _p() > pOld) {
                    vm.deleteStateSnapshot(snap);
                    done = true;
                } else {
                    vm.revertToState(snap);
                }
            }
            if (!done) break;
            ++cycles;
        }
    }

    // ───────────────────────── the attack, and its refusal ─────────────────────────

    /// The local copies of the error selector and the floor are the contract's own.
    function test_pinsMatchTheContract() public view {
        assertEq(FLOOR_ERR, VaultCore.PositionBelowFloor.selector, "selector pin");
        assertEq(vault.MIN_POSITION_SHARES(), FLOOR, "floor constant");
    }

    /// The first step of the attack: A burns all but one share-wei. It must be refused, and the
    /// error must be the real `PositionBelowFloor`. Red on the unfixed contract (the trim lands).
    function test_trimToOneWeiIsRefused() public {
        _aOpens(100 * U);
        uint256 ts = vault.totalShares();
        vm.prank(A);
        vm.expectRevert(FLOOR_ERR);
        vault.requestExit(ts - 1);
        assertEq(vault.totalShares(), ts, "nothing burned");
    }

    /// The best the attacker can still do against a victim whose first deposit is pending: try
    /// the trim to one share-wei; if it lands, ratchet (the original attack); if it is refused,
    /// cycle B against whatever supply there is. The victim, activated afterwards, must lose at
    /// most one USDC unit. Red on the unfixed contract: the trim lands and the victim loses 46.59
    /// USDC (24.5 percent) of 190.
    function test_victimLossIsBoundedAgainstTheOriginalAttack() public {
        uint256 victim = 190 * U;
        usdc.mint(B, 1000 * U);
        usdc.mint(V, victim);
        vm.prank(V);
        vault.deposit(victim); // first-time deposit: pending, no shares, excluded from NAV
        assertEq(vault.totalShares(), 0, "vault empty while victim pends");

        _aOpens(100 * U);
        bool trimmed;
        uint256 ts = vault.totalShares();
        vm.prank(A);
        try vault.requestExit(ts - 1) {
            trimmed = true;
        } catch {}

        if (trimmed) {
            _ratchetToOneWei(victim, 1000 * U, 100 * U);
        } else {
            for (uint256 i; i < 16; ++i) {
                vm.startPrank(B);
                if (i == 0) {
                    vault.deposit(1000 * U);
                    vault.skipWindow();
                } else {
                    vault.deposit(usdc.balanceOf(B));
                }
                vault.requestExit(vault.sharesOf(B));
                vm.stopPrank();
            }
        }
        skip(4 hours);
        vault.activate(V); // permissionless, no slippage argument
        _exitAll(A);
        _exitAll(V);
        uint256 vb = usdc.balanceOf(V);
        uint256 loss = victim > vb ? victim - vb : 0;
        console2.log("victim loss (units):", loss, "trim landed:", trimmed);
        assertFalse(trimmed, "the one-wei trim must be refused");
        assertLe(loss, 1, "victim loses at most one USDC unit");
    }

    /// A strong attack the floor still allows: trim to exactly the floor (1e18 share-wei, about
    /// 1 USDC of NAV), then cycle B 100 times with 1000 USDC. The victim's `activate` is the
    /// pending-activation path of the brief. Loss stays at the rounding unit and the victim mints
    /// a large number of share-wei, not one.
    function test_trimToTheFloorThenRatchetIsHarmless() public {
        uint256 victim = 190 * U;
        usdc.mint(B, 1000 * U);
        usdc.mint(V, victim);
        vm.prank(V);
        vault.deposit(victim);
        _aOpens(100 * U);
        uint256 ts = vault.totalShares();
        vm.prank(A);
        vault.requestExit(ts - FLOOR);
        assertEq(vault.totalShares(), FLOOR, "A sits exactly on the floor");
        for (uint256 i; i < 100; ++i) {
            vm.startPrank(B);
            if (i == 0) {
                vault.deposit(1000 * U);
                vault.skipWindow();
            } else {
                vault.deposit(usdc.balanceOf(B));
            }
            vault.requestExit(vault.sharesOf(B));
            vm.stopPrank();
        }
        skip(4 hours);
        vault.activate(V);
        uint256 sharesV = vault.sharesOf(V);
        // pro-rata value of the victim stake (exit fee excluded: it is not the ratchet)
        uint256 vb = vault.navWad() * sharesV / vault.totalShares() / 1e12;
        uint256 loss = victim > vb ? victim - vb : 0;
        console2.log("floor-trim: victim shares:", sharesV);
        console2.log("floor-trim: victim loss (units):", loss);
        assertGt(sharesV, 1e15, "victim minted a real number of share-wei, not one");
        assertLe(loss, 1, "victim loses at most one unit");

        // The victim's position (about half a share) is itself below the floor, and A sits on it.
        // Both exits leave a remainder of 0, so the floor check passes for each, in either order.
        assertLt(sharesV, FLOOR, "the victim's position is below the floor");
        uint256 snap = vm.snapshotState();
        _exitAll(A); // A first: V's sub-floor position stays behind, and A is not blocked by it
        assertEq(vault.totalShares(), sharesV, "only the victim's dust position remains");
        vm.revertToState(snap);
        _exitAll(V);
        _exitAll(A);
        assertEq(vault.totalShares(), 0, "both left in full");
    }

    // ───────────────────────── boundaries of the floor ─────────────────────────

    /// Burn leaving exactly FLOOR succeeds; one wei less is refused; a burn leaving 1 is refused.
    function test_floorBoundaryIsExact() public {
        _aOpens(100 * U); // 100e18 share-wei
        uint256 ts = vault.totalShares();
        assertEq(ts, 100e18);

        vm.startPrank(A);
        vm.expectRevert(FLOOR_ERR);
        vault.requestExit(ts - (FLOOR - 1)); // leaves FLOOR - 1
        vm.expectRevert(FLOOR_ERR);
        vault.requestExit(ts - 1); // leaves 1
        vault.requestExit(ts - FLOOR); // leaves exactly FLOOR: allowed
        vm.stopPrank();
        assertEq(vault.sharesOf(A), FLOOR);

        // a partial burn of the position that sits on the floor leaves a remainder below it
        vm.startPrank(A);
        vm.expectRevert(FLOOR_ERR);
        vault.requestExit(1);
        vault.requestExit(FLOOR);
        vm.stopPrank();
        assertEq(vault.totalShares(), 0, "sole holder exited in full");
        assertEq(vault.sharesOf(A), 0);
    }

    /// A sole holder's full exit is not refused by the floor, and the sole-holder fee waiver is untouched.
    function test_soleHolderFullExitIsUnaffected() public {
        _aOpens(100 * U);
        _exitAll(A);
        assertEq(usdc.balanceOf(A), 100 * U, "no exit fee, no loss");
        assertEq(vault.totalShares(), 0);
    }

    /// The floor check reads the exiter's own remainder, not the pool.
    /// Min deposit 1 unit lets a position below the floor exist: B holds 1e12 share-wei next to a
    /// large holder A. A exits in full (the pool is left at B's dust); B exits in full. A burn that
    /// would leave a nonzero remainder below the floor reverts `PositionBelowFloor`.
    function test_noMemberIsTrappedByAnotherMembersDust() public {
        VaultCore v = _deployVault(1);
        _approveAll(v);
        usdc.mint(A, 1000 * U);
        usdc.mint(B, 1);
        vm.startPrank(A);
        v.deposit(1000 * U);
        v.skipWindow();
        vm.stopPrank();
        vm.startPrank(B);
        v.deposit(1); // 1 unit into a 1000 USDC vault mints 1e12 share-wei: a position below the floor
        v.skipWindow();
        vm.stopPrank();
        uint256 dust = v.sharesOf(B);
        assertGt(dust, 0);
        assertLt(dust, FLOOR, "B holds a sub-floor position");

        // a partial burn of B's sub-floor position reverts; a full burn passes
        vm.startPrank(B);
        if (dust > 1) {
            vm.expectRevert(FLOOR_ERR);
            v.requestExit(1);
        }
        vm.stopPrank();

        // A, the large holder, exits in full although B's dust stays behind
        uint256 aShares = v.sharesOf(A);
        vm.prank(A);
        v.requestExit(aShares);
        assertEq(v.sharesOf(A), 0, "full exit passes the floor check with a dust peer");
        assertEq(v.totalShares(), dust);

        // and the dust holder, now sole holder, leaves in full
        vm.prank(B);
        v.requestExit(dust);
        assertEq(v.totalShares(), 0);
    }

    /// A vault whose creator is the only holder: a creator burn that leaves a nonzero remainder below
    /// the floor reverts `PositionBelowFloor`.
    function test_creatorSoleHolderCannotTrimToDust() public {
        usdc.mint(creator, 100 * U);
        vm.startPrank(creator);
        vault.deposit(100 * U);
        vault.skipWindow();
        uint256 ts = vault.totalShares();
        vm.expectRevert(FLOOR_ERR);
        vault.requestExit(ts - 1);
        vault.requestExit(ts - FLOOR);
        vault.requestExit(FLOOR); // full exit still available
        vm.stopPrank();
        assertEq(vault.totalShares(), 0);
    }

    // ───────────────────────── Mode F (queued exits) ─────────────────────────

    /// A trim queued while an execution is pending is refused at QUEUE time (like the creator gate,
    /// L-1): a refused queue leaves nothing queued, so there is no queued exit left to revert at settle.
    /// Red on the unfixed contract (the queue lands and the settle burns to one share-wei).
    function test_modeFQueuedTrimIsRefusedAtQueueTime() public {
        _aOpens(100 * U);
        gov.setPendingExecution(true);
        uint256 ts = vault.totalShares();
        vm.prank(A);
        vm.expectRevert(FLOOR_ERR);
        vault.requestExit(ts - 1);
        assertEq(vault.queuedExitShares(A), 0, "nothing queued");
    }

    /// A queued exit that clears the floor at queue time settles: an exit leaving exactly the floor,
    /// then a full exit.
    function test_modeFQueuedExitsThatClearTheFloorSettle() public {
        _aOpens(100 * U);
        gov.setPendingExecution(true);
        uint256 ts = vault.totalShares();
        vm.prank(A);
        vault.requestExit(ts - FLOOR);
        assertEq(vault.queuedExitShares(A), ts - FLOOR);
        gov.setPendingExecution(false);
        vault.settleQueuedExit(A);
        assertEq(vault.sharesOf(A), FLOOR);

        gov.setPendingExecution(true);
        vm.prank(A);
        vault.requestExit(FLOOR); // full
        gov.setPendingExecution(false);
        vault.settleQueuedExit(A);
        assertEq(vault.totalShares(), 0);
    }

    /// A queued exit is irrevocable, so the floor is checked when it is queued and NOT again at
    /// settlement: a full exit queued (remainder 0) and then a top-up that mints a sub-floor balance
    /// (min deposit 1 unit into a 1000 USDC vault mints 1e12 share-wei) must still settle, leaving the
    /// top-up behind. Red if `settleQueuedExit` re-checks the floor (the strand this test pins).
    function test_modeFQueuedExitIsNotStrandedByASubFloorTopUp() public {
        VaultCore v = _deployVault(1);
        _approveAll(v);
        usdc.mint(A, 1000 * U + 1);
        vm.startPrank(A);
        v.deposit(1000 * U);
        v.skipWindow();
        uint256 all = v.sharesOf(A);
        gov.setPendingExecution(true);
        v.requestExit(all); // remainder 0: clears the floor at queue time
        v.deposit(1); // window cleared: immediate mint of a sub-floor balance
        vm.stopPrank();
        uint256 topUp = v.sharesOf(A) - all;
        assertGt(topUp, 0);
        assertLt(topUp, FLOOR);
        gov.setPendingExecution(false);
        v.settleQueuedExit(A); // must not revert PositionBelowFloor
        assertEq(v.sharesOf(A), topUp, "the queued shares left, the top-up stayed");
        vm.prank(A);
        v.requestExit(topUp); // and the dust position can still leave in full
        assertEq(v.totalShares(), 0);
    }

    /// The same in Mode F: a large holder queues a FULL exit (remainder 0) while a dust peer (a position
    /// below the floor) remains, and it settles. Pins that the queue-time check reads the exiter's own
    /// remainder, not the pool's.
    function test_modeFQueuedFullExitIsNotTrappedByADustPeer() public {
        VaultCore v = _deployVault(1);
        _approveAll(v);
        usdc.mint(A, 1000 * U);
        usdc.mint(B, 1);
        vm.startPrank(A);
        v.deposit(1000 * U);
        v.skipWindow();
        vm.stopPrank();
        vm.startPrank(B);
        v.deposit(1);
        v.skipWindow();
        vm.stopPrank();
        uint256 dust = v.sharesOf(B);
        assertLt(dust, FLOOR);
        uint256 aShares = v.sharesOf(A);

        gov.setPendingExecution(true);
        vm.prank(A);
        v.requestExit(aShares); // queues: A's own remainder is 0
        gov.setPendingExecution(false);
        v.settleQueuedExit(A);
        assertEq(v.sharesOf(A), 0);
        assertEq(v.totalShares(), dust);
    }

    // ───────────────── fuzz: remainder of an immediate exit is 0, at least the floor, or reverts ─────────────────

    /// For every burn size of an immediate (Mode I) exit: it either lands with the exiter at 0 or at least
    /// the floor, or reverts with `PositionBelowFloor` and the remainder it would have left was in (0, floor).
    function testFuzz_noExitLeavesADustPosition(uint256 burn) public {
        _aOpens(100 * U);
        uint256 held = vault.sharesOf(A);
        burn = bound(burn, 1, held);
        uint256 left = held - burn;
        vm.prank(A);
        try vault.requestExit(burn) {
            assertTrue(left == 0 || left >= FLOOR, "a dust position survived an exit");
            assertEq(vault.sharesOf(A), left);
        } catch (bytes memory err) {
            assertEq(bytes4(err), FLOOR_ERR, "the revert is the floor's");
            assertTrue(left > 0 && left < FLOOR, "refused although the remainder was fine");
            assertEq(vault.sharesOf(A), held);
        }
    }

    // ───────────────── the headline claim, generalised ─────────────────
    //
    // The tests above pin the mechanism at one parameter set (190 USDC victim, 1000 USDC cycles, 16 or
    // 100 rounds, minimum deposit 100 USDC). The two fuzz tests below check the claim itself over a band
    // around the real Arc parameters (minimum deposit 100 USDC, exit fee 50 bps, window 4 hours):
    //   minimum deposit 10 to 1000 USDC; victim from the minimum deposit to 20,000 USDC; A's seed from the
    //   minimum deposit to 5,000 USDC; B's capital from the minimum deposit to 20,000 USDC; 1 to 40 ratchet
    //   cycles. Victim loss is measured pro rata, before any exit, so the exit fee that A pays on the way
    //   out cannot mask it. The bounds are a generous band, not a proof for every parameter; they are not
    //   to be narrowed to make a failure pass.

    /// A's best allowed trim, then B's ratchet, against a victim whose deposit is pending. A first tries
    /// to trim to a fuzzed remainder (1 share-wei, one below the floor, the floor, or above it); a refused
    /// trim falls back to exactly the floor, the strongest position the floor allows. Whatever lands, the
    /// victim, activated afterwards, loses at most one USDC unit, and no trim below the floor lands.
    function testFuzz_victimLossIsBoundedAcrossParameters(
        uint256 minDepRaw,
        uint256 victimRaw,
        uint256 aSeedRaw,
        uint256 bCapRaw,
        uint256 cyclesRaw,
        uint256 keepRaw
    ) public {
        uint256 minDep = bound(minDepRaw, 10 * U, 1000 * U);
        uint256 victim = bound(victimRaw, minDep, 20_000 * U);
        uint256 aSeed = bound(aSeedRaw, minDep, 5_000 * U);
        uint256 bCap = bound(bCapRaw, minDep, 20_000 * U);
        uint256 cycles = bound(cyclesRaw, 1, 40);
        vault = _deployVault(minDep);
        _approveAll(vault);
        usdc.mint(B, bCap);
        usdc.mint(V, victim);
        vm.prank(V);
        vault.deposit(victim); // first-time deposit: pending, no shares
        assertEq(vault.totalShares(), 0, "vault empty while the victim pends");

        _aOpens(aSeed);
        uint256 ts = vault.totalShares();
        uint256 kind = keepRaw % 4;
        uint256 keep =
            kind == 0 ? 1 : kind == 1 ? FLOOR - 1 : kind == 2 ? FLOOR : FLOOR + (keepRaw / 4) % (5 * FLOOR);
        assertLt(keep, ts, "the seed is always larger than the trim target");
        bool trimmedBelowFloor;
        vm.prank(A);
        try vault.requestExit(ts - keep) {
            trimmedBelowFloor = keep < FLOOR;
        } catch {
            // refused: fall back to the strongest position the floor allows
            vm.prank(A);
            vault.requestExit(ts - FLOOR);
        }

        if (trimmedBelowFloor) {
            _ratchetToOneWei(victim, bCap, minDep);
        } else {
            for (uint256 i; i < cycles; ++i) {
                uint256 bal = usdc.balanceOf(B);
                if (bal < minDep) break;
                vm.startPrank(B);
                if (i == 0) {
                    vault.deposit(bCap);
                    vault.skipWindow();
                } else {
                    vault.deposit(bal);
                }
                vault.requestExit(vault.sharesOf(B));
                vm.stopPrank();
            }
        }
        skip(4 hours);
        vault.activate(V); // permissionless, no slippage argument

        uint256 sharesV = vault.sharesOf(V);
        uint256 worth = vault.navWad() * sharesV / vault.totalShares() / 1e12;
        uint256 loss = victim > worth ? victim - worth : 0;
        assertLe(loss, 1, "victim loses at most one USDC unit");
        assertFalse(trimmedBelowFloor, "a trim below the floor must be refused");

        // and the exits themselves: neither is blocked, and the victim, now the sole holder, is paid in full
        _exitAll(A);
        _exitAll(V);
        uint256 vb = usdc.balanceOf(V);
        assertLe(victim > vb ? victim - vb : 0, 1, "victim's realised loss is at most one USDC unit");
    }

    /// The exit shape, across two holders and both settlement modes: six exits by A or B, each in Mode I or
    /// queued in Mode F, of fuzzed size (full, leaving the floor, one above it, one share-wei, or any
    /// size). Every exit either lands leaving its exiter at zero or at least the floor, or reverts
    /// `PositionBelowFloor` when it would have left a remainder in (0, floor). A queued exit settles
    /// whatever else happened, and once every queue has settled each holder can still leave in full, so
    /// neither is trapped by the other's position.
    function testFuzz_noExitShapeLeavesADustPosition(
        uint256 minDepRaw,
        uint256 aRaw,
        uint256 bRaw,
        uint256[6] memory steps
    ) public {
        uint256 minDep = bound(minDepRaw, 10 * U, 1000 * U);
        vault = _deployVault(minDep);
        _approveAll(vault);
        usdc.mint(A, bound(aRaw, minDep, 50_000 * U));
        usdc.mint(B, bound(bRaw, minDep, 50_000 * U));
        uint256 aAmt = usdc.balanceOf(A);
        uint256 bAmt = usdc.balanceOf(B);
        vm.startPrank(A);
        vault.deposit(aAmt);
        vault.skipWindow(); // a first-time deposit is pending until the member skips the window
        vm.stopPrank();
        vm.startPrank(B);
        vault.deposit(bAmt);
        vault.skipWindow();
        vm.stopPrank();

        for (uint256 i; i < steps.length; ++i) {
            address who = steps[i] & 1 == 0 ? A : B;
            bool queued = (steps[i] >> 1) & 1 == 1;
            gov.setPendingExecution(queued);
            uint256 held = vault.sharesOf(who);
            if (held == 0 || vault.queuedExitShares(who) != 0) continue;
            uint256 burn = _pickBurn(held, steps[i] >> 2);
            uint256 left = held - burn;
            vm.prank(who);
            try vault.requestExit(burn) {
                assertTrue(left == 0 || left >= FLOOR, "a dust position survived an exit");
                if (queued) {
                    assertEq(vault.queuedExitShares(who), burn, "queued in full");
                    assertEq(vault.sharesOf(who), held, "queued shares stay outstanding");
                } else {
                    assertEq(vault.sharesOf(who), left, "burned in full");
                }
            } catch (bytes memory err) {
                assertEq(bytes4(err), FLOOR_ERR, "the revert is the floor's");
                assertTrue(left > 0 && left < FLOOR, "refused although the remainder was fine");
                assertEq(vault.sharesOf(who), held, "nothing burned");
                assertEq(vault.queuedExitShares(who), 0, "nothing queued");
            }
            _assertNoDustPositions();
        }

        // every queued exit settles, floor or not
        gov.setPendingExecution(false);
        address[2] memory holders = [A, B];
        for (uint256 i; i < 2; ++i) {
            if (vault.queuedExitShares(holders[i]) != 0) vault.settleQueuedExit(holders[i]);
        }
        _assertNoDustPositions();

        // and nobody is trapped: each holder can leave in full, in either order
        for (uint256 i; i < 2; ++i) {
            uint256 left = vault.sharesOf(holders[i]);
            if (left == 0) continue;
            vm.prank(holders[i]);
            vault.requestExit(left);
        }
        assertEq(vault.totalShares(), 0, "both left in full");
    }

    function _assertNoDustPositions() internal view {
        address[2] memory holders = [A, B];
        for (uint256 i; i < 2; ++i) {
            // a queued exit's shares are still outstanding, and its remainder was floor-checked at queue time
            uint256 effective = vault.sharesOf(holders[i]) - vault.queuedExitShares(holders[i]);
            assertTrue(effective == 0 || effective >= FLOOR, "a dust position exists");
        }
    }

    /// Burn sizes that sit on and around the boundary, plus a uniform draw.
    function _pickBurn(uint256 held, uint256 seed) internal pure returns (uint256) {
        uint256 kind = seed % 5;
        if (kind == 0) return held;
        if (kind == 1) return held > FLOOR ? held - FLOOR : held;
        if (kind == 2) return held > FLOOR ? held - FLOOR + 1 : held;
        if (kind == 3) return held > 1 ? held - 1 : held;
        return 1 + (seed / 5) % held;
    }
}
