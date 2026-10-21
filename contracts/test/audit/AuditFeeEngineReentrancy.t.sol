// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeEngine, IRegistryView} from "../../src/FeeEngine.sol";
import {PROTOCOL_INITIALIZER} from "../../src/lib/ProtocolInitializer.sol";
import {MockERC20} from "../mocks/Mocks.sol";

/// @notice AUDIT ARTIFACT — not a protocol test. **M-3 IS REMEDIATED.**
///
/// `FeeEngine.pullEscrowed` is permissionless and measures a balance delta STRADDLING a
/// full-gas external call (`claimEscrowed`). The engine had no mutex, and `VaultCore`'s does not
/// cover this: the nested call targets a DIFFERENT vault — a different instance with its own
/// lock slot — so that vault's guard is simply not on the path.
///
/// The arithmetic of the bug: the inner `pullEscrowed` completes first and correctly credits its
/// own `X`; the outer frame then measures the whole delta `X + X2` and credits that too, so
/// `2X + X2` is credited against `X + X2` delivered. Whoever claims first is paid out of the
/// other operator's balance.
///
/// The precondition is attacker-controlled rather than incidental: escrow is populated only when
/// `tryTransfer` returns false, and a hook token decides that on demand.
contract StubRegistryView is IRegistryView {
    mapping(address => uint256) public opOf;
    mapping(uint256 => address) public addrOf;

    function setOperator(address vault, uint256 opId, address opAddr) external {
        opOf[vault] = opId;
        addrOf[opId] = opAddr;
    }

    function operatorOf(address vault) external view returns (uint256) {
        return opOf[vault];
    }

    function carryOf(address, uint256) external pure returns (uint256) {
        return 0;
    }

    function operatorAddressOf(uint256 opId) external view returns (address) {
        return addrOf[opId];
    }

    function recordFeeCollected(uint256, uint256) external {}
}

/// @notice A vault whose `claimEscrowed` delivers tokens AND re-enters the engine against a
/// second vault — the cross-vault nesting VaultCore's own mutex cannot see.
contract ReentrantVault {
    FeeEngine public engine;
    MockERC20 public token;
    address public inner; // the second vault to nest into
    uint256 public amount;
    bool public armed;
    address public creator; // fee model A1: the engine credits the creator, read from the vault

    constructor(FeeEngine engine_, MockERC20 token_, address creator_) {
        engine = engine_;
        token = token_;
        creator = creator_;
    }

    function arm(address inner_, uint256 amount_) external {
        inner = inner_;
        amount = amount_;
        armed = true;
    }

    function usdc() external pure returns (address) {
        return address(0);
    }

    function claimable(address, address) external pure returns (uint256) {
        return 0;
    }

    function claimEscrowed(address) external {
        // Deliver this vault's own escrowed slice.
        token.transfer(address(engine), amount);
        // …and re-enter against a different vault while the outer frame's `before` snapshot is
        // still open. Without the mutex the outer measurement absorbs the inner delivery too.
        if (armed) {
            armed = false;
            engine.pullEscrowed(inner, address(token));
        }
    }
}

/// @notice A plain vault that just delivers its slice.
contract PlainVault {
    MockERC20 public token;
    address public engine;
    uint256 public amount;
    address public creator; // fee model A1: the engine credits the creator, read from the vault

    constructor(MockERC20 token_, address engine_, uint256 amount_, address creator_) {
        token = token_;
        engine = engine_;
        amount = amount_;
        creator = creator_;
    }

    function usdc() external pure returns (address) {
        return address(0);
    }

    function claimable(address, address) external pure returns (uint256) {
        return 0;
    }

    function claimEscrowed(address) external {
        token.transfer(engine, amount);
    }
}

contract AuditFeeEngineReentrancyTest is Test {
    FeeEngine engine;
    StubRegistryView registry;
    MockERC20 token;

    address opA = makeAddr("operatorA");
    address opB = makeAddr("operatorB");

    function setUp() public {
        registry = new StubRegistryView();
        engine = new FeeEngine(IRegistryView(address(registry)));
        vm.prank(PROTOCOL_INITIALIZER);
        engine.initialize(address(0x7EA5));
        token = new MockERC20("HOOK", 18);
    }

    /// @notice M-3 FIXED: the cross-vault nesting is refused outright. Before the mutex the
    /// outer frame credited `2X + X2` against `X + X2` delivered.
    function test_remediated_crossVaultNestingIsRefused() public {
        ReentrantVault outer = new ReentrantVault(engine, token, opA);
        PlainVault innerVault = new PlainVault(token, address(engine), 40e18, opB);

        registry.setOperator(address(outer), 1, opA);
        registry.setOperator(address(innerVault), 2, opB);

        token.mint(address(outer), 100e18);
        token.mint(address(innerVault), 100e18);

        outer.arm(address(innerVault), 60e18);

        vm.expectRevert(FeeEngine.Reentrancy.selector);
        engine.pullEscrowed(address(outer), address(token));
    }

    /// @notice The complement, so the fix is not merely "pullEscrowed is broken": two SEQUENTIAL
    /// pulls credit exactly what each vault delivered, and the engine's balance equals the sum of
    /// its credits — the invariant M-3 violated.
    function test_remediated_sequentialPullsCreditExactlyWhatArrived() public {
        PlainVault a = new PlainVault(token, address(engine), 60e18, opA);
        PlainVault b = new PlainVault(token, address(engine), 40e18, opB);

        registry.setOperator(address(a), 1, opA);
        registry.setOperator(address(b), 2, opB);
        token.mint(address(a), 100e18);
        token.mint(address(b), 100e18);

        engine.pullEscrowed(address(a), address(token));
        engine.pullEscrowed(address(b), address(token));

        // Fee model A1: each delivery splits 90% to its vault's creator and 10% to the treasury.
        address treasury = engine.treasury();
        assertEq(engine.claimableFees(opA, address(token)), 54e18, "A's creator credited 90% of its own 60");
        assertEq(engine.claimableFees(opB, address(token)), 36e18, "B's creator credited 90% of its own 40");
        assertEq(
            engine.claimableFees(treasury, address(token)),
            10e18,
            "treasury credited 10% of the 100 delivered"
        );
        assertEq(
            token.balanceOf(address(engine)),
            engine.claimableFees(opA, address(token)) + engine.claimableFees(opB, address(token))
                + engine.claimableFees(treasury, address(token)),
            "engine balance == sum of credits: the invariant M-3 broke"
        );
    }
}
