// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFeeEngine} from "./interfaces/IFeeEngine.sol";
import {IERC20Balance} from "./interfaces/IERC20Balance.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {PROTOCOL_INITIALIZER} from "./lib/ProtocolInitializer.sol";

interface IRegistryView {
    function operatorOf(address vault) external view returns (uint256);
    function carryOf(address member, uint256 opId) external view returns (uint256);
    function operatorAddressOf(uint256 opId) external view returns (address);
    function recordFeeCollected(uint256 opId, uint256 amountUsdc) external;
}

interface IVaultUsdc {
    function usdc() external view returns (address);
    function claimEscrowed(address asset) external;
    function claimable(address member, address asset) external view returns (uint256);
    function creator() external view returns (address);
}

/// @title FeeEngine — 10% performance fee on realized gain net of the registry loss carryforward
/// @notice Sprint 3 module. Crystallization happens ONLY at member redemption (CM-3): the
/// vault calls onRealize with the member's realized P&L, the engine nets it against the
/// (member, operator) loss carryforward read from the registry — PRE-update, the registry
/// consumes it afterward in the same settlement — and returns 10% of the net gain.
///
/// The vault may clamp the returned fee (hostile-module defense) and reports what it actually
/// transferred via onFeeCollected; recipients are credited strictly from collected amounts.
///
/// Fee model A1: of every collected fee the treasury is credited 10% (1% of the net gain), rounded
/// down, and the vault creator the remainder, 90% (9% of the net gain). The rate and the split
/// are constants, so they are the same on every chain; only the treasury address is per chain,
/// set once by {initialize}. There is no high-water mark on vault NAV: the fee is per member, at
/// exit, on realized gain after the loss carryforward. Until {initialize} lands `onRealize` returns 0, so no fee is taken and none
/// can reach this contract uncredited.
contract FeeEngine is IFeeEngine {
    using SafeTransferLib for address;

    uint256 public constant PERF_FEE_BPS = 1_000; // 10%
    uint256 internal constant BPS = 10_000;
    /// @notice The treasury's slice of every collected fee: 10% of the fee (1% of the net gain),
    /// rounded down. The vault creator receives the remainder (90% of the fee, 9% of the net gain).
    uint256 public constant TREASURY_SHARE_BPS = 1_000;

    IRegistryView public immutable registry;

    /// @notice RWAlly treasury, credited its share of every fee. Zero until {initialize}.
    address public treasury;

    /// @notice Collected fees awaiting claim: recipient (vault creator or treasury) ⇒ token ⇒ amount.
    mapping(address => mapping(address => uint256)) public claimableFees;

    /// @dev M-3: reentrancy mutex. `FeeEngine` had none, and it does NOT inherit VaultCore's:
    /// a nested `pullEscrowed` targets a DIFFERENT vault, so that vault's own guard is not on
    /// the path. See `pullEscrowed` for why the absence was exploitable.
    uint256 private _lock = 1;

    event FeeAssessed(address indexed vault, address indexed member, uint256 netGain, uint256 fee);
    event FeeCredited(uint256 indexed opId, address indexed token, uint256 amount);
    event FeeSplit(
        address indexed vault,
        address indexed token,
        address creator,
        uint256 creatorAmount,
        uint256 treasuryAmount
    );
    event Initialized(address indexed treasury);
    event FeesClaimed(address indexed recipient, address indexed token, uint256 amount);

    error UnattestedVault();
    error NothingToClaim();
    error Reentrancy();
    error OnlyInitializer();
    error AlreadyInitialized();
    error ZeroTreasury();
    error TreasuryNotSet();

    /// @dev Non-reentrant across the whole engine, not per-vault — the double-credit in M-3
    /// is precisely a cross-VAULT nesting, so a per-vault guard would not see it.
    modifier nonReentrant() {
        require(_lock == 1, Reentrancy());
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param registry_ the canonical OperatorRegistry (carry reads, identity, fee stats)
    constructor(IRegistryView registry_) {
        registry = registry_;
    }

    /// @notice One-shot, {PROTOCOL_INITIALIZER}-only: set this chain's treasury. A second call reverts.
    /// @param treasury_ the RWAlly treasury that receives {TREASURY_SHARE_BPS} of every fee; non-zero
    function initialize(address treasury_) external {
        require(msg.sender == PROTOCOL_INITIALIZER, OnlyInitializer());
        require(treasury == address(0), AlreadyInitialized());
        require(treasury_ != address(0), ZeroTreasury());
        treasury = treasury_;
        emit Initialized(treasury_);
    }

    /// @dev Credit `amount` of `token` collected from `vault`: the treasury gets the floored share,
    /// the vault creator the remainder, so the two parts always sum to `amount` exactly. Reverts
    /// {TreasuryNotSet} if the treasury is unset, which no honest vault can reach: {onRealize}
    /// returns no fee until {initialize}, so no tokens are sent here before it. Crediting the zero
    /// address instead would lock the treasury's slice for good.
    function _credit(address vault, address token, uint256 amount) internal {
        require(treasury != address(0), TreasuryNotSet());
        uint256 toTreasury = amount * TREASURY_SHARE_BPS / BPS;
        uint256 toCreator = amount - toTreasury;
        address creator = IVaultUsdc(vault).creator();
        claimableFees[creator][token] += toCreator;
        claimableFees[treasury][token] += toTreasury;
        emit FeeSplit(vault, token, creator, toCreator, toTreasury);
    }

    /// @inheritdoc IFeeEngine
    function onRealize(
        address member,
        uint256 gainUsdc,
        uint256 /*lossUsdc*/
    )
        external
        returns (uint256 feeUsdc)
    {
        uint256 opId = registry.operatorOf(msg.sender);
        require(opId != 0, UnattestedVault());
        // losses reach the carry via the vault's own registry call; nothing to do here

        // No treasury, no fee: nothing is withheld that could not be credited.
        if (gainUsdc > 0 && treasury != address(0)) {
            // Loss carryforward, not a NAV high-water mark: net the gain against the cross-vault
            // loss carryforward (§7). The registry consumes the carry right after this call in the
            // same vault settlement.
            uint256 carry = registry.carryOf(member, opId);
            uint256 netGain = gainUsdc > carry ? gainUsdc - carry : 0;
            feeUsdc = netGain * PERF_FEE_BPS / BPS;
            emit FeeAssessed(msg.sender, member, netGain, feeUsdc);
        }
    }

    /// @inheritdoc IFeeEngine
    function onFeeCollected(
        address,
        /* member */
        uint256 amountUsdc
    )
        external
    {
        uint256 opId = registry.operatorOf(msg.sender);
        require(opId != 0, UnattestedVault());
        address token = IVaultUsdc(msg.sender).usdc();
        _credit(msg.sender, token, amountUsdc);
        registry.recordFeeCollected(opId, amountUsdc);
        emit FeeCredited(opId, token, amountUsdc);
    }

    /// @inheritdoc IFeeEngine
    function onFeeCollectedAsset(
        address,
        /* member */
        address asset,
        uint256 amount
    )
        external
    {
        uint256 opId = registry.operatorOf(msg.sender);
        require(opId != 0, UnattestedVault());
        _credit(msg.sender, asset, amount);
        emit FeeCredited(opId, asset, amount);
        // Note: asset-leg fees are credited at token amounts; USD-terms fee reporting to the
        // registry stats happens on the cash leg only (indexer can price the asset legs, S7).
    }

    /// @notice Pull a fee slice (USDC or in-kind) that the vault escrowed after a failed transfer
    /// to this engine (VaultCore EE-6 path); {_credit} splits it between treasury and creator.
    ///
    /// @dev M-3 remediation. This function is permissionless and measures a balance delta
    /// STRADDLING a full-gas external call (`claimEscrowed`), which a hook token can re-enter.
    /// The engine had no mutex, and VaultCore's does not help because the nested call targets a
    /// DIFFERENT vault — a different instance, a different lock slot, not on this path.
    ///
    /// The arithmetic of the bug: an inner `pullEscrowed` completes first and correctly credits
    /// its own `X`; the outer frame then measures the whole delta `X + X2` and credits that too,
    /// so `2X + X2` is credited against `X + X2` actually delivered. Whoever claims first is
    /// paid from another recipient's balance. The precondition is attacker-controlled: escrow
    /// is populated only when `tryTransfer` returns false, which a hook token decides on demand.
    ///
    /// (The report notes ERC-777 specifically does NOT work here — this engine is not an
    /// ERC-1820 implementer — but that closes one hook mechanism, not the class.)
    /// @param vault the attested vault holding the escrowed fee slice
    /// @param asset the escrowed token; credit is the measured balance delta
    function pullEscrowed(address vault, address asset) external nonReentrant {
        uint256 opId = registry.operatorOf(vault);
        require(opId != 0, UnattestedVault());
        uint256 before = IERC20Balance(asset).balanceOf(address(this));
        IVaultUsdc(vault).claimEscrowed(asset);
        uint256 received = IERC20Balance(asset).balanceOf(address(this)) - before;
        if (received > 0) {
            _credit(vault, asset, received);
            emit FeeCredited(opId, asset, received);
        }
    }

    /// @notice A fee recipient (vault creator or treasury) claims its accumulated fees for a token.
    /// @dev Guarded too. The accounting here is already correct under reentrancy (the balance
    /// is zeroed BEFORE the transfer, so CEI holds), but leaving one unguarded entry point into
    /// a contract whose invariant is "credits match deliveries" invites the next composition.
    /// @param token USDC or a basket asset with a nonzero claimable balance for the caller
    function claimFees(address token) external nonReentrant {
        uint256 amt = claimableFees[msg.sender][token];
        require(amt > 0, NothingToClaim());
        claimableFees[msg.sender][token] = 0;
        token.safeTransfer(msg.sender, amt);
        emit FeesClaimed(msg.sender, token, amt);
    }
}
