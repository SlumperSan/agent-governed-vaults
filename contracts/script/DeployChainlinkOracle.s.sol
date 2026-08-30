// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ChainlinkOracle} from "../src/oracle/ChainlinkOracle.sol";

/// @title DeployChainlinkOracle — deploy one blessed ChainlinkOracle from env config
/// @notice The C-6 launch resolution needs a CURATED oracle: a ChainlinkOracle over VERIFIED
/// genuine Chainlink Data Feeds on the target chain, whose address then goes into
/// `VaultFactory`'s `BLESSED_ORACLES` allowlist (see Deploy.s.sol). This script deploys exactly
/// that from environment variables — no addresses are baked in, because inventing a feed address
/// is the one irreversible mistake here (a wrong or fake feed prices every vault wrong forever).
///
/// Required env (all parallel by asset; comma-delimited):
///   ORACLE_ASSETS      address[]  — the priceable basket assets (no duplicates, not USDC)
///   ORACLE_FEEDS       address[]  — the Chainlink AggregatorV3 PROXY per asset (verify each on-chain!)
///   ORACLE_HEARTBEATS  uint[]     — per-asset staleness bound = the feed's OWN heartbeat (seconds)
///   ORACLE_MIN_WAD     uint[]     — per-asset sane-price floor (WAD), 0 to disable the band with max 0
///   ORACLE_MAX_WAD     uint[]     — per-asset sane-price ceiling (WAD), 0 to disable the band
/// Optional:
///   ORACLE_USDC        address    — USDC-like token pinned to 1e18 (default 0 = no pin)
///   ORACLE_SEQUENCER   address    — L2 sequencer uptime feed (default 0; REQUIRED on every chain
///                                   except the exempt ids below — see `requiresSequencerUptimeFeed`)
///
/// Before using the output: verify every feed with scripts/verify-chainlink-oracle.mjs. Then set
///   BLESSED_ORACLES=<deployed address>   for Deploy.s.sol.
contract DeployChainlinkOracle is Script {
    /// @dev anvil / forge test — no sequencer exists to have an uptime feed.
    uint256 constant LOCAL_CHAIN_ID = 31337;
    /// @dev Base Sepolia — `config/base-sepolia.json` commits `chainlinkOracle.sequencerUptimeFeed: ""`
    /// BY DESIGN (see its `sequencerUptimeFeedNote`): the testnet exercise targets the vault lifecycle
    /// and real-feed pricing, and the uptime gate itself is mock-tested in ChainlinkOracle.t.sol.
    uint256 constant BASE_SEPOLIA_CHAIN_ID = 84532;

    /// @notice Does a deploy on `chainId` have to supply ORACLE_SEQUENCER?
    /// @dev L2-GENERIC and FAIL-CLOSED: an ALLOWLIST of the ids known to have no uptime feed, with
    /// "yes, required" as the default for every other id — including one this script has never seen.
    /// The rule this replaces was a denylist of ONE id (`block.chainid != 8453`), so deploying to any
    /// OTHER L2 (Optimism, Arbitrum, a future Base-like chain, or a mis-pointed RPC) silently shipped
    /// an IMMUTABLE oracle with the sequencer guard disabled — it would keep serving prices computed
    /// while the sequencer was down, which is exactly the window the guard exists to close. Getting
    /// the default wrong is asymmetric: fail-closed costs a deploy that reverts until the operator
    /// supplies the feed; fail-open costs a permanently unguarded oracle nobody can fix.
    /// There is deliberately NO env override — an `ALLOW_NO_SEQUENCER=1` escape hatch would restore
    /// the silent skip one flag at a time. A chain that genuinely has no uptime feed (another
    /// testnet, an L1) is added to the allowlist here, in a reviewed change, on the record.
    function requiresSequencerUptimeFeed(uint256 chainId) public pure returns (bool) {
        return chainId != LOCAL_CHAIN_ID && chainId != BASE_SEPOLIA_CHAIN_ID;
    }

    /// @notice Env entrypoint: `forge script script/DeployChainlinkOracle.s.sol:DeployChainlinkOracle`.
    function run() external returns (ChainlinkOracle oracle) {
        return runWithSequencer(vm.envOr("ORACLE_SEQUENCER", address(0)));
    }

    /// @notice Same deploy with the L2 sequencer uptime feed passed explicitly
    /// (`--sig "runWithSequencer(address)" <feed>`), rather than via ORACLE_SEQUENCER. The guard below
    /// is on THIS function, so it holds identically on both entrypoints — there is no unguarded path.
    /// (The tests drive this one: forge runs a suite's test functions in PARALLEL and env vars are
    /// process-global, so a test that exported a different ORACLE_SEQUENCER than its neighbours would
    /// be flaky by construction.)
    function runWithSequencer(address sequencer) public returns (ChainlinkOracle oracle) {
        // Checked FIRST, before any other config is read: a chain that must have the L2 sequencer
        // uptime guard never gets as far as deploying an oracle without one.
        require(
            sequencer != address(0) || !requiresSequencerUptimeFeed(block.chainid),
            "DeployChainlinkOracle: ORACLE_SEQUENCER (L2 sequencer uptime feed) is required on every chain except local 31337 and Base Sepolia 84532"
        );

        address[] memory assets = vm.envAddress("ORACLE_ASSETS", ",");
        address[] memory feeds = vm.envAddress("ORACLE_FEEDS", ",");
        uint256[] memory hbU = vm.envUint("ORACLE_HEARTBEATS", ",");
        uint256[] memory minWad = vm.envUint("ORACLE_MIN_WAD", ",");
        uint256[] memory maxWad = vm.envUint("ORACLE_MAX_WAD", ",");
        address usdc = vm.envOr("ORACLE_USDC", address(0));

        uint256 n = assets.length;
        require(
            feeds.length == n && hbU.length == n && minWad.length == n && maxWad.length == n,
            "DeployChainlinkOracle: parallel-array length mismatch"
        );

        uint32[] memory heartbeats = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            require(hbU[i] > 0 && hbU[i] <= type(uint32).max, "DeployChainlinkOracle: bad heartbeat");
            heartbeats[i] = uint32(hbU[i]);
        }

        vm.startBroadcast();
        oracle = new ChainlinkOracle(assets, feeds, heartbeats, minWad, maxWad, usdc, sequencer);
        vm.stopBroadcast();

        console2.log("ChainlinkOracle ", address(oracle));
        console2.log("assets          ", n);
        console2.log("sequencer feed  ", sequencer);
        console2.log("-> set BLESSED_ORACLES to the address above for Deploy.s.sol");
    }
}
