// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Gas- and returndata-bounded external calls for creator-chosen bookkeeping modules
/// (security review H-1): a reverting, gas-guzzling, or returndata-bombing module must never
/// be able to block a member's exit. Copies at most one word of returndata, so a bomb costs
/// the callee its gas allowance and nothing else.
library BoundedCall {
    /// @return ok       call succeeded
    /// @return word     first 32 bytes of returndata (0 if none)
    /// @return retSize  actual returndata size
    function boundedCall(address target, bytes memory data, uint256 gasLimit)
        internal
        returns (bool ok, uint256 word, uint256 retSize)
    {
        assembly ("memory-safe") {
            ok := call(gasLimit, target, 0, add(data, 0x20), mload(data), 0, 0)
            retSize := returndatasize()
            if gt(retSize, 0) {
                let ptr := mload(0x40)
                let copy := retSize
                if gt(copy, 0x20) { copy := 0x20 }
                // L-3: zero the scratch word first. For 1-31 bytes of returndata the copy
                // filled only the high bytes and the remainder was whatever happened to be
                // at the free-memory pointer, so `word` carried uninitialised memory. Two
                // of the five call sites gate on `retSize >= 32`; VaultCore's perfFee read
                // did not.
                mstore(ptr, 0)
                returndatacopy(ptr, 0, copy)
                word := mload(ptr)
            }
        }
    }

    function boundedStaticCall(address target, bytes memory data, uint256 gasLimit)
        internal
        view
        returns (bool ok, uint256 word, uint256 retSize)
    {
        assembly ("memory-safe") {
            ok := staticcall(gasLimit, target, add(data, 0x20), mload(data), 0, 0)
            retSize := returndatasize()
            if gt(retSize, 0) {
                let ptr := mload(0x40)
                let copy := retSize
                if gt(copy, 0x20) { copy := 0x20 }
                mstore(ptr, 0) // L-3, as above
                returndatacopy(ptr, 0, copy)
                word := mload(ptr)
            }
        }
    }
}
