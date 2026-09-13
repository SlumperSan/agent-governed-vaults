// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ORACLE ROTATION — characterization of the deliberate NON-path (residual-risk row 12).
//
// The C-6 remediation blesses a fixed set of oracle instances in `VaultFactory`'s constructor
// (`allowedOracles_` -> `isAllowedOracle`). That allowlist is IMMUTABLE: there is no add, no
// remove, and no owner anywhere in `src/` to hold such a power. The question this suite answers
// is what that immutability actually costs, because the intuitive answer ("vaults are stuck on a
// deprecated feed and a rotation lever would rescue them") is WRONG in a way that changes the
// whole design decision:
//
//   1. A vault's oracle is `immutable` in VaultCore, pinned at construction. Nothing — not the
//      factory, not Governance (which has zero oracle references and three proposal types, none
//      of them oracle-shaped), not the creator — can repoint a deployed vault.
//   2. The factory allowlist is read ONLY by `_requireAllowedOracle`, called ONLY from
//      `createVault`/`createChildVault`. It therefore governs NEW VAULT CREATION and nothing else.
//
// Together: an allowlist rotation lever could not rescue one stuck dollar. It could only change
// which oracles FUTURE creators may select — which a plain factory redeploy already achieves,
// without introducing the protocol's first standing privileged role. The one real cost of the
// redeploy route is priced in test 3: `OperatorRegistry.wire` is one-shot, so a replacement
// factory cannot attest into the canonical registry, and operator identity / HWM carry
// continuity (§7, CM-5) restarts.
//
// These tests exist so that the residual row is backed by executed evidence rather than prose,
// and so that anyone later ADDING a rotation surface has to delete an assertion on purpose.

import {Test} from "forge-std/Test.sol";
import {VaultCore} from "../../src/VaultCore.sol";
import {VaultFactory, IVaultDeployer} from "../../src/VaultFactory.sol";
import {VaultDeployer} from "../../src/VaultDeployer.sol";
import {SubVaultRegistry} from "../../src/SubVaultRegistry.sol";
import {OperatorRegistry} from "../../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../../src/FeeEngine.sol";
import {Governance} from "../../src/Governance.sol";
import {IOperatorRegistry} from "../../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";
import {MockERC20, MockOracle} from "../mocks/Mocks.sol";

