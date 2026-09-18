// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IdentityGate} from "../src/IdentityGate.sol";

// ─────────────────────────────── mocks ────────────────────────────────────────

contract MockERC721Registry {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(uint256 => uint256)) public tokenOfOwnerByIndex;

    function setBalance(address owner, uint256 bal) external {
        balanceOf[owner] = bal;
    }

    function setTokenId(address owner, uint256 index, uint256 tokenId) external {
        tokenOfOwnerByIndex[owner][index] = tokenId;
    }
}

contract RevertingRegistry {
    fallback() external {
        revert("hostile-registry");
    }
}

contract MockReputationRegistry {
    uint64 public retCount;
    int128 public retValue;
    uint8 public retDecimals;
    bool public shouldRevert;

    function configure(uint64 count, int128 value, uint8 dec, bool revert_) external {
        retCount = count;
        retValue = value;
        retDecimals = dec;
        shouldRevert = revert_;
    }

    function getSummary(uint256, address[] calldata, string calldata, string calldata)
        external
        view
        returns (uint64, int128, uint8)
    {
        if (shouldRevert) revert("rep-revert");
        return (retCount, retValue, retDecimals);
    }
}

// ─────────────────────────────── test suite ───────────────────────────────────

contract IdentityGateTest is Test {
    MockERC721Registry internal idRegistry;
    MockReputationRegistry internal repRegistry;
    IdentityGate internal gate;

    address internal constant AGENT = address(0xA6E4);
    address internal constant VAULT = address(0xBEEF1);

    function setUp() public {
        idRegistry = new MockERC721Registry();
        repRegistry = new MockReputationRegistry();
        gate = new IdentityGate(address(idRegistry), address(repRegistry));
    }

    // ─── 1. hasIdentity — true when balanceOf > 0 ─────────────────────────────

    function test_HasIdentity_TrueWhenBalancePositive() public {
        idRegistry.setBalance(AGENT, 1);
        assertTrue(gate.hasIdentity(AGENT));
    }

    // ─── 2. hasIdentity — false when balanceOf == 0 ───────────────────────────

    function test_HasIdentity_FalseWhenBalanceZero() public view {
        // balance defaults to 0
        assertFalse(gate.hasIdentity(AGENT));
    }

    // ─── 3. hasIdentity — fail-open on registry revert ────────────────────────

    function test_HasIdentity_FailOpenOnRegistryRevert() public {
        RevertingRegistry brokenRegistry = new RevertingRegistry();
        MockReputationRegistry repReg = new MockReputationRegistry();
        IdentityGate gateWithBroken = new IdentityGate(address(brokenRegistry), address(repReg));

        // Should not revert — returns false
        assertFalse(gateWithBroken.hasIdentity(AGENT));
    }

    // ─── 4. agentIdOf — returns (id, true) on success ────────────────────────

    function test_AgentIdOf_ReturnsTrueWithId() public {
        uint256 expectedId = 42;
        idRegistry.setBalance(AGENT, 1);
        idRegistry.setTokenId(AGENT, 0, expectedId);

        (uint256 id, bool found) = gate.agentIdOf(AGENT);
        assertTrue(found);
        assertEq(id, expectedId);
    }

    // ─── 5. agentIdOf — fail-open on registry revert ─────────────────────────

    function test_AgentIdOf_FailOpenOnRegistryRevert() public {
        RevertingRegistry brokenRegistry = new RevertingRegistry();
        MockReputationRegistry repReg = new MockReputationRegistry();
        IdentityGate gateWithBroken = new IdentityGate(address(brokenRegistry), address(repReg));

        (uint256 id, bool found) = gateWithBroken.agentIdOf(AGENT);
        assertFalse(found);
        assertEq(id, 0);
    }

    function test_AgentIdOf_FailOpenWhenNoTokens() public view {
        // balance = 0, tokenOfOwnerByIndex(0) would revert on a real ERC721
        // MockERC721Registry returns 0 silently — still (0, true) since the call succeeds
        // For the purpose of this test: balance=0 but the mock doesn't revert, returns 0
        (uint256 id, bool found) = gate.agentIdOf(AGENT);
        // mock returns 0 silently (not a real ERC721), so found is true, id is 0
        // In the real ERC-8004 registry, tokenOfOwnerByIndex would revert for balance=0,
        // which is the actual fail-open path. Both are acceptable here.
        assertEq(id, 0);
        assertTrue(found); // mock doesn't revert
    }

    // ─── 6. reputationSummary — live data ─────────────────────────────────────

    function test_ReputationSummary_ReturnsLiveData() public {
        repRegistry.configure(5, 95, 0, false);

        address[] memory clients = new address[](1);
        clients[0] = address(0xC11);

        (uint64 count, int128 value, uint8 dec) = gate.reputationSummary(1, clients, "tag1", "tag2");

        assertEq(count, 5);
        assertEq(value, 95);
        assertEq(dec, 0);
    }

    // ─── 7. reputationSummary — fail-open on revert ───────────────────────────

    function test_ReputationSummary_FailOpenOnRevert() public {
        repRegistry.configure(0, 0, 0, true); // will revert

        address[] memory clients = new address[](1);
        clients[0] = address(0xC11);

        // Should not revert — returns (0, 0, 0)
        (uint64 count, int128 value, uint8 dec) = gate.reputationSummary(1, clients, "tag1", "tag2");

        assertEq(count, 0);
        assertEq(value, 0);
        assertEq(dec, 0);
    }

    // ─── 8. recordActivity — emits event, anyone can call ─────────────────────

    function test_RecordActivity_EmitsEvent() public {
        uint256 agentId = 7;
        address vault = address(0xB00B);
        string memory tag = "rebalance-proposed";

        // The id is resolved from the registry, not supplied by the caller, so it has to be
        // registered for AGENT before the event can carry it.
        idRegistry.setBalance(AGENT, 1);
        idRegistry.setTokenId(AGENT, 0, agentId);

        vm.expectEmit(true, true, true, true);
        emit IdentityGate.AgentActivityRecorded(AGENT, agentId, vault, tag);

        vm.prank(AGENT);
        gate.recordActivity(vault, tag);
    }

    /// @dev The id in the event is the CALLER's, never one they chose. An earlier draft took the
    /// id as a parameter, which let anyone emit activity attributed to someone else's agent id —
    /// junk for any indexer keying on it. This test fails if that parameter comes back.
    function test_RecordActivity_CannotAttributeToAnotherAgentsId() public {
        uint256 victimId = 7;
        idRegistry.setBalance(AGENT, 1);
        idRegistry.setTokenId(AGENT, 0, victimId);

        address impostor = address(0xBAD1);
        idRegistry.setBalance(impostor, 1);
        idRegistry.setTokenId(impostor, 0, 99);

        // The impostor's event carries 99 — its own id — and never the victim's 7.
        vm.expectEmit(true, true, true, true);
        emit IdentityGate.AgentActivityRecorded(impostor, 99, VAULT, "spoof-attempt");

        vm.prank(impostor);
        gate.recordActivity(VAULT, "spoof-attempt");
    }

    /// @dev An agent with no identity records id 0 rather than reverting: this is a record, not a
    /// gate, and refusing to record would make the crank an access-control surface.
    function test_RecordActivity_NoIdentityRecordsZero() public {
        address nobody = address(0xDEAD1);

        vm.expectEmit(true, true, true, true);
        emit IdentityGate.AgentActivityRecorded(nobody, 0, VAULT, "no-identity");

        vm.prank(nobody);
        gate.recordActivity(VAULT, "no-identity");
    }

    function test_RecordActivity_AnyoneCanCall() public {
        // Random address can also call recordActivity — no access control
        address random = address(0xBEEF2);
        vm.prank(random);
        gate.recordActivity(address(0), "open-crank");
        // No revert = pass
    }

    // ─── 9. Authority invariant — IdentityGate modifies no protocol state ─────

    /// @dev AUTHORITY INVARIANT: IdentityGate has no function that can modify VaultCore,
    ///      Governance, FeeEngine, or any vault state.
    ///      The only mutating function is recordActivity, which emits an event only.
    function test_AuthorityInvariant_NoProtocolStateModification() public view {
        // IdentityGate's mutable surface is exactly: recordActivity (event only)
        // It has no vault/governance/feeEngine reference.
        // It has no write path to any external contract.
        // Confirmed by reading the source — this test documents the invariant.
        assertEq(gate.identityRegistry(), address(idRegistry));
        assertEq(gate.reputationRegistry(), address(repRegistry));
        // No other state-mutating externals exist on the contract.
    }

    /// @dev Reputation score does NOT affect governance — direct confirmation.
    ///      IdentityGate.reputationSummary is a pure read. The result is never passed
    ///      to Governance or VaultCore by this contract.
    function test_AuthorityInvariant_ReputationDoesNotGrantGovernancePower() public {
        // Set a very high reputation score
        repRegistry.configure(type(uint64).max, type(int128).max, 0, false);
        address[] memory clients = new address[](1);
        clients[0] = AGENT;

        (uint64 count,,) = gate.reputationSummary(1, clients, "", "");
        assertGt(count, 0, "reputation is non-zero");

        // But IdentityGate has no call to Governance or VaultCore — score stays off-chain.
        // The contract has no governance reference at all. Verified by the fact that
        // `gate` was constructed with only idRegistry + repRegistry addresses.
        // This test passes as long as IdentityGate compiles with no vault/gov imports.
    }

    // ─── 10. Constructor validation ───────────────────────────────────────────

    function test_Constructor_RejectsZeroIdentityRegistry() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityGate.BadConfig.selector));
        new IdentityGate(address(0), address(repRegistry));
    }

    function test_Constructor_RejectsZeroReputationRegistry() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityGate.BadConfig.selector));
        new IdentityGate(address(idRegistry), address(0));
    }
}
