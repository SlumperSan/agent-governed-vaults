#!/usr/bin/env node
// @ts-check
/**
 * DRILL 5 COMPANION — the deployer's half of the agent's governance round, on the smoke vault.
 *
 * The smoke vault has TWO members once the agent activates (deployer 4e18 + agent 1e18), so the
 * signer regime needs `revealedVoterCount * 2 > memberCount` → both must reveal. The agent side
 * runs through its own loop (drill5, vote phase — that is the thing under test); this script is
 * the other voter, plus the round mechanics nobody is testing: propose, finalize, execute, and
 * settling the agent's queued exit if its forced-trigger exit lands as Mode F during the reveal
 * window (settleQueuedExit is callable by anyone once execution completes — EE-10).
 *
 * The proposal MUST be created after the agent holds shares: voting weight snapshots at
 * `createdAt - 1`, so a proposal raised before activation would give the agent zero weight and
 * its reveal would be a no-op. Preflight enforces this.
 *
 * Env: SOAK_SIGNER_ARGS (deployer), BASE_SEPOLIA_RPC, SOAK_STATE_DIR, SOAK_RESET=1.
 * Run:  node scripts/soak/drill5-gov-companion.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ROOT, RPC, log, assert, call, callU, send, tryCall, waitUntilChainTime,
  openState, SIGNER_ARGS, cast, abiEncode, keccakOf, readProposal, pollUntil, TOPIC,
} from './lib.mjs';
import { loadDeployment } from './deployment.mjs';

const dep = loadDeployment(
  path.join(ROOT, 'contracts', 'config', 'deployments', 'base-sepolia.json'),
  { expectChainId: 84532 },
);
const soak = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'soak', 'soak-vaults.json'), 'utf8'));
const VAULT = soak.smokeVault.address;
const AGENT = '0x290caf006794a73bB1ba928a38c2A7f099015a6d';

const STATE_DIR = process.env.SOAK_STATE_DIR ?? path.join(ROOT, 'scripts', 'soak');
const STATE_PATH = path.join(STATE_DIR, '.state-drill5gov.json');
const { state, save, saveFirst } = openState(STATE_PATH, dep.factory);

log('DRILL 5 COMPANION — deployer half of the agent governance round (smoke vault)');
assert(SIGNER_ARGS.length > 0, 'SOAK_SIGNER_ARGS is required');
if (!state.signer) saveFirst('signer', cast(['wallet', 'address', ...SIGNER_ARGS], { interactive: true }).split('\n').pop().trim());

// ── preflight: the agent must already hold shares, and no other proposal may be live ──
const agentShares = callU(VAULT, 'sharesOf(address)(uint256)', AGENT);
assert(agentShares > 0n,
  `agent ${AGENT} holds no shares — run drill5-fasttrack.mjs first; a proposal raised now would snapshot the agent at zero weight`);
const deployerShares = callU(VAULT, 'sharesOf(address)(uint256)', state.signer);
assert(deployerShares > 0n, 'deployer holds no smoke-vault shares — cannot propose or vote');
log(`members ready: deployer ${deployerShares} shares, agent ${agentShares} shares`);

if (!state.pid) {
  const active = callU(dep.governance, 'activeProposalOf(address)(uint256)', VAULT);
  if (active !== 0n) {
    const p = readProposal(dep.governance, active.toString());
    assert(['Executed', 'Defeated', 'Expired'].includes(p.status),
      `smoke vault already has proposal ${active} in status ${p.status} — governance serializes per vault`);
  }
}

// ── propose the no-op rebalance (same shape Sprint 9 proved) ──
if (!state.steps.propose?.done) {
  const payload = saveFirst('payload',
    abiEncode('f(address,(address,address,uint256,uint256,uint256,bytes)[])', dep.adapter, '[]'));
  saveFirst('actionHash', keccakOf(payload));
  const r = send('governance.propose(no-op, agent vote host)', dep.governance,
    'propose(address,uint8,bytes32)', VAULT, 0, state.actionHash);
  const pid = pollUntil(() => callU(dep.governance, 'activeProposalOf(address)(uint256)', VAULT),
    (v) => v > 0n, { label: 'proposal id' });
  saveFirst('pid', pid.toString());
  const p = readProposal(dep.governance, state.pid);
  saveFirst('commitDeadline', p.commitDeadline);
  saveFirst('revealDeadline', p.revealDeadline);
  assert(p.snapshotTotal === deployerShares + agentShares,
    `snapshot ${p.snapshotTotal} != deployer+agent ${deployerShares + agentShares} — the agent may not be in the snapshot`);
  log(`proposal ${state.pid}: commit until ${p.commitDeadline}, reveal until ${p.revealDeadline}, snapshot ${p.snapshotTotal} across ${p.memberCount} member(s)`);
  state.steps.propose = { done: true, tx: r.transactionHash, pid: state.pid, snapshotTotal: p.snapshotTotal.toString(), memberCount: p.memberCount };
  save();
}

// ── deployer commit (salt persisted BEFORE the send — Sprint-9 §7.5) ──
if (!state.steps.commit?.done) {
  if (!state.salt) saveFirst('salt', '0x' + randomBytes(32).toString('hex'));
  const commitment = keccakOf(abiEncode('f(uint256,address,bool,bytes32)', state.pid, state.signer, 'true', state.salt));
  const r = send('governance.commitVote(deployer, FOR)', dep.governance, 'commitVote(uint256,bytes32)', state.pid, commitment);
  state.steps.commit = { done: true, tx: r.transactionHash };
  save();
}

// ── reveal after the commit phase closes ──
if (!state.steps.reveal?.done) {
  await waitUntilChainTime(state.commitDeadline, 'commit phase end (1h)');
  const r = send('governance.revealVote(deployer, FOR)', dep.governance,
    'revealVote(uint256,bool,bytes32)', state.pid, 'true', state.salt);
  state.steps.reveal = { done: true, tx: r.transactionHash };
  save();
}

// ── finalize + execute once the reveal phase closes ──
if (!state.steps.execute?.done) {
  await waitUntilChainTime(state.revealDeadline, 'reveal phase end (1h)');
  // Both voters must have revealed by now; read it rather than assume it.
  const p0 = readProposal(dep.governance, state.pid);
  log(`pre-finalize: revealedVoterCount ${p0.revealedVoterCount}, revealedWeight ${p0.revealedWeight} of ${p0.snapshotTotal}`);
  const rf = send('governance.finalize', dep.governance, 'finalize(uint256)', state.pid);
  const p1 = readProposal(dep.governance, state.pid);
  assert(p1.status === 'Passed',
    `finalized as ${p1.status} — with 2 members the signer regime needs BOTH reveals (agent side is drill5's vote phase; check its log)`);
  if (p1.executableAt) await waitUntilChainTime(p1.executableAt, 'timelock');
  const rx = send('governance.execute(no-op)', dep.governance, 'execute(uint256,bytes)', state.pid, state.payload);
  state.steps.execute = { done: true, finalizeTx: rf.transactionHash, executeTx: rx.transactionHash, status: 'Executed' };
  save();
}

// ── settle the agent's queued exit, if its forced trigger landed as Mode F during reveal ──
const queued = callU(VAULT, 'queuedExitShares(address)(uint256)', AGENT);
if (queued > 0n) {
  log(`agent has ${queued} shares queued (its exit fired during the pending-execution window → Mode F). Settling — callable by anyone once execution completes (EE-10).`);
  const r = send('vault.settleQueuedExit(agent)', VAULT, 'settleQueuedExit(address)', AGENT);
  const after = callU(VAULT, 'sharesOf(address)(uint256)', AGENT);
  assert(after === 0n, `agent still holds ${after} shares after settlement`);
  state.steps.settleAgentQueued = { done: true, tx: r.transactionHash, settledShares: queued.toString(), agentModeF: true };
  save();
} else {
  log('no queued exit for the agent (either it exited Mode I after execution, or has not exited yet)');
}

log('COMPANION COMPLETE');
log(`  proposal ${state.pid} Executed; state file ${STATE_PATH}`);
