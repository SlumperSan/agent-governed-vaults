// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OperatorRegistry} from "../../src/OperatorRegistry.sol";
import {SubVaultRegistry} from "../../src/SubVaultRegistry.sol";
import {FeeEngine} from "../../src/FeeEngine.sol";
import {Governance} from "../../src/Governance.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {VaultDeployer} from "../../src/VaultDeployer.sol";

/// @title ProtocolCreate2 — the same-address deployment recipe for the six protocol singletons
/// @notice One definition of each singleton's salt and initcode, shared by `Deploy.s.sol`, the
/// determinism tests and the Arc fork test, so the recipe a test proves is the recipe the script runs.
/// `contracts/config/create2-manifest.json` records the resulting initcode hashes and addresses;
/// `test/Create2Determinism.t.sol` and `scripts/test/create2-manifest.test.mjs` hold that file to this one.
///
/// Every salt is fixed per contract and carries NO chain id: the address of a singleton is a function
/// of (proxy, salt, keccak256(initcode)) only, and no initcode takes a per-chain value. The per-chain
/// inputs (the oracle allowlist) arrive afterwards through `VaultFactory.initialize`.
///
/// ChainlinkOracle and the router adapter are NOT here by design: their whole content is per-chain
/// configuration, so they are deployed per chain with plain CREATE.
library ProtocolCreate2 {
    /// @dev Arachnid's deterministic deployment proxy: 69 bytes of runtime, present at this address on
    /// Arc, Base, Arbitrum, Ethereum and Polygon. Calldata is `salt (32) || initcode`; it returns the
    /// 20-byte address and reverts with no data on failure (including an address that already has code).
    address internal constant PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    bytes32 internal constant SALT_OPERATOR_REGISTRY = keccak256("rwally.protocol.v2.OperatorRegistry");
    bytes32 internal constant SALT_SUB_VAULT_REGISTRY = keccak256("rwally.protocol.v2.SubVaultRegistry");
    bytes32 internal constant SALT_FEE_ENGINE = keccak256("rwally.protocol.v2.FeeEngine");
    bytes32 internal constant SALT_GOVERNANCE = keccak256("rwally.protocol.v2.Governance");
    bytes32 internal constant SALT_VAULT_DEPLOYER = keccak256("rwally.protocol.v2.VaultDeployer");
    bytes32 internal constant SALT_VAULT_FACTORY = keccak256("rwally.protocol.v2.VaultFactory");

    /// @dev C-1: root vaults only at launch. Part of the VaultFactory initcode, so it is part of its address.
    bool internal constant ALLOW_SUB_VAULTS = false;

    struct Set {
        address operatorRegistry;
        address subVaultRegistry;
        address feeEngine;
        address governance;
        address vaultDeployer;
        address vaultFactory;
    }

    /// @notice `address = keccak256(0xff ++ proxy ++ salt ++ keccak256(initcode))[12:]`.
    function addressOf(bytes32 salt, bytes memory initcode) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), PROXY, salt, keccak256(initcode)))))
        );
    }

    // ───────────────────────────── initcode ──────────────────────────────

    function initcodeOperatorRegistry() internal pure returns (bytes memory) {
        return type(OperatorRegistry).creationCode;
    }

    function initcodeSubVaultRegistry() internal pure returns (bytes memory) {
        return type(SubVaultRegistry).creationCode;
    }

    function initcodeFeeEngine(address operatorRegistry) internal pure returns (bytes memory) {
        return abi.encodePacked(type(FeeEngine).creationCode, abi.encode(operatorRegistry));
    }

    function initcodeGovernance() internal pure returns (bytes memory) {
        return type(Governance).creationCode;
    }

    function initcodeVaultDeployer() internal pure returns (bytes memory) {
        return type(VaultDeployer).creationCode;
    }

    function initcodeVaultFactory(Set memory s) internal pure returns (bytes memory) {
        return abi.encodePacked(
            type(VaultFactory).creationCode,
            abi.encode(
                s.operatorRegistry,
                s.governance,
                s.feeEngine,
                s.subVaultRegistry,
                s.vaultDeployer,
                ALLOW_SUB_VAULTS
            )
        );
    }

    /// @notice All six predicted addresses. Order of derivation is the dependency order: the factory's
    /// initcode embeds the other five, FeeEngine's embeds the OperatorRegistry.
    function predict() internal pure returns (Set memory s) {
        s.operatorRegistry = addressOf(SALT_OPERATOR_REGISTRY, initcodeOperatorRegistry());
        s.subVaultRegistry = addressOf(SALT_SUB_VAULT_REGISTRY, initcodeSubVaultRegistry());
        s.feeEngine = addressOf(SALT_FEE_ENGINE, initcodeFeeEngine(s.operatorRegistry));
        s.governance = addressOf(SALT_GOVERNANCE, initcodeGovernance());
        s.vaultDeployer = addressOf(SALT_VAULT_DEPLOYER, initcodeVaultDeployer());
        s.vaultFactory = addressOf(SALT_VAULT_FACTORY, initcodeVaultFactory(s));
    }

    /// @notice Send `salt || initcode` to the proxy and return the created address.
    /// @dev Reverts if the proxy is absent, the deployment reverts, or the address already has code.
    function create(bytes32 salt, bytes memory initcode) internal returns (address created) {
        require(
            PROXY.code.length > 0, "ProtocolCreate2: deterministic deployment proxy has no code on this chain"
        );
        (bool ok, bytes memory ret) = PROXY.call(abi.encodePacked(salt, initcode));
        require(ok && ret.length == 20, "ProtocolCreate2: CREATE2 through the proxy failed");
        created = address(bytes20(ret));
        require(
            created == addressOf(salt, initcode), "ProtocolCreate2: created address differs from prediction"
        );
    }

    /// @notice Deploy all six through the proxy. The caller supplies the transaction sender.
    function createAll() internal returns (Set memory s) {
        s = predict();
        create(SALT_OPERATOR_REGISTRY, initcodeOperatorRegistry());
        create(SALT_SUB_VAULT_REGISTRY, initcodeSubVaultRegistry());
        create(SALT_FEE_ENGINE, initcodeFeeEngine(s.operatorRegistry));
        create(SALT_GOVERNANCE, initcodeGovernance());
        create(SALT_VAULT_DEPLOYER, initcodeVaultDeployer());
        create(SALT_VAULT_FACTORY, initcodeVaultFactory(s));
    }
}
