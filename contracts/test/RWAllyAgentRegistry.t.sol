// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {RWAllyAgentRegistry, IERC721Receiver} from "../src/RWAllyAgentRegistry.sol";
import {PROTOCOL_INITIALIZER} from "../src/lib/ProtocolInitializer.sol";
import {MockERC20} from "./mocks/Mocks.sol";

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

/// An ERC-6492-style account factory: CREATE2-deploys a Wallet1271 and arms it with one signature.
contract Factory6492 {
    uint256 public calls;

    function predict(bytes32 salt) external view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff), address(this), salt, keccak256(type(Wallet1271).creationCode)
                        )
                    )
                )
            )
        );
    }

    function deploy(bytes32 salt, bytes32 d, bytes calldata s) external {
        ++calls;
        Wallet1271 w = new Wallet1271{salt: salt}();
        w.allow(d, s);
    }

    function noop() external {
        ++calls;
    }
}

contract RWAllyAgentRegistryTest is Test {
    RWAllyAgentRegistry reg;
    MockERC20 usdc;
    address multisig = makeAddr("multisig");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed k, string metadataKey, bytes metadataValue);
    event MetadataUpdate(uint256 _tokenId);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    /// Fee 0 and no import window: this suite covers the ERC-8004 surface and ownership. The fee, the
    /// import window, initialization and CREATE2 have their own suites below.
    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new RWAllyAgentRegistry();
        usdc = new MockERC20("USDC", 6);
        vm.prank(reg.INITIALIZER());
        reg.initialize(multisig, address(usdc), treasury, 0, address(0), 0);
    }

    // ── metadata ─────────────────────────────────────────────────────────────

    function test_identityStrings() public view {
        assertEq(reg.name(), "AgentIdentity");
        assertEq(reg.symbol(), "AGENT");
        assertEq(reg.getVersion(), "2.0.0");
        assertTrue(reg.supportsInterface(0x01ffc9a7));
        assertTrue(reg.supportsInterface(0x80ac58cd));
        assertTrue(reg.supportsInterface(0x5b5e139f));
        assertTrue(reg.supportsInterface(0x49064906));
        assertTrue(reg.supportsInterface(0xb45a3c0e)); // ERC-5192
        assertEq(bytes4(keccak256("locked(uint256)")), bytes4(0xb45a3c0e), "the ERC-5192 interface id");
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
        assertEq(vm.getRecordedLogs().length, 4, "register(): Transfer, Locked, Registered, MetadataSet");

        vm.recordLogs();
        vm.prank(alice);
        reg.register("ipfs://a");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 5, "register(uri): Transfer, Locked, MetadataUpdate, Registered, MetadataSet");
        assertEq(logs[1].topics[0], Locked.selector);
        assertEq(logs[2].topics[0], MetadataUpdate.selector);

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
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721NonexistentToken.selector, 7));
        reg.locked(7);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidOwner.selector, address(0)));
        reg.balanceOf(address(0));
        assertEq(reg.balanceOf(alice), 0);
    }

    // ── soulbound (ERC-5192): no transfer, no approval ───────────────────────

    function _alice() internal returns (uint256 id) {
        vm.prank(alice);
        id = reg.register("ipfs://a");
    }

    function _assertSoulbound(address caller, bytes memory data, string memory what) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(reg).call(data);
        assertFalse(ok, what);
        assertEq(ret.length, 4, what);
        assertEq(bytes4(ret), RWAllyAgentRegistry.Soulbound.selector, what);
    }

    /// Every transfer and approval entry point reverts with Soulbound, for the holder, for a stranger,
    /// for the owner address, for a zero destination and for an id that does not exist.
    function test_soulbound_everyTransferAndApprovalEntryPointReverts() public {
        uint256 id = _alice();
        address[3] memory callers = [alice, bob, multisig];
        uint256[2] memory ids = [id, 99];
        for (uint256 c; c < callers.length; ++c) {
            for (uint256 k; k < ids.length; ++k) {
                address who = callers[c];
                uint256 t = ids[k];
                _assertSoulbound(
                    who,
                    abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, bob, t),
                    "transferFrom"
                );
                _assertSoulbound(
                    who,
                    abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, address(0), t),
                    "transferFrom to zero"
                );
                _assertSoulbound(
                    who,
                    abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", alice, bob, t),
                    "safeTransferFrom"
                );
                _assertSoulbound(
                    who,
                    abi.encodeWithSignature(
                        "safeTransferFrom(address,address,uint256,bytes)", alice, bob, t, hex"01"
                    ),
                    "safeTransferFrom with data"
                );
                _assertSoulbound(who, abi.encodeWithSignature("approve(address,uint256)", bob, t), "approve");
                _assertSoulbound(
                    who, abi.encodeWithSignature("approve(address,uint256)", address(0), t), "approve zero"
                );
            }
            _assertSoulbound(
                callers[c],
                abi.encodeWithSignature("setApprovalForAll(address,bool)", bob, true),
                "setApprovalForAll true"
            );
            _assertSoulbound(
                callers[c],
                abi.encodeWithSignature("setApprovalForAll(address,bool)", bob, false),
                "setApprovalForAll false"
            );
            _assertSoulbound(
                callers[c],
                abi.encodeWithSignature("setApprovalForAll(address,bool)", address(0), true),
                "setApprovalForAll zero"
            );
        }
        // A transfer to a contract that cannot receive still fails with Soulbound, not a receiver error.
        NoReceiver n = new NoReceiver();
        _assertSoulbound(
            alice,
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", alice, address(n), id),
            "safeTransferFrom to a non-receiver"
        );
        // Nothing moved.
        assertEq(reg.ownerOf(id), alice);
        assertEq(reg.balanceOf(alice), 1);
        assertEq(reg.balanceOf(bob), 0);
    }

    function test_soulbound_noApprovalExists() public {
        uint256 id = _alice();
        assertEq(reg.getApproved(id), address(0));
        assertFalse(reg.isApprovedForAll(alice, bob));
        assertFalse(reg.isApprovedForAll(alice, address(0)));
        assertFalse(reg.isApprovedForAll(address(0), address(0)));
        // A refused approval leaves no trace.
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        reg.approve(bob, id);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        reg.setApprovalForAll(bob, true);
        assertEq(reg.getApproved(id), address(0));
        assertFalse(reg.isApprovedForAll(alice, bob));
        // A would-be operator still cannot write the identity.
        vm.prank(bob);
        vm.expectRevert(RWAllyAgentRegistry.NotAuthorized.selector);
        reg.setMetadata(id, "k", hex"01");
    }

    /// ERC-5192: locked is true for every minted id, from every way of minting, and reverts for an
    /// id that does not exist, as ownerOf does.
    function test_locked_trueForEveryMintedId_revertsOtherwise() public {
        vm.startPrank(alice);
        uint256 a = reg.register();
        uint256 b = reg.register("ipfs://b");
        RWAllyAgentRegistry.MetadataEntry[] memory m = new RWAllyAgentRegistry.MetadataEntry[](0);
        uint256 c = reg.register("ipfs://c", m);
        vm.stopPrank();
        assertTrue(reg.locked(a));
        assertTrue(reg.locked(b));
        assertTrue(reg.locked(c));
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721NonexistentToken.selector, c + 1));
        reg.locked(c + 1);
    }

    function test_locked_eventEmittedAtEveryRegister() public {
        vm.startPrank(alice);
        vm.expectEmit(false, false, false, true, address(reg));
        emit Locked(0);
        reg.register();
        vm.expectEmit(false, false, false, true, address(reg));
        emit Locked(1);
        reg.register("ipfs://b");
        vm.expectEmit(false, false, false, true, address(reg));
        emit Locked(2);
        reg.register("ipfs://c", new RWAllyAgentRegistry.MetadataEntry[](0));
        vm.stopPrank();
    }

    /// One wallet may hold many identities, and each one is its own.
    function test_oneWalletMayHoldManyIdentities() public {
        uint256 n = 20;
        for (uint256 i; i < n; ++i) {
            vm.prank(alice);
            assertEq(reg.register(), i);
        }
        assertEq(reg.balanceOf(alice), n);
        for (uint256 i; i < n; ++i) {
            assertEq(reg.ownerOf(i), alice);
            assertTrue(reg.locked(i));
            assertEq(reg.getAgentWallet(i), alice);
        }
        // Identities are independent: writing one touches no other.
        vm.prank(alice);
        reg.setAgentURI(7, "ipfs://seven");
        assertEq(reg.tokenURI(7), "ipfs://seven");
        assertEq(reg.tokenURI(8), "");
    }

    // ── metadata and URI ─────────────────────────────────────────────────────

    function test_setMetadata_holderOnly_notStranger_notReservedKey() public {
        uint256 id = _alice();
        vm.prank(alice);
        reg.setMetadata(id, "k", hex"01");
        assertEq(reg.getMetadata(id, "k"), hex"01");

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
        uint256 far = vm.getBlockTimestamp() + 1 hours + 1; // via-ir caches block.timestamp across vm.warp
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

    /// The consent deadline may sit a full hour ahead (a bundler mempool wait) and no further.
    function test_setAgentWallet_deadlineCapIsOneHour() public {
        uint256 id = _alice();
        (address w, uint256 wk) = makeAddrAndKey("wallet");
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wk, _digest(id, w, alice, dl));
        vm.prank(alice);
        reg.setAgentWallet(id, w, dl, abi.encodePacked(r, s, v));
        assertEq(reg.getAgentWallet(id), w);

        uint256 far = block.timestamp + 1 hours + 1;
        (v, r, s) = vm.sign(wk, _digest(id, w, alice, far));
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.DeadlineTooFar.selector);
        reg.setAgentWallet(id, w, far, abi.encodePacked(r, s, v));
    }

    // ── agent wallet: ERC-6492 (counterfactual smart account) ────────────────

    bytes32 private constant SUFFIX_6492 = 0x6492649264926492649264926492649264926492649264926492649264926492;

    function _wrap6492(address factory, bytes memory factoryCalldata, bytes memory inner)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(abi.encode(factory, factoryCalldata, inner), SUFFIX_6492);
    }

    function _cfSetup(bytes32 salt)
        internal
        returns (Factory6492 f, address wallet, uint256 id, uint256 dl, bytes32 d)
    {
        f = new Factory6492();
        wallet = f.predict(salt);
        id = _alice();
        dl = block.timestamp + 30 minutes;
        d = _digest(id, wallet, alice, dl);
    }

    function test_setAgentWallet_erc6492_deploysTheCounterfactualAccount_thenChecksTheInnerSignature()
        public
    {
        bytes32 salt = keccak256("cf");
        (Factory6492 f, address wallet, uint256 id, uint256 dl, bytes32 d) = _cfSetup(salt);
        bytes memory inner = hex"aabbcc";
        assertEq(wallet.code.length, 0, "not deployed yet");
        bytes memory sig = _wrap6492(address(f), abi.encodeCall(Factory6492.deploy, (salt, d, inner)), inner);
        vm.prank(alice);
        reg.setAgentWallet(id, wallet, dl, sig);
        assertGt(wallet.code.length, 0, "the factory call ran");
        assertEq(reg.getAgentWallet(id), wallet);
    }

    function test_setAgentWallet_erc6492_badInnerSignature_reverts() public {
        bytes32 salt = keccak256("cf");
        (Factory6492 f, address wallet, uint256 id, uint256 dl, bytes32 d) = _cfSetup(salt);
        bytes memory sig =
            _wrap6492(address(f), abi.encodeCall(Factory6492.deploy, (salt, d, hex"aabbcc")), hex"aabbcd");
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, wallet, dl, sig);
        assertEq(reg.getAgentWallet(id), alice, "unchanged");
    }

    function test_setAgentWallet_erc6492_factoryThatDeploysNothing_reverts() public {
        bytes32 salt = keccak256("cf");
        (Factory6492 f, address wallet, uint256 id, uint256 dl,) = _cfSetup(salt);
        bytes memory sig = _wrap6492(address(f), abi.encodeCall(Factory6492.noop, ()), hex"aabbcc");
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, wallet, dl, sig);
    }

    /// An already-deployed account: the factory is not called, only the inner signature counts.
    function test_setAgentWallet_erc6492_deployedAccount_skipsTheFactory() public {
        uint256 id = _alice();
        Wallet1271 w = new Wallet1271();
        uint256 dl = block.timestamp + 1 minutes;
        bytes memory inner = hex"aabbcc";
        w.allow(_digest(id, address(w), alice, dl), inner);
        Factory6492 f = new Factory6492();
        bytes memory sig =
            _wrap6492(address(f), abi.encodeCall(Factory6492.deploy, (bytes32(0), 0, "")), inner);
        vm.prank(alice);
        reg.setAgentWallet(id, address(w), dl, sig);
        assertEq(reg.getAgentWallet(id), address(w));
        assertEq(f.calls(), 0, "factory untouched");
    }

    /// The factory call is made by the registry, so it may not be the fee token or the registry itself.
    /// This test does NOT tell the guard apart from its absence: `undeployed` has no code, so the code
    /// check after the call would revert either way. The guard is exercised by
    /// `RWAllyAgentRegistryHookFeeTokenTest`, whose fee token deploys the wallet from its transfer hook.
    function test_setAgentWallet_erc6492_factoryMayNotBeTheFeeTokenOrTheRegistry() public {
        uint256 id = _alice();
        usdc.mint(bob, 100e6);
        vm.prank(bob);
        usdc.approve(address(reg), type(uint256).max);
        address target = makeAddr("undeployed");
        uint256 dl = block.timestamp + 1 minutes;

        bytes memory steal =
            abi.encodeWithSignature("transferFrom(address,address,uint256)", bob, alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, target, dl, _wrap6492(address(usdc), steal, hex"aabbcc"));
        assertEq(usdc.balanceOf(bob), 100e6, "allowance not spent");

        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, target, dl, _wrap6492(address(reg), hex"", hex"aabbcc"));
    }

    // ── owner powers: exactly four, nothing over any identity ────────────────

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
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        reg.transferFrom(alice, multisig, id);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        reg.approve(multisig, id);
        vm.stopPrank();
        assertEq(reg.ownerOf(id), alice);
        assertEq(reg.tokenURI(id), "ipfs://a");
    }

    /// Only the holder is authorized. The zero address, which is what getApproved returns, is never
    /// authorized, and no approval or operator can change that.
    function test_isAuthorizedOrOwner_holderOnly_zeroAddressIsNeverAuthorized() public {
        uint256 id = _alice();
        assertEq(reg.getApproved(id), address(0));
        assertFalse(reg.isAuthorizedOrOwner(address(0), id), "address(0) must not read as authorized");
        assertTrue(reg.isAuthorizedOrOwner(alice, id));
        assertFalse(reg.isAuthorizedOrOwner(bob, id));
        assertFalse(reg.isAuthorizedOrOwner(multisig, id), "the owner address is not the holder");
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        reg.approve(bob, id);
        assertFalse(reg.isAuthorizedOrOwner(bob, id));
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        reg.setApprovalForAll(carol, true);
        assertFalse(reg.isAuthorizedOrOwner(carol, id));
        // A nonexistent id still reverts rather than answering false.
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ERC721NonexistentToken.selector, 99));
        reg.isAuthorizedOrOwner(address(0), 99);
    }

    /// There is no function on the registry that removes an identity: the old `revoke` selector is
    /// gone, and so is every other selector that could burn a token.
    function test_noRemovalFunctionExists() public {
        uint256 id = _alice();
        bytes[3] memory attempts = [
            abi.encodeWithSignature("revoke(uint256)", id),
            abi.encodeWithSignature("burn(uint256)", id),
            abi.encodeWithSignature("remove(uint256)", id)
        ];
        for (uint256 i; i < attempts.length; ++i) {
            vm.prank(multisig);
            (bool ok,) = address(reg).call(attempts[i]);
            assertFalse(ok);
        }
        assertEq(reg.ownerOf(id), alice);
        assertEq(reg.balanceOf(alice), 1);
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

    function test_ownerFunctionsRefuseEveryoneElse() public {
        vm.startPrank(alice);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.setFee(1);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.setTreasury(alice);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.transferOwnership(alice);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.renounceOwnership();
        vm.stopPrank();
    }

    // ── EIP-712 domain follows the live chain id ─────────────────────────────

    function _digestFor(uint256 chainId, uint256 id, address wallet, address holder, uint256 deadline)
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
                chainId,
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

    function test_domainSeparator_followsTheLiveChainId() public {
        vm.chainId(5042);
        bytes32 arc = reg.domainSeparator();
        vm.chainId(8453);
        bytes32 base = reg.domainSeparator();
        assertTrue(arc != base, "two chain ids, two separators");
        vm.chainId(5042);
        assertEq(reg.domainSeparator(), arc, "and back again");
        assertEq(
            arc,
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256("ERC8004IdentityRegistry"),
                    keccak256("1"),
                    uint256(5042),
                    address(reg)
                )
            )
        );
    }

    /// A wallet signature made for one chain is refused on another and accepted on its own.
    function test_agentWalletSignature_doesNotReplayAcrossChains() public {
        uint256 id = _alice();
        (address w, uint256 wk) = makeAddrAndKey("wallet");
        uint256 dl = vm.getBlockTimestamp() + 4 minutes;

        vm.chainId(5042);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wk, _digestFor(5042, id, w, alice, dl));
        bytes memory sigForArc = abi.encodePacked(r, s, v);

        vm.chainId(8453);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, w, dl, sigForArc);

        vm.chainId(5042);
        vm.prank(alice);
        reg.setAgentWallet(id, w, dl, sigForArc);
        assertEq(reg.getAgentWallet(id), w);

        // and the other way round
        vm.prank(alice);
        reg.unsetAgentWallet(id);
        vm.chainId(8453);
        (v, r, s) = vm.sign(wk, _digestFor(8453, id, w, alice, dl));
        vm.chainId(5042);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, w, dl, abi.encodePacked(r, s, v));
    }
}

