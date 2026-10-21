// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {FeeEngine} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";
import {ProtocolCreate2} from "./lib/ProtocolCreate2.sol";
import {TreasuryConfig} from "./lib/TreasuryConfig.sol";

/// @title Deploy — canonical protocol bring-up (same addresses on every chain)
/// @notice Deploys the six singletons through the Arachnid CREATE2 proxy with fixed salts (see
/// `lib/ProtocolCreate2.sol`), so each one lands at the same address on every chain, then sets the
/// per-chain oracle allowlist and performs the one-shot wiring. Every post-deploy call is sent by
/// PROTOCOL_INITIALIZER, and the broadcast is pinned to that address: any other signer cannot
/// complete this script. The wiring calls (`registry.wire`, `subReg.wire`,
/// `gov.wireSubVaultRegistry`) and `factory.initialize` are each permanently locked after their
/// first call, which is what makes the registry/factory trust anchor credible (CM-5, SF-4).
///
/// Order (the six deploys can land in any order, because every address is a function of salt and
/// initcode alone; this is the order the script uses):
///   1. OperatorRegistry + SubVaultRegistry — no dependencies.
///   2. FeeEngine — its initcode embeds the OperatorRegistry address.
///   3. Governance — no constructor deps; sub-vault registry wired post-deploy.
///   4. VaultDeployer — no dependencies, but the factory pins it. It carries VaultCore's creation
///      code, which is why the factory itself no longer does and fits under EIP-170 (#10).
///   5. VaultFactory — its initcode embeds registry + governance + feeEngine + subRegistry +
///      vaultDeployer. It creates nothing until step 6.
///   6. `factory.initialize(BLESSED_ORACLES)`, THEN the wiring: registry.wire(factory, feeEngine);
///      subReg.wire(factory); gov.wireSubVaultRegistry(subReg). The factory is initialised before the
///      registry is pointed at it, so an uninitialised factory (oracle allowlist off) is never wired.
///   7. `feeEngine.initialize(FEE_TREASURY)` (fee model A1): the per-chain treasury that receives 10% of
///      every performance fee. Until it lands the engine takes no fee, so the order against steps 1 to 6
///      does not matter; it is one-shot and refuses the zero address. FEE_TREASURY is required on any
///      real chain (see `lib/TreasuryConfig.sol`).
///
/// Oracles and execution adapters are NOT protocol singletons — each chain has its own (DeployChainlinkOracle
/// deploys the oracle), and each vault creator supplies theirs at createVault time, so this script deploys
/// none. Run DeployChainlinkOracle first and pass its address as BLESSED_ORACLES.
contract Deploy is Script {
    uint256 constant LOCAL_CHAIN_ID = 31337; // anvil / forge test — the ONLY chain an empty oracle allowlist is allowed on

    function run()
        external
        returns (
            OperatorRegistry registry,
            SubVaultRegistry subReg,
            FeeEngine feeEngine,
            Governance governance,
            VaultDeployer vaultDeployer,
            VaultFactory factory
        )
    {
        // The oracle list is read and refused BEFORE anything is sent.
        // C-6: blessed oracle allowlist. Supply the curated ChainlinkOracle instance(s) — deployed
        // over verified genuine Chainlink Data Feeds (see DeployChainlinkOracle.s.sol) — via the
        // BLESSED_ORACLES env var (comma-separated addresses). An empty allowlist ships the C-6 gate
        // DISABLED (any creator-supplied oracle accepted, including a weak custom aggregator or a
        // fake-feed oracle), which is only ever acceptable on the LOCAL test chain (anvil/forge =
        // 31337). On ANY real chain — Base mainnet, any other L2, or a wrong-RPC chainid — refuse an
        // empty allowlist rather than silently deploying enforcement-off. (This guard was previously a
        // denylist of just chainid 8453, which left every OTHER chain permissive — an empty allowlist
        // on a mis-pointed RPC would have shipped the gate off; hardened 2026-08-29 after review.)
        address[] memory blessedOracles = vm.envOr("BLESSED_ORACLES", ",", new address[](0));
        require(
            block.chainid == LOCAL_CHAIN_ID || blessedOracles.length > 0,
            "C-6: a real-chain deploy requires a non-empty BLESSED_ORACLES allowlist (empty allowed only on local 31337)"
        );

        // Read and refused BEFORE anything is sent: the treasury is set once and never changes.
        address treasury = TreasuryConfig.read(vm);

        vm.startBroadcast(PROTOCOL_INITIALIZER);

        ProtocolCreate2.Set memory s = ProtocolCreate2.createAll();
        registry = OperatorRegistry(s.operatorRegistry);
        subReg = SubVaultRegistry(s.subVaultRegistry);
        feeEngine = FeeEngine(s.feeEngine);
        governance = Governance(s.governance);
        vaultDeployer = VaultDeployer(s.vaultDeployer);
        factory = VaultFactory(s.vaultFactory);

        // Initialise the factory FIRST: an uninitialised factory has its C-6 oracle allowlist off, and it
        // must never be the one the registry is wired to.
        factory.initialize(blessedOracles);

        // One-shot wiring — irreversible after this transaction.
        registry.wire(address(factory), address(feeEngine));
        subReg.wire(address(factory));
        governance.wireSubVaultRegistry(address(subReg));

        // Fee model A1: the one-shot treasury, so the engine can credit its share.
        feeEngine.initialize(treasury);

        vm.stopBroadcast();

        require(factory.initialized(), "Deploy: factory not initialised");
        require(
            registry.initialized() && subReg.initialized() && governance.initialized(), "Deploy: not wired"
        );
        require(feeEngine.treasury() == treasury, "Deploy: fee treasury not set");

        console2.log("OperatorRegistry", address(registry));
        console2.log("SubVaultRegistry", address(subReg));
        console2.log("FeeEngine       ", address(feeEngine));
        console2.log("Governance      ", address(governance));
        console2.log("VaultDeployer   ", address(vaultDeployer));
        console2.log("VaultFactory    ", address(factory));
        console2.log("FeeTreasury     ", treasury);
    }
}
