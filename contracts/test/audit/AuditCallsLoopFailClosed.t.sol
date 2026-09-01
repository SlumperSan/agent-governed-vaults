// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {VaultFactory, IVaultDeployer} from "../../src/VaultFactory.sol";
import {VaultDeployer} from "../../src/VaultDeployer.sol";
import {SubVaultRegistry} from "../../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../../src/FeeEngine.sol";
import {Governance} from "../../src/Governance.sol";
import {ChainlinkOracle} from "../../src/oracle/ChainlinkOracle.sol";
import {IOperatorRegistry} from "../../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockERC20} from "../mocks/Mocks.sol";
import {MockAggregatorV3} from "../mocks/OracleSourceMocks.sol";

/// @notice Cluster C fixture: a basket asset whose `decimals()` reports cleanly but whose
/// `balanceOf()` is an unbounded gas sink. `VaultCore`'s constructor only ever probes
/// `decimals()` when validating a basket asset (`IERC20Metadata(a).decimals()`); it never calls
/// `balanceOf`. `test_constructorDecimalsProbeDoesNotProveBalanceOfIsSafe` uses this to show
/// construction-time validation does not, and structurally cannot cheaply, extend to `balanceOf`.
contract DecimalsOkBalanceOfHostile {
    function decimals() external pure returns (uint8) {
        return 18;
    }

    /// @dev A genuine gas-exhaustion sink (not a plain revert): a bounded-looking loop whose
    /// iteration count (2**256 - 1) is unreachable within any real gas budget, so any caller
    /// without a gas cap on this call burns everything it has before this ever returns.
    function balanceOf(address) external pure returns (uint256) {
        uint256 i;
        for (; i < type(uint256).max; ++i) {}
        return i;
    }
}

