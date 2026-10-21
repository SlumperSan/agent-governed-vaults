// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RWAllyAgentRegistry, IERC721Receiver} from "../src/RWAllyAgentRegistry.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {Vm} from "forge-std/Vm.sol";
import {
    RegistryTestBase,
    OutsideRegistryMock,
    Wallet1271,
    Factory6492
} from "./RWAllyAgentRegistry.t.sol";

/// An ERC-1271 attestor that burns every unit of gas it is given.
contract BurnerAttestor {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4 magic) {
        for (;;) {}
    }
}

/// An ERC-1271 attestor that answers with the magic value but only four bytes of returndata.
contract ShortReturnAttestor {
    fallback() external {
        assembly {
            mstore(0, shl(224, 0x1626ba7e))
            return(0, 4)
        }
    }
}

/// A contract that claims a mirror and checks, inside the ERC-721 callback, that the identity is
/// already in place (state first, callback last).
contract MirrorClaimer is IERC721Receiver {
    RWAllyAgentRegistry public reg;
    bool public sawIdentityInCallback;

    constructor(RWAllyAgentRegistry reg_) {
        reg = reg_;
    }

    function claim(RWAllyAgentRegistry.MirrorAttestation calldata a, string calldata uri, bytes calldata sig)
        external
        returns (uint256)
    {
        return reg.mintMirrored(a, uri, sig);
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        sawIdentityInCallback = reg.ownerOf(id) == address(this) && reg.balanceOf(address(this)) == 1;
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract BadMagicClaimer is IERC721Receiver {
    function claim(
        RWAllyAgentRegistry reg,
        RWAllyAgentRegistry.MirrorAttestation calldata a,
        string calldata uri,
        bytes calldata sig
    ) external returns (uint256) {
        return reg.mintMirrored(a, uri, sig);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

contract RWAllyAgentRegistryMirrorTest is RegistryTestBase {
    uint256 constant ATT_PK = 0xa77e57ed;
    uint256 constant ORIGIN = 5042; // Arc
    uint256 constant DEST = 8453; // Base
    uint256 constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    event AttestorSet(address indexed oldAttestor, address indexed newAttestor);
    event Mirrored(
        uint256 indexed agentId, address indexed owner, uint256 indexed originChainId, uint256 originAgentId
    );
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId);

    RWAllyAgentRegistry reg;
    MockERC20 usdc;
    address attestor;
    string constant URI = "ipfs://mirror";

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.chainId(DEST);
        usdc = new MockERC20("USDC", 6);
        attestor = vm.addr(ATT_PK);
        reg = new RWAllyAgentRegistry();
        // A nonzero fee: a mirror must not touch it.
        vm.prank(reg.INITIALIZER());
        reg.initialize(multisig, address(usdc), treasury, USDC_1, address(0), 0, attestor);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _att(uint256 originId, address owner_, string memory uri)
        internal
        view
        returns (RWAllyAgentRegistry.MirrorAttestation memory)
    {
        return RWAllyAgentRegistry.MirrorAttestation({
            originChainId: ORIGIN,
            originRegistry: address(reg),
            originAgentId: originId,
            owner: owner_,
            agentURIHash: keccak256(bytes(uri)),
            expiry: block.timestamp + 1 hours,
            nonce: 123
        });
    }

    function _sign(uint256 pk, RWAllyAgentRegistry.MirrorAttestation memory a)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, reg.mirrorAttestationDigest(a));
        return abi.encodePacked(r, s, v);
    }

    function _claim(address who, RWAllyAgentRegistry.MirrorAttestation memory a, string memory uri)
        internal
        returns (uint256)
    {
        bytes memory sig = _sign(ATT_PK, a); // an external view call: sign before the prank
        vm.prank(who);
        return reg.mintMirrored(a, uri, sig);
    }

    function _expect(bytes4 sel) internal {
        vm.expectRevert(sel);
    }

    // ── happy path ───────────────────────────────────────────────────────────

    function test_mint_happyPath_noFee_originRecorded() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes memory sig = _sign(ATT_PK, a);
        assertEq(reg.fee(), USDC_1);
        assertEq(usdc.balanceOf(alice), 0);

        vm.expectEmit(true, true, true, true, address(reg));
        emit Registered(0, URI, alice);
        vm.expectEmit(true, true, true, true, address(reg));
        emit Mirrored(0, alice, ORIGIN, 7);
        vm.prank(alice);
        uint256 id = reg.mintMirrored(a, URI, sig);

        assertEq(id, 0);
        assertEq(reg.ownerOf(0), alice);
        assertEq(reg.balanceOf(alice), 1);
        assertEq(reg.tokenURI(0), URI);
        assertEq(reg.getAgentWallet(0), alice);
        (uint256 oc, address oreg, uint256 oid) = reg.originOf(0);
        assertEq(oc, ORIGIN);
        assertEq(oreg, address(reg));
        assertEq(oid, 7);
        (bool minted, uint256 local) = reg.localIdOfOrigin(ORIGIN, address(reg), 7);
        assertTrue(minted);
        assertEq(local, 0);
        assertEq(usdc.balanceOf(treasury), 0, "no fee moved");
        assertEq(usdc.balanceOf(alice), 0);
    }

    function test_mirror_destinationPolygonIsAllowed() public {
        vm.chainId(137);
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        assertEq(_claim(alice, a, URI), 0);
    }

    // ── attestor switch and rotation ─────────────────────────────────────────

    function test_attestorZero_failsClosed_afterSixArgInitialize() public {
        RWAllyAgentRegistry r = new RWAllyAgentRegistry();
        vm.prank(r.INITIALIZER());
        r.initialize(multisig, address(usdc), treasury, 0, address(0), 0);
        assertEq(r.attestor(), address(0));
        RWAllyAgentRegistry.MirrorAttestation memory a = RWAllyAgentRegistry.MirrorAttestation(
            ORIGIN, address(r), 7, alice, keccak256(bytes(URI)), block.timestamp + 1 hours, 1
        );
        _expect(RWAllyAgentRegistry.AttestorNotSet.selector);
        vm.prank(alice);
        r.mintMirrored(a, URI, hex"");
    }

    function test_beforeInitialize_reverts_notInitialized() public {
        RWAllyAgentRegistry r = new RWAllyAgentRegistry();
        RWAllyAgentRegistry.MirrorAttestation memory a = RWAllyAgentRegistry.MirrorAttestation(
            ORIGIN, address(r), 7, alice, keccak256(bytes(URI)), block.timestamp + 1 hours, 1
        );
        _expect(RWAllyAgentRegistry.NotInitialized.selector);
        vm.prank(alice);
        r.mintMirrored(a, URI, hex"");
    }

    function test_attestorZero_afterOwnerSwitchesOff() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes memory sig = _sign(ATT_PK, a);
        vm.prank(multisig);
        reg.setAttestor(address(0));
        _expect(RWAllyAgentRegistry.AttestorNotSet.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, sig);
    }

    function test_attestorZero_garbageSignatureNeverMints() public {
        // address(0) must not validate a signature that `ecrecover` cannot recover.
        vm.prank(multisig);
        reg.setAttestor(address(0));
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        _expect(RWAllyAgentRegistry.AttestorNotSet.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, new bytes(65));
        assertEq(reg.balanceOf(alice), 0);
    }

    function test_initialize_sevenArg_setsAttestorAndEmits() public {
        RWAllyAgentRegistry r = new RWAllyAgentRegistry();
        vm.expectEmit(true, true, false, false, address(r));
        emit AttestorSet(address(0), attestor);
        vm.prank(r.INITIALIZER());
        r.initialize(multisig, address(usdc), treasury, 0, address(0), 0, attestor);
        assertEq(r.attestor(), attestor);
        assertEq(r.owner(), multisig);
    }

    function test_initialize_sevenArg_wrongSenderReverts_andIsOneShot() public {
        RWAllyAgentRegistry r = new RWAllyAgentRegistry();
        vm.prank(alice);
        _expect(RWAllyAgentRegistry.NotInitializer.selector);
        r.initialize(multisig, address(usdc), treasury, 0, address(0), 0, alice);
        assertEq(r.attestor(), address(0));
        address init = r.INITIALIZER();
        vm.startPrank(init);
        r.initialize(multisig, address(usdc), treasury, 0, address(0), 0, attestor);
        _expect(RWAllyAgentRegistry.AlreadyInitialized.selector);
        r.initialize(multisig, address(usdc), treasury, 0, address(0), 0, alice);
        vm.stopPrank();
        assertEq(r.attestor(), attestor);
    }

    function test_setAttestor_onlyOwner_emits() public {
        vm.prank(alice);
        _expect(RWAllyAgentRegistry.NotOwner.selector);
        reg.setAttestor(alice);

        address initializer = reg.INITIALIZER();
        vm.prank(initializer);
        _expect(RWAllyAgentRegistry.NotOwner.selector);
        reg.setAttestor(alice);

        vm.expectEmit(true, true, false, false, address(reg));
        emit AttestorSet(attestor, bob);
        vm.prank(multisig);
        reg.setAttestor(bob);
        assertEq(reg.attestor(), bob);
    }

    function test_rotation_killsPendingAttestation_newKeyWorks() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes memory oldSig = _sign(ATT_PK, a);
        uint256 newPk = 0xbeef;
        vm.prank(multisig);
        reg.setAttestor(vm.addr(newPk));

        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, oldSig);

        bytes memory newSig = _sign(newPk, a);
        vm.prank(alice);
        reg.mintMirrored(a, URI, newSig);
        assertEq(reg.ownerOf(0), alice);
    }

    function test_renounce_freezesAttestor() public {
        vm.prank(multisig);
        reg.renounceOwnership();
        vm.prank(multisig);
        _expect(RWAllyAgentRegistry.NotOwner.selector);
        reg.setAttestor(bob);
        assertEq(reg.attestor(), attestor);
    }

    // ── expiry and TTL ───────────────────────────────────────────────────────

    function test_expired_reverts_boundaryAccepted() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        a.expiry = block.timestamp; // equal to now: still valid
        assertEq(_claim(alice, a, URI), 0);

        RWAllyAgentRegistry.MirrorAttestation memory b = _att(8, alice, URI);
        b.expiry = block.timestamp - 1;
        bytes memory sig = _sign(ATT_PK, b);
        _expect(RWAllyAgentRegistry.AttestationExpired.selector);
        vm.prank(alice);
        reg.mintMirrored(b, URI, sig);
    }

    function test_ttlCap_sevenDaysAccepted_oneSecondMoreReverts() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        a.expiry = block.timestamp + 7 days;
        assertEq(_claim(alice, a, URI), 0);

        RWAllyAgentRegistry.MirrorAttestation memory b = _att(8, alice, URI);
        b.expiry = block.timestamp + 7 days + 1;
        bytes memory sig = _sign(ATT_PK, b);
        _expect(RWAllyAgentRegistry.AttestationTtlTooLong.selector);
        vm.prank(alice);
        reg.mintMirrored(b, URI, sig);

        RWAllyAgentRegistry.MirrorAttestation memory c = _att(9, alice, URI);
        c.expiry = type(uint256).max; // a buggy signer's "never expires"
        sig = _sign(ATT_PK, c);
        _expect(RWAllyAgentRegistry.AttestationTtlTooLong.selector);
        vm.prank(alice);
        reg.mintMirrored(c, URI, sig);
    }

    // ── who may submit, and what is bound ────────────────────────────────────

    function test_relayerRefused_onlyTheNamedOwnerMints() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes memory sig = _sign(ATT_PK, a);
        _expect(RWAllyAgentRegistry.NotAttestedOwner.selector);
        vm.prank(bob);
        reg.mintMirrored(a, URI, sig);
        assertEq(reg.balanceOf(alice), 0);
        assertEq(reg.balanceOf(bob), 0);
    }

    function test_originOnThisChain_reverts() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        a.originChainId = DEST;
        bytes memory sig = _sign(ATT_PK, a);
        _expect(RWAllyAgentRegistry.OriginIsThisChain.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, sig);
    }

    function test_originRegistryNotThis_reverts() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        a.originRegistry = makeAddr("someOtherRegistry");
        bytes memory sig = _sign(ATT_PK, a);
        _expect(RWAllyAgentRegistry.OriginRegistryNotThis.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, sig);
    }

    function test_uriHashMismatch_reverts() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes memory sig = _sign(ATT_PK, a);
        _expect(RWAllyAgentRegistry.AgentURIMismatch.selector);
        vm.prank(alice);
        reg.mintMirrored(a, "ipfs://other", sig);
    }

    function test_everyFieldIsSigned() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes memory sig = _sign(ATT_PK, a);
        // change each signed field after signing; the signature must stop matching
        RWAllyAgentRegistry.MirrorAttestation memory b = _att(7, alice, URI);
        b.originAgentId = 8;
        vm.prank(alice);
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        reg.mintMirrored(b, URI, sig);
        b = _att(7, alice, URI);
        b.originChainId = 1;
        vm.prank(alice);
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        reg.mintMirrored(b, URI, sig);
        b = _att(7, alice, URI);
        b.nonce = 124;
        vm.prank(alice);
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        reg.mintMirrored(b, URI, sig);
        b = _att(7, alice, URI);
        b.expiry = a.expiry - 1;
        vm.prank(alice);
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        reg.mintMirrored(b, URI, sig);
        // the unchanged struct passes
        vm.prank(alice);
        reg.mintMirrored(a, URI, sig);
    }

    // ── replay ───────────────────────────────────────────────────────────────

    function test_doubleMint_sameAttestation_reverts() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes memory sig = _sign(ATT_PK, a);
        vm.prank(alice);
        reg.mintMirrored(a, URI, sig);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.AlreadyMirrored.selector, uint256(0)));
        reg.mintMirrored(a, URI, sig);
    }

    function test_doubleMint_freshAttestationForSameOrigin_reverts() public {
        _claim(alice, _att(7, alice, URI), URI);
        // a new nonce, a new expiry, a new owner: the origin key is what is unique
        RWAllyAgentRegistry.MirrorAttestation memory b = _att(7, bob, "ipfs://b");
        b.nonce = 999;
        b.expiry = block.timestamp + 2 hours;
        bytes memory sig = _sign(ATT_PK, b);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.AlreadyMirrored.selector, uint256(0)));
        reg.mintMirrored(b, "ipfs://b", sig);
    }

    function test_originSold_sellerMints_buyerCannotMintSecond() public {
        RWAllyAgentRegistry.MirrorAttestation memory seller = _att(7, alice, URI);
        RWAllyAgentRegistry.MirrorAttestation memory buyer = _att(7, bob, URI);
        buyer.nonce = 124;
        bytes memory sigSeller = _sign(ATT_PK, seller);
        bytes memory sigBuyer = _sign(ATT_PK, buyer);
        vm.prank(alice);
        reg.mintMirrored(seller, URI, sigSeller);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.AlreadyMirrored.selector, uint256(0)));
        reg.mintMirrored(buyer, URI, sigBuyer);
    }

    function test_replayOnAnotherChain_reverts() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes memory sig = _sign(ATT_PK, a); // signed for chain 8453
        vm.chainId(42161); // the same registry address on Arbitrum
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, sig);
        vm.chainId(DEST);
        vm.prank(alice);
        reg.mintMirrored(a, URI, sig);
    }

    function test_replayOnAnotherRegistry_reverts() public {
        RWAllyAgentRegistry other = new RWAllyAgentRegistry();
        vm.prank(other.INITIALIZER());
        other.initialize(multisig, address(usdc), treasury, 0, address(0), 0, attestor);
        // an attestation whose own fields name `other`, signed against `reg`'s domain
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        a.originRegistry = address(other);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATT_PK, reg.mirrorAttestationDigest(a));
        vm.prank(alice);
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        other.mintMirrored(a, URI, abi.encodePacked(r, s, v));
    }

    function test_domainDiffersPerChain() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes32 base = reg.mirrorAttestationDigest(a);
        vm.chainId(137);
        bytes32 polygon = reg.mirrorAttestationDigest(a);
        vm.chainId(1);
        bytes32 eth = reg.mirrorAttestationDigest(a);
        assertTrue(base != polygon && base != eth && polygon != eth);
    }

    // ── signature handling ───────────────────────────────────────────────────

    function test_wrongSigner_reverts() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes memory sig = _sign(0xdead, a);
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, sig);
    }

    function test_malleableHighS_twinRejected() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATT_PK, reg.mirrorAttestationDigest(a));
        bytes32 sTwin = bytes32(SECP_N - uint256(s));
        uint8 vTwin = v == 27 ? 28 : 27;
        // the twin recovers the same signer under raw ecrecover, so only the half-order check refuses it
        assertEq(ecrecover(reg.mirrorAttestationDigest(a), vTwin, r, sTwin), attestor);
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, abi.encodePacked(r, sTwin, vTwin));
        // the canonical form of the same signature mints
        vm.prank(alice);
        reg.mintMirrored(a, URI, abi.encodePacked(r, s, v));
    }

    function test_badV_andBadLength_rejected() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATT_PK, reg.mirrorAttestationDigest(a));
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, abi.encodePacked(r, s, uint8(v - 27))); // v = 0 or 1
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, abi.encodePacked(r, s)); // 64 bytes
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, abi.encodePacked(r, s, v, uint8(0))); // 66 bytes
    }

    function testFuzz_randomSignatureNeverMints(bytes memory junk) public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        vm.prank(alice);
        vm.expectRevert(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        reg.mintMirrored(a, URI, junk);
    }

    // ── ERC-1271 attestor (a bridge receiver or a contract wallet) ───────────

    function test_erc1271Attestor_acceptedAndRejected() public {
        Wallet1271 w = new Wallet1271();
        vm.prank(multisig);
        reg.setAttestor(address(w));
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes32 d = reg.mirrorAttestationDigest(a);

        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector); // nothing allowed yet
        vm.prank(alice);
        reg.mintMirrored(a, URI, hex"1234");

        w.allow(d, hex"1234");
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector); // a different blob
        vm.prank(alice);
        reg.mintMirrored(a, URI, hex"9999");

        vm.prank(alice);
        reg.mintMirrored(a, URI, hex"1234");
        assertEq(reg.ownerOf(0), alice);
    }

    function test_erc1271Attestor_emptySignature_bridgeStyle() public {
        Wallet1271 w = new Wallet1271();
        vm.prank(multisig);
        reg.setAttestor(address(w));
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        w.allow(reg.mirrorAttestationDigest(a), hex"");
        vm.prank(alice);
        reg.mintMirrored(a, URI, hex"");
        assertEq(reg.ownerOf(0), alice);
    }

    function test_erc1271Attestor_gasBurner_isBounded() public {
        BurnerAttestor b = new BurnerAttestor();
        vm.prank(multisig);
        reg.setAttestor(address(b));
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        // Hand the call 5M gas. An unbounded ERC-1271 call would let the burner eat nearly all of it; the
        // bound caps what it can take at ATTESTOR_CALL_GAS (300k), and the revert is the registry's own.
        uint256 before = gasleft();
        vm.prank(alice);
        (bool ok, bytes memory ret) =
            address(reg).call{gas: 5_000_000}(abi.encodeCall(reg.mintMirrored, (a, URI, bytes(hex""))));
        uint256 used = before - gasleft();
        assertFalse(ok);
        assertEq(bytes4(ret), RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        assertLt(used, 450_000, "the attestor call is not gas-bounded");
    }

    function test_erc1271Attestor_shortReturn_rejected() public {
        ShortReturnAttestor s = new ShortReturnAttestor();
        vm.prank(multisig);
        reg.setAttestor(address(s));
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, hex"");
    }

    function test_accountAttestor_withNoCode_doesNotFallThrough() public {
        // an account attestor with a bad signature must not be rescued by the ERC-1271 branch
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, hex"1234");
    }

    // ── daily cap ────────────────────────────────────────────────────────────

    function test_dailyCap_mintsThenReverts_resetsNextDay() public {
        uint256 cap = reg.MIRROR_DAILY_CAP();
        assertEq(cap, 100);
        assertEq(reg.mirrorsRemainingToday(), cap);
        for (uint256 i; i < cap; ++i) {
            address who = address(uint160(0xC0000 + i));
            _claim(who, _att(1000 + i, who, URI), URI);
        }
        assertEq(reg.mirrorsRemainingToday(), 0);

        address late = makeAddr("late");
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(5000, late, URI);
        bytes memory sig = _sign(ATT_PK, a);
        _expect(RWAllyAgentRegistry.MirrorCapReached.selector);
        vm.prank(late);
        reg.mintMirrored(a, URI, sig);

        // register and import are not subject to the mirror cap
        // (the fee is 1 USDC here; fund and approve)
        usdc.mint(late, USDC_1);
        vm.prank(late);
        usdc.approve(address(reg), USDC_1);
        vm.prank(late);
        reg.register();

        vm.warp(block.timestamp + 1 days);
        assertEq(reg.mirrorsRemainingToday(), cap);
        a = _att(5000, late, URI);
        assertEq(_claim(late, a, URI), cap + 1);
        assertEq(reg.mirrorsRemainingToday(), cap - 1);
    }

    function test_dailyCap_acrossUtcMidnight_canMintAgain() public {
        uint256 cap = reg.MIRROR_DAILY_CAP();
        uint256 dayEnd = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(dayEnd - 1);
        for (uint256 i; i < cap; ++i) {
            address who = address(uint160(0xD0000 + i));
            _claim(who, _att(2000 + i, who, URI), URI);
        }
        assertEq(reg.mirrorsRemainingToday(), 0);
        vm.warp(dayEnd); // the next UTC day starts: the documented residual is up to twice the cap across midnight
        assertEq(reg.mirrorsRemainingToday(), cap);
        _claim(alice, _att(9000, alice, URI), URI);
    }

    // ── shared path with the import window ───────────────────────────────────

    function test_importAndMirror_shareDedupeAndOriginOf() public {
        OutsideRegistryMock outside = new OutsideRegistryMock();
        RWAllyAgentRegistry r = new RWAllyAgentRegistry();
        vm.prank(r.INITIALIZER());
        r.initialize(multisig, address(usdc), treasury, USDC_1, address(outside), 10, attestor);
        outside.set(7, alice, address(0), address(0));
        reg = r; // helpers sign against `reg`

        vm.prank(alice);
        uint256 imported = r.importAgent(7, "ipfs://imp");
        assertEq(imported, 0);

        // a mirror whose origin id is also 7 mints too: the keys differ (outside registry on this chain
        // versus (origin chain, this registry))
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        assertEq(_claim(alice, a, URI), 1);

        (uint256 c0, address r0, uint256 i0) = r.originOf(0);
        assertEq(c0, DEST);
        assertEq(r0, address(outside));
        assertEq(i0, 7);
        (uint256 c1, address r1, uint256 i1) = r.originOf(1);
        assertEq(c1, ORIGIN);
        assertEq(r1, address(r), "a mirror is marked by an origin registry equal to this registry");
        assertEq(i1, 7);

        (bool m0, uint256 l0) = r.localIdOfOrigin(DEST, address(outside), 7);
        (bool m1, uint256 l1) = r.localIdOfOrigin(ORIGIN, address(r), 7);
        assertTrue(m0 && m1);
        assertEq(l0, 0);
        assertEq(l1, 1);

        // both are once-only through the one mapping
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.AlreadyImported.selector, uint256(7)));
        r.importAgent(7, "ipfs://again");
        RWAllyAgentRegistry.MirrorAttestation memory a2 = _att(7, alice, URI);
        a2.nonce = 2;
        bytes memory sig = _sign(ATT_PK, a2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.AlreadyMirrored.selector, uint256(1)));
        r.mintMirrored(a2, URI, sig);

        // an attestation can never be crafted to collide with an import key: its origin chain may not be
        // this chain and its origin registry must be this registry
        RWAllyAgentRegistry.MirrorAttestation memory forged = _att(8, alice, URI);
        forged.originChainId = DEST;
        forged.originRegistry = address(outside);
        sig = _sign(ATT_PK, forged);
        vm.prank(alice);
        _expect(RWAllyAgentRegistry.OriginIsThisChain.selector);
        r.mintMirrored(forged, URI, sig);

        // neither path charged the fee: only registrations pay
        assertEq(usdc.balanceOf(treasury), 0);
    }

    // ── receivers ────────────────────────────────────────────────────────────

    function test_contractOwner_receiverCallbackSeesIdentityInPlace() public {
        MirrorClaimer c = new MirrorClaimer(reg);
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, address(c), URI);
        bytes memory sig = _sign(ATT_PK, a);
        assertEq(c.claim(a, URI, sig), 0);
        assertTrue(c.sawIdentityInCallback());
    }

    function test_contractOwner_badReceiver_reverts_nothingMinted() public {
        BadMagicClaimer c = new BadMagicClaimer();
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, address(c), URI);
        bytes memory sig = _sign(ATT_PK, a);
        vm.expectRevert(
            abi.encodeWithSelector(RWAllyAgentRegistry.ERC721InvalidReceiver.selector, address(c))
        );
        c.claim(reg, a, URI, sig);
        (bool minted,) = reg.localIdOfOrigin(ORIGIN, address(reg), 7);
        assertFalse(minted);
    }

    // ── a mirror behaves as an identity afterwards ───────────────────────────

    /// A mirrored id is soulbound exactly like a registered one: no transfer, no approval, from any
    /// caller, and the dedupe record and the holder stay put.
    function test_mirror_isSoulbound_everyTransferAndApprovalEntryPointReverts() public {
        uint256 id = _claim(alice, _att(7, alice, URI), URI);
        address[3] memory callers = [alice, bob, multisig];
        for (uint256 c; c < callers.length; ++c) {
            address who = callers[c];
            _assertSoulbound(
                who, abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, bob, id)
            );
            _assertSoulbound(
                who, abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", alice, bob, id)
            );
            _assertSoulbound(
                who,
                abi.encodeWithSignature("safeTransferFrom(address,address,uint256,bytes)", alice, bob, id, "")
            );
            _assertSoulbound(who, abi.encodeWithSignature("approve(address,uint256)", bob, id));
            _assertSoulbound(who, abi.encodeWithSignature("setApprovalForAll(address,bool)", bob, true));
        }
        assertEq(reg.ownerOf(id), alice);
        assertEq(reg.balanceOf(alice), 1);
        assertEq(reg.balanceOf(bob), 0);
        assertEq(reg.getApproved(id), address(0));
        assertFalse(reg.isApprovedForAll(alice, bob));
        // the origin still cannot mint a second mirror, and the original record is unchanged
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        a.nonce = 5;
        bytes memory sig = _sign(ATT_PK, a);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RWAllyAgentRegistry.AlreadyMirrored.selector, id));
        reg.mintMirrored(a, URI, sig);
        (uint256 oc, address orr, uint256 oid) = reg.originOf(id);
        assertEq(oc, ORIGIN);
        assertEq(orr, address(reg));
        assertEq(oid, 7);
    }

    /// ERC-5192 on a mirror: `locked` is true, the interface is advertised, and `Locked(id)` is emitted
    /// once, second in the log order (after Transfer), as for `register`.
    function test_mirror_lockedTrue_andLockedEventEmittedAtMint() public {
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes memory sig = _sign(ATT_PK, a);
        vm.recordLogs();
        vm.prank(alice);
        uint256 id = reg.mintMirrored(a, URI, sig);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 6, "Transfer, Locked, MetadataUpdate, Registered, MetadataSet, Mirrored");
        assertEq(logs[0].topics[0], Transfer.selector);
        assertEq(logs[1].topics[0], Locked.selector);
        assertEq(abi.decode(logs[1].data, (uint256)), id);
        assertEq(logs[1].emitter, address(reg));
        assertTrue(reg.locked(id));
        assertTrue(reg.supportsInterface(0xb45a3c0e));
        vm.expectRevert();
        reg.locked(id + 1);
    }

    /// The attestor is an owner-set address, not an agent's account: its signature is ECDSA or a call
    /// to a contract that already exists. An ERC-6492 wrapper from a counterfactual (undeployed)
    /// attestor is refused, and the factory in it is never called.
    function test_attestor_counterfactualAccount_erc6492Wrapper_isRefused() public {
        Factory6492 f = new Factory6492();
        bytes32 salt = keccak256("cf-attestor");
        address cf = f.predict(salt);
        vm.prank(multisig);
        reg.setAttestor(cf);
        RWAllyAgentRegistry.MirrorAttestation memory a = _att(7, alice, URI);
        bytes32 d = reg.mirrorAttestationDigest(a);
        bytes memory inner = hex"aabbcc";
        bytes4 q = 0x64926492;
        bytes memory sig = abi.encodePacked(
            abi.encode(address(f), abi.encodeCall(Factory6492.deploy, (salt, d, inner)), inner),
            q, q, q, q, q, q, q, q
        );
        assertEq(cf.code.length, 0, "not deployed");
        _expect(RWAllyAgentRegistry.InvalidAttestorSignature.selector);
        vm.prank(alice);
        reg.mintMirrored(a, URI, sig);
        assertEq(f.calls(), 0, "the factory was not called");
        assertEq(cf.code.length, 0, "nothing deployed");
        (bool minted,) = reg.localIdOfOrigin(ORIGIN, address(reg), 7);
        assertFalse(minted);
    }

    function _assertSoulbound(address caller, bytes memory data) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(reg).call(data);
        assertFalse(ok);
        assertEq(ret.length, 4);
        assertEq(bytes4(ret), RWAllyAgentRegistry.Soulbound.selector);
    }
}

