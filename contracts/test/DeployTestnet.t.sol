// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployTestnet} from "../script/DeployTestnet.s.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {FeeEngine} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {ChainlinkOracle} from "../src/oracle/ChainlinkOracle.sol";
import {IAggregatorV3} from "../src/OracleAggregator.sol";
import {AggregationRouterAdapter} from "../src/AggregationRouterAdapter.sol";

/// Proves the parameterized testnet deploy script wires the FULL stack the committed
/// `config/base-sepolia.json` describes, on the C-6 LAUNCH oracle model: singletons + locked
/// one-shot wiring (as Deploy.t.sol proves for Deploy.s.sol) PLUS the per-vault infra — a
/// {ChainlinkOracle} pricing each configured asset from ONE Chainlink feed, SEEDED INTO THE
/// FACTORY'S ORACLE ALLOWLIST (the C-6 curation gate), and a selector-allowlisted
/// AggregationRouterAdapter. The real Base Sepolia feed addresses are mocked locally.
contract DeployTestnetTest is Test {
    // Canonical Base Sepolia addresses — must match config/base-sepolia.json (chainlinkOracle block).
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant LINK = 0xE4aB69C077896252FAFBD49EFD26B5D171A32410;
    address constant ETH_USD_FEED = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;
    address constant LINK_USD_FEED = 0xb113F5A928BCfF189C998ab20d753a47F9dE5A61;
    address constant ROUTER = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;

    function _mockFeed(address feed, int256 answer8dec) internal {
        vm.etch(feed, hex"00"); // mockCall requires code at the address
        vm.mockCall(feed, abi.encodeWithSignature("decimals()"), abi.encode(uint8(8)));
        vm.mockCall(
            feed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), answer8dec, uint256(block.timestamp), block.timestamp, uint80(1))
        );
    }

    function test_testnetDeployWiresFullStack() public {
        // Answers inside the config's sane-price bands (WETH $100..$100k, LINK $1..$1k).
        _mockFeed(ETH_USD_FEED, 1917e8); // $1,917
        _mockFeed(LINK_USD_FEED, 975e6); // $9.75

        DeployTestnet d = new DeployTestnet();
        (
            OperatorRegistry registry,
            SubVaultRegistry subReg,
            FeeEngine feeEngine,
            Governance gov,
            VaultDeployer vaultDeployer,
            VaultFactory factory,
            ChainlinkOracle oracle,
            AggregationRouterAdapter routerAdapter
        ) = d.run();

        // Singleton wiring resolved and permanently locked (same guarantees Deploy.t.sol proves).
        assertEq(registry.factory(), address(factory), "registry factory");
        assertEq(registry.feeEngine(), address(feeEngine), "registry feeEngine");
        assertEq(subReg.factory(), address(factory), "subReg factory");
        assertEq(gov.subVaultRegistry(), address(subReg), "gov subReg");
        assertEq(address(factory.vaultDeployer()), address(vaultDeployer), "factory vaultDeployer");
        vm.startPrank(registry.deployer());
        vm.expectRevert(OperatorRegistry.AlreadyWired.selector);
        registry.wire(address(1), address(2));
        vm.stopPrank();

        // C-6 curation gate: the deployed ChainlinkOracle is the ONE blessed oracle, and enforcement
        // is on (a non-empty allowlist). A stray address is not allowed.
        assertTrue(factory.oracleAllowlistEnforced(), "allowlist enforced");
        assertTrue(factory.isAllowedOracle(address(oracle)), "the deployed oracle is blessed");
        assertFalse(factory.isAllowedOracle(address(0xdead)), "a stray oracle is not blessed");

        // Oracle: each config asset maps to its single Chainlink feed with the config's heartbeat and
        // sane-price band; no custom multi-source median (C-6).
        (IAggregatorV3 ethFeed, uint32 ethHb,, uint128 ethMin, uint128 ethMax) = oracle.feedOf(WETH);
        assertEq(address(ethFeed), ETH_USD_FEED, "WETH -> ETH/USD feed");
        assertEq(ethHb, 86400, "WETH heartbeat (testnet-generous 24h)");
        assertEq(ethMin, 100e18, "WETH band floor $100");
        assertEq(ethMax, 100_000e18, "WETH band ceiling $100k");
        (IAggregatorV3 linkFeed,,,,) = oracle.feedOf(LINK);
        assertEq(address(linkFeed), LINK_USD_FEED, "LINK -> LINK/USD feed");

        // Prices flow feed (8 dec) → WAD (scale 1e10). No median: one genuine feed per asset.
        assertEq(oracle.priceWad(WETH), 1917e18, "WETH priceWad");
        assertEq(oracle.priceWad(LINK), 9.75e18, "LINK priceWad");
        assertEq(oracle.priceWad(0x036CbD53842c5426634e7929541eC2318f3dCF7e), 1e18, "USDC pinned to $1");

        // Execution adapter pinned to the configured router, swap selectors allow-listed.
        assertEq(routerAdapter.router(), ROUTER, "router pinned");
        assertTrue(
            routerAdapter.allowedSelector(
                bytes4(
                    keccak256("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")
                )
            ),
            "exactInputSingle allowed"
        );
        assertTrue(
            routerAdapter.allowedSelector(bytes4(keccak256("exactInput((bytes,address,uint256,uint256))"))),
            "exactInput allowed"
        );
        assertFalse(
            routerAdapter.allowedSelector(bytes4(keccak256("transfer(address,uint256)"))), "no strays"
        );
    }

    function test_testnetDeployRevertsOnWrongChain() public {
        _mockFeed(ETH_USD_FEED, 1917e8);
        _mockFeed(LINK_USD_FEED, 975e6);
        vm.chainId(999); // a non-mainnet chain whose id does not match the base-sepolia config (84532)
        DeployTestnet d = new DeployTestnet();
        vm.expectRevert(abi.encodeWithSelector(DeployTestnet.ChainIdMismatch.selector, 84532, 999));
        d.run();
    }

    /// @notice This testnet script hardcodes allowSubVaults=true; on Base MAINNET that is the C-1
    /// topology (mainnet launches root-only via Deploy.s.sol). The guard refuses chainid 8453 up
    /// front, regardless of config — so no operator can stand up an immutable mainnet factory with
    /// sub-vaults enabled by pointing this script at a mainnet RPC.
    function test_refusesBaseMainnet() public {
        vm.chainId(8453); // Base mainnet
        DeployTestnet d = new DeployTestnet();
        vm.expectRevert(
            bytes("DeployTestnet refuses Base mainnet: it enables sub-vaults (C-1) - use Deploy.s.sol")
        );
        d.run();
    }
}
