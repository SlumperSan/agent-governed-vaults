// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";
import {MockERC20} from "./mocks/Mocks.sol";

contract SplitRegistry is IRegistryView {
    mapping(address => uint256) public opOf;
    uint256 public recorded;

    function attest(address vault, uint256 opId) external {
        opOf[vault] = opId;
    }

    function operatorOf(address vault) external view returns (uint256) {
        return opOf[vault];
    }

    function carryOf(address, uint256) external pure returns (uint256) {
        return 0;
    }

    function operatorAddressOf(uint256) external pure returns (address) {
        return address(0xBAD); // A1: the engine must never credit this
    }

    function recordFeeCollected(uint256, uint256 amount) external {
        recorded += amount;
    }
}

/// @dev A vault that holds an escrowed slice and hands it to the engine on `claimEscrowed`.
contract SplitVault {
    MockERC20 public token;
    address public engine;
    address public creator;

    constructor(MockERC20 token_, address engine_, address creator_) {
        token = token_;
        engine = engine_;
        creator = creator_;
    }

    function usdc() external view returns (address) {
        return address(token);
    }

    function claimable(address, address) external pure returns (uint256) {
        return 0;
    }

    function claimEscrowed(address asset) external {
        MockERC20(asset).transfer(engine, MockERC20(asset).balanceOf(address(this)));
    }
}

