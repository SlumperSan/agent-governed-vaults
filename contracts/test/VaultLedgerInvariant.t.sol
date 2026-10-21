// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {IExecutionAdapter} from "../src/interfaces/IExecutionAdapter.sol";
import {MockERC20, MockOracle, StubGovernance, StubFeeEngine, StubRegistry} from "./mocks/Mocks.sol";

/// @notice Swap venue that fills at the vault's own oracle price less `haircutBps`. Pulls the
/// input with transferFrom and mints the output, so the venue is never the limiting factor.
contract OracleFillAdapter is IExecutionAdapter {
    MockOracle public immutable oracle;
    address public immutable usdc;
    uint256 public haircutBps;

    constructor(MockOracle oracle_, address usdc_) {
        oracle = oracle_;
        usdc = usdc_;
    }

    function setHaircut(uint256 bps) external {
        haircutBps = bps;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 valueWad = _value(tokenIn, amountIn) * (10_000 - haircutBps) / 10_000;
        return tokenOut == usdc
            ? valueWad / 1e12
            : valueWad * (10 ** MockERC20(tokenOut).decimals()) / oracle.priceWad(tokenOut);
    }

    function _value(address token, uint256 amount) internal view returns (uint256) {
        if (token == usdc) return amount * 1e12;
        return amount * oracle.priceWad(token) / (10 ** MockERC20(token).decimals());
    }

    function executeSwap(SwapOrder calldata o) external returns (uint256 out) {
        out = quote(o.tokenIn, o.tokenOut, o.amountIn);
        require(out >= o.minAmountOut, "minOut");
        MockERC20(o.tokenIn).transferFrom(msg.sender, address(this), o.amountIn);
        MockERC20(o.tokenOut).mint(msg.sender, out);
    }
}