// ───────────────────────────── test doubles ──────────────────────────────

/// An outside ERC-8004 registry: `ownerOf` answers from a table; `getAgentWallet` and `getApproved`
/// answer with other addresses so a test can prove only `ownerOf` counts.
contract OutsideRegistryMock {
    mapping(uint256 => address) public owners;
    mapping(uint256 => address) public wallets;
    mapping(uint256 => address) public approvals;
    uint256 public ownerOfCalls;

    function set(uint256 id, address owner_, address wallet_, address approved_) external {
        owners[id] = owner_;
        wallets[id] = wallet_;
        approvals[id] = approved_;
    }

    function ownerOf(uint256 id) external view returns (address) {
        address o = owners[id];
        require(o != address(0), "nonexistent");
        return o;
    }

    function getAgentWallet(uint256 id) external view returns (address) {
        return wallets[id];
    }

    function getApproved(uint256 id) external view returns (address) {
        return approvals[id];
    }
}

/// An outside registry that misbehaves in a chosen way on every call.
contract HostileOutside {
    enum Mode {
        Revert,
        Revert32,
        Empty,
        Short,
        Long,
        Burn,
        DirtyWord
    }

    Mode public mode;
    address public victim;

    constructor(Mode m, address victim_) {
        mode = m;
        victim = victim_;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        Mode m = mode;
        if (m == Mode.Revert) revert("hostile");
        if (m == Mode.Revert32) {
            address v = victim;
            assembly {
                mstore(0, v)
                revert(0, 32)
            }
        }
        if (m == Mode.Burn) {
            assembly {
                for {} 1 {} {}
            }
        }
        if (m == Mode.Short) return abi.encodePacked(bytes1(0x01));
        if (m == Mode.Long) return abi.encode(victim, victim);
        if (m == Mode.DirtyWord) return abi.encode(uint256(uint160(victim)) | (uint256(1) << 200));
        return ""; // Empty
    }
}

