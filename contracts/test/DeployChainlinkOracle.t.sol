// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployChainlinkOracle} from "../script/DeployChainlinkOracle.s.sol";
import {ChainlinkOracle} from "../src/oracle/ChainlinkOracle.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";

/// Proves the L2 sequencer guard in the curated-oracle deploy script is L2-GENERIC and FAIL-CLOSED.
///
/// The rule under test (`DeployChainlinkOracle.requiresSequencerUptimeFeed`): the L2 sequencer uptime
/// feed is mandatory on EVERY chain except an allowlist of ids known to have none — local 31337;
/// Base Sepolia 84532, whose committed config leaves `sequencerUptimeFeed` empty by design; and
/// Robinhood Chain 4663, for which Chainlink publishes no uptime feed (owner-approved 2026-09-04;
/// the doc comment on ROBINHOOD_CHAIN_ID in the script states what the exemption costs at price
/// time); Arc 5042 (an L1); and, by owner decision 2026-10-18, Ethereum 1 (the L1 the rollups settle
/// to) and Polygon 137 (a validator-set sidechain with no Chainlink sequencer feed). The allowlist replaces a DENYLIST of one id (`block.chainid != 8453`) under which a deploy to any other L2 — or
/// to a mis-pointed RPC — silently produced an IMMUTABLE oracle with the sequencer guard off, free to
/// serve prices computed while that chain's sequencer was down.
///
/// Env note: the sequencer address is passed through `runWithSequencer` rather than ORACLE_SEQUENCER,
/// because forge runs a suite's test functions in PARALLEL against process-global env vars — a test
/// that exported a different value than its neighbours would be flaky by construction. The basket
/// arrays are still env (the script's only source for them), so setUp writes them ONCE and no test
/// mutates them; every test then sees the same basket. `run()` is covered too: it is a one-line
/// delegation to `runWithSequencer`, and `test_envEntrypointIsGuardedToo` exercises it.
contract DeployChainlinkOracleTest is Test {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant ETH_USD_FEED = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;
    address constant SEQUENCER_FEED = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433; // Base's real uptime feed
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    string constant SEQUENCER_REQUIRED_REVERT =
        "DeployChainlinkOracle: ORACLE_SEQUENCER (L2 sequencer uptime feed) is required on every chain except local 31337, Base Sepolia 84532, Robinhood Chain 4663, Arc 5042, Ethereum 1 and Polygon 137";

    DeployChainlinkOracle script;

    /// @dev One priceable asset is enough — the guard under test is about the sequencer, not the
    /// basket. ORACLE_SEQUENCER is pinned to the zero address so a value in the developer's own shell
    /// cannot satisfy the guard behind the tests' back.
    function setUp() public {
        vm.warp(1_700_000_000);
        script = new DeployChainlinkOracle();
        vm.setEnv("ORACLE_ASSETS", vm.toString(WETH));
        vm.setEnv("ORACLE_FEEDS", vm.toString(ETH_USD_FEED));
        vm.setEnv("ORACLE_HEARTBEATS", "86400");
        // A real band around the mock price (1917 USD): `requiresSanePriceBand` makes one mandatory on
        // every chain except local 31337 and Base Sepolia, so a band-less env would fail the deploys
        // below for the wrong reason. Band absence is tested through `deployWith`, which takes
        // arguments instead of this process-global env.
        vm.setEnv("ORACLE_MIN_WAD", "100000000000000000000");
        vm.setEnv("ORACLE_MAX_WAD", "100000000000000000000000");
        vm.setEnv("ORACLE_USDC", vm.toString(USDC));
        vm.setEnv("ORACLE_SEQUENCER", vm.toString(address(0)));
    }

    /// @dev AggregatorV3 stub: the ChainlinkOracle constructor decode-proves decimals() and
    /// latestRoundData() on every asset feed AND on the sequencer feed, and additionally proves the
    /// USD quote leg from description() on ASSET feeds. The stub answers "ETH / USD" because these
    /// tests are about the CHAIN-ID guard, not denomination — AuditFeedDenomination.t.sol owns that
    /// check. Without it the deploy reverts before any chain-id assertion is reached.
    function _mockFeed(address feed, int256 answer) internal {
        vm.etch(feed, hex"00"); // mockCall requires code at the address
        vm.mockCall(feed, abi.encodeWithSignature("decimals()"), abi.encode(uint8(8)));
        vm.mockCall(feed, abi.encodeWithSignature("description()"), abi.encode("ETH / USD"));
        vm.mockCall(
            feed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), answer, uint256(block.timestamp), block.timestamp, uint80(1))
        );
    }

    // ─────────────────────────── the classification itself ───────────────────────────

    /// @notice Fail-closed by construction: the ONLY exempt ids are the six known-feedless ones,
    /// and every other id — Base mainnet, other L2 mainnets, testnets this script has never seen,
    /// and a garbage id from a wrong RPC — requires the feed.
    function test_requiresSequencerUptimeFeedIsAnAllowlist() public view {
        assertFalse(script.requiresSequencerUptimeFeed(31337), "local 31337 exempt");
        assertFalse(script.requiresSequencerUptimeFeed(84532), "Base Sepolia 84532 exempt");
        assertFalse(script.requiresSequencerUptimeFeed(4663), "Robinhood Chain 4663 exempt");
        assertTrue(script.requiresSequencerUptimeFeed(8453), "Base mainnet required");
        assertTrue(script.requiresSequencerUptimeFeed(10), "Optimism mainnet required");
        assertTrue(script.requiresSequencerUptimeFeed(42161), "Arbitrum One required");
        assertFalse(script.requiresSequencerUptimeFeed(5042), "Arc 5042 exempt (an L1)");
        assertFalse(script.requiresSequencerUptimeFeed(1), "Ethereum 1 exempt (an L1, owner 2026-10-18)");
        assertFalse(script.requiresSequencerUptimeFeed(137), "Polygon 137 exempt (owner 2026-10-18)");
        assertTrue(script.requiresSequencerUptimeFeed(2), "an id adjacent to Ethereum required");
        assertTrue(script.requiresSequencerUptimeFeed(0), "id 0 required");
        assertTrue(script.requiresSequencerUptimeFeed(136), "an id just below Polygon required");
        assertTrue(script.requiresSequencerUptimeFeed(138), "an id just above Polygon required");
        assertTrue(script.requiresSequencerUptimeFeed(80002), "Polygon Amoy testnet required (unlisted)");
        assertTrue(script.requiresSequencerUptimeFeed(11155420), "an unlisted testnet required");
        assertTrue(script.requiresSequencerUptimeFeed(999_999_999), "an unknown id required");
        assertTrue(
            script.requiresSequencerUptimeFeed(4664),
            "an id adjacent to Robinhood Chain required (the exemption is one id, not a range)"
        );
    }

    // ─────────────────────────── the deploys that must be refused ───────────────────────────

    /// @notice The case the old denylist let through: chainid 10 (Optimism mainnet) is not 8453, so
    /// `block.chainid != 8453` waved it past — and shipped an oracle with no sequencer guard at all.
    function test_otherL2MainnetRequiresSequencerFeed() public {
        vm.chainId(10);
        vm.expectRevert(bytes(SEQUENCER_REQUIRED_REVERT));
        script.runWithSequencer(address(0));
    }

    /// @notice An unrecognized chain id (a mis-pointed RPC) fails closed rather than fails open.
    function test_unknownChainRequiresSequencerFeed() public {
        vm.chainId(424_242);
        vm.expectRevert(bytes(SEQUENCER_REQUIRED_REVERT));
        script.runWithSequencer(address(0));
    }

    /// @notice Regression on the one case the denylist did get right: Base mainnet still refuses. The
    /// asset feeds are deliberately left unmocked here — the guard runs before any basket config is
    /// read, so this must fail on the sequencer rule, not on a later incidental config complaint.
    function test_baseMainnetStillRequiresSequencerFeed() public {
        vm.chainId(8453);
        vm.expectRevert(bytes(SEQUENCER_REQUIRED_REVERT));
        script.runWithSequencer(address(0));
    }

    /// @notice The env entrypoint carries the identical guard — `run()` cannot be the unguarded way
    /// in. (setUp pins ORACLE_SEQUENCER to the zero address, so this is the "operator forgot it" path.)
    function test_envEntrypointIsGuardedToo() public {
        vm.chainId(8453);
        vm.expectRevert(bytes(SEQUENCER_REQUIRED_REVERT));
        script.run();
    }

    // ─────────────────────────── the deploys that must still work ───────────────────────────

    /// @notice Base Sepolia deploys with NO sequencer feed — the committed testnet design
    /// (`config/base-sepolia.json` -> chainlinkOracle.sequencerUptimeFeed: ""). The hardening must not
    /// break the one chain this protocol actually deploys to today.
    function test_baseSepoliaDeploysWithoutSequencerFeed() public {
        vm.chainId(84532);
        _mockFeed(ETH_USD_FEED, 1917e8);
        ChainlinkOracle oracle = script.runWithSequencer(address(0));
        assertEq(address(oracle.sequencerUptimeFeed()), address(0), "no uptime feed on the testnet");
        assertEq(oracle.priceWad(WETH), 1917e18, "prices without the guard");
    }

    /// @notice Local 31337 (anvil / forge) likewise deploys with no sequencer feed.
    function test_localChainDeploysWithoutSequencerFeed() public {
        vm.chainId(31337);
        _mockFeed(ETH_USD_FEED, 1917e8);
        ChainlinkOracle oracle = script.runWithSequencer(address(0));
        assertEq(address(oracle.sequencerUptimeFeed()), address(0), "no uptime feed locally");
    }

    /// @notice Robinhood Chain 4663 deploys with NO sequencer feed, and the oracle it produces
    /// prices anyway — the exemption's cost, pinned rather than described. Chainlink publishes no
    /// uptime feed for this chain, so the fail-closed default would refuse the deploy outright;
    /// the owner approved the weakening on 2026-09-04. The second assertion is the point: with
    /// `sequencerUptimeFeed` at address(0), `_requireSequencerUp` returns early and `priceWad`
    /// answers, so nothing here would revert during a sequencer outage on this chain.
    function test_robinhoodChainDeploysWithoutSequencerFeed() public {
        vm.chainId(4663);
        _mockFeed(ETH_USD_FEED, 1917e8);
        ChainlinkOracle oracle = script.runWithSequencer(address(0));
        assertEq(address(oracle.sequencerUptimeFeed()), address(0), "no uptime feed on Robinhood Chain");
        assertEq(oracle.priceWad(WETH), 1917e18, "prices with no sequencer gate at all");
    }

    /// @notice Arc deploys with no uptime feed, which is the point of the owner's 2026-09-19
    /// exemption: Arc is an L1, so there is no sequencer whose uptime could be reported and Chainlink
    /// publishes no feed to supply. Before this entry `forge script DeployChainlinkOracle` reverted on
    /// 5042 and the Arc deploy could not run at all.
    function test_arcDeploysWithoutSequencerFeed() public {
        vm.chainId(5042);
        _mockFeed(ETH_USD_FEED, 1917e8);
        ChainlinkOracle oracle = script.runWithSequencer(address(0));
        assertEq(address(oracle.sequencerUptimeFeed()), address(0), "no uptime feed on Arc");
        assertEq(oracle.priceWad(WETH), 1917e18, "prices with no sequencer gate at all");
    }

    /// @notice Scoped to the one id, same as Robinhood's: 5043 still fails closed. A range, an
    /// off-by-one or a `>=` would pass both allowlist assertions and fail here.
    function test_chainAdjacentToArcStillRequiresSequencerFeed() public {
        vm.chainId(5043);
        vm.expectRevert(bytes(SEQUENCER_REQUIRED_REVERT));
        script.runWithSequencer(address(0));
    }

    /// @notice The exemption is scoped to the one id: an ADJACENT id still fails closed. A range or
    /// a typo'd comparison would pass the allowlist test above and fail here.
    function test_chainAdjacentToRobinhoodStillRequiresSequencerFeed() public {
        vm.chainId(4664);
        vm.expectRevert(bytes(SEQUENCER_REQUIRED_REVERT));
        script.runWithSequencer(address(0));
    }

    /// @notice Supplying the feed satisfies the guard on a chain that requires it, and the feed is
    /// wired into the immutable oracle — the fail-closed default costs an operator one argument, not
    /// a deploy.
    function test_requiredChainDeploysWhenSequencerFeedSupplied() public {
        vm.chainId(10); // an L2 with no allowlist entry: the feed is mandatory here
        _mockFeed(ETH_USD_FEED, 1917e8);
        _mockFeed(SEQUENCER_FEED, 0); // 0 == sequencer up
        ChainlinkOracle oracle = script.runWithSequencer(SEQUENCER_FEED);
        assertEq(address(oracle.sequencerUptimeFeed()), SEQUENCER_FEED, "uptime feed wired");
        (IAggregatorV3 feed,,,,) = oracle.feedOf(WETH);
        assertEq(address(feed), ETH_USD_FEED, "asset feed wired");
    }

    // ───────────── Ethereum 1 and Polygon 137 (owner decision 2026-10-18) ─────────────

    /// @notice Ethereum deploys with no uptime feed: it is an L1, so there is no sequencer. Pinned
    /// like Arc's: the oracle prices with no sequencer gate, which is the cost the entry records.
    function test_ethereumDeploysWithoutSequencerFeed() public {
        vm.chainId(1);
        _mockFeed(ETH_USD_FEED, 1917e8);
        ChainlinkOracle oracle = script.runWithSequencer(address(0));
        assertEq(address(oracle.sequencerUptimeFeed()), address(0), "no uptime feed on Ethereum");
        assertEq(oracle.priceWad(WETH), 1917e18, "prices with no sequencer gate at all");
    }

    /// @notice Polygon PoS deploys with no uptime feed (validator sidechain, no Chainlink feed).
    function test_polygonDeploysWithoutSequencerFeed() public {
        vm.chainId(137);
        _mockFeed(ETH_USD_FEED, 1917e8);
        ChainlinkOracle oracle = script.runWithSequencer(address(0));
        assertEq(address(oracle.sequencerUptimeFeed()), address(0), "no uptime feed on Polygon");
        assertEq(oracle.priceWad(WETH), 1917e18, "prices with no sequencer gate at all");
    }

    /// @notice Arbitrum One is NOT exempt (Base is covered above): Chainlink publishes a sequencer feed, so
    /// the deploy refuses without one. The exemption is for the two chains the owner named.
    function test_arbitrumIsNotExempt() public {
        vm.chainId(42161);
        vm.expectRevert(bytes(SEQUENCER_REQUIRED_REVERT));
        script.runWithSequencer(address(0));
    }

    function test_chainsAdjacentToEthereumAndPolygonStillRequireSequencerFeed() public {
        vm.chainId(2);
        vm.expectRevert(bytes(SEQUENCER_REQUIRED_REVERT));
        script.runWithSequencer(address(0));
        vm.chainId(138);
        vm.expectRevert(bytes(SEQUENCER_REQUIRED_REVERT));
        script.runWithSequencer(address(0));
    }

    // ───────────── the sane-price band is mandatory on every mainnet ─────────────

    string constant BAND_REQUIRED_REVERT =
        "DeployChainlinkOracle: a sane-price band per asset is required on every chain except local 31337 and Base Sepolia 84532";

    function _basket(uint256 minW, uint256 maxW)
        internal
        pure
        returns (
            address[] memory a,
            address[] memory f,
            uint256[] memory hb,
            uint256[] memory mn,
            uint256[] memory mx
        )
    {
        a = new address[](1);
        f = new address[](1);
        hb = new uint256[](1);
        mn = new uint256[](1);
        mx = new uint256[](1);
        a[0] = WETH;
        f[0] = ETH_USD_FEED;
        hb[0] = 86400;
        mn[0] = minW;
        mx[0] = maxW;
    }

    function _deployWith(uint256 minW, uint256 maxW) internal returns (ChainlinkOracle) {
        (
            address[] memory a,
            address[] memory f,
            uint256[] memory hb,
            uint256[] memory mn,
            uint256[] memory mx
        ) = _basket(minW, maxW);
        return script.deployWith(SEQUENCER_FEED, a, f, hb, mn, mx, USDC);
    }

    /// @notice Allowlist shape: only local and Base Sepolia may omit the band; everything else,
    /// including an id the script has never seen, needs it.
    function test_requiresSanePriceBandIsAnAllowlist() public view {
        assertFalse(script.requiresSanePriceBand(31337), "local may omit");
        assertFalse(script.requiresSanePriceBand(84532), "Base Sepolia may omit");
        uint256[9] memory mainnets = [uint256(1), 137, 8453, 42161, 5042, 4663, 10, 11155111, 999_999_999];
        for (uint256 i; i < mainnets.length; ++i) {
            assertTrue(script.requiresSanePriceBand(mainnets[i]), "band required");
        }
    }

    /// @notice A band-less deploy is refused on each of the five launch chains, with both halves of
    /// the band (a floor alone or a ceiling alone is no band).
    function test_bandlessDeployRefusedOnEveryMainnet() public {
        uint256[5] memory ids = [uint256(5042), 8453, 42161, 1, 137];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            _mockFeed(ETH_USD_FEED, 1917e8);
            _mockFeed(SEQUENCER_FEED, 0);
            vm.expectRevert(bytes(BAND_REQUIRED_REVERT));
            _deployWith(0, 0);
            vm.expectRevert(bytes(BAND_REQUIRED_REVERT));
            _deployWith(100e18, 0);
            vm.expectRevert(bytes(BAND_REQUIRED_REVERT));
            _deployWith(0, 100_000e18);
        }
    }

    /// @notice An id this script has never seen fails closed: a mis-pointed RPC cannot ship a band-less oracle.
    function test_bandlessDeployRefusedOnAnUnknownChain() public {
        vm.chainId(424_242);
        _mockFeed(ETH_USD_FEED, 1917e8);
        _mockFeed(SEQUENCER_FEED, 0);
        vm.expectRevert(bytes(BAND_REQUIRED_REVERT));
        _deployWith(0, 0);
    }

    /// @notice The local chain and Base Sepolia still deploy band-less (the design for tests and the testnet).
    function test_bandlessDeployStillWorksOnLocalAndBaseSepolia() public {
        _mockFeed(ETH_USD_FEED, 1917e8);
        _mockFeed(SEQUENCER_FEED, 0);
        vm.chainId(31337);
        assertEq(address(_deployWith(0, 0).sequencerUptimeFeed()), SEQUENCER_FEED, "local deploys");
        vm.chainId(84532);
        assertEq(address(_deployWith(0, 0).sequencerUptimeFeed()), SEQUENCER_FEED, "Base Sepolia deploys");
    }

    /// @notice With a band, every launch chain deploys.
    function test_bandedDeployWorksOnEveryMainnet() public {
        uint256[5] memory ids = [uint256(5042), 8453, 42161, 1, 137];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            _mockFeed(ETH_USD_FEED, 1917e8);
            _mockFeed(SEQUENCER_FEED, 0);
            ChainlinkOracle oracle = _deployWith(100e18, 100_000e18);
            (,,, uint128 mn, uint128 mx) = oracle.feedOf(WETH);
            assertEq(mn, 100e18, "band floor wired");
            assertEq(mx, 100_000e18, "band ceiling wired");
        }
    }
}
