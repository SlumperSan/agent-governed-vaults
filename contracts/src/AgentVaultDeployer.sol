// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentVaultCore} from "./AgentVaultCore.sol";

/// @title AgentVaultDeployer: the factory's one construction path for AgentVaultCore
/// @notice The same design as {VaultDeployer}, for the same reason (EIP-170): a factory that wrote
/// `new AgentVaultCore(...)` would embed the vault's whole creation code in its own runtime. This
/// contract's own CREATION code carries `type(AgentVaultCore).creationCode`, its constructor copies
/// that blob into two immutable, non-executable data contracts, and `deploy` reads the two chunks
/// back, appends the caller's ABI-encoded constructor arguments, and CREATEs. The bytes that reach
/// CREATE are fixed at compile time and verifiable on chain through {creationCode}.
///
/// It is a copy of VaultDeployer with one type swapped, not a shared base, on purpose:
/// VaultDeployer holds the audited VaultCore blob and its bytes (and therefore its CREATE2
/// address) stay exactly as they were.
///
/// Trust: this contract holds NO authority. It has no owner, no state after construction, and no
/// relationship with any protocol singleton. Attestation stays factory-gated in OperatorRegistry,
/// so calling `deploy` directly yields an UNATTESTED AgentVaultCore, which is what anyone could
/// already obtain by deploying AgentVaultCore themselves. What the factory's pin buys is the other
/// direction: the factory can only ever CREATE an agent vault through this one code path.
contract AgentVaultDeployer {
    /// @notice First half of `type(AgentVaultCore).creationCode`, stored as contract code.
    address public immutable codeChunkA;
    /// @notice Second half of `type(AgentVaultCore).creationCode`, stored as contract code.
    address public immutable codeChunkB;

    error ChunkWriteFailed();
    error DeployFailed();

    constructor() {
        bytes memory code = type(AgentVaultCore).creationCode;
        uint256 half = code.length / 2;
        codeChunkA = _writeChunk(code, 0, half);
        codeChunkB = _writeChunk(code, half, code.length - half);
    }

    /// @notice Deploy an AgentVaultCore from the pinned creation code plus `ctorArgs`.
    /// @dev Permissionless and authority-free by design (see contract notes). A failing
    /// AgentVaultCore constructor bubbles its own revert data unchanged, so callers observe
    /// `VaultCore.BadConfig()` exactly as they would from `new AgentVaultCore(...)`.
    /// @param ctorArgs abi.encode of AgentVaultCore's constructor parameter tuple
    /// @return vault the newly created AgentVaultCore
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
    /// @dev Verification aid: this must equal the compiled `type(AgentVaultCore).creationCode`.
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
        //   f3          RETURN(0, size)         00        STOP  <- first byte of the runtime
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
