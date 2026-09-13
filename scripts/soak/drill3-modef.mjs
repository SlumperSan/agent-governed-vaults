#!/usr/bin/env node
// @ts-check
/**
 * DRILL 3 — MODE-F EXIT. The K-1 seam, live: an exit requested while a rebalance is pending
 * must NOT settle at the pre-execution price. It queues, and settles afterwards.
 *
 * ## Why this drill exists
 *
 * `requestExit` has two modes (VaultCore C-4). With nothing pending it settles immediately at
 * current NAV (Mode I — that is what Sprint 9 exercised). With a rebalance pending it queues
 * the shares and settles later (Mode F). Mode F is the branch that closes K-1: a member who
 * can see a rebalance coming must not be able to redeem at the stale price ahead of it.
 *
 * Sprint 9 only ever ran Mode I. This is the first live Mode-F settlement.
 *
 * ## The window is the reveal phase — verified, not assumed
 *
 * `Governance.hasPendingExecution` (Governance.sol:515) is true when either
 *
 *   - status == Active AND block.timestamp >= commitDeadline   ← the reveal phase
 *   - status == Passed AND block.timestamp <= expiresAt        ← awaiting execution
 *
 * so the Mode-F window OPENS at `commitDeadline`, not at finalize. During the commit phase
 * an exit still settles Mode I. The drill therefore asserts the mode boundary in both
 * directions rather than trusting the timing: it proves Mode I is what you get before the
 * deadline is reached, then queues after it.
 *
 * ## Ordering that matters
 *
 * Reveal BEFORE requesting the exit. `requestExit` calls `_snapshot(member)`, and queued
 * shares leave eligible stake immediately — exiting first would forfeit the vote and the
 * proposal would fail quorum, collapsing the drill into a different scenario.
 *
 * ## Honest limit of the NAV claim
 *
 * The rebalance is a no-op (allow-listed adapter, zero orders), the same shape Sprint 9 used.
 * That keeps the drill from needing a real swap and real slippage on testnet, but it means
 * pre- and post-execution NAV are EQUAL, so "settles at post-execution NAV" is proven
 * STRUCTURALLY (the exit queued instead of settling; settlement was impossible until the
 * rebalance executed) and NOT NUMERICALLY (no price delta separates the two). The drill
 * records both NAV readings so the report can state this plainly rather than implying a
 * price move that never happened.
 *
 * Host is vault B, created by drill 1 — run that first.
 *
 * Env: SOAK_SIGNER_ARGS (required), SOAK_RPC (or BASE_SEPOLIA_RPC), SOAK_DEPLOYMENT,
 *      SOAK_STATE_DIR, SOAK_RESET=1.
 * Run:  node scripts/soak/drill3-modef.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ROOT, RPC, log, assert, eq, call, callU, send, tryCall, chainNow, waitUntilChainTime,
  openState, runSteps, TOPIC, SIGNER_ARGS, cast, abiEncode, keccakOf, readProposal,
} from './lib.mjs';
import { assertLiveChainId, deploymentPath, loadDeployment } from './deployment.mjs';

const dep = loadDeployment(deploymentPath(ROOT));

const STATE_DIR = process.env.SOAK_STATE_DIR ?? path.join(ROOT, 'scripts', 'soak');
const STATE_PATH = path.join(STATE_DIR, '.state-drill3.json');
const DRILL1_STATE = path.join(STATE_DIR, '.state-drill1.json');

const { state, save, saveFirst } = openState(STATE_PATH, dep.factory);

/** Vault B comes from drill 1's state file — this drill does not create vaults. */
function resolveHost() {
  if (state.vault) return state.vault;
  assert(fs.existsSync(DRILL1_STATE),
    `drill 1 state not found at ${DRILL1_STATE} — run drill1-multivault.mjs first (it creates and activates the Mode-F host)`);
  const d1 = JSON.parse(fs.readFileSync(DRILL1_STATE, 'utf8'));
  assert(d1.vaultB, 'drill 1 state has no vaultB — drill 1 did not complete');
  assert(eq(d1.factory, dep.factory),
    `drill 1 ran against factory ${d1.factory}, this deployment is ${dep.factory}`);
  return saveFirst('vault', d1.vaultB);
}

