// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentVaultCore} from "../src/AgentVaultCore.sol";
import {VaultCoreTest} from "./VaultCore.t.sol";
import {VaultCoreInvariantTest} from "./VaultCoreInvariant.t.sol";
import {GovernanceTest} from "./Governance.t.sol";
import {ExecutionTest} from "./Execution.t.sol";

/// Differential suites. Each existing VaultCore suite is inherited whole and re-run with its vault
/// built as an AgentVaultCore pinned to a registry that admits every address. Every inherited test
/// must still pass: any difference between VaultCore and AgentVaultCore outside the gate is a defect.
/// Nothing is overridden but the construction seam, so no assertion is weakened or skipped.
contract AgentVaultCore_VaultCoreSuite is VaultCoreTest {
    function _agentFlavor() internal pure override returns (bool) {
        return true;
    }

    /// Guards the differential against being vacuous: the vault under test really is the subclass.
    function test_differential_vaultUnderTestIsTheAgentSubclass() public view {
        assertGt(AgentVaultCore(address(vault)).identityRegistry().code.length, 0);
    }
}

contract AgentVaultCore_VaultCoreInvariantSuite is VaultCoreInvariantTest {
    function _agentFlavor() internal pure override returns (bool) {
        return true;
    }

    /// Guards the differential against being vacuous: the vault under test really is the subclass.
    function test_differential_vaultUnderTestIsTheAgentSubclass() public view {
        assertGt(AgentVaultCore(address(vault)).identityRegistry().code.length, 0);
    }
}

contract AgentVaultCore_GovernanceSuite is GovernanceTest {
    function _agentFlavor() internal pure override returns (bool) {
        return true;
    }

    /// Guards the differential against being vacuous: the vault under test really is the subclass.
    function test_differential_vaultUnderTestIsTheAgentSubclass() public view {
        assertGt(AgentVaultCore(address(vault)).identityRegistry().code.length, 0);
    }
}

contract AgentVaultCore_ExecutionSuite is ExecutionTest {
    function _agentFlavor() internal pure override returns (bool) {
        return true;
    }

    /// Guards the differential against being vacuous: the vault under test really is the subclass.
    function test_differential_vaultUnderTestIsTheAgentSubclass() public view {
        assertGt(AgentVaultCore(address(vault)).identityRegistry().code.length, 0);
    }
}
