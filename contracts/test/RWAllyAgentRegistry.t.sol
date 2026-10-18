// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {RWAllyAgentRegistry, IERC721Receiver} from "../src/RWAllyAgentRegistry.sol";

contract GoodReceiver is IERC721Receiver {
    RWAllyAgentRegistry public reg;
    uint256 public received;
    bool public reenter;

    constructor(RWAllyAgentRegistry reg_) {
        reg = reg_;
    }

    function setReenter(bool r) external {
        reenter = r;
    }

    function doRegister() external returns (uint256) {
        return reg.register();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        received++;
        if (reenter) {
            reenter = false;
            reg.register();
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract BadMagicReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }

    function doRegister(RWAllyAgentRegistry reg) external returns (uint256) {
        return reg.register();
    }
}

contract NoReceiver {
    function doRegister(RWAllyAgentRegistry reg) external returns (uint256) {
        return reg.register();
    }
}

/// An ERC-1271 wallet that accepts exactly one signature blob.
contract Wallet1271 {
    bytes32 public okDigest;
    bytes public okSig;

    function allow(bytes32 d, bytes calldata s) external {
        okDigest = d;
        okSig = s;
    }

    function isValidSignature(bytes32 d, bytes calldata s) external view returns (bytes4) {
        return (d == okDigest && keccak256(s) == keccak256(okSig)) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract RWAllyAgentRegistryTest is Test {
    RWAllyAgentRegistry reg;
    address multisig = makeAddr("multisig");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed k, string metadataKey, bytes metadataValue);
    event MetadataUpdate(uint256 _tokenId);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event Revoked(uint256 indexed agentId, address indexed holder);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new RWAllyAgentRegistry(multisig);
    }

    // ── construction and metadata ────────────────────────────────────────────

    function test_constructor_setsOwnerAndEmits() public {
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(address(0), multisig);
        RWAllyAgentRegistry r = new RWAllyAgentRegistry(multisig);
        assertEq(r.owner(), multisig);
        assertEq(r.pendingOwner(), address(0));
    }

    function test_constructor_zeroOwnerReverts() public {
        vm.expectRevert(RWAllyAgentRegistry.ZeroOwner.selector);
        new RWAllyAgentRegistry(address(0));
    }

    function test_identityStrings() public view {
        assertEq(reg.name(), "AgentIdentity");
        assertEq(reg.symbol(), "AGENT");
        assertEq(reg.getVersion(), "2.0.0");
        assertTrue(reg.supportsInterface(0x01ffc9a7));
        assertTrue(reg.supportsInterface(0x80ac58cd));
        assertTrue(reg.supportsInterface(0x5b5e139f));
        assertTrue(reg.supportsInterface(0x49064906));
        assertFalse(reg.supportsInterface(0x780e9d63)); // not enumerable, like the canonical registry
        assertFalse(reg.supportsInterface(0xffffffff));
    }

    /// Every ERC-8004 function is reachable by the exact canonical signature string (the selector a
    /// client built from the ERC text would send), not only through this repo's Solidity names.
    function test_erc8004SignaturesAreServed() public {
        vm.startPrank(alice);
        (bool ok, bytes memory r) = address(reg).call(abi.encodeWithSignature("register()"));
        assertTrue(ok && abi.decode(r, (uint256)) == 0, "register()");
        (ok, r) = address(reg).call(abi.encodeWithSignature("register(string)", "ipfs://a"));
        assertTrue(ok && abi.decode(r, (uint256)) == 1, "register(string)");
        RWAllyAgentRegistry.MetadataEntry[] memory m = new RWAllyAgentRegistry.MetadataEntry[](1);
        m[0] = RWAllyAgentRegistry.MetadataEntry("k", hex"01");
        (ok, r) =
            address(reg).call(abi.encodeWithSignature("register(string,(string,bytes)[])", "ipfs://b", m));
        assertTrue(ok && abi.decode(r, (uint256)) == 2, "register(string,(string,bytes)[])");
        (ok,) = address(reg).call(abi.encodeWithSignature("setAgentURI(uint256,string)", 2, "ipfs://c"));
        assertTrue(ok, "setAgentURI");
        (ok,) =
            address(reg).call(abi.encodeWithSignature("setMetadata(uint256,string,bytes)", 2, "k", hex"02"));
        assertTrue(ok, "setMetadata");
        (ok, r) = address(reg).call(abi.encodeWithSignature("getMetadata(uint256,string)", 2, "k"));
        assertTrue(ok && keccak256(abi.decode(r, (bytes))) == keccak256(hex"02"), "getMetadata");
        (ok, r) = address(reg).call(abi.encodeWithSignature("getAgentWallet(uint256)", 2));
        assertTrue(ok && abi.decode(r, (address)) == alice, "getAgentWallet");
        (ok,) = address(reg).call(abi.encodeWithSignature("unsetAgentWallet(uint256)", 2));
        assertTrue(ok, "unsetAgentWallet");
        (ok,) = address(reg)
            .call(abi.encodeWithSignature("setAgentWallet(uint256,address,uint256,bytes)", 2, bob, 0, hex""));
        assertFalse(ok, "setAgentWallet exists and refuses an expired request");
        vm.stopPrank();
        (ok, r) = address(reg).call(abi.encodeWithSignature("isAuthorizedOrOwner(address,uint256)", alice, 2));
        assertTrue(ok && abi.decode(r, (bool)), "isAuthorizedOrOwner");
    }

    // ── registration ─────────────────────────────────────────────────────────

    function test_register_isPermissionless_idsStartAtZero() public {
        vm.prank(alice);
        assertEq(reg.register(), 0);
        vm.prank(bob);
        assertEq(reg.register("ipfs://x"), 1);
        vm.prank(alice);
        assertEq(reg.register(), 2);
        assertEq(reg.balanceOf(alice), 2);
        assertEq(reg.balanceOf(bob), 1);
        assertEq(reg.ownerOf(1), bob);
        assertEq(reg.tokenURI(0), "");
        assertEq(reg.tokenURI(1), "ipfs://x");
    }

    function test_register_setsAgentWalletToCaller_andEmits() public {
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), alice, 0);
        vm.expectEmit(true, true, false, true);
        emit Registered(0, "ipfs://a", alice);
        vm.expectEmit(true, true, false, true);
        emit MetadataSet(0, "agentWallet", "agentWallet", abi.encodePacked(alice));
        vm.prank(alice);
        reg.register("ipfs://a");
        assertEq(reg.getAgentWallet(0), alice);
        assertEq(reg.getMetadata(0, "agentWallet"), abi.encodePacked(alice));
    }

    function test_agentUriWrites_emitErc4906MetadataUpdate_likeTheReferenceRegistry() public {
        vm.recordLogs();
        vm.prank(alice);
        reg.register();
        assertEq(vm.getRecordedLogs().length, 3, "register(): Transfer, Registered, MetadataSet");

        vm.recordLogs();
        vm.prank(alice);
        reg.register("ipfs://a");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 4, "register(uri): Transfer, MetadataUpdate, Registered, MetadataSet");
        assertEq(logs[1].topics[0], MetadataUpdate.selector);

        vm.expectEmit(false, false, false, true);
        emit MetadataUpdate(1);
        vm.prank(alice);
        reg.setAgentURI(1, "ipfs://b");
    }

    function test_register_withMetadata_storesEntries_andRejectsReservedKey() public {
        RWAllyAgentRegistry.MetadataEntry[] memory m = new RWAllyAgentRegistry.MetadataEntry[](2);
        m[0] = RWAllyAgentRegistry.MetadataEntry("operatedBy", bytes("RWAlly"));
        m[1] = RWAllyAgentRegistry.MetadataEntry("tier", hex"01");
        vm.prank(alice);
        uint256 id = reg.register("ipfs://a", m);
        assertEq(reg.getMetadata(id, "operatedBy"), bytes("RWAlly"));
        assertEq(reg.getMetadata(id, "tier"), hex"01");

        m[1] = RWAllyAgentRegistry.MetadataEntry("agentWallet", abi.encodePacked(bob));
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.ReservedKey.selector);
        reg.register("ipfs://a", m);
    }

    function test_register_toReceiverContract_works_andReceiverMayReenter() public {
        GoodReceiver r = new GoodReceiver(reg);
        r.setReenter(true);
        uint256 id = r.doRegister();
        assertEq(reg.ownerOf(id), address(r));
        assertEq(reg.balanceOf(address(r)), 2, "reentrant register also minted");
        assertEq(r.received(), 2);
    }

    function test_register_toContractWithoutReceiver_reverts() public {
        NoReceiver n = new NoReceiver();
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidReceiver.selector, address(n))
        );
        n.doRegister(reg);

        BadMagicReceiver b = new BadMagicReceiver();
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidReceiver.selector, address(b))
        );
        b.doRegister(reg);
        assertEq(reg.balanceOf(address(n)), 0);
    }

    // ── ERC-721 reads and errors ─────────────────────────────────────────────

    function test_reads_revertOnNonexistentToken() public {
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721NonexistentToken.selector, 7));
        reg.ownerOf(7);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721NonexistentToken.selector, 7));
        reg.tokenURI(7);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721NonexistentToken.selector, 7));
        reg.getApproved(7);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidOwner.selector, address(0)));
        reg.balanceOf(address(0));
        assertEq(reg.balanceOf(alice), 0);
    }

    // ── transfers and approvals ──────────────────────────────────────────────

    function _alice() internal returns (uint256 id) {
        vm.prank(alice);
        id = reg.register("ipfs://a");
    }

    function test_transfer_movesToken_clearsApprovalAndAgentWallet() public {
        uint256 id = _alice();
        vm.prank(alice);
        reg.approve(carol, id);
        assertEq(reg.getApproved(id), carol);

        vm.expectEmit(true, true, true, false);
        emit Transfer(alice, bob, id);
        vm.prank(alice);
        reg.transferFrom(alice, bob, id);

        assertEq(reg.ownerOf(id), bob);
        assertEq(reg.balanceOf(alice), 0);
        assertEq(reg.balanceOf(bob), 1);
        assertEq(reg.getApproved(id), address(0), "approval cleared");
        assertEq(reg.getAgentWallet(id), address(0), "agentWallet cleared on transfer");
        // the old approved party can no longer move it
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InsufficientApproval.selector, carol, id)
        );
        reg.transferFrom(bob, carol, id);
    }

    function test_transfer_byApprovedAndByOperator() public {
        uint256 id = _alice();
        vm.prank(alice);
        reg.approve(bob, id);
        vm.prank(bob);
        reg.transferFrom(alice, carol, id);
        assertEq(reg.ownerOf(id), carol);

        vm.prank(carol);
        reg.setApprovalForAll(bob, true);
        assertTrue(reg.isApprovedForAll(carol, bob));
        vm.prank(bob);
        reg.safeTransferFrom(carol, alice, id);
        assertEq(reg.ownerOf(id), alice);
    }

    function test_transfer_rejectsStrangerWrongFromAndZeroTo() public {
        uint256 id = _alice();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InsufficientApproval.selector, bob, id)
        );
        reg.transferFrom(alice, bob, id);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721IncorrectOwner.selector, bob, id, alice)
        );
        reg.transferFrom(bob, carol, id);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidReceiver.selector, address(0))
        );
        reg.transferFrom(alice, address(0), id);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidApprover.selector, bob));
        reg.approve(bob, id);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidOperator.selector, address(0))
        );
        reg.setApprovalForAll(address(0), true);
    }

    function test_safeTransfer_toNonReceiverContract_reverts() public {
        uint256 id = _alice();
        NoReceiver n = new NoReceiver();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidReceiver.selector, address(n))
        );
        reg.safeTransferFrom(alice, address(n), id);
        assertEq(reg.ownerOf(id), alice, "reverted transfer left no trace");
    }

    // ── metadata and URI ─────────────────────────────────────────────────────

    function test_setMetadata_ownerOperatorApproved_notStranger_notReservedKey() public {
        uint256 id = _alice();
        vm.prank(alice);
        reg.setMetadata(id, "k", hex"01");
        assertEq(reg.getMetadata(id, "k"), hex"01");

        vm.prank(alice);
        reg.setApprovalForAll(bob, true);
        vm.prank(bob);
        reg.setMetadata(id, "k", hex"02");
        assertEq(reg.getMetadata(id, "k"), hex"02");

        vm.prank(alice);
        reg.approve(carol, id);
        vm.prank(carol);
        reg.setMetadata(id, "k", hex"03");

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(RWAllyAgentRegistry.NotAuthorized.selector);
        reg.setMetadata(id, "k", hex"04");

        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.ReservedKey.selector);
        reg.setMetadata(id, "agentWallet", abi.encodePacked(bob));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721NonexistentToken.selector, 99));
        reg.setMetadata(99, "k", hex"01");
    }

    function test_setAgentURI_authAndEvent() public {
        uint256 id = _alice();
        vm.expectEmit(true, true, false, true);
        emit URIUpdated(id, "ipfs://b", alice);
        vm.prank(alice);
        reg.setAgentURI(id, "ipfs://b");
        assertEq(reg.tokenURI(id), "ipfs://b");

        vm.prank(bob);
        vm.expectRevert(RWAllyAgentRegistry.NotAuthorized.selector);
        reg.setAgentURI(id, "ipfs://evil");
    }

    // ── agent wallet ─────────────────────────────────────────────────────────

    function _digest(uint256 id, address wallet, address holder, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                address(reg)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                id,
                wallet,
                holder,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function test_setAgentWallet_eoaSignature() public {
        uint256 id = _alice();
        (address w, uint256 wk) = makeAddrAndKey("wallet");
        uint256 dl = block.timestamp + 4 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wk, _digest(id, w, alice, dl));
        vm.prank(alice);
        reg.setAgentWallet(id, w, dl, abi.encodePacked(r, s, v));
        assertEq(reg.getAgentWallet(id), w);

        vm.prank(alice);
        reg.unsetAgentWallet(id);
        assertEq(reg.getAgentWallet(id), address(0));
    }

    function test_setAgentWallet_rejections() public {
        uint256 id = _alice();
        (address w, uint256 wk) = makeAddrAndKey("wallet");
        (, uint256 otherKey) = makeAddrAndKey("other");
        uint256 dl = block.timestamp + 1 minutes;
        bytes32 d = _digest(id, w, alice, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wk, d);
        bytes memory good = abi.encodePacked(r, s, v);

        // stranger
        vm.prank(bob);
        vm.expectRevert(RWAllyAgentRegistry.NotAuthorized.selector);
        reg.setAgentWallet(id, w, dl, good);

        // zero wallet
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.BadWallet.selector);
        reg.setAgentWallet(id, address(0), dl, good);

        // expired
        vm.warp(dl + 1);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.Expired.selector);
        reg.setAgentWallet(id, w, dl, good);

        // deadline too far
        uint256 far = vm.getBlockTimestamp() + 5 minutes + 1; // via-ir caches block.timestamp across vm.warp
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.DeadlineTooFar.selector);
        reg.setAgentWallet(id, w, far, good);

        // signature by the wrong key
        uint256 dl2 = vm.getBlockTimestamp() + 1 minutes;
        (v, r, s) = vm.sign(otherKey, _digest(id, w, alice, dl2));
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, w, dl2, abi.encodePacked(r, s, v));

        // malleable twin (high s) of a valid signature is refused
        (v, r, s) = vm.sign(wk, _digest(id, w, alice, dl2));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sHigh = bytes32(n - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, w, dl2, abi.encodePacked(r, sHigh, vFlip));

        // wrong length
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, w, dl2, hex"1234");

        // signature bound to the holder: a signature over another owner field fails
        (v, r, s) = vm.sign(wk, _digest(id, w, bob, dl2));
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, w, dl2, abi.encodePacked(r, s, v));
    }

    function test_setAgentWallet_erc1271Wallet() public {
        uint256 id = _alice();
        Wallet1271 w = new Wallet1271();
        uint256 dl = block.timestamp + 1 minutes;
        bytes memory sig = hex"aabbcc";
        w.allow(_digest(id, address(w), alice, dl), sig);
        vm.prank(alice);
        reg.setAgentWallet(id, address(w), dl, sig);
        assertEq(reg.getAgentWallet(id), address(w));

        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, address(w), dl, hex"aabbcd");
    }

    // ── owner powers: exactly three, nothing else ────────────────────────────

    function test_revoke_burnsOneIdentity_idNeverReissued() public {
        uint256 id = _alice();
        vm.prank(alice);
        reg.approve(bob, id);
        vm.prank(alice);
        uint256 id2 = reg.register();

        vm.expectEmit(true, true, true, false);
        emit Transfer(alice, address(0), id);
        vm.expectEmit(true, true, false, false);
        emit Revoked(id, alice);
        vm.prank(multisig);
        reg.revoke(id);

        assertEq(reg.balanceOf(alice), 1);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721NonexistentToken.selector, id));
        reg.ownerOf(id);
        assertEq(reg.getAgentWallet(id), address(0));
        assertEq(reg.ownerOf(id2), alice, "other identities untouched");

        vm.prank(bob);
        uint256 next = reg.register();
        assertEq(next, 2, "revoked id 0 is not reissued");

        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721NonexistentToken.selector, id));
        reg.revoke(id);
    }

    function test_revoke_onlyOwner_notEvenTheHolder() public {
        uint256 id = _alice();
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.revoke(id);
        vm.prank(bob);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.revoke(id);
        assertEq(reg.balanceOf(alice), 1);
    }

    /// The owner address, acting as the owner, cannot reach another holder's identity data or move it.
    function test_owner_hasNoPowerOverHoldersIdentities() public {
        uint256 id = _alice();
        vm.startPrank(multisig);
        vm.expectRevert(RWAllyAgentRegistry.NotAuthorized.selector);
        reg.setAgentURI(id, "ipfs://evil");
        vm.expectRevert(RWAllyAgentRegistry.NotAuthorized.selector);
        reg.setMetadata(id, "k", hex"01");
        vm.expectRevert(RWAllyAgentRegistry.NotAuthorized.selector);
        reg.unsetAgentWallet(id);
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InsufficientApproval.selector, multisig, id)
        );
        reg.transferFrom(alice, multisig, id);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidApprover.selector, multisig));
        reg.approve(multisig, id);
        vm.stopPrank();
        assertEq(reg.ownerOf(id), alice);
        assertEq(reg.tokenURI(id), "ipfs://a");
    }

    function test_ownership_twoStep() public {
        address next = makeAddr("next");
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferStarted(multisig, next);
        vm.prank(multisig);
        reg.transferOwnership(next);
        assertEq(reg.owner(), multisig, "not yet");
        assertEq(reg.pendingOwner(), next);

        vm.prank(bob);
        vm.expectRevert(RWAllyAgentRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();

        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(multisig, next);
        vm.prank(next);
        reg.acceptOwnership();
        assertEq(reg.owner(), next);
        assertEq(reg.pendingOwner(), address(0));

        vm.prank(multisig);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.transferOwnership(multisig);
    }

    function test_ownership_nominationCanBeReplacedOrCleared() public {
        address n1 = makeAddr("n1");
        address n2 = makeAddr("n2");
        vm.startPrank(multisig);
        reg.transferOwnership(n1);
        reg.transferOwnership(n2);
        vm.stopPrank();
        vm.prank(n1);
        vm.expectRevert(RWAllyAgentRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();
        vm.prank(multisig);
        reg.transferOwnership(address(0));
        vm.prank(n2);
        vm.expectRevert(RWAllyAgentRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();
    }

    function test_renounce_endsRevocationForever() public {
        uint256 id = _alice();
        vm.prank(multisig);
        reg.transferOwnership(bob);
        vm.prank(multisig);
        reg.renounceOwnership();
        assertEq(reg.owner(), address(0));
        assertEq(reg.pendingOwner(), address(0));

        vm.prank(bob);
        vm.expectRevert(RWAllyAgentRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();
        vm.prank(multisig);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.revoke(id);
        assertEq(reg.ownerOf(id), alice);
    }

    // ── fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_balancesTrackRegistrationsTransfersAndRevokes(uint8 nRegs, uint8 revokeMask) public {
        uint256 n = bound(nRegs, 1, 12);
        for (uint256 i; i < n; ++i) {
            vm.prank(i % 2 == 0 ? alice : bob);
            reg.register();
        }
        uint256 a = reg.balanceOf(alice);
        uint256 b = reg.balanceOf(bob);
        assertEq(a + b, n);
        for (uint256 i; i < n; ++i) {
            if ((revokeMask >> (i % 8)) & 1 == 1) {
                address holder = reg.ownerOf(i);
                uint256 before = reg.balanceOf(holder);
                vm.prank(multisig);
                reg.revoke(i);
                assertEq(reg.balanceOf(holder), before - 1);
            }
        }
    }
}
