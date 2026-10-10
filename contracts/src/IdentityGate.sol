// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC721Balance {
    function balanceOf(address owner) external view returns (uint256);
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
}

interface IReputationRegistry {
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}

/// @title IdentityGate — ERC-8004 identity presence check + reputation view
/// @notice Enforces the authority invariant: reputation is a timestamped record, NOT a
/// governance multiplier. An agent's ERC-8004 reputation score has zero influence
/// on voting weight, proposal rights, or execution authority in any vault.
///
/// AUTHORITY INVARIANT (reputation ≠ governance):
///   - Reputation data from IReputationRegistry is read-only.
///   - No function in this contract modifies VaultCore, Governance, FeeEngine, or any
///     other protocol module.
///   - Operatorship confers no authority to vote, execute, pause, reprice, or move member funds.
///   - Identity presence (hasIdentity) is a record check, not an access control gate
///     on any vault function. Vaults are permissionless — identity is checked off-chain
///     or in the UI, not enforced on-chain on deposit/exit paths.
contract IdentityGate {
    /// @notice Pinned ERC-8004 identity registry (ERC-721 compatible).
    address public immutable identityRegistry;

    /// @notice Pinned ERC-8004 reputation registry.
    address public immutable reputationRegistry;

    /// @notice Emitted by recordActivity as an indexable off-chain activity crank.
    event AgentActivityRecorded(
        address indexed agent, uint256 indexed agentId, address indexed vault, string activityTag
    );

    error BadConfig();

    /// @notice Constructs a read-only identity and reputation view gate.
    /// @param identityRegistry_ ERC-8004 identity registry address (non-zero).
    /// @param reputationRegistry_ ERC-8004 reputation registry address (non-zero).
    constructor(address identityRegistry_, address reputationRegistry_) {
        require(identityRegistry_ != address(0) && reputationRegistry_ != address(0), BadConfig());
        identityRegistry = identityRegistry_;
        reputationRegistry = reputationRegistry_;
    }

    /// @notice Checks whether an agent owns at least one ERC-8004 identity token.
    /// @dev Uses staticcall and fails open: if the registry call reverts, returns false.
    /// @param agent Address to query.
    /// @return present True when balanceOf(agent) > 0, false otherwise or on call failure.
    function hasIdentity(address agent) external view returns (bool present) {
        (bool ok, bytes memory data) =
            identityRegistry.staticcall(abi.encodeWithSelector(IERC721Balance.balanceOf.selector, agent));
        if (!ok || data.length < 32) return false;
        uint256 bal = abi.decode(data, (uint256));
        return bal > 0;
    }

    /// @notice Returns the first ERC-8004 identity token id for an agent.
    /// @dev Uses staticcall and fails open: on revert or malformed response returns (0, false).
    /// @param agent Address to query.
    /// @return agentId First identity token id when found.
    /// @return found True if tokenOfOwnerByIndex(agent, 0) succeeded.
    function agentIdOf(address agent) public view returns (uint256 agentId, bool found) {
        (bool ok, bytes memory data) = identityRegistry.staticcall(
            abi.encodeWithSelector(IERC721Balance.tokenOfOwnerByIndex.selector, agent, 0)
        );
        if (!ok || data.length < 32) return (0, false);
        return (abi.decode(data, (uint256)), true);
    }

    /// @notice Reads an agent's reputation summary from the ERC-8004 reputation registry.
    /// @dev Fails open: on revert or malformed response returns zeroed summary values.
    /// @param agentId Agent identity id.
    /// @param clientAddresses Optional client-address filter supplied to the registry.
    /// @param tag1 First reputation tag.
    /// @param tag2 Second reputation tag.
    /// @return count Number of contributing feedback records.
    /// @return summaryValue Signed summary value from the registry.
    /// @return summaryValueDecimals Decimals for summaryValue.
    function reputationSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        try IReputationRegistry(reputationRegistry).getSummary(agentId, clientAddresses, tag1, tag2) returns (
            uint64 count_, int128 summaryValue_, uint8 summaryValueDecimals_
        ) {
            return (count_, summaryValue_, summaryValueDecimals_);
        } catch {
            return (0, 0, 0);
        }
    }

    /// @notice Emits an off-chain indexable agent activity event for the CALLER.
    /// @dev Public crank only; does not mutate vault/protocol governance or balances.
    ///
    /// The emitted `agentId` is RESOLVED ON-CHAIN from `msg.sender` rather than accepted from
    /// calldata. An earlier draft took the id as a parameter, which let any caller emit an event
    /// attributing activity to an arbitrary agent id: `msg.sender` could not be spoofed, but an
    /// indexer keying on `agentId` could be fed junk by anyone. Resolving it here means the id and
    /// the address in a given event always agree. An agent with no ERC-8004 identity emits id 0,
    /// which is the honest answer rather than a revert — this is a record, not a gate.
    ///
    /// `vault` remains caller-supplied and is NOT verified to be a real vault. It is a routing
    /// hint for consumers, and consumers must treat it as one.
    /// @param vault Vault address associated with the activity (unverified hint).
    /// @param activityTag Free-form activity tag for off-chain consumers.
    function recordActivity(address vault, string calldata activityTag) external {
        (uint256 agentId,) = agentIdOf(msg.sender);
        emit AgentActivityRecorded(msg.sender, agentId, vault, activityTag);
    }
}
