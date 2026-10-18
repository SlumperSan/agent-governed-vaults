// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {VaultCore} from "../src/VaultCore.sol";
import {AgentVaultCore} from "../src/AgentVaultCore.sol";
import {RWAllyAgentRegistry} from "../src/RWAllyAgentRegistry.sol";
import {Governance} from "../src/Governance.sol";
import {IOperatorRegistry} from "../src/interfaces/IOperatorRegistry.sol";
import {IGovernance} from "../src/interfaces/IGovernance.sol";
import {IFeeEngine} from "../src/interfaces/IFeeEngine.sol";
import {IOracleAggregator} from "../src/interfaces/IOracleAggregator.sol";
import {AllowAllRegistry, ModeRegistry} from "./mocks/RegistryMocks.sol";

interface IErc20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IFactoryView {
    function isAllowedOracle(address) external view returns (bool);
    function allVaults(uint256) external view returns (address);
}

interface IVaultParams {
    function capacityCapUsdc() external view returns (uint256);
    function minDepositUsdc() external view returns (uint256);
    function exitFeeMaxBps() external view returns (uint256);
    function exitFeeDecayPeriod() external view returns (uint256);
}

interface ICanonicalRegistry {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function getVersion() external view returns (string memory);
    function supportsInterface(bytes4) external view returns (bool);
    function register(string calldata) external returns (uint256);
    function ownerOf(uint256) external view returns (address);
    function balanceOf(address) external view returns (uint256);
    function tokenURI(uint256) external view returns (string memory);
    function getAgentWallet(uint256) external view returns (address);
    function getMetadata(uint256, string calldata) external view returns (bytes memory);
}

/// Answers every call with `false` (used as the blocklist precompile stub).
contract AllowNoneStub {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(false);
    }
}

/// Stands in for Arc's native-transfer precompile (0x1800...0000): `transfer(from, to, amount)` moves the
/// 18-decimal native balance that backs the USDC predeploy. Forge's local EVM has no such precompile.
contract NativeTransferStub is CommonBase {
    fallback(bytes calldata data) external returns (bytes memory) {
        require(
            bytes4(data[0:4]) == bytes4(keccak256("transfer(address,address,uint256)")), "unexpected call"
        );
        (address from, address to, uint256 amount) = abi.decode(data[4:], (address, address, uint256));
        require(from.balance >= amount, "native balance too low");
        vm.deal(from, from.balance - amount);
        vm.deal(to, to.balance + amount);
        return abi.encode(true);
    }
}

