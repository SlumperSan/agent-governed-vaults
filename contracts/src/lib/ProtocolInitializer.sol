// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The single sender of every post-deploy call on a protocol singleton: the one-shot wiring
// of OperatorRegistry, SubVaultRegistry and Governance, and `VaultFactory.initialize`.
// Why a constant and not `msg.sender` captured in a constructor. The protocol singletons are
// deployed through the shared CREATE2 proxy (0x4e59b44847b379578588920ca78fbf26c0b4956c) so that
// each one has the same address on every chain. Inside a constructor `msg.sender` is then the
// proxy, never the person who sent the deployment, and nobody could ever call as the proxy again:
// the wiring would be unreachable and the protocol would deploy inert. A literal here keeps every
// singleton's initcode identical on every chain, which is what fixes its address.
//
// What the key can do: call each one-shot wire or initialize function once per chain. Each of
// those functions reverts on a second call, so after bring-up no function in OperatorRegistry,
// SubVaultRegistry, Governance or VaultFactory accepts this address as a special caller. If the
// key is lost before a chain is initialised, that chain cannot be initialised at these addresses.
address constant PROTOCOL_INITIALIZER = 0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35;
