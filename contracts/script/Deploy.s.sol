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
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";

/// @title Deploy — canonical protocol bring-up
/// @notice Deploys the singletons and performs the one-shot wiring in the ONLY valid order.
/// The wiring calls (`registry.wire`, `subReg.wire`, `gov.wireSubVaultRegistry`) are each
/// permanently locked after this transaction — there is no admin able to re-point them, which
/// is what makes the registry/factory trust anchor credible (CM-5, SF-4).
///
/// Ordering constraint (why this sequence and no other):
///   1. OperatorRegistry + SubVaultRegistry — no dependencies.
///   2. FeeEngine — needs the OperatorRegistry address.
///   3. Governance — no constructor deps; sub-vault registry wired post-deploy.
///   4. VaultDeployer — no dependencies, but MUST precede the factory: the factory pins it
///      immutably. It carries VaultCore's creation code, which is why the factory itself no
///      longer does and finally fits under EIP-170 (#10).
///   5. VaultFactory — needs registry + governance + feeEngine + subRegistry + vaultDeployer.
///   6. Wire back-references: registry.wire(factory, feeEngine); subReg.wire(factory);
///      gov.wireSubVaultRegistry(subReg). Only now can vaults be created.
///
/// Oracles and execution adapters are NOT protocol singletons — each vault creator supplies
/// their own at createVault time (venue/source choice is a per-vault decision, C-2/SF-1), so
/// this script deploys none.
contract Deploy is Script {
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
        vm.startBroadcast();

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
            IVaultDeployer(address(vaultDeployer))
        );

        // One-shot wiring — irreversible after this transaction.
        registry.wire(address(factory), address(feeEngine));
        subReg.wire(address(factory));
        governance.wireSubVaultRegistry(address(subReg));

        vm.stopBroadcast();

        console2.log("OperatorRegistry", address(registry));
        console2.log("SubVaultRegistry", address(subReg));
        console2.log("FeeEngine       ", address(feeEngine));
        console2.log("Governance      ", address(governance));
        console2.log("VaultDeployer   ", address(vaultDeployer));
        console2.log("VaultFactory    ", address(factory));
    }
}
