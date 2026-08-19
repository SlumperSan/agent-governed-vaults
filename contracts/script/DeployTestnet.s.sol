// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {OracleAggregator, ChainlinkSourceAdapter, IAggregatorV3} from "../src/OracleAggregator.sol";
import {AggregationRouterAdapter} from "../src/AggregationRouterAdapter.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";

/// @title DeployTestnet — parameterized testnet bring-up (singletons + per-vault infra)
/// @notice One-command deployment for a testnet: the five protocol singletons with their
/// one-shot wiring (identical to Deploy.s.sol — the canonical order lives there and is
/// mirrored here verbatim), PLUS the per-vault infrastructure a smoke test needs:
///
///   - one ChainlinkSourceAdapter per configured feed entry, per asset;
///   - one OracleAggregator over those adapters (>=3 sources, majority quorum,
///     maxStaleness <= 1 day — all enforced by its constructor);
///   - one AggregationRouterAdapter pinned to the chain's aggregation router with only the
///     configured swap selectors allow-listed (EX-1..EX-3).
///
/// Everything chain-specific comes from a COMMITTED JSON config (default
/// `config/base-sepolia.json`, override with DEPLOY_CONFIG) — no hardcoded addresses in code
/// and never a key: the signer is supplied on the CLI (`--account` / `--ledger`).
///
///   forge script script/DeployTestnet.s.sol:DeployTestnet \
///     --rpc-url "$BASE_SEPOLIA_RPC" --account deployer --broadcast --verify
///
/// The config's chainId is asserted against the live RPC so a wrong `--rpc-url` fails before
/// a single transaction is sent (chainid 31337 is exempt so the deploy test can run locally).
contract DeployTestnet is Script {
    struct AssetPlan {
        string symbol;
        address token;
        uint8 quorum;
        address[] feeds;
    }

    error NoAssetsConfigured();
    error ChainIdMismatch(uint256 configured, uint256 actual);

    function run()
        external
        returns (
            OperatorRegistry registry,
            SubVaultRegistry subReg,
            FeeEngine feeEngine,
            Governance governance,
            VaultFactory factory,
            OracleAggregator aggregator,
            AggregationRouterAdapter routerAdapter
        )
    {
        string memory cfgPath = vm.envOr("DEPLOY_CONFIG", string("config/base-sepolia.json"));
        string memory json = vm.readFile(cfgPath);

        uint256 cfgChain = vm.parseJsonUint(json, ".chainId");
        require(block.chainid == cfgChain || block.chainid == 31337, ChainIdMismatch(cfgChain, block.chainid));

        uint32 maxStaleness = uint32(vm.parseJsonUint(json, ".maxStalenessSeconds"));
        address router = vm.parseJsonAddress(json, ".router");
        string[] memory routerSigs = vm.parseJsonStringArray(json, ".routerAllowedSignatures");
        AssetPlan[] memory plan = _readAssets(json);

        vm.startBroadcast();

        // ── Singletons + one-shot wiring, in the ONLY valid order (see Deploy.s.sol) ──
        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        feeEngine = new FeeEngine(IRegistryView(address(registry)));
        governance = new Governance();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(governance)),
            IFeeEngine(address(feeEngine)),
            address(subReg)
        );
        registry.wire(address(factory), address(feeEngine));
        subReg.wire(address(factory));
        governance.wireSubVaultRegistry(address(subReg));

        // ── Per-vault infra: source adapters → aggregator → execution adapter ──
        uint256 n = plan.length;
        address[] memory assets = new address[](n);
        address[][] memory sources = new address[][](n);
        uint32[] memory staleness = new uint32[](n);
        uint8[] memory quorums = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            assets[i] = plan[i].token;
            staleness[i] = maxStaleness;
            quorums[i] = plan[i].quorum;
            address[] memory srcs = new address[](plan[i].feeds.length);
            for (uint256 j; j < srcs.length; ++j) {
                srcs[j] = address(new ChainlinkSourceAdapter(IAggregatorV3(plan[i].feeds[j])));
            }
            sources[i] = srcs;
        }
        aggregator = new OracleAggregator(assets, sources, staleness, quorums);

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
        for (uint256 i; i < n; ++i) {
            (address[] memory s, uint32 st, uint8 q) = aggregator.assetConfig(assets[i]);
            require(
                s.length == plan[i].feeds.length && st == maxStaleness && q == plan[i].quorum, "oracle cfg"
            );
        }

        console2.log("config          ", cfgPath);
        console2.log("chainId         ", block.chainid);
        console2.log("OperatorRegistry", address(registry));
        console2.log("SubVaultRegistry", address(subReg));
        console2.log("FeeEngine       ", address(feeEngine));
        console2.log("Governance      ", address(governance));
        console2.log("VaultFactory    ", address(factory));
        console2.log("OracleAggregator", address(aggregator));
        console2.log("RouterAdapter   ", address(routerAdapter));
        for (uint256 i; i < n; ++i) {
            console2.log(
                string.concat(
                    "asset ",
                    plan[i].symbol,
                    ": sources=",
                    vm.toString(plan[i].feeds.length),
                    " quorum=",
                    vm.toString(plan[i].quorum),
                    " maxStaleness=",
                    vm.toString(maxStaleness)
                )
            );
        }
    }

    /// @dev Reads `.assets[i]` until the index no longer exists. Explicit lists only — the
    /// config states exactly which feed backs each source slot (a repeated feed address is a
    /// deliberate, documented testnet compromise, never something this script invents).
    function _readAssets(string memory json) internal view returns (AssetPlan[] memory plan) {
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".assets[", vm.toString(n), "].token"))) {
            ++n;
        }
        require(n > 0, NoAssetsConfigured());
        plan = new AssetPlan[](n);
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".assets[", vm.toString(i), "]");
            plan[i] = AssetPlan({
                symbol: vm.parseJsonString(json, string.concat(base, ".symbol")),
                token: vm.parseJsonAddress(json, string.concat(base, ".token")),
                quorum: uint8(vm.parseJsonUint(json, string.concat(base, ".quorum"))),
                feeds: vm.parseJsonAddressArray(json, string.concat(base, ".feeds"))
            });
        }
    }
}
