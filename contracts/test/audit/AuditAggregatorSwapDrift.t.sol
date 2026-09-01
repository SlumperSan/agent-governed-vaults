// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockERC20, StubGovernance, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

/// @notice AGGREGATOR-SWAP DRIFT — the ACCEPTED residual behind {ChainlinkOracle}'s cached `scale`,
/// pinned here as evidence rather than remediated. Read `docs/LAUNCH-READINESS.md` §4 row 14 for the
/// decision; this file is what stops that row from silently becoming wrong.
///
/// ## The shape
///
/// The configured feed addresses are Chainlink `EACAggregatorProxy` instances, and Chainlink swaps
/// the aggregator behind the proxy as routine operation (`phaseId` counts the swaps). `decimals()`
/// and `description()` forward to whichever aggregator is current. {ChainlinkOracle} reads both
/// ONCE, in its constructor, and caches `scale = 10**(18 - decimals)`; the config is immutable, so
/// nothing re-checks. A post-deployment decimals change would therefore mis-scale every price by a
/// power of ten, permanently, with no revert.
///
/// ## Why it is accepted rather than fixed — and what these tests fix in place
///
/// 1. **`description()` drift is runtime-inert.** Nothing in `priceWad` reads it; it is a
///    construction-time misconfiguration guard only. Only `decimals()` feeds a cached value.
///    Pinned by `test_descriptionDriftAfterConstructionIsRuntimeInert`.
/// 2. **The sane-price band already fail-closes on every drift with a Chainlink precedent.** The
///    only alternative convention Chainlink actually uses is 18 decimals (its ETH-denominated
///    feeds), which misses by ten orders of magnitude; and any shift of >= 2 decimals leaves the
///    real launch bands. Both revert `StaleOracle` today with no new code. Pinned by the
///    `test_backstop_*` cases.
/// 3. **What is left is a +/-1-decimal change** — a shape with no Chainlink convention behind it
///    (8 for USD feeds, 18 for ETH-denominated; never 7 or 9), and zero occurrences in an on-chain
///    survey of 25 real aggregator swaps across 12 proxies on Base and Ethereum mainnet (Base
///    ETH/USD `0x71041ddd` is at phaseId 3 and reports 8 decimals at every phase; Ethereum ETH/USD,
///    BTC/USD and LINK/USD are each at phaseId 7 and report 8 at every phase that implements
///    AggregatorV3). Pinned by the `test_residual_*` cases, which assert the mispricing is silent —
///    they are the boundary of the accepted risk, not a claim that it is safe.
/// 4. **The harm is bounded to MINTING, not to redemption.** `_settleExit` pays a member their
///    pro-rata slice of `assetBalance` and `idleUsdc` — the oracle is consulted only to value the
///    payout for reporting and fees, never to size it. So under drift a member still exits whole,
///    while a re-check that fail-closed on a routine swap would freeze `navWad`, `deposit` AND
///    `requestExit` forever, with no rotation lever to undo it (the vault's oracle is `immutable`
///    and `Governance` has no oracle surface — see `AuditOracleRotation.t.sol`). That asymmetry is
///    the argument. Pinned by `test_harmModel_driftDoesNotRobAnExitingMember`.
///
/// ## What would invalidate the acceptance
///
/// The backstop in (2) is DEPLOYER CONFIGURATION, not a contract guarantee:
/// `test_backstop_disappearsEntirelyWhenTheSanePriceBandIsDisabled` proves a 0/0 band lets a 100x
/// mis-scale through in silence. `scripts/verify-chainlink-oracle.mjs` hard-fails a mainnet feed
/// with no band, which is what keeps that from happening — do not weaken either.
contract AuditAggregatorSwapDriftTest is Test {
    using stdStorage for StdStorage;

    address constant WETH = address(0xE7);
    address constant CBBTC = address(0xCBB7);
    uint32 constant HEARTBEAT = 3600;

    // A SNAPSHOT of the real launch bands and prices from
    // `contracts/config/base-mainnet.json.chainlinkOracle` (read on-chain 2026-08-29). These are
    // literals: retuning that config does NOT fail this suite, so do not read these tests as a
    // binding on it. The binding lives in `scripts/verify-chainlink-oracle.mjs`, whose
    // `band bounds a 2-decimal drift` check hard-fails a config whose band is too wide to catch the
    // drift these tests describe. What this suite pins is the ARITHMETIC at these values -- which
    // drifts the band catches and which it does not.
    uint256 constant WETH_MIN_WAD = 100000000000000000000; // 1e20  = $100
    uint256 constant WETH_MAX_WAD = 100000000000000000000000; // 1e23 = $100,000
    uint256 constant WETH_SPOT_USD = 2440; // ~$2,440 at the 2026-08-29 on-chain verification

    uint256 constant CBBTC_MIN_WAD = 1000000000000000000000; // 1e21 = $1,000
    uint256 constant CBBTC_MAX_WAD = 1000000000000000000000000; // 1e24 = $1,000,000
    uint256 constant CBBTC_SPOT_USD = 77700; // ~$77,700 at the same verification

    function setUp() public {
        vm.warp(1_000_000);
    }

    // --- helpers -----------------------------------------------------------

    function _oracle(address asset, address feed, uint256 lo, uint256 hi) internal returns (ChainlinkOracle) {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[] memory feeds = new address[](1);
        feeds[0] = feed;
        uint32[] memory hb = new uint32[](1);
        hb[0] = HEARTBEAT;
        uint256[] memory mn = new uint256[](1);
        mn[0] = lo;
        uint256[] memory mx = new uint256[](1);
        mx[0] = hi;
        return new ChainlinkOracle(assets, feeds, hb, mn, mx, address(0), address(0));
    }

    /// @dev The aggregator behind the proxy is swapped: it now reports `newDecimals` precision, and
    /// republishes the SAME real-world price at that new precision. The oracle's cached `scale` is
    /// untouched — this is exactly the drift being modelled.
    function _swapAggregatorTo(MockAggregatorV3 feed, uint8 newDecimals, uint256 priceUsd) internal {
        feed.setDecimals(newDecimals);
        feed.set(int256(priceUsd * 10 ** newDecimals), block.timestamp);
    }

    function _expectStale(ChainlinkOracle oracle, address asset) internal {
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        oracle.priceWad(asset);
    }

    // --- 1. the finding is real -------------------------------------------

    /// The constructor's `decimals() == 8` pin and its cached `scale` are a one-time snapshot. With
    /// the band disabled — the shape every non-mainnet fixture and every 0/0 config uses — a
    /// post-construction decimals change mis-scales silently and forever.
    function test_finding_decimalsDriftAfterConstructionIsNeverReChecked() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(WETH_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oracle = _oracle(WETH, address(feed), 0, 0); // band DISABLED
        assertEq(oracle.priceWad(WETH), WETH_SPOT_USD * 1e18, "baseline: 8-decimal feed prices correctly");

        // Chainlink swaps the aggregator; the new one reports 9 decimals for the same $2,440.
        _swapAggregatorTo(feed, 9, WETH_SPOT_USD);

        // No revert, no staleness, no band trip: the price is simply 10x wrong, from now on.
        assertEq(feed.decimals(), 9, "the feed itself now reports 9 decimals");
        assertEq(
            oracle.priceWad(WETH),
            WETH_SPOT_USD * 10 * 1e18,
            "FINDING: cached scale mis-prices by 10x, silently and permanently"
        );
    }

    /// `description()` is a CONSTRUCTION-time misconfiguration guard (the #75 denomination check).
    /// Nothing on the price path reads it, so description drift — including a swap to the exact
    /// ETH-denominated string that check exists to reject — changes nothing at runtime. This is why
    /// the residual is about `decimals()` alone, and why description-watching belongs off-chain.
    function test_descriptionDriftAfterConstructionIsRuntimeInert() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(WETH_SPOT_USD * 1e8), block.timestamp);
        feed.setDescription("ETH / USD");
        ChainlinkOracle oracle = _oracle(WETH, address(feed), WETH_MIN_WAD, WETH_MAX_WAD);
        uint256 before = oracle.priceWad(WETH);

        feed.setDescription("CBETH / ETH"); // the exact string the constructor would have rejected

        assertEq(oracle.priceWad(WETH), before, "description drift has no runtime surface at all");
    }

    // --- 2. the sane-price band is the backstop that already exists --------

    /// 18 decimals is Chainlink's ETH-DENOMINATED convention and the ONLY alternative precision it
    /// actually ships. Against the real WETH launch band it misses by ten orders of magnitude, so
    /// the drift that has an actual precedent already fails closed with no new code.
    function test_backstop_driftToTheEighteenDecimalConventionTripsTheBand() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(WETH_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oracle = _oracle(WETH, address(feed), WETH_MIN_WAD, WETH_MAX_WAD);
        _swapAggregatorTo(feed, 18, WETH_SPOT_USD);
        _expectStale(oracle, WETH); // 2.44e31 WAD vs a 1e23 ceiling
    }

    /// >= 2 decimals in either direction leaves the real launch band on both launch assets.
    function test_backstop_twoDecimalDriftTripsTheBand_weth() public {
        MockAggregatorV3 up = new MockAggregatorV3(8, int256(WETH_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oUp = _oracle(WETH, address(up), WETH_MIN_WAD, WETH_MAX_WAD);
        _swapAggregatorTo(up, 10, WETH_SPOT_USD); // 2.44e23 > 1e23 ceiling
        _expectStale(oUp, WETH);

        MockAggregatorV3 down = new MockAggregatorV3(8, int256(WETH_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oDown = _oracle(WETH, address(down), WETH_MIN_WAD, WETH_MAX_WAD);
        _swapAggregatorTo(down, 6, WETH_SPOT_USD); // 2.44e19 < 1e20 floor
        _expectStale(oDown, WETH);
    }

    function test_backstop_twoDecimalDriftTripsTheBand_cbbtc() public {
        MockAggregatorV3 up = new MockAggregatorV3(8, int256(CBBTC_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oUp = _oracle(CBBTC, address(up), CBBTC_MIN_WAD, CBBTC_MAX_WAD);
        _swapAggregatorTo(up, 10, CBBTC_SPOT_USD); // 7.77e24 > 1e24 ceiling
        _expectStale(oUp, CBBTC);

        MockAggregatorV3 down = new MockAggregatorV3(8, int256(CBBTC_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oDown = _oracle(CBBTC, address(down), CBBTC_MIN_WAD, CBBTC_MAX_WAD);
        _swapAggregatorTo(down, 6, CBBTC_SPOT_USD); // 7.77e20 < 1e21 floor
        _expectStale(oDown, CBBTC);
    }

    /// THE LOAD-BEARING WARNING. The backstop above is deployer CONFIG, not a contract property.
    /// With the band disabled even a 100x mis-scale — which the band would have caught — prices in
    /// silence. `scripts/verify-chainlink-oracle.mjs` refuses a mainnet feed with no band, and this
    /// is why that check must not be relaxed.
    function test_backstop_disappearsEntirelyWhenTheSanePriceBandIsDisabled() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(WETH_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oracle = _oracle(WETH, address(feed), 0, 0); // 0/0 => band off
        _swapAggregatorTo(feed, 10, WETH_SPOT_USD);
        assertEq(
            oracle.priceWad(WETH),
            WETH_SPOT_USD * 100 * 1e18,
            "with no band, a 100x mis-scale prices silently -- the band is the whole backstop"
        );
    }

    // --- 3. the exact residual: a +/-1-decimal drift ----------------------

    /// The accepted gap, stated precisely: 8 -> 9 puts WETH at $24,400 against a $100,000 ceiling,
    /// so the band does NOT catch it. Asserting the WRONG price is the point — this is the boundary
    /// of the residual, and a future band retune that changes this outcome must be a deliberate act.
    function test_residual_plusOneDecimalDriftIsInsideTheRealWethBand() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(WETH_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oracle = _oracle(WETH, address(feed), WETH_MIN_WAD, WETH_MAX_WAD);
        _swapAggregatorTo(feed, 9, WETH_SPOT_USD);

        uint256 p = oracle.priceWad(WETH);
        assertEq(p, 24_400e18, "RESIDUAL: 10x overprice, inside the band, returned silently");
        assertLt(p, WETH_MAX_WAD, "and it is inside the band by construction -- nothing trips");
    }

    /// 8 -> 7 puts WETH at $244 against a $100 floor. The DEPRESSED direction is the dangerous one:
    /// it is C-4's shape, where an under-stated NAV mints excess shares to a new depositor.
    function test_residual_minusOneDecimalDriftIsInsideTheRealWethBand() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(WETH_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oracle = _oracle(WETH, address(feed), WETH_MIN_WAD, WETH_MAX_WAD);
        _swapAggregatorTo(feed, 7, WETH_SPOT_USD);

        uint256 p = oracle.priceWad(WETH);
        assertEq(p, 244e18, "RESIDUAL: 10x underprice (the share-minting direction), returned silently");
        assertGt(p, WETH_MIN_WAD, "inside the band");
    }

    /// cbBTC's band is wide enough that +1 decimal also slips through — but only by 1.29x, so the
    /// residual NARROWS as the asset's price rises toward the ceiling: above ~$100,000 BTC, a +1
    /// drift would exceed 1e24 and fail closed on its own. Recorded because it means the size of
    /// this residual is a function of live price, not a constant.
    function test_residual_plusOneDecimalDriftIsInsideTheRealCbbtcBand_butOnlyJust() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(CBBTC_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oracle = _oracle(CBBTC, address(feed), CBBTC_MIN_WAD, CBBTC_MAX_WAD);
        _swapAggregatorTo(feed, 9, CBBTC_SPOT_USD);

        uint256 p = oracle.priceWad(CBBTC);
        assertEq(p, 777_000e18, "RESIDUAL: 10x overprice, inside the band");
        assertLt(p, CBBTC_MAX_WAD, "inside -- but the ceiling is only 1.29x away");

        // Same drift with BTC at $110,000 exceeds the ceiling and fails closed unaided.
        _swapAggregatorTo(feed, 9, 110_000);
        _expectStale(oracle, CBBTC);
    }

    function test_residual_minusOneDecimalDriftIsInsideTheRealCbbtcBand() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(CBBTC_SPOT_USD * 1e8), block.timestamp);
        ChainlinkOracle oracle = _oracle(CBBTC, address(feed), CBBTC_MIN_WAD, CBBTC_MAX_WAD);
        _swapAggregatorTo(feed, 7, CBBTC_SPOT_USD);
        assertEq(oracle.priceWad(CBBTC), 7_770e18, "RESIDUAL: 10x underprice, inside the band");
    }

    // --- 3a. the expiry: backstop (ii) is a property of the PRICE, not of the config -----

    /// The band bounds a -2-decimal drift only while `spot < 100 * minPriceWad`, and the contract's
    /// floor comparison is `priceWad_ < cfg.minPriceWad` — EXCLUSIVE, so landing exactly on the
    /// floor does not revert either. cbBTC's floor is $1,000, so the backstop lapses at BTC =
    /// $100,000: a 100x underprice then reads as a sane price, which is C-4's share-minting shape
    /// with nothing to stop it. No config change is involved. Nobody has to do anything for this
    /// to happen — the asset just has to go up, and BTC was ~$77,700 when the band was set.
    ///
    /// This is pinned as a TEST rather than a sentence because residual-register row 14 accepts the
    /// cached-`scale` risk ON the strength of backstop (ii). A prose caveat about a price boundary
    /// is the kind of thing that gets read once; a failing assertion is not.
    function test_expiry_atBtc100kTheMinusTwoDecimalDriftNoLongerTripsTheFloor() public {
        uint256 spotUsd = 100_000; // the boundary itself
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(spotUsd * 1e8), block.timestamp);
        ChainlinkOracle oracle = _oracle(CBBTC, address(feed), CBBTC_MIN_WAD, CBBTC_MAX_WAD);

        _swapAggregatorTo(feed, 6, spotUsd); // 8 -> 6 decimals: a /100 mis-scale

        uint256 p = oracle.priceWad(CBBTC);
        assertEq(p, CBBTC_MIN_WAD, "the drifted price lands exactly ON the floor");
        assertFalse(p < CBBTC_MIN_WAD, "and the contract's comparison is exclusive, so it does not revert");
        assertEq(
            p, 1_000e18, "BTC priced at $1,000 while the feed says $100,000 -- 100x underprice, no revert"
        );
    }

    /// One dollar below the boundary the backstop still works, which is what makes the line above a
    /// boundary and not an argument about the whole design.
    function test_expiry_justBelowTheBoundaryTheFloorStillCatchesIt() public {
        uint256 spotUsd = 99_999;
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(spotUsd * 1e8), block.timestamp);
        ChainlinkOracle oracle = _oracle(CBBTC, address(feed), CBBTC_MIN_WAD, CBBTC_MAX_WAD);

        _swapAggregatorTo(feed, 6, spotUsd);

        vm.expectRevert();
        oracle.priceWad(CBBTC);
    }

    /// WETH has the same expiry an order of magnitude lower: its floor is $100, so the -2-decimal
    /// backstop lapses at ETH = $10,000. Recorded because the two launch assets fail at different
    /// prices and the register should not imply one number.
    function test_expiry_wethBackstopLapsesAtTenThousand() public {
        uint256 spotUsd = 10_000;
        MockAggregatorV3 feed = new MockAggregatorV3(8, int256(spotUsd * 1e8), block.timestamp);
        ChainlinkOracle oracle = _oracle(WETH, address(feed), WETH_MIN_WAD, WETH_MAX_WAD);

        _swapAggregatorTo(feed, 6, spotUsd);

        assertEq(
            oracle.priceWad(WETH), WETH_MIN_WAD, "exactly on the $100 floor, and exclusive means no revert"
        );
    }

    // --- 4. the harm model: drift misprices MINTING, not REDEMPTION -------

    /// The asymmetry the whole decision rests on. Under a live 10x drift an exiting member still
    /// receives EXACTLY their pro-rata slice of the basket and of idle USDC, because `_settleExit`
    /// sizes the payout from `assetBalance`/`idleUsdc` and consults the oracle only to VALUE it.
    /// A decimals re-check that fail-closed on a routine aggregator swap would instead revert
    /// `navWad`, `deposit` and `requestExit` alike — already demonstrated by
    /// `ChainlinkOracleVaultIntegrationTest::test_staleFeedFreezesDepositsAndExits` — and nothing
    /// on-chain could lift it. Mispricing is recoverable by leaving; a freeze is not.
    function test_harmModel_driftDoesNotRobAnExitingMember() public {
        DriftVaultFixture f = new DriftVaultFixture();
        (VaultCore vault, MockERC20 weth, MockAggregatorV3 feed, address alice) = f.build();

        uint256 shares = vault.sharesOf(alice);
        uint256 vaultWethBefore = weth.balanceOf(address(vault));
        assertGt(vaultWethBefore, 0, "fixture holds a basket position");

        // Aggregator swap: 9 decimals now, so NAV reads 10x high for the wETH leg.
        uint256 navBefore = vault.navWad();
        feed.setDecimals(9);
        feed.set(2500e9, block.timestamp);
        assertGt(vault.navWad(), navBefore, "NAV is now mis-stated by the drift");

        // The sole holder exits: pro-rata is 100%, and it lands in full despite the wrong price.
        vm.prank(alice);
        vault.requestExit(shares);

        assertEq(vault.sharesOf(alice), 0, "exit settles under drift -- no freeze");
        assertEq(
            weth.balanceOf(alice),
            vaultWethBefore,
            "member received their FULL basket slice, unaffected by the drift"
        );
        assertEq(vault.assetBalance(address(weth)), 0, "and the vault paid all of it out");
    }
}

/// @dev A minimal VaultCore priced by a ChainlinkOracle, built in a helper contract so the drift
/// suite above stays readable. Mirrors ChainlinkOracleVaultIntegrationTest's fixture exactly.
contract DriftVaultFixture is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;

    function build()
        external
        returns (VaultCore vault, MockERC20 weth, MockAggregatorV3 feed, address alice)
    {
        MockERC20 usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        feed = new MockAggregatorV3(8, 2500e8, block.timestamp);

        address[] memory assets = new address[](1);
        assets[0] = address(weth);
        address[] memory feeds = new address[](1);
        feeds[0] = address(feed);
        uint32[] memory hb = new uint32[](1);
        hb[0] = 3600;
        uint256[] memory z = new uint256[](1); // band disabled: isolate the drift, not the backstop
        ChainlinkOracle oracle = new ChainlinkOracle(assets, feeds, hb, z, z, address(usdc), address(0));

        vault = new VaultCore(
            address(usdc),
            assets,
            address(this),
            new StubRegistry(),
            new StubGovernance(),
            new StubFeeEngine(),
            oracle,
            0,
            10 * USDC_1,
            0,
            0,
            new address[](0),
            address(0)
        );

        alice = makeAddr("drift-alice");
        usdc.mint(alice, 1_000_000 * USDC_1);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000 * USDC_1);
        vault.skipWindow();
        vm.stopPrank();

        // Simulate a settled rebalance: $500k idle becomes 200 wETH @ $2,500.
        weth.mint(address(vault), 200e18);
        stdstore.target(address(vault)).sig("assetBalance(address)").with_key(address(weth))
            .checked_write(200e18);
        stdstore.target(address(vault)).sig("idleUsdc()").checked_write(vault.idleUsdc() - 500_000 * USDC_1);
    }
}
