// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Integration: a VaultCore priced by ChainlinkOracle (the C-6 pivot) — end-to-end, not the oracle
// in isolation. Proves (1) the vault reads its basket NAV through the Chainlink feed correctly, and
// (2) ChainlinkOracle's fail-closed contract PROPAGATES: a stale/reverting feed freezes NAV, so
// deposits and exits revert rather than pricing against bad data. This is the evidence that
// ChainlinkOracle is a drop-in for the custom OracleAggregator in the `oracle_` slot with no
// VaultCore change.

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockERC20, StubGovernance, StubFeeEngine, StubRegistry} from "../mocks/Mocks.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

contract ChainlinkOracleVaultIntegrationTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth;
    MockAggregatorV3 feed; // wETH/USD, 8 decimals
    ChainlinkOracle oracle;
    StubGovernance gov;
    StubFeeEngine fees;
    StubRegistry registry;
    VaultCore vault;

    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        gov = new StubGovernance();
        fees = new StubFeeEngine();
        registry = new StubRegistry();

        feed = new MockAggregatorV3(8, 2500e8, block.timestamp); // $2500
        address[] memory assets = new address[](1);
        assets[0] = address(weth);
        address[] memory feeds = new address[](1);
        feeds[0] = address(feed);
        uint32[] memory hb = new uint32[](1);
        hb[0] = 3600;
        uint256[] memory z = new uint256[](1); // bounds disabled
        oracle = new ChainlinkOracle(assets, feeds, hb, z, z, address(usdc), address(0));

        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        vault = new VaultCore(
            address(usdc),
            basket,
            address(this),
            registry,
            gov,
            fees,
            oracle, // <-- ChainlinkOracle in the oracle_ slot, unchanged VaultCore
            0,
            10 * USDC_1,
            0,
            0,
            new address[](0),
            address(0)
        );

        usdc.mint(alice, 10_000_000 * USDC_1);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000 * USDC_1);
        vault.skipWindow();
        vm.stopPrank();
    }

    /// @dev Simulate a settled rebalance: move `usdcAmt` idle into `wethAmt` wETH held.
    function _invest(uint256 usdcAmt, uint256 wethAmt) internal {
        weth.mint(address(vault), wethAmt);
        stdstore.target(address(vault)).sig("assetBalance(address)").with_key(address(weth))
            .checked_write(wethAmt);
        stdstore.target(address(vault)).sig("idleUsdc()").checked_write(vault.idleUsdc() - usdcAmt);
    }

    function test_vaultPricesBasketThroughChainlinkFeed() public {
        // All idle: NAV == idle (oracle not consulted, no basket holdings).
        assertEq(vault.navWad(), 1_000_000e18, "all-idle NAV");

        // Invest $500k into 200 wETH @ $2500. NAV = 200*2500 + 500k idle = $1.0m, via the feed.
        _invest(500_000 * USDC_1, 200e18);
        assertEq(vault.navWad(), 1_000_000e18, "NAV via ChainlinkOracle: 200 wETH @ $2500 + 500k idle");

        // Move the feed price to $3000: NAV rises to 200*3000 + 500k = $1.1m — proves the vault
        // reads the live Chainlink price.
        feed.set(3000e8, block.timestamp);
        assertEq(vault.navWad(), 1_100_000e18, "NAV tracks the Chainlink feed price");
    }

    function test_staleFeedFreezesDepositsAndExits() public {
        _invest(500_000 * USDC_1, 200e18); // basket held, so NAV needs the oracle

        // Feed goes stale (older than the 3600s heartbeat): ChainlinkOracle reverts StaleOracle,
        // and that propagates — navWad reverts, so deposit and exit both fail closed.
        feed.set(2500e8, block.timestamp - 3601);

        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(weth)));
        vault.navWad();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(weth)));
        vault.deposit(1000 * USDC_1);

        uint256 sh = vault.sharesOf(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(weth)));
        vault.requestExit(sh);

        // Fresh feed restores everything.
        feed.set(2500e8, block.timestamp);
        assertGt(vault.navWad(), 0, "fresh feed: vault prices again");
        vm.prank(alice);
        vault.requestExit(sh); // exits now
        assertEq(vault.sharesOf(alice), 0, "exit settles once the feed is fresh");
    }
}
