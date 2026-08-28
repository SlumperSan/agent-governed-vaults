// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IGovernance} from "./interfaces/IGovernance.sol";
import {IExecutionAdapter} from "./interfaces/IExecutionAdapter.sol";

interface IVaultExecution {
    function executeRebalance(address adapter, IExecutionAdapter.SwapOrder[] calldata orders) external;
    function allocateToChild(address child, uint256 amountUsdc) external;
    function redeemFromChild(address child, uint256 shares) external;
}

interface IVaultSnapshots {
    function creator() external view returns (address);
    function pastVotingEligibleShares(address member, uint64 ts) external view returns (uint256);
    function votingEligibleShares(address member) external view returns (uint256);
    function pastTotalVotingEligibleShares(uint64 ts) external view returns (uint256);
    function pastHolderCount(uint64 ts) external view returns (uint256);
}

/// @title Governance — commit-reveal proposals, quorum, standing defaults, delegation, timelock
/// @notice Sprint 2 module. One active proposal per vault (serialization is the CM-6 spam
/// defense and keeps the Mode-F exit coupling in VaultCore unambiguous).
///
/// Lifecycle:  propose → commit phase → reveal phase → finalize → [timelock] → execute | expire
///
/// Mode-F coupling (VO-8, K-1): `hasPendingExecution` turns true at REVEAL START, not at
/// finalize — once reveals begin, the outcome leaks on-chain, so an exit taken after that point
/// must be forward-priced. It turns false on Defeated / Executed / expiry (EE-10: queued exits
/// can always settle eventually).
///
/// Voting power is read from VaultCore checkpoints at proposal creation (VO-9): stake minted
/// after `createdAt` — flash deposits included — carries zero weight, and Mode-F-locked or
/// pending-deposit capital is already excluded by the vault's eligible-stake accounting.
interface ISubVaultParent {
    function parentOf(address child) external view returns (address);
}

