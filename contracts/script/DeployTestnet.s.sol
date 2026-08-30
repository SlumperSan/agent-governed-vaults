// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {VaultFactory, IVaultDeployer} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {ChainlinkOracle} from "../src/oracle/ChainlinkOracle.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {AggregationRouterAdapter} from "../src/AggregationRouterAdapter.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";

/// @title DeployTestnet — parameterized testnet bring-up (singletons + per-vault infra), PIVOTED to
/// the C-6 launch oracle.
/// @notice One-command deployment for a testnet: the five protocol singletons with their one-shot
/// wiring (identical to Deploy.s.sol — the canonical order lives there and is mirrored here
/// verbatim), PLUS the per-vault infrastructure a smoke/soak needs, now on the LAUNCH oracle model:
///
///   - one {ChainlinkOracle} pricing each configured asset from ONE genuine Chainlink Data Feed
///     (the C-6 resolution — no custom multi-source median/quorum; see AI-AUDIT-REPORT C-6). Its
///     config is the COMMITTED `chainlinkOracle` block of the JSON, on-chain-verified by
///     scripts/verify-chainlink-oracle.mjs before deploying;
///   - the factory's oracle ALLOWLIST is seeded with exactly that oracle, so the testnet run
///     exercises the C-6 curation gate (mainnet does the same via Deploy.s.sol + BLESSED_ORACLES),
///     rather than the old permissive `new address[](0)`;
///   - one AggregationRouterAdapter pinned to the chain's aggregation router with only the
///     configured swap selectors allow-listed (EX-1..EX-3).
///
/// The pre-C-6 custom `OracleAggregator` bring-up this script used to perform is RETIRED (C-6); its
/// legacy config survives in the JSON's top-level `assets` block (marked deprecated) and in git.
///
/// Everything chain-specific comes from a COMMITTED JSON config (default
/// `config/base-sepolia.json`, override with DEPLOY_CONFIG) — no hardcoded addresses in code and
/// never a key: the signer is supplied on the CLI (`--account` / `--ledger`).
///
///   forge script script/DeployTestnet.s.sol:DeployTestnet \
///     --rpc-url "$BASE_SEPOLIA_RPC" --account deployer --broadcast --verify
///
/// The config's chainId is asserted against the live RPC so a wrong `--rpc-url` fails before a
/// single transaction is sent (chainid 31337 is exempt so the deploy test can run locally).
contract DeployTestnet is Script {
    struct AssetPlan {
        string symbol;
        address asset;
        address feed;
        uint32 heartbeat;
        uint256 minPriceWad;
        uint256 maxPriceWad;
    }

    uint256 constant BASE_MAINNET_CHAIN_ID = 8453; // this script enables sub-vaults (C-1) — never mainnet

    error NoAssetsConfigured();
    error ChainIdMismatch(uint256 configured, uint256 actual);

    function run()
        external
        returns (
            OperatorRegistry registry,
            SubVaultRegistry subReg,
            FeeEngine feeEngine,
            Governance governance,
            VaultDeployer vaultDeployer,
            VaultFactory factory,
            ChainlinkOracle oracle,
            AggregationRouterAdapter routerAdapter
        )
    {
        // Review hardening (2026-08-29): this script hardcodes allowSubVaults=true (the SV soak drills
        // need it) — the exact C-1 topology mainnet must NOT ship. base-mainnet.json declares chainId
        // 8453 and parses cleanly here, so `DEPLOY_CONFIG=config/base-mainnet.json ... --rpc-url
        // <base-mainnet>` would otherwise pass the config-vs-RPC check below (8453==8453) and stand up
        // an IMMUTABLE mainnet factory with sub-vaults enabled. Refuse Base mainnet outright, before
        // anything else — the mainnet path is Deploy.s.sol (root-only).
        require(
            block.chainid != BASE_MAINNET_CHAIN_ID,
            "DeployTestnet refuses Base mainnet: it enables sub-vaults (C-1) - use Deploy.s.sol"
        );

        string memory cfgPath = vm.envOr("DEPLOY_CONFIG", string("config/base-sepolia.json"));
        string memory json = vm.readFile(cfgPath);

        uint256 cfgChain = vm.parseJsonUint(json, ".chainId");
        require(block.chainid == cfgChain || block.chainid == 31337, ChainIdMismatch(cfgChain, block.chainid));

        address router = vm.parseJsonAddress(json, ".router");
        string[] memory routerSigs = vm.parseJsonStringArray(json, ".routerAllowedSignatures");
        address usdcPin = vm.parseJsonAddress(json, ".usdc");
        address sequencer = _readSequencer(json);
        AssetPlan[] memory plan = _readChainlinkAssets(json);

        vm.startBroadcast();

        // ── The curated launch oracle FIRST, so it can seed the factory allowlist ──
        oracle = _deployOracle(plan, usdcPin, sequencer);

        address[] memory blessed = new address[](1);
        blessed[0] = address(oracle);

        // ── Singletons + one-shot wiring, in the ONLY valid order (see Deploy.s.sol) ──
        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        feeEngine = new FeeEngine(IRegistryView(address(registry)));
        governance = new Governance();
        vaultDeployer = new VaultDeployer();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(governance)),
            IFeeEngine(address(feeEngine)),
            address(subReg),
            IVaultDeployer(address(vaultDeployer)),
            // C-1: TESTNET deliberately enables sub-vaults so the retained (in-audit-scope) sub-vault
            // code and the SV-* soak drills can be exercised. MAINNET launches root-only (Deploy.s.sol
            // passes false). Re-enabling on mainnet requires the parent-casts-child-vote mechanism to
            // have shipped and been audited — see VaultFactory.allowSubVaults.
            true,
            // C-6: seed the oracle allowlist with the curated ChainlinkOracle so the testnet run
            // exercises the curation gate (the old bring-up passed an empty, permissive list).
            blessed
        );
        registry.wire(address(factory), address(feeEngine));
        subReg.wire(address(factory));
        governance.wireSubVaultRegistry(address(subReg));

        // ── Execution adapter: aggregation router with only the configured selectors ──
        bytes4[] memory selectors = new bytes4[](routerSigs.length);
        for (uint256 i; i < selectors.length; ++i) {
            selectors[i] = bytes4(keccak256(bytes(routerSigs[i])));
        }
        routerAdapter = new AggregationRouterAdapter(router, selectors);

        vm.stopBroadcast();

        // ── Post-deploy sanity (view reads; fail the script rather than leave a bad deploy) ──
        require(registry.factory() == address(factory), "wire: registry.factory");
        require(registry.feeEngine() == address(feeEngine), "wire: registry.feeEngine");
        require(subReg.factory() == address(factory), "wire: subReg.factory");
        require(governance.subVaultRegistry() == address(subReg), "wire: gov.subReg");
        require(routerAdapter.router() == router, "adapter: router");
        require(factory.isAllowedOracle(address(oracle)), "allowlist: oracle blessed");
        uint256 n = plan.length;
        for (uint256 i; i < n; ++i) {
            (IAggregatorV3 feed,,,,) = oracle.feedOf(plan[i].asset);
            require(address(feed) == plan[i].feed, "oracle: feed wired");
        }

        console2.log("config          ", cfgPath);
        console2.log("chainId         ", block.chainid);
        console2.log("OperatorRegistry", address(registry));
        console2.log("SubVaultRegistry", address(subReg));
        console2.log("FeeEngine       ", address(feeEngine));
        console2.log("Governance      ", address(governance));
        console2.log("VaultFactory    ", address(factory));
        console2.log("ChainlinkOracle ", address(oracle));
        console2.log("RouterAdapter   ", address(routerAdapter));
        console2.log("sequencer feed  ", sequencer);
        for (uint256 i; i < n; ++i) {
            console2.log(
                string.concat(
                    "asset ",
                    plan[i].symbol,
                    ": feed=",
                    vm.toString(plan[i].feed),
                    " heartbeat=",
                    vm.toString(plan[i].heartbeat)
                )
            );
        }
    }

    /// @dev Flatten the plan into the ChainlinkOracle constructor's parallel arrays and deploy it.
    /// Extracted from run() so the deploy body stays under the via-IR stack limit; the CREATE still
    /// happens under the caller's active broadcast.
    function _deployOracle(AssetPlan[] memory plan, address usdc, address sequencer)
        internal
        returns (ChainlinkOracle)
    {
        uint256 n = plan.length;
        address[] memory assets = new address[](n);
        address[] memory feeds = new address[](n);
        uint32[] memory heartbeats = new uint32[](n);
        uint256[] memory minWad = new uint256[](n);
        uint256[] memory maxWad = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            assets[i] = plan[i].asset;
            feeds[i] = plan[i].feed;
            heartbeats[i] = plan[i].heartbeat;
            minWad[i] = plan[i].minPriceWad;
            maxWad[i] = plan[i].maxPriceWad;
        }
        return new ChainlinkOracle(assets, feeds, heartbeats, minWad, maxWad, usdc, sequencer);
    }

    /// @dev The Base L2 sequencer uptime feed. On this testnet the config leaves it EMPTY (the guard
    /// is skipped off a configured sequencer chain — it is mock-tested in ChainlinkOracle.t.sol);
    /// mainnet carries the real, mandatory feed. An empty string decodes to address(0).
    function _readSequencer(string memory json) internal view returns (address) {
        string memory s = vm.parseJsonString(json, ".chainlinkOracle.sequencerUptimeFeed");
        if (bytes(s).length == 0) return address(0);
        return vm.parseAddress(s);
    }

    /// @dev Reads `.chainlinkOracle.assets[i]` until the index no longer exists. Explicit lists only.
    /// The WAD price bounds are quoted strings in the config (they exceed JSON's safe integer range),
    /// so they are read as strings and parsed, not read as JSON numbers.
    function _readChainlinkAssets(string memory json) internal view returns (AssetPlan[] memory plan) {
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".chainlinkOracle.assets[", vm.toString(n), "].asset"))) {
            ++n;
        }
        require(n > 0, NoAssetsConfigured());
        plan = new AssetPlan[](n);
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".chainlinkOracle.assets[", vm.toString(i), "]");
            // Bound heartbeatSeconds BEFORE the uint32 downcast: a silent uint32() truncation of a
            // >=2^32 config value would ship an oracle with a staleness window nobody configured, and
            // ChainlinkOracle's constructor only sees the already-narrowed uint32 (it cannot catch it,
            // unlike the WAD bands it bounds itself). Parity with those bands — review, 2026-08-29.
            uint256 hb = vm.parseJsonUint(json, string.concat(base, ".heartbeatSeconds"));
            require(hb > 0 && hb <= type(uint32).max, "heartbeatSeconds out of uint32 range");
            plan[i] = AssetPlan({
                symbol: vm.parseJsonString(json, string.concat(base, ".symbol")),
                asset: vm.parseJsonAddress(json, string.concat(base, ".asset")),
                feed: vm.parseJsonAddress(json, string.concat(base, ".feed")),
                heartbeat: uint32(hb),
                minPriceWad: vm.parseUint(vm.parseJsonString(json, string.concat(base, ".minPriceWad"))),
                maxPriceWad: vm.parseUint(vm.parseJsonString(json, string.concat(base, ".maxPriceWad")))
            });
        }
    }
}