/// The typed-data vector below was produced by viem's `signTypedData`/`hashTypedData`
/// (scripts/lib/registry-attestation.mjs) and is re-derived by
/// scripts/test/registry-attestation.test.mjs, which also fails if these literals drift from what viem
/// computes. It pins the typehash, the field order and the domain against an implementation that does
/// not share this contract's assumptions.
contract RWAllyAgentRegistryMirrorVectorTest is RegistryTestBase {
    uint256 constant ATT_PK = 0xa77e57ed;
    address constant VECTOR_REGISTRY = 0x1234567890123456789012345678901234567890;
    address constant VECTOR_OWNER = 0x2222222222222222222222222222222222222222;
    address constant VECTOR_ATTESTOR = 0x881DAFc9dA43AFa62cC3D41bF373ebEE712c3F9e;
    bytes32 constant VECTOR_DIGEST = 0xa4b9c9897a2f0df5bc16c43c44760de1041874fd4f46551119f95f5999d0e0d6;
    bytes constant VECTOR_SIG =
        hex"f0d3d7cf607af95a6e58f483ceec64a7b95439ecb003e56c03816be7ccce528a2a5cbe9e32e4d37c98a188dd9f6a3fa47a9c4a97dfc2fd605d02a96cbfa8558b1b";

    function _vectorRegistry() internal returns (RWAllyAgentRegistry r) {
        vm.warp(1_800_000_000);
        vm.chainId(8453);
        vm.etch(VECTOR_REGISTRY, address(new RWAllyAgentRegistry()).code);
        r = RWAllyAgentRegistry(VECTOR_REGISTRY);
        MockERC20 usdc = new MockERC20("USDC", 6);
        vm.prank(r.INITIALIZER());
        r.initialize(multisig, address(usdc), treasury, 0, address(0), 0, VECTOR_ATTESTOR);
    }

    function _vectorStruct() internal pure returns (RWAllyAgentRegistry.MirrorAttestation memory) {
        return RWAllyAgentRegistry.MirrorAttestation({
            originChainId: 5042,
            originRegistry: VECTOR_REGISTRY,
            originAgentId: 7,
            owner: VECTOR_OWNER,
            agentURIHash: keccak256(bytes("ipfs://vector")),
            expiry: 1_800_003_600,
            nonce: 26_639_726
        });
    }

    function test_vector_attestorKeyIsTheViemAddress() public pure {
        assertEq(vm.addr(ATT_PK), VECTOR_ATTESTOR);
    }

    function test_vector_digestMatchesViem() public {
        RWAllyAgentRegistry r = _vectorRegistry();
        assertEq(r.mirrorAttestationDigest(_vectorStruct()), VECTOR_DIGEST);
    }

    function test_vector_viemSignatureIsAcceptedByTheContract() public {
        RWAllyAgentRegistry r = _vectorRegistry();
        vm.prank(VECTOR_OWNER);
        uint256 id = r.mintMirrored(_vectorStruct(), "ipfs://vector", VECTOR_SIG);
        assertEq(r.ownerOf(id), VECTOR_OWNER);
    }

    function test_vector_sameStructOnAnotherChainHasAnotherDigest() public {
        RWAllyAgentRegistry r = _vectorRegistry();
        vm.chainId(42161);
        assertTrue(r.mirrorAttestationDigest(_vectorStruct()) != VECTOR_DIGEST);
    }
}
