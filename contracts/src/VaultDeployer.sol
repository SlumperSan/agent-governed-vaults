// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {VaultCore} from "./VaultCore.sol";

/// @title VaultDeployer — the factory's one and only vault construction path
/// @notice Exists for one reason: EIP-170. `VaultCore`'s creation code is 24,731 B, which is
/// larger than the 24,576 B runtime cap all by itself, so ANY contract that writes
/// `new VaultCore(...)` embeds a blob that cannot fit in a deployable contract. VaultFactory
/// was 2,665 B over the cap for exactly this reason (#10).
///
/// The fix keeps the bytes compile-time-embedded — they are never supplied by a caller. This
/// contract's own CREATION code carries `type(VaultCore).creationCode` (initcode is capped at
/// 49,152 B by EIP-3860, so it fits there), and its constructor copies that blob into two
/// immutable, non-executable data contracts. `deploy` reads those two chunks back, appends the
/// caller's ABI-encoded constructor arguments, and CREATEs. The bytes that reach CREATE are
/// therefore fixed at compile time and verifiable on-chain via `creationCode()`.
///
/// Trust: this contract holds NO authority. It has no owner, no state after construction, and
/// no privileged relationship with any protocol singleton. Attestation stays anchored where it
/// always was — `OperatorRegistry.attestVault` is callable only by the wired VaultFactory
/// (CM-5). Calling `deploy` directly yields an UNATTESTED VaultCore, which is exactly what
/// anyone could already obtain by deploying VaultCore themselves. What the factory's immutable
/// `deployer` pin buys is the other direction: the factory can only ever CREATE through this
/// one code path.
contract VaultDeployer {
    /// @notice First half of `type(VaultCore).creationCode`, stored as contract code.
    address public immutable codeChunkA;
    /// @notice Second half of `type(VaultCore).creationCode`, stored as contract code.
    address public immutable codeChunkB;

    error ChunkWriteFailed();
    error DeployFailed();

    constructor() {
        bytes memory code = type(VaultCore).creationCode;
        uint256 half = code.length / 2;
        codeChunkA = _writeChunk(code, 0, half);
        codeChunkB = _writeChunk(code, half, code.length - half);
    }

    /// @notice Deploy a VaultCore from the pinned creation code plus `ctorArgs`.
    /// @dev Permissionless and authority-free by design (see contract notes). A failing
    /// VaultCore constructor bubbles its own revert data unchanged, so callers still observe
    /// `VaultCore.BadConfig()` exactly as they did when the factory used `new VaultCore(...)`.
    /// @param ctorArgs abi.encode of VaultCore's constructor parameter tuple
    /// @return vault the newly created VaultCore
    function deploy(bytes calldata ctorArgs) external returns (address vault) {
        address a = codeChunkA;
        address b = codeChunkB;
        bytes4 failed = DeployFailed.selector;
        assembly ("memory-safe") {
            // Chunk code is `0x00 || data`, so skip the leading STOP byte on read.
            let la := sub(extcodesize(a), 1)
            let lb := sub(extcodesize(b), 1)
            let n := add(add(la, lb), ctorArgs.length)
            let p := mload(0x40)
            mstore(0x40, add(p, n))
            extcodecopy(a, p, 1, la)
            extcodecopy(b, add(p, la), 1, lb)
            calldatacopy(add(p, add(la, lb)), ctorArgs.offset, ctorArgs.length)
            vault := create(0, p, n)
            if iszero(vault) {
                if iszero(returndatasize()) {
                    mstore(0, failed)
                    revert(0, 4)
                }
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }

    /// @notice The exact creation code `deploy` will CREATE from, reassembled from both chunks.
    /// @dev Verification aid: this must equal the compiled `type(VaultCore).creationCode`.
    function creationCode() external view returns (bytes memory) {
        return bytes.concat(_readChunk(codeChunkA), _readChunk(codeChunkB));
    }

    /// @dev Store `code[offset..offset+len]` as the runtime of a fresh contract, prefixed with
    /// a STOP byte so the data can never be executed (the SSTORE2 convention).
    function _writeChunk(bytes memory code, uint256 offset, uint256 len) private returns (address ptr) {
        // 11-byte header, then the payload:
        //   61 <len+1>  PUSH2 returnSize        80        DUP1
        //   60 0a       PUSH1 codeOffset        3d        RETURNDATASIZE (0)
        //   39          CODECOPY(0, 0x0a, size) 3d        RETURNDATASIZE (0)
        //   f3          RETURN(0, size)         00        STOP  ← first byte of the runtime
        bytes memory initcode = new bytes(11 + len);
        uint256 header = (((0x61 << 16) | (len + 1)) << 64) | 0x80600a3d393df300;
        assembly ("memory-safe") {
            let p := add(initcode, 0x20)
            mstore(p, shl(168, header))
            mcopy(add(p, 11), add(add(code, 0x20), offset), len)
            ptr := create(0, p, add(len, 11))
        }
        require(ptr != address(0), ChunkWriteFailed());
    }

    function _readChunk(address chunk) private view returns (bytes memory data) {
        uint256 len = chunk.code.length - 1;
        data = new bytes(len);
        assembly ("memory-safe") {
            extcodecopy(chunk, add(data, 0x20), 1, len)
        }
    }
}
