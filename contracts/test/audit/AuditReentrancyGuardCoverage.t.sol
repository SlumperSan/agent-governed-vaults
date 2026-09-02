// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

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
import {IExecutionAdapter} from "../../src/interfaces/IExecutionAdapter.sol";
import {MockERC20, MockOracle} from "../mocks/Mocks.sol";

/// The register of `VaultCore`'s state-mutating external surface, and the guard status of each
/// entry. This is the machine-checked form of the invariant H-9's fix depends on.
library GuardedSurface {
    /// Canonical signatures of every state-mutating external/public function on `VaultCore`.
    /// Each must revert `Reentrancy()` while the vault's own lock is engaged.
    ///
    /// The reason is the same for all twelve and it is structural rather than per-function:
    /// `_fullNavWad`'s `require(!v.locked())` converts "the callee's accounting is understated"
    /// into "the callee is locked". That substitution is only sound if EVERY window in which a
    /// vault's accounting can be understated lies inside that vault's own lock — which is true
    /// exactly because every entry point that can move `idleUsdc`, `assetBalance`, `totalShares`
    /// or `claimable` is `nonReentrant`. The individual notes below record which window each one
    /// opens, i.e. what an unguarded version of it would expose.
    function guarded() internal pure returns (string[] memory s) {
        s = new string[](12);
        // Writes `idleUsdc` / `totalShares` and reads look-through NAV to price the mint.
        s[0] = "deposit(uint256)";
        s[1] = "deposit(uint256,uint256)";
        // Moves escrowed pending capital into shares (`totalShares`, `totalPendingUsdc`).
        s[2] = "activate(address)";
        // Returns escrowed pending capital; transfers out mid-write.
        s[3] = "cancelPending()";
        // Can activate a pending deposit, so it mints inside its own call.
        s[4] = "skipWindow()";
        // Burns shares, debits `idleUsdc`/`assetBalance`, and unwinds children mid-call — the
        // longest understatement window on the member path.
        s[5] = "requestExit(uint256)";
        s[6] = "settleQueuedExit(address)";
        // Debits `idleUsdc` BEFORE `child.deposit()` returns (see the CEI note at the call site).
        s[7] = "allocateToChild(address,uint256)";
        // Credits measured proceeds only after `child.requestExit` returns — H-9's second window.
        s[8] = "redeemFromChild(address,uint256)";
        // Credits a measured delta after an external `claimEscrowed`.
        s[9] = "pullChildEscrow(address,address)";
        // H-9's first window: each leg's input is debited before the swap, the measured output
        // credited after.
        s[10] = "executeRebalance(address,(address,address,uint256,uint256,uint256,bytes)[])";
        // Pays out an EE-6 escrow slice; zeroes `claimable` around an external transfer.
        s[11] = "claimEscrowed(address)";
    }

    /// State-mutating externals that legitimately do NOT need the reentrancy guard.
    ///
    /// **Currently empty, and adding to it is a security decision, not a bookkeeping one.** An
    /// entry is admissible only if the function cannot leave `idleUsdc`, `assetBalance`,
    /// `totalShares`, `totalPendingUsdc` or `claimable` in a state that misprices this vault at
    /// any point where control can leave the contract — which in practice means it makes no
    /// external call at all AND touches none of those fields. If it does neither, ask why it is
    /// on `VaultCore` rather than somewhere else. Every entry must carry a non-empty reason in
    /// `exemptReasons()`, and the test enforces that.
    function exempt() internal pure returns (string[] memory s) {
        s = new string[](0);
    }

    function exemptReasons() internal pure returns (string[] memory s) {
        s = new string[](0);
    }
}

