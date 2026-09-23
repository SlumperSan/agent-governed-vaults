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
  decideReveal, finalizeDeadRound, waitOutProposalCooldown,
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
  // KEY BUG FIXED: this used to check `state.steps.requestExit`, a step name this drill never
  // writes (the actual step is `requestExitModeF`) — so the resume guard below was always false
  // and a legitimate resume holding queued shares from a completed run tripped this assertion.
  assert(queued === 0n || state.steps.requestExitModeF?.done,
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
  //
  // THREE-field payload, not two (card 207): Governance.execute's Rebalance branch decodes
  // `(address adapter, uint256 maxSlippageBps, IExecutionAdapter.SwapOrder[] orders)`. A
  // 2-field encode here decodes on-chain as garbage and Panics. maxSlippageBps = 100 (1%):
  // VaultCore.executeRebalance rejects 0 outright (BadSlippageBound) and the ceiling is
  // MAX_REBALANCE_SLIPPAGE_BPS (2%); orders stays empty either way, so no swap is attempted —
  // this bound only has to be IN RANGE. Same value scripts/smoke-test.mjs and
  // apps/vaults-ui/test/lib/ui-smoke-chain.mjs use for the identical no-op.
  const payload = saveFirst('payload',
    abiEncode('f(address,uint256,(address,address,uint256,uint256,uint256,bytes)[])', dep.adapter, 100, '[]'));
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

/**
 * A round may be auto-restarted at most this many times per process — same cap and same reason
 * as drill 2's (#369): unbounded restarts would burn gas forever if something keeps killing the
 * round before it can be won.
 */
const MAX_ROUND_RESTARTS = 2;
/** Cap for `waitOutProposalCooldown` (lib.mjs) — mirrors drill 2's. */
const MAX_COOLDOWN_WAIT_SEC = 2 * 3600;

/**
 * Settle a dead round (via `finalizeDeadRound`, lib.mjs) and discard this drill's round-scoped
 * state so `voteRound()` re-enters from `propose` — measured live 2026-09-21/22: proposal 13
 * resumed with `reveal` PENDING, `commitDeadline=1790050702`, `revealDeadline=1790054302`, the
 * identical shape drill 2's proposal 12 hit three days earlier.
 *
 * TWO THINGS DRILL 2's VERSION DOES NOT NEED, BOTH SPECIFIC TO MODE-F:
 *
 * 1. `proveModeIWindow` MUST be cleared along with the round-scoped keys. It is the drill's
 *    negative-half assertion (`now < commitDeadline`, Governance.sol:519's reveal-phase-opens-
 *    Mode-F boundary) checked against THIS proposal's `commitDeadline`. Clearing only
 *    `commit`/`reveal` and leaving `proveModeIWindow.done` true would let the restarted round
 *    complete having proved the negative half against a proposal that no longer exists — merely
 *    completing, not proving what the drill exists to prove.
 * 2. A restart must be REFUSED once the Mode-F exit has queued. `votingEligibleShares` is
 *    `sharesOf - queuedExitShares` (VaultCore.sol:1025-1028,1039-1041, confirmed by reading both
 *    call sites), so a signer with shares locked in the queue could never supply quorum to a
 *    fresh round again. This is checked live rather than assumed reachable: in THIS drill's step
 *    order `reveal` always precedes `requestExitModeF`, so a stale-reveal restart should never
 *    observe a non-zero queue — the guard exists to fail loudly if that invariant is ever broken
 *    (e.g. by a future reordering, or a hand-edited state file) rather than restart into a round
 *    that can structurally never pass.
 */
async function recoverStaleRound(pid, p, now) {
  const priorRestarts = state.roundRestartCount ?? 0;
  assert(priorRestarts < MAX_ROUND_RESTARTS,
    `Mode-F round ${pid} is unrecoverable (status ${p.status}, revealDeadline ${p.revealDeadline}, ` +
    `chain now ${now}) and has already been auto-restarted ${priorRestarts} time(s) — refusing to ` +
    `restart again (cap ${MAX_ROUND_RESTARTS}). Something is repeatedly killing this round before ` +
    'its vote can be revealed; investigate rather than retrying blindly.');

  const queued = callU(state.vault, 'queuedExitShares(address)(uint256)', state.signer);
  assert(queued === 0n,
    `cannot restart the Mode-F round: signer already has ${queued} shares queued for exit on ` +
    `${state.vault} — a fresh round could never reach quorum (votingEligibleShares = sharesOf - ` +
    'queuedExitShares, VaultCore.sol:1025-1028,1039-1041). This should be structurally impossible ' +
    'at this step (reveal precedes requestExitModeF in this drill) — investigate rather than restart.');

  log('──────────────────────────────────────────────');
  log(`Mode-F round: RESTARTING (auto-restart ${priorRestarts + 1}/${MAX_ROUND_RESTARTS})`);
  log(`  proposal ${pid}: status=${p.status}, commitDeadline=${p.commitDeadline}, ` +
    `revealDeadline=${p.revealDeadline}, chain now=${now}` +
    (p.status === 'Active' && now >= p.revealDeadline
      ? ` — ${now - p.revealDeadline}s PAST the reveal deadline`
      : ''));
  log('  this drill was almost certainly stopped and resumed after the reveal window closed');
  log('──────────────────────────────────────────────');

  await finalizeDeadRound(dep.governance, pid, 'Mode-F round');

  for (const key of ['pid', 'commitDeadline', 'revealDeadline', 'salt', 'executableAt']) delete state[key];
  for (const step of ['propose', 'proveModeIWindow', 'commit', 'reveal']) delete state.steps[step];
  state.roundRestartCount = priorRestarts + 1;
  save();
}

/**
 * Propose, prove the Mode-I negative, commit and reveal — one unit, so a stale-round restart can
 * re-enter from `propose` and re-prove `proveModeIWindow` against the new proposal (see
 * `recoverStaleRound`'s doc comment). Registered as ONE step (`voteRound`) in the step list below
 * so `runSteps`'s own resume-skip works whether the process is starting fresh, resuming mid-round
 * (this drill's old flat step names — `propose`, `proveModeIWindow`, `commit`, `reveal` — are kept
 * so an EXISTING state file, like tonight's `.state-drill3.json`, resumes correctly), or resuming
 * after this function has already recorded `voteRound` done.
 */
async function voteRound() {
  if (!state.pid) await waitOutProposalCooldown(dep.governance, state.vault, state.signer, MAX_COOLDOWN_WAIT_SEC);
  if (!state.steps.propose?.done) stepPropose();
  if (!state.steps.proveModeIWindow?.done) stepProveModeIWindow();
  if (!state.steps.commit?.done) stepCommit();

  if (!state.steps.reveal?.done) {
    await waitUntilChainTime(state.commitDeadline, 'commit phase end (1h)');

    // RE-READ CHAIN TRUTH BEFORE REVEALING — see decideReveal's doc comment (lib.mjs) and the
    // 2026-09-21/22 proposal-13 stranding (measured live: reveal PENDING, resumed with the track
    // A process dead) this exists to catch.
    const p = readProposal(dep.governance, state.pid);
    const now = chainNow();
    const hasCommit = callU(dep.governance, 'commitOf(uint256,address)(bytes32)', state.pid, state.signer) !== 0n;
    const alreadyRevealed = call(dep.governance, 'revealedOf(uint256,address)(bool)', state.pid, state.signer)[0] === 'true';
    const { action, reason } = decideReveal(p, { now, hasCommit, alreadyRevealed });

    if (action === 'already-revealed') {
      log('revealedOf[pid][signer] is already true on-chain — recording without re-sending');
      state.steps.reveal = { done: true, tx: '(recovered: already revealed on-chain)' };
      save();
    } else if (action === 'reveal') {
      // Reveal BEFORE exiting: queued shares leave eligible stake immediately, so exiting first
      // would forfeit this vote and the proposal would fail quorum.
      const r = send('governance.revealVote(FOR)', dep.governance,
        'revealVote(uint256,bool,bytes32)', state.pid, 'true', state.salt);
      const p2 = readProposal(dep.governance, state.pid);
      assert(p2.revealedVoterCount >= 1, `reveal did not register (revealedVoterCount ${p2.revealedVoterCount})`);
      log(`revealed FOR — revealedWeight ${p2.revealedWeight}, voters ${p2.revealedVoterCount}`);
      state.steps.reveal = { done: true, tx: r.transactionHash, revealedVoterCount: p2.revealedVoterCount };
      save();
    } else if (action === 'restart') {
      await recoverStaleRound(state.pid, p, now);
      return voteRound();
    } else {
      assert(false, `cannot reveal proposal ${state.pid} and this is not a stale-window case — ${reason}`);
    }
  }

  if (!state.steps.voteRound?.done) {
    state.steps.voteRound = { done: true };
    save();
  }
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
  ['voteRound', voteRound],
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
