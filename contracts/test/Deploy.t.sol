// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Create2ProxyFixture} from "./helpers/Create2ProxyFixture.sol";
import {ProtocolCreate2} from "../script/lib/ProtocolCreate2.sol";
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {FeeEngine} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {VaultFactory, IVaultDeployer} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {AgentVaultDeployer} from "../src/AgentVaultDeployer.sol";
import {TreasuryConfig} from "../script/lib/TreasuryConfig.sol";

/// @dev Exposes the internal `TreasuryConfig.read` so a test can call it at a chosen chain id.
contract TreasuryConfigHarness is Test {
    function read() external view returns (address) {
        return TreasuryConfig.read(vm);
    }
}

/// Proves the deploy script wires the system correctly and locks every one-shot back-reference.
contract DeployTest is Create2ProxyFixture {
    /// The agent ID registry is not a Deploy.s.sol singleton: the script reads its recorded address
    /// from `config/agent-registry-create2.json` and refuses to run unless it already has code.
    /// Etching any runtime there stands in for "deployed first"; `factory.agentRegistry()` is only
    /// ever compared to it.
    function setUp() public {
        _etchCreate2Proxy();
        vm.etch(_recordedRegistry(), hex"00");
    }

    function _recordedRegistry() internal view returns (address) {
        return vm.parseJsonAddress(vm.readFile("config/agent-registry-create2.json"), ".address");
    }

    function test_deployWiresAndLocks() public {
        Deploy d = new Deploy();
        (
            OperatorRegistry registry,
            SubVaultRegistry subReg,
            FeeEngine feeEngine,
            Governance gov,
            VaultDeployer vaultDeployer,
            AgentVaultDeployer agentVaultDeployer,
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
        // The agent path: the recorded registry and the agent deployer, both pinned, one shot spent.
        assertTrue(factory.agentPathInitialized(), "agent path initialised");
        assertEq(factory.agentRegistry(), _recordedRegistry(), "factory agentRegistry");
        assertEq(
            address(factory.agentVaultDeployer()), address(agentVaultDeployer), "factory agentVaultDeployer"
        );
        vm.prank(PROTOCOL_INITIALIZER);
        vm.expectRevert(VaultFactory.AgentPathAlreadyInitialized.selector);
        factory.initializeAgentPath(address(1), IVaultDeployer(address(2)));

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

        // The deployer is the protocol-wide constant, not the Deploy contract or the CREATE2 proxy.
        assertEq(dep, PROTOCOL_INITIALIZER, "deployer is PROTOCOL_INITIALIZER");
        assertEq(subReg.deployer(), PROTOCOL_INITIALIZER, "subReg deployer");
        assertEq(gov.deployer(), PROTOCOL_INITIALIZER, "gov deployer");
    }

    /// @notice The script lands every singleton at the address the manifest recipe predicts, which is
    /// a function of (proxy, salt, initcode) alone, and leaves the factory initialised.
    function test_deployLandsAtThePredictedAddresses() public {
        ProtocolCreate2.Set memory p = ProtocolCreate2.predict();
        Deploy d = new Deploy();
        (
            OperatorRegistry registry,
            SubVaultRegistry subReg,
            FeeEngine feeEngine,
            Governance gov,
            VaultDeployer vaultDeployer,
            AgentVaultDeployer agentVaultDeployer,
            VaultFactory factory
        ) = d.run();
        assertEq(address(registry), p.operatorRegistry, "OperatorRegistry");
        assertEq(address(subReg), p.subVaultRegistry, "SubVaultRegistry");
        assertEq(address(feeEngine), p.feeEngine, "FeeEngine");
        assertEq(address(gov), p.governance, "Governance");
        assertEq(address(vaultDeployer), p.vaultDeployer, "VaultDeployer");
        assertEq(address(agentVaultDeployer), p.agentVaultDeployer, "AgentVaultDeployer");
        assertEq(address(factory), p.vaultFactory, "VaultFactory");
        assertTrue(factory.initialized(), "factory initialised");
        assertTrue(registry.initialized() && subReg.initialized() && gov.initialized(), "wired");
    }

    /// @notice Fee model A1: the script performs the one-shot `FeeEngine.initialize`, so the engine
    /// takes a fee from the first settlement. On the local chain (31337) it uses the fixed
    /// placeholder; the one-shot is spent, so a second call reverts.
    function test_deploySetsTheFeeTreasuryOnce() public {
        Deploy d = new Deploy();
        (,, FeeEngine feeEngine,,,,) = d.run();
        assertEq(feeEngine.treasury(), TreasuryConfig.LOCAL_TREASURY, "treasury set by the script");
        vm.prank(PROTOCOL_INITIALIZER);
        vm.expectRevert(FeeEngine.AlreadyInitialized.selector);
        feeEngine.initialize(address(0xBEEF));
    }

    /// @notice A15 A3: the treasury lands BEFORE `registry.wire`, so there is no block in which a vault
    /// can be created while the engine takes no fee. Read from the emitted order, not the source.
    function test_deploySetsTheTreasuryBeforeTheRegistryIsWired() public {
        Deploy d = new Deploy();
        vm.recordLogs();
        (OperatorRegistry registry,, FeeEngine feeEngine,,,,) = d.run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 treasurySet = type(uint256).max;
        uint256 factorySet = type(uint256).max;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(feeEngine) && logs[i].topics[0] == FeeEngine.Initialized.selector) {
                treasurySet = i;
            }
            if (logs[i].emitter == address(registry) && logs[i].topics[0] == OperatorRegistry.FactorySet.selector) {
                factorySet = i;
            }
        }
        assertLt(factorySet, logs.length, "registry.wire emitted no FactorySet");
        assertLt(treasurySet, factorySet, "feeEngine.initialize must land before registry.wire");
    }

    /// @notice On any real chain the treasury must be supplied: with `FEE_TREASURY` unset the read
    /// refuses, so the deploy stops before anything is sent. (FEE_TREASURY is unset in CI.)
    function test_realChainRefusesAnUnsetFeeTreasury() public {
        TreasuryConfigHarness h = new TreasuryConfigHarness();
        vm.chainId(5042000); // any non-31337 chain
        vm.expectRevert(
            bytes(
                "FeeEngine: a real-chain deploy requires a non-zero FEE_TREASURY (the per-chain treasury, set once)"
            )
        );
        h.read();
        vm.chainId(31337);
        assertEq(h.read(), TreasuryConfig.LOCAL_TREASURY, "local chain falls back to the placeholder");
    }

    /// @notice The agent registry must exist before the script runs: the factory pins its address for
    /// good, so the script refuses (before sending anything) when the recorded address has no code.
    function test_deployRefusesWhenTheAgentRegistryIsNotDeployed() public {
        vm.etch(_recordedRegistry(), "");
        Deploy d = new Deploy();
        vm.expectRevert(
            bytes(
                "Deploy: the agent registry at config/agent-registry-create2.json has no code on this chain; deploy it first"
            )
        );
        d.run();
        assertEq(ProtocolCreate2.predict().vaultFactory.code.length, 0, "nothing was deployed");
    }

    function test_proxyFixtureMatchesTheKnownCodehash() public view {
        assertEq(ProtocolCreate2.PROXY.codehash, PROXY_CODEHASH, "fixture is the real Arachnid runtime");
        assertEq(ProtocolCreate2.PROXY.code.length, 69, "69 bytes");
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
