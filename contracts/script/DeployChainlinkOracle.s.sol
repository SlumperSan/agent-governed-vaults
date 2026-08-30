// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ChainlinkOracle} from "../src/oracle/ChainlinkOracle.sol";

interface IFeedMeta {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
}

/// @title DeployChainlinkOracle — deploy one blessed ChainlinkOracle from env config
/// @notice The C-6 launch resolution needs a CURATED oracle: a ChainlinkOracle over VERIFIED
/// genuine Chainlink Data Feeds on the target chain, whose address then goes into
/// `VaultFactory`'s `BLESSED_ORACLES` allowlist (see Deploy.s.sol). This script deploys exactly
/// that from environment variables — no addresses are baked in, because inventing a feed address
/// is the one irreversible mistake here (a wrong or fake feed prices every vault wrong forever).
///
/// Required env (all parallel by asset; comma-delimited):
///   ORACLE_ASSETS      address[]  — the priceable basket assets (no duplicates, not USDC)
///   ORACLE_FEEDS       address[]  — the Chainlink AggregatorV3 PROXY per asset (verify each on-chain!).
///                                   Must be USD-QUOTED: `description()` ending in "/ USD", 8 decimals.
///                                   An ASSET/ETH feed (e.g. Base's `CBETH / ETH`) is rejected here and
///                                   again by the ChainlinkOracle constructor — it would be read as USD.
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

        // DENOMINATION PRE-FLIGHT. The ChainlinkOracle constructor enforces this itself (a USD quote
        // leg and the 8-decimal USD convention) — that is the load-bearing check and it binds every
        // deployment path, including one that never runs this script. What the loop below adds is
        // DIAGNOSIS: the constructor can only say `BadOracleConfig()`, which on a 5-asset list
        // leaves the operator guessing WHICH feed is wrong. Here the failure names the asset, the
        // feed and the description read off-chain — so the classic mistake (wiring `CBETH / ETH`
        // because Base has no cbETH/USD feed) reads as exactly that.
        for (uint256 i; i < n; ++i) {
            string memory where =
                string.concat("asset ", vm.toString(assets[i]), " feed ", vm.toString(feeds[i]));
            // Order matters, and a TYPED call would defeat the point. A codeless address (the
            // single most likely typo) returns empty data, and `IFeedMeta(x).description()` would
            // then blow up on ABI-decode as a bare Panic — the opaque failure this loop exists to
            // replace. Prove there is code, then read `description()` by staticcall so "this is not
            // an AggregatorV3" is reported as itself.
            require(
                feeds[i].code.length > 0,
                string.concat("DeployChainlinkOracle: feed address has no code: ", where)
            );
            (bool ok, bytes memory ret) =
                feeds[i].staticcall(abi.encodeWithSelector(IFeedMeta.description.selector));
            require(
                ok && ret.length >= 96, // (offset, length, >=1 word of data)
                string.concat(
                    "DeployChainlinkOracle: feed has no description() - cannot prove USD denomination: ",
                    where
                )
            );
            string memory desc = abi.decode(ret, (string));
            require(
                _isUsdQuoted(desc),
                string.concat("DeployChainlinkOracle: NOT a USD feed: ", where, " = ", desc)
            );
            require(
                IFeedMeta(feeds[i]).decimals() == 8,
                string.concat(
                    "DeployChainlinkOracle: feed decimals != 8 (USD convention): ", where, " = ", desc
                )
            );
            console2.log("feed OK", desc, feeds[i]);
        }

        vm.startBroadcast();
        oracle = new ChainlinkOracle(assets, feeds, heartbeats, minWad, maxWad, usdc, sequencer);
        vm.stopBroadcast();

        console2.log("ChainlinkOracle ", address(oracle));
        console2.log("assets          ", n);
        console2.log("sequencer feed  ", sequencer);
        console2.log("-> set BLESSED_ORACLES to the address above for Deploy.s.sol");
    }

    /// @dev Mirrors `ChainlinkOracle._requireUsdQuote`: the description must end in `USD` as a
    /// whole word — last three bytes `USD`, preceded by a pair separator (' ' or '/'). Kept in step
    /// with the constructor deliberately; if the two ever disagree the constructor wins and the
    /// deploy simply fails later, never earlier.
    function _isUsdQuoted(string memory description) internal pure returns (bool) {
        bytes memory d = bytes(description);
        uint256 n = d.length;
        if (n < 4) return false;
        if (d[n - 3] != "U" || d[n - 2] != "S" || d[n - 1] != "D") return false;
        return d[n - 4] == " " || d[n - 4] == "/";
    }
}
