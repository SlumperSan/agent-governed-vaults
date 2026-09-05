// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SafeTransferLib} from "../../src/lib/SafeTransferLib.sol";

/// @notice AUDIT ARTIFACT — not a protocol test. **M-11 IS REMEDIATED.**
///
/// The three reverting helpers (`safeTransfer`, `safeTransferFrom`, `safeApprove`) used
/// `(bool ok, bytes memory ret) = token.call(...)`, which copies the ENTIRE returndata buffer
/// into memory. A returndata-bombing token therefore OOG'd every one of them — the exact
/// failure the MO-2 hardening exists to close, on the three call shapes it did not cover.
/// `tryTransfer` was genuinely bounded, so the hardening covered one shape of four.
///
/// A second defect went with it: for a 1–31 byte return, `abi.decode(ret, (bool))` reverts with
/// a decoder panic, so the intended `TransferFailed` error was **unreachable** for exactly the
/// malformed-return case it exists to report.
contract BombToken {
    uint256 public immutable words;

    constructor(uint256 words_) {
        words = words_;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return new bytes(words * 32);
    }
}

/// @notice Returns a huge buffer whose first word is `true`. The callee SUCCEEDS, which is
/// what makes this the discriminating case: the old helper had to copy the entire buffer into
/// the caller frame to read one bool out of its first 32 bytes.
contract BombTrueToken {
    uint256 public immutable words;

    constructor(uint256 words_) {
        words = words_;
    }

    fallback(bytes calldata) external returns (bytes memory r) {
        r = new bytes(words * 32);
        assembly {
            mstore(add(r, 0x20), 1)
        }
    }
}

contract ShortReturnToken {
    fallback(bytes calldata) external returns (bytes memory) {
        return hex"01"; // 1 byte: malformed
    }
}

contract NoReturnToken {
    // USDT-style: succeeds, returns nothing.
    fallback() external {}
}

contract FalseToken {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(false);
    }
}

contract GoodToken {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(true);
    }
}

/// @dev A thin harness so the library's `internal` helpers are reachable externally, and so gas
/// can be measured around a single call.
contract Harness {
    using SafeTransferLib for address;

    function doTransfer(address token, address to, uint256 amount) external {
        token.safeTransfer(to, amount);
    }

    function doApprove(address token, address spender, uint256 amount) external {
        token.safeApprove(spender, amount);
    }

    function doTransferFrom(address token, address from, address to, uint256 amount) external {
        token.safeTransferFrom(from, to, amount);
    }
}

contract AuditSafeTransferBoundedTest is Test {
    Harness h;
    address alice = makeAddr("alice");

    function setUp() public {
        h = new Harness();
    }

    /// @notice M-11 FIXED, stated precisely. The fix does NOT stop a callee burning its own
    /// gas — nothing can, at full gas, and that is what `tryTransfer`'s explicit `gasLimit` is
    /// for. What it stops is the CALLER additionally paying to copy the buffer.
    ///
    /// A 50,000-word (1.6 MB) return costs the callee ~5.0M gas in memory expansion
    /// (3n + n^2/512). The old helper then expanded the CALLER's memory by the same 1.6 MB to
    /// decode one bool out of the first 32 bytes — roughly doubling it, to ~10.1M. Measured at
    /// ~5.19M with the bounded copy, so an 8M budget succeeds now and could not have before.
    function test_remediated_callerDoesNotPayToCopyTheBomb() public {
        address bomb = address(new BombTrueToken(50_000));

        uint256 g = gasleft();
        h.doTransfer{gas: 8_000_000}(bomb, alice, 1); // succeeds: first word is `true`
        uint256 used = g - gasleft();

        assertLt(used, 8_000_000, "completed inside a budget that a double copy would exceed");
        emit log_named_uint("gas used against a 1.6 MB return", used);
    }

    /// @notice And a bomb that does NOT return a well-formed `true` still reports the intended
    /// named error rather than an anonymous decoder panic.
    function test_remediated_bombThatIsNotTrueStillReportsTheNamedError() public {
        address bomb = address(new BombToken(10_000));
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TransferFailed.selector, bomb));
        h.doTransfer(bomb, alice, 1);
    }

    /// @notice The same bound on the other two shapes — the point of M-11 was that the hardening
    /// covered one of four.
    function test_remediated_bothOtherShapesAreBoundedToo() public {
        address bomb = address(new BombToken(10_000));

        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.ApproveFailed.selector, bomb));
        h.doApprove(bomb, alice, 1);

        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TransferFromFailed.selector, bomb));
        h.doTransferFrom(bomb, alice, alice, 1);
    }

    /// @notice M-11's second half: the intended error is now REACHABLE for a malformed return.
    /// It previously died in `abi.decode` with a decoder panic, so the one case `TransferFailed`
    /// was written to describe was the one case it could never report.
    function test_remediated_shortReturnRaisesTheIntendedErrorNotADecoderPanic() public {
        address short = address(new ShortReturnToken());
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TransferFailed.selector, short));
        h.doTransfer(short, alice, 1);
    }

    /// @notice The behaviours that must NOT change: USDT-style no-return is success, an explicit
    /// `false` is failure, and a well-formed `true` succeeds. A "fix" that broke USDT compatibility
    /// would be a worse bug than the one being fixed.
    function test_remediated_normalTokenSemanticsAreUnchanged() public {
        h.doTransfer(address(new NoReturnToken()), alice, 1); // no revert
        h.doTransfer(address(new GoodToken()), alice, 1); // no revert

        address f = address(new FalseToken());
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TransferFailed.selector, f));
        h.doTransfer(f, alice, 1);
    }

    /// @notice A non-contract address returns no code and no data. `call` to it SUCCEEDS with
    /// zero returndata, which these helpers read as "USDT-style success" — unchanged by this fix
    /// and worth pinning, because it means the helpers do not themselves verify tokenhood. The
    /// callers that matter validate it: `VaultCore`'s constructor reads `decimals()` on every
    /// basket asset and the settlement token, which reverts on a codeless address.
    function test_codelessAddressStillReadsAsSuccess_documentedNotFixedHere() public {
        h.doTransfer(address(0xDEAD), alice, 1); // no revert
    }
}