// ────────────────────────────────── phases ──────────────────────────────────

function preflight() {
  log(`rpc=${RPC}  governance=${dep.governance}`);
  assertLiveChainId(dep, Number(cast(['chain-id', '--rpc-url', RPC])));

  const vault = resolveHost();
  log(`Mode-F host: vault B ${vault}`);

  if (!state.signer) {
    assert(SIGNER_ARGS.length > 0, 'SOAK_SIGNER_ARGS is required; this script never handles the key itself');
    saveFirst('signer', cast(['wallet', 'address', ...SIGNER_ARGS], { interactive: true }).split('\n').pop().trim());
  }

  // The host must be live and the signer must actually hold shares, or "the exit queued"
  // proves nothing.
  const shares = callU(vault, 'sharesOf(address)(uint256)', state.signer);
  assert(shares > 0n,
    `signer holds no shares in ${vault} — drill 1 must have completed its activate step`);
  const queued = callU(vault, 'queuedExitShares(address)(uint256)', state.signer);
  assert(queued === 0n || state.steps.requestExit?.done,
    `signer already has ${queued} shares queued for exit — resolve that before running this drill`);

  assert(call(dep.governance, 'vaultRegistered(address)(bool)', vault)[0] === 'true',
    'vault B is not registered with governance');

  // No other proposal may be in flight, or `propose` reverts ProposalActive().
  const activePid = callU(dep.governance, 'activeProposalOf(address)(uint256)', vault);
  if (activePid !== 0n && !state.pid) {
    const p = readProposal(dep.governance, activePid.toString());
    assert(['Executed', 'Defeated', 'Expired'].includes(p.status),
      `vault B already has proposal ${activePid} in status ${p.status} — settle it before running this drill`);
  }

  saveFirst('sharesAtStart', shares.toString());
  log(`preflight OK — signer ${state.signer} holds ${shares} shares`);
}

function buildPayload() {
  // Same no-op shape Sprint 9 proved: allow-listed adapter, zero orders. Voters approve
  // exactly these bytes; actionHash pins them.
  const payload = saveFirst('payload',
    abiEncode('f(address,(address,address,uint256,uint256,uint256,bytes)[])', dep.adapter, '[]'));
  saveFirst('actionHash', keccakOf(payload));
}

function stepPropose() {
  buildPayload();
  const r = send('governance.propose(Rebalance on vault B)', dep.governance,
    'propose(address,uint8,bytes32)', state.vault, 0, state.actionHash);
  const pid = callU(dep.governance, 'activeProposalOf(address)(uint256)', state.vault);
  assert(pid > 0n, 'no active proposal after propose');
  saveFirst('pid', pid.toString());
  const p = readProposal(dep.governance, state.pid);
  saveFirst('commitDeadline', p.commitDeadline);
  saveFirst('revealDeadline', p.revealDeadline);
  log(`proposal ${state.pid}: commit until ${p.commitDeadline}, reveal until ${p.revealDeadline}`);
  state.steps.propose = { done: true, tx: r.transactionHash, pid: state.pid, status: p.status };
  save();
}

/**
 * The negative half of the mode boundary. Before `commitDeadline`, hasPendingExecution is
 * false and an exit would settle Mode I. Proven by READING the flag, not by exiting — an
 * actual Mode-I exit here would burn the shares the drill needs.
 */
