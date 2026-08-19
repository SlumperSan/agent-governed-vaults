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

    /// @notice Non-reverting transfer for the in-kind redemption escrow path (threat model
    /// EE-6): one blacklisted/reverting basket asset must not block the whole redemption.
    /// @return ok true on success; false lets the caller escrow the slice for later claim.
    function tryTransfer(address token, address to, uint256 amount) internal returns (bool ok) {
        (bool callOk, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        ok = callOk && (ret.length == 0 || abi.decode(ret, (bool)));
    }
}