contract Governance is IGovernance {
    address public subVaultRegistry; // one-shot deploy wiring
    address public immutable deployer = msg.sender;

    error OnlyDeployer();
    error AlreadyWiredSubRegistry();
    error ZeroSubRegistry();

    /// @notice One-shot deploy-time wiring of the SubVaultRegistry used for SV-6 quorum-floor
    /// inheritance. Deployer-only, callable once, permanently locked after.
    /// @param r the SubVaultRegistry address (nonzero)
    function wireSubVaultRegistry(address r) external {
        require(msg.sender == deployer, OnlyDeployer());
        require(subVaultRegistry == address(0), AlreadyWiredSubRegistry());
        require(r != address(0), ZeroSubRegistry());
        subVaultRegistry = r;
    }

    uint256 internal constant BPS = 10_000;
    uint256 public constant QUORUM_FLOOR_BPS = 2_500; // 25% protocol floor
    uint256 public constant TIMELOCK_HARD_CAP = 30 days;
    /// @notice Upper bounds on the phase durations (AI pre-audit C-2). These were FLOOR-ONLY, and
    /// every one of them is `uint32` — settable to ~136 years. That is not a theoretical range:
    /// a vault frozen mid-proposal cannot legislate its way out, because `_isSettled` counts only
    /// Defeated/Executed/Expired, so an unresolvable proposal also blocks every future proposal,
    /// including the `RuleChange` that would shorten the window. Meanwhile `hasPendingExecution`
    /// stays true, so `requestExit` queues Mode-F and `settleQueuedExit` reverts — every exit in
    /// the vault is frozen, permanently, with no admin and no upgrade path to undo it.
    /// Confirmed by `test/audit/AuditExecutionWindowFreeze.t.sol` and `AuditDosExitLiveness.t.sol`.
    uint256 public constant COMMIT_HARD_CAP = 30 days;
    uint256 public constant REVEAL_HARD_CAP = 30 days;
    uint256 public constant EXECUTION_WINDOW_HARD_CAP = 90 days;
    uint256 public constant DEFAULT_TTL = 72 hours; // standing-default expiry
    uint256 public constant SIGNER_REGIME_BELOW = 5; // <5 members ⇒ absolute signer counts

    enum ProposalType {
        Rebalance, // routine — the only type standing defaults apply to (VO-4)
        RuleChange, // full consensus + timelock (CM-8 / K-2)
        ChildAllocation // sub-vault capital moves (SV-1); normal quorum, no defaults
    }

    enum Status {
        None,
        Active,
        Passed,
        Defeated,
        Executed,
        Expired
    }

    struct GovConfig {
        uint32 commitDuration;
        uint32 revealDuration;
        uint32 timelockDuration; // ≤ 30 days (hard cap)
        uint32 executionWindow;
        uint16 quorumBps; // ≥ 2500
        uint16 proposalThresholdBps; // stake required to propose (CM-6)
        uint16 concentrationCapBps; // max delegate weight incl. own (VO-5)
        uint32 proposalCooldown; // per-proposer (CM-6)
    }

    struct Proposal {
        address vault;
        ProposalType ptype;
        address proposer;
        uint64 createdAt; // snapshot timestamp
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint64 executableAt;
        uint64 expiresAt;
        Status status;
        bytes32 actionHash; // keccak256 of the execution payload
        uint256 snapshotTotal; // eligible stake at createdAt
        uint256 memberCount; // holders at createdAt — fixes the quorum regime (CM-7)
        uint256 forWeight; // includes applied standing defaults
        uint256 againstWeight; // includes applied standing defaults
        uint256 revealedWeight; // revealed votes ONLY — the quorum numerator (VO-2)
        uint256 revealedVoterCount; // signer-regime quorum numerator
    }

    struct StandingDefault {
        bool set;
        bool support;
        uint64 setAt;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bytes32)) public commitOf;
    mapping(uint256 => mapping(address => bool)) public revealedOf;
    mapping(uint256 => mapping(address => bool)) public revealedSupportOf; // valid iff revealedOf
    mapping(uint256 => mapping(address => bool)) public defaultApplied;
    mapping(uint256 => mapping(address => uint256)) public delegateAccrued; // incl. own weight

    mapping(address => GovConfig) public configOf; // per vault
    mapping(address => bool) public vaultRegistered;
    mapping(address => uint256) public activeProposalOf; // vault ⇒ pid (0 = none)
    mapping(address => mapping(address => StandingDefault)) public standingDefaultOf;
    mapping(address => mapping(address => address)) public delegateOf; // vault ⇒ member ⇒ delegate
    mapping(address => mapping(address => uint64)) public lastProposalAt; // vault ⇒ proposer

    event VaultRegistered(address indexed vault, GovConfig config);
    event Proposed(
        uint256 indexed pid,
        address indexed vault,
        ProposalType ptype,
        address indexed proposer,
        bytes32 actionHash
    );
    event Committed(uint256 indexed pid, address indexed voter);
    event Revealed(uint256 indexed pid, address indexed voter, bool support, uint256 weight);
    event DefaultApplied(uint256 indexed pid, address indexed member, bool support, uint256 weight);
    event DelegatedRevealed(
        uint256 indexed pid, address indexed delegator, address indexed delegate, uint256 weight
    );
    event Finalized(uint256 indexed pid, Status status);
    event Executed(uint256 indexed pid);
    event ProposalExpired(uint256 indexed pid);
    event StandingDefaultSet(address indexed vault, address indexed member, bool support);
    event StandingDefaultCleared(address indexed vault, address indexed member);
    event DelegateSet(address indexed vault, address indexed member, address delegate);

    error AlreadyRegistered();
    error NotRegistered();
    error NotVaultCreator();
    error BadGovConfig();
    error ProposalActive();
    error NoActiveProposal();
    error BelowProposalThreshold();
    error Cooldown();
    error WrongPhase();
    error NoWeight();
    error AlreadyCommitted();
    error NoCommit();
    error BadReveal();
    error AlreadyRevealed();
    error NotRebalance();
    error DefaultUnavailable();
    error HasDelegate();
    error DelegateNotRevealed();
    error ConcentrationCap();
    error NotPassed();
    error TimelockActive();
    error ExecutionWindowOver();
    error BadPayload();
    error CannotDelegateDuringProposal();

    // ─────────────────────────── registration ─────────────────────────────────

    /// @notice Register a vault's governance config. Once, by the vault's creator. Config is
    /// thereafter immutable except via a full-consensus RuleChange proposal (CM-8).
    /// @param vault the VaultCore to register
    /// @param cfg governance parameters (validated; child quorum must respect the parent floor)
    function registerVault(address vault, GovConfig calldata cfg) external {
        require(!vaultRegistered[vault], AlreadyRegistered());
        require(msg.sender == IVaultSnapshots(vault).creator(), NotVaultCreator());
        _validateConfig(cfg);
        // SV-6: child quorum floors inherit — a child may never be easier to pass than its
        // parent. Effective floor = max(childFloor, parentFloor).
        _requireParentQuorumFloor(vault, cfg.quorumBps);
        vaultRegistered[vault] = true;
        configOf[vault] = cfg;
        emit VaultRegistered(vault, cfg);
    }

    /// @dev SV-6 quorum-floor inheritance, enforced at BOTH registration and RuleChange update.
    function _requireParentQuorumFloor(address vault, uint16 quorumBps) internal view {
        if (subVaultRegistry == address(0)) return;
        address parent = ISubVaultParent(subVaultRegistry).parentOf(vault);
        if (parent != address(0) && vaultRegistered[parent]) {
            require(quorumBps >= configOf[parent].quorumBps, BadGovConfig());
        }
    }

    function _validateConfig(GovConfig memory cfg) internal pure {
        require(cfg.commitDuration >= 1 hours && cfg.commitDuration <= COMMIT_HARD_CAP, BadGovConfig());
        require(cfg.revealDuration >= 1 hours && cfg.revealDuration <= REVEAL_HARD_CAP, BadGovConfig());
        require(cfg.timelockDuration <= TIMELOCK_HARD_CAP, BadGovConfig());
        require(
            cfg.executionWindow >= 1 hours && cfg.executionWindow <= EXECUTION_WINDOW_HARD_CAP, BadGovConfig()
        );
        require(cfg.quorumBps >= QUORUM_FLOOR_BPS && cfg.quorumBps <= BPS, BadGovConfig());
        require(cfg.proposalThresholdBps <= BPS, BadGovConfig());
        require(cfg.concentrationCapBps > 0 && cfg.concentrationCapBps <= BPS, BadGovConfig());
    }

    // ───────────────────────────── proposals ──────────────────────────────────

    /// @notice Open a proposal. One active proposal per vault (CM-6 serialization); proposer
    /// must clear the stake threshold and cooldown; snapshots are taken strictly before
    /// creation so same-second (flash) stake carries zero weight (VO-9).
    /// @param vault the target vault (must be registered)
    /// @param ptype Rebalance | RuleChange | ChildAllocation — fixes quorum regime and payload shape
    /// @param actionHash keccak256 of the exact execution payload voters are approving
    /// @return pid the new proposal id
    function propose(address vault, ProposalType ptype, bytes32 actionHash) external returns (uint256 pid) {
        require(vaultRegistered[vault], NotRegistered());
        GovConfig memory cfg = configOf[vault];

        uint256 activePid = activeProposalOf[vault];
        if (activePid != 0) {
            _refreshStatus(activePid);
            require(_isSettled(proposals[activePid].status), ProposalActive());
        }
        uint64 lastAt = lastProposalAt[vault][msg.sender];
        require(lastAt == 0 || block.timestamp >= lastAt + cfg.proposalCooldown, Cooldown());

        uint64 nowTs = uint64(block.timestamp);
        // Snapshots read strictly BEFORE creation (nowTs - 1): stake minted in the same block
        // as the proposal — flash-loan deposits included — carries zero weight (VO-9).
        IVaultSnapshots v = IVaultSnapshots(vault);
        uint256 total = v.pastTotalVotingEligibleShares(nowTs - 1);
        uint256 own = v.pastVotingEligibleShares(msg.sender, nowTs - 1);
        require(own > 0, NoWeight());
        // Proposal rights scale with stake (CM-6).
        require(own * BPS >= uint256(cfg.proposalThresholdBps) * total, BelowProposalThreshold());

        pid = ++proposalCount;
        Proposal storage p = proposals[pid];
        p.vault = vault;
        p.ptype = ptype;
        p.proposer = msg.sender;
        p.createdAt = nowTs;
        p.commitDeadline = nowTs + cfg.commitDuration;
        p.revealDeadline = nowTs + cfg.commitDuration + cfg.revealDuration;
        p.status = Status.Active;
        p.actionHash = actionHash;
        p.snapshotTotal = total;
        p.memberCount = v.pastHolderCount(nowTs - 1);

        activeProposalOf[vault] = pid;
        lastProposalAt[vault][msg.sender] = nowTs;
        emit Proposed(pid, vault, ptype, msg.sender, actionHash);
    }

    // ─────────────────────────── commit-reveal ────────────────────────────────

    /// @dev C-5 remediation — **exiting forfeits voice on an in-flight proposal.**
    ///
    /// Every weight read is `pastVotingEligibleShares(voter, createdAt - 1)`, and
    /// `Checkpoints.getAt` returns the last checkpoint at or before that timestamp. The
    /// checkpoint written when a member EXITS is stamped at the current block — strictly after
    /// `createdAt - 1` — so it was invisible to a proposal already in flight. Worse, the exit
    /// settled instantly and in full: `hasPendingExecution` is false for the entire commit
    /// phase, so `requestExit` took the Mode-I branch and paid out immediately.
    ///
    /// An attacker could therefore deposit a dominant position, propose one block later, exit
    /// completely, and then reveal FOR with the full snapshot weight on stake they no longer
    /// owned. Not free — they carry round-trip price risk across a couple of blocks — but it
    /// reduced the skin-in-the-game requirement from DAYS (reveal + timelock + execution
    /// window, up to 30 days of timelock alone) to seconds. That alignment is the entire reason
    /// the timelock exists.
    ///
    /// Taking the MINIMUM of snapshot and current weight preserves VO-9 in the direction it
    /// already handled (stake acquired after creation still carries zero weight, because the
    /// snapshot term is zero) and closes the withdrawal direction, which was the profitable one.
    /// It also finally makes EE-10's claim true — Mode-F-locked shares now do lose eligibility
    /// on the proposal that motivated the queue, not merely on future ones.
    /// @param p the proposal being voted on
    /// @param member the voter or delegator whose weight is being measured
    /// @return the lesser of snapshot weight and current voting-eligible weight
    function _boundedWeight(Proposal storage p, address member) internal view returns (uint256) {
        uint256 snap = IVaultSnapshots(p.vault).pastVotingEligibleShares(member, p.createdAt - 1);
        uint256 cur = IVaultSnapshots(p.vault).votingEligibleShares(member);
        return snap < cur ? snap : cur;
    }

    /// @notice Commit `keccak256(abi.encode(pid, voter, support, salt))` during the commit phase.
    /// @param pid the proposal id
    /// @param commitment the vote commitment hash (binds pid + voter — no cross-proposal replay)
    function commitVote(uint256 pid, bytes32 commitment) external {
        Proposal storage p = proposals[pid];
        require(p.status == Status.Active && block.timestamp < p.commitDeadline, WrongPhase());
        require(commitOf[pid][msg.sender] == bytes32(0), AlreadyCommitted());
        require(_boundedWeight(p, msg.sender) > 0, NoWeight());
        commitOf[pid][msg.sender] = commitment;
        emit Committed(pid, msg.sender);
    }

    /// @notice Reveal during the reveal phase. Unrevealed commits are forfeit — they count
    /// toward nothing (VO-6: non-reveal costs the committer their voice, not the vault its
    /// quorum). Research note: mature systems lost votes to *forgotten* reveals (Kleros) —
    /// agents should automate reveal; the standing-default mechanism is the routine fallback.
    /// @param pid the proposal id
    /// @param support the committed vote direction (must match the commitment)
    /// @param salt the committed salt
    function revealVote(uint256 pid, bool support, bytes32 salt) external {
        Proposal storage p = proposals[pid];
        require(
            p.status == Status.Active && block.timestamp >= p.commitDeadline
                && block.timestamp < p.revealDeadline,
            WrongPhase()
        );
        bytes32 c = commitOf[pid][msg.sender];
        require(c != bytes32(0), NoCommit());
        require(!revealedOf[pid][msg.sender], AlreadyRevealed());
        require(c == keccak256(abi.encode(pid, msg.sender, support, salt)), BadReveal());

        revealedOf[pid][msg.sender] = true;
        revealedSupportOf[pid][msg.sender] = support;
        // F1 (S6): a member's OWN weight is never concentration-capped — only weight RECEIVED
        // via delegation is (architecture §8). Self-accrual here made any holder above the cap
        // unable to reveal, bricking sole/dominant-holder vaults and RuleChange consensus.
        uint256 weight = _boundedWeight(p, msg.sender);

        if (support) p.forWeight += weight;
        else p.againstWeight += weight;
        p.revealedWeight += weight;
        ++p.revealedVoterCount;
        emit Revealed(pid, msg.sender, support, weight);
    }

    /// @notice Crank a non-participating delegator's weight onto their delegate's revealed
    /// direction. Permissionless. Self-participation (commit) takes precedence over delegation.
    /// @param pid the proposal id
    /// @param delegator the member whose standing delegation should be applied
    function revealDelegated(uint256 pid, address delegator) external {
        Proposal storage p = proposals[pid];
        require(
            p.status == Status.Active && block.timestamp >= p.commitDeadline
                && block.timestamp < p.revealDeadline,
            WrongPhase()
        );
        address del = delegateOf[p.vault][delegator];
        require(del != address(0), DefaultUnavailable());
        require(commitOf[pid][delegator] == bytes32(0), AlreadyCommitted()); // self-vote wins
        require(!defaultApplied[pid][delegator], AlreadyRevealed()); // consumed flag
        require(revealedOf[pid][del], DelegateNotRevealed());
        bool support = revealedSupportOf[pid][del];

        uint256 weight = _boundedWeight(p, delegator);
        require(weight > 0, NoWeight());
        defaultApplied[pid][delegator] = true;
        _accrueDelegate(pid, del, weight, p);

        if (support) p.forWeight += weight;
        else p.againstWeight += weight;
        p.revealedWeight += weight; // delegated reveals are live participation → count in quorum
        emit DelegatedRevealed(pid, delegator, del, weight);
    }

    /// @dev Concentration cap (VO-5): a delegate's accrued weight — own reveal plus all cranked
    /// delegations — may not exceed concentrationCapBps of the snapshot total. Checked at tally
    /// accrual, i.e. re-checked at vote time, not just at delegation time.
    function _accrueDelegate(uint256 pid, address delegate_, uint256 weight, Proposal storage p) internal {
        uint256 accrued = delegateAccrued[pid][delegate_] + weight;
        require(
            accrued * BPS <= uint256(configOf[p.vault].concentrationCapBps) * p.snapshotTotal,
            ConcentrationCap()
        );
        delegateAccrued[pid][delegate_] = accrued;
    }

    // ─────────────────────────── standing defaults ────────────────────────────

    /// @notice Declare a standing absentee vote for future ROUTINE REBALANCE proposals on
    /// `vault`. Expires 72h after being set (VO-3); only applies to proposals created AFTER it
    /// was set (G4). Counts toward tallies, never toward quorum (VO-2/K-3).
    /// @param vault the vault the default applies to
    /// @param support the pre-declared direction
    function setStandingDefault(address vault, bool support) external {
        require(vaultRegistered[vault], NotRegistered());
        standingDefaultOf[vault][msg.sender] = StandingDefault(true, support, uint64(block.timestamp));
        emit StandingDefaultSet(vault, msg.sender, support);
    }

    /// @notice Clear the caller's standing default for `vault`.
    function clearStandingDefault(address vault) external {
        delete standingDefaultOf[vault][msg.sender];
        emit StandingDefaultCleared(vault, msg.sender);
    }

    /// @notice Apply a member's standing default to an active ROUTINE REBALANCE tally during
    /// the reveal phase. Permissionless crank. Defaults count toward the tally, NEVER toward
    /// quorum (VO-2/K-3), expire 72h after being set (VO-3), and are structurally limited to
    /// the Rebalance proposal type on-chain (VO-4 — the type is not proposer-asserted text).
    /// @param pid the proposal id (must be a Rebalance in its reveal phase)
    /// @param member the non-participating member whose default should be applied
    function applyStandingDefault(uint256 pid, address member) external {
        Proposal storage p = proposals[pid];
        require(
            p.status == Status.Active && block.timestamp >= p.commitDeadline
                && block.timestamp < p.revealDeadline,
            WrongPhase()
        );
        require(p.ptype == ProposalType.Rebalance, NotRebalance());
        require(commitOf[pid][member] == bytes32(0), AlreadyCommitted()); // self-vote precedence
        require(delegateOf[p.vault][member] == address(0), HasDelegate()); // delegate precedence
        require(!defaultApplied[pid][member], AlreadyRevealed());

        StandingDefault memory d = standingDefaultOf[p.vault][member];
        // F4 (S6): the default must be genuinely STANDING — set before the proposal existed —
        // and within its 72h TTL. The lower bound blocks tally-aware reveal-phase defaults.
        require(
            d.set && d.setAt < p.createdAt && block.timestamp <= d.setAt + DEFAULT_TTL, DefaultUnavailable()
        );

        uint256 weight = _boundedWeight(p, member);
        require(weight > 0, NoWeight());
        defaultApplied[pid][member] = true;

        if (d.support) p.forWeight += weight;
        else p.againstWeight += weight;
        // NOT added to revealedWeight / revealedVoterCount: tally yes, quorum never.
        emit DefaultApplied(pid, member, d.support, weight);
    }

    // ─────────────────────────────── delegation ───────────────────────────────

    /// @notice Set or clear (address(0)) a standing delegate for a vault. Not changeable while
    /// a proposal is in flight — prevents mid-proposal delegation games.
    /// @param vault the vault the delegation applies to
    /// @param delegate_ the delegate whose revealed direction carries the caller's weight
    function setDelegate(address vault, address delegate_) external {
        require(vaultRegistered[vault], NotRegistered());
        uint256 activePid = activeProposalOf[vault];
        if (activePid != 0) {
            _refreshStatus(activePid);
            require(_isSettled(proposals[activePid].status), CannotDelegateDuringProposal());
        }
        delegateOf[vault][msg.sender] = delegate_;
        emit DelegateSet(vault, msg.sender, delegate_);
    }

    // ─────────────────────────── finalize / execute ───────────────────────────

    /// @notice Tally a proposal after its reveal deadline. Quorum regime: RuleChange = full
    /// consensus; <5 members at creation = strict signer majority (CM-7); otherwise revealed
    /// stake ≥ quorumBps of snapshot (VO-2). Passing starts the timelock + execution window.
    /// @param pid the proposal id
    function finalize(uint256 pid) external {
        Proposal storage p = proposals[pid];
        require(p.status == Status.Active && block.timestamp >= p.revealDeadline, WrongPhase());

        bool quorumOk;
        if (p.ptype == ProposalType.RuleChange) {
            // Full consensus (CM-8/K-2): every unit of snapshot-eligible stake revealed FOR.
            // Standing defaults never contribute (they are routine-rebalance-only anyway).
            quorumOk = p.revealedWeight == p.snapshotTotal && p.forWeight >= p.snapshotTotal;
        } else if (p.memberCount < SIGNER_REGIME_BELOW) {
            // Absolute signer counts (CM-7): strict majority of members-at-creation revealed.
            quorumOk = p.revealedVoterCount * 2 > p.memberCount;
        } else {
            // Stake quorum: revealed (live) weight only — defaults never count (VO-2).
            quorumOk = p.revealedWeight * BPS >= uint256(configOf[p.vault].quorumBps) * p.snapshotTotal;
        }

        if (quorumOk && p.forWeight > p.againstWeight) {
            p.status = Status.Passed;
            GovConfig memory cfg = configOf[p.vault];
            p.executableAt = uint64(block.timestamp) + cfg.timelockDuration;
            p.expiresAt = p.executableAt + cfg.executionWindow;
        } else {
            p.status = Status.Defeated;
        }
        emit Finalized(pid, p.status);
    }

    /// @notice Execute a passed proposal after its timelock, within its execution window.
    /// Rebalance payload execution is wired to the execution adapter in Sprint 4; in Sprint 2
    /// execution is the state transition that releases Mode-F queued exits at post-vote NAV.
    /// @param pid the passed proposal id
    /// @param payload the exact bytes hashed into actionHash at propose time; decoded per the
    /// stored proposal type (never inferred from payload shape)
    function execute(uint256 pid, bytes calldata payload) external {
        Proposal storage p = proposals[pid];
        require(p.status == Status.Passed, NotPassed());
        require(block.timestamp >= p.executableAt, TimelockActive());
        require(block.timestamp <= p.expiresAt, ExecutionWindowOver());
        require(keccak256(payload) == p.actionHash, BadPayload());

        p.status = Status.Executed;
        if (p.ptype == ProposalType.RuleChange) {
            GovConfig memory newCfg = abi.decode(payload, (GovConfig));
            _validateConfig(newCfg);
            _requireParentQuorumFloor(p.vault, newCfg.quorumBps); // F2 (S6): SV-6 also on update
            configOf[p.vault] = newCfg;
        } else if (p.ptype == ProposalType.ChildAllocation) {
            (address child, uint256 allocateUsdc, uint256 redeemShares) =
                abi.decode(payload, (address, uint256, uint256));
            if (allocateUsdc > 0) IVaultExecution(p.vault).allocateToChild(child, allocateUsdc);
            if (redeemShares > 0) IVaultExecution(p.vault).redeemFromChild(child, redeemShares);
        } else if (payload.length > 0) {
            // Rebalance: decode the committed orders and drive the vault's execution path.
            // The payload hash was fixed at proposal time — voters approved THESE orders.
            (address adapter, IExecutionAdapter.SwapOrder[] memory orders) =
                abi.decode(payload, (address, IExecutionAdapter.SwapOrder[]));
            IVaultExecution(p.vault).executeRebalance(adapter, orders);
        }
        emit Executed(pid);
    }

    /// @notice Mark a passed-but-unexecuted proposal expired once its window lapses (EE-10).
    /// @param pid the passed proposal id past its execution window
    function markExpired(uint256 pid) external {
        Proposal storage p = proposals[pid];
        require(p.status == Status.Passed && block.timestamp > p.expiresAt, WrongPhase());
        p.status = Status.Expired;
        emit ProposalExpired(pid);
    }

    function _refreshStatus(uint256 pid) internal {
        Proposal storage p = proposals[pid];
        if (p.status == Status.Passed && block.timestamp > p.expiresAt) {
            p.status = Status.Expired;
            emit ProposalExpired(pid);
        }
    }

    function _isSettled(Status s) internal pure returns (bool) {
        return s == Status.Defeated || s == Status.Executed || s == Status.Expired;
    }

    // ───────────────────────── IGovernance (vault coupling) ───────────────────

    /// @inheritdoc IGovernance
    /// @dev True from REVEAL START of an active proposal (outcome starts leaking on-chain the
    /// moment reveals begin — an exit after that must be forward-priced, VO-8) until the
    /// proposal is executed, defeated, or its execution window lapses.
    function hasPendingExecution(address vault) external view returns (bool) {
        uint256 pid = activeProposalOf[vault];
        if (pid == 0) return false;
        Proposal storage p = proposals[pid];
        if (p.status == Status.Active) {
            return block.timestamp >= p.commitDeadline; // reveal phase or awaiting finalize
        }
        if (p.status == Status.Passed) {
            return block.timestamp <= p.expiresAt;
        }
        return false;
    }

    /// @inheritdoc IGovernance
    function isExecutor(address vault, address account) external view returns (bool) {
        return account == address(this) && vaultRegistered[vault];
    }
}
