// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IOperatorRegistry} from "./interfaces/IOperatorRegistry.sol";

/// @title OperatorRegistry — operator identity, cross-vault marks, aggregate leaderboard
/// @notice Sprint 3 module, the C-3 load-bearing reference. Three requirements meet here:
///
/// 1. **HWM portability (§7):** the per-(member, operator) USDC loss carryforward. A member
///    who realized a loss under an operator in vault A pays no performance fee under that
///    operator in vault B until made whole. Carry mutates ONLY through attested vaults.
/// 2. **Leaderboard integrity (SF-4/SF-5):** lifetime gain/loss accumulators per operator,
///    aggregated across ALL attested vaults, monotone — closed vaults' history is retained,
///    wind-downs recorded. No cherry-picking is possible because nothing ever decrements.
/// 3. **Anti-Sybil (CM-4):** identity is the registry id. A fresh identity escapes its loss
///    carry but restarts at zero track record — visible and reputation-costly by construction.
///
/// Only vaults deployed by the canonical factory are attested (CM-5): carry and leaderboard
/// ignore everything else, so throwaway-vault mark-farming requires real, visible vaults.
contract OperatorRegistry is IOperatorRegistry {
    address public factory; // one-shot wiring (deploy-time only, not an admin power)
    address public immutable deployer;

    uint256 public operatorCount;
    mapping(address => uint256) public operatorIdOf; // 0 = unregistered
    mapping(uint256 => address) public operatorAddressOf;

    mapping(address => uint256) internal _vaultOperator; // vault ⇒ opId (0 = unattested)

    /// @notice USDC-denominated loss carryforward per (member, operatorId) — the portable HWM.
    mapping(address => mapping(uint256 => uint256)) public carryOf;

    struct OperatorStats {
        uint256 lifetimeGainUsdc; // Σ realized member gains across all attested vaults
        uint256 lifetimeLossUsdc; // Σ realized member losses across all attested vaults
        uint256 lifetimeFeesUsdc; // Σ performance fees actually collected
        uint256 vaultCount; // vaults ever attested (never decremented — SF-5)
    }

    mapping(uint256 => OperatorStats) public statsOf;

    address public feeEngine; // one-shot wiring; only caller allowed to record fee collection

    event FactorySet(address indexed factory);
    event FeeEngineSet(address indexed feeEngine);
    event OperatorRegistered(uint256 indexed opId, address indexed operator);
    event VaultAttested(address indexed vault, uint256 indexed opId);
    event RealizationRecorded(
        address indexed vault,
        uint256 indexed opId,
        address indexed member,
        uint256 gainUsdc,
        uint256 lossUsdc,
        uint256 carryAfter
    );
    event FeeRecorded(uint256 indexed opId, uint256 amountUsdc);

    error OnlyDeployer();
    error ZeroAddress();
    error AlreadyWired();
    error OnlyFactory();
    error OnlyFeeEngine();
    error OnlyAttestedVault();
    error AlreadyOperator();
    error NotOperator();

    constructor() {
        deployer = msg.sender;
    }

    /// @notice One-shot deploy-time wiring. Immutable thereafter — not an ongoing admin power.
    /// @param factory_ the canonical VaultFactory (sole attestation caller)
    /// @param feeEngine_ the FeeEngine (sole fee-stat recorder)
    function wire(address factory_, address feeEngine_) external {
        require(msg.sender == deployer, OnlyDeployer());
        require(factory == address(0) && feeEngine == address(0), AlreadyWired());
        require(factory_ != address(0) && feeEngine_ != address(0), ZeroAddress());
        factory = factory_;
        feeEngine = feeEngine_;
        emit FactorySet(factory_);
        emit FeeEngineSet(feeEngine_);
    }

    // ───────────────────────────── identity ───────────────────────────────────

    /// @notice Mint a fresh operator id for a not-yet-registered address. Permissionless and
    /// harmless: it grants no authority and can never rebind an existing operator (CM-4 — a
    /// fresh identity restarts at zero track record).
    /// @param operator the address to register
    /// @return opId the newly assigned operator id (ids start at 1; 0 = unregistered)
    function registerOperator(address operator) public returns (uint256 opId) {
        require(operatorIdOf[operator] == 0, AlreadyOperator());
        opId = ++operatorCount;
        operatorIdOf[operator] = opId;
        operatorAddressOf[opId] = operator;
        emit OperatorRegistered(opId, operator);
    }

    /// @notice Attest a factory-deployed vault to its operator. Factory-only (CM-5).
    /// @param vault the freshly deployed vault
    /// @param operator the creator identity (auto-registered if new)
    function attestVault(address vault, address operator) external {
        require(msg.sender == factory, OnlyFactory());
        uint256 opId = operatorIdOf[operator];
        if (opId == 0) opId = registerOperator(operator);
        _vaultOperator[vault] = opId;
        ++statsOf[opId].vaultCount;
        emit VaultAttested(vault, opId);
    }

    /// @inheritdoc IOperatorRegistry
    function operatorOf(address vault) external view returns (uint256) {
        return _vaultOperator[vault];
    }

    // ───────────────────────────── marks ──────────────────────────────────────

    /// @inheritdoc IOperatorRegistry
    /// @dev Called by attested vaults at redemption settlement, AFTER the fee engine has read
    /// the pre-realization carry (call order fixed in VaultCore._settleExit). Losses build the
    /// carry; gains consume it.
    function recordRealization(address member, uint256 gainUsdc, uint256 lossUsdc) external {
        uint256 opId = _vaultOperator[msg.sender];
        require(opId != 0, OnlyAttestedVault());

        uint256 carry = carryOf[member][opId];
        if (lossUsdc > 0) {
            carry += lossUsdc;
            statsOf[opId].lifetimeLossUsdc += lossUsdc;
        }
        if (gainUsdc > 0) {
            carry = gainUsdc >= carry ? 0 : carry - gainUsdc;
            statsOf[opId].lifetimeGainUsdc += gainUsdc;
        }
        carryOf[member][opId] = carry;
        emit RealizationRecorded(msg.sender, opId, member, gainUsdc, lossUsdc, carry);
    }

    /// @notice Fee-engine callback so collected fees appear in the aggregate record.
    /// @param opId the operator credited
    /// @param amountUsdc the fee amount actually collected, USDC units
    function recordFeeCollected(uint256 opId, uint256 amountUsdc) external {
        require(msg.sender == feeEngine, OnlyFeeEngine());
        statsOf[opId].lifetimeFeesUsdc += amountUsdc;
        emit FeeRecorded(opId, amountUsdc);
    }

    // ───────────────────────────── leaderboard ────────────────────────────────

    /// @notice Aggregate, all-vaults-included operator record (SF-4): monotone accumulators,
    /// nothing is ever removed or restated. Rankings/weighting are an indexer concern (S7).
    /// @param opId the operator queried
    /// @return operator the operator's address
    /// @return stats lifetime gain/loss/fees/vault-count accumulators
    function leaderboardEntry(uint256 opId)
        external
        view
        returns (address operator, OperatorStats memory stats)
    {
        return (operatorAddressOf[opId], statsOf[opId]);
    }
}