/// @notice Fee model A1 at the engine: of every collected fee the vault creator is credited 90% and
/// the treasury 10%, on the cash path, the in-kind path and the escrow-pull path; no dust is lost or
/// created; `initialize` is one-shot, initializer-only and refuses a zero treasury.
contract FeeEngineSplitTest is Test {
    SplitRegistry registry;
    FeeEngine engine;
    MockERC20 usdc;
    MockERC20 basketAsset;
    SplitVault vault;

    address creator = makeAddr("creator");
    address treasury = makeAddr("treasury");
    address member = makeAddr("member");

    function setUp() public {
        registry = new SplitRegistry();
        engine = new FeeEngine(IRegistryView(address(registry)));
        usdc = new MockERC20("USDC", 6);
        basketAsset = new MockERC20("WBTC", 8);
        vault = new SplitVault(usdc, address(engine), creator);
        registry.attest(address(vault), 1);
        vm.prank(PROTOCOL_INITIALIZER);
        engine.initialize(treasury);
    }

    function _total(address token) internal view returns (uint256) {
        return engine.claimableFees(creator, token) + engine.claimableFees(treasury, token);
    }

    // ── initialize ───────────────────────────────────────────────────────────

    function test_initialize_setsTreasuryOnce() public {
        assertEq(engine.treasury(), treasury);
        vm.prank(PROTOCOL_INITIALIZER);
        vm.expectRevert(FeeEngine.AlreadyInitialized.selector);
        engine.initialize(makeAddr("other"));
        assertEq(engine.treasury(), treasury, "second call changed nothing");
    }

    function test_initialize_zeroTreasuryRefused() public {
        FeeEngine fresh = new FeeEngine(IRegistryView(address(registry)));
        vm.prank(PROTOCOL_INITIALIZER);
        vm.expectRevert(FeeEngine.ZeroTreasury.selector);
        fresh.initialize(address(0));
        assertEq(fresh.treasury(), address(0), "still unset, so a valid call can follow");
        vm.prank(PROTOCOL_INITIALIZER);
        fresh.initialize(treasury);
        assertEq(fresh.treasury(), treasury);
    }

    function test_initialize_onlyProtocolInitializer() public {
        FeeEngine fresh = new FeeEngine(IRegistryView(address(registry)));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(FeeEngine.OnlyInitializer.selector);
        fresh.initialize(treasury);
    }

    function test_rateAndShareAreConstants() public view {
        assertEq(engine.PERF_FEE_BPS(), 1_000, "10% fee unchanged");
        assertEq(engine.TREASURY_SHARE_BPS(), 1_000, "10% of the fee to the treasury");
    }

    // ── onRealize before and after initialize ────────────────────────────────

    function test_onRealize_returnsFeeOnceInitialized() public {
        vm.prank(address(vault));
        assertEq(engine.onRealize(member, 1_000e6, 0), 100e6, "10% of net gain");
    }

    function test_onRealize_noFeeBeforeInitialize() public {
        FeeEngine fresh = new FeeEngine(IRegistryView(address(registry)));
        registry.attest(address(vault), 1);
        vm.prank(address(vault));
        assertEq(fresh.onRealize(member, 1_000e6, 0), 0, "nothing withheld that could not be credited");
    }

    // ── no path can credit before the treasury is set ────────────────────────

    function test_creditBeforeInitializeReverts() public {
        FeeEngine fresh = new FeeEngine(IRegistryView(address(registry)));
        registry.attest(address(vault), 1);
        vm.startPrank(address(vault));
        vm.expectRevert(FeeEngine.TreasuryNotSet.selector);
        fresh.onFeeCollected(member, 1_000_000);
        vm.expectRevert(FeeEngine.TreasuryNotSet.selector);
        fresh.onFeeCollectedAsset(member, address(basketAsset), 3e8);
        vm.stopPrank();
        usdc.mint(address(vault), 5_000_000);
        vm.expectRevert(FeeEngine.TreasuryNotSet.selector);
        fresh.pullEscrowed(address(vault), address(usdc));
    }

    // ── the split on every crediting path ────────────────────────────────────

    function test_split_cashPath() public {
        vm.prank(address(vault));
        engine.onFeeCollected(member, 1_000_000);
        assertEq(engine.claimableFees(creator, address(usdc)), 900_000, "creator 90%");
        assertEq(engine.claimableFees(treasury, address(usdc)), 100_000, "treasury 10%");
        assertEq(
            engine.claimableFees(address(0xBAD), address(usdc)), 0, "registry operator address not credited"
        );
        assertEq(registry.recorded(), 1_000_000, "registry stat records the full fee collected");
    }

    function test_split_inKindPath() public {
        vm.prank(address(vault));
        engine.onFeeCollectedAsset(member, address(basketAsset), 3e8);
        assertEq(engine.claimableFees(creator, address(basketAsset)), 2.7e8);
        assertEq(engine.claimableFees(treasury, address(basketAsset)), 0.3e8);
    }

    function test_split_escrowPullPath() public {
        usdc.mint(address(vault), 5_000_000);
        engine.pullEscrowed(address(vault), address(usdc));
        assertEq(engine.claimableFees(creator, address(usdc)), 4_500_000);
        assertEq(engine.claimableFees(treasury, address(usdc)), 500_000);
        assertEq(usdc.balanceOf(address(engine)), _total(address(usdc)), "balance == credits");
    }

    // ── rounding: no dust lost or created ────────────────────────────────────

    function test_rounding_oddAmountsSumExactly() public {
        uint256[7] memory amounts = [uint256(1), 2, 9, 10, 11, 19, 123_457];
        uint256 sum;
        for (uint256 i; i < amounts.length; ++i) {
            vm.prank(address(vault));
            engine.onFeeCollected(member, amounts[i]);
            sum += amounts[i];
            assertEq(_total(address(usdc)), sum, "credits == collected after every call");
        }
        // 1 and 2 and 9 floor to a zero treasury share; the creator absorbs the remainder.
        vm.prank(address(vault));
        engine.onFeeCollected(member, 1);
        assertEq(_total(address(usdc)), sum + 1);
    }

    function testFuzz_rounding_splitSumsToAmount(uint96 amount) public {
        vm.prank(address(vault));
        engine.onFeeCollected(member, amount);
        assertEq(_total(address(usdc)), amount, "no dust lost or created");
        assertEq(
            engine.claimableFees(treasury, address(usdc)),
            uint256(amount) * 1_000 / 10_000,
            "treasury floored"
        );
    }

    // ── the vault calls the engine through a bounded call: the split must fit its gas budget ──

    /// @dev VaultCore calls `onFeeCollected` and `onFeeCollectedAsset` with `MODULE_CALL_GAS` = 300_000. A
    /// credit that ran out of gas would be dropped (event-logged) with the tokens already sent to the
    /// engine, so the split's worst case (cold creator and treasury slots, the creator read from the
    /// vault, the registry stat write) has to leave a wide margin. Half the budget is the bar.
    function test_creditFitsHalfTheVaultModuleGasBudget() public {
        vm.startPrank(address(vault));
        uint256 g0 = gasleft();
        engine.onFeeCollected(member, 1_000_000);
        uint256 cashGas = g0 - gasleft();
        g0 = gasleft();
        engine.onFeeCollectedAsset(member, address(basketAsset), 3e8);
        uint256 assetGas = g0 - gasleft();
        vm.stopPrank();
        assertLt(cashGas, 150_000, "cash path fits half of MODULE_CALL_GAS");
        assertLt(assetGas, 150_000, "in-kind path fits half of MODULE_CALL_GAS");
    }

    // ── claims pay each recipient its own credit ─────────────────────────────

    function test_bothRecipientsClaim() public {
        usdc.mint(address(engine), 1_000_000);
        vm.prank(address(vault));
        engine.onFeeCollected(member, 1_000_000);

        vm.prank(creator);
        engine.claimFees(address(usdc));
        vm.prank(treasury);
        engine.claimFees(address(usdc));

        assertEq(usdc.balanceOf(creator), 900_000);
        assertEq(usdc.balanceOf(treasury), 100_000);
        assertEq(usdc.balanceOf(address(engine)), 0, "engine fully paid out");
    }
}
