// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IOperatorRegistry} from "./interfaces/IOperatorRegistry.sol";
import {IGovernance} from "./interfaces/IGovernance.sol";
import {IFeeEngine} from "./interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "./interfaces/IOracleAggregator.sol";
import {IExecutionAdapter} from "./interfaces/IExecutionAdapter.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {Checkpoints} from "./lib/Checkpoints.sol";
import {BoundedCall} from "./lib/BoundedCall.sol";

interface ISubVaultEdges {
    function parentOf(address child) external view returns (address);
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
}

/// @title VaultCore — shares, NAV, deposits, redemptions, capacity (Sprint 1)
/// @notice Agent-governed index vault. Settlement asset USDC; basket priced by an immutable
/// {IOracleAggregator} — at launch {ChainlinkOracle}, one genuine Chainlink Data Feed per asset.
/// NOT ERC-4626 (commitment C-1): in-kind redemption, forward pricing and swing
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
    using Checkpoints for Checkpoints.History;
    using BoundedCall for address;

    /// @dev Gas allowance for creator-chosen bookkeeping modules (security review H-1): value
    /// AND liveness are both defended — a reverting / gas-guzzling / returndata-bombing module
    /// can lose its own bookkeeping (event-logged) but can never block a member's exit.
    uint256 internal constant MODULE_CALL_GAS = 300_000;

    // ─────────────────────────────── constants ────────────────────────────────
    uint256 internal constant WAD = 1e18;
    uint256 internal constant SHORTFALL_DUST_WAD = 1e12; // 1e-6 USD rounding tolerance
    uint256 internal constant BPS = 10_000;
    uint256 public constant OBSERVATION_WINDOW = 4 hours;
    uint256 public constant CREATOR_MIN_STAKE_BPS = 500; // 5%
    uint256 public constant EXIT_FEE_CAP_BPS = 100; // 1% protocol cap

    /// @dev H-4: the maximum value a single rebalance leg may give up against the vault's own
    /// oracle. THREAT-MODEL EX-2 stated this bound as "minOut bound from oracle median ±
    /// tolerance" and no such bound existed: both execution paths compared the measured output
    /// delta only against the caller-supplied `minAmountOut`, and the oracle was never
    /// consulted on the execution path at all. Measuring honestly against a floor of 1 wei
    /// still yields 1 wei — which is what made governance capture equal a DRAIN (C-1, C-5)
    /// rather than a bounded bad trade.
    ///
    /// Deliberately a PROTOCOL CONSTANT, not a creator-supplied parameter as the finding
    /// suggested. The creator is untrusted by explicit design, and a creator-set
    /// `maxSlippageBps = 10000` would be a silent no-op — reproducing M-6, where every named
    /// defence turned out to be optional and the only worked config disabled all three.
    uint256 public constant MAX_REBALANCE_SLIPPAGE_BPS = 200; // 2%

    // ─────────────────────────────── immutables ───────────────────────────────
    address public immutable usdc;
    uint256 public immutable usdcScalar; // 10**(18 - usdcDecimals)
    address public immutable creator;
    IOperatorRegistry public immutable operatorRegistry; // C-3: load-bearing from day one
    IGovernance public immutable governance;
    IFeeEngine public immutable feeEngine;
    IOracleAggregator public immutable oracle;

    address public immutable subVaultRegistry; // SV edges; zero disables child allocation
    address internal _cachedParentVault; // lazily resolved; a parent vault is a NON-voting member
    uint256 public immutable capacityCapUsdc; // max NAV (USDC units); 0 = uncapped (no limit)
    uint256 public immutable minDepositUsdc; // dust / rounding-inflation defense
    uint256 public immutable exitFeeMaxBps; // ≤ EXIT_FEE_CAP_BPS
    uint256 public immutable exitFeeDecayPeriod; // seconds until fee decays to zero

    // ───────────────────────────── execution ──────────────────────────────────
    /// @dev Adapter allowlist fixed at creation (EX-1): rebalances may only touch venues the
    /// members signed up for. Immutable — changing venues means a new vault.
    mapping(address => bool) public isAllowedAdapter;

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

    // ─────────────── stake snapshots (VO-9: proposal-time voting power) ───────
    mapping(address => Checkpoints.History) internal _eligibleHist;
    Checkpoints.History internal _totalEligibleHist;
    Checkpoints.History internal _holderCountHist;
    uint256 public holderCount; // addresses with shares > 0, creator included

    // ───────────────────────────── sub-vaults ─────────────────────────────────
    address[] public childVaults; // governance-allocated children (≤ MAX_CHILDREN)
    mapping(address => bool) public isChildVault;
    uint256 public constant MAX_CHILDREN = 8;
    uint256 public constant MAX_LOOKTHROUGH_DEPTH = 3; // matches SubVaultRegistry.MAX_DEPTH
    uint256 public constant MAX_BASKET_ASSETS = 10; // Finding 8: bound navWad gas cost

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

    /// @notice True while one of this vault's guarded entry points is mid-execution.
    /// @dev Read-only-reentrancy handle for look-through valuation (`_fullNavWad`): between a
    /// rebalance leg's debit and its measured credit this vault's own accounting understates
    /// its NAV, so a parent must refuse to price it.
    ///
    /// LOAD-BEARING INVARIANT — **every state-mutating external on this contract is
    /// `nonReentrant`.** `locked()` is not a statement about NAV; it is a statement about the
    /// lock, and `_fullNavWad` treats the two as equivalent. That substitution is sound only
    /// while every window in which `idleUsdc`, `assetBalance`, `totalShares`, `totalPendingUsdc`
    /// or `claimable` can be mid-write sits inside this vault's own lock. **Adding a mutating
    /// external without `nonReentrant` silently reopens H-9 at full severity** — an ancestor
    /// reads through this view, sees `false`, and prices an understated vault. It is not enough
    /// that the new function looks harmless: the ancestor never calls it, it calls `locked()`.
    /// Enforced by `test/audit/AuditReentrancyGuardCoverage.t.sol`, which enumerates the
    /// compiled ABI and fails when a mutating external appears outside its register.
    function locked() external view returns (bool) {
        return _lock != 1;
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
    event ModuleCallFailed(bytes32 indexed module, address indexed member);
    event EscrowClaimed(address indexed member, address indexed asset, uint256 amount);
    event RebalanceExecuted(address indexed adapter, uint256 orderCount);
    event ChildAllocated(address indexed child, uint256 amountUsdc);
    event ChildRedeemed(address indexed child, uint256 shares, uint256 usdcCredited);

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
    error SlippageExceeded(); // M-15: deposit minted fewer shares than minSharesOut
    error NoQueuedExit();
    error ExecutionStillPending();
    error CreatorStakeGate();
    error NothingToClaim();
    error BadConfig();
    error OnlyGovernance();
    error AdapterNotAllowed();
    error BadSwapToken();
    error InsufficientAssetBalance();
    error SwapSlippage();
    error MinOutTooLow();
    error NotRegisteredChild();
    error TooManyChildren();
    error ChildSettlementPending();
    error ExitNeedsChildSettlement();

    // ─────────────────────────────── constructor ──────────────────────────────

    /// @notice Deploy a vault. Every trust-relevant choice is fixed here and immutable after —
    /// members inspect the config before depositing; there are no setters.
    /// @param usdc_ settlement asset (decimals read at runtime, must be ≤ 18)
    /// @param basketAssets_ index basket (≤ MAX_BASKET_ASSETS; no zero/duplicate/USDC entries)
    /// @param creator_ vault creator — the 5% withdrawal gate binds to this address
    /// @param operatorRegistry_ canonical registry for (member, operator) marks (C-3)
    /// @param governance_ governance module consulted for the Mode-I/Mode-F exit switch
    /// @param feeEngine_ performance-fee module called at redemption settlement
    /// @param oracle_ price oracle, immutable for the vault's life; fail-closed, so a stale or
    /// untrustworthy read reverts and freezes every NAV path
    /// @param capacityCapUsdc_ max NAV in USDC units; 0 opts out of the cap (SF-3)
    /// @param minDepositUsdc_ minimum deposit, must be nonzero (dust/rounding defense)
    /// @param exitFeeMaxBps_ tenure-decayed exit fee ceiling, ≤ EXIT_FEE_CAP_BPS (1%)
    /// @param exitFeeDecayPeriod_ seconds until the exit fee decays to zero (nonzero iff fee set)
    /// @param allowedAdapters_ execution-adapter allowlist, fixed forever (EX-1)
    /// @param subVaultRegistry_ parent/child edge registry; zero disables child allocation
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
        uint256 exitFeeDecayPeriod_,
        address[] memory allowedAdapters_,
        address subVaultRegistry_
    ) {
        subVaultRegistry = subVaultRegistry_;
        for (uint256 i; i < allowedAdapters_.length; ++i) {
            isAllowedAdapter[allowedAdapters_[i]] = true;
        }
        require(usdc_ != address(0) && creator_ != address(0), BadConfig());
        require(exitFeeMaxBps_ <= EXIT_FEE_CAP_BPS, BadConfig());
        require(minDepositUsdc_ > 0, BadConfig()); // capacityCapUsdc_ == 0 ⇒ uncapped
        require(exitFeeMaxBps_ == 0 || exitFeeDecayPeriod_ > 0, BadConfig());

        usdc = usdc_;
        // Decimals read at runtime, never assumed (chain-agnostic C-2; evm-token-decimals).
        uint8 dec = IERC20Metadata(usdc_).decimals();
        require(dec <= 18, BadConfig());
        usdcScalar = 10 ** (18 - dec);
        // M-4/L-2: `shortfallWad` is the sub-unit truncation residual, uniform in
        // [0, usdcScalar - 1], and `_settleExit` requires it to be <= SHORTFALL_DUST_WAD.
        // So `dec >= 6` was REQUIRED and never enforced: at 5 decimals ~90% of exits
        // revert, and at 2 (e.g. GUSD, a real USD stablecoin) ~99.99% do - from a vault
        // with no children at all, reporting `ExitNeedsChildSettlement`, which is a
        // thoroughly misleading error for a pure rounding artifact.
        //
        // This also pins L-2: at the canonical 6 decimals the old bound held with exactly
        // ONE unit of slack (usdcScalar - 1 = 1e12 - 1 against a <= 1e12 bound). Correct,
        // but by coincidence and undocumented. The relationship is now a constructor
        // invariant, so any future change to the residual derivation fails loudly here
        // instead of silently bricking redemptions.
        require(usdcScalar <= SHORTFALL_DUST_WAD, BadConfig());

        creator = creator_;
        operatorRegistry = operatorRegistry_;
        governance = governance_;
        feeEngine = feeEngine_;
        oracle = oracle_;
        capacityCapUsdc = capacityCapUsdc_;
        minDepositUsdc = minDepositUsdc_;
        exitFeeMaxBps = exitFeeMaxBps_;
        exitFeeDecayPeriod = exitFeeDecayPeriod_;

        require(basketAssets_.length <= MAX_BASKET_ASSETS, BadConfig());
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
    /// @return nav idle USDC + oracle-priced basket + look-through-priced child positions, WAD
    function navWad() public view returns (uint256 nav) {
        nav = idleUsdc * usdcScalar;
        uint256 n = basketAssets.length;
        for (uint256 i; i < n; ++i) {
            address a = basketAssets[i];
            uint256 bal = assetBalance[a];
            if (bal != 0) nav += _assetValueWad(a, bal);
        }
        for (uint256 i; i < childVaults.length; ++i) {
            nav += _childValueWad(childVaults[i]);
        }
    }

    /// @dev SV-7 look-through: the child position is valued from the child's INTERNAL asset
    /// accounting priced by THIS vault's own oracle — never from child-reported NAVps, and
    /// never through the child's oracle choice. Child baskets are subsets of the parent's
    /// (factory-enforced), so every child asset is priceable here; an unpriceable asset
    /// fails safe via StaleOracle.
    function _childValueWad(address child) internal view returns (uint256) {
        return _holdingValueWad(VaultCore(child), address(this), 1);
    }

    /// @dev Value of `holder`'s position in vault `v`, WAD. Finding 1 (S6): value the WHOLE
    /// child NAV including ITS children, then take the holder's fraction — non-recursive
    /// valuation silently dropped grandchild value from the root. Shared by the parent's own
    /// child mark and by every look-through level beneath it.
    function _holdingValueWad(VaultCore v, address holder, uint256 depth) internal view returns (uint256) {
        uint256 sh = v.sharesOf(holder);
        if (sh == 0) return 0;
        return _fullNavWad(v, depth) * sh / v.totalShares();
    }

    /// @dev Full NAV of `v` priced through THIS vault's oracle, recursing into descendants.
    /// Depth-bounded by MAX_LOOKTHROUGH_DEPTH (registry caps real nesting at 3; this is the
    /// backstop). Every descendant asset is a subset of this vault's basket (factory-enforced),
    /// so assetUnit/oracle always resolve.
    function _fullNavWad(VaultCore v, uint256 depth) internal view returns (uint256 nav) {
        // Read-only reentrancy: mid-`executeRebalance` a leg's input is already debited and its
        // measured output not yet credited, so `v`'s accounting understates its NAV — pricing it
        // then overmints to a depositor and underpays an exiter here. A locked vault is
        // observable ONLY from inside its own call stack, so no honest caller ever sees this.
        //
        // This check stands on an invariant stated at `locked()`: every state-mutating external
        // on VaultCore is `nonReentrant`, so every understatement window sits inside the lock
        // this reads. A mutating external added without the modifier reopens H-9 while this line
        // still appears to defend it — `AuditReentrancyGuardCoverage.t.sol` is what catches that.
        //
        // It must also stay HERE rather than move up into `_childValueWad`: `_childValueWad` is
        // only the depth-1 entry point, and the recursion below re-enters `_fullNavWad` for each
        // descendant. Hoisting it passes every depth-1 test and leaves grandchildren exploitable
        // — measured at a 1.5× overmint and a one-third short-paid exit in
        // AuditLookThroughDepth2Test.
        require(!v.locked(), Reentrancy());
        nav = v.idleUsdc() * usdcScalar;
        uint256 n = v.basketLength();
        for (uint256 i; i < n; ++i) {
            address a = v.basketAssets(i);
            uint256 bal = v.assetBalance(a);
            if (bal != 0) nav += _assetValueWad(a, bal);
        }
        if (depth < MAX_LOOKTHROUGH_DEPTH) {
            uint256 cc = v.childVaultCount();
            for (uint256 i; i < cc; ++i) {
                nav += _holdingValueWad(VaultCore(v.childVaults(i)), address(v), depth + 1);
            }
        }
    }

    /// @notice Number of registered child vaults (≤ MAX_CHILDREN).
    function childVaultCount() external view returns (uint256) {
        return childVaults.length;
    }

    /// @notice NAV per share, WAD. 1e18 before the first deposit.
    /// @return NAVps in WAD; reverts with the oracle breaker like navWad
    function navPerShareWad() public view returns (uint256) {
        uint256 ts = totalShares;
        return ts == 0 ? WAD : navWad() * WAD / ts;
    }

    // ───────────────────────────── deposits ───────────────────────────────────

    /// @notice Deposit USDC. First-ever deposit by an agent enters the 4-hour observation
    /// window as escrowed pending capital (no shares, no NAV inclusion, no voting rights).
    /// Repeat deposits and window-skipped agents mint immediately at current NAV.
    /// @param amountUsdc deposit size in USDC units (≥ minDepositUsdc); receipt is measured,
    /// so fee-on-transfer shortfalls below the minimum revert
    function deposit(uint256 amountUsdc) external nonReentrant {
        _deposit(amountUsdc, 0);
    }

    /// @notice Deposit with slippage protection (M-15). `minSharesOut` bounds the shares minted on
    /// the IMMEDIATE-mint path only (returning or window-cleared depositor) — the user-side defence
    /// against a depressed NAV minting fewer shares than expected (the C-4/H-1/H-2 anomaly seen from
    /// the depositor's side). A first-time deposit is escrowed pending and prices at activation, so
    /// `minSharesOut` does not apply there; pass 0 to opt out.
    /// @param amountUsdc deposit size in USDC units (≥ minDepositUsdc)
    /// @param minSharesOut minimum shares to mint on the immediate path, or 0 to opt out
    function deposit(uint256 amountUsdc, uint256 minSharesOut) external nonReentrant {
        _deposit(amountUsdc, minSharesOut);
    }

    function _deposit(uint256 amountUsdc, uint256 minSharesOut) internal {
        require(amountUsdc > 0, ZeroAmount());
        require(amountUsdc >= minDepositUsdc, BelowMinDeposit());

        // Capacity measured against NAV + escrowed pending (both will count once active).
        // capacityCapUsdc == 0 means the vault opted out of a cap (SF-3 is optional).
        uint256 navUsdc = navWad() / usdcScalar;
        if (capacityCapUsdc != 0) {
            require(navUsdc + totalPendingUsdc + amountUsdc <= capacityCapUsdc, CapacityExceeded());
        }

        // Measure actual receipt — internal accounting never trusts the request amount.
        uint256 balBefore = _bal(usdc);
        usdc.safeTransferFrom(msg.sender, address(this), amountUsdc);
        uint256 received = _bal(usdc) - balBefore;
        require(received >= minDepositUsdc, BelowMinDeposit());

        if (windowCleared[msg.sender] || sharesOf[msg.sender] > 0) {
            uint256 minted = _mintShares(msg.sender, received);
            require(minted >= minSharesOut, SlippageExceeded()); // M-15 (immediate path only)
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
    /// @param member the depositor whose pending deposit matured
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
        // M-2: this was the WORST of the three, being unconditional - a member blacklisted
        // AFTER depositing had their pending escrow permanently stranded, with no other path
        // out. `cancelPending` is also the one guaranteed action during an oracle freeze (K-4),
        // so a revert here removed the only lever the incident playbook can promise.
        _payOrEscrow(usdc, msg.sender, p.amountUsdc);
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

    function _mintShares(address member, uint256 amountUsdc) internal returns (uint256 minted) {
        uint256 amountWad = amountUsdc * usdcScalar;
        uint256 ts = totalShares;
        // Round down against the depositor; internal-accounting NAV makes donation moot (EE-1).
        minted = ts == 0 ? amountWad : amountWad * ts / navWad();
        require(minted > 0, ZeroAmount());

        if (sharesOf[member] == 0) {
            if (member != creator) ++nonCreatorMemberCount;
            ++holderCount;
        }
        sharesOf[member] += minted;
        totalShares = ts + minted;
        idleUsdc += amountUsdc; // enters NAV only now
        costBasisUsdc[member] += amountUsdc;
        lastDepositTime[member] = block.timestamp; // tenure clock resets (conservative)
        _snapshot(member);
    }

    /// @notice The parent vault, if this is a sub-vault (else address(0)). A parent that has
    /// allocated capital HOLDS shares here but is a smart contract with no vote path — counting
    /// it as a voting member would make full-consensus RuleChange permanently unreachable and
    /// distort every quorum (governance re-review, Area 1). It is therefore excluded from all
    /// voting-eligible stake and holder counts. The edge is one-shot (set at child creation),
    /// so cache it once resolved.
    /// @return the registered parent vault, or address(0) for a root vault
    function parentVault() public view returns (address) {
        if (_cachedParentVault != address(0)) return _cachedParentVault;
        if (subVaultRegistry == address(0)) return address(0);
        return ISubVaultEdges(subVaultRegistry).parentOf(address(this));
    }

    /// @dev Record post-mutation voting-eligible stake and holder count (VO-9 snapshots),
    /// EXCLUDING the parent vault's non-voting position.
    function _snapshot(address member) internal {
        address pv = parentVault();
        if (pv != address(0) && _cachedParentVault == address(0)) _cachedParentVault = pv;

        uint256 pHeld = (pv != address(0) && sharesOf[pv] > 0) ? 1 : 0;

        _eligibleHist[member].push(member == pv ? 0 : sharesOf[member] - queuedExitShares[member]);
        _totalEligibleHist.push(_totalEligibleShares(pv));
        _holderCountHist.push(holderCount - pHeld);
    }

    /// @dev Supply minus Mode-F-locked shares minus the parent vault's non-voting position.
    /// Shared by the snapshot writer and the live view so the two can never diverge.
    /// @param pv the resolved parent vault, or address(0) for a root vault
    function _totalEligibleShares(address pv) internal view returns (uint256) {
        uint256 pElig = pv == address(0) ? 0 : sharesOf[pv] - queuedExitShares[pv];
        return totalShares - totalQueuedShares - pElig;
    }

    // ───────────────────────────── redemptions ────────────────────────────────

    /// @notice Request redemption of `shares`. Two-mode settlement (C-4, resolves K-1):
    /// Mode I — no passed-but-unexecuted rebalance ⇒ settles now at current NAV, in kind.
    /// Mode F — rebalance passed and pending ⇒ queued, settles at post-execution NAV.
    /// Queued shares stay outstanding but are locked: no voting eligibility, irrevocable.
    /// @param shares share amount to redeem (≤ balance; one queued exit per member at a time)
    /// @dev M-15 note: unlike `deposit`, exit has no `minValueOut` overload. The byte budget did
    /// not fit both, and the deposit side is the primary user-side defence (the C-4/H-1/H-2
    /// depressed-price anomaly mints excess shares to a DEPOSITOR; an exiter at a depressed NAV
    /// receives fewer assets but is the party choosing to exit and can read NAV first). The exit
    /// side is documented as a residual — see AI-AUDIT-REPORT.md M-15.
    function requestExit(uint256 shares) external nonReentrant {
        require(shares > 0, ZeroAmount());
        require(queuedExitShares[msg.sender] == 0, ExitAlreadyQueued());
        require(sharesOf[msg.sender] >= shares, InsufficientShares());

        if (_pendingExecution()) {
            // L-1 fix: evaluate the creator gate at QUEUE time — a gate-violating Mode-F
            // request must revert here, not strand an un-cancellable queued exit at settle.
            _checkCreatorGate(msg.sender, shares);
            queuedExitShares[msg.sender] = shares;
            totalQueuedShares += shares;
            _snapshot(msg.sender); // locked shares leave eligible stake immediately
            emit ExitQueued(msg.sender, shares);
        } else {
            _settleExit(msg.sender, shares, false);
        }
    }

    /// @dev H-1: bounded, non-reverting read of the governance module. On ANY failure the
    /// fallback is Mode I (instant settlement) — a broken governance forfeits forward pricing
    /// (VO-8 leak accepted in that already-broken state); permanent exit lockup is never on
    /// the table. Deliberate, documented liveness decision.
    function _pendingExecution() internal view returns (bool) {
        return _hasPendingExecution(address(governance), address(this));
    }

    /// @dev The bounded read both pending-execution callers share: `gov`'s opinion of whether
    /// `vault` has a passed-but-unexecuted rebalance. Any failure — revert, OOG, short return —
    /// reads as false, which is the liveness-preserving answer for both callers (H-1).
    function _hasPendingExecution(address gov, address vault) internal view returns (bool) {
        (bool ok, uint256 word, uint256 retSize) =
            gov.boundedStaticCall(abi.encodeCall(IGovernance.hasPendingExecution, (vault)), MODULE_CALL_GAS);
        return ok && retSize >= 32 && word != 0;
    }

    /// @notice Settle a queued Mode-F exit once no execution is pending (the rebalance executed,
    /// or its proposal expired — either way settlement is at *current* NAV, which post-execution
    /// is the post-rebalance NAV; EE-10 guarantees no indefinite lock). Callable by anyone.
    /// @param member the member whose queued Mode-F exit should settle
    function settleQueuedExit(address member) external nonReentrant {
        uint256 shares = queuedExitShares[member];
        require(shares > 0, NoQueuedExit());
        require(!_pendingExecution(), ExecutionStillPending());
        queuedExitShares[member] = 0;
        totalQueuedShares -= shares;
        _settleExit(member, shares, true);
    }

    /// @dev Creator 5% withdrawal gate (CM-1/CM-2): gate on creator ACTION while members remain.
    function _checkCreatorGate(address member, uint256 burnShares) internal view {
        if (member == creator && nonCreatorMemberCount > 0) {
            require(
                (sharesOf[member] - burnShares) * BPS >= CREATOR_MIN_STAKE_BPS * (totalShares - burnShares),
                CreatorStakeGate()
            );
        }
    }

    function _settleExit(address member, uint256 burnShares, bool fromQueue) internal {
        uint256 memberShares = sharesOf[member];
        require(memberShares >= burnShares, InsufficientShares());
        uint256 ts = totalShares;

        // Queued exits passed the gate at queue time (L-1); re-checking here could re-strand
        // them if membership grew in between — new joiners had on-chain notice of the queue.
        if (!fromQueue) _checkCreatorGate(member, burnShares);

        // Exit fee: decays with tenure, waived for a sole holder (fee would route to self;
        // last-member waiver per EE-8/EE-9 — it can never route to the operator).
        uint256 feeBps = _exitFeeBps(member);
        if (memberShares == ts) feeBps = 0;
        uint256 keepBps = BPS - feeBps;

        // ── Pass 1: internal accounting only (CEI — final before any external transfer) ──
        // Pro-rata payout; the exit-fee fraction of every slice STAYS in the vault, so NAVps
        // for remaining members is non-decreasing across any redemption (§4.6 invariant).
        // SV-5: the cash leg covers the exiter's share of idle AND child value, drawn from
        // idle stables FIRST; child positions are unwound only for the shortfall.
        uint256 childValTotalWad;
        for (uint256 i; i < childVaults.length; ++i) {
            childValTotalWad += _childValueWad(childVaults[i]);
        }
        // Both pro-rata legs divide ONCE, by `ts * BPS`: dividing by `ts` first discarded the
        // remainder before `keepBps` was applied. Still floors, so the exiter is still rounded
        // down and §4.6 holds; it just no longer loses a unit that belongs to them.
        uint256 tsBps = ts * BPS;
        uint256 burnKeep = burnShares * keepBps;
        uint256 cashTargetWad = (idleUsdc * usdcScalar + childValTotalWad) * burnKeep / tsBps;
        uint256 usdcPay = cashTargetWad / usdcScalar;
        if (usdcPay > idleUsdc) usdcPay = idleUsdc;
        uint256 shortfallWad = cashTargetWad - usdcPay * usdcScalar;
        uint256 payoutValueWad = usdcPay * usdcScalar;

        sharesOf[member] = memberShares - burnShares;
        totalShares = ts - burnShares;
        if (sharesOf[member] == 0 && memberShares > 0) {
            if (member != creator) --nonCreatorMemberCount;
            --holderCount;
        }
        _snapshot(member);

        uint256 basisRemoved = costBasisUsdc[member] * burnShares / memberShares;
        costBasisUsdc[member] -= basisRemoved;
        idleUsdc -= usdcPay;

        uint256[] memory slices = new uint256[](basketAssets.length);
        for (uint256 i; i < slices.length; ++i) {
            address a = basketAssets[i];
            uint256 slice = assetBalance[a] * burnKeep / tsBps;
            if (slice == 0) continue;
            assetBalance[a] -= slice;
            slices[i] = slice;
            payoutValueWad += _assetValueWad(a, slice);
        }

        // SV-5 shortfall: unwind children by value until the cash target is covered. The
        // proceeds (already net of the child's own fees — stacking is real and displayed,
        // SV-4) belong entirely to the exiter and never enter parent accounting.
        for (uint256 i; shortfallWad > SHORTFALL_DUST_WAD && i < childVaults.length; ++i) {
            address child = childVaults[i];
            // Finding 4 (S6): skip a child mid-rebalance — calling requestExit would queue the
            // parent's exit (Mode F) and revert deep in the stack. Skipping avoids the queue;
            // if no other child covers the shortfall the exit reverts cleanly below.
            if (_childPendingExecution(child)) continue;
            uint256 cv = _childValueWad(child);
            if (cv == 0) continue;
            uint256 takeWad = shortfallWad > cv ? cv : shortfallWad;
            uint256 cs = VaultCore(child).sharesOf(address(this)) * takeWad / cv;
            if (cs == 0) continue;
            (uint256 childUsdc, uint256[] memory childDeltas) = _redeemChildMeasured(child, cs, false);
            uint256 receivedWad = childUsdc * usdcScalar;
            usdcPay += childUsdc;
            for (uint256 j; j < childDeltas.length; ++j) {
                if (childDeltas[j] == 0) continue;
                slices[j] += childDeltas[j];
                receivedWad += _assetValueWad(basketAssets[j], childDeltas[j]);
            }
            payoutValueWad += receivedWad;
            // Finding 5 (S6): reduce the shortfall by what ACTUALLY arrived, never the intended
            // takeWad — a child that EE-6-escrows a slice back returns less, and must not be
            // recorded as satisfied (that silently underpaid the exiter).
            shortfallWad = receivedWad >= shortfallWad ? 0 : shortfallWad - receivedWad;
        }
        // Findings 4/5 (S6): if children could not cover the cash target now (all pending, or
        // in-kind slices escrowed), revert clean rather than silently underpay. The member
        // retries once children settle — bounded by the child timelock + execution window.
        require(shortfallWad <= SHORTFALL_DUST_WAD, ExitNeedsChildSettlement());

        // ── Realized P&L + performance fee ──
        // H-1: bookkeeping modules are called BOUNDED and non-blocking — value is defended by
        // the clamp, liveness by the bounded call. A failing module forfeits its own
        // bookkeeping (event-logged for the indexer) and can never block the exit itself.
        uint256 payoutValueUsdc = payoutValueWad / usdcScalar;
        uint256 perfFee;
        if (payoutValueUsdc > basisRemoved) {
            uint256 gain = payoutValueUsdc - basisRemoved;
            (bool feeOk, uint256 feeWord,) = address(feeEngine)
                .boundedCall(abi.encodeCall(IFeeEngine.onRealize, (member, gain, 0)), MODULE_CALL_GAS);
            if (feeOk) perfFee = feeWord;
            else emit ModuleCallFailed("feeEngine.onRealize", member);
            // Defensive clamp: never trust the module beyond its contract (≤ 10% of gain).
            uint256 cap = gain / 10;
            if (perfFee > cap) perfFee = cap;
            _recordRealization(member, gain, 0);
        } else {
            uint256 loss = basisRemoved - payoutValueUsdc;
            (bool ok,,) = address(feeEngine)
                .boundedCall(abi.encodeCall(IFeeEngine.onRealize, (member, 0, loss)), MODULE_CALL_GAS);
            if (!ok) emit ModuleCallFailed("feeEngine.onRealize", member);
            _recordRealization(member, 0, loss);
        }

        // M-2: the fee is withheld UNIFORMLY across the whole payout — cash and in-kind alike —
        // so a fully invested vault still pays the 10%-of-net-gain fee. gain ≤ payoutValue ⇒
        // feeFrac ≤ 10%. Rounding down under-collects in the member's favor.
        // One WAD fraction, resolved once and applied per leg, is what makes it uniform — so the
        // division here necessarily precedes the per-leg multiplications below (a known
        // divide-before-multiply, bounded at 1 wei per leg, always against the fee).
        uint256 feeFracWad = payoutValueWad == 0 ? 0 : perfFee * usdcScalar * WAD / payoutValueWad;

        // ── Pass 2: external transfers ──
        uint256 usdcFee = usdcPay * feeFracWad / WAD;
        usdcPay -= usdcFee;
        if (usdcFee > 0) {
            // M-2: the USDC legs had NO EE-6 escrow isolation, unlike every basket asset. This
            // one is the systemic case: `feeEngine` is a factory-wired singleton shared by every
            // vault, and it is exactly the address class a stablecoin issuer blacklists. Once
            // listed, a reverting `safeTransfer` here made EVERY exit carrying a positive
            // performance fee, in EVERY vault, revert permanently. Now it degrades to escrow,
            // exactly as an in-kind fee slice already did.
            if (_payOrEscrow(usdc, address(feeEngine), usdcFee)) {
                (bool collectOk,,) = address(feeEngine)
                    .boundedCall(
                        abi.encodeCall(IFeeEngine.onFeeCollected, (member, usdcFee)), MODULE_CALL_GAS
                    );
                if (!collectOk) emit ModuleCallFailed("feeEngine.onFeeCollected", member);
            }
        }

        for (uint256 i; i < slices.length; ++i) {
            uint256 slice = slices[i];
            if (slice == 0) continue;
            address a = basketAssets[i];
            uint256 feePart = slice * feeFracWad / WAD;
            uint256 memberPart = slice - feePart;
            // EE-6/H-2: bounded tryTransfer — a bad asset degrades to escrow, never a revert.
            _payOrEscrow(a, member, memberPart);
            if (feePart > 0) {
                if (_payOrEscrow(a, address(feeEngine), feePart)) {
                    (bool assetOk,,) = address(feeEngine)
                        .boundedCall(
                            abi.encodeCall(IFeeEngine.onFeeCollectedAsset, (member, a, feePart)),
                            MODULE_CALL_GAS
                        );
                    if (!assetOk) emit ModuleCallFailed("feeEngine.onFeeCollectedAsset", member);
                }
            }
        }
        // M-2: a blacklisted member could not exit AT ALL and lost their in-kind legs with it -
        // the precise outcome EE-6 exists to prevent, and the falsification of PX-1's claim that
        // in-kind redemption "keeps non-USDC basket assets exitable".
        if (usdcPay > 0) _payOrEscrow(usdc, member, usdcPay);

        emit ExitSettled(member, burnShares, usdcPay, feeBps, perfFee);
    }

    // ───────────────────────────── sub-vault flows ────────────────────────────

    /// @notice Allocate idle USDC into a registered child vault. Governance-only (a
    /// ChildAllocation proposal — standing defaults never apply, VO-4). Edges come from the
    /// SubVaultRegistry, so deposits flow ONLY along creation-time parent→child links (SV-3).
    /// @param child registered child vault (registry edge parentOf(child) == this)
    /// @param amountUsdc idle USDC to allocate into the child
    function allocateToChild(address child, uint256 amountUsdc) external nonReentrant {
        require(msg.sender == address(governance), OnlyGovernance());
        require(
            subVaultRegistry != address(0)
                && ISubVaultEdges(subVaultRegistry).parentOf(child) == address(this),
            NotRegisteredChild()
        );
        require(idleUsdc >= amountUsdc, InsufficientAssetBalance());

        if (!isChildVault[child]) {
            require(childVaults.length < MAX_CHILDREN, TooManyChildren());
            isChildVault[child] = true;
            childVaults.push(child);
            // First allocation: irrevocably skip the child's observation window — the parent's
            // own timelocked vote already served the scrutiny purpose (§5 reading for agents).
            VaultCore(child).skipWindow();
        }

        // Slither reads the debit-after-`skipWindow()` order as CEI-violating. It is not, but
        // the ordering is the lesser of the two reasons: this vault holds its own reentrancy
        // lock across the whole call, so `_fullNavWad` refuses to price it from outside no
        // matter where the debit sits. The ordering still earns its place — the debit books a
        // transfer that has NOT happened yet, so the accounting is truthful throughout
        // `skipWindow()`, and hoisting it above the call would CREATE an understatement inside
        // the lock rather than remove one. Reordering is safe; removing the lock is not.
        idleUsdc -= amountUsdc;
        usdc.safeApprove(child, amountUsdc);
        VaultCore(child).deposit(amountUsdc);
        usdc.safeApprove(child, 0);
        emit ChildAllocated(child, amountUsdc);
    }

    /// @notice Redeem child shares back into the parent. Governance-only. In-kind proceeds
    /// (child baskets ⊆ parent basket, factory-enforced) are credited to internal accounting
    /// from measured deltas. Reverts if the child queues the exit (Mode F) — retry after the
    /// child settles (bounded by the child's timelock + execution window).
    /// @param child child vault to redeem from (must be a locally registered child)
    /// @param shares child-vault shares to redeem
    function redeemFromChild(address child, uint256 shares) external nonReentrant {
        require(msg.sender == address(governance), OnlyGovernance());
        require(isChildVault[child], NotRegisteredChild());
        (uint256 usdcDelta,) = _redeemChildMeasured(child, shares, true);
        emit ChildRedeemed(child, shares, usdcDelta);
    }

    /// @dev Redeem `shares` from a child and measure proceeds. If `credit`, proceeds are
    /// credited to internal accounting (governance redemptions); otherwise the measured
    /// deltas stay un-credited for the caller to route (member-exit shortfall unwind).
    function _redeemChildMeasured(address child, uint256 shares, bool credit)
        internal
        returns (uint256 usdcDelta, uint256[] memory assetDeltas)
    {
        uint256 usdcBefore = _bal(usdc);
        uint256 n = basketAssets.length;
        assetDeltas = new uint256[](n);
        uint256[] memory before = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            before[i] = _bal(basketAssets[i]);
        }

        VaultCore(child).requestExit(shares);
        require(VaultCore(child).queuedExitShares(address(this)) == 0, ChildSettlementPending());

        usdcDelta = _bal(usdc) - usdcBefore;
        if (credit) idleUsdc += usdcDelta;
        for (uint256 i; i < n; ++i) {
            uint256 delta = _bal(basketAssets[i]) - before[i];
            assetDeltas[i] = delta;
            if (delta > 0 && credit) assetBalance[basketAssets[i]] += delta;
        }
    }

    /// @dev Bounded read of a child's own governance for its pending-execution state. On any
    /// failure returns false — a child whose governance is broken settles Mode I anyway (its
    /// own _pendingExecution falls back to false), so attempting the redeem is safe.
    function _childPendingExecution(address child) internal view returns (bool) {
        return _hasPendingExecution(address(VaultCore(child).governance()), child);
    }

    /// @notice Crank: pull a slice the child escrowed for this vault (child EE-6 path) and
    /// credit it. Permissionless.
    /// @param child child vault holding the escrowed slice
    /// @param asset USDC or a basket asset to claim from the child's escrow
    function pullChildEscrow(address child, address asset) external nonReentrant {
        require(isChildVault[child], NotRegisteredChild());
        require(assetUnit[asset] != 0 || asset == usdc, BadSwapToken());
        uint256 before = _bal(asset);
        VaultCore(child).claimEscrowed(asset);
        uint256 delta = _bal(asset) - before;
        if (asset == usdc) idleUsdc += delta;
        else assetBalance[asset] += delta;
    }

    // ───────────────────────────── rebalancing ────────────────────────────────

    /// @notice Execute a passed rebalance: governance-only, allowlisted adapter, every leg's
    /// tokens constrained to USDC + basket, every output measured by the vault's OWN balance
    /// delta (EX-3 — the adapter's word is never the accounting source).
    /// @dev NAV IS UNDERSTATED MID-EXECUTION, and making that unobservable is what the
    /// `nonReentrant` guard is for. Each leg debits its input before the swap and credits the
    /// measured output after, so between those two writes this vault's accounting omits the
    /// whole in-transit leg. The window cannot be closed: the output is not knowable until the
    /// swap returns, and taking the adapter's claimed amount instead is precisely EX-3. So the
    /// understatement is hidden rather than removed — `locked()` is true for the whole call and
    /// `_fullNavWad` refuses to price a locked vault. DO NOT DELETE that `require(!v.locked())`
    /// to reclaim bytes: a parent pricing a mid-swap child mints against the understated NAV,
    /// demonstrated at 2,000e18 shares for 1,000 USDC in
    /// test/audit/AuditLookThroughReadOnlyReentrancy.t.sol.
    /// @param adapter allowlisted execution adapter to route every leg through
    /// @param orders swap legs; tokenIn/tokenOut restricted to USDC + basket assets
    function executeRebalance(address adapter, IExecutionAdapter.SwapOrder[] calldata orders)
        external
        nonReentrant
    {
        require(msg.sender == address(governance), OnlyGovernance());
        require(isAllowedAdapter[adapter], AdapterNotAllowed());

        for (uint256 i; i < orders.length; ++i) {
            IExecutionAdapter.SwapOrder calldata o = orders[i];
            require(o.tokenOut == usdc || assetUnit[o.tokenOut] != 0, BadSwapToken());

            // H-4: bound the ORDER against the vault's own oracle before executing it. The
            // measured-delta check below (`received >= o.minAmountOut`) is a genuine defence
            // against a lying router (EX-3) and is frequently mistaken for a slippage bound; it
            // is not one. This is the slippage bound. It costs rebalancing a dependency on
            // oracle liveness, which is consistent with the rest of the design — every other
            // NAV path already freezes on staleness (K-4) — but it is a real coupling and is
            // stated rather than assumed.
            require(
                _valueWad(o.tokenOut, o.minAmountOut) * BPS
                    >= _valueWad(o.tokenIn, o.amountIn) * (BPS - MAX_REBALANCE_SLIPPAGE_BPS),
                MinOutTooLow()
            );

            // Debit internal accounting for the input leg.
            if (o.tokenIn == usdc) {
                require(idleUsdc >= o.amountIn, InsufficientAssetBalance());
                idleUsdc -= o.amountIn;
            } else {
                require(assetUnit[o.tokenIn] != 0, BadSwapToken());
                require(assetBalance[o.tokenIn] >= o.amountIn, InsufficientAssetBalance());
                assetBalance[o.tokenIn] -= o.amountIn;
            }

            o.tokenIn.safeApprove(adapter, o.amountIn);
            uint256 outBefore = _bal(o.tokenOut);
            uint256 inBefore = _bal(o.tokenIn);
            IExecutionAdapter(adapter).executeSwap(o);
            uint256 received = _bal(o.tokenOut) - outBefore;
            require(received >= o.minAmountOut, SwapSlippage());
            o.tokenIn.safeApprove(adapter, 0);

            // Credit internal accounting with the measured output.
            if (o.tokenOut == usdc) idleUsdc += received;
            else assetBalance[o.tokenOut] += received;

            // Finding 3 (S6): refund UNSPENT input measured from this swap's own balance delta,
            // never from a whole-vault balance-vs-accounting comparison — the latter absorbed
            // EE-6 escrow and donations. spent = inBefore - inAfter ≤ amountIn (approval-bounded).
            uint256 inAfter = _bal(o.tokenIn);
            uint256 spent = inBefore - inAfter;
            if (o.amountIn > spent) {
                uint256 refund = o.amountIn - spent;
                if (o.tokenIn == usdc) idleUsdc += refund;
                else assetBalance[o.tokenIn] += refund;
            }
        }
        emit RebalanceExecuted(adapter, orders.length);
    }

    /// @dev EE-6 payout primitive: attempt a bounded transfer and, on ANY failure, escrow the
    /// amount for later `claimEscrowed`. This is the shape all five payout legs share — member
    /// slice, member USDC, both fee legs, and the cancelled-deposit refund — so it is emitted
    /// once rather than five times.
    /// @return ok true when the transfer landed; false means the amount is now escrowed.
    function _payOrEscrow(address asset, address to, uint256 amount) internal returns (bool ok) {
        ok = asset.tryTransfer(to, amount, MODULE_CALL_GAS);
        if (!ok) {
            claimable[to][asset] += amount;
            emit SliceEscrowed(to, asset, amount);
        }
    }

    /// @dev This vault's own balance of `token`. Every measured-delta site in the contract
    /// funnels through here, so the external-call sequence is emitted once rather than twelve
    /// times.
    function _bal(address token) internal view returns (uint256) {
        return IERC20Metadata(token).balanceOf(address(this));
    }

    /// @dev USD value of `amount` units of `token`, WAD. USDC is the settlement unit and is
    /// valued at par, exactly as every other NAV path values it (`:251`, `:282`).
    /// @param token USDC or a basket asset
    /// @param amount raw token units
    /// @return WAD-scaled USD value
    function _valueWad(address token, uint256 amount) internal view returns (uint256) {
        if (token == usdc) return amount * usdcScalar;
        return _assetValueWad(token, amount);
    }

    /// @dev USD value of `amount` units of a BASKET asset, WAD. The oracle read plus the
    /// unit-scaling division is the single most repeated expression in the contract (five
    /// sites: both NAV walks, both payout legs, and `_valueWad`); emitting it once is worth
    /// real EIP-170 headroom. Multiplication precedes division exactly as at every former
    /// site, so every rounding result is bit-identical.
    function _assetValueWad(address asset, uint256 amount) internal view returns (uint256) {
        return amount * oracle.priceWad(asset) / assetUnit[asset];
    }

    /// @dev H-1: best-effort mark recording — a reverting registry loses the mark (event-logged),
    /// never the member's exit.
    function _recordRealization(address member, uint256 gainUsdc, uint256 lossUsdc) internal {
        (bool ok,,) = address(operatorRegistry)
            .boundedCall(
                abi.encodeCall(IOperatorRegistry.recordRealization, (member, gainUsdc, lossUsdc)),
                MODULE_CALL_GAS
            );
        if (!ok) emit ModuleCallFailed("registry.recordRealization", member);
    }

    /// @notice Claim an in-kind slice that was escrowed after a failed asset transfer (EE-6).
    /// @param asset the escrowed token to claim; reverts if nothing is claimable
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
    /// @param member the member queried (a registered parent vault always reads 0)
    /// @return eligible share weight for `member`
    function votingEligibleShares(address member) external view returns (uint256) {
        if (member == parentVault()) return 0; // parent vault is a non-voting member
        return sharesOf[member] - queuedExitShares[member];
    }

    /// @notice Total voting-eligible stake: supply minus Mode-F-locked shares minus the parent
    /// vault's non-voting position.
    function totalVotingEligibleShares() external view returns (uint256) {
        return _totalEligibleShares(parentVault());
    }

    /// @notice Voting-eligible stake of `member` as of timestamp `ts` (proposal snapshots).
    /// @param member the member queried
    /// @param ts historical timestamp (Governance reads createdAt − 1, VO-9)
    /// @return the last checkpointed eligible weight at or before `ts` (0 if none)
    function pastVotingEligibleShares(address member, uint64 ts) external view returns (uint256) {
        return _eligibleHist[member].getAt(ts);
    }

    /// @notice Total voting-eligible stake as of timestamp `ts` (quorum denominators).
    /// @param ts historical timestamp (Governance reads createdAt − 1, VO-9)
    function pastTotalVotingEligibleShares(uint64 ts) external view returns (uint256) {
        return _totalEligibleHist.getAt(ts);
    }

    /// @notice Holder count as of `ts` — drives the <5-member absolute-signer-count regime
    /// (CM-7: regime is fixed per proposal at creation, membership changes never flip it).
    /// @param ts historical timestamp (Governance reads createdAt − 1)
    function pastHolderCount(uint64 ts) external view returns (uint256) {
        return _holderCountHist.getAt(ts);
    }

    /// @notice Current tenure-decayed exit fee for `member`, in bps (before any sole-holder
    /// waiver applied at settlement).
    function exitFeeBpsOf(address member) external view returns (uint256) {
        return _exitFeeBps(member);
    }

    /// @notice Number of basket assets (excludes USDC).
    function basketLength() external view returns (uint256) {
        return basketAssets.length;
    }

    /// @notice False when the vault opted out of a capacity cap (capacityCapUsdc == 0).
    function isCapped() external view returns (bool) {
        return capacityCapUsdc != 0;
    }

    // 4626-SHAPED, INDICATIVE ONLY (C-1): no compliance claim; previews ignore exit fees,
    // observation windows, forward pricing and in-kind mechanics.

    /// @notice Indicative-only NAV in USDC units (C-1: NOT an ERC-4626 compliance claim).
    function totalAssets() external view returns (uint256) {
        return navWad() / usdcScalar;
    }

    /// @notice Indicative-only share preview for a USDC amount; ignores window, fees and
    /// forward pricing (C-1).
    function convertToShares(uint256 assets) external view returns (uint256) {
        uint256 ts = totalShares;
        return ts == 0 ? assets * usdcScalar : assets * usdcScalar * ts / navWad();
    }

    /// @notice Indicative-only USDC value of `shares`; the real redemption is in-kind and
    /// fee-bearing (C-1).
    function convertToAssets(uint256 shares) external view returns (uint256) {
        uint256 ts = totalShares;
        return ts == 0 ? shares / usdcScalar : shares * navWad() / ts / usdcScalar;
    }
}
