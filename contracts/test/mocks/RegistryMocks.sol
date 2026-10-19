// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice A registry whose `balanceOf(address)` answer is chosen by the test. Used to prove that
/// AgentVaultCore's gate fails closed on entry and that no exit path consults the registry.
contract ModeRegistry {
    enum Mode {
        Normal, // 1 for addresses flagged with setHeld (or everyone when allowAll), else 0
        Revert, // reverts with an Error(string)
        Revert32, // reverts with exactly one nonzero word of data
        Short, // returns one byte
        Zero, // returns uint256(0) for everyone
        Burn, // consumes all gas it is given
        Big // returns 64 bytes whose first word is nonzero
    }

    Mode public mode;
    bool public allowAll;
    mapping(address => bool) public held;
    /// A chosen nonzero balance for an address, returned as is in Normal mode (a wallet may hold
    /// many identities). Zero means "use `held` / `allowAll`", which answer 1 or 0.
    mapping(address => uint256) public heldCount;

    function setMode(Mode m) external {
        mode = m;
    }

    function setAllowAll(bool a) external {
        allowAll = a;
    }

    function setHeld(address who, bool h) external {
        held[who] = h;
    }

    function setHeldCount(address who, uint256 n) external {
        heldCount[who] = n;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        Mode m = mode;
        if (m == Mode.Revert) revert("hostile registry");
        if (m == Mode.Revert32) {
            assembly {
                mstore(0, 1)
                revert(0, 32)
            }
        }
        if (m == Mode.Burn) {
            assembly {
                for {} 1 {} {}
            }
        }
        if (m == Mode.Short) return hex"01";
        if (m == Mode.Zero) return abi.encode(uint256(0));
        if (m == Mode.Big) return abi.encode(uint256(1), uint256(1));
        address who = abi.decode(data[4:], (address));
        uint256 n = heldCount[who];
        if (n != 0) return abi.encode(n);
        return abi.encode(allowAll || held[who] ? uint256(1) : uint256(0));
    }
}

/// @notice Admits every address. The registry used by the differential suites, so that any
/// behavioural difference between VaultCore and AgentVaultCore is a defect.
contract AllowAllRegistry {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(uint256(1));
    }
}
