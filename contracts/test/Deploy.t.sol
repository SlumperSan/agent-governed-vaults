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

    /// @notice C-6 deploy guard: on Base mainnet (chainid 8453) the deploy REFUSES to run with an
    /// empty BLESSED_ORACLES allowlist — enforcement-off on mainnet would re-open C-6. This turns
    /// the "do not launch with this empty" comment into a deploy-time invariant. (BLESSED_ORACLES is
    /// unset in CI, so the allowlist is empty here.) On the local test chainid (31337) the guard is a
    /// no-op, which is why `test_deployWiresAndLocks` above runs fine.
    function test_baseMainnetDeployRefusesEmptyOracleAllowlist() public {
        vm.chainId(8453); // pretend we are deploying to Base mainnet
        Deploy d = new Deploy();
        vm.expectRevert(
            bytes(
                "C-6: a real-chain deploy requires a non-empty BLESSED_ORACLES allowlist (empty allowed only on local 31337)"
            )
        );
        d.run();
    }

    /// @notice The guard is L2-GENERIC, not Base-specific: an empty allowlist on ANY real chain (here
    /// a stand-in chainid that is neither Base mainnet nor local 31337 — e.g. a mis-pointed RPC or
    /// another L2) is refused, so a wrong-RPC deploy can never silently ship the C-6 gate disabled.
    /// (Previously the guard only fired on chainid 8453, leaving every other chain permissive.)
    function test_anyRealChainDeployRefusesEmptyOracleAllowlist() public {
        vm.chainId(10); // any non-8453, non-31337 chain (stand-in for a wrong RPC / other L2)
        Deploy d = new Deploy();
        vm.expectRevert(
            bytes(
                "C-6: a real-chain deploy requires a non-empty BLESSED_ORACLES allowlist (empty allowed only on local 31337)"
            )
        );
        d.run();
    }
}
