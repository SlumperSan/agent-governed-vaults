// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OperatorRegistry} from "../src/OperatorRegistry.sol";
import {FeeEngine, IRegistryView} from "../src/FeeEngine.sol";

/// Drives randomized realization sequences through the registry as if from an attested vault,
/// tracking a ghost of the expected (member, operator) loss carryforward. Hardens the novel
/// cross-vault high-water-mark mechanism (no prior art — research flagged it for extra weight).
contract CarryHandler is Test {
    OperatorRegistry public registry;
    FeeEngine public fees;
    address public vaultAddr; // the attested caller
    uint256 public opId;

    address[] public members;
    mapping(address => uint256) public ghostCarry; // expected carryOf[member][opId]
    uint256 public ghostTotalGain;
    uint256 public ghostTotalLoss;

    constructor(OperatorRegistry registry_, FeeEngine fees_, address vaultAddr_, uint256 opId_) {
        registry = registry_;
        fees = fees_;
        vaultAddr = vaultAddr_;
        opId = opId_;
        for (uint256 i; i < 4; ++i) {
            members.push(makeAddr(string(abi.encodePacked("m", i))));
        }
    }

    function _member(uint256 seed) internal view returns (address) {
        return members[seed % members.length];
    }

    function realizeGain(uint256 seed, uint256 amount) external {
        address m = _member(seed);
        amount = bound(amount, 0, 1_000_000e6);
        vm.prank(vaultAddr);
        registry.recordRealization(m, amount, 0);
        // Ghost: gain consumes carry down to zero.
        ghostCarry[m] = amount >= ghostCarry[m] ? 0 : ghostCarry[m] - amount;
        ghostTotalGain += amount;
    }

    function realizeLoss(uint256 seed, uint256 amount) external {
        address m = _member(seed);
        amount = bound(amount, 0, 1_000_000e6);
        vm.prank(vaultAddr);
        registry.recordRealization(m, 0, amount);
        ghostCarry[m] += amount;
        ghostTotalLoss += amount;
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }
}

contract FeeCarryInvariantTest is Test {
    OperatorRegistry registry;
    FeeEngine fees;
    CarryHandler handler;
    address vaultAddr = makeAddr("attestedVault");
    address operator = makeAddr("operator");
    uint256 opId;

    function setUp() public {
        registry = new OperatorRegistry();
        fees = new FeeEngine(IRegistryView(address(registry)));
        // Wire a "factory" we control so we can attest a synthetic vault address.
        registry.wire(address(this), address(fees));
        registry.attestVault(vaultAddr, operator);
        opId = registry.operatorOf(vaultAddr);

        handler = new CarryHandler(registry, fees, vaultAddr, opId);
        targetContract(address(handler));
    }

    /// The registry's carry always matches the ghost computed from the realization history:
    /// losses accumulate, gains consume down to zero, never negative (it's a uint, but the
    /// ghost proves no over-subtraction either).
    function invariant_carryMatchesGhost() public view {
        for (uint256 i; i < handler.memberCount(); ++i) {
            address m = handler.members(i);
            assertEq(registry.carryOf(m, opId), handler.ghostCarry(m), "carry drift");
        }
    }

    /// Lifetime accumulators are monotone and exactly equal the summed history (SF-5: nothing is
    /// ever restated or removed).
    function invariant_lifetimeMonotone() public view {
        (uint256 g, uint256 l,,) = registry.statsOf(opId);
        assertEq(g, handler.ghostTotalGain(), "lifetime gain drift");
        assertEq(l, handler.ghostTotalLoss(), "lifetime loss drift");
    }

    /// The fee the engine assesses is ALWAYS ≤ 10% of the gain net of the current carry, and 0
    /// when fully under water — for any carry state the fuzzer reached.
    function invariant_feeNeverExceedsNetGainTenth() public {
        for (uint256 i; i < handler.memberCount(); ++i) {
            address m = handler.members(i);
            uint256 carry = registry.carryOf(m, opId);
            uint256 gain = 500_000e6; // probe gain
            vm.prank(vaultAddr);
            uint256 fee = fees.onRealize(m, gain, 0);
            uint256 net = gain > carry ? gain - carry : 0;
            assertLe(fee, net / 10, "fee exceeds 10% of net gain");
            if (net == 0) assertEq(fee, 0, "fee charged while under water");
        }
    }
}