/// A fee token with settable transferFrom behaviour. Balances and allowances are real.
contract ShapedToken {
    enum Shape {
        ReturnsTrue,
        ReturnsFalse,
        ReturnsNothing,
        ReturnsTwo,
        ReturnsShort
    }

    uint8 public decimals = 6;
    Shape public shape;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public calls;

    function setShape(Shape s) external {
        shape = s;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        require(bytes4(data[0:4]) == 0x23b872dd, "only transferFrom");
        calls++;
        (address from, address to, uint256 amount) = abi.decode(data[4:], (address, address, uint256));
        Shape s = shape;
        if (s != Shape.ReturnsFalse) {
            require(allowance[from][msg.sender] >= amount && balanceOf[from] >= amount, "no funds");
            allowance[from][msg.sender] -= amount;
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        if (s == Shape.ReturnsFalse) return abi.encode(false);
        if (s == Shape.ReturnsNothing) return "";
        if (s == Shape.ReturnsTwo) return abi.encode(uint256(2));
        if (s == Shape.ReturnsShort) return abi.encodePacked(bytes1(0x01));
        return abi.encode(true);
    }
}

/// A USDC-shaped fee token with a blocklist: `transferFrom` reverts when the sender, the recipient or
/// the caller is blocked, as Circle's USDC does. Balances and allowances are real.
contract BlocklistToken {
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlocklisted;

    function setBlocked(address who, bool blocked) external {
        isBlocklisted[who] = blocked;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(
            !isBlocklisted[msg.sender] && !isBlocklisted[from] && !isBlocklisted[to], "Blocklistable: blocked"
        );
        require(allowance[from][msg.sender] >= amount && balanceOf[from] >= amount, "no funds");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// A token whose `decimals()` reverts.
contract NoDecimalsToken {
    function decimals() external pure returns (uint8) {
        revert("none");
    }
}

abstract contract RegistryTestBase is Test {
    uint256 constant USDC_1 = 1e6;

    address multisig = makeAddr("multisig");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function _fresh(address token, uint256 fee_, address outside, uint256 ceiling)
        internal
        returns (RWAllyAgentRegistry r)
    {
        r = new RWAllyAgentRegistry();
        vm.prank(r.INITIALIZER());
        r.initialize(multisig, token, treasury, fee_, outside, ceiling);
    }

    function _fund(MockERC20 t, RWAllyAgentRegistry r, address who, uint256 amount) internal {
        t.mint(who, amount);
        vm.prank(who);
        t.approve(address(r), type(uint256).max);
    }
}

// ───────────────────────────── initialization ────────────────────────────

contract RWAllyAgentRegistryInitTest is RegistryTestBase {
    event Initialized(
        address indexed owner,
        address indexed feeToken,
        address indexed treasury,
        uint256 fee,
        address outsideRegistry,
        uint256 importIdCeiling,
        uint256 importEnd
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    RWAllyAgentRegistry reg;
    MockERC20 usdc;
    OutsideRegistryMock outside;
    address initializer;

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new RWAllyAgentRegistry();
        usdc = new MockERC20("USDC", 6);
        outside = new OutsideRegistryMock();
        initializer = reg.INITIALIZER();
    }

    function test_initializerIsTheDeclaredConstant() public view {
        assertEq(initializer, 0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35);
        assertFalse(reg.initialized());
        assertEq(reg.owner(), address(0), "nobody holds a power before initialization");
    }

    function test_registerBeforeInit_reverts_allOverloads() public {
        RWAllyAgentRegistry.MetadataEntry[] memory m = new RWAllyAgentRegistry.MetadataEntry[](0);
        vm.startPrank(alice);
        vm.expectRevert(RWAllyAgentRegistry.NotInitialized.selector);
        reg.register();
        vm.expectRevert(RWAllyAgentRegistry.NotInitialized.selector);
        reg.register("ipfs://a");
        vm.expectRevert(RWAllyAgentRegistry.NotInitialized.selector);
        reg.register("ipfs://a", m);
        vm.expectRevert(RWAllyAgentRegistry.NotInitialized.selector);
        reg.importAgent(0, "ipfs://a");
        vm.stopPrank();
        assertEq(reg.balanceOf(alice), 0);
    }

    function test_ownerPowersAreDeadBeforeInit() public {
        address[3] memory who = [alice, initializer, multisig];
        for (uint256 i; i < who.length; ++i) {
            vm.startPrank(who[i]);
            vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
            reg.setFee(1);
            vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
            reg.setTreasury(alice);
            vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
            reg.renounceOwnership();
            vm.stopPrank();
        }
    }

    function test_initialize_wrongSender_reverts() public {
        address[3] memory wrong = [alice, multisig, address(this)];
        for (uint256 i; i < wrong.length; ++i) {
            vm.prank(wrong[i]);
            vm.expectRevert(RWAllyAgentRegistry.NotInitializer.selector);
            reg.initialize(multisig, address(usdc), treasury, USDC_1, address(0), 0);
        }
        assertFalse(reg.initialized());
    }

    function test_initialize_twice_reverts_evenForTheInitializer() public {
        vm.startPrank(initializer);
        reg.initialize(multisig, address(usdc), treasury, USDC_1, address(0), 0);
        vm.expectRevert(RWAllyAgentRegistry.AlreadyInitialized.selector);
        reg.initialize(bob, address(usdc), bob, 0, address(0), 0);
        vm.stopPrank();
        assertEq(reg.owner(), multisig, "the second call changed nothing");
        assertEq(reg.treasury(), treasury);
        assertEq(reg.fee(), USDC_1);
    }

    function test_initialize_setsStateAndEmits_withImportWindow() public {
        outside.set(0, alice, alice, alice);
        uint256 end = block.timestamp + 30 days;
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(address(0), multisig);
        vm.expectEmit(true, true, true, true);
        emit Initialized(multisig, address(usdc), treasury, USDC_1, address(outside), 2535, end);
        vm.prank(initializer);
        reg.initialize(multisig, address(usdc), treasury, USDC_1, address(outside), 2535);

        assertTrue(reg.initialized());
        assertEq(reg.owner(), multisig);
        assertEq(reg.feeToken(), address(usdc));
        assertEq(reg.treasury(), treasury);
        assertEq(reg.fee(), USDC_1);
        assertEq(reg.outsideRegistry(), address(outside));
        assertEq(reg.importIdCeiling(), 2535);
        assertEq(reg.importEnd(), end);
        assertEq(reg.IMPORT_WINDOW(), 30 days);
    }

    function test_initialize_withoutOutsideRegistry_hasNoWindow() public {
        vm.prank(initializer);
        reg.initialize(multisig, address(usdc), treasury, 0, address(0), 0);
        assertEq(reg.importEnd(), 0);
        assertEq(reg.outsideRegistry(), address(0));
    }

    function test_initialize_feeAboveCap_reverts_atCapPasses() public {
        uint256 cap = reg.MAX_FEE();
        assertEq(cap, 100_000_000, "100 USDC");
        vm.prank(initializer);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.FeeTooHigh.selector, cap + 1));
        reg.initialize(multisig, address(usdc), treasury, cap + 1, address(0), 0);
        assertFalse(reg.initialized(), "a refused initialize leaves it open");

        vm.prank(initializer);
        reg.initialize(multisig, address(usdc), treasury, cap, address(0), 0);
        assertEq(reg.fee(), cap);
    }

    function test_initialize_feeTokenDecimalsMustBeSix() public {
        MockERC20 eighteen = new MockERC20("DAI", 18);
        MockERC20 zero = new MockERC20("Z", 0);
        MockERC20 seven = new MockERC20("S", 7);
        MockERC20[3] memory bad = [eighteen, zero, seven];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(initializer);
            vm.expectRevert(RWAllyAgentRegistry.BadFeeToken.selector);
            reg.initialize(multisig, address(bad[i]), treasury, 0, address(0), 0);
        }
        assertFalse(reg.initialized());
    }

    function test_initialize_feeTokenMustBeAContractThatAnswersDecimals() public {
        address broken = address(new NoDecimalsToken());
        vm.startPrank(initializer);
        vm.expectRevert(RWAllyAgentRegistry.BadFeeToken.selector);
        reg.initialize(multisig, address(0), treasury, 0, address(0), 0);
        vm.expectRevert(RWAllyAgentRegistry.BadFeeToken.selector);
        reg.initialize(multisig, alice, treasury, 0, address(0), 0); // an EOA
        vm.expectRevert(); // decimals() reverts
        reg.initialize(multisig, broken, treasury, 0, address(0), 0);
        vm.stopPrank();
        assertFalse(reg.initialized());
    }

    function test_initialize_zeroOwnerZeroTreasuryAndSelfTreasury_revert() public {
        vm.startPrank(initializer);
        vm.expectRevert(RWAllyAgentRegistry.ZeroOwner.selector);
        reg.initialize(address(0), address(usdc), treasury, 0, address(0), 0);
        vm.expectRevert(RWAllyAgentRegistry.BadTreasury.selector);
        reg.initialize(multisig, address(usdc), address(0), 0, address(0), 0);
        vm.expectRevert(RWAllyAgentRegistry.BadTreasury.selector);
        reg.initialize(multisig, address(usdc), address(reg), 0, address(0), 0);
        vm.stopPrank();
        assertFalse(reg.initialized());
    }

    function test_initialize_outsideRegistryMustHaveCode_andCeilingNeedsOne() public {
        vm.startPrank(initializer);
        vm.expectRevert(RWAllyAgentRegistry.BadOutsideRegistry.selector);
        reg.initialize(multisig, address(usdc), treasury, 0, alice, 10); // an EOA
        vm.expectRevert(RWAllyAgentRegistry.BadOutsideRegistry.selector);
        reg.initialize(multisig, address(usdc), treasury, 0, address(0), 10); // ceiling with no registry
        vm.stopPrank();
        assertFalse(reg.initialized());
    }
}

