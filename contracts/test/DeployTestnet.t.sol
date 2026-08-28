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
import {OracleAggregator} from "../src/OracleAggregator.sol";
import {AggregationRouterAdapter} from "../src/AggregationRouterAdapter.sol";

/// Proves the parameterized testnet deploy script wires the FULL stack the committed
/// `config/base-sepolia.json` describes: singletons + locked one-shot wiring (as Deploy.t.sol
/// proves for Deploy.s.sol) PLUS the per-vault infra — ChainlinkSourceAdapters per configured
/// feed, an OracleAggregator that medians through them, and a selector-allowlisted
/// AggregationRouterAdapter. The real Base Sepolia feed addresses are mocked locally.
contract DeployTestnetTest is Test {
    // Canonical Base Sepolia addresses — must match config/base-sepolia.json.
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
        _mockFeed(ETH_USD_FEED, 1917e8);
        _mockFeed(LINK_USD_FEED, 975e6);

        DeployTestnet d = new DeployTestnet();
        (
            OperatorRegistry registry,
            SubVaultRegistry subReg,
            FeeEngine feeEngine,
            Governance gov,
            VaultDeployer vaultDeployer,
            VaultFactory factory,
            OracleAggregator aggregator,
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

        // Oracle stack: each config asset listed with 3 adapter sources, 2-of-3 quorum,
        // 1-day staleness — the constructor-enforced floor (>=3, strict majority, <=1 day).
        address[2] memory assets = [WETH, LINK];
        for (uint256 i; i < assets.length; ++i) {
            (address[] memory sources, uint32 maxStaleness, uint8 quorum) = aggregator.assetConfig(assets[i]);
            assertEq(sources.length, 3, "3 sources");
            assertEq(quorum, 3, "H-1: quorum reaches MIN_MEDIAN (3-of-3 on this testnet)");
            assertEq(maxStaleness, 1 days, "staleness at the 1-day ceiling");
            for (uint256 j; j < sources.length; ++j) {
                assertTrue(sources[j].code.length > 0, "source adapter deployed");
            }
        }

        // Prices flow feed → ChainlinkSourceAdapter (8→18 dec) → median.
        assertEq(aggregator.priceWad(WETH), 1917e18, "WETH median WAD");
        assertEq(aggregator.priceWad(LINK), 9.75e18, "LINK median WAD");

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
        vm.chainId(8453); // Base MAINNET against a base-sepolia config must fail hard
        DeployTestnet d = new DeployTestnet();
        vm.expectRevert(abi.encodeWithSelector(DeployTestnet.ChainIdMismatch.selector, 84532, 8453));
        d.run();
    }
}
