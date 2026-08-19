// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice Minimal safe ERC-20 transfer helpers tolerating missing return values (USDT-style).
/// Vendored rather than imported to keep the dependency surface auditable (Sprint 1 decision;
/// may be swapped for OpenZeppelin SafeERC20 at the Sprint 6 audit-prep pass).
library SafeTransferLib {
    error TransferFailed(address token);
    error TransferFromFailed(address token);

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed(token);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount)); // transferFrom
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFromFailed(token);
    }

    error ApproveFailed(address token);

    function safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount)); // approve
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed(token);
    }

    /// @notice Non-reverting transfer for the in-kind redemption escrow path (threat model
    /// EE-6): one blacklisted/reverting basket asset must not block the whole redemption.
    /// Gas-capped and returndata-bounded (security review H-2): a token that returns 1–31
    /// bytes, a returndata bomb, or burns unlimited gas must degrade to `false` (→ escrow),
    /// never revert the enclosing settlement.
    /// @return ok true on success; false lets the caller escrow the slice for later claim.
    function tryTransfer(address token, address to, uint256 amount, uint256 gasLimit) internal returns (bool ok) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), to)
            mstore(add(ptr, 0x24), amount)
            ok := call(gasLimit, token, 0, ptr, 0x44, 0, 0)
            if ok {
                switch returndatasize()
                case 0 {} // no-return tokens: success
                default {
                    switch lt(returndatasize(), 0x20)
                    case 1 { ok := 0 } // 1–31 bytes: malformed, treat as failure
                    default {
                        returndatacopy(ptr, 0, 0x20)
                        ok := eq(mload(ptr), 1)
                    }
                }
            }
        }
    }
}
