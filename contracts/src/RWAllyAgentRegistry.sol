// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @title RWAllyAgentRegistry
/// @notice A fresh, minimal implementation of the ERC-8004 Identity Registry surface: an ERC-721
/// whose token is an agent identity, with an agent URI, on-chain metadata and a designated agent
/// wallet. It is written against the ERC text and the reference registry's external interface
/// (https://eips.ethereum.org/EIPS/eip-8004), imports no third-party code, and shares no storage
/// layout with the canonical deployment. It is NOT the canonical ERC-8004 registry: the ids it
/// issues are its own, and an identity registered on another registry is not recognised here.
///
/// @dev REGISTRATION IS PERMISSIONLESS, as in ERC-8004. `register` mints to `msg.sender` and
/// checks nothing about the caller, so holding an identity here is a registration, not evidence of
/// who or what controls the address.
///
/// UPGRADEABILITY: none. The contract has no proxy, no `delegatecall`, no `selfdestruct` and no
/// code-replacement hook. Its code is fixed at deployment.
///
/// OWNER POWERS. The owner is one address, passed at construction and intended to be a multisig.
/// The complete list of what the owner address can do through this contract is:
///   1. `revoke(agentId)`: burn one identity. Clears that token's owner, approval, agent URI and
///      `agentWallet`, lowers the holder's balance by one, emits `Transfer(holder, 0, id)` and
///      `Revoked`. The id is never reissued. This exists so that an identity that falsely claims to
///      be protocol-operated can be removed from the pinned registry.
///   2. `transferOwnership(newOwner)`: nominate a successor. Takes effect only when that address
///      calls `acceptOwnership`; the nomination can be replaced or cleared (nominate address(0))
///      by the owner at any time before acceptance.
///   3. `renounceOwnership()`: set the owner to address(0), after which power 1 can never be
///      exercised again.
/// The owner address holds no other privileged entry point. Specifically, there is no function by
/// which the owner registers, transfers, approves, re-points or edits another holder's identity,
/// URI, metadata or agent wallet, pauses or gates registration, changes the name, symbol or
/// version, upgrades or replaces code, or receives or moves any asset (the contract holds none and
/// has no payable function). Revocation affects only whether an address still holds an identity
/// token here; a contract that reads this registry's `balanceOf` sees the holder's balance fall.
/// The owner's address is public in `owner()`; changing the multisig's signers or threshold happens
/// inside the multisig and is invisible to this contract.
///
/// Ids start at 0 and increase by one, as in the reference registry.
contract RWAllyAgentRegistry {
    // ───────────────────────────── types ─────────────────────────────

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    // ───────────────────────────── events ────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataUpdate(uint256 _tokenId); // ERC-4906, emitted whenever an agent URI is written
    event Revoked(uint256 indexed agentId, address indexed holder);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ───────────────────────────── errors ────────────────────────────

    error ERC721InvalidOwner(address owner);
    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner);
    error ERC721InvalidReceiver(address receiver);
    error ERC721InsufficientApproval(address operator, uint256 tokenId);
    error ERC721InvalidApprover(address approver);
    error ERC721InvalidOperator(address operator);
    error NotAuthorized();
    error ReservedKey();
    error BadWallet();
    error Expired();
    error DeadlineTooFar();
    error InvalidWalletSignature();
    error NotOwner();
    error NotPendingOwner();
    error ZeroOwner();

    // ───────────────────────────── storage ───────────────────────────

    string public constant name = "AgentIdentity";
    string public constant symbol = "AGENT";

    /// @notice Address holding the three owner powers listed in the contract NatSpec.
    address public owner;
    /// @notice Address nominated by `transferOwnership`, not yet in office.
    address public pendingOwner;

    uint256 private _nextId;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _uris;
    mapping(uint256 => mapping(string => bytes)) private _metadata;

    bytes32 private constant AGENT_WALLET_KEY_HASH = keccak256("agentWallet");
    bytes32 private constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ERC8004IdentityRegistry");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes4 private constant ERC1271_MAGICVALUE = 0x1626ba7e;
    uint256 private constant MAX_DEADLINE_DELAY = 5 minutes;
    /// @dev secp256k1 group order / 2: signatures with a larger `s` are malleable twins and are refused.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ──────────────────────────── construction ────────────────────────

    /// @param owner_ the multisig that holds the owner powers. Not required to have code yet (a
    /// multisig may be deployed counterfactually); required to be nonzero.
    constructor(address owner_) {
        require(owner_ != address(0), ZeroOwner());
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, NotOwner());
        _;
    }

    // ───────────────────────────── owner powers ──────────────────────

    /// @notice Owner power 1: burn one identity. See the contract NatSpec for exactly what it clears.
    function revoke(uint256 agentId) external onlyOwner {
        address holder = _requireOwned(agentId);
        delete _approved[agentId];
        delete _uris[agentId];
        delete _metadata[agentId]["agentWallet"];
        unchecked {
            _balances[holder] -= 1;
        }
        delete _owners[agentId];
        emit Transfer(holder, address(0), agentId);
        emit Revoked(agentId, holder);
    }

    /// @notice Owner power 2, step one: nominate a successor (address(0) clears a nomination).
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Owner power 2, step two: the nominee takes office.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, NotPendingOwner());
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        delete pendingOwner;
    }

    /// @notice Owner power 3: give up the owner powers permanently.
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
        delete pendingOwner;
    }

    // ───────────────────────────── registration ──────────────────────

    function register() external returns (uint256 agentId) {
        agentId = _register("", false);
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _register(agentURI, true);
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId)
    {
        agentId = _nextId;
        _mintTo(msg.sender, agentURI, true);
        for (uint256 i; i < metadata.length; ++i) {
            require(keccak256(bytes(metadata[i].metadataKey)) != AGENT_WALLET_KEY_HASH, ReservedKey());
            _metadata[agentId][metadata[i].metadataKey] = metadata[i].metadataValue;
            emit MetadataSet(
                agentId, metadata[i].metadataKey, metadata[i].metadataKey, metadata[i].metadataValue
            );
        }
        _checkReceiver(address(0), msg.sender, agentId, "");
    }

    function _register(string memory agentURI, bool hasUri) private returns (uint256 agentId) {
        agentId = _nextId;
        _mintTo(msg.sender, agentURI, hasUri);
        _checkReceiver(address(0), msg.sender, agentId, "");
    }

    /// @dev State first, receiver callback last (the caller then runs with the identity in place).
    function _mintTo(address to, string memory agentURI, bool hasUri) private {
        uint256 agentId = _nextId++;
        _owners[agentId] = to;
        unchecked {
            _balances[to] += 1;
        }
        if (hasUri) _uris[agentId] = agentURI;
        _metadata[agentId]["agentWallet"] = abi.encodePacked(to);
        emit Transfer(address(0), to, agentId);
        if (hasUri) emit MetadataUpdate(agentId);
        emit Registered(agentId, agentURI, to);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(to));
    }

    // ───────────────────────────── agent data ────────────────────────

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        return _metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        _requireAuthorized(agentId);
        require(keccak256(bytes(metadataKey)) != AGENT_WALLET_KEY_HASH, ReservedKey());
        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _requireAuthorized(agentId);
        _uris[agentId] = newURI;
        emit MetadataUpdate(agentId);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    /// @notice The agent URI (ERC-721 `tokenURI`). Empty when none was set.
    function tokenURI(uint256 agentId) external view returns (string memory) {
        _requireOwned(agentId);
        return _uris[agentId];
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return address(bytes20(_metadata[agentId]["agentWallet"]));
    }

    /// @notice Designate `newWallet` as the agent wallet. `signature` is a 65-byte EIP-712 signature
    /// by `newWallet` (EOA) or an ERC-1271 signature accepted by it (contract wallet), over
    /// AgentWalletSet(agentId, newWallet, owner, deadline), valid for at most five minutes.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        address holder = _requireAuthorized(agentId);
        require(newWallet != address(0), BadWallet());
        require(block.timestamp <= deadline, Expired());
        require(deadline <= block.timestamp + MAX_DEADLINE_DELAY, DeadlineTooFar());

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))),
                keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, holder, deadline))
            )
        );
        if (_recover(digest, signature) != newWallet) {
            (bool ok, bytes memory res) =
                newWallet.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
            require(
                ok && res.length >= 32 && abi.decode(res, (bytes4)) == ERC1271_MAGICVALUE,
                InvalidWalletSignature()
            );
        }
        _metadata[agentId]["agentWallet"] = abi.encodePacked(newWallet);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(newWallet));
    }

    function unsetAgentWallet(uint256 agentId) external {
        _requireAuthorized(agentId);
        _metadata[agentId]["agentWallet"] = "";
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        return _isAuthorized(_requireOwned(agentId), spender, agentId);
    }

    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }

    // ───────────────────────────── ERC-721 ───────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 Metadata
            || interfaceId == 0x49064906; // ERC-4906 metadata update
    }

    function balanceOf(address holder) external view returns (uint256) {
        require(holder != address(0), ERC721InvalidOwner(address(0)));
        return _balances[holder];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _requireOwned(tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        _requireOwned(tokenId);
        return _approved[tokenId];
    }

    function isApprovedForAll(address holder, address operator) public view returns (bool) {
        return _operatorApprovals[holder][operator];
    }

    function approve(address to, uint256 tokenId) external {
        address holder = _requireOwned(tokenId);
        require(
            msg.sender == holder || isApprovedForAll(holder, msg.sender), ERC721InvalidApprover(msg.sender)
        );
        _approved[tokenId] = to;
        emit Approval(holder, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != address(0), ERC721InvalidOperator(address(0)));
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(to != address(0), ERC721InvalidReceiver(address(0)));
        address holder = _requireOwned(tokenId);
        require(holder == from, ERC721IncorrectOwner(from, tokenId, holder));
        require(_isAuthorized(holder, msg.sender, tokenId), ERC721InsufficientApproval(msg.sender, tokenId));
        delete _approved[tokenId];
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[tokenId] = to;
        // The designated wallet belongs to the previous holder's verification and must be re-proved.
        _metadata[tokenId]["agentWallet"] = "";
        emit MetadataSet(tokenId, "agentWallet", "agentWallet", "");
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        _checkReceiver(from, to, tokenId, data);
    }

    // ───────────────────────────── internals ─────────────────────────

    function _requireOwned(uint256 tokenId) private view returns (address holder) {
        holder = _owners[tokenId];
        require(holder != address(0), ERC721NonexistentToken(tokenId));
    }

    function _isAuthorized(address holder, address spender, uint256 tokenId) private view returns (bool) {
        return spender == holder || _operatorApprovals[holder][spender] || _approved[tokenId] == spender;
    }

    function _requireAuthorized(uint256 agentId) private view returns (address holder) {
        holder = _requireOwned(agentId);
        require(_isAuthorized(holder, msg.sender, agentId), NotAuthorized());
    }

    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 magic) {
            require(magic == IERC721Receiver.onERC721Received.selector, ERC721InvalidReceiver(to));
        } catch {
            revert ERC721InvalidReceiver(to);
        }
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