// ───────────────────────────── the registration fee ──────────────────────

contract RWAllyAgentRegistryFeeTest is RegistryTestBase {
    event FeeChanged(uint256 oldFee, uint256 newFee);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);

    RWAllyAgentRegistry reg;
    MockERC20 usdc;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockERC20("USDC", 6);
        reg = _fresh(address(usdc), USDC_1, address(0), 0);
        _fund(usdc, reg, alice, 100 * USDC_1);
    }

    function test_register_pullsTheFeeStraightToTheTreasury_allOverloads() public {
        RWAllyAgentRegistry.MetadataEntry[] memory m = new RWAllyAgentRegistry.MetadataEntry[](1);
        m[0] = RWAllyAgentRegistry.MetadataEntry("k", hex"01");
        vm.startPrank(alice);
        reg.register();
        assertEq(usdc.balanceOf(treasury), USDC_1);
        reg.register("ipfs://a");
        assertEq(usdc.balanceOf(treasury), 2 * USDC_1);
        reg.register("ipfs://b", m);
        vm.stopPrank();
        assertEq(usdc.balanceOf(treasury), 3 * USDC_1);
        assertEq(usdc.balanceOf(alice), 97 * USDC_1);
        assertEq(usdc.balanceOf(address(reg)), 0, "no fee stays in the registry after paid registrations");
        assertEq(reg.balanceOf(alice), 3);
    }

    function test_register_withoutAllowance_orBalance_revertsAndMintsNothing() public {
        vm.prank(bob); // no balance, no allowance
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        reg.register();
        _fund(usdc, reg, bob, USDC_1 - 1);
        vm.prank(bob);
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        reg.register("ipfs://x");
        assertEq(reg.balanceOf(bob), 0);
        // The next id was not consumed by the failed attempts.
        vm.prank(alice);
        assertEq(reg.register(), 0);
    }

    function test_register_feeZero_skipsTheTokenCallEntirely() public {
        RWAllyAgentRegistry free = _fresh(address(usdc), 0, address(0), 0);
        vm.expectCall(address(usdc), abi.encodeWithSelector(usdc.transferFrom.selector), 0);
        vm.prank(bob); // holds nothing, approved nothing
        uint256 id = free.register();
        assertEq(id, 0);
        assertEq(free.balanceOf(bob), 1);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_register_isNotPayable_andTheRegistryHasNoReceive() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(reg).call{value: 1}(abi.encodeWithSignature("register()"));
        assertFalse(ok, "register is not payable");
        vm.prank(alice);
        (ok,) = address(reg).call{value: 1}("");
        assertFalse(ok, "no receive or fallback");
        assertEq(address(reg).balance, 0);
    }

    // ── fee token shapes ──────────────────────────────────────────────────

    function _shaped(ShapedToken.Shape s) internal returns (RWAllyAgentRegistry r, ShapedToken t) {
        t = new ShapedToken();
        t.setShape(s);
        r = _fresh(address(t), USDC_1, address(0), 0);
        t.mint(alice, 10 * USDC_1);
        vm.prank(alice);
        t.approve(address(r), type(uint256).max);
    }

    function test_transferFromReturningFalse_isRefused() public {
        (RWAllyAgentRegistry r, ShapedToken t) = _shaped(ShapedToken.Shape.ReturnsFalse);
        vm.expectCall(address(t), abi.encodeWithSelector(0x23b872dd, alice, treasury, USDC_1));
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        r.register();
        assertEq(r.balanceOf(alice), 0, "no identity without a fee");
    }

    function test_transferFromReturningTwoOrShortData_isRefused() public {
        (RWAllyAgentRegistry r,) = _shaped(ShapedToken.Shape.ReturnsTwo);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        r.register();
        (r,) = _shaped(ShapedToken.Shape.ReturnsShort);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        r.register();
    }

    function test_transferFromReturningNothing_isAccepted_whenItSucceeded() public {
        (RWAllyAgentRegistry r, ShapedToken t) = _shaped(ShapedToken.Shape.ReturnsNothing);
        vm.prank(alice);
        r.register();
        assertEq(t.balanceOf(treasury), USDC_1);
        assertEq(r.balanceOf(alice), 1);
    }

    function test_transferFromReturningTrue_isAccepted() public {
        (RWAllyAgentRegistry r, ShapedToken t) = _shaped(ShapedToken.Shape.ReturnsTrue);
        vm.prank(alice);
        r.register();
        assertEq(t.balanceOf(treasury), USDC_1);
    }

    // ── setFee ────────────────────────────────────────────────────────────

    function test_setFee_aboveCap_reverts_atCapPasses_emits() public {
        uint256 cap = reg.MAX_FEE();
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.FeeTooHigh.selector, cap + 1));
        reg.setFee(cap + 1);
        assertEq(reg.fee(), USDC_1);

        vm.expectEmit(false, false, false, true);
        emit FeeChanged(USDC_1, cap);
        vm.prank(multisig);
        reg.setFee(cap);
        assertEq(reg.fee(), cap);

        vm.expectEmit(false, false, false, true);
        emit FeeChanged(cap, 0);
        vm.prank(multisig);
        reg.setFee(0);
    }

    function test_setFee_appliesToTheNextRegistrationOnly_existingIdentitiesUntouched() public {
        vm.prank(alice);
        uint256 first = reg.register();
        vm.prank(multisig);
        reg.setFee(5 * USDC_1);
        assertEq(reg.ownerOf(first), alice, "an existing identity is untouched");
        uint256 before = usdc.balanceOf(treasury);
        vm.prank(alice);
        reg.register();
        assertEq(usdc.balanceOf(treasury) - before, 5 * USDC_1);
    }

    function test_setTreasury_nonzero_notSelf_emits_andRedirectsTheNextFee() public {
        address next = makeAddr("next treasury");
        vm.startPrank(multisig);
        vm.expectRevert(RWAllyAgentRegistry.BadTreasury.selector);
        reg.setTreasury(address(0));
        vm.expectRevert(RWAllyAgentRegistry.BadTreasury.selector);
        reg.setTreasury(address(reg));
        vm.expectEmit(true, true, false, false);
        emit TreasuryChanged(treasury, next);
        reg.setTreasury(next);
        vm.stopPrank();
        vm.prank(alice);
        reg.register();
        assertEq(usdc.balanceOf(next), USDC_1);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_renounce_freezesFeeAndTreasury_registrationStillWorks() public {
        vm.startPrank(multisig);
        reg.setFee(2 * USDC_1);
        reg.renounceOwnership();
        vm.stopPrank();
        assertEq(reg.owner(), address(0));

        vm.startPrank(multisig);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.setFee(0);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.setTreasury(bob);
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.transferOwnership(bob);
        vm.stopPrank();

        vm.prank(alice);
        reg.register();
        assertEq(usdc.balanceOf(treasury), 2 * USDC_1, "the frozen fee and treasury still apply");
    }

    function test_renounce_clearsAPendingNomination() public {
        vm.startPrank(multisig);
        reg.transferOwnership(bob);
        reg.renounceOwnership();
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(RWAllyAgentRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();
    }

    function testFuzz_feeIsPulledExactly(uint256 fee_) public {
        fee_ = bound(fee_, 0, reg.MAX_FEE());
        vm.prank(multisig);
        reg.setFee(fee_);
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        reg.register();
        assertEq(usdc.balanceOf(treasury) - t0, fee_);
        assertEq(a0 - usdc.balanceOf(alice), fee_);
        assertEq(usdc.balanceOf(address(reg)), 0);
    }

    function testFuzz_feeAboveCapIsNeverAccepted(uint256 fee_) public {
        fee_ = bound(fee_, reg.MAX_FEE() + 1, type(uint256).max);
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.FeeTooHigh.selector, fee_));
        reg.setFee(fee_);
        RWAllyAgentRegistry r = new RWAllyAgentRegistry();
        vm.prank(r.INITIALIZER());
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.FeeTooHigh.selector, fee_));
        r.initialize(multisig, address(usdc), treasury, fee_, address(0), 0);
    }

    /// A call to an address without code succeeds and returns nothing, which the token-shape rules
    /// accept as a paid fee. The registry re-checks that the fee token still has code when it pulls.
    function test_register_feeTokenWithoutCodeAtPullTime_isRefused() public {
        (RWAllyAgentRegistry r, ShapedToken t) = _shaped(ShapedToken.Shape.ReturnsNothing);
        vm.prank(alice);
        assertEq(r.register(), 0, "precondition: the token works while it has code");
        vm.etch(address(t), "");
        assertEq(address(t).code.length, 0);
        vm.startPrank(alice);
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        r.register();
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        r.register("ipfs://x");
        vm.stopPrank();
        assertEq(r.balanceOf(alice), 1, "no identity was minted without a fee");
        // A zero fee never calls the token, so it is unaffected.
        vm.prank(multisig);
        r.setFee(0);
        vm.prank(alice);
        r.register();
        assertEq(r.balanceOf(alice), 2);
    }
}

