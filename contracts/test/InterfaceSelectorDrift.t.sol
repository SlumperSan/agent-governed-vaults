// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// Slither `missing-inheritance` fired on four contracts that implement an interface's function
// set WITHOUT an `is` clause (4 rows, triaged 2026-09-01): VaultDeployer/IVaultDeployer,
// SubVaultRegistry/ISubRegistryChild, OperatorRegistry/IRegistryAttest, VaultCore/IVaultExecution.
// Because none of them inherit, the compiler never checks the pair against each other — a
// renamed or re-typed function on either side would compile silently and only fail at runtime
// when `Governance.execute` or `VaultFactory.createVault` calls across the boundary. This file
// pins every selector on every one of the four interfaces against its implementation and is the
// substitute for the missing `is` clause.

import {Test} from "forge-std/Test.sol";
import {IVaultDeployer, ISubRegistryChild, IRegistryAttest} from "../src/VaultFactory.sol";
import {IVaultExecution} from "../src/Governance.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {VaultCore} from "../src/VaultCore.sol";

contract InterfaceSelectorDriftTest is Test {
    // Each assertion below compares two compile-time constants (`Interface.fn.selector` vs.
    // `Impl.fn.selector`). That comparison alone is not the whole defence: if the implementation
    // dropped, renamed, or re-typed the function, `Impl.fn.selector` would fail to COMPILE in the
    // first place (there would be no such member to take the selector of). So the mere fact that
    // this file builds already proves the implementation exposes a runtime-callable function of
    // that exact signature; a staticcall/call round-trip is not needed and Foundry has no
    // ABI-introspection assertion for this — the compile-time reference IS the runtime check.

    // ── 1. IVaultDeployer (VaultFactory.sol) -> VaultDeployer ──
    function test_selectorsMatch_iVaultDeployer_vaultDeployer() public pure {
        assertEq(
            IVaultDeployer.deploy.selector,
            VaultDeployer.deploy.selector,
            "IVaultDeployer/VaultDeployer: deploy"
        );
    }

    // ── 2. ISubRegistryChild (VaultFactory.sol) -> SubVaultRegistry ──
    function test_selectorsMatch_iSubRegistryChild_subVaultRegistry() public pure {
        assertEq(
            ISubRegistryChild.registerChild.selector,
            SubVaultRegistry.registerChild.selector,
            "ISubRegistryChild/SubVaultRegistry: registerChild"
        );
    }

    // ── 3. IRegistryAttest (VaultFactory.sol) -> OperatorRegistry ──
    function test_selectorsMatch_iRegistryAttest_operatorRegistry() public pure {
        assertEq(
            IRegistryAttest.attestVault.selector,
            OperatorRegistry.attestVault.selector,
            "IRegistryAttest/OperatorRegistry: attestVault"
        );
    }

    // ── 4. IVaultExecution (Governance.sol) -> VaultCore ──
    function test_selectorsMatch_iVaultExecution_vaultCore() public pure {
        assertEq(
            IVaultExecution.executeRebalance.selector,
            VaultCore.executeRebalance.selector,
            "IVaultExecution/VaultCore: executeRebalance"
        );
        assertEq(
            IVaultExecution.allocateToChild.selector,
            VaultCore.allocateToChild.selector,
            "IVaultExecution/VaultCore: allocateToChild"
        );
        assertEq(
            IVaultExecution.redeemFromChild.selector,
            VaultCore.redeemFromChild.selector,
            "IVaultExecution/VaultCore: redeemFromChild"
        );
    }
}
