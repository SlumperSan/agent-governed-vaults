// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ProtocolCreate2} from "../script/lib/ProtocolCreate2.sol";
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";

/// @notice Holds `config/create2-manifest.json` to the compiler's own output. The manifest records, for
/// each same-address singleton, its salt, its initcode hash and the CREATE2 address those give through
/// the Arachnid proxy. A source change that moves a byte of any initcode moves the hash and fails here,
/// which is the signal to regenerate the manifest (`node scripts/update-create2-manifest.mjs`) and to
/// read what moved. `scripts/test/create2-manifest.test.mjs` is the second, independent reader: it
/// recomputes every figure from `contracts/out` with a different implementation.
contract Create2DeterminismTest is Test {
    string internal manifest;

    function setUp() public {
        manifest = vm.readFile("config/create2-manifest.json");
    }

    function _check(string memory name, bytes32 salt, bytes memory initcode, address predicted)
        internal
        view
    {
        string memory base = string.concat(".contracts.", name);
        assertEq(
            vm.parseJsonBytes32(manifest, string.concat(base, ".salt")), salt, string.concat(name, " salt")
        );
        assertEq(
            vm.parseJsonUint(manifest, string.concat(base, ".initcodeBytes")),
            initcode.length,
            string.concat(name, " initcode length")
        );
        assertEq(
            vm.parseJsonBytes32(manifest, string.concat(base, ".initcodeHash")),
            keccak256(initcode),
            string.concat(name, " initcode hash (the source moved: regenerate and review the manifest)")
        );
        assertEq(
            vm.parseJsonAddress(manifest, string.concat(base, ".address")),
            predicted,
            string.concat(name, " address")
        );
    }

    function test_manifestMatchesTheCompiledInitcode() public view {
        assertEq(vm.parseJsonAddress(manifest, ".proxy"), ProtocolCreate2.PROXY, "proxy");
        assertEq(vm.parseJsonAddress(manifest, ".initializer"), PROTOCOL_INITIALIZER, "initializer");
        ProtocolCreate2.Set memory s = ProtocolCreate2.predict();
        _check(
            "OperatorRegistry",
            ProtocolCreate2.SALT_OPERATOR_REGISTRY,
            ProtocolCreate2.initcodeOperatorRegistry(),
            s.operatorRegistry
        );
        _check(
            "SubVaultRegistry",
            ProtocolCreate2.SALT_SUB_VAULT_REGISTRY,
            ProtocolCreate2.initcodeSubVaultRegistry(),
            s.subVaultRegistry
        );
        _check(
            "FeeEngine",
            ProtocolCreate2.SALT_FEE_ENGINE,
            ProtocolCreate2.initcodeFeeEngine(s.operatorRegistry),
            s.feeEngine
        );
        _check(
            "Governance", ProtocolCreate2.SALT_GOVERNANCE, ProtocolCreate2.initcodeGovernance(), s.governance
        );
        _check(
            "VaultDeployer",
            ProtocolCreate2.SALT_VAULT_DEPLOYER,
            ProtocolCreate2.initcodeVaultDeployer(),
            s.vaultDeployer
        );
        _check(
            "VaultFactory",
            ProtocolCreate2.SALT_VAULT_FACTORY,
            ProtocolCreate2.initcodeVaultFactory(s),
            s.vaultFactory
        );
    }

    /// @notice Initcode is a pure function of the build, so it reads the same under every launch chain
    /// id. (No constructor argument reads `block.chainid`; this is the guard against one being added.)
    function test_initcodeHashesAreIdenticalUnderEveryLaunchChainId() public {
        uint256[5] memory ids = [uint256(5042), 8453, 42161, 1, 137];
        ProtocolCreate2.Set memory base = ProtocolCreate2.predict();
        bytes32 hFactory = keccak256(ProtocolCreate2.initcodeVaultFactory(base));
        bytes32 hDeployer = keccak256(ProtocolCreate2.initcodeVaultDeployer());
        bytes32 hGov = keccak256(ProtocolCreate2.initcodeGovernance());
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            ProtocolCreate2.Set memory s = ProtocolCreate2.predict();
            assertEq(keccak256(ProtocolCreate2.initcodeVaultFactory(s)), hFactory, "factory initcode");
            assertEq(keccak256(ProtocolCreate2.initcodeVaultDeployer()), hDeployer, "deployer initcode");
            assertEq(keccak256(ProtocolCreate2.initcodeGovernance()), hGov, "governance initcode");
            assertEq(s.operatorRegistry, base.operatorRegistry, "registry address");
            assertEq(s.vaultFactory, base.vaultFactory, "factory address");
        }
    }

    /// @notice The six addresses are distinct, so no two salts collide into one slot.
    function test_addressesAreDistinct() public view {
        ProtocolCreate2.Set memory s = ProtocolCreate2.predict();
        address[6] memory a = [
            s.operatorRegistry, s.subVaultRegistry, s.feeEngine, s.governance, s.vaultDeployer, s.vaultFactory
        ];
        for (uint256 i; i < 6; ++i) {
            for (uint256 j = i + 1; j < 6; ++j) {
                assertTrue(a[i] != a[j], "distinct");
            }
        }
    }
}