// ───────────────────────────── a treasury the fee token refuses ──────────

/// The owner cannot pause registration, but `setTreasury` accepts any nonzero address, so pointing it
/// at an address the fee token refuses (a USDC-blocklisted address) makes every paid `register`
/// revert. These tests pin that behaviour, what it leaves untouched, and how it ends.
contract RWAllyAgentRegistryRefusedTreasuryTest is RegistryTestBase {
    RWAllyAgentRegistry reg;
    BlocklistToken token;
    OutsideRegistryMock outside;
    address blocked = makeAddr("blocklisted treasury");

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new BlocklistToken();
        outside = new OutsideRegistryMock();
        reg = new RWAllyAgentRegistry();
        vm.prank(reg.INITIALIZER());
        reg.initialize(multisig, address(token), treasury, USDC_1, address(outside), 100);
        outside.set(5, bob, bob, address(0));
        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? alice : i == 1 ? bob : carol;
            token.mint(who, 100 * USDC_1);
            vm.prank(who);
            token.approve(address(reg), type(uint256).max);
        }
        token.setBlocked(blocked, true);
    }

    function _refuseTreasury() internal {
        vm.prank(multisig);
        reg.setTreasury(blocked);
        assertEq(reg.treasury(), blocked);
    }

    function _assertEveryRegisterOverloadReverts(address who) internal {
        RWAllyAgentRegistry.MetadataEntry[] memory m = new RWAllyAgentRegistry.MetadataEntry[](0);
        vm.startPrank(who);
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        reg.register();
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        reg.register("ipfs://x");
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        reg.register("ipfs://x", m);
        vm.stopPrank();
    }

    function test_treasuryTheFeeTokenRefuses_haltsEveryPaidRegister_untilChangedAgain() public {
        vm.prank(alice);
        uint256 first = reg.register(); // works while the treasury is accepted
        _refuseTreasury();

        _assertEveryRegisterOverloadReverts(carol);
        assertEq(reg.balanceOf(carol), 0, "nothing was minted");
        assertEq(token.balanceOf(carol), 100 * USDC_1, "nothing was charged");

        // The owner puts an accepted treasury back and paid registration resumes.
        vm.prank(multisig);
        reg.setTreasury(treasury);
        vm.prank(carol);
        assertEq(reg.register(), first + 1);
        assertEq(token.balanceOf(treasury), 2 * USDC_1);
    }

    function test_refusedTreasury_leavesImportAndIdentityWritesUnaffected() public {
        vm.prank(alice);
        uint256 id = reg.register();
        _refuseTreasury();
        _assertEveryRegisterOverloadReverts(carol);

        // Import is free and never touches the treasury.
        vm.prank(bob);
        uint256 imported = reg.importAgent(5, "ipfs://imported");
        assertEq(reg.ownerOf(imported), bob);
        assertEq(token.balanceOf(blocked), 0);

        // URI and metadata writes work; the identity stays with its holder.
        vm.startPrank(alice);
        reg.setAgentURI(id, "ipfs://new");
        reg.setMetadata(id, "k", hex"01");
        vm.stopPrank();
        assertEq(reg.ownerOf(id), alice);
        assertEq(reg.tokenURI(id), "ipfs://new");
        // The fee token was never asked to move anything to the refused treasury.
        assertEq(token.balanceOf(blocked), 0);
    }

    function test_refusedTreasury_aZeroFeeIsUnaffected() public {
        _refuseTreasury();
        vm.prank(multisig);
        reg.setFee(0);
        vm.prank(carol);
        reg.register();
        assertEq(reg.balanceOf(carol), 1);
    }

    function test_refusedTreasury_afterRenounce_paidRegistrationStaysHalted() public {
        _refuseTreasury();
        vm.startPrank(multisig);
        reg.renounceOwnership();
        vm.expectRevert(RWAllyAgentRegistry.NotOwner.selector);
        reg.setTreasury(treasury);
        vm.stopPrank();
        _assertEveryRegisterOverloadReverts(alice);
        // Import still works after renounce, and so do the identities already held.
        vm.prank(bob);
        reg.importAgent(5, "");
        assertEq(reg.balanceOf(bob), 1);
    }

    function test_refusedSender_isTheTokensBlocklistNotTheRegistrys() public {
        token.setBlocked(carol, true);
        vm.prank(carol);
        vm.expectRevert(RWAllyAgentRegistry.FeeNotPaid.selector);
        reg.register();
        vm.prank(alice);
        reg.register(); // someone else is not affected
        assertEq(reg.balanceOf(alice), 1);
    }
}