/// ─────────────────────────────────────────────────────────────────────────────
/// H-9 defence in depth: **every state-mutating external on `VaultCore` is `nonReentrant`.**
///
/// H-9's remediation is a single `require(!v.locked(), Reentrancy())` at the top of
/// `_fullNavWad`. That guard is *sufficient* only because of an invariant stated nowhere in the
/// code it protects: a locked vault is a proxy for an understated vault, and the proxy holds
/// only while every window in which the accounting is understated sits inside the vault's own
/// lock. `executeRebalance` and `redeemFromChild` are the two windows the finding names, and
/// both are `nonReentrant` — but so is every other mutating entry point, and nothing said so.
///
/// The failure mode this suite exists to catch: a future external is added to `VaultCore`
/// WITHOUT `nonReentrant`. H-9 reopens at full severity — a parent can read the vault mid-write
/// again — and every existing test still passes, including
/// `AuditLookThroughReadOnlyReentrancy.t.sol`, because they all drive the guard through
/// `executeRebalance`. Nothing in the repo would notice.
///
/// Two legs, and both are needed:
///
/// - **Completeness** reads the compiled ABI and asserts the set of mutating externals is
///   exactly the register in `GuardedSurface`. Adding a function fails this immediately.
/// - **Guardedness** engages a real lock — the vault is genuinely mid-`executeRebalance`, called
///   from inside a hostile adapter, not a `vm.store` of the lock slot — and asserts every
///   registered signature reverts on `Reentrancy()`. Deleting a modifier fails this.
///
/// **What this does NOT prove, stated so the suite is not mistaken for more than it is:**
///
/// 1. It does not prove the lock is HELD across the whole external-call window. A future
///    function that released `_lock` before calling out would pass both legs and reopen H-9.
///    Ordering inside a guarded function remains a review obligation.
/// 2. It does not see a `fallback` or `receive` — neither appears in the ABI's function list.
///    `VaultCore` has neither today; a future one would be invisible here.
/// 3. Completeness is read from `out/VaultCore.sol/VaultCore.json`, which `forge test` rebuilds
///    before running, so it describes the tree under test — but it is an artifact read, not a
///    source parse.
contract AuditReentrancyGuardCoverageTest is Test {
    uint256 constant USDC_1 = 1e6;

    MockERC20 usdc;
    MockERC20 weth;
    MockOracle oracle;
    OperatorRegistry registry;
    SubVaultRegistry subReg;
    FeeEngine fees;
    Governance gov;
    VaultFactory factory;

    address operator = makeAddr("operator");

    VaultCore vault;
    GuardProbeAdapter probe;

    /// The compiled ABI, decoded ONCE in `setUp`. Two reasons it lives here rather than in the
    /// test body, and the second is the load-bearing one:
    ///  - it is shared reference data, not per-test state; and
    ///  - `forge snapshot` records the test body's gas, not `setUp`'s. Keeping the artifact read
    ///    out of the bodies leaves both snapshot rows measuring the code rather than the build,
    ///    which is what the gate's `--nmt "testFuzz|c4EndToEnd|testFork"` filter exists to
    ///    protect and is why that filter did not have to be touched.
    ///
    /// **The read must also cost the same whatever the artifact weighs**, and that is a separate
    /// requirement from where it lives. `out/VaultCore.sol/VaultCore.json` is not one file: a
    /// plain `forge build` writes ~231 KB, and any build carrying `--build-info` / `--ast` --
    /// which is what Slither drives, and Slither is the LAST step of `npm run gate` -- embeds the
    /// `ast` and writes ~1,049 KB. That state is sticky (a later `forge build` reports
    /// "compilation skipped" and leaves it), so anything here whose cost tracks the file's byte
    /// length times the ABI's entry count runs out of gas on the *next* run of the gate rather
    /// than on this one. It did: the original walk made ~330 whole-document parses and `setUp()`
    /// failed `EvmError: OutOfGas` against the 1 MB artifact while passing against the 231 KB one.
    /// Hence exactly three whole-document reads below, a count that does not move with the ABI.
    string[] internal abiNames;
    bool[] internal abiMutating;
    string[] internal abiSignatures;

    /// `.abi[]` filtered to function entries. Both queries carry the SAME predicate, so the two
    /// arrays are index-aligned by construction and in document order -- which is what makes the
    /// name/mutability join sound. Filtering rather than reading `.abi[*].name` and
    /// `.abi[*].stateMutability` is not a stylistic choice: the `constructor` entry has a
    /// `stateMutability` and no `name`, and `error`/`event` entries have a `name` and no
    /// `stateMutability`, so those two arrays are of different lengths (109 and 68 against 110
    /// entries) and joining them by index would silently mis-pair.
    string constant FN_NAMES = "$.abi[?(@.type == 'function')].name";
    string constant FN_MUTABILITIES = "$.abi[?(@.type == 'function')].stateMutability";

    function setUp() public {
        string memory json = vm.readFile("out/VaultCore.sol/VaultCore.json");
        _loadAbi(json);
        abiSignatures = vm.parseJsonKeys(json, ".methodIdentifiers");

        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("wETH", 18);
        oracle = new MockOracle();
        oracle.setPrice(address(weth), 4_000e18);

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
            false, // sub-vaults not needed: the lock is engaged by the vault's own rebalance
            new address[](0)
        );
        registry.wire(address(factory), address(fees));
        subReg.wire(address(factory));
        gov.wireSubVaultRegistry(address(subReg));

        probe = new GuardProbeAdapter(address(usdc), address(weth));
        usdc.mint(operator, 10_000_000 * USDC_1);
        weth.mint(address(probe), 1_000e18);

        address[] memory basket = new address[](1);
        basket[0] = address(weth);
        address[] memory adapters = new address[](1);
        adapters[0] = address(probe);

        vm.startPrank(operator);
        vault = VaultCore(
            factory.createVault(
                VaultFactory.VaultParams({
                    usdc: address(usdc),
                    basketAssets: basket,
                    oracle: IOracleAggregator(address(oracle)),
                    capacityCapUsdc: 1_000_000_000 * USDC_1,
                    minDepositUsdc: 10 * USDC_1,
                    exitFeeMaxBps: 0,
                    exitFeeDecayPeriod: 0,
                    allowedAdapters: adapters
                })
            )
        );
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(2_000 * USDC_1);
        vault.skipWindow();
        vm.stopPrank();
    }

    // ── leg 1: completeness ──────────────────────────────────────────────────

    /// Every state-mutating external in the compiled ABI is accounted for by the register —
    /// nothing is guarded-by-omission. **This is the test that fails when someone adds a
    /// function to `VaultCore`**, which is the whole point: the failure is the prompt to decide,
    /// deliberately, whether the new function is `nonReentrant`.
    function test_everyMutatingExternalIsRegistered() public view {
        string[] memory names = abiNames;
        bool[] memory isMut = abiMutating;
        assertGt(names.length, 0, "VaultCore artifact lists no functions -- the read is doing nothing");

        string[] memory guarded = GuardedSurface.guarded();
        string[] memory exempt = GuardedSurface.exempt();
        string[] memory reasons = GuardedSurface.exemptReasons();
        assertEq(exempt.length, reasons.length, "every exemption must carry a reason");
        for (uint256 i; i < reasons.length; ++i) {
            assertGt(bytes(reasons[i]).length, 0, "an exemption has an empty reason");
        }

        // The register is keyed by NAME below (an ABI entry does not carry its canonical
        // signature), so first prove that name -> mutability is well defined for this ABI: if a
        // name were ever both a view and a mutating overload, the name-based comparison would
        // silently under-report. It is not today, and this fails loudly if that changes -- at
        // which point the comparison must move to full signatures.
        uint256 mutating;
        for (uint256 i; i < names.length; ++i) {
            if (isMut[i]) ++mutating;
            for (uint256 j = i + 1; j < names.length; ++j) {
                if (!_eq(names[i], names[j])) continue;
                assertEq(
                    isMut[i],
                    isMut[j],
                    string.concat(
                        "overloads of '",
                        names[i],
                        "' disagree on mutability -- switch this test to signatures"
                    )
                );
            }
        }

        // Direction 1: every ABI mutating function appears in the register. This runs before the
        // count so the failure NAMES the offending function -- the count alone would report
        // "13 != 12" and leave the reader to find which.
        for (uint256 i; i < names.length; ++i) {
            if (!isMut[i]) continue;
            assertTrue(
                _hasName(guarded, names[i]) || _hasName(exempt, names[i]),
                string.concat(
                    "VaultCore.", names[i], " is a state-mutating external that no reentrancy register covers"
                )
            );
        }

        // And the count, which catches the opposite drift: a register entry for a function that
        // no longer exists, or an overload removed.
        assertEq(
            mutating,
            guarded.length + exempt.length,
            "the count of mutating externals in the ABI does not match the register"
        );

        // Direction 2: every register entry is a real, current, externally callable signature.
        // `methodIdentifiers` is keyed by canonical signature, so this catches an arity or type
        // change that leaves the NAME intact -- and it makes the hand-written `executeRebalance`
        // tuple literal self-checking rather than a hope.
        string[] memory selectors = abiSignatures;
        for (uint256 i; i < guarded.length; ++i) {
            assertTrue(
                _hasExact(selectors, guarded[i]),
                string.concat("registered signature is not in the compiled ABI: ", guarded[i])
            );
        }
        for (uint256 i; i < exempt.length; ++i) {
            assertTrue(
                _hasExact(selectors, exempt[i]),
                string.concat("exempted signature is not in the compiled ABI: ", exempt[i])
            );
        }
    }

    // ── leg 2: guardedness ───────────────────────────────────────────────────

    /// Every registered signature reverts `Reentrancy()` while the vault holds its own lock.
    /// The lock is engaged the way it is in production — the vault is genuinely inside
    /// `executeRebalance`, and the probe runs from the adapter it called out to — so this
    /// asserts the modifier's real effect, not a simulated storage slot.
    function test_everyRegisteredExternalRevertsWhileLocked() public {
        string[] memory guarded = GuardedSurface.guarded();

        assertFalse(vault.locked(), "vault reported locked at rest");
        vm.prank(address(gov));
        vault.executeRebalance(address(probe), _leg());
        assertFalse(vault.locked(), "lock not released after the rebalance");

        assertTrue(probe.sawLocked(), "the vault was not locked during its own swap");
        assertEq(probe.count(), guarded.length, "the probe did not attempt every registered signature");

        for (uint256 i; i < guarded.length; ++i) {
            assertFalse(probe.ok(i), string.concat("succeeded while locked: ", guarded[i]));
            assertEq(
                probe.revertSelector(i),
                VaultCore.Reentrancy.selector,
                string.concat("reverted while locked, but not on the guard: ", guarded[i])
            );
        }
    }

    function _leg() internal view returns (IExecutionAdapter.SwapOrder[] memory orders) {
        orders = new IExecutionAdapter.SwapOrder[](1);
        orders[0] = IExecutionAdapter.SwapOrder({
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: 1_000 * USDC_1,
            minAmountOut: 0.25e18,
            deadline: block.timestamp + 1 hours,
            routeData: ""
        });
    }

    // ── json helpers ─────────────────────────────────────────────────────────

    /// Record the name and mutability of every `type == "function"` entry in `.abi[]`, in
    /// document order, in TWO whole-document reads — a count that does not move with the number
    /// of ABI entries or with the artifact's byte length. See the note on `abiNames` for why
    /// that constancy is the property under test here and not an optimisation.
    ///
    /// `vm.parseJson`'s bytes-returning form is used rather than `vm.parseJsonStringArray`
    /// because the typed array cheatcodes reject any path that selects more than one JSON node
    /// (`must return exactly one JSON value`) — which is every useful path here, filter or not.
    /// `parseJson` encodes a multi-node selection of strings as a `string[]`, so the decode below
    /// is exact rather than lenient. The one shape it would NOT survive is an ABI with exactly
    /// one function, which `parseJson` would return as a bare string; `VaultCore` has 67 and
    /// `assertGt(names.length, 0)` in the completeness leg is the backstop if that ever changes.
    function _loadAbi(string memory json) internal {
        string[] memory names = abi.decode(vm.parseJson(json, FN_NAMES), (string[]));
        string[] memory mutabilities = abi.decode(vm.parseJson(json, FN_MUTABILITIES), (string[]));
        // Both selections share a predicate, so a length mismatch is impossible unless the
        // engine's semantics changed underneath the join. Assert it rather than assume it: a
        // silent mis-pairing here would report a mutating function as a view and hide exactly
        // what this suite exists to catch.
        assertEq(
            names.length,
            mutabilities.length,
            "the ABI's function names and mutabilities did not select in step -- the join is unsound"
        );
        for (uint256 i; i < names.length; ++i) {
            abiNames.push(names[i]);
            abiMutating.push(!_eq(mutabilities[i], "view") && !_eq(mutabilities[i], "pure"));
        }
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _hasName(string[] memory sigs, string memory name) internal pure returns (bool) {
        bytes memory nb = bytes(name);
        for (uint256 i; i < sigs.length; ++i) {
            bytes memory sb = bytes(sigs[i]);
            if (sb.length <= nb.length || sb[nb.length] != "(") continue;
            bool same = true;
            for (uint256 j; j < nb.length; ++j) {
                if (sb[j] != nb[j]) {
                    same = false;
                    break;
                }
            }
            if (same) return true;
        }
        return false;
    }

    function _hasExact(string[] memory hay, string memory needle) internal pure returns (bool) {
        for (uint256 i; i < hay.length; ++i) {
            if (_eq(hay[i], needle)) return true;
        }
        return false;
    }
}

