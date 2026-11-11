// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VaultCore} from "../../src/VaultCore.sol";
import {AgentVaultCore} from "../../src/AgentVaultCore.sol";
import {AllowAllRegistry} from "../mocks/RegistryMocks.sol";
import {AuditExitFeeRatchet} from "./AuditExitFeeRatchet.t.sol";

/// @notice The exit-fee ratchet suite and the position floor, run unchanged against AgentVaultCore
/// built with a registry that admits every address. Every inherited test must pass: a difference in
/// share math or exit behaviour between the two vaults outside the deposit gate is a defect.
///
/// Honest scope: `requestExit`, `_settleExit` and `_checkPositionFloor` are non-virtual, so
/// AgentVaultCore cannot skip the floor without a VaultCore edit. This suite catches parity drift from
/// AgentVaultCore's only override (`_deposit`), not a direct floor bypass.
contract AgentVaultCore_ExitFeeRatchet is AuditExitFeeRatchet {
    AllowAllRegistry idReg = new AllowAllRegistry();

    function _deployVault(uint256 minDeposit) internal override returns (VaultCore) {
        return new AgentVaultCore(
            address(usdc),
            new address[](0),
            creator,
            registry,
            gov,
            fees,
            oracle,
            0, // capacityCapUsdc: uncapped, as launched
            minDeposit,
            50, // exitFeeMaxBps: Arc launch value
            604800, // exitFeeDecayPeriod: Arc launch value
            new address[](0),
            address(0),
            address(idReg)
        );
    }

    /// Guards the suite against being vacuous: the vault under test really is the subclass.
    function test_differential_vaultUnderTestIsTheAgentSubclass() public view {
        assertGt(AgentVaultCore(address(vault)).identityRegistry().code.length, 0);
    }
}