// ───────────────────────────── the import window ─────────────────────────

contract RWAllyAgentRegistryImportTest is RegistryTestBase {
    event Imported(uint256 indexed agentId, uint256 indexed externalAgentId, address indexed holder);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    uint256 constant CEILING = 2535;

    RWAllyAgentRegistry reg;
    MockERC20 usdc;
    OutsideRegistryMock outside;
    uint256 end;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockERC20("USDC", 6);
        outside = new OutsideRegistryMock();
        reg = _fresh(address(usdc), USDC_1, address(outside), CEILING);
        end = reg.importEnd();
        outside.set(7, alice, bob, carol); // alice owns 7; bob is its agent wallet; carol is approved
        outside.set(CEILING - 1, alice, alice, address(0));
        outside.set(CEILING, alice, alice, address(0));
        outside.set(CEILING + 100, alice, alice, address(0));
    }

    function test_import_happyPath_isFree_mintsToTheOutsideOwner() public {
        vm.expectEmit(true, true, true, false);
        emit Imported(0, 7, alice);
        vm.prank(alice);
        uint256 id = reg.importAgent(7, "ipfs://imported");

        assertEq(id, 0);
        assertEq(reg.ownerOf(0), alice);
        assertEq(reg.tokenURI(0), "ipfs://imported");
        assertEq(reg.getAgentWallet(0), alice);
        assertEq(reg.balanceOf(alice), 1);
        (bool imported, uint256 local) = reg.localIdOfOrigin(block.chainid, address(outside), 7);
        assertTrue(imported);
        assertEq(local, id);
        assertEq(usdc.balanceOf(treasury), 0, "no fee");
        assertEq(usdc.balanceOf(alice), 0);
    }

    function test_import_doesNotConsumeOrDisturbPaidRegistrations() public {
        _fund(usdc, reg, bob, USDC_1);
        vm.prank(bob);
        assertEq(reg.register(), 0);
        vm.prank(alice);
        assertEq(reg.importAgent(7, ""), 1);
        assertEq(usdc.balanceOf(treasury), USDC_1);
    }

    function test_import_windowEdge_lastSecondWorks_thenClosed() public {
        vm.warp(end - 1);
        vm.prank(alice);
        reg.importAgent(7, "");

        vm.warp(end);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.ImportClosed.selector);
        reg.importAgent(CEILING - 1, "");

        vm.warp(end + 365 days);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.ImportClosed.selector);
        reg.importAgent(CEILING - 1, "");
    }

    function test_import_afterTheWindow_theOutsideRegistryIsNeverCalled() public {
        vm.warp(end);
        vm.expectCall(address(outside), abi.encodeWithSelector(0x6352211e), 0);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.ImportClosed.selector);
        reg.importAgent(7, "");
    }

    function test_import_afterTheWindow_aBurningOrRevertingOutsideRegistryChangesNothing() public {
        HostileOutside burn = new HostileOutside(HostileOutside.Mode.Burn, alice);
        RWAllyAgentRegistry r = _fresh(address(usdc), USDC_1, address(burn), 100);
        vm.warp(r.importEnd());
        uint256 g = gasleft();
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.ImportClosed.selector);
        r.importAgent(1, "");
        assertLt(g - gasleft(), 100_000, "a closed window costs almost nothing, no burn is reached");

        // and ordinary registration never touches the outside registry at any time
        _fund(usdc, r, alice, USDC_1);
        vm.expectCall(address(burn), "", 0);
        vm.prank(alice);
        r.register();
    }

    function test_import_atOrAboveTheCeiling_reverts_belowItWorks() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.ImportIdNotEligible.selector, CEILING));
        reg.importAgent(CEILING, "");
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ImportIdNotEligible.selector, CEILING + 100)
        );
        reg.importAgent(CEILING + 100, "");
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ImportIdNotEligible.selector, type(uint256).max)
        );
        reg.importAgent(type(uint256).max, "");
        reg.importAgent(CEILING - 1, "");
        vm.stopPrank();
        assertEq(reg.balanceOf(alice), 1);
        (bool imported,) = reg.localIdOfOrigin(block.chainid, address(outside), CEILING);
        assertFalse(imported);
    }

    function test_import_sameOutsideIdTwice_reverts() public {
        vm.prank(alice);
        reg.importAgent(7, "");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.AlreadyImported.selector, 7));
        reg.importAgent(7, "");
    }

    /// Selling the outside token on does not sell a second free import of it. The imported identity
    /// itself cannot be moved on, so the outside id stays claimed.
    function test_import_sameOutsideIdByTheNextOutsideOwner_reverts() public {
        vm.prank(alice);
        uint256 id = reg.importAgent(7, "");
        outside.set(7, bob, bob, address(0)); // the outside token changes hands
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        reg.transferFrom(alice, carol, id);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.AlreadyImported.selector, 7));
        reg.importAgent(7, "");
    }

    /// The origin record: an import stores (chain id, outside registry, outside id) against the local
    /// id; a registered identity has none; the record is permanent; one origin mints once, and
    /// the same outside id on another chain or another outside registry is a different origin.
    function test_import_recordsItsOrigin_andOneOriginMintsOnce() public {
        _fund(usdc, reg, bob, USDC_1);
        vm.prank(bob);
        uint256 registered = reg.register();
        (uint256 c0, address r0, uint256 a0) = reg.originOf(registered);
        assertEq(c0, 0);
        assertEq(r0, address(0));
        assertEq(a0, 0);

        vm.prank(alice);
        uint256 id = reg.importAgent(7, "");
        (uint256 c, address r, uint256 a) = reg.originOf(id);
        assertEq(c, block.chainid);
        assertEq(r, address(outside));
        assertEq(a, 7);

        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        reg.transferFrom(alice, carol, id);
        (c, r, a) = reg.originOf(id);
        assertEq(a, 7, "the origin stays with the identity");

        (bool imported, uint256 local) = reg.localIdOfOrigin(block.chainid, address(outside), 7);
        assertTrue(imported);
        assertEq(local, id);
        (imported,) = reg.localIdOfOrigin(block.chainid + 1, address(outside), 7);
        assertFalse(imported, "another chain is another origin");
        (imported,) = reg.localIdOfOrigin(block.chainid, address(this), 7);
        assertFalse(imported, "another registry is another origin");

        outside.set(7, alice, alice, address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.AlreadyImported.selector, 7));
        reg.importAgent(7, "");

        // local id 0 is a real id: the +1 encoding does not make it look unimported
        RWAllyAgentRegistry r2 = _fresh(address(usdc), 0, address(outside), CEILING);
        vm.prank(alice);
        uint256 first = r2.importAgent(7, "");
        assertEq(first, 0);
        (imported, local) = r2.localIdOfOrigin(block.chainid, address(outside), 7);
        assertTrue(imported);
        assertEq(local, 0);
    }

    function test_import_notTheOutsideOwner_reverts_andDoesNotBurnTheId() public {
        vm.prank(bob);
        vm.expectRevert(RWAllyAgentRegistry.NotOutsideOwner.selector);
        reg.importAgent(7, "");
        (bool imported,) = reg.localIdOfOrigin(block.chainid, address(outside), 7);
        assertFalse(imported, "a refused import leaves the id claimable by its owner");
        vm.prank(alice);
        reg.importAgent(7, "");
    }

    /// Only `ownerOf` counts. The outside agent wallet and an approved operator are refused.
    function test_import_neverViaAgentWalletOrApproval() public {
        assertEq(outside.getAgentWallet(7), bob);
        assertEq(outside.getApproved(7), carol);
        vm.prank(bob);
        vm.expectRevert(RWAllyAgentRegistry.NotOutsideOwner.selector);
        reg.importAgent(7, "");
        vm.prank(carol);
        vm.expectRevert(RWAllyAgentRegistry.NotOutsideOwner.selector);
        reg.importAgent(7, "");
        assertEq(reg.balanceOf(bob) + reg.balanceOf(carol), 0);
        // the identity lands with the outside owner, not with the wallet
        vm.prank(alice);
        uint256 id = reg.importAgent(7, "");
        assertEq(reg.ownerOf(id), alice);
        assertEq(reg.getAgentWallet(id), alice);
    }

    function test_import_nonexistentOutsideId_reverts() public {
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.NotOutsideOwner.selector);
        reg.importAgent(8, ""); // below the ceiling, but the outside registry reverts
    }

    function _hostile(HostileOutside.Mode m) internal returns (RWAllyAgentRegistry r) {
        HostileOutside h = new HostileOutside(m, alice);
        r = _fresh(address(usdc), USDC_1, address(h), 100);
    }

    function test_import_hostileOutsideRegistries_areRefused() public {
        HostileOutside.Mode[7] memory modes = [
            HostileOutside.Mode.Revert,
            HostileOutside.Mode.Revert32,
            HostileOutside.Mode.Empty,
            HostileOutside.Mode.Short,
            HostileOutside.Mode.Long,
            HostileOutside.Mode.Burn,
            HostileOutside.Mode.DirtyWord
        ];
        for (uint256 i; i < modes.length; ++i) {
            RWAllyAgentRegistry r = _hostile(modes[i]);
            vm.prank(alice);
            vm.expectRevert(RWAllyAgentRegistry.NotOutsideOwner.selector);
            r.importAgent(1, "");
            assertEq(r.balanceOf(alice), 0);
        }
    }

    function test_import_gasBurningOutsideRegistry_costsTheCallerUnderTheBound() public {
        RWAllyAgentRegistry r = _hostile(HostileOutside.Mode.Burn);
        uint256 g = gasleft();
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.NotOutsideOwner.selector);
        r.importAgent(1, "");
        uint256 used = g - gasleft();
        assertGt(used, 250_000, "the allowance was spent");
        assertLt(used, 400_000, "and not a unit more than the bound");
    }

    function test_import_hostileOutsideRegistry_cannotBlockPaidRegistration() public {
        RWAllyAgentRegistry r = _hostile(HostileOutside.Mode.Burn);
        _fund(usdc, r, bob, USDC_1);
        vm.prank(bob);
        assertEq(r.register(), 0);
    }

    function test_import_noOutsideRegistry_isClosedFromTheStart() public {
        RWAllyAgentRegistry r = _fresh(address(usdc), USDC_1, address(0), 0);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.ImportClosed.selector);
        r.importAgent(0, "");
    }

    function test_import_toAContractWithoutAReceiver_reverts() public {
        NoReceiver n = new NoReceiver();
        outside.set(9, address(n), address(n), address(0));
        vm.prank(address(n));
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidReceiver.selector, address(n))
        );
        reg.importAgent(9, "");
        (bool imported,) = reg.localIdOfOrigin(block.chainid, address(outside), 9);
        assertFalse(imported, "the revert rolled the claim back");
    }

    function test_import_identityIsAnOrdinaryIdentityAfterwards() public {
        vm.prank(alice);
        uint256 id = reg.importAgent(7, "ipfs://x");
        assertTrue(reg.locked(id), "an imported identity is soulbound too");
        vm.prank(alice);
        reg.setAgentURI(id, "ipfs://y");
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.Soulbound.selector);
        reg.transferFrom(alice, bob, id);
        assertEq(reg.ownerOf(id), alice);
        assertEq(reg.getAgentWallet(id), alice, "the wallet is the holder's until the holder re-points it");
    }

    function test_import_emitsLocked() public {
        vm.recordLogs();
        vm.prank(alice);
        uint256 id = reg.importAgent(7, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(reg) && logs[i].topics[0] == keccak256("Locked(uint256)")) {
                assertEq(abi.decode(logs[i].data, (uint256)), id);
                ++seen;
            }
        }
        assertEq(seen, 1, "exactly one Locked per import");
    }
}

