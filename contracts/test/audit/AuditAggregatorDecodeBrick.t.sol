// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleAggregator, IPriceSource} from "../../src/OracleAggregator.sol";

/// @notice AUDIT ARTIFACT — not a protocol test.
///
/// Verifies the claim that `OracleAggregator.priceWad`'s `try/catch` (`src/OracleAggregator.sol:88-90`)
/// does NOT contain a return-DATA DECODE failure. Solidity decodes the returned buffer in the
/// caller's frame after the callee returns successfully; a `catch` clause cannot absorb that.
///
/// If true, a single source returning a short/absent buffer reverts `priceWad` unconditionally —
/// regardless of quorum — which falsifies the contract's own stated contract at `:86-87`
/// ("A reverting source is simply not fresh — one broken feed must not trip the breaker while
/// quorum still holds elsewhere") and makes every consuming vault permanently unpriceable.
contract GoodSource is IPriceSource {
    uint256 p;

    constructor(uint256 p_) {
        p = p_;
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (p, block.timestamp);
    }
}

/// @notice Genuinely reverts — the case the `catch` IS meant to absorb.
contract RevertingSource {
    function latestPrice() external pure returns (uint256, uint256) {
        revert("boom");
    }
}

/// @notice Returns a well-formed but SHORT buffer (32 bytes where 64 are expected).
contract ShortReturnSource {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(uint256(1));
    }
}

/// @notice Returns nothing at all (the shape a codeless address / EOA also produces).
contract EmptyReturnSource {
    fallback(bytes calldata) external returns (bytes memory) {
        return "";
    }
}

contract AuditAggregatorDecodeBrickTest is Test {
    address asset = makeAddr("WETH");

    function _deploy(address third) internal returns (OracleAggregator) {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](3);
        sources[0][0] = address(new GoodSource(2500e18));
        sources[0][1] = address(new GoodSource(2510e18));
        sources[0][2] = third;
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = 3600;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 2; // the shipped base-mainnet.json value
        return new OracleAggregator(assets, sources, staleness, quorum);
    }

    /// @notice CONTROL: a source that genuinely reverts IS absorbed, quorum still holds.
    /// This is the behaviour the contract documents, and it works.
    function test_control_revertingSourceIsAbsorbed() public {
        OracleAggregator agg = _deploy(address(new RevertingSource()));
        assertEq(agg.priceWad(asset), 2500e18, "reverting source degrades to not-fresh");
    }

    /// @notice THE FINDING: a source returning 32 bytes instead of 64 reverts the WHOLE read,
    /// even though two well-formed sources satisfy the quorum of 2.
    function test_finding_shortReturndataBricksThePriceEntirely() public {
        OracleAggregator agg = _deploy(address(new ShortReturnSource()));
        vm.expectRevert(); // NOT StaleOracle — an uncatchable decode failure
        agg.priceWad(asset);
    }

    /// @notice Same for an empty buffer — the shape a mistyped (codeless) source address gives.
    function test_finding_emptyReturndataBricksThePriceEntirely() public {
        OracleAggregator agg = _deploy(address(new EmptyReturnSource()));
        vm.expectRevert();
        agg.priceWad(asset);
    }

    /// @notice A plain EOA / never-deployed address behaves the same way, so a single deploy-time
    /// typo in a source address makes the asset permanently unpriceable. The constructor accepts
    /// it: there is no `code.length` check on any source (`src/OracleAggregator.sol:60-72`),
    /// even though UniswapV3TwapSource (`:178`,`:204`) and PythSource (`:102`) both check theirs.
    function test_finding_codelessSourceAddressIsAcceptedThenBricks() public {
        address typo = address(0xDEAD); // no code
        OracleAggregator agg = _deploy(typo); // constructor does NOT reject it
        vm.expectRevert();
        agg.priceWad(asset);
    }

    /// @notice The distinguishing detail: the revert is NOT the breaker. `StaleOracle` would be a
    /// clean, intended failure; this is empty returndata propagating out of the decode.
    function test_finding_revertIsNotTheStaleOracleBreaker() public {
        OracleAggregator agg = _deploy(address(new ShortReturnSource()));
        (bool ok, bytes memory ret) =
            address(agg).staticcall(abi.encodeCall(OracleAggregator.priceWad, (asset)));
        assertFalse(ok, "call failed");
        assertEq(ret.length, 0, "empty returndata: a decode failure, not StaleOracle(asset)");
    }
}
