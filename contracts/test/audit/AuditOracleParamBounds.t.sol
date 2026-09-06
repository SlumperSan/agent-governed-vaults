// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

/// @notice AUDIT ARTIFACT — the pre-mainnet completeness-critic finding that {ChainlinkOracle}'s
/// `heartbeatSeconds` and sane-price band were bounded ONLY off-chain, by
/// `scripts/verify-chainlink-oracle.mjs`. Nothing on-chain stopped a deployer shipping an oracle
/// whose staleness guard could never fire (a 100-year heartbeat) or whose band admitted any value,
/// and the config is immutable, so the mistake is permanent. Finding C-2's shape exactly, and the
/// same class PR #69 closed for the `uint32` heartbeat downcast.
///
/// WHERE THE CHECKS LIVE, and why that is not the AuditProposalThresholdFloor mistake:
///
/// That precedent reverted a constructor-enforced floor on `proposalThresholdBps`. Its real test
/// is two questions, not "constructors must not enforce bounds": can the constructor OBSERVE what
/// makes the value right, and does a wrong bound produce a POST-deploy freeze or a PRE-deploy
/// error? The threshold floor failed both — it depended on live stake distribution no constructor
/// can see, and it produced a permanent, self-locking liveness cliff after deployment.
///
/// The heartbeat and band-SHAPE bounds pass both. The constructor already reads the feed (it calls
/// `decimals()` and `latestRoundData()` on it), the values are static deploy-time facts, and a
/// rejection happens before the contract exists — the remedy is "fix the env var and redeploy",
/// not "wait for members to exit". So they go in the constructor.
///
/// The precedent DOES bite once, and the design respects it: there is no MINIMUM band width. A
/// band's correct width is a function of the asset's volatility class, which the constructor
/// cannot observe — a floor sized for ETH would forbid the correct ~1.2x band for the USDC/USD
/// feed {ChainlinkOracle} explicitly offers as an alternative to the $1 pin, and a too-tight band
/// freezes the vault permanently once price moves. What replaces it is observable: the feed's own
/// current answer must fall inside the band.
///
/// Two checks therefore live OUTSIDE the constructor, each with the layer that can see it:
///   - band PRESENCE on Base mainnet — chain policy, in `DeployChainlinkOracle.s.sol` beside the
///     existing mandatory-sequencer gate (local/testnet/tests deploy bandless by design);
///   - feed LIVENESS (fresh now) — in `scripts/verify-chainlink-oracle.mjs`, which has an RPC.
contract AuditOracleParamBoundsTest is Test {
    address constant ASSET = address(0xE7);

    // The bounds under test, mirrored from ChainlinkOracle's private constants.
    uint32 constant MIN_HEARTBEAT = 600;
    uint32 constant MAX_HEARTBEAT = 86_400;
    uint256 constant MAX_BAND_RATIO = 1000;

    function setUp() public {
        vm.warp(1_000_000); // a clock comfortably larger than any heartbeat
    }

    // --- helpers -----------------------------------------------------------

    function _build(address feed, uint32 heartbeat, uint256 lo, uint256 hi)
        internal
        returns (ChainlinkOracle)
    {
        address[] memory assets = new address[](1);
        assets[0] = ASSET;
        address[] memory feeds = new address[](1);
        feeds[0] = feed;
        uint32[] memory hb = new uint32[](1);
        hb[0] = heartbeat;
        uint256[] memory mn = new uint256[](1);
        mn[0] = lo;
        uint256[] memory mx = new uint256[](1);
        mx[0] = hi;
        return new ChainlinkOracle(assets, feeds, hb, mn, mx, address(0), address(0));
    }

    /// An 8-decimal feed reporting $2,500 — inside every band used below unless stated otherwise.
    function _feed() internal returns (address) {
        return address(new MockAggregatorV3(8, 2500e8, block.timestamp));
    }

    function _expectBadConfig() internal {
        vm.expectRevert(ChainlinkOracle.BadOracleConfig.selector);
    }

    // --- heartbeat: too loose ---------------------------------------------

    /// @notice THE FINDING. A 100-year staleness bound leaves the guard in the bytecode and makes
    /// it unable to ever fire: `updatedAt` can never be older than the window, so a frozen feed
    /// prices forever. Before this change the only on-chain bound was `> 0`, so a `uint32` gave a
    /// deployer 136 years of room.
    function test_heartbeatCenturyIsRejected() public {
        address feed = _feed();
        _expectBadConfig();
        _build(feed, 100 * 365 days, 0, 0);
    }

    function test_heartbeatOneSecondOverTheCeilingIsRejected() public {
        address feed = _feed();
        _expectBadConfig();
        _build(feed, MAX_HEARTBEAT + 1, 0, 0);
    }

    /// @notice The ceiling is INCLUSIVE, because Base Sepolia's documented 24h bound sits exactly
    /// on it. A ceiling below 86_400 would break testnet deploys, which is not an acceptable price.
    function test_heartbeatAtTheCeilingIsAccepted() public {
        ChainlinkOracle oracle = _build(_feed(), MAX_HEARTBEAT, 0, 0);
        assertEq(oracle.priceWad(ASSET), 2500e18, "the testnet bound still deploys and prices");
    }

    // --- heartbeat: too tight ---------------------------------------------

    /// @notice A bound under the feed's real update cadence freezes the asset against a HEALTHY
    /// feed — and because config is immutable, forever. Measured on Base 2026-08-29, more than half
    /// of the observed inter-update intervals of all four configured feeds exceed 600s.
    function test_heartbeatOneSecondUnderTheFloorIsRejected() public {
        address feed = _feed();
        _expectBadConfig();
        _build(feed, MIN_HEARTBEAT - 1, 0, 0);
    }

    /// @notice A dropped zero — 3600 typed as 360 — is the realistic version of the same mistake.
    function test_heartbeatDroppedZeroIsRejected() public {
        address feed = _feed();
        _expectBadConfig();
        _build(feed, 360, 0, 0);
    }

    function test_heartbeatAtTheFloorIsAccepted() public {
        ChainlinkOracle oracle = _build(_feed(), MIN_HEARTBEAT, 0, 0);
        assertEq(oracle.priceWad(ASSET), 2500e18, "the floor itself is a usable bound");
    }

    /// @notice The pre-existing `> 0` guard is subsumed, not lost.
    function test_heartbeatZeroIsStillRejected() public {
        address feed = _feed();
        _expectBadConfig();
        _build(feed, 0, 0, 0);
    }

    // --- band: too loose --------------------------------------------------

    /// @notice A band spanning to the top of `uint128` is the band-side version of the finding:
    /// present, and unable to reject anything. The floor is $1 so the feed's $2,500 sits INSIDE the
    /// band — the width bound is the only one that can fire here, which is the point of the case.
    function test_bandSpanningEverythingIsRejected() public {
        address feed = _feed();
        _expectBadConfig();
        _build(feed, 3600, 1e18, type(uint128).max);
    }

    function test_bandOneStepWiderThanTheRatioCeilingIsRejected() public {
        address feed = _feed();
        _expectBadConfig();
        _build(feed, 3600, 100e18, 100e18 * MAX_BAND_RATIO + 1);
    }

    /// @notice Exactly 1000x is accepted: it is the width every asset in both shipped configs uses,
    /// so the ceiling is the tightest value that rejects nothing already reviewed.
    function test_bandAtExactlyTheRatioCeilingIsAccepted() public {
        ChainlinkOracle oracle = _build(_feed(), 3600, 100e18, 100e18 * MAX_BAND_RATIO);
        assertEq(oracle.priceWad(ASSET), 2500e18, "the shipped band width still deploys");
    }

    /// @notice THE HOLE THIS CLOSES. `[0, hi]` passed the old `hi == 0 ? lo == 0 : lo <= hi` check
    /// and produced a ceiling-only band — which guards the wrong side. The failure the band exists
    /// for is a deprecated `minAnswer` clamp, and a clamp is a LOW value: under `[0, 100_000e18]`
    /// a feed reporting 1 wei of a dollar reads as perfectly sane.
    function test_ceilingOnlyBandIsRejected() public {
        address feed = _feed();
        _expectBadConfig();
        _build(feed, 3600, 0, 100_000e18);
    }

    // --- band: too tight --------------------------------------------------

    /// @notice A degenerate band admits exactly one price, for any asset — a brick that needs no
    /// view on volatility to recognise. `lo <= hi` allowed it; `lo < hi` does not.
    function test_degenerateSinglePriceBandIsRejected() public {
        address feed = _feed();
        _expectBadConfig();
        _build(feed, 3600, 2500e18, 2500e18);
    }

    /// @notice The observable "too tight" test: a band that already excludes the price the feed is
    /// reporting is broken on arrival — the oracle would revert on its very first read.
    function test_bandEntirelyAboveTheLivePriceIsRejected() public {
        address feed = _feed(); // $2,500
        _expectBadConfig();
        _build(feed, 3600, 3000e18, 300_000e18);
    }

    function test_bandEntirelyBelowTheLivePriceIsRejected() public {
        address feed = _feed(); // $2,500
        _expectBadConfig();
        _build(feed, 3600, 1e18, 1000e18);
    }

    /// @notice The same check catches the realistic version: a band written in the FEED's decimals
    /// instead of WAD. `100e8 .. 100_000e8` is the mainnet WETH band off by 1e10.
    function test_bandWrittenInFeedDecimalsInsteadOfWadIsRejected() public {
        address feed = _feed();
        _expectBadConfig();
        _build(feed, 3600, 100e8, 100_000e8);
    }

    /// @notice And a band copied from the wrong asset — cbBTC's $1k..$1m applied to an ETH feed.
    function test_bandCopiedFromAnotherAssetIsRejected() public {
        address feed = _feed(); // $2,500 — below cbBTC's floor
        _expectBadConfig();
        _build(feed, 3600, 1000e18 * 1000, 1_000_000e18 * 1000);
    }

    /// @notice A disabled band (0,0) is still a supported configuration — testnet, local and the
    /// existing suite rely on it, and PRESENCE is enforced on mainnet by the deploy script.
    function test_disabledBandIsStillAccepted() public {
        ChainlinkOracle oracle = _build(_feed(), 3600, 0, 0);
        assertEq(oracle.priceWad(ASSET), 2500e18, "bandless deploys are unchanged");
    }

    // --- every shipped configuration still deploys ------------------------

    /// @dev Live 8-decimal answers read from Base on 2026-08-29 via `cast call latestRoundData()`,
    /// the same session that measured the update cadence behind MIN_HEARTBEAT. Keyed by the config
    /// `symbol`, so adding an asset to a config fails this test until a real answer is recorded
    /// for it rather than silently skipping the new entry.
    function _verifiedSpot8(string memory chain, string memory symbol) internal pure returns (int256) {
        bytes32 k = keccak256(abi.encodePacked(chain, "/", symbol));
        if (k == keccak256("base-mainnet/WETH")) return 246_338_995_910; // ETH/USD $2,463.39
        if (k == keccak256("base-mainnet/cbBTC")) return 7_824_489_206_691; // BTC/USD $78,244.89
        if (k == keccak256("base-sepolia/WETH")) return 246_205_326_009; // ETH/USD $2,462.05
        if (k == keccak256("base-sepolia/LINK")) return 1_142_708_481; // LINK/USD $11.4271
        revert("no verified spot recorded for this config asset");
    }

    /// @dev Deploys a ChainlinkOracle over EVERY asset in a real config file, with each feed mocked
    /// at its on-chain-verified answer. Reads the files rather than copying their numbers, so a
    /// config edit that violates a bound fails here instead of at `--broadcast`.
    function _assertConfigDeploys(string memory chain) internal {
        string memory json = vm.readFile(string.concat("config/", chain, ".json"));

        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".chainlinkOracle.assets[", vm.toString(n), "].asset"))) {
            ++n;
        }
        assertGt(n, 0, "config lists at least one asset");

        address[] memory assets = new address[](n);
        address[] memory feeds = new address[](n);
        uint32[] memory hb = new uint32[](n);
        uint256[] memory mn = new uint256[](n);
        uint256[] memory mx = new uint256[](n);

        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".chainlinkOracle.assets[", vm.toString(i), "]");
            string memory symbol = vm.parseJsonString(json, string.concat(base, ".symbol"));
            assets[i] = vm.parseJsonAddress(json, string.concat(base, ".asset"));
            hb[i] = uint32(vm.parseJsonUint(json, string.concat(base, ".heartbeatSeconds")));
            // The WAD bounds exceed JSON's safe integer range, so the config quotes them.
            mn[i] = vm.parseUint(vm.parseJsonString(json, string.concat(base, ".minPriceWad")));
            mx[i] = vm.parseUint(vm.parseJsonString(json, string.concat(base, ".maxPriceWad")));
            feeds[i] = address(new MockAggregatorV3(8, _verifiedSpot8(chain, symbol), block.timestamp));
        }

        // The real deployment shape: USDC pinned, no feed listed for it. The sequencer feed is left
        // unset here because the mainnet one is a live L2 contract, not a config bound — it is
        // exercised against a mock in ChainlinkOracle.t.sol.
        ChainlinkOracle oracle = new ChainlinkOracle(assets, feeds, hb, mn, mx, address(0), address(0));

        for (uint256 i; i < n; ++i) {
            (, uint32 storedHb,,,) = oracle.feedOf(assets[i]);
            assertEq(storedHb, hb[i], "the configured heartbeat survives construction unchanged");
            assertGt(oracle.priceWad(assets[i]), 0, "every configured asset prices");
        }
    }

    /// @notice Both shipped configs must keep deploying. Base Sepolia is the load-bearing case: its
    /// 86_400 heartbeat is a DOCUMENTED asymmetry (testnet feeds have no economic SLA, so a tight
    /// bound would false-freeze a soak on feed flakiness), and it is what pins the ceiling.
    function test_baseSepoliaConfigStillDeploys() public {
        _assertConfigDeploys("base-sepolia");
    }

    function test_baseMainnetConfigStillDeploys() public {
        _assertConfigDeploys("base-mainnet");
    }
}