contract AuditOracleRotationTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle blessed; // the originally-blessed oracle (stands in for the launch ChainlinkOracle)
    MockOracle replacement; // a healthy successor (stands in for a re-pointed ChainlinkOracle)

    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultDeployer deployerLib;

    address creator = makeAddr("creator");
    address anyone = makeAddr("anyone");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        blessed = new MockOracle();
        replacement = new MockOracle();
        blessed.setPrice(address(weth), 2500e18);
        replacement.setPrice(address(weth), 2500e18);

        registry = new OperatorRegistry();
        subReg = new SubVaultRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        gov = new Governance();
        deployerLib = new VaultDeployer();
    }

    /// @dev Build a factory over the SHARED singletons. `wireCanonical` performs the one-shot
    /// wiring that makes it the canonical (attesting) factory — only the first one can.
    function _factory(address[] memory allowedOracles, bool wireCanonical) internal returns (VaultFactory f) {
        f = new VaultFactory(
            IOperatorRegistry(address(registry)),
            IGovernance(address(gov)),
            IFeeEngine(address(fees)),
            address(subReg),
            IVaultDeployer(address(deployerLib)),
            false, // C-1: root vaults only
            allowedOracles
        );
        if (wireCanonical) {
            registry.wire(address(f), address(fees));
            subReg.wire(address(f));
            gov.wireSubVaultRegistry(address(subReg));
        }
    }

    function _one(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    function _params(address oracle) internal view returns (VaultFactory.VaultParams memory) {
        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        return VaultFactory.VaultParams({
            usdc: address(usdc),
            basketAssets: basket,
            oracle: IOracleAggregator(oracle),
            capacityCapUsdc: 0,
            minDepositUsdc: 10 * USDC_1,
            exitFeeMaxBps: 50,
            exitFeeDecayPeriod: 30 days,
            allowedAdapters: new address[](0)
        });
    }

    // ── 1. A deployed vault's oracle is pinned; no ABI surface can rotate it ───
    //
    // THE ACTUAL PROOF IS THE COMPILER, and this comment says so rather than overclaiming what a
    // test can show: `VaultCore.sol:76` declares `IOracleAggregator public immutable oracle`, so
    // no assignment outside the constructor can exist and the value lives in bytecode rather than
    // in a settable slot. The two checks below are CORROBORATION, and neither is exhaustive:
    //   - a selector battery over the conventional setter/mutator names (a differently-named
    //     entrypoint — `blessNewOracle(address)` — would sail through, so this catches a careless
    //     addition, not an adversarial one);
    //   - a scan of the first 64 storage slots showing no slot holds the oracle address, i.e.
    //     there is no mutable copy to set (imperfect under packing, still stronger than names).
    // Their value is as a tripwire: a future change that adds a rotation surface has to touch
    // this file on purpose.
    function test_deployedVaultOracleIsPinned_noRotationSurfaceExists() public {
        VaultFactory factory = _factory(_one(address(blessed)), true);
        vm.prank(creator);
        address vault = factory.createVault(_params(address(blessed)));
        assertEq(address(VaultCore(vault).oracle()), address(blessed), "wired to the blessed oracle");

        string[6] memory vaultSetters = [
            "setOracle(address)",
            "updateOracle(address)",
            "migrateOracle(address)",
            "rotateOracle(address)",
            "changeOracle(address)",
            "setOracle(address,address)"
        ];
        string[6] memory factoryMutators = [
            "addOracle(address)",
            "removeOracle(address)",
            "blessOracle(address)",
            "setAllowedOracle(address,bool)",
            "setOracleAllowed(address,bool)",
            "allowOracle(address)"
        ];

        // Try each from the creator, from the factory itself, and from an unrelated address —
        // every caller identity a rotation lever could plausibly be gated on.
        address[3] memory callers = [creator, address(factory), anyone];
        for (uint256 c; c < callers.length; ++c) {
            for (uint256 i; i < vaultSetters.length; ++i) {
                vm.prank(callers[c]);
                (bool ok,) =
                    vault.call(abi.encodeWithSignature(vaultSetters[i], address(replacement), address(0)));
                assertFalse(ok, "vault exposes an oracle mutator");
            }
            for (uint256 i; i < factoryMutators.length; ++i) {
                vm.prank(callers[c]);
                (bool ok,) = address(factory)
                    .call(abi.encodeWithSignature(factoryMutators[i], address(replacement), true));
                assertFalse(ok, "factory exposes an allowlist mutator");
            }
        }

        // No storage slot holds the oracle address — it is in bytecode (`immutable`), so there is
        // nothing for a setter to write even if one were added without changing the type.
        bytes32 needle = bytes32(uint256(uint160(address(blessed))));
        for (uint256 s; s < 64; ++s) {
            assertTrue(vm.load(vault, bytes32(s)) != needle, "oracle found in a mutable storage slot");
        }

        // Unchanged, and still the exact instance the vault prices through.
        assertEq(address(VaultCore(vault).oracle()), address(blessed), "oracle still pinned");
        assertFalse(factory.isAllowedOracle(address(replacement)), "replacement was never blessed");
    }

    // ── 2. Blessing a replacement helps FUTURE vaults only ────────────────────
    //
    // The load-bearing fact for the residual row. A second factory blessing a successor oracle
    // (the shape a rotation lever would produce) accepts new vaults against it — and has no
    // effect whatsoever on the vault that already exists. The old vault keeps pricing through
    // its own pinned oracle, and would freeze with it (K-4 / SF-2) no matter what any allowlist
    // anywhere says.
    function test_blessingAReplacementDoesNotMigrateAnExistingVault() public {
        VaultFactory factoryA = _factory(_one(address(blessed)), true);
        vm.prank(creator);
        address oldVault = factoryA.createVault(_params(address(blessed)));

        // The successor factory blesses ONLY the replacement — `blessed` is de-blessed here, the
        // strongest form of "removal", and it still touches nothing that exists.
        VaultFactory factoryB = _factory(_one(address(replacement)), false);
        assertTrue(factoryB.isAllowedOracle(address(replacement)), "replacement blessed in B");
        assertFalse(factoryB.isAllowedOracle(address(blessed)), "old oracle de-blessed in B");

        // The already-deployed vault is entirely unaffected by B's allowlist, in either direction.
        assertEq(address(VaultCore(oldVault).oracle()), address(blessed), "old vault still on the old oracle");
        assertEq(VaultCore(oldVault).oracle().priceWad(address(weth)), 2500e18, "and still prices through it");

        // Now deprecate the old oracle. The replacement is healthy the whole time; it does the
        // stuck vault no good at all, because there is no path from one to the other.
        blessed.setStale(true);
        // Read the pinned oracle BEFORE arming expectRevert — `oracle()` is itself an external
        // call and would otherwise consume the expectation.
        IOracleAggregator pinned = VaultCore(oldVault).oracle();
        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, address(weth)));
        pinned.priceWad(address(weth));
        assertEq(replacement.priceWad(address(weth)), 2500e18, "the successor is live and healthy");
        assertEq(address(VaultCore(oldVault).oracle()), address(blessed), "no migration path exists");
    }

    // ── 3. The price of rotating by redeploy: registry continuity ─────────────
    //
    // Rotation without a lever = deploy a new factory with a new blessed set. This is the cost,
    // and it is the reason the option is not free: `OperatorRegistry.wire` is one-shot and
    // deployer-gated, so the replacement factory cannot attest into the canonical registry.
    // Operator identity, the cross-vault leaderboard (SF-4/SF-5) and the HWM loss carryforward
    // (§7, CM-5) all restart under a fresh registry. Existing vaults keep working on the old one.
    function test_aReplacementFactoryCannotReuseTheCanonicalRegistry() public {
        VaultFactory factoryA = _factory(_one(address(blessed)), true);
        vm.prank(creator);
        factoryA.createVault(_params(address(blessed)));

        VaultFactory factoryB = _factory(_one(address(replacement)), false);

        // Re-wiring the canonical registry to the successor factory is impossible.
        vm.expectRevert(OperatorRegistry.AlreadyWired.selector);
        registry.wire(address(factoryB), address(fees));

        // And unwired, the successor factory cannot attest — so it cannot create a vault at all
        // against the canonical registry. Rotation therefore forks the registry, by construction.
        vm.prank(creator);
        vm.expectRevert(OperatorRegistry.OnlyFactory.selector);
        factoryB.createVault(_params(address(replacement)));

        // With its OWN registry the successor works fine — a new, disjoint reputation universe.
        OperatorRegistry registryB = new OperatorRegistry();
        SubVaultRegistry subRegB = new SubVaultRegistry();
        FeeEngine feesB = new FeeEngine(IRegistryView(address(registryB)));
        VaultFactory factoryC = new VaultFactory(
            IOperatorRegistry(address(registryB)),
            IGovernance(address(new Governance())),
            IFeeEngine(address(feesB)),
            address(subRegB),
            IVaultDeployer(address(deployerLib)),
            false,
            _one(address(replacement))
        );
        registryB.wire(address(factoryC), address(feesB));
        subRegB.wire(address(factoryC));

        vm.prank(creator);
        address newVault = factoryC.createVault(_params(address(replacement)));
        assertEq(
            address(VaultCore(newVault).oracle()), address(replacement), "new vault on the successor oracle"
        );
        assertEq(registry.operatorOf(newVault), 0, "unknown to the old registry");
        assertGt(registryB.operatorOf(newVault), 0, "attested only in the new one");
    }
}
