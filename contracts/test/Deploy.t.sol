// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {FeeEngine} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";

/// Proves the deploy script wires the system correctly and locks every one-shot back-reference.
contract DeployTest is Test {
    function test_deployWiresAndLocks() public {
        Deploy d = new Deploy();
        (
            OperatorRegistry registry,
            SubVaultRegistry subReg,
            FeeEngine feeEngine,
            Governance gov,
            VaultDeployer vaultDeployer,
            VaultFactory factory
        ) = d.run();

        // Cross-references resolved.
        assertEq(registry.factory(), address(factory), "registry factory");
        assertEq(registry.feeEngine(), address(feeEngine), "registry feeEngine");
        assertEq(subReg.factory(), address(factory), "subReg factory");
        assertEq(gov.subVaultRegistry(), address(subReg), "gov subReg");
        assertEq(address(factory.subVaultRegistry()), address(subReg), "factory subReg");
        // #10: the factory's one construction path, pinned immutably at deploy time.
        assertEq(address(factory.vaultDeployer()), address(vaultDeployer), "factory vaultDeployer");

        // Every wiring is now permanently locked. The deployer is the Deploy contract; even
        // AS the deployer, re-wiring reverts AlreadyWired (one-shot). Non-deployers get
        // OnlyDeployer earlier still.
        address dep = registry.deployer();
        vm.startPrank(dep);
        vm.expectRevert(OperatorRegistry.AlreadyWired.selector);
        registry.wire(address(1), address(2));
        vm.stopPrank();
        vm.startPrank(subReg.deployer());
        vm.expectRevert(SubVaultRegistry.AlreadyWired.selector);
        subReg.wire(address(1));
        vm.stopPrank();
        vm.startPrank(gov.deployer());
        vm.expectRevert(Governance.AlreadyWiredSubRegistry.selector);
        gov.wireSubVaultRegistry(address(1));
        vm.stopPrank();

        // A random caller is rejected before the one-shot check even matters.
        vm.expectRevert(OperatorRegistry.OnlyDeployer.selector);
        registry.wire(address(1), address(2));
    }
}
