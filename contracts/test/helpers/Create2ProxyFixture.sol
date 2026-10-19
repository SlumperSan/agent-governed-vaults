// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ProtocolCreate2} from "../../script/lib/ProtocolCreate2.sol";

/// @notice Puts Arachnid's deterministic deployment proxy at its canonical address in a local test
/// EVM, so the same-address recipe can be exercised without a fork.
/// @dev The runtime is the 69 bytes read from `eth_getCode` on Arc mainnet (both public RPCs agreed,
/// keccak256 0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989, the same hash the
/// research note recorded on all five chains). `test_proxyFixtureMatchesTheKnownCodehash` pins it.
abstract contract Create2ProxyFixture is Test {
    bytes internal constant PROXY_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
    bytes32 internal constant PROXY_CODEHASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    function _etchCreate2Proxy() internal {
        vm.etch(ProtocolCreate2.PROXY, PROXY_RUNTIME);
    }
}
