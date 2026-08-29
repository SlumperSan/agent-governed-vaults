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
///   ORACLE_SEQUENCER   address    — L2 sequencer uptime feed (default 0; REQUIRED on Base mainnet)
///
/// Before using the output: verify every feed with scripts/verify-chainlink-oracle.mjs. Then set
///   BLESSED_ORACLES=<deployed address>   for Deploy.s.sol.
contract DeployChainlinkOracle is Script {
    function run() external returns (ChainlinkOracle oracle) {
        address[] memory assets = vm.envAddress("ORACLE_ASSETS", ",");
        address[] memory feeds = vm.envAddress("ORACLE_FEEDS", ",");
        uint256[] memory hbU = vm.envUint("ORACLE_HEARTBEATS", ",");
        uint256[] memory minWad = vm.envUint("ORACLE_MIN_WAD", ",");
        uint256[] memory maxWad = vm.envUint("ORACLE_MAX_WAD", ",");
        address usdc = vm.envOr("ORACLE_USDC", address(0));
        address sequencer = vm.envOr("ORACLE_SEQUENCER", address(0));

        uint256 n = assets.length;
        require(
            feeds.length == n && hbU.length == n && minWad.length == n && maxWad.length == n,
            "DeployChainlinkOracle: parallel-array length mismatch"
        );
        // On Base mainnet the L2 sequencer uptime guard is mandatory (Deploy.s.sol enforces the
        // allowlist; the sequencer feed is the ChainlinkOracle's own L2 safety).
        require(
            block.chainid != 8453 || sequencer != address(0),
            "DeployChainlinkOracle: Base mainnet requires ORACLE_SEQUENCER"
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