// ───────────────────────────── same address through CREATE2 ──────────────

contract RWAllyAgentRegistryCreate2Test is RegistryTestBase {
    address constant ARACHNID = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// Runtime code of the Arachnid deterministic deployment proxy, byte for byte as read from Arc
    /// mainnet (`cast code 0x4e59...956c`) on both RPC endpoints.
    bytes constant ARACHNID_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    string cfg;

    function setUp() public {
        cfg = vm.readFile("config/agent-registry-create2.json");
        vm.etch(ARACHNID, ARACHNID_RUNTIME);
    }

    function _salt() internal view returns (bytes32) {
        return vm.parseJsonBytes32(cfg, ".salt");
    }

    function _predict(bytes32 salt, bytes memory initcode) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), ARACHNID, salt, keccak256(initcode)))))
        );
    }

    function _deploy(bytes32 salt, bytes memory initcode) internal returns (address deployed) {
        (bool ok, bytes memory ret) = ARACHNID.call(abi.encodePacked(salt, initcode));
        require(ok && ret.length == 20, "create2 proxy failed");
        deployed = address(bytes20(ret));
    }

    /// The recorded hash is the hash of the code this source builds. When the contract changes, this
    /// goes red until contracts/config/agent-registry-create2.json is regenerated (and the deploy
    /// address with it): the address is a function of the exact bytes.
    function test_recordedInitcodeHash_matchesTheBuild() public view {
        bytes memory initcode = type(RWAllyAgentRegistry).creationCode;
        assertEq(
            keccak256(initcode),
            vm.parseJsonBytes32(cfg, ".initcodeHash"),
            "initcode changed: regenerate contracts/config/agent-registry-create2.json"
        );
    }

    /// The recorded cap is the contract's cap.
    function test_recordedMaxFee_isTheContractCap() public {
        RWAllyAgentRegistry r = new RWAllyAgentRegistry();
        assertEq(vm.parseJsonUint(cfg, ".maxFee"), r.MAX_FEE());
        assertEq(r.MAX_FEE(), 100_000_000, "100 USDC in raw units of a 6-decimal token");
    }

    /// The salt is mined, not derived from a preimage, so the address starts with 0x1337 only for
    /// the exact creation code the salt was mined against. Any change to the registry's bytecode, or
    /// to what it imports, moves the address off the prefix and turns this red until the salt is
    /// mined again (cast create2 --starts-with 1337).
    function test_predictedAddress_startsWith0x1337() public view {
        address predicted = _predict(_salt(), type(RWAllyAgentRegistry).creationCode);
        assertEq(uint16(uint160(predicted) >> 144), 0x1337, "the registry address must start with 0x1337");
        assertEq(uint16(uint160(vm.parseJsonAddress(cfg, ".address")) >> 144), 0x1337, "so must the record");
    }

    function test_recordedAddress_isTheCreate2AddressOfTheRecordedInputs() public view {
        assertEq(vm.parseJsonAddress(cfg, ".factory"), ARACHNID);
        assertEq(
            vm.parseJsonAddress(cfg, ".address"),
            _predict(_salt(), type(RWAllyAgentRegistry).creationCode),
            "recorded address is not the CREATE2 address of (factory, salt, initcode hash)"
        );
    }

    function test_deployThroughTheProxy_landsAtThePredictedAddress() public {
        bytes memory initcode = type(RWAllyAgentRegistry).creationCode;
        address predicted = _predict(_salt(), initcode);
        assertEq(predicted.code.length, 0);
        address deployed = _deploy(_salt(), initcode);
        assertEq(deployed, predicted);
        assertEq(deployed, vm.parseJsonAddress(cfg, ".address"));
        assertGt(deployed.code.length, 0);
        assertEq(
            keccak256(deployed.code),
            keccak256(vm.getDeployedCode("RWAllyAgentRegistry.sol:RWAllyAgentRegistry"))
        );
        // It arrives uninitialized, ownerless and closed.
        RWAllyAgentRegistry r = RWAllyAgentRegistry(deployed);
        assertFalse(r.initialized());
        assertEq(r.owner(), address(0));
        // The same salt and code cannot be deployed twice at the address.
        (bool ok,) = ARACHNID.call(abi.encodePacked(_salt(), initcode));
        assertFalse(ok);
    }

    function test_theAddressDoesNotDependOnTheChain() public {
        bytes memory initcode = type(RWAllyAgentRegistry).creationCode;
        uint256 snap = vm.snapshotState();
        vm.chainId(5042);
        address onArc = _deploy(_salt(), initcode);
        assertTrue(vm.revertToState(snap));
        vm.etch(ARACHNID, ARACHNID_RUNTIME);
        vm.chainId(8453);
        address onBase = _deploy(_salt(), initcode);
        assertEq(onArc, onBase, "one address on every chain");
    }

    function test_aDifferentSaltOrCodeIsADifferentAddress() public view {
        bytes memory initcode = type(RWAllyAgentRegistry).creationCode;
        assertTrue(_predict(_salt(), initcode) != _predict(bytes32(uint256(_salt()) + 1), initcode));
        assertTrue(_predict(_salt(), initcode) != _predict(_salt(), abi.encodePacked(initcode, hex"00")));
    }

    function test_initializeAfterDeploy_onlyTheInitializerCan_andAnyoneCanSendTheDeploy() public {
        address anyone = makeAddr("anyone sends the deploy");
        MockERC20 usdc = new MockERC20("USDC", 6);
        vm.prank(anyone);
        address deployed = _deploy(_salt(), type(RWAllyAgentRegistry).creationCode);
        RWAllyAgentRegistry r = RWAllyAgentRegistry(deployed);

        vm.prank(anyone); // the deploy sender has no claim on the registry
        vm.expectRevert(RWAllyAgentRegistry.NotInitializer.selector);
        r.initialize(anyone, address(usdc), anyone, USDC_1, address(0), 0);

        vm.prank(r.INITIALIZER());
        r.initialize(multisig, address(usdc), treasury, USDC_1, address(0), 0);
        assertEq(r.owner(), multisig);
        assertEq(r.fee(), USDC_1);
    }

    // ── the recorded initializer ─────────────────────────────────────────

    function test_initializerConstant_equalsTheRecordedInitializer() public {
        RWAllyAgentRegistry r = new RWAllyAgentRegistry();
        assertEq(r.INITIALIZER(), vm.parseJsonAddress(cfg, ".initializer"));
    }

    /// The registry's one-shot gate is the protocol-wide constant, as the singletons' is, not a
    /// separate literal that could drift from it.
    function test_initializerConstant_isTheProtocolInitializer() public {
        RWAllyAgentRegistry r = new RWAllyAgentRegistry();
        assertEq(r.INITIALIZER(), PROTOCOL_INITIALIZER);
    }

    /// The initializer is the owner-held protocol deployer key, the same address the Arc deployment
    /// record names as `deployer`.
    function test_initializer_isTheProtocolDeployer() public view {
        string memory deployment = vm.readFile("config/deployments/arc-mainnet.json");
        assertEq(vm.parseJsonAddress(cfg, ".initializer"), vm.parseJsonAddress(deployment, ".deployer"));
    }
}

