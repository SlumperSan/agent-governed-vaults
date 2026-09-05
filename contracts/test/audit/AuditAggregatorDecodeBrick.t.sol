// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleAggregator, IPriceSource} from "../retired/OracleAggregator.sol";
import {IOracleAggregator} from "../../src/interfaces/IOracleAggregator.sol";

/// @notice AUDIT ARTIFACT — not a protocol test. **C-3 AND M-1 ARE REMEDIATED.**
///
/// This file originally carried four `test_finding_*` cases proving that a single source
/// returning a short or absent buffer reverted `priceWad` unconditionally — regardless of
/// quorum, with EMPTY returndata rather than `StaleOracle` — permanently bricking every vault
/// wired to the aggregator. The cause was that `try/catch` cannot absorb a return-DATA DECODE
/// failure: Solidity decodes the buffer in the CALLER's frame, after the callee has already
/// returned successfully. A genuine `revert` was absorbed correctly, which is precisely why the
/// gap survived review — the `catch` worked for the case it was written for and failed for the
/// adjacent one.
///
/// The exploits are preserved in git history and described in full in
/// docs/audit/AI-AUDIT-REPORT.md C-3. They are replaced here by `test_remediated_*` cases
/// asserting the fixed behaviour, because a permanently-red suite is noise, not evidence.
///
/// Note the configuration change forced by **H-1**: quorum must now be >= 3, so the old 2-of-3
/// fixture is no longer constructible. These tests use **5 sources, quorum 3** — the
/// configuration the report names as the honest resolution, where fault tolerance and median
/// integrity can coexist.
contract GoodSource is IPriceSource {
    uint256 p;

    constructor(uint256 p_) {
        p = p_;
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (p, block.timestamp);
    }
}

/// @notice Genuinely reverts — the case the old `catch` DID absorb.
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

/// @notice Returns nothing at all.
contract EmptyReturnSource {
    fallback(bytes calldata) external returns (bytes memory) {
        return "";
    }
}

/// @notice Returns a huge buffer — the returndata-bomb shape. The fix must copy a bounded two
/// words, or absorbing the decode failure would merely relocate the brick into the reader's gas.
contract BombSource {
    fallback(bytes calldata) external returns (bytes memory) {
        return new bytes(400_000);
    }
}

contract AuditAggregatorDecodeBrickTest is Test {
    address asset = makeAddr("WETH");

    /// @dev 5 sources / quorum 3: four well-formed, the fifth supplied by the caller.
    function _deploy(address fifth) internal returns (OracleAggregator) {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](5);
        sources[0][0] = address(new GoodSource(2500e18));
        sources[0][1] = address(new GoodSource(2510e18));
        sources[0][2] = address(new GoodSource(2505e18));
        sources[0][3] = address(new GoodSource(2508e18));
        sources[0][4] = fifth;
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = 3600;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 3;
        return new OracleAggregator(assets, sources, staleness, quorum);
    }

    /// @notice CONTROL, unchanged in meaning: a genuinely reverting source degrades to
    /// not-fresh and quorum still holds. This always worked; it must keep working.
    function test_control_revertingSourceIsAbsorbed() public {
        OracleAggregator agg = _deploy(address(new RevertingSource()));
        assertEq(agg.priceWad(asset), 2505e18, "reverting source degrades to not-fresh");
    }

    /// @notice C-3 FIXED: 32 bytes where 64 were expected is now absorbed exactly like a revert.
    function test_remediated_shortReturndataIsAbsorbedLikeARevert() public {
        OracleAggregator agg = _deploy(address(new ShortReturnSource()));
        assertEq(agg.priceWad(asset), 2505e18, "malformed source is merely not-fresh");
    }

    /// @notice C-3 FIXED: an empty buffer likewise.
    function test_remediated_emptyReturndataIsAbsorbedLikeARevert() public {
        OracleAggregator agg = _deploy(address(new EmptyReturnSource()));
        assertEq(agg.priceWad(asset), 2505e18, "empty return is merely not-fresh");
    }

    /// @notice C-3 FIXED, and BOUNDED: a returndata bomb cannot starve the reader. Absorbing the
    /// decode failure into an unbounded `bytes memory` would have moved the brick, not removed
    /// it — the copy is capped at the two words actually needed.
    function test_remediated_returndataBombCannotStarveTheReader() public {
        OracleAggregator agg = _deploy(address(new BombSource()));
        uint256 g = gasleft();
        assertEq(agg.priceWad(asset), 2505e18, "bomb source is merely not-fresh");
        assertLt(g - gasleft(), 1_000_000, "returndata copy is bounded, not proportional to the bomb");
    }

    /// @notice C-3(a) FIXED at the constructor: a codeless source address — one deploy typo — is
    /// rejected where it is still fixable, instead of bricking the asset permanently at the
    /// first read. UniswapV3TwapSource and PythSource always checked theirs; this closes the
    /// inconsistency the report flagged as evidence of oversight rather than decision.
    function test_remediated_codelessSourceAddressIsRejectedAtConstruction() public {
        // Built inline rather than via _deploy: vm.expectRevert binds the NEXT create, and
        // _deploy's own `new GoodSource(...)` calls would consume it.
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](3);
        sources[0][0] = address(new GoodSource(2500e18));
        sources[0][1] = address(new GoodSource(2510e18));
        sources[0][2] = address(0xDEAD); // no code — a deploy typo
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = 3600;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 3;
        vm.expectRevert(OracleAggregator.BadOracleConfig.selector);
        new OracleAggregator(assets, sources, staleness, quorum);
    }

    /// @notice The breaker is now reachable and CLEAN. With three of five sources malformed,
    /// k == 2 < quorum, so the read reverts `StaleOracle(asset)` — a named, intended failure —
    /// rather than propagating empty returndata out of a decode.
    function test_remediated_quorumLossIsStaleOracleNotAnEmptyRevert() public {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](5);
        sources[0][0] = address(new GoodSource(2500e18));
        sources[0][1] = address(new GoodSource(2510e18));
        sources[0][2] = address(new ShortReturnSource());
        sources[0][3] = address(new EmptyReturnSource());
        sources[0][4] = address(new RevertingSource());
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = 3600;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 3;
        OracleAggregator agg = new OracleAggregator(assets, sources, staleness, quorum);

        vm.expectRevert(abi.encodeWithSelector(IOracleAggregator.StaleOracle.selector, asset));
        agg.priceWad(asset);
    }

    /// @notice M-1 FIXED: `[S,S,S]` satisfied "3 sources" and any quorum, and its median was just
    /// S — one source both setting the price and able to trip the breaker.
    function test_remediated_duplicateSourceAddressesAreRejected() public {
        address dup = address(new GoodSource(2500e18));
        address[] memory assets = new address[](1);
        assets[0] = asset;
        address[][] memory sources = new address[][](1);
        sources[0] = new address[](3);
        sources[0][0] = dup;
        sources[0][1] = dup;
        sources[0][2] = dup;
        uint32[] memory staleness = new uint32[](1);
        staleness[0] = 3600;
        uint8[] memory quorum = new uint8[](1);
        quorum[0] = 3;
        vm.expectRevert(OracleAggregator.BadOracleConfig.selector);
        new OracleAggregator(assets, sources, staleness, quorum);
    }
}