function stepProveModeIWindow() {
  const now = chainNow();
  assert(now < state.commitDeadline,
    `already past commitDeadline (${now} >= ${state.commitDeadline}) — cannot observe the Mode-I window; use SOAK_RESET=1 to restart the drill`);
  const pending = call(dep.governance, 'hasPendingExecution(address)(bool)', state.vault)[0];
  assert(pending === 'false',
    `hasPendingExecution is ${pending} during the COMMIT phase — expected false (Mode I). Governance.sol:519 says the reveal phase is what opens Mode F.`);
  log(`mode boundary (before): chain ${now} < commitDeadline ${state.commitDeadline}, hasPendingExecution=false → an exit here would be Mode I`);
  state.steps.proveModeIWindow = { done: true, chainTime: now, commitDeadline: state.commitDeadline, hasPendingExecution: false };
  save();
}

function stepCommit() {
  // Persist the salt BEFORE the commit lands — Sprint-9 §7.5, a lost salt is an
  // unrevealable commit and a forfeited vote.
  if (!state.salt) saveFirst('salt', '0x' + randomBytes(32).toString('hex'));
  const commitment = keccakOf(abiEncode('f(uint256,address,bool,bytes32)', state.pid, state.signer, 'true', state.salt));
  const r = send('governance.commitVote(FOR)', dep.governance, 'commitVote(uint256,bytes32)', state.pid, commitment);
  state.steps.commit = { done: true, tx: r.transactionHash };
  save();
}

async function stepReveal() {
  await waitUntilChainTime(state.commitDeadline, 'commit phase end (1h)');
  // Reveal BEFORE exiting: queued shares leave eligible stake immediately, so exiting first
  // would forfeit this vote and the proposal would fail quorum.
  const r = send('governance.revealVote(FOR)', dep.governance,
    'revealVote(uint256,bool,bytes32)', state.pid, 'true', state.salt);
  const p = readProposal(dep.governance, state.pid);
  assert(p.revealedVoterCount >= 1, `reveal did not register (revealedVoterCount ${p.revealedVoterCount})`);
  log(`revealed FOR — revealedWeight ${p.revealedWeight}, voters ${p.revealedVoterCount}`);
  state.steps.reveal = { done: true, tx: r.transactionHash, revealedVoterCount: p.revealedVoterCount };
  save();
}

/**
 * THE DRILL. Request the exit inside the reveal phase and prove it QUEUED rather than settled.
 */
function stepRequestExitModeF() {
  const now = chainNow();
  assert(now >= state.commitDeadline && now < state.revealDeadline,
    `not inside the reveal phase (chain ${now}, window ${state.commitDeadline}..${state.revealDeadline}) — the Mode-F window was missed; SOAK_RESET=1 and rerun`);

  const pending = call(dep.governance, 'hasPendingExecution(address)(bool)', state.vault)[0];
  assert(pending === 'true',
    `hasPendingExecution is ${pending} during the REVEAL phase — Mode F would not trigger`);

  const navBefore = callU(state.vault, 'navWad()(uint256)');
  const npsBefore = callU(state.vault, 'navPerShareWad()(uint256)');
  const usdcBefore = callU(dep.usdc, 'balanceOf(address)(uint256)', state.signer);
  saveFirst('navBeforeExecution', navBefore.toString());
  saveFirst('npsBeforeExecution', npsBefore.toString());
  saveFirst('usdcBeforeExit', usdcBefore.toString());

  const exitShares = state.sharesAtStart;
  const r = send(`vaultB.requestExit(${exitShares}) during reveal`, state.vault, 'requestExit(uint256)', exitShares);

  // The whole point: ExitQueued, NOT ExitSettled.
  const queuedLog = r.logs.find((l) => l.topics?.[0] === TOPIC.ExitQueued());
  const settledLog = r.logs.find((l) => l.topics?.[0] === TOPIC.ExitSettled());
  assert(queuedLog, 'no ExitQueued event — the exit did not take the Mode-F branch');
  assert(!settledLog,
    'ExitSettled was emitted during a pending rebalance — this is the K-1 leak Mode F exists to close');

  // Re-read from chain rather than trusting the receipt.
  const queued = callU(state.vault, 'queuedExitShares(address)(uint256)', state.signer);
  assert(queued === BigInt(exitShares), `queuedExitShares ${queued} != requested ${exitShares}`);
  const stillHeld = callU(state.vault, 'sharesOf(address)(uint256)', state.signer);
  assert(stillHeld === BigInt(exitShares),
    `shares were burned at queue time (${stillHeld}) — queued shares must stay outstanding but locked`);
  const usdcAfterQueue = callU(dep.usdc, 'balanceOf(address)(uint256)', state.signer);
  assert(usdcAfterQueue === usdcBefore,
    `USDC moved at queue time (${usdcBefore} → ${usdcAfterQueue}) — a queued exit must not pay out`);

  log(`MODE F CONFIRMED: ${queued} shares queued, still outstanding, no payout. navWad ${navBefore} at queue time.`);
  state.steps.requestExitModeF = {
    done: true, tx: r.transactionHash, chainTime: now, queuedShares: queued.toString(),
    sharesStillHeld: stillHeld.toString(), navWadAtQueue: navBefore.toString(),
    navPerShareAtQueue: npsBefore.toString(), usdcUnchanged: true,
  };
  save();
}