/// An adapter that pays out honestly and, while the calling vault is mid-swap and therefore
/// holding its own reentrancy lock, calls back into EVERY registered mutating external and
/// records how each one failed.
contract GuardProbeAdapter is IExecutionAdapter {
    MockERC20 immutable tokenInERC;
    MockERC20 immutable tokenOutERC;

    bool public sawLocked;
    bool[] internal _ok;
    bytes4[] internal _sel;

    constructor(address usdc_, address weth_) {
        tokenInERC = MockERC20(usdc_);
        tokenOutERC = MockERC20(weth_);
    }

    function count() external view returns (uint256) {
        return _sel.length;
    }

    function ok(uint256 i) external view returns (bool) {
        return _ok[i];
    }

    function revertSelector(uint256 i) external view returns (bytes4) {
        return _sel[i];
    }

    /// Calldata for each registered signature. The selector is derived FROM the signature
    /// string, so the register in `GuardedSurface` is the single source of truth for both legs
    /// of the test: a wrong signature string cannot silently probe some other function, it
    /// probes nothing and fails the completeness leg first.
    ///
    /// Argument values are deliberately meaningless. `nonReentrant`'s `require` is the first
    /// statement executed in every one of these, ahead of `OnlyGovernance`, `ZeroAmount` and
    /// every other precondition, so a guarded function reverts `Reentrancy()` on any
    /// well-formed calldata. The arguments only have to DECODE — which is why they are built as
    /// real ABI encodings rather than empty bytes.
    function _calls() internal pure returns (bytes[] memory c) {
        string[] memory s = GuardedSurface.guarded();
        c = new bytes[](s.length);
        c[0] = abi.encodePacked(_sig(s[0]), abi.encode(uint256(1)));
        c[1] = abi.encodePacked(_sig(s[1]), abi.encode(uint256(1), uint256(0)));
        c[2] = abi.encodePacked(_sig(s[2]), abi.encode(address(0)));
        c[3] = abi.encodePacked(_sig(s[3]));
        c[4] = abi.encodePacked(_sig(s[4]));
        c[5] = abi.encodePacked(_sig(s[5]), abi.encode(uint256(1)));
        c[6] = abi.encodePacked(_sig(s[6]), abi.encode(address(0)));
        c[7] = abi.encodePacked(_sig(s[7]), abi.encode(address(0), uint256(1)));
        c[8] = abi.encodePacked(_sig(s[8]), abi.encode(address(0), uint256(1)));
        c[9] = abi.encodePacked(_sig(s[9]), abi.encode(address(0), address(0)));
        c[10] = abi.encodePacked(_sig(s[10]), abi.encode(address(0), new SwapOrder[](0)));
        c[11] = abi.encodePacked(_sig(s[11]), abi.encode(address(0)));
    }

    function _sig(string memory signature) internal pure returns (bytes4) {
        return bytes4(keccak256(bytes(signature)));
    }

    function executeSwap(SwapOrder calldata o) external returns (uint256 amountOut) {
        tokenInERC.transferFrom(msg.sender, address(this), o.amountIn);

        sawLocked = VaultCore(msg.sender).locked();
        bytes[] memory c = _calls();
        for (uint256 i; i < c.length; ++i) {
            (bool success, bytes memory err) = msg.sender.call(c[i]);
            _ok.push(success);
            _sel.push(err.length >= 4 ? bytes4(err) : bytes4(0));
        }

        amountOut = o.minAmountOut;
        tokenOutERC.transfer(msg.sender, amountOut);
    }
}
