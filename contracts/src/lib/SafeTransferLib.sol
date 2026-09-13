// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal safe ERC-20 transfer helpers tolerating missing return values (USDT-style).
/// Vendored rather than imported to keep the dependency surface auditable (Sprint 1 decision;
/// may be swapped for OpenZeppelin SafeERC20 at the Sprint 6 audit-prep pass).
///
/// @dev **M-11 remediation.** The three reverting helpers below used to do
/// `(bool ok, bytes memory ret) = token.call(...)`, which copies the ENTIRE returndata buffer
/// into memory. A returndata-bombing token therefore OOG'd every one of them — the exact
/// failure the MO-2 hardening was written to close, on the three call shapes it did not cover.
/// `tryTransfer` was genuinely bounded; these were not, so the hardening covered one shape of
/// four. Reachable at `VaultCore` `:611`, `:642`, `:363`, `:816` (`claimEscrowed`, so an asset
/// that degraded to escrow could be made permanently unclaimable), `:673/675`, `:773/779`, and
/// both execution adapters.
///
/// A second, quieter defect went with it: for a token returning 1–31 bytes,
/// `abi.decode(ret, (bool))` reverts with a decoder panic, so the intended `TransferFailed`
/// error was **unreachable** for exactly the malformed-return case it exists to report.
///
/// All three now use a bounded call that copies at most one word — the same shape `tryTransfer`
/// already used — and reverts with the intended named error. The bomb costs the callee its own
/// memory expansion and nothing here, because a buffer that is never copied is never paid for.
library SafeTransferLib {
    error TransferFailed(address token);
    error TransferFromFailed(address token);

    function safeTransfer(address token, address to, uint256 amount) internal {
        // transfer(address,uint256)
        if (!_call2(token, 0xa9059cbb, to, amount)) revert TransferFailed(token);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        // transferFrom(address,address,uint256)
        if (!_call3(token, 0x23b872dd, from, to, amount)) revert TransferFromFailed(token);
    }

    error ApproveFailed(address token);

    function safeApprove(address token, address spender, uint256 amount) internal {
        // approve(address,uint256)
        if (!_call2(token, 0x095ea7b3, spender, amount)) revert ApproveFailed(token);
    }

    /// @dev Two-argument ERC-20 call, returndata-bounded. Full gas, unlike `tryTransfer` — these
    /// helpers are meant to propagate a genuine failure, just not to be OOG'd by a bomb.
    /// @return ok call succeeded AND returned either nothing or a well-formed `true`
    function _call2(address token, uint32 selector, address p1, uint256 p2) private returns (bool ok) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, shl(224, selector))
            mstore(add(ptr, 0x04), p1)
            mstore(add(ptr, 0x24), p2)
            ok := call(gas(), token, 0, ptr, 0x44, 0, 0)
            if ok {
                // Bounded: at most one word is ever copied, so a returndata bomb costs the
                // callee its own memory expansion and costs this frame nothing.
                switch returndatasize()
                case 0 {} // no-return tokens (USDT-style): success
                default {
                    switch lt(returndatasize(), 0x20)
                    case 1 { ok := 0 } // 1-31 bytes: malformed, and now REPORTABLE
                    default {
                        returndatacopy(ptr, 0, 0x20)
                        ok := eq(mload(ptr), 1)
                    }
                }
            }
        }
    }

    /// @dev Three-argument ERC-20 call, returndata-bounded.
    /// @return ok call succeeded AND returned either nothing or a well-formed `true`
    function _call3(address token, uint32 selector, address p1, address p2, uint256 p3)
        private
        returns (bool ok)
    {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, shl(224, selector))
            mstore(add(ptr, 0x04), p1)
            mstore(add(ptr, 0x24), p2)
            mstore(add(ptr, 0x44), p3)
            ok := call(gas(), token, 0, ptr, 0x64, 0, 0)
            if ok {
                // Bounded: at most one word is ever copied, so a returndata bomb costs the
                // callee its own memory expansion and costs this frame nothing.
                switch returndatasize()
                case 0 {} // no-return tokens (USDT-style): success
                default {
                    switch lt(returndatasize(), 0x20)
                    case 1 { ok := 0 } // 1-31 bytes: malformed, and now REPORTABLE
                    default {
                        returndatacopy(ptr, 0, 0x20)
                        ok := eq(mload(ptr), 1)
                    }
                }
            }
        }
    }

    /// @notice Non-reverting transfer for the in-kind redemption escrow path (threat model
    /// EE-6): one blacklisted/reverting basket asset must not block the whole redemption.
    /// Gas-capped and returndata-bounded (security review H-2): a token that returns 1–31
    /// bytes, a returndata bomb, or burns unlimited gas must degrade to `false` (→ escrow),
    /// never revert the enclosing settlement.
    /// @return ok true on success; false lets the caller escrow the slice for later claim.
    function tryTransfer(address token, address to, uint256 amount, uint256 gasLimit)
        internal
        returns (bool ok)
    {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), to)
            mstore(add(ptr, 0x24), amount)
            ok := call(gasLimit, token, 0, ptr, 0x44, 0, 0)
            if ok {
                // Bounded: at most one word is ever copied, so a returndata bomb costs the
                // callee its own memory expansion and costs this frame nothing.
                switch returndatasize()
                case 0 {} // no-return tokens (USDT-style): success
                default {
                    switch lt(returndatasize(), 0x20)
                    case 1 { ok := 0 } // 1-31 bytes: malformed, and now REPORTABLE
                    default {
                        returndatacopy(ptr, 0, 0x20)
                        ok := eq(mload(ptr), 1)
                    }
                }
            }
        }
    }
}
