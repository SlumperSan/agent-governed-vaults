// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IOperatorRegistry} from "./interfaces/IOperatorRegistry.sol";
import {IGovernance} from "./interfaces/IGovernance.sol";
import {IFeeEngine} from "./interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "./interfaces/IOracleAggregator.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";

interface IERC20Metadata {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
}

/// @title VaultCore — shares, NAV, deposits, redemptions, capacity (Sprint 1)
/// @notice Agent-governed index vault. Settlement asset USDC; basket priced by a multi-source
/// median oracle. NOT ERC-4626 (commitment C-1): in-kind redemption, forward pricing and swing
/// pricing break preview round-trips; 4626-shaped views are indicative only.
///
/// Sprint 1 scope: deposit with 4-hour observation window, two-mode redemption settlement
/// (C-4), in-kind payout with per-asset escrow isolation, tenure-decaying exit fee accruing to
/// remaining members, per-vault capacity cap, creator 5% withdrawal gate, cost-basis tracking
/// feeding the (member, operator) realization hooks. Governance, fees, oracles and execution
/// are consumed through interfaces; concrete modules land in Sprints 2–4.
///
/// Deliberate properties (do NOT "fix" — see docs/THREAT-MODEL.md):
///  - Oracle staleness reverts every NAV-reading path INCLUDING exits (SF-2 / K-4).
///  - Shares are non-transferable in Sprint 1 (EE-7).
///  - Creator 5% is a withdrawal gate, not a solvency condition (CM-2).
contract VaultCore {
    using SafeTransferLib for address;

    // ─────────────────────────────── constants ────────────────────────────────
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 public constant OBSERVATION_WINDOW = 4 hours;
    uint256 public constant CREATOR_MIN_STAKE_BPS = 500; // 5%
    uint256 public constant EXIT_FEE_CAP_BPS = 100; // 1% protocol cap

    // ─────────────────────────────── immutables ───────────────────────────────
    address public immutable usdc;
    uint256 public immutable usdcScalar; // 10**(18 - usdcDecimals)
    address public immutable creator;
    IOperatorRegistry public immutable operatorRegistry; // C-3: load-bearing from day one
    IGovernance public immutable governance;
    IFeeEngine public immutable feeEngine;
    IOracleAggregator public immutable oracle;

    uint256 public immutable capacityCapUsdc; // deposits revert above this NAV (USDC units)
    uint256 public immutable minDepositUsdc; // dust / rounding-inflation defense
    uint256 public immutable exitFeeMaxBps; // ≤ EXIT_FEE_CAP_BPS
    uint256 public immutable exitFeeDecayPeriod; // seconds until fee decays to zero

    // ─────────────────────────────── basket ───────────────────────────────────
    address[] public basketAssets;
    mapping(address => uint256) public assetUnit; // 10**decimals, nonzero ⇔ in basket
    /// @dev Internal accounting only — NAV never reads balanceOf (donation defense, EE-1).
    mapping(address => uint256) public assetBalance;
    uint256 public idleUsdc; // internal accounting, USDC units

    // ─────────────────────────────── shares ───────────────────────────────────
    uint256 public totalShares; // WAD-scaled
    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) public costBasisUsdc; // per-member, USDC units
    mapping(address => uint256) public lastDepositTime; // tenure clock (resets on deposit)
    uint256 public nonCreatorMemberCount;

    // ─────────────────────────── observation window ───────────────────────────
    struct PendingDeposit {
        uint256 amountUsdc;
        uint64 availableAt;
    }

    mapping(address => PendingDeposit) public pendingDeposit;
    mapping(address => bool) public windowCleared; // first activation done, or skipped
    mapping(address => bool) public skipOptIn; // irreversible, once per agent per vault
    uint256 public totalPendingUsdc; // escrowed, excluded from NAV and idleUsdc

    // ─────────────────────────── Mode-F exit queue ────────────────────────────
    mapping(address => uint256) public queuedExitShares; // locked: no vote, no transfer
    uint256 public totalQueuedShares;

    // ────────────────────── in-kind escrow (EE-6 isolation) ───────────────────
    mapping(address => mapping(address => uint256)) public claimable; // member ⇒ asset ⇒ amount

    // ─────────────────────────────── reentrancy ───────────────────────────────
    uint256 private _lock = 1;

    modifier nonReentrant() {
        require(_lock == 1, Reentrancy());
        _lock = 2;
        _;
        _lock = 1;
    }

    // ─────────────────────────────── events ───────────────────────────────────
    event DepositPending(address indexed member, uint256 amountUsdc, uint64 availableAt);
    event DepositActivated(address indexed member, uint256 amountUsdc, uint256 sharesMinted);
    event PendingCancelled(address indexed member, uint256 amountUsdc);
    event WindowSkipped(address indexed member);
    event ExitQueued(address indexed member, uint256 shares);
    event ExitSettled(
        address indexed member,
        uint256 sharesBurned,
        uint256 usdcPaid,
        uint256 exitFeeBps,
        uint256 perfFeeUsdc
    );
    event SliceEscrowed(address indexed member, address indexed asset, uint256 amount);
    event EscrowClaimed(address indexed member, address indexed asset, uint256 amount);

    // ─────────────────────────────── errors ───────────────────────────────────
    error Reentrancy();
    error ZeroAmount();
    error BelowMinDeposit();
    error CapacityExceeded();
    error PendingExists();
    error NoPending();
    error WindowNotElapsed();
    error AlreadyOptedIn();
    error InsufficientShares();
    error ExitAlreadyQueued();
    error NoQueuedExit();
    error ExecutionStillPending();
    error CreatorStakeGate();
    error NothingToClaim();
    error BadConfig();

    // ─────────────────────────────── constructor ──────────────────────────────
    constructor(
        address usdc_,
        address[] memory basketAssets_,
        address creator_,
        IOperatorRegistry operatorRegistry_,
        IGovernance governance_,
        IFeeEngine feeEngine_,
        IOracleAggregator oracle_,
        uint256 capacityCapUsdc_,
        uint256 minDepositUsdc_,
        uint256 exitFeeMaxBps_,
        uint256 exitFeeDecayPeriod_
    ) {
        require(usdc_ != address(0) && creator_ != address(0), BadConfig());
        require(exitFeeMaxBps_ <= EXIT_FEE_CAP_BPS, BadConfig());
        require(capacityCapUsdc_ > 0 && minDepositUsdc_ > 0, BadConfig());
        require(exitFeeMaxBps_ == 0 || exitFeeDecayPeriod_ > 0, BadConfig());

        usdc = usdc_;
        // Decimals read at runtime, never assumed (chain-agnostic C-2; evm-token-decimals).
        uint8 dec = IERC20Metadata(usdc_).decimals();
        require(dec <= 18, BadConfig());
        usdcScalar = 10 ** (18 - dec);

        creator = creator_;
        operatorRegistry = operatorRegistry_;
        governance = governance_;
        feeEngine = feeEngine_;
        oracle = oracle_;
        capacityCapUsdc = capacityCapUsdc_;
        minDepositUsdc = minDepositUsdc_;
        exitFeeMaxBps = exitFeeMaxBps_;
        exitFeeDecayPeriod = exitFeeDecayPeriod_;

        basketAssets = basketAssets_;
        for (uint256 i; i < basketAssets_.length; ++i) {
            address a = basketAssets_[i];
            require(a != address(0) && a != usdc_ && assetUnit[a] == 0, BadConfig());
            uint8 ad = IERC20Metadata(a).decimals();
            require(ad <= 18, BadConfig());
            assetUnit[a] = 10 ** ad;
        }
    }

    // ─────────────────────────────── NAV ──────────────────────────────────────

    /// @notice Vault NAV in WAD USD terms. Pending deposits are excluded (EE-1). Reverts while
    /// the oracle breaker is tripped — freezing everything, including exits, by design (K-4).
    function navWad() public view returns (uint256 nav) {
        nav = idleUsdc * usdcScalar;
        uint256 n = basketAssets.length;
        for (uint256 i; i < n; ++i) {
            address a = basketAssets[i];
            uint256 bal = assetBalance[a];
            if (bal != 0) nav += bal * oracle.priceWad(a) / assetUnit[a];
        }
    }

    function navPerShareWad() public view returns (uint256) {
        uint256 ts = totalShares;
        return ts == 0 ? WAD : navWad() * WAD / ts;
    }

    // ───────────────────────────── deposits ───────────────────────────────────

    /// @notice Deposit USDC. First-ever deposit by an agent enters the 4-hour observation
    /// window as escrowed pending capital (no shares, no NAV inclusion, no voting rights).
    /// Repeat deposits and window-skipped agents mint immediately at current NAV.
    function deposit(uint256 amountUsdc) external nonReentrant {
        require(amountUsdc > 0, ZeroAmount());
        require(amountUsdc >= minDepositUsdc, BelowMinDeposit());

        // Capacity measured against NAV + escrowed pending (both will count once active).
        uint256 navUsdc = navWad() / usdcScalar;
        require(navUsdc + totalPendingUsdc + amountUsdc <= capacityCapUsdc, CapacityExceeded());

        // Measure actual receipt — internal accounting never trusts the request amount.
        uint256 balBefore = IERC20Metadata(usdc).balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amountUsdc);
        uint256 received = IERC20Metadata(usdc).balanceOf(address(this)) - balBefore;
        require(received >= minDepositUsdc, BelowMinDeposit());

        if (windowCleared[msg.sender] || sharesOf[msg.sender] > 0) {
            _mintShares(msg.sender, received);
            emit DepositActivated(msg.sender, received, sharesOf[msg.sender]);
        } else {
            require(pendingDeposit[msg.sender].amountUsdc == 0, PendingExists());
            uint64 availableAt = uint64(block.timestamp + OBSERVATION_WINDOW);
            pendingDeposit[msg.sender] = PendingDeposit(received, availableAt);
            totalPendingUsdc += received;
            emit DepositPending(msg.sender, received, availableAt);
        }
    }

    /// @notice Activate a pending deposit after the observation window. Shares mint at
    /// activation-time NAV (forward pricing on entry, §4.3). Callable by anyone.
    function activate(address member) external nonReentrant {
        PendingDeposit memory p = pendingDeposit[member];
        require(p.amountUsdc > 0, NoPending());
        require(block.timestamp >= p.availableAt, WindowNotElapsed());
        _activatePending(member, p.amountUsdc);
    }

    /// @notice Cancel a pending deposit before activation and reclaim the escrowed USDC.
    function cancelPending() external nonReentrant {
        PendingDeposit memory p = pendingDeposit[msg.sender];
        require(p.amountUsdc > 0, NoPending());
        delete pendingDeposit[msg.sender];
        totalPendingUsdc -= p.amountUsdc;
        usdc.safeTransfer(msg.sender, p.amountUsdc);
        emit PendingCancelled(msg.sender, p.amountUsdc);
    }

    /// @notice Irrevocably opt in to skipping the observation window for this vault — once per
    /// agent per vault. If a pending deposit exists it activates immediately.
    function skipWindow() external nonReentrant {
        require(!skipOptIn[msg.sender], AlreadyOptedIn());
        skipOptIn[msg.sender] = true;
        windowCleared[msg.sender] = true;
        emit WindowSkipped(msg.sender);

        uint256 amt = pendingDeposit[msg.sender].amountUsdc;
        if (amt > 0) _activatePending(msg.sender, amt);
    }

    function _activatePending(address member, uint256 amountUsdc) internal {
        delete pendingDeposit[member];
        totalPendingUsdc -= amountUsdc;
        windowCleared[member] = true;
        _mintShares(member, amountUsdc);
        emit DepositActivated(member, amountUsdc, sharesOf[member]);
    }

    function _mintShares(address member, uint256 amountUsdc) internal {
        uint256 amountWad = amountUsdc * usdcScalar;
        uint256 ts = totalShares;
        // Round down against the depositor; internal-accounting NAV makes donation moot (EE-1).
        uint256 minted = ts == 0 ? amountWad : amountWad * ts / navWad();
        require(minted > 0, ZeroAmount());

        if (member != creator && sharesOf[member] == 0) ++nonCreatorMemberCount;
        sharesOf[member] += minted;
        totalShares = ts + minted;
        idleUsdc += amountUsdc; // enters NAV only now
        costBasisUsdc[member] += amountUsdc;
        lastDepositTime[member] = block.timestamp; // tenure clock resets (conservative)
    }

    // ───────────────────────────── redemptions ────────────────────────────────

    /// @notice Request redemption of `shares`. Two-mode settlement (C-4, resolves K-1):
    /// Mode I — no passed-but-unexecuted rebalance ⇒ settles now at current NAV, in kind.
    /// Mode F — rebalance passed and pending ⇒ queued, settles at post-execution NAV.
    /// Queued shares stay outstanding but are locked: no voting eligibility, irrevocable.
    function requestExit(uint256 shares) external nonReentrant {
        require(shares > 0, ZeroAmount());
        require(queuedExitShares[msg.sender] == 0, ExitAlreadyQueued());
        require(sharesOf[msg.sender] >= shares, InsufficientShares());

        if (governance.hasPendingExecution(address(this))) {
            queuedExitShares[msg.sender] = shares;
            totalQueuedShares += shares;
            emit ExitQueued(msg.sender, shares);
        } else {
            _settleExit(msg.sender, shares);
        }
    }

    /// @notice Settle a queued Mode-F exit once no execution is pending (the rebalance executed,
    /// or its proposal expired — either way settlement is at *current* NAV, which post-execution
    /// is the post-rebalance NAV; EE-10 guarantees no indefinite lock). Callable by anyone.
    function settleQueuedExit(address member) external nonReentrant {
        uint256 shares = queuedExitShares[member];
        require(shares > 0, NoQueuedExit());
        require(!governance.hasPendingExecution(address(this)), ExecutionStillPending());
        queuedExitShares[member] = 0;
        totalQueuedShares -= shares;
        _settleExit(member, shares);
    }

    function _settleExit(address member, uint256 burnShares) internal {
        uint256 memberShares = sharesOf[member];
        require(memberShares >= burnShares, InsufficientShares());
        uint256 ts = totalShares;

        // Creator 5% withdrawal gate (CM-1/CM-2): gate on creator ACTION while members remain.
        if (member == creator && nonCreatorMemberCount > 0) {
            require(
                (memberShares - burnShares) * BPS >= CREATOR_MIN_STAKE_BPS * (ts - burnShares),
                CreatorStakeGate()
            );
        }

        // Exit fee: decays with tenure, waived for a sole holder (fee would route to self;
        // last-member waiver per EE-8/EE-9 — it can never route to the operator).
        uint256 feeBps = _exitFeeBps(member);
        if (memberShares == ts) feeBps = 0;
        uint256 keepBps = BPS - feeBps;

        // Pro-rata in-kind payout; the fee fraction of every slice STAYS in the vault, so
        // NAVps for remaining members is non-decreasing across any redemption (§4.6 invariant).
        uint256 usdcPay = idleUsdc * burnShares / ts * keepBps / BPS;
        uint256 payoutValueWad = usdcPay * usdcScalar;

        // Burn before external transfers (CEI).
        sharesOf[member] = memberShares - burnShares;
        totalShares = ts - burnShares;
        if (member != creator && sharesOf[member] == 0 && memberShares > 0) {
            --nonCreatorMemberCount;
        }

        // Realized P&L against pro-rata cost basis; hooks feed the (member, operator)
        // loss-carryforward HWM (§7). Fee engine is a zero-fee stub until Sprint 3.
        uint256 basisRemoved = costBasisUsdc[member] * burnShares / memberShares;
        costBasisUsdc[member] -= basisRemoved;

        idleUsdc -= usdcPay;
        uint256 n = basketAssets.length;
        for (uint256 i; i < n; ++i) {
            address a = basketAssets[i];
            uint256 slice = assetBalance[a] * burnShares / ts * keepBps / BPS;
            if (slice == 0) continue;
            assetBalance[a] -= slice;
            payoutValueWad += slice * oracle.priceWad(a) / assetUnit[a];
            // EE-6: one reverting/blacklisted asset must not block the redemption — escrow it.
            if (!a.tryTransfer(member, slice)) {
                claimable[member][a] += slice;
                emit SliceEscrowed(member, a, slice);
            }
        }

        uint256 payoutValueUsdc = payoutValueWad / usdcScalar;
        uint256 perfFee;
        if (payoutValueUsdc > basisRemoved) {
            uint256 gain = payoutValueUsdc - basisRemoved;
            perfFee = feeEngine.onRealize(member, gain, 0);
            // Defensive clamp: never trust the module beyond its contract (≤10% of gain, ≤ cash leg).
            uint256 cap = gain / 10;
            if (perfFee > cap) perfFee = cap;
            if (perfFee > usdcPay) perfFee = usdcPay;
            operatorRegistry.recordRealization(member, gain, 0);
        } else {
            uint256 loss = basisRemoved - payoutValueUsdc;
            feeEngine.onRealize(member, 0, loss);
            operatorRegistry.recordRealization(member, 0, loss);
        }

        if (perfFee > 0) {
            usdcPay -= perfFee;
            usdc.safeTransfer(address(feeEngine), perfFee);
        }
        if (usdcPay > 0) usdc.safeTransfer(member, usdcPay);

        emit ExitSettled(member, burnShares, usdcPay, feeBps, perfFee);
    }

    /// @notice Claim an in-kind slice that was escrowed after a failed asset transfer (EE-6).
    function claimEscrowed(address asset) external nonReentrant {
        uint256 amt = claimable[msg.sender][asset];
        require(amt > 0, NothingToClaim());
        claimable[msg.sender][asset] = 0;
        asset.safeTransfer(msg.sender, amt);
        emit EscrowClaimed(msg.sender, asset, amt);
    }

    function _exitFeeBps(address member) internal view returns (uint256) {
        uint256 maxBps = exitFeeMaxBps;
        if (maxBps == 0) return 0;
        uint256 tenure = block.timestamp - lastDepositTime[member];
        uint256 period = exitFeeDecayPeriod;
        if (tenure >= period) return 0;
        return maxBps * (period - tenure) / period;
    }

    // ─────────────────────────────── views ────────────────────────────────────

    /// @notice Stake eligible for voting and quorum denominators (Sprint 2): live shares minus
    /// Mode-F-locked shares. Pending deposits hold no shares at all (EE-1/EE-2).
    function votingEligibleShares(address member) external view returns (uint256) {
        return sharesOf[member] - queuedExitShares[member];
    }

    function totalVotingEligibleShares() external view returns (uint256) {
        return totalShares - totalQueuedShares;
    }

    function exitFeeBpsOf(address member) external view returns (uint256) {
        return _exitFeeBps(member);
    }

    function basketLength() external view returns (uint256) {
        return basketAssets.length;
    }

    // 4626-SHAPED, INDICATIVE ONLY (C-1): no compliance claim; previews ignore exit fees,
    // observation windows, forward pricing and in-kind mechanics.
    function totalAssets() external view returns (uint256) {
        return navWad() / usdcScalar;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        uint256 ts = totalShares;
        return ts == 0 ? assets * usdcScalar : assets * usdcScalar * ts / navWad();
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        uint256 ts = totalShares;
        return ts == 0 ? shares / usdcScalar : shares * navWad() / ts / usdcScalar;
    }
}