/** Settlement must be IMPOSSIBLE while the rebalance is still pending. */
function stepProveSettleBlocked() {
  const attempt = tryCall(state.vault, 'settleQueuedExit(address)', state.signer);
  assert(!attempt.ok,
    'settleQueuedExit succeeded while execution was still pending — EE-10/K-1 violated');
  // `!ok` alone does NOT prove the contract refused it. A rate limit, a timeout or an unreachable
  // RPC also produces `ok:false`, so the assertion above was satisfiable by a 429 — a security
  // invariant PASSING because the network was busy, and then persisted to the state file as
  // `revertedWith: "...429 Too Many Requests..."` where it reads like evidence. Only a recognised
  // REVERT is evidence about the contract; anything else means this step did not run.
  assert(attempt.kind === 'revert',
    `settleQueuedExit did not revert — the call failed for a NON-CONTRACT reason (${attempt.kind}), `
      + `so EE-10/K-1 is UNPROVEN, not proven: ${attempt.err}`);
  log(`settleQueuedExit correctly reverted while pending: ${attempt.err}`);
  state.steps.proveSettleBlocked = { done: true, revertedWith: attempt.err, kind: attempt.kind };
  save();
}

async function stepFinalize() {
  await waitUntilChainTime(state.revealDeadline, 'reveal phase end (1h)');
  const r = send('governance.finalize', dep.governance, 'finalize(uint256)', state.pid);
  const p = readProposal(dep.governance, state.pid);
  assert(p.status === 'Passed',
    `proposal finalized as ${p.status}, expected Passed. Vault B runs a 50% quorum; the signer's queued shares left eligible stake at queue time, so check revealedWeight ${p.revealedWeight} vs snapshotTotal ${p.snapshotTotal}.`);
  saveFirst('executableAt', p.executableAt);
  log(`proposal Passed — executable at ${p.executableAt}, expires ${p.expiresAt}`);
  state.steps.finalize = { done: true, tx: r.transactionHash, status: p.status, executableAt: p.executableAt, expiresAt: p.expiresAt };
  save();
}

async function stepExecute() {
  if (state.executableAt) await waitUntilChainTime(state.executableAt, 'execution timelock');
  const r = send('governance.execute(no-op rebalance)', dep.governance,
    'execute(uint256,bytes)', state.pid, state.payload);
  const executed = r.logs.find((l) => l.topics?.[0] === TOPIC.RebalanceExecuted());
  assert(executed, 'no RebalanceExecuted event');
  const p = readProposal(dep.governance, state.pid);
  assert(p.status === 'Executed', `proposal status ${p.status} after execute`);

  const navAfter = callU(state.vault, 'navWad()(uint256)');
  const npsAfter = callU(state.vault, 'navPerShareWad()(uint256)');
  saveFirst('navAfterExecution', navAfter.toString());
  saveFirst('npsAfterExecution', npsAfter.toString());
  log(`rebalance executed. navWad ${state.navBeforeExecution} → ${navAfter}`);
  state.steps.execute = {
    done: true, tx: r.transactionHash,
    navWadBefore: state.navBeforeExecution, navWadAfter: navAfter.toString(),
    navPerShareBefore: state.npsBeforeExecution, navPerShareAfter: npsAfter.toString(),
    noOp: npsAfter.toString() === state.npsBeforeExecution,
  };
  save();
}

