// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoundedCall} from "./lib/BoundedCall.sol";
import {PROTOCOL_INITIALIZER} from "./lib/ProtocolInitializer.sol";

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title RWAllyAgentRegistry
/// @notice A fresh, minimal implementation of the ERC-8004 Identity Registry surface: an ERC-721
/// whose token is an agent identity, with an agent URI, on-chain metadata and a designated agent
/// wallet. Every identity is soulbound (ERC-5192): it is minted to its holder and can never be
/// transferred or approved to anyone else. It is written against the ERC text and the reference registry's external interface
/// (https://eips.ethereum.org/EIPS/eip-8004), imports no third-party code, and shares no storage
/// layout with the canonical deployment. It is NOT the canonical ERC-8004 registry: the ids it
/// issues are its own, and an identity registered on another registry is recognised here only
/// through `importAgent`, during the import window.
///
/// @dev REGISTRATION IS OPEN AND PAID. `register` mints to `msg.sender` and checks nothing about the
/// caller beyond the fee: it pulls a flat `fee` of the fee token from the caller straight to the
/// treasury (`transferFrom(msg.sender, treasury, fee)`, return value checked), so the registry never
/// holds funds. The fee is set by the owner and can never exceed `MAX_FEE` (100 USDC, 100_000_000
/// raw units of a 6-decimal token), a constant in the bytecode. It is charged once, at registration;
/// a later fee change touches no existing identity. Holding an identity here is a registration, not
/// evidence of who or what controls the address.
///
/// IMPORT WINDOW. For `IMPORT_WINDOW` (30 days) after `initialize`, a holder of an identity on the
/// outside ERC-8004 registry named at initialization can claim one free identity here per outside
/// id with `importAgent`, only for outside ids below `importIdCeiling`. The ceiling is a value
/// snapshotted per chain at a block recorded before the deploy is announced
/// (`contracts/config/agent-registry-create2.json`, `importCeilings`), so ids minted on the free
/// outside registry after that block do not qualify; ids minted before it are not excluded. The
/// check is a gas-bounded
/// `ownerOf(externalAgentId)` static call that must return `msg.sender` exactly (never an agent
/// wallet or an approved operator). After the window closes the outside registry is never called.
/// Each import records its origin (chain id, outside registry, outside id), readable with
/// `originOf(localId)`, and one origin can mint at most once.
///
/// SAME ADDRESS ON EVERY CHAIN. There are no constructor arguments, so the creation code, and
/// therefore the CREATE2 address through the same factory and salt, is identical on every chain.
/// Per-chain configuration is supplied once through `initialize`, callable only by `INITIALIZER`.
/// Until it is called, `register` and `importAgent` revert and nobody holds any owner power.
/// `INITIALIZER` is the owner-held protocol deployer key (0x0f80...9f35), used for `initialize`
/// only through the owner's sign queue. Whoever holds that key can initialize any chain where the
/// registry is deployed and not yet initialized, with their own treasury; the key has no power on
/// an initialized chain. If it is lost, no new chain can be initialized at this address (a new
/// address is needed there) and nothing changes on chains already initialized.
///
/// SOULBOUND (ERC-5192). `locked(id)` is true for every minted id and `Locked(id)` is emitted at every
/// mint. `transferFrom`, both `safeTransferFrom` overloads, `approve` and `setApprovalForAll` always
/// revert with `Soulbound`; `getApproved` is always the zero address and `isApprovedForAll` always
/// false. There is no approved party and no operator: only the holder can write the identity's URI,
/// metadata and agent wallet. One address may hold any number of identities, and registers one per
/// call. An identity is lost only by losing the wallet that holds it; nothing in this contract, the
/// owner included, can move, burn or re-assign one.
///
/// UPGRADEABILITY: none. The contract has no proxy, no `delegatecall`, no `selfdestruct` and no
/// code-replacement hook. Its code is fixed at deployment.
///
/// OWNER POWERS. The owner is one address, set by `initialize` and intended to be a multisig. The
/// complete list of what the owner address can do through this contract is:
///   1. `setFee(newFee)`: set the registration fee, at most `MAX_FEE`; emits `FeeChanged(old, new)`.
///   2. `setTreasury(newTreasury)`: set the address that receives fees, nonzero and not this
///      contract; emits `TreasuryChanged(old, new)`. The registry does not check that the fee
///      token will accept a transfer to the new treasury (see the paragraph after this list).
///   3. `transferOwnership(newOwner)` then the nominee's `acceptOwnership()`: two-step handover. The
///      nomination can be replaced or cleared (nominate address(0)) by the owner before acceptance.
///   4. `renounceOwnership()`: set the owner to address(0), which freezes the fee and the treasury
///      at their current values for good.
/// There is no function by which the owner removes, registers, transfers, approves, re-points or
/// edits any identity, URI, metadata or agent wallet, changes the name, symbol or version,
/// upgrades or replaces code, or moves any asset (the contract has no payable function, and it pulls
/// each fee straight to the treasury; a fee token sent to the registry directly has no way out, because
/// no function transfers a token from the registry). The owner's address is public in `owner()`; changing the multisig's signers
/// or threshold happens inside the multisig and is invisible here.
///
/// THE OWNER CANNOT PAUSE REGISTRATION DIRECTLY, BUT CAN HALT PAID REGISTRATION INDIRECTLY. There is
/// no pause switch. However `setTreasury` accepts any nonzero address other than this contract, and
/// `register` pulls the fee to the treasury with `transferFrom(msg.sender, treasury, fee)`. If the
/// owner sets the treasury to an address the fee token refuses (for example an address on USDC's
/// blocklist), every `register` overload reverts with `FeeNotPaid` while the fee is nonzero, until
/// the treasury is changed again. `importAgent`, metadata and agent-wallet
/// writes, and every vault exit do not touch the treasury and are unaffected; with a fee of zero
/// the token is never called. After `renounceOwnership` the treasury is fixed for good: if it was
/// refused at that moment, paid registration stays halted permanently, and if it was accepted it
/// stays accepted unless the fee token later refuses it. The owner can also raise the fee to
/// `MAX_FEE` in one transaction.
///
/// KNOWN LIMITATION, NO MAX-FEE ARGUMENT. `register` takes no maximum-fee argument, so a registrant
/// is charged whatever the fee is when the transaction lands, up to `MAX_FEE` (100 USDC). Approve the
/// exact current fee, not more, and read `fee()` immediately before registering.
///
/// Ids start at 0 and increase by one, as in the reference registry.
contract RWAllyAgentRegistry {
    using BoundedCall for address;

    // ───────────────────────────── types ─────────────────────────────

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    // ───────────────────────────── events ────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    /// @dev ERC-5192: emitted once per identity, at its mint. `Unlocked` is declared by the ERC but
    /// is never emitted here, because an identity is never unlocked.
    event Locked(uint256 tokenId);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataUpdate(uint256 _tokenId); // ERC-4906, emitted whenever an agent URI is written
    event Imported(uint256 indexed agentId, uint256 indexed externalAgentId, address indexed holder);
    event Initialized(
        address indexed owner,
        address indexed feeToken,
        address indexed treasury,
        uint256 fee,
        address outsideRegistry,
        uint256 importIdCeiling,
        uint256 importEnd
    );
    event FeeChanged(uint256 oldFee, uint256 newFee);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ───────────────────────────── errors ────────────────────────────

    error ERC721InvalidOwner(address owner);
    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721InvalidReceiver(address receiver);
    /// @dev Every transfer and approval entry point reverts with this: an identity is soulbound.
    error Soulbound();
    error NotAuthorized();
    error ReservedKey();
    error BadWallet();
    error Expired();
    error DeadlineTooFar();
    error InvalidWalletSignature();
    error NotOwner();
    error NotPendingOwner();
    error ZeroOwner();
    error NotInitializer();
    error AlreadyInitialized();
    error NotInitialized();
    error BadFeeToken();
    error BadTreasury();
    error BadOutsideRegistry();
    error FeeTooHigh(uint256 fee);
    error FeeNotPaid();
    error ImportClosed();
    error ImportIdNotEligible(uint256 externalAgentId);
    error AlreadyImported(uint256 externalAgentId);
    error NotOutsideOwner();

    // ───────────────────────────── storage ───────────────────────────

    string public constant name = "AgentIdentity";
    string public constant symbol = "AGENT";

    /// @notice The only address that can call `initialize`, once: the protocol-wide
    /// {PROTOCOL_INITIALIZER}, the owner-held deployer key used only through the owner's sign queue
    /// and the same constant that gates the protocol singletons (recorded in
    /// `contracts/config/agent-registry-create2.json`).
    address public constant INITIALIZER = PROTOCOL_INITIALIZER;
    /// @notice Hard cap on the registration fee: 100 USDC in raw units of a 6-decimal token.
    uint256 public constant MAX_FEE = 100_000_000;
    /// @notice How long after `initialize` the free import window stays open.
    uint256 public constant IMPORT_WINDOW = 30 days;
    /// @dev Gas allowance for the outside registry's `ownerOf`, the same figure and style as
    /// VaultCore's MODULE_CALL_GAS.
    uint256 private constant OUTSIDE_CALL_GAS = 300_000;

    /// @notice Address holding the owner powers listed in the contract NatSpec. Zero until
    /// `initialize`, and again after `renounceOwnership`.
    address public owner;
    /// @notice Address nominated by `transferOwnership`, not yet in office.
    address public pendingOwner;
    /// @notice True once `initialize` has run. `register` and `importAgent` revert until then.
    bool public initialized;
    /// @notice ERC-20 (6 decimals) the registration fee is paid in.
    address public feeToken;
    /// @notice Receives every registration fee directly from the registrant.
    address public treasury;
    /// @notice Current flat registration fee in raw units of `feeToken`, at most `MAX_FEE`.
    uint256 public fee;
    /// @notice The outside ERC-8004 registry consulted by `importAgent`, or zero for no import window.
    address public outsideRegistry;
    /// @notice Outside ids strictly below this value may be imported.
    uint256 public importIdCeiling;
    /// @notice Timestamp at which the import window closes. Zero when there is no outside registry.
    uint256 public importEnd;

    struct Origin {
        uint256 chainId;
        address registry;
        uint256 agentId;
    }

    /// @dev local id => where an imported identity came from; all zero for a registered one.
    mapping(uint256 => Origin) private _origins;
    /// @dev keccak256(abi.encode(originChainId, originRegistry, originAgentId)) => local id + 1.
    mapping(bytes32 => uint256) private _importedAs;

    uint256 private _nextId;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
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
    /// @dev ERC-6492 magic suffix: a signature ending in these 32 bytes is a wrapped
    /// `abi.encode(factory, factoryCalldata, innerSignature)` from a not-yet-deployed smart account.
    bytes32 private constant ERC6492_SUFFIX =
        0x6492649264926492649264926492649264926492649264926492649264926492;
    /// @dev How far ahead a wallet's signed consent may be dated. One hour, not the five minutes of the
    /// reference registry: a smart account (ERC-4337) signs its consent when the user operation is built,
    /// and that operation may then wait in a bundler mempool for a low fee to clear, so five minutes
    /// expires it before it lands. The consent only designates a wallet for one agent id and one holder
    /// (all three are in the signed digest) and is replayable only by that holder, but it has no nonce and
    /// no revocation, so it can be replayed by that holder until its deadline, and the hour lengthens that
    /// window twelve times against five minutes. The authority it confers is unchanged (the same wallet
    /// for the same id by the same holder); an hour bounds how long a stale consent stays usable and
    /// still clears a congested mempool.
    uint256 private constant MAX_DEADLINE_DELAY = 1 hours;
    /// @dev secp256k1 group order / 2: signatures with a larger `s` are malleable twins and are refused.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ──────────────────────────── initialization ──────────────────────

    /// @notice One-shot per-chain configuration. Only `INITIALIZER`, only once.
    /// @param owner_ the multisig that holds the owner powers; nonzero.
    /// @param feeToken_ the fee token; must have code and report `decimals() == 6`.
    /// @param treasury_ where fees go; nonzero and not this contract.
    /// @param initialFee the starting fee, at most `MAX_FEE`; zero is allowed.
    /// @param outsideRegistry_ the outside ERC-8004 registry to import from, or zero for no import
    /// window; if nonzero it must have code.
    /// @param importIdCeiling_ outside ids strictly below this qualify for import. Typed by the
    /// initializer: the outside registry has no next-id view, so it is the value snapshotted for
    /// this chain at the recorded block (`importCeilings` in the CREATE2 record), not a fresh read at
    /// initialize time; it must be zero when there is no outside registry.
    function initialize(
        address owner_,
        address feeToken_,
        address treasury_,
        uint256 initialFee,
        address outsideRegistry_,
        uint256 importIdCeiling_
    ) external {
        require(msg.sender == INITIALIZER, NotInitializer());
        require(!initialized, AlreadyInitialized());
        initialized = true;
        require(owner_ != address(0), ZeroOwner());
        require(feeToken_.code.length > 0 && IERC20Decimals(feeToken_).decimals() == 6, BadFeeToken());
        require(treasury_ != address(0) && treasury_ != address(this), BadTreasury());
        require(initialFee <= MAX_FEE, FeeTooHigh(initialFee));
        require(
            outsideRegistry_ == address(0) ? importIdCeiling_ == 0 : outsideRegistry_.code.length > 0,
            BadOutsideRegistry()
        );
        owner = owner_;
        feeToken = feeToken_;
        treasury = treasury_;
        fee = initialFee;
        outsideRegistry = outsideRegistry_;
        importIdCeiling = importIdCeiling_;
        uint256 end = outsideRegistry_ == address(0) ? 0 : block.timestamp + IMPORT_WINDOW;
        importEnd = end;
        emit OwnershipTransferred(address(0), owner_);
        emit Initialized(owner_, feeToken_, treasury_, initialFee, outsideRegistry_, importIdCeiling_, end);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, NotOwner());
        _;
    }

    modifier whenInitialized() {
        require(initialized, NotInitialized());
        _;
    }

    // ───────────────────────────── owner powers ──────────────────────

    /// @notice Owner power 1: set the registration fee, at most `MAX_FEE`.
    function setFee(uint256 newFee) external onlyOwner {
        require(newFee <= MAX_FEE, FeeTooHigh(newFee));
        emit FeeChanged(fee, newFee);
        fee = newFee;
    }

    /// @notice Owner power 2: set the fee recipient.
    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0) && newTreasury != address(this), BadTreasury());
        emit TreasuryChanged(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Owner power 3, step one: nominate a successor (address(0) clears a nomination).
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Owner power 3, step two: the nominee takes office.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, NotPendingOwner());
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        delete pendingOwner;
    }

    /// @notice Owner power 4: give up the owner powers permanently, freezing fee and treasury.
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
        delete pendingOwner;
    }

    // ───────────────────────────── registration ──────────────────────

    function register() external whenInitialized returns (uint256 agentId) {
        agentId = _register("", false);
    }

    function register(string calldata agentURI) external whenInitialized returns (uint256 agentId) {
        agentId = _register(agentURI, true);
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        whenInitialized
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
        _collectFee();
        _checkReceiver(address(0), msg.sender, agentId, "");
    }

    function _register(string memory agentURI, bool hasUri) private returns (uint256 agentId) {
        agentId = _nextId;
        _mintTo(msg.sender, agentURI, hasUri);
        _collectFee();
        _checkReceiver(address(0), msg.sender, agentId, "");
    }

    /// @notice Claim a free identity here for an identity you hold on the outside registry. Only
    /// while the import window is open, only for outside ids below `importIdCeiling`, once per
    /// outside id, and only if the outside registry's `ownerOf(externalAgentId)` is `msg.sender`.
    function importAgent(uint256 externalAgentId, string calldata agentURI)
        external
        whenInitialized
        returns (uint256 agentId)
    {
        require(block.timestamp < importEnd, ImportClosed());
        require(externalAgentId < importIdCeiling, ImportIdNotEligible(externalAgentId));
        bytes32 originKey = keccak256(abi.encode(block.chainid, outsideRegistry, externalAgentId));
        require(_importedAs[originKey] == 0, AlreadyImported(externalAgentId));
        (bool ok, uint256 word, uint256 retSize) = outsideRegistry.boundedStaticCall(
            abi.encodeWithSelector(0x6352211e, externalAgentId),
            OUTSIDE_CALL_GAS // ownerOf(uint256)
        );
        require(ok && retSize == 32 && word == uint256(uint160(msg.sender)), NotOutsideOwner());
        agentId = _nextId;
        _importedAs[originKey] = agentId + 1;
        _origins[agentId] = Origin(block.chainid, outsideRegistry, externalAgentId);
        _mintTo(msg.sender, agentURI, true);
        emit Imported(agentId, externalAgentId, msg.sender);
        _checkReceiver(address(0), msg.sender, agentId, "");
    }

    /// @notice Where local identity `localId` was imported from: (chain id, outside registry, outside
    /// id). All zero for an identity that was registered here.
    function originOf(uint256 localId)
        external
        view
        returns (uint256 originChainId, address originRegistry, uint256 originAgentId)
    {
        Origin storage o = _origins[localId];
        return (o.chainId, o.registry, o.agentId);
    }

    /// @notice The local identity that an origin was imported as, if any.
    function localIdOfOrigin(uint256 originChainId, address originRegistry, uint256 originAgentId)
        external
        view
        returns (bool imported, uint256 localId)
    {
        uint256 v = _importedAs[keccak256(abi.encode(originChainId, originRegistry, originAgentId))];
        return (v != 0, v == 0 ? 0 : v - 1);
    }

    /// @dev Pulls `fee` from the registrant straight to the treasury. A token that returns nothing
    /// counts as success only if the call succeeded; a token that returns data must return true.
    /// The fee token must still have code at pull time: a call to an address without code succeeds
    /// with no returndata, which would otherwise read as a paid fee.
    function _collectFee() private {
        uint256 f = fee;
        if (f == 0) return;
        address token = feeToken;
        require(token.code.length > 0, FeeNotPaid());
        (bool ok, uint256 word, uint256 retSize) = token.boundedCall(
            abi.encodeWithSelector(0x23b872dd, msg.sender, treasury, f),
            gasleft() // transferFrom
        );
        require(ok && (retSize == 0 || (retSize >= 32 && word == 1)), FeeNotPaid());
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
        emit Locked(agentId);
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
    /// by `newWallet` (EOA), an ERC-1271 signature accepted by it (contract wallet), or an ERC-6492
    /// wrapped signature from a smart account that is not deployed yet (counterfactual), over
    /// AgentWalletSet(agentId, newWallet, owner, deadline), valid for at most `MAX_DEADLINE_DELAY`
    /// (one hour; see that constant for why).
    /// ERC-6492: when `newWallet` has no code, the wrapped factory call is made so the account exists,
    /// then the inner signature is checked by ERC-1271 as usual; when it already has code the factory is
    /// not called and only the inner signature is checked. The factory call is made by this contract
    /// with caller-chosen calldata, so the factory may not be this contract or the fee token. This
    /// contract is the spender of registrants' fee-token allowances, so a call to the fee token could
    /// spend one: a fee token with a transfer hook (`initialize` checks only that the token has code
    /// and `decimals() == 6`) could deploy `newWallet` from inside `transferFrom(victim, holder, amount)`,
    /// the code check after the call would then pass, and the holder would have spent a registrant's
    /// allowance. The `feeToken` half of the guard is what stops that, and a test builds exactly that
    /// token. USDC has no hooks. The `address(this)` half is belt and braces: no reachable effect is
    /// known. The call result is ignored: success is decided only by `newWallet` having code and
    /// accepting the inner signature afterwards.
    /// KNOWN LIMITATION: the ERC-1271 call to a contract `newWallet` has no gas allowance and no
    /// returndata bound. The caller (the holder) chooses
    /// `newWallet`, so a wallet that burns gas or returns a large payload costs only that caller;
    /// the call is a static call and cannot change state, and no other party is affected.
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
                domainSeparator(),
                keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, holder, deadline))
            )
        );
        if (_recover(digest, signature) != newWallet) {
            _requireContractSignature(newWallet, digest, signature);
        }
        _metadata[agentId]["agentWallet"] = abi.encodePacked(newWallet);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(newWallet));
    }

    /// @notice The EIP-712 domain separator, computed from the live `block.chainid` on every call (never
    /// cached), so a signature made for one chain is invalid on any other.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function unsetAgentWallet(uint256 agentId) external {
        _requireAuthorized(agentId);
        _metadata[agentId]["agentWallet"] = "";
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
    }

    /// @notice Whether `spender` is the holder of `agentId`, the only address that can write it: an
    /// identity has no operators and no approved party. Reverts for a nonexistent id. `address(0)` is
    /// never authorized, because the holder of a minted id is never the zero address.
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        return spender == _requireOwned(agentId);
    }

    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }

    // ───────────────────────────── ERC-721 ───────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 Metadata
            || interfaceId == 0x49064906 // ERC-4906 metadata update
            || interfaceId == 0xb45a3c0e; // ERC-5192 minimal soulbound
    }

    function balanceOf(address holder) external view returns (uint256) {
        require(holder != address(0), ERC721InvalidOwner(address(0)));
        return _balances[holder];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _requireOwned(tokenId);
    }

    /// @notice ERC-5192: true for every minted id, forever. Reverts for a nonexistent id, as
    /// `ownerOf` does.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    /// @notice Always the zero address for a minted id: approvals do not exist. Reverts for a
    /// nonexistent id, as ERC-721 requires.
    function getApproved(uint256 tokenId) external view returns (address) {
        _requireOwned(tokenId);
        return address(0);
    }

    /// @notice Always false: operators do not exist.
    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    /// @notice Always reverts `Soulbound`.
    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    /// @notice Always reverts `Soulbound`.
    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    /// @notice Always reverts `Soulbound`.
    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    /// @notice Always reverts `Soulbound`.
    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    /// @notice Always reverts `Soulbound`.
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    // ───────────────────────────── internals ─────────────────────────

    function _requireOwned(uint256 tokenId) private view returns (address holder) {
        holder = _owners[tokenId];
        require(holder != address(0), ERC721NonexistentToken(tokenId));
    }

    /// @dev Only the holder may write an identity.
    function _requireAuthorized(uint256 agentId) private view returns (address holder) {
        holder = _requireOwned(agentId);
        require(msg.sender == holder, NotAuthorized());
    }

    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 magic) {
            require(magic == IERC721Receiver.onERC721Received.selector, ERC721InvalidReceiver(to));
        } catch {
            revert ERC721InvalidReceiver(to);
        }
    }

    /// @dev ERC-1271 check, unwrapping an ERC-6492 signature first (deploying the account if needed).
    function _requireContractSignature(address wallet, bytes32 digest, bytes calldata signature) private {
        bytes memory inner = signature;
        uint256 len = signature.length;
        if (len >= 32 && bytes32(signature[len - 32:]) == ERC6492_SUFFIX) {
            address factory;
            bytes memory factoryCalldata;
            (factory, factoryCalldata, inner) = abi.decode(signature[:len - 32], (address, bytes, bytes));
            if (wallet.code.length == 0) {
                require(
                    factory != address(this) && factory != feeToken && factory.code.length > 0,
                    InvalidWalletSignature()
                );
                factory.call(factoryCalldata); // result ignored: the code check below decides
                require(wallet.code.length > 0, InvalidWalletSignature());
            }
        }
        (bool ok, bytes memory res) =
            wallet.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, inner)));
        require(
            ok && res.length >= 32 && abi.decode(res, (bytes4)) == ERC1271_MAGICVALUE,
            InvalidWalletSignature()
        );
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
