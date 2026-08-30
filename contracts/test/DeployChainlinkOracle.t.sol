// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployChainlinkOracle} from "../script/DeployChainlinkOracle.s.sol";
import {ChainlinkOracle} from "../src/oracle/ChainlinkOracle.sol";
import {IAggregatorV3} from "../src/OracleAggregator.sol";

/// Proves the L2 sequencer guard in the curated-oracle deploy script is L2-GENERIC and FAIL-CLOSED.
///
/// The rule under test (`DeployChainlinkOracle.requiresSequencerUptimeFeed`): the L2 sequencer uptime
/// feed is mandatory on EVERY chain except an allowlist of ids known to have none — local 31337 and
/// Base Sepolia 84532, whose committed config leaves `sequencerUptimeFeed` empty by design. It
/// replaces a DENYLIST of one id (`block.chainid != 8453`) under which a deploy to any other L2 — or
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
        "DeployChainlinkOracle: ORACLE_SEQUENCER (L2 sequencer uptime feed) is required on every chain except local 31337 and Base Sepolia 84532";

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
        vm.setEnv("ORACLE_MIN_WAD", "0");
        vm.setEnv("ORACLE_MAX_WAD", "0");
        vm.setEnv("ORACLE_USDC", vm.toString(USDC));
        vm.setEnv("ORACLE_SEQUENCER", vm.toString(address(0)));
    }

    /// @dev AggregatorV3 stub: the ChainlinkOracle constructor decode-proves decimals() and
    /// latestRoundData() on every asset feed AND on the sequencer feed.
    function _mockFeed(address feed, int256 answer) internal {
        vm.etch(feed, hex"00"); // mockCall requires code at the address
        vm.mockCall(feed, abi.encodeWithSignature("decimals()"), abi.encode(uint8(8)));
        vm.mockCall(
            feed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), answer, uint256(block.timestamp), block.timestamp, uint80(1))
        );
    }

    // ─────────────────────────── the classification itself ───────────────────────────

    /// @notice Fail-closed by construction: the ONLY exempt ids are the two known-feedless ones, and
    /// every other id — Base mainnet, other L2 mainnets, testnets this script has never seen, and a
    /// garbage id from a wrong RPC — requires the feed.
    function test_requiresSequencerUptimeFeedIsAnAllowlist() public view {
        assertFalse(script.requiresSequencerUptimeFeed(31337), "local 31337 exempt");
        assertFalse(script.requiresSequencerUptimeFeed(84532), "Base Sepolia 84532 exempt");
        assertTrue(script.requiresSequencerUptimeFeed(8453), "Base mainnet required");
        assertTrue(script.requiresSequencerUptimeFeed(10), "Optimism mainnet required");
        assertTrue(script.requiresSequencerUptimeFeed(42161), "Arbitrum One required");
        assertTrue(
            script.requiresSequencerUptimeFeed(1), "Ethereum mainnet required (not a rollup: review it)"
        );
        assertTrue(script.requiresSequencerUptimeFeed(11155420), "an unlisted testnet required");
        assertTrue(script.requiresSequencerUptimeFeed(999_999_999), "an unknown id required");
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
}