/// @notice Randomized handler for the cloud R1 vault invariants. Unlike VaultCoreInvariant (a
/// USDC-only basket) this runs a priced two-asset basket with rebalances, performance fees,
/// per-recipient blacklists (EE-6 escrow), an oracle freeze, and hostile callers. Every property
/// is recorded as a ghost counter rather than asserted inside the handler: the profile sets
/// `fail_on_revert = false`, so an assertion that reverts inside a handler call is discarded.
contract LedgerHandler is Test {
    VaultCore public vault;
    MockERC20 public usdc;
    MockERC20 public weth;
    MockERC20 public wbtc;
    MockOracle public oracle;
    StubGovernance public gov;
    StubFeeEngine public fees;
    OracleFillAdapter public adapter;

    address public creator;
    address[] public actors;
    address[] public tokens; // usdc, weth, wbtc

    uint256 constant USDC_1 = 1e6;
    uint256 constant BPS = 10_000;

    // ── ghosts: token conservation ──
    mapping(address => uint256) public donated;

    // ── ghosts: share price ──
    uint256 public navPsFloor; // highest NAVps seen since the last loss event or empty vault
    uint256 public navPsViolations;
    uint256 public worstNavPsDrop;
    uint256 public lossEvents;

    // ── ghosts: rebalance bound ──
    uint256 public rebalances;
    uint256 public rebalanceBoundViolations;
    uint256 public rebalancesRefused;

    // ── ghosts: liveness. Each action pre-checks its own preconditions, so a revert from the
    // vault on a member path is a finding, not noise. The handler itself never reverts, which
    // keeps the `reverts` field of the .gas-snapshot entry deterministic at 0.
    uint256 public unexpectedReverts;
    bytes4 public lastUnexpectedSelector;

    // ── ghosts: access control ──
    uint256 public unauthorizedSuccesses;
    uint256 public unauthorizedWrongError;
    uint256 public unauthorizedAttempts;
    uint256 public crossMemberShareLoss;
    uint256 public foreignEscrowTaken;
    uint256 public claimMismatches; // a claim paid other than exactly the escrow, or left it set

    // ── ghosts: oracle freeze ──
    uint256 public frozenValueMoves;
    uint256 public frozenProbes;
    uint256 public frozenCancelFailures;

    constructor(
        VaultCore vault_,
        MockERC20 usdc_,
        MockERC20 weth_,
        MockERC20 wbtc_,
        MockOracle oracle_,
        StubGovernance gov_,
        StubFeeEngine fees_,
        OracleFillAdapter adapter_,
        address creator_
    ) {
        vault = vault_;
        usdc = usdc_;
        weth = weth_;
        wbtc = wbtc_;
        oracle = oracle_;
        gov = gov_;
        fees = fees_;
        adapter = adapter_;
        creator = creator_;
        tokens.push(address(usdc_));
        tokens.push(address(weth_));
        tokens.push(address(wbtc_));
        actors.push(creator_);
        for (uint256 i; i < 4; ++i) {
            actors.push(makeAddr(string(abi.encodePacked("r1-actor", i))));
        }
        for (uint256 i; i < actors.length; ++i) {
            usdc.mint(actors[i], 1_000_000_000 * USDC_1);
            vm.prank(actors[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _pending(address who) internal view returns (uint256 amt) {
        (amt,) = vault.pendingDeposit(who);
    }

    function _unexpected(bytes memory err) internal {
        ++unexpectedReverts;
        if (err.length >= 4) lastUnexpectedSelector = bytes4(err);
    }

    function _snapShares() internal view returns (uint256[] memory s) {
        s = new uint256[](actors.length);
        for (uint256 i; i < actors.length; ++i) {
            s[i] = vault.sharesOf(actors[i]);
        }
    }

    /// No action taken by `who` may reduce another member's shares. `exempt` is the one member a
    /// permissionless settleQueuedExit may burn, by exactly `exemptBurn`.
    function _checkOthers(uint256[] memory before, address who, address exempt, uint256 exemptBurn) internal {
        for (uint256 i; i < actors.length; ++i) {
            address y = actors[i];
            if (y == who) continue;
            uint256 nowShares = vault.sharesOf(y);
            if (y == exempt) {
                if (nowShares + exemptBurn != before[i]) ++crossMemberShareLoss;
            } else if (nowShares < before[i]) {
                ++crossMemberShareLoss;
            }
        }
    }

    /// NAVps must not fall absent a loss event. Tolerance covers per-asset floor rounding in
    /// navWad (one WAD wei per basket asset, scaled by 1e18 / totalShares) and nothing more.
    function _checkNavPs() internal {
        if (oracle.stale()) return;
        uint256 ts = vault.totalShares();
        if (ts == 0) {
            navPsFloor = 0;
            return;
        }
        uint256 ps = vault.navPerShareWad();
        uint256 tol = 10 + 3 * 1e18 / ts + ps / 1e15;
        if (ps + tol < navPsFloor) {
            ++navPsViolations;
            uint256 drop = navPsFloor - ps;
            if (drop > worstNavPsDrop) worstNavPsDrop = drop;
        }
        if (ps > navPsFloor) navPsFloor = ps;
    }

    /// A loss event: the floor restarts at the post-event NAVps.
    function _lossEvent() internal {
        ++lossEvents;
        navPsFloor = 0;
        _checkNavPs();
    }

    // ───────────────────────────── member actions ─────────────────────────────

    function deposit(uint256 seed, uint256 amount) external {
        if (oracle.stale()) return;
        address who = _actor(seed);
        amount = bound(amount, 10 * USDC_1, 2_000_000 * USDC_1);
        if (!vault.windowCleared(who) && vault.sharesOf(who) == 0 && _pending(who) > 0) return;
        uint256[] memory before = _snapShares();
        vm.prank(who);
        try vault.deposit(amount) {}
        catch (bytes memory err) {
            _unexpected(err);
            return;
        }
        _checkOthers(before, who, address(0), 0);
        _checkNavPs();
    }

    function activate(uint256 seed, uint256 callerSeed) external {
        if (oracle.stale()) return;
        address who = _actor(seed);
        if (_pending(who) == 0) return;
        (, uint64 availableAt) = vault.pendingDeposit(who);
        if (block.timestamp < availableAt) vm.warp(availableAt);
        address caller = _actor(callerSeed); // permissionless crank
        uint256[] memory before = _snapShares();
        vm.prank(caller);
        try vault.activate(who) {}
        catch (bytes memory err) {
            _unexpected(err);
            return;
        }
        _checkOthers(before, caller, address(0), 0);
        _checkNavPs();
    }

    function cancelPending(uint256 seed) external {
        address who = _actor(seed);
        if (_pending(who) == 0) return;
        uint256[] memory before = _snapShares();
        vm.prank(who);
        try vault.cancelPending() {}
        catch (bytes memory err) {
            _unexpected(err);
            return;
        }
        _checkOthers(before, who, address(0), 0);
        _checkNavPs();
    }

    function skipWindow(uint256 seed) external {
        if (oracle.stale()) return;
        address who = _actor(seed);
        if (vault.skipOptIn(who)) return;
        uint256[] memory before = _snapShares();
        vm.prank(who);
        try vault.skipWindow() {}
        catch (bytes memory err) {
            _unexpected(err);
            return;
        }
        _checkOthers(before, who, address(0), 0);
        _checkNavPs();
    }

    function requestExit(uint256 seed, uint256 shareAmt) external {
        if (oracle.stale()) return;
        address who = _actor(seed);
        uint256 held = vault.sharesOf(who);
        if (held == 0 || vault.queuedExitShares(who) > 0) return;
        uint256 burn = bound(shareAmt, 1, held);
        uint256 rest = held - burn;
        if (rest != 0 && rest < vault.MIN_POSITION_SHARES()) burn = held; // floor: exit fully
        if (who == creator && vault.nonCreatorMemberCount() > 0) {
            uint256 ts = vault.totalShares();
            if ((held - burn) * BPS < 500 * (ts - burn)) return; // creator gate is unit-tested
        }
        uint256[] memory before = _snapShares();
        vm.prank(who);
        try vault.requestExit(burn) {}
        catch (bytes memory err) {
            _unexpected(err);
            return;
        }
        _checkOthers(before, who, address(0), 0);
        _checkNavPs();
    }

    function settleQueued(uint256 seed, uint256 callerSeed) external {
        if (oracle.stale()) return;
        address who = _actor(seed);
        uint256 q = vault.queuedExitShares(who);
        if (q == 0) return;
        gov.setPendingExecution(false);
        address caller = _actor(callerSeed);
        uint256[] memory before = _snapShares();
        vm.prank(caller);
        try vault.settleQueuedExit(who) {}
        catch (bytes memory err) {
            _unexpected(err);
            return;
        }
        _checkOthers(before, caller, who, q);
        _checkNavPs();
    }

    /// Claims the first escrowed balance found from `seed` (members and the fee engine). The
    /// recipient is delisted first, which is the realistic route out of an EE-6 escrow.
    function claimEscrowed(uint256 seed, uint256 tokenSeed) external {
        address t = tokens[tokenSeed % tokens.length];
        address who;
        for (uint256 i; i <= actors.length; ++i) {
            uint256 k = (seed % (actors.length + 1) + i) % (actors.length + 1);
            address c = k == actors.length ? address(fees) : actors[k];
            if (vault.claimable(c, t) > 0) {
                who = c;
                break;
            }
        }
        if (who == address(0)) return;
        MockERC20(t).setBlacklisted(who, false);
        uint256 owed = vault.claimable(who, t);
        uint256 balBefore = MockERC20(t).balanceOf(who);
        uint256[] memory before = _snapShares();
        vm.prank(who);
        try vault.claimEscrowed(t) {}
        catch (bytes memory err) {
            _unexpected(err);
            return;
        }
        if (vault.claimable(who, t) != 0 || MockERC20(t).balanceOf(who) - balBefore != owed) {
            ++claimMismatches;
        }
        _checkOthers(before, who, address(0), 0);
        _checkNavPs();
    }

    // ───────────────────────────── environment ─────────────────────────────

    function togglePendingExecution(bool p) external {
        gov.setPendingExecution(p);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 minutes, 45 days));
        _checkNavPs();
    }

    function donate(uint256 tokenSeed, uint256 amount) external {
        address t = tokens[tokenSeed % tokens.length];
        amount = bound(
            amount, 1, t == address(usdc) ? 10_000_000 * USDC_1 : 1_000 * 10 ** MockERC20(t).decimals()
        );
        MockERC20(t).mint(address(vault), amount);
        donated[t] += amount;
        _checkNavPs(); // a donation is not a gain and must not move NAVps either way
    }

    function setBlacklist(uint256 seed, uint256 tokenSeed, bool listed) external {
        // Includes the fee engine: the M-2 systemic case is a listed fee recipient.
        address who = seed % 6 == 5 ? address(fees) : _actor(seed);
        MockERC20(tokens[tokenSeed % tokens.length]).setBlacklisted(who, listed);
    }

    function setPerformanceFee(uint256 f) external {
        fees.setFeeToCharge(bound(f, 0, 1_000_000 * USDC_1)); // vault clamps to 10% of gain
    }

    /// Price move. A rise is a gain (floor ratchets up); a fall is the canonical loss event.
    function movePrice(uint256 assetSeed, uint256 pctBps, bool up) external {
        if (oracle.stale()) return;
        address a = assetSeed % 2 == 0 ? address(weth) : address(wbtc);
        uint256 p = oracle.price(a);
        uint256 d = p * bound(pctBps, 1, 2_000) / BPS;
        uint256 np = up ? p + d : p - d;
        if (np < 1e18 || np > 1e24) return; // keep valuations inside a sane band
        oracle.setPrice(a, np);
        if (up) _checkNavPs();
        else _lossEvent();
    }

    /// Oracle freeze: the vault has no pause switch; a stale oracle is its freeze (K-4).
    function setStale(bool s) external {
        oracle.setStale(s);
        if (!s) _checkNavPs();
    }

    /// While frozen nothing NAV-relevant may move (supply, idle USDC, basket balances), and
    /// cancelPending must still work. A Mode F queue is allowed: it locks shares and moves no
    /// value. Paths only read the oracle when a priced basket asset is involved (navWad skips
    /// zero balances, an exit skips zero slices), so each probe is gated on that being true.
    function probeFrozen(uint256 seed, uint256 amount) external {
        if (!oracle.stale()) return;
        ++frozenProbes;
        address who = _actor(seed);
        amount = bound(amount, 10 * USDC_1, 1_000_000 * USDC_1);
        uint256 ts = vault.totalShares();
        bool priced = vault.assetBalance(address(weth)) > 0 || vault.assetBalance(address(wbtc)) > 0;
        bytes32 before = _navState();

        if (priced) {
            vm.prank(who);
            try vault.deposit(amount) {} catch {}
        }

        uint256 held = vault.sharesOf(who);
        if (held > 0 && vault.queuedExitShares(who) == 0 && _exitTouchesBasket(held, ts)) {
            vm.prank(who);
            try vault.requestExit(held) {} catch {}
        }

        if (_pending(who) > 0) {
            (, uint64 availableAt) = vault.pendingDeposit(who);
            if (priced && ts > 0 && block.timestamp >= availableAt) {
                try vault.activate(who) {} catch {}
            }
        }

        if (_navState() != before) ++frozenValueMoves;

        if (_pending(who) > 0) {
            vm.prank(who);
            try vault.cancelPending() {}
            catch {
                ++frozenCancelFailures;
            }
        }
    }

    function _navState() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                vault.totalShares(),
                vault.idleUsdc(),
                vault.assetBalance(address(weth)),
                vault.assetBalance(address(wbtc))
            )
        );
    }

    /// True when a full exit of `held` would carry a nonzero slice of some basket asset, at the
    /// worst-case 1% exit fee.
    function _exitTouchesBasket(uint256 held, uint256 ts) internal view returns (bool) {
        if (ts == 0) return false;
        uint256 keep = held * (BPS - 100);
        return vault.assetBalance(address(weth)) * keep / (ts * BPS) > 0
            || vault.assetBalance(address(wbtc)) * keep / (ts * BPS) > 0;
    }

    // ───────────────────────────── governance ─────────────────────────────

    /// A governance-executed rebalance through the allowlisted venue. Every rebalance is treated
    /// as a loss event for the NAVps floor (fills round down, and a haircut is a real cost), but
    /// the loss must stay inside the proposal's declared slippage bound plus one output unit.
    function rebalance(uint256 inSeed, uint256 outSeed, uint256 frac, uint256 haircut, uint256 slip)
        external
    {
        if (oracle.stale() || vault.totalShares() == 0) return;
        address tIn = tokens[inSeed % 3];
        address tOut = tokens[(inSeed % 3 + 1 + outSeed % 2) % 3];
        uint256 bal = tIn == address(usdc) ? vault.idleUsdc() : vault.assetBalance(tIn);
        if (bal == 0) return;
        uint256 amountIn = bal * bound(frac, 1, BPS) / BPS;
        if (amountIn == 0) return;
        slip = bound(slip, 1, vault.MAX_REBALANCE_SLIPPAGE_BPS());
        adapter.setHaircut(bound(haircut, 0, slip));
        uint256 minOut = adapter.quote(tIn, tOut, amountIn);
        if (minOut == 0) return;

        IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](1);
        orders[0] = IExecutionAdapter.SwapOrder(tIn, tOut, amountIn, minOut, block.timestamp, "");

        uint256 navBefore = vault.navWad();
        // Not counted as unexpected: the fill and the oracle bound both floor, so a quote can
        // land a wei under the bound on small legs. The refusal is the bound working.
        vm.prank(address(gov));
        try vault.executeRebalance(address(adapter), slip, orders) {}
        catch {
            ++rebalancesRefused;
            return;
        }
        ++rebalances;

        uint256 navAfter = vault.navWad();
        uint256 unitWad =
            tOut == address(usdc) ? 1e12 : oracle.priceWad(tOut) / 10 ** MockERC20(tOut).decimals() + 1;
        uint256 inValue = tIn == address(usdc)
            ? amountIn * 1e12
            : amountIn * oracle.priceWad(tIn) / 10 ** MockERC20(tIn).decimals();
        uint256 maxLoss = inValue * slip / BPS + unitWad + 4;
        if (navAfter + maxLoss < navBefore) ++rebalanceBoundViolations;
        _lossEvent();
    }

    // ───────────────────────────── hostile callers ─────────────────────────────

    /// Any non-governance caller, member or stranger, must be refused OnlyGovernance on every
    /// governance-only entry point, and claimEscrowed only ever pays the caller.
    function attack(uint256 callerSeed, address stranger, uint256 which) external {
        address caller = callerSeed % 2 == 0 ? _actor(callerSeed) : stranger;
        if (caller == address(gov)) return;
        ++unauthorizedAttempts;
        which = which % 4;
        bytes memory data;
        if (which == 0) {
            IExecutionAdapter.SwapOrder[] memory orders = new IExecutionAdapter.SwapOrder[](0);
            data = abi.encodeCall(VaultCore.executeRebalance, (address(adapter), 100, orders));
        } else if (which == 1) {
            data = abi.encodeCall(VaultCore.allocateToChild, (stranger, 0));
        } else if (which == 2) {
            data = abi.encodeCall(VaultCore.redeemFromChild, (stranger, 1));
        } else {
            // Escrow belongs to its owner: a caller with nothing claimable takes nothing, and
            // every other member's claimable balance is untouched.
            address t = tokens[callerSeed % tokens.length];
            if (vault.claimable(caller, t) != 0) return;
            uint256 sumBefore = _sumClaimable(t);
            vm.prank(caller);
            (bool okc,) = address(vault).call(abi.encodeCall(VaultCore.claimEscrowed, (t)));
            if (okc || _sumClaimable(t) != sumBefore) ++foreignEscrowTaken;
            return;
        }
        uint256[] memory before = _snapShares();
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(vault).call(data);
        if (ok) ++unauthorizedSuccesses;
        else if (ret.length < 4 || bytes4(ret) != VaultCore.OnlyGovernance.selector) ++unauthorizedWrongError;
        _checkOthers(before, address(0), address(0), 0);
    }

    // ───────────────────────────── views for the invariants ─────────────────────────────

    function _sumClaimable(address t) internal view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += vault.claimable(actors[i], t);
        }
        sum += vault.claimable(address(fees), t);
    }

    function sumClaimable(address t) external view returns (uint256) {
        return _sumClaimable(t);
    }

    function sumShares() external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += vault.sharesOf(actors[i]);
        }
    }

    function holders() external view returns (uint256 all, uint256 nonCreator) {
        for (uint256 i; i < actors.length; ++i) {
            if (vault.sharesOf(actors[i]) > 0) {
                ++all;
                if (actors[i] != creator) ++nonCreator;
            }
        }
    }

    function sumQueued() external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += vault.queuedExitShares(actors[i]);
        }
    }

    function sumPending() external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += _pending(actors[i]);
        }
    }
}

