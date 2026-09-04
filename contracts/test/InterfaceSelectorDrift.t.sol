// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// Slither `missing-inheritance` fired on four contracts that implement an interface's function
// set WITHOUT an `is` clause (4 rows, triaged 2026-09-01): VaultDeployer/IVaultDeployer,
// SubVaultRegistry/ISubRegistryChild, OperatorRegistry/IRegistryAttest, VaultCore/IVaultExecution.
// Because none of them inherit, the compiler never checks the pair against each other — a
// renamed or re-typed function on either side would compile silently and only fail at runtime
// when `Governance.execute` or `VaultFactory.createVault` calls across the boundary.
//
// This file has two halves, and the first one alone is NOT a substitute for the missing `is`
// clause — it used to claim it was, and that claim was false:
//
//   1. `test_selectorsMatch_*` pin six hand-typed pairs. A rename or a re-type on either side is
//      a COMPILE error (there is no such member to take `.selector` of), so those they catch.
//      They cannot catch an ADDITION: a reviewer added an unimplemented seventh function to
//      `IVaultExecution` — exactly the missing-inheritance gap this file exists to close — and
//      got 4/4 green, because a hand-written list has nothing to say about a member nobody
//      wrote down. That is the same defect as #109's tier-coverage test, in a second subsystem.
//
//   2. `test_*_isFullyImplementedBy*` close it, by making the COMPILER enumerate the interface.
//      `type(I).interfaceId` is the XOR of every selector the compiler finds in `I`, so adding a
//      member changes it, and the equality then holds only if the right-hand side names the
//      implementation's counterpart — which compiles only if the implementation has one. That is
//      the property the `is` clause would give.
//
// Why not the `is` clause itself, in a test-only contract? Because it does not compile. Probed on
// solc 0.8.26: `contract P is SubVaultRegistry, ISubRegistryChild {}` fails with
// `Error (6480): Derived contract must override function "registerChild". Two or more base
// classes define function with same name and parameter types.` — and writing those `override`s
// out is a hand-maintained list again, which is the thing being fixed. `interfaceId` is the
// version of the same idea that the compiler will actually accept.
//
// The residual, stated rather than glossed: XOR is order-independent, so two simultaneous
// changes whose selectors cancel would pass. Every single-member change is caught.

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

    // ------------------------------------------------------------------------------------
    // The half that catches ADDITIONS. `type(I).interfaceId` is compiler-enumerated: it is the
    // XOR of every selector declared in `I`, so nothing can be added to an interface without
    // changing it. The right-hand side has to name the implementation's counterpart to restore
    // the equality, and naming it compiles only if the implementation actually has it.
    //
    // Mutation these are built against: add `function sweepDust(address,uint256) external;` to
    // `IVaultExecution` without implementing it on `VaultCore`. The six selector pairs above
    // stay green; these fail.
    // ------------------------------------------------------------------------------------

    string constant WHY = "an interface member is unimplemented, or an implementation member left "
        "the interface. Add the missing function to the implementation and XOR its selector in "
        "here; if it compiles, the implementation has it.";

    function test_iVaultExecution_isFullyImplementedByVaultCore() public pure {
        assertEq(
            type(IVaultExecution).interfaceId,
            VaultCore.executeRebalance.selector ^ VaultCore.allocateToChild.selector
                ^ VaultCore.redeemFromChild.selector,
            string.concat("IVaultExecution/VaultCore: ", WHY)
        );
    }

    function test_iVaultDeployer_isFullyImplementedByVaultDeployer() public pure {
        assertEq(
            type(IVaultDeployer).interfaceId,
            VaultDeployer.deploy.selector,
            string.concat("IVaultDeployer/VaultDeployer: ", WHY)
        );
    }

    function test_iSubRegistryChild_isFullyImplementedBySubVaultRegistry() public pure {
        assertEq(
            type(ISubRegistryChild).interfaceId,
            SubVaultRegistry.registerChild.selector,
            string.concat("ISubRegistryChild/SubVaultRegistry: ", WHY)
        );
    }

    function test_iRegistryAttest_isFullyImplementedByOperatorRegistry() public pure {
        assertEq(
            type(IRegistryAttest).interfaceId,
            OperatorRegistry.attestVault.selector,
            string.concat("IRegistryAttest/OperatorRegistry: ", WHY)
        );
    }
}