/// @notice Pins the behaviour Slither `calls-loop` clusters B (the basket-asset pricing loop in
/// `navWad`/`_settleExit`) and C (the raw, uncapped `balanceOf` reads in `_bal`) are dispositioned
/// on. LAUNCH CONFIGURATION: `allowSubVaults = false`, a single root vault, no children — this is
/// the shape every mainnet vault actually has at launch (audit finding C-1).
///
/// Cluster B's disposition: one dead feed anywhere in a FUNDED basket asset freezes the whole
/// vault — every NAV-reading path, deposit, and exit — by design (K-4/SF-2, fail-closed
/// oracle). This is not a bug to fix; it is documented as an accepted posture on `navWad`'s own
/// natspec. A dead feed on an UNFUNDED basket asset (`assetBalance == 0`) is inert, because
/// `navWad`/`_fullNavWad` skip zero balances — and, load-bearingly, an arbitrary donor cannot
/// force that asset "funded" by sending it tokens directly, because NAV reads the vault's
/// internal `assetBalance` accounting, never `balanceOf` (EE-1). So cluster B degrades to a
/// benign, curated-basket risk rather than a permissionless griefing vector.
///
/// Cluster C's residual: `_bal` (VaultCore.sol:910) calls `balanceOf` with NO gas cap, unlike
/// every payout leg (`_payOrEscrow` -> `tryTransfer(..., MODULE_CALL_GAS)`). A basket asset whose
/// `balanceOf` is a gas bomb is not caught at construction — only `decimals()` is probed there.
/// Basket curation is the entire defence; this file shows the construction-time gap directly.
contract AuditCallsLoopFailClosedTest is Test {
    using stdStorage for StdStorage;

    uint256 constant USDC_1 = 1e6;
    uint256 constant N_ASSETS = 10;

    MockERC20 usdc;
    MockERC20[N_ASSETS] assets;
    MockAggregatorV3[N_ASSETS] feeds;
    ChainlinkOracle oracle;

    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultFactory factory;

    VaultCore root;

    address operator = makeAddr("operator");
    uint256 internal BAL_SLOT;
    bool internal balSlotFound;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);

        address[] memory oAssets = new address[](N_ASSETS);
        address[] memory oFeeds = new address[](N_ASSETS);
        uint32[] memory oHb = new uint32[](N_ASSETS);
        uint256[] memory oMin = new uint256[](N_ASSETS);
        uint256[] memory oMax = new uint256[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            assets[i] = new MockERC20("A", 18);
            feeds[i] = new MockAggregatorV3(8, 2000e8, block.timestamp);
            oAssets[i] = address(assets[i]);
            oFeeds[i] = address(feeds[i]);
            oHb[i] = 1 hours; // within [MIN_HEARTBEAT, MAX_HEARTBEAT]
        }
        oracle = new ChainlinkOracle(oAssets, oFeeds, oHb, oMin, oMax, address(usdc), address(0));

        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        gov = new Governance();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(subReg),
            IVaultDeployer(address(new VaultDeployer())),
            false, // LAUNCH CONFIGURATION: sub-vaults disabled (C-1, root vaults only)
            new address[](0) // C-6: no oracle allowlist (permissive, matches NavGas.t.sol)
        );
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));

        address[] memory basket = new address[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            basket[i] = address(assets[i]);
        }

        vm.prank(operator);
        root = VaultCore(
            factory.createVault(
                VaultFactory.VaultParams({
                    usdc: address(usdc),
                    basketAssets: basket,
                    oracle: IOracleAggregator(address(oracle)),
                    capacityCapUsdc: 0,
                    minDepositUsdc: 10 * USDC_1,
                    exitFeeMaxBps: 0,
                    exitFeeDecayPeriod: 0,
                    allowedAdapters: new address[](0)
                })
            )
        );

        usdc.mint(operator, 1_000_000 * USDC_1);
        vm.startPrank(operator);
        usdc.approve(address(root), type(uint256).max);
        root.deposit(1_000_000 * USDC_1);
        root.skipWindow(); // activates the pending deposit immediately; operator holds all shares
        vm.stopPrank();

        // Fund assets[0..8] (nine assets) with a non-zero assetBalance; deliberately leave
        // assets[9] at assetBalance == 0. One stdstore write locates the mapping's base storage
        // slot, every subsequent write goes straight through vm.store (see AuditCallsLoopMaxBound
        // for why: stdstore's per-call slot search does not scale to many writes).
        // NOT 1e18: assetUnit[a] == 10**decimals == 1e18 for every 18-decimal basket asset
        // already, before any write here, so a 1e18 seed would make the slot-scan below match
        // assetUnit's slot instead of assetBalance's on a pure value coincidence.
        uint256 seedVal = 123_456_789_012_345_678;
        stdstore.target(address(root)).sig("assetBalance(address)").with_key(address(assets[0]))
            .checked_write(seedVal);
        require(root.assetBalance(address(assets[0])) == seedVal, "stdstore seed write failed");

        for (uint256 s; s < 200; ++s) {
            bytes32 v = vm.load(address(root), keccak256(abi.encode(address(assets[0]), s)));
            if (uint256(v) == seedVal) {
                BAL_SLOT = s;
                balSlotFound = true;
                break;
            }
        }
        assertTrue(balSlotFound, "assetBalance storage slot not found by scan");

        for (uint256 i = 1; i < 9; ++i) {
            vm.store(address(root), keccak256(abi.encode(address(assets[i]), BAL_SLOT)), bytes32(seedVal));
        }

        for (uint256 i; i < 9; ++i) {
            assertEq(root.assetBalance(address(assets[i])), seedVal, "funded asset readback");
        }
        assertEq(root.assetBalance(address(assets[9])), 0, "assets[9] deliberately left unfunded");
    }

    /// @notice Cluster B, the accepted posture. `feeds[3]` backs a FUNDED basket asset
    /// (`assetBalance != 0`). Killing it must freeze `navWad`, `deposit`, and `requestExit` alike
    /// — this is K-4/SF-2 exactly as documented on `navWad`'s natspec ("Reverts while the oracle
    /// breaker is tripped — freezing everything, including exits, by design"). A mutation that
    /// let any of these three paths succeed while the feed is down would silently relax that
    /// documented guarantee.
    function test_oneDeadFeedOnAFundedAssetFreezesTheWholeVault() public {
        feeds[3].setReverts(true);

        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(assets[3])));
        root.navWad();

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(assets[3])));
        root.deposit(10 * USDC_1);

        // Full exit forces every basket asset's slice to equal its assetBalance exactly (sole
        // holder => fee waived => burnKeep == tsBps), so assets[3]'s slice is guaranteed non-zero
        // and _assetValueWad must reach the dead feed.
        uint256 shares = root.sharesOf(operator);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(assets[3])));
        root.requestExit(shares);
    }

    /// @notice Cluster B's other half. `feeds[9]` backs the ONE basket asset deliberately left at
    /// `assetBalance == 0`. `navWad`/`_fullNavWad` skip zero balances (VaultCore.sol:287), so an
    /// unfunded asset's dead feed must be inert: `navWad` still succeeds, and its value is
    /// unchanged from before the feed died (nothing about killing an unread feed can move NAV). A
    /// mutation that started pricing zero-balance assets would trip either assertion.
    function test_deadFeedOnAZeroBalanceAssetDoesNotFreezeTheVault() public {
        uint256 navBefore = root.navWad();

        feeds[9].setReverts(true);

        uint256 navAfter = root.navWad();
        assertEq(navAfter, navBefore, "dead feed on an unfunded asset must not move NAV");
    }

    /// @notice EE-1, the LOAD-BEARING test for cluster B's benign disposition. Without this
    /// guarantee, an unfunded dead-feed asset (test above) would be a griefing vector: anyone
    /// could donate the token straight to the vault to force it "funded" and freeze every NAV
    /// path. `navWad` reads the internal `assetBalance` mapping, never `balanceOf` — so a raw
    /// ERC20 donation from an arbitrary, unpermissioned address cannot give a dead-feed asset a
    /// non-zero ACCOUNTED balance. A mutation that let `navWad` read `balanceOf` (directly or via
    /// donation-triggered accounting) would flip this from benign to a live DoS and trip either
    /// assertion below.
    function test_donatingTheDeadFeedTokenDoesNotFreezeTheVault() public {
        feeds[9].setReverts(true);
        uint256 nav0 = root.navWad();

        assets[9].mint(address(root), 1_000_000e18); // raw donation, no vault-side call at all

        assertEq(root.navWad(), nav0, "a raw donation must not move accounted NAV");
        assertEq(root.assetBalance(address(assets[9])), 0, "internal accounting is untouched by a donation");
        assertEq(assets[9].balanceOf(address(root)), 1_000_000e18, "the donated tokens are genuinely held");
    }

    /// @notice Cluster C's residual. `VaultCore`'s constructor validates a basket asset only via
    /// `decimals()` (`IERC20Metadata(a).decimals()`); it never touches `balanceOf`. `_bal`
    /// (VaultCore.sol:910), which every measured-delta site in the contract funnels through
    /// including the hot NAV/exit paths, calls `balanceOf` with NO gas cap — unlike every payout
    /// leg, which goes through `_payOrEscrow` -> `tryTransfer(..., MODULE_CALL_GAS)`. This proves
    /// construction does NOT extend its validation to `balanceOf`: a token whose `decimals()` lies
    /// clean but whose `balanceOf` is an unbounded gas sink still constructs a vault successfully.
    /// Curation of the basket at listing time is the entire defence — a mutation that made
    /// construction probe `balanceOf` (closing this gap) would make this specific hostile token
    /// revert here instead of succeeding.
    function test_constructorDecimalsProbeDoesNotProveBalanceOfIsSafe() public {
        DecimalsOkBalanceOfHostile hostile = new DecimalsOkBalanceOfHostile();

        // _requireOracleCoversBasket runs at creation and calls priceWad (not balanceOf), so the
        // hostile token needs its own listed feed — a fresh single-asset oracle is simplest.
        MockAggregatorV3 hostileFeed = new MockAggregatorV3(8, 1e8, block.timestamp);
        address[] memory hAssets = new address[](1);
        hAssets[0] = address(hostile);
        address[] memory hFeeds = new address[](1);
        hFeeds[0] = address(hostileFeed);
        uint32[] memory hHb = new uint32[](1);
        hHb[0] = 1 hours;
        uint256[] memory hZ = new uint256[](1);
        ChainlinkOracle hostileOracle =
            new ChainlinkOracle(hAssets, hFeeds, hHb, hZ, hZ, address(0), address(0));

        address[] memory basket = new address[](1);
        basket[0] = address(hostile);

        vm.prank(operator);
        address vault = factory.createVault(
            VaultFactory.VaultParams({
                usdc: address(usdc),
                basketAssets: basket,
                oracle: IOracleAggregator(address(hostileOracle)),
                capacityCapUsdc: 0,
                minDepositUsdc: 10 * USDC_1,
                exitFeeMaxBps: 0,
                exitFeeDecayPeriod: 0,
                allowedAdapters: new address[](0)
            })
        );

        assertTrue(vault != address(0), "construction must succeed: only decimals() is probed, not balanceOf");
    }
}