/// A 6-decimal fee token with a transfer hook (the ERC-777 and ERC-1363 shape): after moving a balance
/// it calls out. `initialize` accepts it, since it checks only that the address has code and that
/// `decimals()` is 6. USDC has no hooks; this token exists to show what the factory-target guard is for.
contract HookFeeToken {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    Factory6492 public hookFactory;
    bytes32 public hookSalt;
    bytes32 public hookDigest;
    bytes public hookSig;

    function mint(address a, uint256 n) external {
        balanceOf[a] += n;
    }

    function approve(address s, uint256 n) external returns (bool) {
        allowance[msg.sender][s] = n;
        return true;
    }

    function arm(Factory6492 f, bytes32 salt, bytes32 d, bytes calldata sig) external {
        hookFactory = f;
        hookSalt = salt;
        hookDigest = d;
        hookSig = sig;
    }

    function transferFrom(address from, address to, uint256 n) external returns (bool) {
        allowance[from][msg.sender] -= n;
        balanceOf[from] -= n;
        balanceOf[to] += n;
        // The hook: after the balance moves, deploy the wallet the holder is designating.
        if (address(hookFactory) != address(0)) hookFactory.deploy(hookSalt, hookDigest, hookSig);
        return true;
    }
}

/// The ERC-6492 factory-target guard (`factory != address(this) && factory != feeToken`) against a fee
/// token whose transfer hook deploys the wallet being designated.
contract RWAllyAgentRegistryHookFeeTokenTest is Test {
    RWAllyAgentRegistry reg;
    HookFeeToken tok;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new RWAllyAgentRegistry();
        tok = new HookFeeToken();
        vm.prank(reg.INITIALIZER());
        reg.initialize(makeAddr("multisig"), address(tok), makeAddr("treasury"), 0, address(0), 0);
    }

    function _suffix6492() private pure returns (bytes32) {
        return bytes32(
            abi.encodePacked(
                bytes8(0x6492649264926492),
                bytes8(0x6492649264926492),
                bytes8(0x6492649264926492),
                bytes8(0x6492649264926492)
            )
        );
    }

    /// Without the guard, a holder could name the fee token as the factory with calldata
    /// `transferFrom(victim, holder, amount)`: the registry, the spender of every registrant's
    /// allowance, would make that call, and the token's hook would deploy `newWallet`, so the code
    /// check afterwards would pass and the call would succeed having spent the allowance. With the
    /// guard the call reverts before the token is touched.
    function test_setAgentWallet_erc6492_hookFeeTokenAsFactory_cannotSpendARegistrantsAllowance() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://a");
        tok.mint(bob, 100e6);
        vm.prank(bob);
        tok.approve(address(reg), type(uint256).max);

        Factory6492 f = new Factory6492();
        bytes32 salt = keccak256("hook");
        address target = f.predict(salt);
        uint256 dl = block.timestamp + 10 minutes;
        bytes32 d = keccak256(
            abi.encodePacked(
                "\x19\x01",
                reg.domainSeparator(),
                keccak256(
                    abi.encode(
                        keccak256(
                            "AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"
                        ),
                        id,
                        target,
                        alice,
                        dl
                    )
                )
            )
        );
        bytes memory inner = hex"aabbcc";
        tok.arm(f, salt, d, inner);
        bytes memory steal =
            abi.encodeWithSignature("transferFrom(address,address,uint256)", bob, alice, 100e6);
        bytes memory sig = abi.encodePacked(abi.encode(address(tok), steal, inner), _suffix6492());

        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidWalletSignature.selector);
        reg.setAgentWallet(id, target, dl, sig);
        assertEq(tok.balanceOf(bob), 100e6, "bob's allowance to the registry was not spent");
        assertEq(tok.balanceOf(alice), 0, "the holder received nothing");
        assertEq(target.code.length, 0, "the hook never ran");
        assertEq(reg.getAgentWallet(id), alice);
    }
}