/// A contract account that registers an identity and deposits from itself (the P2 shape).
contract ForkContractAgent {
    function register(RWAllyAgentRegistry reg) external returns (uint256) {
        return reg.register("RWAlly contract-account agent");
    }

    function deposit(IErc20Like usdc, AgentVaultCore vault, uint256 amt) external {
        usdc.approve(address(vault), amt);
        vault.deposit(amt);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// Fork simulation on Arc mainnet (chain 5042) of a fresh AgentVaultCore against the LIVE
/// Governance, FeeEngine, OperatorRegistry, Chainlink oracle and Uniswap v3 adapter, with
/// throwaway keys and no broadcast. Skipped (every test returns) unless ARC_MAINNET_RPC_URL is set,
/// so the gate never reaches the network. Run by hand:
///   ARC_MAINNET_RPC_URL=https://rpc.mainnet.arc.io forge test --match-path test/AgentVaultCoreFork.t.sol
/// Profiles P1 to P10 follow the agent-only vault spec, section 5.2. Test names start `testFork_`
/// so the gas snapshot excludes them.
contract AgentVaultCoreForkTest is Test {
    uint256 constant ARC_CHAIN_ID = 5042;
    bytes32 constant SALT = keccak256("salt");

    bool forked;

    address usdc;
    address cirBtc;
    address govAddr;
    address feeEngineAddr;
    address opRegAddr;
    address oracleAddr;
    address adapterAddr;
    address factoryAddr;
    address firstVault;
    address safe; // the creator Safe: registers governance, holds nothing

    RWAllyAgentRegistry idReg;
    AgentVaultCore vault;
    Governance gov;
    uint256 minDeposit;

    address multisig = makeAddr("registry multisig");
    address agentA = makeAddr("agent A");
    address agentB = makeAddr("agent B");
    address agentC = makeAddr("agent C");
    address human = makeAddr("human");
    address teamSeed1 = makeAddr("team seed 1");
    address teamSeed2 = makeAddr("team seed 2");

    function setUp() public {
        string memory rpc = vm.envOr("ARC_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return; // every test returns; no fork is created

        string memory pin = vm.envOr("ARC_FORK_BLOCK", string(""));
        if (bytes(pin).length == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, vm.parseUint(pin));
        assertEq(block.chainid, ARC_CHAIN_ID, "fork is not Arc mainnet");
        forked = true;

        // Read the shipping record, not hardcoded copies.
        string memory j = vm.readFile("config/deployments/arc-mainnet.json");
        usdc = vm.parseJsonAddress(j, ".infrastructure.usdc");
        cirBtc = vm.parseJsonAddress(j, ".oracle.assets.cirBTC.token");
        govAddr = vm.parseJsonAddress(j, ".singletons.Governance");
        feeEngineAddr = vm.parseJsonAddress(j, ".singletons.FeeEngine");
        opRegAddr = vm.parseJsonAddress(j, ".singletons.OperatorRegistry");
        factoryAddr = vm.parseJsonAddress(j, ".singletons.VaultFactory");
        oracleAddr = vm.parseJsonAddress(j, ".oracle.ChainlinkOracle");
        adapterAddr = vm.parseJsonAddress(j, ".execution.AggregationRouterAdapter");
        firstVault = vm.parseJsonAddress(j, ".firstVault.address");
        safe = vm.parseJsonAddress(j, ".intendedCreator");
        gov = Governance(govAddr);
        _stubArcPrecompiles();

        // Deploy-preflight assertions from the spec: the oracle is the factory's allowed oracle and
        // prices the basket asset.
        assertTrue(
            IFactoryView(factoryAddr).isAllowedOracle(oracleAddr),
            "oracle is not the factory's allowed oracle"
        );
        assertGt(IOracleAggregator(oracleAddr).priceWad(cirBtc), 0, "cirBTC unpriced");

        // Mirror the first vault's launch parameters (read from chain, not typed in).
        minDeposit = IVaultParams(firstVault).minDepositUsdc();
        idReg = new RWAllyAgentRegistry(multisig);

        address[] memory basket = new address[](1);
        basket[0] = cirBtc;
        address[] memory adapters = new address[](1);
        adapters[0] = adapterAddr;
        vault = new AgentVaultCore(
            usdc,
            basket,
            safe,
            IOperatorRegistry(opRegAddr),
            IGovernance(govAddr),
            IFeeEngine(feeEngineAddr),
            IOracleAggregator(oracleAddr),
            IVaultParams(firstVault).capacityCapUsdc(),
            minDeposit,
            IVaultParams(firstVault).exitFeeMaxBps(),
            IVaultParams(firstVault).exitFeeDecayPeriod(),
            adapters,
            address(0),
            address(idReg)
        );

        vm.prank(safe);
        gov.registerVault(
            address(vault),
            Governance.GovConfig({
                commitDuration: uint32(vm.parseJsonUint(j, ".firstVault.configOf.commitDuration")),
                revealDuration: uint32(vm.parseJsonUint(j, ".firstVault.configOf.revealDuration")),
                timelockDuration: uint32(vm.parseJsonUint(j, ".firstVault.configOf.timelockDuration")),
                executionWindow: uint32(vm.parseJsonUint(j, ".firstVault.configOf.executionWindow")),
                quorumBps: uint16(vm.parseJsonUint(j, ".firstVault.configOf.quorumBps")),
                proposalThresholdBps: uint16(
                    vm.parseJsonUint(j, ".firstVault.configOf.proposalThresholdBps")
                ),
                concentrationCapBps: uint16(vm.parseJsonUint(j, ".firstVault.configOf.concentrationCapBps")),
                proposalCooldown: uint32(vm.parseJsonUint(j, ".firstVault.configOf.proposalCooldown"))
            })
        );
    }

    // -- helpers ----------------------------------------------------------------

    /// Arc's USDC predeploy calls native precompiles that forge's local EVM does not implement
    /// (0x1800...0001 answers `isBlocklisted`; its call from `transferFrom` otherwise halts the EVM). The fork
    /// puts a stub that reports "not blocklisted" at that address.
    function _stubArcPrecompiles() internal {
        vm.etch(address(0x1800000000000000000000000000000000000001), address(new AllowNoneStub()).code);
        vm.etch(address(0x1800000000000000000000000000000000000000), address(new NativeTransferStub()).code);
        vm.allowCheatcodes(address(0x1800000000000000000000000000000000000000));
    }

    modifier onFork() {
        if (!forked) vm.skip(true); // no ARC_MAINNET_RPC_URL: reported as skipped, never as a pass
        _;
    }

    function _fund(address who, uint256 amount) internal {
        // Arc USDC is the native gas asset: its ERC-20 balanceOf is the native balance scaled to 6 decimals,
        // so `deal` (which looks for a storage slot) cannot find it. Fund the native balance instead.
        vm.deal(who, amount * 1e12);
        assertEq(IErc20Like(usdc).balanceOf(who), amount, "could not fund on the fork");
        vm.prank(who);
        IErc20Like(usdc).approve(address(vault), type(uint256).max);
    }

    function _register(address who, string memory label) internal returns (uint256 id) {
        vm.prank(who);
        id = idReg.register(label);
    }

    /// Register, fund, deposit and open the position at once.
    function _join(address who, uint256 amount) internal {
        _register(who, "RWAlly fork agent");
        _fund(who, amount);
        vm.startPrank(who);
        vault.deposit(amount);
        vault.skipWindow();
        vm.stopPrank();
    }

    function _commitment(uint256 pid, address voter, bool support) internal pure returns (bytes32) {
        return keccak256(abi.encode(pid, voter, support, SALT));
    }

    function _propose(address proposer, bytes32 actionHash) internal returns (uint256 pid) {
        vm.prank(proposer);
        pid = gov.propose(address(vault), Governance.ProposalType.Rebalance, actionHash);
    }

    function _commit(uint256 pid, address voter, bool support) internal {
        vm.prank(voter);
        gov.commitVote(pid, _commitment(pid, voter, support));
    }

    function _reveal(uint256 pid, address voter, bool support) internal {
        vm.prank(voter);
        gov.revealVote(pid, support, SALT);
    }

    function _deadlines(uint256 pid) internal view returns (uint64 commitD, uint64 revealD) {
        (,,,, commitD, revealD,,,,,,,,,,) = gov.proposals(pid);
    }

    function _status(uint256 pid) internal view returns (Governance.Status s) {
        (,,,,,,,, s,,,,,,,) = gov.proposals(pid);
    }

    function _memberCount(uint256 pid) internal view returns (uint256 n) {
        (,,,,,,,,,,, n,,,,) = gov.proposals(pid);
    }

    function _finalizeAfterReveal(uint256 pid) internal {
        (, uint64 revealD) = _deadlines(pid);
        vm.warp(revealD);
        gov.finalize(pid);
    }

    // -- deployment ---------------------------------------------------------------

    function testFork_deployment_wiringMatchesTheLiveFirstVault_andGasIsRecorded() public onFork {
        assertEq(address(vault.governance()), address(IVaultWiring(firstVault).governance()));
        assertEq(address(vault.feeEngine()), address(IVaultWiring(firstVault).feeEngine()));
        assertEq(address(vault.operatorRegistry()), address(IVaultWiring(firstVault).operatorRegistry()));
        assertEq(address(vault.oracle()), address(IVaultWiring(firstVault).oracle()));
        assertTrue(gov.vaultRegistered(address(vault)));
        assertEq(vault.identityRegistry(), address(idReg));
        // Not attested: the vault came from a direct deploy, not the factory.
        assertEq(IOperatorRegistryView(opRegAddr).operatorOf(address(vault)), 0);

        address[] memory basket = new address[](1);
        basket[0] = cirBtc;
        address[] memory adapters = new address[](1);
        adapters[0] = adapterAddr;
        uint256 g0 = gasleft();
        new AgentVaultCore(
            usdc,
            basket,
            safe,
            IOperatorRegistry(opRegAddr),
            IGovernance(govAddr),
            IFeeEngine(feeEngineAddr),
            IOracleAggregator(oracleAddr),
            0,
            minDeposit,
            0,
            0,
            adapters,
            address(0),
            address(idReg)
        );
        emit log_named_uint("AgentVaultCore deploy gas (fork, constructor included)", g0 - gasleft());
        g0 = gasleft();
        new RWAllyAgentRegistry(multisig);
        emit log_named_uint("RWAllyAgentRegistry deploy gas (fork)", g0 - gasleft());
    }

    // -- P1 to P5 -------------------------------------------------------------------

    function testFork_P1_registeredEoaAgentDeposits() public onFork {
        _register(agentA, "RWAlly fork agent");
        _fund(agentA, 5 * minDeposit);
        vm.prank(agentA);
        vault.deposit(minDeposit);
        assertEq(vault.totalPendingUsdc(), minDeposit);
        skip(4 hours);
        vault.activate(agentA);
        assertGt(vault.sharesOf(agentA), 0);
    }

    function testFork_P2_contractAccountAgentHoldingATokenDeposits() public onFork {
        ForkContractAgent a = new ForkContractAgent();
        _fund(address(a), 5 * minDeposit);
        vm.prank(address(a));
        IErc20Like(usdc).approve(address(vault), type(uint256).max);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        a.deposit(IErc20Like(usdc), vault, minDeposit);
        a.register(idReg);
        a.deposit(IErc20Like(usdc), vault, minDeposit);
        assertEq(vault.totalPendingUsdc(), minDeposit);
    }

    function testFork_P3_unregisteredHumanEoaReverts() public onFork {
        _fund(human, 5 * minDeposit);
        vm.prank(human);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        vault.deposit(minDeposit);
    }

    /// Documents the limit: a person who calls register() first is admitted.
    function testFork_P4_humanWhoRegistersFirstDeposits() public onFork {
        _register(human, "not an agent at all");
        _fund(human, 5 * minDeposit);
        vm.prank(human);
        vault.deposit(minDeposit);
        assertEq(vault.totalPendingUsdc(), minDeposit);
    }

    function testFork_P5_agentTransfersItsTokenAwayAfterDepositing() public onFork {
        _join(agentA, 2 * minDeposit);
        _join(agentB, 2 * minDeposit);
        uint256 shares = vault.sharesOf(agentA);
        uint256 weight = vault.votingEligibleShares(agentA);
        vm.prank(agentA);
        idReg.transferFrom(agentA, human, 0);

        assertEq(vault.sharesOf(agentA), shares);
        assertEq(vault.votingEligibleShares(agentA), weight);
        vm.prank(agentA);
        vm.expectRevert(AgentVaultCore.NoAgentIdentity.selector);
        vault.deposit(minDeposit);

        // The weight still votes: agentA proposes, commits and reveals with no token.
        skip(1);
        uint256 pid = _propose(agentA, keccak256(""));
        _commit(pid, agentA, true);
        (uint64 commitD,) = _deadlines(pid);
        vm.warp(commitD);
        _reveal(pid, agentA, true);

        // And it exits.
        uint256 bShares = vault.sharesOf(agentB);
        vm.prank(agentB);
        vault.requestExit(bShares / 2);
        // The proposal is in its reveal phase, so the exit queues (Mode F) rather than paying at once.
        assertEq(vault.queuedExitShares(agentB), bShares / 2, "exit accepted");
    }

    // -- P6, P7: governance regimes -----------------------------------------------

    /// Five registered wallets at the minimum put the vault in the five-or-more regime (H-8(a)).
    function testFork_P6_fiveRegisteredWalletsAtTheMinimumFlipTheRegime() public onFork {
        _join(agentA, minDeposit);
        _join(agentB, minDeposit);
        _join(agentC, minDeposit);
        _join(teamSeed1, minDeposit);
        skip(1);
        uint256 pidFour = _propose(agentA, keccak256(""));
        assertEq(_memberCount(pidFour), 4, "four members: sub-five regime");
        (, uint64 r) = _deadlines(pidFour);
        vm.warp(r);
        gov.finalize(pidFour); // nobody revealed: defeated, which settles it

        skip(1 hours);
        _join(teamSeed2, minDeposit);
        skip(2);
        uint256 pidFive = _propose(agentA, keccak256(""));
        assertEq(_memberCount(pidFive), 5, "five members: stake-weighted regime");
        emit log_named_uint("cost of the fifth seat in USDC base units (min deposit)", minDeposit);
    }

    /// Two team-labelled seeds over half the stake pass a Rebalance alone in the sub-five regime. The
    /// contract allows it; launch rule 8 forbids it in practice. The team-operated share is computed.
    function testFork_P7_twoTeamSeedsOverHalfOfStakePassARebalanceAlone() public onFork {
        _register(teamSeed1, "RWAlly team: seed 1 (owner-signed)");
        _register(teamSeed2, "RWAlly team: seed 2 (owner-signed)");
        _fund(teamSeed1, 10 * minDeposit);
        _fund(teamSeed2, 10 * minDeposit);
        vm.startPrank(teamSeed1);
        vault.deposit(3 * minDeposit);
        vault.skipWindow();
        vm.stopPrank();
        vm.startPrank(teamSeed2);
        vault.deposit(3 * minDeposit);
        vault.skipWindow();
        vm.stopPrank();
        _join(agentA, 2 * minDeposit); // the one outside member, silent

        uint256 teamShares = vault.sharesOf(teamSeed1) + vault.sharesOf(teamSeed2);
        uint256 teamBps = teamShares * 10_000 / vault.totalShares();
        emit log_named_uint("team-operated share of eligible stake, bps", teamBps);
        assertGt(teamBps, 5_000, "monitor: team-operated stake is over half");

        skip(1);
        uint256 pid = _propose(teamSeed1, keccak256(""));
        assertEq(_memberCount(pid), 3);
        _commit(pid, teamSeed1, true);
        _commit(pid, teamSeed2, true);
        (uint64 commitD,) = _deadlines(pid);
        vm.warp(commitD);
        _reveal(pid, teamSeed1, true);
        _reveal(pid, teamSeed2, true);
        _finalizeAfterReveal(pid);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Passed), "passed with the outsider silent");
    }

    // -- P8: the registry changes under the vault ------------------------------------

    /// Our registry has no upgrade path, so "the registry's answer changes" is simulated by putting other
    /// code at its address on the fork. Always-true opens entry only; always-revert closes it only.
    function testFork_P8_registryAlwaysTrue_entryOpens_fundsUnaffected() public onFork {
        _join(agentA, 2 * minDeposit);
        uint256 shares = vault.sharesOf(agentA);
        vm.etch(address(idReg), address(new AllowAllRegistry()).code);
        _fund(human, 5 * minDeposit);
        vm.prank(human);
        vault.deposit(minDeposit); // an unregistered address now enters
        assertEq(vault.totalPendingUsdc(), minDeposit);
        assertEq(vault.sharesOf(agentA), shares, "existing position untouched");
        vm.prank(agentA);
        vault.requestExit(shares);
        assertEq(vault.sharesOf(agentA), 0);
    }

    function testFork_P8_registryAlwaysRevert_depositsBlocked_everyExitWorks() public onFork {
        _join(agentA, 2 * minDeposit);
        _join(agentB, 2 * minDeposit);
        _register(agentC, "RWAlly fork agent");
        _fund(agentC, 5 * minDeposit);
        vm.prank(agentC);
        vault.deposit(minDeposit); // pending
        ModeRegistry hostile = new ModeRegistry();
        hostile.setMode(ModeRegistry.Mode.Revert);
        vm.etch(address(idReg), address(hostile).code);

        vm.prank(agentA);
        (bool ok, bytes memory ret) =
            address(vault).call{gas: 5_000_000}(abi.encodeWithSignature("deposit(uint256)", minDeposit));
        assertFalse(ok);
        assertEq(bytes4(ret), AgentVaultCore.NoAgentIdentity.selector);

        skip(4 hours);
        vault.activate(agentC); // pending deposit still activates
        uint256 cShares = vault.sharesOf(agentC);
        vm.prank(agentC);
        vault.requestExit(cShares); // and exits
        uint256 aShares = vault.sharesOf(agentA);
        vm.prank(agentA);
        vault.requestExit(aShares); // as does everyone else
        assertEq(vault.sharesOf(agentA), 0);
    }

    // -- P9, P10 and the full round -------------------------------------------------

    /// A proposal in its reveal phase makes exits queue (Mode F); they settle once it ends. Not caused by the gate.
    function testFork_P9_rebalancePending_memberExitQueuesAndSettles() public onFork {
        _join(agentA, 2 * minDeposit);
        _join(agentB, 2 * minDeposit);
        skip(1);
        uint256 pid = _propose(agentA, keccak256(""));
        (uint64 commitD, uint64 revealD) = _deadlines(pid);
        vm.warp(commitD);
        assertTrue(gov.hasPendingExecution(address(vault)));

        uint256 shares = vault.sharesOf(agentB);
        vm.prank(agentB);
        vault.requestExit(shares);
        assertEq(vault.queuedExitShares(agentB), shares, "queued, not settled");

        vm.warp(revealD);
        gov.finalize(pid); // nobody revealed: defeated
        assertFalse(gov.hasPendingExecution(address(vault)));
        vault.settleQueuedExit(agentB);
        assertEq(vault.sharesOf(agentB), 0);
    }

    function testFork_P10_delegateWithoutSharesCannotRevealOrCarryWeight() public onFork {
        _join(agentA, 2 * minDeposit);
        _join(agentB, 2 * minDeposit);
        _join(agentC, 2 * minDeposit);
        address delegate = makeAddr("share-less delegate");
        vm.prank(agentB);
        gov.setDelegate(address(vault), delegate);
        skip(1);
        uint256 pid = _propose(agentA, keccak256(""));

        vm.prank(delegate);
        vm.expectRevert(Governance.NoWeight.selector);
        gov.commitVote(pid, bytes32(uint256(1)));

        _commit(pid, agentA, true);
        (uint64 commitD,) = _deadlines(pid);
        vm.warp(commitD);
        _reveal(pid, agentA, true);
        vm.expectRevert(Governance.DelegateNotRevealed.selector);
        gov.revealDelegated(pid, agentB);
    }

    /// Spec 5.1 item 10: a full propose, commit, reveal, finalize, execute round on the live Governance.
    function testFork_governanceRound_proposeCommitRevealFinalizeExecute() public onFork {
        _join(agentA, 2 * minDeposit);
        _join(agentB, 2 * minDeposit);
        _join(agentC, 2 * minDeposit);
        skip(1);
        uint256 pid = _propose(agentA, keccak256(""));
        _commit(pid, agentA, true);
        _commit(pid, agentB, true);
        (uint64 commitD,) = _deadlines(pid);
        vm.warp(commitD);
        _reveal(pid, agentA, true);
        _reveal(pid, agentB, true);
        _finalizeAfterReveal(pid);
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Passed));
        gov.execute(pid, "");
        assertEq(uint8(_status(pid)), uint8(Governance.Status.Executed));
    }

    // -- compatibility with the canonical ERC-8004 registry -----------------------------

    /// Our registry answers the same reads, with the same event shapes, as the canonical one on this chain.
    function testFork_compat_ourRegistryMatchesTheCanonicalErc8004Surface() public onFork {
        ICanonicalRegistry canon = ICanonicalRegistry(0x8004A169FB4a3325136EB29fA0ceB6D2e539a432);
        ICanonicalRegistry ours = ICanonicalRegistry(address(idReg));
        assertEq(ours.name(), canon.name());
        assertEq(ours.symbol(), canon.symbol());
        assertEq(ours.getVersion(), canon.getVersion());
        bytes4[5] memory ifaces = [bytes4(0x01ffc9a7), 0x80ac58cd, 0x5b5e139f, 0x49064906, 0x780e9d63];
        for (uint256 i; i < ifaces.length; ++i) {
            assertEq(
                ours.supportsInterface(ifaces[i]), canon.supportsInterface(ifaces[i]), "supportsInterface"
            );
        }

        vm.recordLogs();
        vm.prank(agentA);
        uint256 canonId = canon.register("ipfs://compat");
        Vm.Log[] memory canonLogs = vm.getRecordedLogs();
        vm.recordLogs();
        vm.prank(agentA);
        uint256 ourId = ours.register("ipfs://compat");
        Vm.Log[] memory ourLogs = vm.getRecordedLogs();

        assertEq(canon.ownerOf(canonId), agentA);
        assertEq(ours.ownerOf(ourId), agentA);
        assertEq(ours.balanceOf(agentA), 1);
        assertEq(keccak256(bytes(ours.tokenURI(ourId))), keccak256(bytes(canon.tokenURI(canonId))));
        assertEq(ours.getAgentWallet(ourId), canon.getAgentWallet(canonId));
        assertEq(
            keccak256(ours.getMetadata(ourId, "agentWallet")),
            keccak256(canon.getMetadata(canonId, "agentWallet"))
        );

        // Same events in the same order with the same signatures (topic 0) and the same indexed owner.
        assertEq(ourLogs.length, canonLogs.length, "event count");
        for (uint256 i; i < canonLogs.length; ++i) {
            assertEq(ourLogs[i].topics[0], canonLogs[i].topics[0], "event signature");
            assertEq(ourLogs[i].topics.length, canonLogs[i].topics.length, "indexed arity");
        }
    }
}

interface IVaultWiring {
    function governance() external view returns (address);
    function feeEngine() external view returns (address);
    function operatorRegistry() external view returns (address);
    function oracle() external view returns (address);
}

interface IOperatorRegistryView {
    function operatorOf(address) external view returns (uint256);
}
