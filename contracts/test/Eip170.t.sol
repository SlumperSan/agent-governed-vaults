// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {VaultFactory, IVaultDeployer} from "../src/VaultFactory.sol";
import {VaultDeployer} from "../src/VaultDeployer.sol";
import {SubVaultRegistry} from "../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";
import {Governance} from "../src/Governance.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "./mocks/Mocks.sol";

/// Guards the #10 fix: every contract deployable under EIP-170, VaultCore's creation code
/// pinned at compile time rather than supplied by anyone, and the attestation anchor exactly
/// where it was — factory-gated, with VaultDeployer holding no authority of its own.
///
/// `forge build --sizes` already gates the 24,576 B cap itself. The budgets below are
/// deliberately far TIGHTER than the cap: their job is to fail loudly the moment something
/// re-embeds VaultCore's creation code in a contract's runtime, which is the specific mistake
/// that put VaultFactory 2,665 B over in the first place. A cap-shaped assertion would sail
/// straight past a factory that had silently grown back to 20 KB.
contract Eip170Test is Test {
    uint256 constant EIP170_RUNTIME_CAP = 24_576;
    uint256 constant EIP3860_INITCODE_CAP = 49_152;

    /// Re-embedding tripwires. Measured at the fix: factory 2,718 B, deployer 938 B.
    uint256 constant FACTORY_RUNTIME_BUDGET = 5_000;
    uint256 constant DEPLOYER_RUNTIME_BUDGET = 2_000;

    /// The headroom floor VaultCore must keep. See
    /// `test_vaultCoreKeepsTheReclaimedEip170Budget` for why this number and not another.
    uint256 constant CORE_MIN_RUNTIME_MARGIN = 2_000;

    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultDeployer vaultDeployer;
    VaultFactory factory;

    address operator = makeAddr("operator");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        oracle.setPrice(address(weth), 4_000e18);

        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        gov = new Governance();
        vaultDeployer = new VaultDeployer();
        factory = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(subReg),
            IVaultDeployer(address(vaultDeployer)),
            true, // asserts subVaultRegistry wiring propagates through the factory
            new address[](0) // C-6: no oracle allowlist (permissive)
        );
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));
    }

    // ── sizes ────────────────────────────────────────────────────────────────

    /// The defect in #10: VaultFactory's runtime carried VaultCore's whole creation code.
    function test_everyDeployedContractFitsUnderEip170() public view {
        uint256 core = vm.getDeployedCode("VaultCore.sol:VaultCore").length;
        uint256 fac = vm.getDeployedCode("VaultFactory.sol:VaultFactory").length;
        uint256 dep = vm.getDeployedCode("VaultDeployer.sol:VaultDeployer").length;

        assertLt(core, EIP170_RUNTIME_CAP, "VaultCore over EIP-170");
        assertLt(fac, EIP170_RUNTIME_CAP, "VaultFactory over EIP-170");
        assertLt(dep, EIP170_RUNTIME_CAP, "VaultDeployer over EIP-170");

        assertLt(fac, FACTORY_RUNTIME_BUDGET, "VaultFactory grew past its budget - re-embedded?");
        assertLt(dep, DEPLOYER_RUNTIME_BUDGET, "VaultDeployer grew past its budget - re-embedded?");
    }

    /// VaultCore's EIP-170 margin is not slack — it is the budget that decides whether a known
    /// fix can be deployed at all. H-5 and H-6 are confirmed High findings whose remediations
    /// were deferred for one reason: at **289 B** of margin they did not fit (both together
    /// measure +1,016 B; the figure was 283 B when the deferral was recorded, and #97 returned 6).
    /// Reclaiming duplicated call shapes took the margin to **4,095 B**, measured on the merged
    /// tree — not the 4,132 B this PR was written against, which predates #97.
    ///
    /// This guards that budget rather than the cap: `forge build --sizes` already fails at the
    /// cap, but by then the next fix has already been deferred.
    ///
    /// The floor is 2,000 B and not something tighter on purpose. Landing both remediations
    /// measured 3,320 B of remaining margin, but that was a probe: it priced the cheapest
    /// credible shape of each and did not carry the in-kind truncation drag, nor the
    /// escrow-degradation variant of H-6, either of which costs more. A floor set just under
    /// the probe would risk blocking the very sprint this budget exists to unblock. The job
    /// here is to catch headroom quietly disappearing — 2,000 B fires far sooner than the
    /// 289 B that caused the deferral, without arguing with the implementer who spends it.
    ///
    /// Be clear about what that buys and what it does not: this is a FLOOR, not a ratchet, so it
    /// correctly needs no edit when a change legitimately spends bytes — and it will let roughly
    /// half the reclaimed budget go without a word. That is the deliberate trade. It catches the
    /// cliff, not the slope. If the slope turns out to be the real risk, the answer is a ratchet
    /// that records the measured value, not a tighter floor.
    function test_vaultCoreKeepsTheReclaimedEip170Budget() public view {
        uint256 core = vm.getDeployedCode("VaultCore.sol:VaultCore").length;
        // `assertLt(core, cap - floor)` and not `assertGt(cap - core, floor)`: the latter
        // underflows to Panic(0x11) the moment VaultCore exceeds the cap, so the guard would die
        // without printing its own message in exactly the case it exists for. Both operands here
        // are compile-time constants, so the subtraction cannot underflow.
        assertLt(core, EIP170_RUNTIME_CAP - CORE_MIN_RUNTIME_MARGIN, "VaultCore headroom spent");
    }

    /// The cliff the fix trades onto: VaultCore's creation code no longer has to fit in a
    /// runtime slot, but it MUST still fit inside VaultDeployer's initcode (EIP-3860). This is
    /// the bound that would actually bite if VaultCore grew by tens of KB.
    function test_vaultCoreCreationCodeFitsInsideTheDeployersInitcode() public view {
        uint256 deployerInit = vm.getCode("VaultDeployer.sol:VaultDeployer").length;
        assertLt(deployerInit, EIP3860_INITCODE_CAP, "VaultDeployer initcode over EIP-3860");
    }

    // ── the pinned creation code ─────────────────────────────────────────────

    /// The load-bearing claim of the whole design: the bytes VaultDeployer will CREATE from are
    /// the compiled VaultCore creation code, byte for byte. Nobody supplies them at runtime.
    function test_deployerCreationCodeIsTheCompiledVaultCore() public view {
        assertEq(vaultDeployer.creationCode(), vm.getCode("VaultCore.sol:VaultCore"), "blob drift");
    }

    /// Chunks are data, not programs: each begins with STOP, so any call into one halts on its
    /// first byte. There is no SELFDESTRUCT to reach (and post-Cancun EIP-6780 would refuse it
    /// outside the creating transaction anyway), so the pinned blob cannot be removed.
    function test_codeChunksAreInertData() public view {
        address a = vaultDeployer.codeChunkA();
        address b = vaultDeployer.codeChunkB();
        assertEq(a.code[0], bytes1(0x00), "chunk A executable");
        assertEq(b.code[0], bytes1(0x00), "chunk B executable");
        assertEq(
            a.code.length - 1 + b.code.length - 1,
            vm.getCode("VaultCore.sol:VaultCore").length,
            "chunks do not reassemble to the full creation code"
        );
    }

    // ── the trust anchor, unchanged ──────────────────────────────────────────

    /// Factory-created vaults are attested; a vault created by calling the deployer DIRECTLY is
    /// not. That is the whole trust story (CM-5): VaultDeployer confers nothing, so a direct
    /// caller ends up exactly where they already were before this contract existed — holding an
    /// unattested VaultCore they could have deployed themselves.
    /// Both vaults are created by the same address with the same configuration, so their
    /// runtime code matches byte for byte down to the baked-in immutables — attestation is
    /// then provably the ONLY thing that separates them.
    function test_deployingDirectlyThroughTheDeployerIsNeverAttested() public {
        vm.prank(stranger);
        address attested = factory.createVault(_params());

        vm.prank(stranger);
        address bypass = vaultDeployer.deploy(_ctorArgs(stranger));

        assertEq(bypass.code, attested.code, "bypass vault is not the same VaultCore code");
        assertEq(VaultCore(bypass).creator(), stranger, "bypass creator");

        assertGt(registry.operatorOf(attested), 0, "factory vault not attested");
        assertEq(registry.operatorOf(bypass), 0, "deployer-created vault was attested");
    }

    /// The gate that makes the above true is on the registry, and the deployer never touches it.
    function test_attestationRemainsFactoryOnly() public {
        assertEq(registry.factory(), address(factory), "registry factory");
        vm.prank(address(vaultDeployer));
        vm.expectRevert(OperatorRegistry.OnlyFactory.selector);
        registry.attestVault(address(1), stranger);
    }

    /// The factory can only ever CREATE through the one deployer it was constructed with.
    function test_factoryPinsItsDeployerImmutably() public view {
        assertEq(address(factory.vaultDeployer()), address(vaultDeployer), "deployer pin");
    }

    // ── behaviour preserved across the extra hop ─────────────────────────────

    /// `new VaultCore(...)` bubbled the constructor's revert; the CREATE-in-assembly path must
    /// too, or every misconfiguration turns into an opaque failure.
    function test_vaultCoreConstructorRevertsStillBubbleThroughTheFactory() public {
        VaultFactory.VaultParams memory p = _params();
        p.exitFeeMaxBps = 101; // over EXIT_FEE_CAP_BPS
        vm.expectRevert(VaultCore.BadConfig.selector);
        factory.createVault(p);
    }

    /// Every vault the factory deploys still binds the same protocol singletons and the same
    /// creator identity it did when the factory used `new VaultCore(...)` directly.
    function test_deployedVaultBindsTheSameSingletonsAndCreator() public {
        vm.prank(operator);
        VaultCore v = VaultCore(factory.createVault(_params()));

        assertEq(v.creator(), operator, "creator");
        assertEq(address(v.operatorRegistry()), address(registry), "registry");
        assertEq(address(v.governance()), address(gov), "governance");
        assertEq(address(v.feeEngine()), address(fees), "feeEngine");
        assertEq(address(v.oracle()), address(oracle), "oracle");
        assertEq(v.subVaultRegistry(), address(subReg), "subVaultRegistry");
        assertEq(v.usdc(), address(usdc), "usdc");
        assertEq(v.assetUnit(address(weth)), 1e18, "basket asset");
        assertEq(v.capacityCapUsdc(), 1_000_000 * USDC_1, "capacity cap");
        assertEq(v.minDepositUsdc(), 100 * USDC_1, "min deposit");
        assertEq(v.exitFeeMaxBps(), 50, "exit fee");
        assertEq(v.exitFeeDecayPeriod(), 30 days, "decay period");
        assertTrue(v.isAllowedAdapter(address(0xADA9)), "adapter allowlist");
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _basket() internal view returns (address[] memory b) {
        b = new address[](1);
        b[0] = address(weth);
    }

    function _adapters() internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = address(0xADA9);
    }

    function _params() internal view returns (VaultFactory.VaultParams memory p) {
        p = VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: _basket(),
            oracle: IOracleAggregator(address(oracle)),
            capacityCapUsdc: 1_000_000 * USDC_1,
            minDepositUsdc: 100 * USDC_1,
            exitFeeMaxBps: 50,
            exitFeeDecayPeriod: 30 days,
            allowedAdapters: _adapters()
        });
    }

    /// The same argument tuple VaultFactory encodes, so the bypass vault differs from a
    /// factory vault in exactly one respect: nobody attested it.
    function _ctorArgs(address creator) internal view returns (bytes memory) {
        return abi.encode(
            address(usdc),
            _basket(),
            creator,
            address(registry),
            address(gov),
            address(fees),
            address(oracle),
            1_000_000 * USDC_1,
            100 * USDC_1,
            uint256(50),
            uint256(30 days),
            _adapters(),
            address(subReg)
        );
    }
}
