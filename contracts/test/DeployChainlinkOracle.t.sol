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
/// time). The allowlist replaces a DENYLIST of one id (`block.chainid != 8453`) under which a deploy to any other L2 — or
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
        "DeployChainlinkOracle: ORACLE_SEQUENCER (L2 sequencer uptime feed) is required on every chain except local 31337, Base Sepolia 84532 and Robinhood Chain 4663";

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

    /// @notice Fail-closed by construction: the ONLY exempt ids are the three known-feedless ones,
    /// and every other id — Base mainnet, other L2 mainnets, testnets this script has never seen,
    /// and a garbage id from a wrong RPC — requires the feed.
    function test_requiresSequencerUptimeFeedIsAnAllowlist() public view {
        assertFalse(script.requiresSequencerUptimeFeed(31337), "local 31337 exempt");
        assertFalse(script.requiresSequencerUptimeFeed(84532), "Base Sepolia 84532 exempt");
        assertFalse(script.requiresSequencerUptimeFeed(4663), "Robinhood Chain 4663 exempt");
        assertTrue(script.requiresSequencerUptimeFeed(8453), "Base mainnet required");
        assertTrue(script.requiresSequencerUptimeFeed(10), "Optimism mainnet required");
        assertTrue(script.requiresSequencerUptimeFeed(42161), "Arbitrum One required");
        assertTrue(
            script.requiresSequencerUptimeFeed(1), "Ethereum mainnet required (not a rollup: review it)"
        );
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
}