/// @notice Cloud R1 vault invariants: conservation of assets, share price never decreasing
/// without a loss event, no unauthorized role use, and the oracle freeze holding.
contract VaultLedgerInvariantTest is Test {
    VaultCore vault;
    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 wbtc;
    MockOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    OracleFillAdapter adapter;
    LedgerHandler handler;
    address creator = makeAddr("r1-creator");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("WETH", 18);
        wbtc = new MockERC20("WBTC", 8);
        oracle = new MockOracle();
        oracle.setPrice(address(weth), 3_000e18);
        oracle.setPrice(address(wbtc), 60_000e18);
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();
        adapter = new OracleFillAdapter(oracle, address(usdc));

        address[] memory basket = new address[](2);
        basket[0] = address(weth);
        basket[1] = address(wbtc);
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);

        vault = new VaultCore(
            address(usdc),
            basket,
            creator,
            registry,
            gov,
            fees,
            oracle,
            0, // uncapped: capacity is not under test here
            10 * 1e6,
            100,
            30 days,
            adapters,
            address(0)
        );

        handler = new LedgerHandler(vault, usdc, weth, wbtc, oracle, gov, fees, adapter, creator);
        targetContract(address(handler));
    }

    /// USDC held by the vault is exactly idle + pending escrow + EE-6 claimable + donations.
    /// Equality, not >=: any wei the accounting created or lost would show here.
    function invariant_usdcConserved() public view {
        assertEq(
            usdc.balanceOf(address(vault)),
            vault.idleUsdc() + vault.totalPendingUsdc() + handler.sumClaimable(address(usdc))
                + handler.donated(address(usdc)),
            "usdc: balance != idle + pending + claimable + donated"
        );
    }

    /// Each basket asset held is exactly internal balance + claimable + donations.
    function invariant_basketAssetsConserved() public view {
        MockERC20[2] memory assets = [weth, wbtc];
        for (uint256 i; i < 2; ++i) {
            address a = address(assets[i]);
            assertEq(
                assets[i].balanceOf(address(vault)),
                vault.assetBalance(a) + handler.sumClaimable(a) + handler.donated(a),
                "asset: balance != assetBalance + claimable + donated"
            );
        }
    }

    /// Shares, holders and locks are internally consistent.
    function invariant_shareAccounting() public view {
        assertEq(handler.sumShares(), vault.totalShares(), "sum(sharesOf) != totalShares");
        (uint256 all, uint256 nonCreator) = handler.holders();
        assertEq(all, vault.holderCount(), "holderCount drift");
        assertEq(nonCreator, vault.nonCreatorMemberCount(), "nonCreatorMemberCount drift");
        assertEq(handler.sumQueued(), vault.totalQueuedShares(), "queued drift");
        assertLe(vault.totalQueuedShares(), vault.totalShares(), "queued > supply");
        assertEq(handler.sumPending(), vault.totalPendingUsdc(), "pending drift");
    }

    /// NAVps never decreases except across a loss event (price fall or rebalance).
    function invariant_navPsMonotoneAbsentLoss() public view {
        assertEq(handler.navPsViolations(), 0, "NAVps fell without a loss event");
    }

    /// Member paths whose preconditions hold never revert (exits stay live).
    function invariant_memberPathsLive() public view {
        assertEq(handler.unexpectedReverts(), 0, "a member path reverted with preconditions met");
    }

    /// A rebalance never costs more than the proposal's declared slippage bound plus rounding.
    function invariant_rebalanceLossBounded() public view {
        assertEq(handler.rebalanceBoundViolations(), 0, "rebalance loss exceeded declared bound");
    }

    /// No non-governance caller ever passed a governance-only gate, every refusal was
    /// OnlyGovernance, nobody claimed someone else's escrow, and no action reduced another
    /// member's shares.
    function invariant_noUnauthorizedRoleUse() public view {
        assertEq(handler.unauthorizedSuccesses(), 0, "governance-only call succeeded");
        assertEq(handler.unauthorizedWrongError(), 0, "refusal was not OnlyGovernance");
        assertEq(handler.foreignEscrowTaken(), 0, "escrow taken by non-owner");
        assertEq(handler.claimMismatches(), 0, "claim did not pay exactly the escrow");
        assertEq(handler.crossMemberShareLoss(), 0, "action reduced another member's shares");
    }

    /// The oracle freeze is the vault's only stop: while it holds, supply, idle USDC and basket
    /// balances do not move, and cancelPending stays available.
    function invariant_frozenMeansFrozen() public view {
        assertEq(handler.frozenValueMoves(), 0, "value moved while oracle stale");
        assertEq(handler.frozenCancelFailures(), 0, "cancelPending failed while oracle stale");
    }
}
