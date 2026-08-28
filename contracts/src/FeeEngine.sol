// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IFeeEngine} from "./interfaces/IFeeEngine.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";

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
}

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

/// @title FeeEngine — 10% performance fee on realized profit, HWM via registry carryforward
/// @notice Sprint 3 module. Crystallization happens ONLY at member redemption (CM-3): the
/// vault calls onRealize with the member's realized P&L, the engine nets it against the
/// (member, operator) loss carryforward read from the registry — PRE-update, the registry
/// consumes it afterward in the same settlement — and returns 10% of the net gain.
///
/// The vault may clamp the returned fee (hostile-module defense) and reports what it actually
/// transferred via onFeeCollected; operators are credited strictly from collected amounts.
contract FeeEngine is IFeeEngine {
    using SafeTransferLib for address;

    uint256 public constant PERF_FEE_BPS = 1_000; // 10%
    uint256 internal constant BPS = 10_000;

    IRegistryView public immutable registry;

    /// @notice Collected fees awaiting operator claim: operator address ⇒ token ⇒ amount.
    mapping(address => mapping(address => uint256)) public claimableFees;

    /// @dev M-3: reentrancy mutex. `FeeEngine` had none, and it does NOT inherit VaultCore's:
    /// a nested `pullEscrowed` targets a DIFFERENT vault, so that vault's own guard is not on
    /// the path. See `pullEscrowed` for why the absence was exploitable.
    uint256 private _lock = 1;

    event FeeAssessed(address indexed vault, address indexed member, uint256 netGain, uint256 fee);
    event FeeCredited(uint256 indexed opId, address indexed token, uint256 amount);
    event FeesClaimed(address indexed operator, address indexed token, uint256 amount);

    error UnattestedVault();
    error NothingToClaim();
    error Reentrancy();

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

        if (gainUsdc > 0) {
            // HWM: net the gain against the cross-vault loss carryforward (§7). The registry
            // consumes the carry right after this call in the same vault settlement.
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
        claimableFees[registry.operatorAddressOf(opId)][token] += amountUsdc;
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
        claimableFees[registry.operatorAddressOf(opId)][asset] += amount;
        emit FeeCredited(opId, asset, amount);
        // Note: asset-leg fees are credited at token amounts; USD-terms fee reporting to the
        // registry stats happens on the cash leg only (indexer can price the asset legs, S7).
    }

    /// @notice Pull an in-kind fee slice that the vault escrowed after a failed transfer to
    /// this engine (VaultCore EE-6 path), and credit it to the vault's operator.
    ///
    /// @dev M-3 remediation. This function is permissionless and measures a balance delta
    /// STRADDLING a full-gas external call (`claimEscrowed`), which a hook token can re-enter.
    /// The engine had no mutex, and VaultCore's does not help because the nested call targets a
    /// DIFFERENT vault — a different instance, a different lock slot, not on this path.
    ///
    /// The arithmetic of the bug: an inner `pullEscrowed` completes first and correctly credits
    /// its own `X`; the outer frame then measures the whole delta `X + X2` and credits that too,
    /// so `2X + X2` is credited against `X + X2` actually delivered. Whoever claims first is
    /// paid from the other operator's balance. The precondition is attacker-controlled: escrow
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
            claimableFees[registry.operatorAddressOf(opId)][asset] += received;
            emit FeeCredited(opId, asset, received);
        }
    }

    /// @notice Operator claims accumulated performance fees for a settlement token.
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
