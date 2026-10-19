// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ProtocolCreate2} from "../script/lib/ProtocolCreate2.sol";
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {FeeEngine} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";

/// @notice FORK TEST. The same-address set deployed through the REAL Arachnid proxy on Arc mainnet
/// state, initialised with `vm.prank(PROTOCOL_INITIALIZER)`, against the live ChainlinkOracle and Arc
/// USDC and cirBTC. Nothing is broadcast: this runs on a local fork and sends no transaction.
///
/// What it proves that the local suite cannot: the proxy at 0x4e59... on Arc has the code the local
/// fixture assumes (69 bytes, the known codehash), a deployment through it lands at the manifest
/// address, the v2 set can be created beside the live v1 set without touching it, and the live
/// oracle's creation probe (real Chainlink reads) accepts a vault on the new factory.
///
/// SKIPPING. Needs `ARC_MAINNET_RPC_URL` (for example https://rpc.mainnet.arc.io). When it is absent
/// every test calls `vm.skip(true)`, which forge reports as skipped and never as a pass. The
/// `testFork_` prefix keeps these out of `forge snapshot --check`, as for the other fork tests.
///
///     ARC_MAINNET_RPC_URL=https://rpc.mainnet.arc.io forge test --mc Create2ArcFork -vv
contract Create2ArcForkTest is Test {
    uint256 constant ARC_CHAIN_ID = 5042;
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address constant CIRBTC = 0x171A4217b86A807A64eB94757Db6849fb4bDbAA0;
    bytes32 constant PROXY_CODEHASH = 0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    bool internal forked;
    string internal deployment;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return; // every test vm.skip()s; the fork is never created
        vm.createSelectFork(rpc);
        assertEq(block.chainid, ARC_CHAIN_ID, "ARC_MAINNET_RPC_URL is not Arc mainnet (5042)");
        deployment = vm.readFile("config/deployments/arc-mainnet.json");
        forked = true;
    }

    modifier onlyFork() {
        if (!forked) vm.skip(true);
        _;
    }

    function testFork_proxyIsTheKnownRuntime() public onlyFork {
        assertEq(ProtocolCreate2.PROXY.code.length, 69, "proxy runtime is 69 bytes on Arc");
        assertEq(ProtocolCreate2.PROXY.codehash, PROXY_CODEHASH, "proxy codehash");
    }

    function testFork_setDeploysAtManifestAddressesAndWires() public onlyFork {
        ProtocolCreate2.Set memory p = ProtocolCreate2.predict();
        assertEq(
            p.operatorRegistry.code.length, 0, "v2 OperatorRegistry address is empty on Arc before deploy"
        );
        assertEq(p.vaultFactory.code.length, 0, "v2 VaultFactory address is empty on Arc before deploy");

        // Anyone may send the six deployments: the proxy does not care who pays.
        vm.startPrank(makeAddr("anyone"));
        ProtocolCreate2.Set memory s = ProtocolCreate2.createAll();
        vm.stopPrank();
        assertEq(s.vaultFactory, p.vaultFactory, "factory at the predicted address");
        assertGt(p.vaultFactory.code.length, 0, "and it has code");

        VaultFactory factory = VaultFactory(s.vaultFactory);
        OperatorRegistry registry = OperatorRegistry(s.operatorRegistry);
        SubVaultRegistry subReg = SubVaultRegistry(s.subVaultRegistry);
        Governance gov = Governance(s.governance);

        // Uninitialised: the factory creates nothing.
        address oracle = vm.parseJsonAddress(deployment, ".oracle.ChainlinkOracle");
        VaultFactory.VaultParams memory params = _params(oracle);
        vm.prank(makeAddr("creator"));
        vm.expectRevert(VaultFactory.NotInitialized.selector);
        factory.createVault(params);

        // The INITIALIZER sets this chain's allowlist, then wires, in the order the sign queue uses.
        address[] memory allow = new address[](1);
        allow[0] = oracle;
        vm.startPrank(PROTOCOL_INITIALIZER);
        factory.initialize(allow);
        registry.wire(address(factory), s.feeEngine);
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));
        vm.stopPrank();

        assertTrue(
            factory.initialized() && registry.initialized() && subReg.initialized() && gov.initialized()
        );
        assertTrue(factory.oracleAllowlistEnforced(), "enforced");
        assertTrue(factory.isAllowedOracle(oracle), "live Arc oracle blessed");
        assertFalse(factory.isAllowedOracle(address(0xBEEF)), "negative control");

        // The live oracle's creation probe makes real Chainlink reads; the new factory accepts the vault.
        address creator = makeAddr("creator");
        vm.prank(creator);
        address vault = factory.createVault(params);
        assertEq(registry.operatorOf(vault), registry.operatorIdOf(creator), "attested on the v2 registry");
        assertEq(address(VaultCore(vault).oracle()), oracle, "built on the live oracle");

        // v1 is untouched: the live factory still counts exactly its one vault.
        address v1Factory = vm.parseJsonAddress(deployment, ".singletons.VaultFactory");
        assertTrue(v1Factory != address(factory), "v2 sits beside v1");
        assertEq(VaultFactory(v1Factory).vaultCount(), 1, "v1 still has its one vault");
    }

    function testFork_noOneButTheInitializerCanWireTheFreshSet() public onlyFork {
        ProtocolCreate2.Set memory s = ProtocolCreate2.createAll();
        vm.expectRevert(OperatorRegistry.OnlyDeployer.selector);
        OperatorRegistry(s.operatorRegistry).wire(s.vaultFactory, s.feeEngine);
        vm.prank(ProtocolCreate2.PROXY);
        vm.expectRevert(OperatorRegistry.OnlyDeployer.selector);
        OperatorRegistry(s.operatorRegistry).wire(s.vaultFactory, s.feeEngine);
    }

    function _params(address oracle) internal view returns (VaultFactory.VaultParams memory) {
        address[] memory basket = new address[](1);
        basket[0] = CIRBTC;
        address[] memory adapters = new address[](1);
        adapters[0] = vm.parseJsonAddress(deployment, ".execution.AggregationRouterAdapter");
        return VaultFactory.VaultParams({
            usdc: ARC_USDC,
            basketAssets: basket,
            oracle: IOracleAggregator(oracle),
            capacityCapUsdc: 0,
            minDepositUsdc: 100e6,
            exitFeeMaxBps: 50,
            exitFeeDecayPeriod: 30 days,
            allowedAdapters: adapters
        });
    }
}