/** Now — and only now — the queued exit can settle. */
function stepSettleQueued() {
  const pending = call(dep.governance, 'hasPendingExecution(address)(bool)', state.vault)[0];
  assert(pending === 'false', `hasPendingExecution still ${pending} after execution`);

  const usdcBefore = callU(dep.usdc, 'balanceOf(address)(uint256)', state.signer);
  const r = send('vaultB.settleQueuedExit', state.vault, 'settleQueuedExit(address)', state.signer);
  const settled = r.logs.find((l) => l.topics?.[0] === TOPIC.ExitSettled());
  assert(settled, 'no ExitSettled event from settleQueuedExit');

  const queuedAfter = callU(state.vault, 'queuedExitShares(address)(uint256)', state.signer);
  const sharesAfter = callU(state.vault, 'sharesOf(address)(uint256)', state.signer);
  const usdcAfter = callU(dep.usdc, 'balanceOf(address)(uint256)', state.signer);
  assert(queuedAfter === 0n, `queuedExitShares still ${queuedAfter} after settlement`);
  assert(sharesAfter === 0n, `sharesOf still ${sharesAfter} after full exit`);
  assert(usdcAfter > usdcBefore, `no USDC returned (${usdcBefore} → ${usdcAfter})`);

  const proceeds = usdcAfter - usdcBefore;
  log(`Mode-F settlement complete: ${proceeds} USDC units returned, shares 0, queue empty`);
  state.steps.settleQueued = {
    done: true, tx: r.transactionHash,
    usdcBefore: usdcBefore.toString(), usdcAfter: usdcAfter.toString(),
    proceedsUsdc: proceeds.toString(),
    settledAtNavWad: state.navAfterExecution,
    navUnchangedByNoOpRebalance: state.navAfterExecution === state.navBeforeExecution,
    caveat: 'the rebalance was a no-op, so pre- and post-execution NAV are equal: post-execution pricing is proven structurally (queued, settlement blocked until execution) and NOT numerically',
  };
  save();
}

// ────────────────────────────────── main ──────────────────────────────────

log('DRILL 3 — Mode-F exit: the K-1 seam, live on vault B');
preflight();
await runSteps([
  ['propose', stepPropose],
  ['proveModeIWindow', stepProveModeIWindow],
  ['commit', stepCommit],
  ['reveal', stepReveal],
  ['requestExitModeF', stepRequestExitModeF],
  ['proveSettleBlocked', stepProveSettleBlocked],
  ['finalize', stepFinalize],
  ['execute', stepExecute],
  ['settleQueued', stepSettleQueued],
], state, save);

log('──────────────────────────────────────────────');
log('DRILL 3 PASSED — Mode F exercised end to end');
log(`  proposal        ${state.pid}`);
log(`  queued at       reveal phase (chain ${state.steps.requestExitModeF?.chainTime})`);
log(`  settled for     ${state.steps.settleQueued?.proceedsUsdc} USDC units`);
log(`  navWad          ${state.navBeforeExecution} (queue) → ${state.navAfterExecution} (settle)`);
log(`  state file      ${STATE_PATH}`);
log('NOTE: the rebalance was a no-op, so the two NAV readings are equal by construction.');
log('      Post-execution pricing is proven by ORDERING, not by a price delta. Say so in the report.');
