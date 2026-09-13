#!/usr/bin/env node
// @ts-check
/**
 * DRILL 5 — AGENT EXECUTE MODE. The first live run of the reference agent with
 * `mode: 'execute'` against the real deployment, signing with a throwaway testnet account.
 *
 * ## Why this needs its own runner
 *
 * `packages/reference-agent/src/run.mjs:71` hard-codes `mode: 'dry-run'` with the comment
 * "this script never runs in execute mode". That is deliberate — the shipped CLI cannot be
 * talked into signing. Execute mode is reachable only by constructing the agent directly:
 *
 *     createAgent({ config: {...cfg, mode: 'execute'}, account, walletClient, ... })
 *
 * and the gate (`config.mjs:179`) additionally requires `AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes`.
 * Both are required; neither downgrades to a safe mode if the other is missing.
 *
 * ## Key handling — identical to Sprint 14
 *
 * The account comes from a V3 keystore decrypted in-process via `scripts/lib/keystore.mjs`,
 * with the path and password supplied by the OPERATOR's own invocation. No raw key is ever
 * accepted from the environment; `SOAK_AGENT_PRIVATE_KEY` is a hard refusal. This is the
 * "human injects the account" requirement of #21, implemented the way X402-LIVE-REPORT §9
 * established.
 *
 * The account must PERSIST: `OBSERVATION_WINDOW` is 4 hours (VaultCore.sol:51), so an
 * ephemeral in-process key like Sprint 14's payer would strand the deposit the moment the
 * process died. That is why this drill uses a keystore rather than `generatePrivateKey()`.
 *
 * ## Phases, and why the policy is retuned between them
 *
 *   join    — `policy.join` tuned to the smoke vault's real economics (1.00 USDC minimum),
 *             not the 25-USDC default. The agent decides to deposit and signs it.
 *   activate— the 4h observation window, then the agent activates its own pending deposit.
 *   vote    — needs an ACTIVE proposal on the smoke vault. The agent commits, then reveals,
 *             exercising the salt scheme live (S-4: the salt is derived, never stored).
 *   exit    — `policy.exit.maxDrawdownBps` is lowered to force the trigger. This is the
 *             "forced drawdown" of #21: we are testing that the agent ACTS on its exit rule,
 *             not that the vault actually lost money.
 *
 * The forced trigger is stated plainly in the transcript. An exit driven by a retuned
 * threshold is evidence the rule fires; it is NOT evidence of a real drawdown, and the report
 * must not imply otherwise.
 *
 * ## Governance serializes per VAULT
 *
 * The vote phase needs a live proposal on the smoke vault, and drill 2 also runs governance
 * rounds there. They cannot overlap — only one proposal is in flight on the smoke vault at a time.
 *
 * `run-soak.ps1` supplies that round rather than leaving it to the operator: track B runs drill 2
 * to completion, then this script's `join` and `activate` phases, then starts
 * `drill5-gov-companion.mjs` in the background, then re-enters this script for `vote` and `exit`.
 * The split is forced, because the two are each other's precondition: the companion refuses to
 * propose until the agent holds shares (drill5-gov-companion.mjs:54-56), and the vote phase
 * refuses to tick until a votable round exists.
 *
 * Env (required): SOAK_AGENT_KEYSTORE, SOAK_AGENT_KEYSTORE_PASSWORD,
 *                 AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes
 * Env (optional): SOAK_RPC (or BASE_SEPOLIA_RPC), SOAK_DEPLOYMENT, SOAK_API, SOAK_STATE_DIR,
 *                 SOAK_TICK_MS, SOAK_MAX_TICKS,
 *                 SOAK_AGENT_CAP_USDC (x402 session spend cap per phase poll window, default
 *                 5.00 — see the cap note in buildAgent), SOAK_PHASE (run a single phase),
 *                 SOAK_RESET=1
 * Run:  node scripts/soak/drill5-agent-execute.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, RPC, log, assert, eq, call, callU, chainNow, waitUntilChainTime, openState, cast,
  budgetExhaustedFailure,
  readProposal, votableNow,
} from './lib.mjs';
import { assertLiveChainId, deploymentPath, loadDeployment } from './deployment.mjs';
import { loadAccountFromKeystore, redact } from '../lib/keystore.mjs';
import { resolveAgentRunConfig, policyFor, TESTNET_CHAIN_IDS, EXECUTE_ENV_VAR } from './agent-policy.mjs';

const dep = loadDeployment(deploymentPath(ROOT));
const soak = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'soak', 'soak-vaults.json'), 'utf8'));
const VAULT = soak.smokeVault.address;

const STATE_DIR = process.env.SOAK_STATE_DIR ?? path.join(ROOT, 'scripts', 'soak');
const STATE_PATH = path.join(STATE_DIR, '.state-drill5.json');
const TRANSCRIPT = path.join(ROOT, 'docs', 'evidence', 'soak-agent-run.json');
const TICK_MS = Number(process.env.SOAK_TICK_MS ?? 30_000);
const MAX_TICKS = Number(process.env.SOAK_MAX_TICKS ?? 40);

const { state, save, saveFirst } = openState(STATE_PATH, dep.factory);

async function buildAgent(phase, cfgIn, account, walletClient, entryMarks = {}) {
  const { createAgent } = await import('../../packages/reference-agent/src/agent.mjs');
  const { loadConfig } = await import('../../packages/reference-agent/src/config.mjs');
  const { createChainReader } = await import('../../packages/reference-agent/src/chain.mjs');
  const { createLogger } = await import('../../packages/reference-agent/src/log.mjs');

  const config = loadConfig({
    mode: 'execute',
    // THE CAP MUST COVER A WHOLE POLL WINDOW, and $0.25 did not. One tick pays for `2 + vaultCount`
    // metered reads (perceive.mjs:127, 133, 144) at $0.01 each (apps/api/src/serve.mjs:70,
    // PRICE_AMOUNT default '10000'), so the 2026-09-04 run burned $0.05/tick against three indexed
    // vaults and went blind at tick 5 of 40. 40 ticks at that rate needs $2.00; $5.00 buys 40 ticks
    // at $0.125, i.e. ten indexed vaults. The owner authorised the raise for this testnet soak.
    // Still PER SESSION, not per drill: `createBudget` runs inside `createAgent` (agent.mjs:52),
    // and `tickUntil` builds a fresh agent per phase window.
    api: {
      baseUrl: cfgIn.apiBaseUrl,
      payments: {
        enabled: true,
        maxSessionSpendUsdc: process.env.SOAK_AGENT_CAP_USDC ?? '5.00',
        maxSingleReadUsdc: '0.05',
      },
    },
    chain: {
      rpcUrl: cfgIn.rpcUrl, chainId: dep.chainId, chainName: dep.chainName,
      governance: dep.governance.toLowerCase(),
      subvaultRegistry: dep.subRegistry.toLowerCase(), // omit and the fee gate always blocks
      usdc: dep.usdc.toLowerCase(), usdcName: 'USDC', usdcVersion: '2',
    },
    // UNITS. `policy.join.depositUsdc` is in WHOLE USDC (the shipped default is '25'), not the
    // 6-decimal base units the contracts and soak-vaults.json use everywhere else. Feeding it
    // "1000000" asked the agent to deposit one MILLION dollars, and its capacity gate correctly
    // refused: "$996 free of $1000 cap; need $1000000". The gate was right; the config was mine.
    policy: policyFor(phase, { depositUsdc: soak.agentDepositWholeUsdc ?? '1', maxDrawdownBps: 1000 }),
  });

  const events = [];
  const logger = createLogger({ json: false });
  const wrapped = {
    ...logger,
    info: (m, d) => { events.push({ level: 'info', msg: m, detail: redact(d) }); logger.info(m, d); },
    warn: (m, d) => { events.push({ level: 'warn', msg: m, detail: redact(d) }); logger.warn(m, d); },
    error: (m, d) => { events.push({ level: 'error', msg: m, detail: redact(d) }); logger.error(m, d); },
  };

  const chainReader = createChainReader({
    rpcUrl: config.chain.rpcUrl, chainId: config.chain.chainId, chainName: config.chain.chainName,
    governance: config.chain.governance,
    onEvent: (e) => wrapped[e.level === 'warn' ? 'warn' : 'info'](e.msg, e.detail),
  });

  const agent = createAgent({
    config, account, payer: account, chainReader, log: wrapped,
    env: process.env, fetchImpl: fetch, walletClient, entryMarks,
  });
  return { agent, events, config };
}

/** Run ticks until `done()` says the on-chain goal is reached, or the tick budget runs out. */
async function tickUntil(phase, cfgIn, account, walletClient, done, label, entryMarks = {}) {
  const { agent, events, config } = await buildAgent(phase, cfgIn, account, walletClient, entryMarks);
  assert(config.mode === 'execute', `agent built in ${config.mode} mode — the gate did not engage`);
  for (let i = 0; i < MAX_TICKS; i++) {
    if (done()) { log(`${label}: goal already satisfied on-chain`); break; }
    await agent.loop({ maxTicks: 1 });
    if (done()) { log(`${label}: goal reached after ${i + 1} tick(s)`); break; }

    // THE BUDGET IS TERMINAL, SO STOP POLLING AS IF IT WERE NOT.
    //
    // The agent perceives through PAID x402 reads. Once the session spend cap is exhausted it can
    // no longer read the vault list or the leaderboard, so it reports "perception gaps" and
    // "no action warranted" on every subsequent tick — forever. No later tick can satisfy `done()`.
    //
    // On 2026-09-04 this drill hit the cap at tick 5 of 40 and then polled a permanently blind
    // agent for the remaining 35 ticks — 17.5 minutes — before failing with
    // "vote:commit: not satisfied after 40 ticks", which names a GOVERNANCE symptom for what was
    // a HARNESS BUDGET cause. Same substitution this soak keeps making: the observed effect
    // standing in for the reason.
    const exhausted = budgetExhaustedFailure(agent.budget?.summary?.(), i + 1, MAX_TICKS, label);
    if (exhausted) assert(false, exhausted);

    log(`${label}: tick ${i + 1}/${MAX_TICKS}, not yet satisfied`);
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  assert(done(), `${label}: not satisfied after ${MAX_TICKS} ticks — inspect the transcript`);
  return events;
}

const record = (phase, events, extra = {}) => {
  state.phases = state.phases ?? {};
  state.phases[phase] = { done: true, at: new Date().toISOString(), events: events.length, ...extra };
  state.log = (state.log ?? []).concat(events.map((e) => ({ phase, ...e })));
  save();
};

// ────────────────────────────────── main ──────────────────────────────────

log('DRILL 5 — reference agent, EXECUTE mode, live deployment');
const cfgIn = resolveAgentRunConfig(process.env);

const chainId = Number(cast(['chain-id', '--rpc-url', cfgIn.rpcUrl]));
assert(TESTNET_CHAIN_IDS.has(chainId), `refusing to run against chain ${chainId} — testnet only`);
assertLiveChainId(dep, chainId);

const account = await loadAccountFromKeystore(cfgIn.keystore, cfgIn.password);
saveFirst('agent', account.address);
log(`agent identity ${account.address} (throwaway, keystore-held by the operator)`);

// SPENDABLE USDC IS A `join` PRECONDITION, NOT A DRILL-WIDE ONE. This check sits above every
// `want(...)` guard, so it also gates activate, vote and exit — none of which spend USDC, and all
// of which run AFTER the deposit has left the wallet. run-soak.ps1 now invokes this script three
// times (join, activate, then vote+exit) so the governance companion can raise its round in
// between, which makes those later invocations the normal case rather than a resume-only one.
// On 2026-09-04 the agent read 995,100 units while holding 1e18 shares — under the threshold, so
// the unqualified form aborts before the phase guard that would have skipped join.
// The minimum is met once the money is escrowed or minted, so accept either as evidence of it.
const usdc = callU(dep.usdc, 'balanceOf(address)(uint256)', account.address);
const eth = BigInt(cast(['balance', account.address, '--rpc-url', cfgIn.rpcUrl]));
const [pendingUsdc] = call(VAULT, 'pendingDeposit(address)(uint256,uint64)', account.address);
const joinedShares = callU(VAULT, 'sharesOf(address)(uint256)', account.address);
const joined = BigInt(pendingUsdc) > 0n || joinedShares > 0n;
assert(usdc >= 1_000_000n || joined,
  `agent needs >= 1.00 USDC to meet the vault minimum, or a deposit already in `
  + `(has ${usdc} units, pending ${pendingUsdc}, shares ${joinedShares})`);
assert(eth >= 10n ** 15n, `agent needs test ETH for gas (has ${eth} wei)`);
log(`agent funded: ${usdc} USDC units, ${eth} wei (pending ${pendingUsdc}, shares ${joinedShares})`);

const { createWalletClient, http } = await import('viem');
const { baseSepolia } = await import('viem/chains');
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(cfgIn.rpcUrl) });

const only = process.env.SOAK_PHASE;
const want = (p) => !only || only === p;

// ── join ──
if (want('join') && !state.phases?.join?.done) {
  const done = () => {
    const [pending] = call(VAULT, 'pendingDeposit(address)(uint256,uint64)', account.address);
    return BigInt(pending) > 0n || callU(VAULT, 'sharesOf(address)(uint256)', account.address) > 0n;
  };
  const events = await tickUntil('join', cfgIn, account, walletClient, done, 'join');
  const [pending, availableAt] = call(VAULT, 'pendingDeposit(address)(uint256,uint64)', account.address);
  saveFirst('availableAt', Number(availableAt));
  log(`agent deposited: pending ${pending}, activation available at chain time ${availableAt}`);
  record('join', events, { pendingDeposit: pending, availableAt: Number(availableAt) });
}

// ── activate ──
if (want('activate') && !state.phases?.activate?.done) {
  // skipWindow() activates a pending deposit immediately (VaultCore.sol:369), so shares may
  // already exist long before availableAt. Only wait for the window when nothing is minted yet.
  const preShares = callU(VAULT, 'sharesOf(address)(uint256)', account.address);
  if (preShares === 0n && state.availableAt) await waitUntilChainTime(state.availableAt, 'agent observation window (4h)');
  const done = () => callU(VAULT, 'sharesOf(address)(uint256)', account.address) > 0n;
  const events = await tickUntil('activate', cfgIn, account, walletClient, done, 'activate');
  const shares = callU(VAULT, 'sharesOf(address)(uint256)', account.address);
  saveFirst('shares', shares.toString());
  log(`agent activated: ${shares} shares`);
  record('activate', events, { shares: shares.toString() });
}

// ── vote (commit AND reveal — the salt scheme live) ──
if (want('vote') && !state.phases?.vote?.done) {
  const pid = callU(dep.governance, 'activeProposalOf(address)(uint256)', VAULT);
  assert(pid > 0n,
    'no proposal has ever been raised on the smoke vault — the agent has nothing to vote on. Start drill 2\'s allocate round (or a standalone no-op proposal) first; governance serializes per vault, so only one may be in flight.');

  // No hasCommitted/hasRevealed helpers exist — read the public mappings directly.
  // commitOf is bytes32(0) until a commitment lands; revealedOf is the reveal flag.
  const ZERO32 = '0x' + '0'.repeat(64);
  const hasCommitted = () => call(dep.governance, 'commitOf(uint256,address)(bytes32)', pid.toString(), account.address)[0] !== ZERO32;

  // ORDER MATTERS: ask "already committed?" BEFORE "still votable?".
  //
  // `record('vote', ...)` runs only after commit AND reveal, so any restart between the two
  // re-enters this phase — and by then the commit deadline has legitimately passed, because
  // `waitUntilChainTime` below waits for exactly that. Gating on votability first would abort a
  // LIVE round mid-reveal, claiming "a fresh round must be raised", which is false: the
  // commitment is on-chain and only the reveal remains. The reveal window here is 3600s inside a
  // 14-hour unattended run that advertises resumability, so that path is ordinary, not exotic.
  //
  // Checking the commitment first also closes `AlreadyCommitted` (Governance.sol:364) without a
  // fifth conjunct, and keeps `votableNow`'s contract honestly "can this voter still COMMIT".
  if (!hasCommitted()) {
    // A pid is NOT a votable round. `activeProposalOf` is never cleared on settlement, so it names
    // the last proposal the vault ever had regardless of its state — see `votableNow`, which
    // documents the fourteen-hour-dead proposal this guard used to accept.
    const prop = readProposal(dep.governance, pid);

    // BOTH TERMS, because `commitVote` gates on `_boundedWeight` (Governance.sol:352-356), which
    // is min(snapshot, current) — not the snapshot alone. `votingEligibleShares` is
    // `sharesOf - queuedExitShares` (VaultCore.sol:1025-1028), so a voter who has queued an exit
    // has snapshot weight and no current weight, and a snapshot-only check would call that
    // votable and then watch `commitVote` revert NoWeight for forty ticks. Drill 5 queues an exit
    // in its own next phase, so a re-run or reset reaches this exact state.
    //
    // Both terms go to `votableNow` UNBOUNDED. It applies the same minimum for its verdict, but
    // keeping them apart is what lets it say WHICH one is zero: minimising here first would make
    // a queued-exit voter indistinguishable from one whose shares postdate the proposal.
    //
    // NOTE THE `uint64`. VaultCore.sol:1040 declares `pastVotingEligibleShares(address, uint64)`;
    // the `uint256` spelling is a DIFFERENT SELECTOR (0xab46cdef vs 0xc5a88eb3) and reverts, which
    // is how the first version of this guard aborted the phase 100% of the time.
    const snap = callU(
      VAULT, 'pastVotingEligibleShares(address,uint64)(uint256)',
      account.address, String(prop.createdAt - 1),
    );
    const cur = callU(VAULT, 'votingEligibleShares(address)(uint256)', account.address);
    // Named for what it holds. Calling this local `snapshotWeight` put that word on the bounded
    // minimum one line above the argument spelled `snapshotWeight:`, which takes `snap` — two
    // meanings, three lines apart, for the confusion this whole gate exists to remove.
    const boundedWeight = snap < cur ? snap : cur;

    const { votable, reason } = votableNow(prop, { now: chainNow(), snapshotWeight: snap, currentWeight: cur });
    assert(votable,
      `proposal ${pid} on the smoke vault is NOT votable by this agent: ${reason}.\n`
        + `  status=${prop.status} ptype=${prop.ptype} createdAt=${prop.createdAt} `
        + `commitDeadline=${prop.commitDeadline} revealDeadline=${prop.revealDeadline} `
        + `snapshot=${snap} current=${cur} boundedWeight=${boundedWeight}\n`
        + '  This is a HARNESS/round-availability failure, not evidence about governance or the\n'
        + '  contracts, and no amount of ticking will change it. A fresh round must be raised on this\n'
        + '  vault AFTER the agent holds shares (voting weight snapshots at createdAt-1), and any\n'
        + '  settled-but-still-named predecessor must be finalized first — governance serializes per\n'
        + '  vault. scripts/soak/drill5-gov-companion.mjs does exactly that, and run-soak.ps1 starts\n'
        + '  it in the background before this phase — so read logs/gov-companion.log and\n'
        + '  logs/gov-companion.err.log for why no round is there. Running this drill standalone,\n'
        + '  start the companion yourself first.');
    log(`proposal ${pid} is votable: status=${prop.status} commitDeadline=${prop.commitDeadline} boundedWeight=${boundedWeight}`);
  } else {
    log(`proposal ${pid} already carries this agent's commitment — skipping the votability gate and going to reveal`);
  }

  const commitEvents = await tickUntil('vote', cfgIn, account, walletClient, hasCommitted, 'vote:commit');
  saveFirst('votedPid', pid.toString());

  const p = call(dep.governance,
    'proposals(uint256)(address,uint8,address,uint64,uint64,uint64,uint64,uint64,uint8,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)',
    pid.toString());
  await waitUntilChainTime(Number(p[4]), 'commit phase end, before the agent reveals');

  const hasRevealed = () => call(dep.governance, 'revealedOf(uint256,address)(bool)', pid.toString(), account.address)[0] === 'true';
  const revealEvents = await tickUntil('vote', cfgIn, account, walletClient, hasRevealed, 'vote:reveal');
  log(`agent committed AND revealed on proposal ${pid} — the salt was re-derived, never stored (S-4)`);
  record('vote', [...commitEvents, ...revealEvents], { pid: pid.toString(), committed: true, revealed: true });
}

// ── exit (forced drawdown trigger) ──
if (want('exit') && !state.phases?.exit?.done) {
  // TWO forcings, both stated in the transcript. The smoke vault holds only idle USDC, so its
  // navPerShare is exactly 1e18 and cannot fall — no threshold detects a drawdown that does not
  // exist. So the entry MARK is seeded 2% above the true NAVps (seeded marks take precedence,
  // agent.mjs:101), making the agent PERCEIVE a ~200bp drawdown against its 1bp threshold. This
  // proves the perceive→decide→requestExit path end to end; it is NOT evidence of a real loss.
  log('forcing the exit trigger: entry mark seeded 2% above true NAVps, threshold 1bp');
  const seededMark = (10n ** 18n * 102n) / 100n;
  const done = () =>
    callU(VAULT, 'sharesOf(address)(uint256)', account.address) === 0n
    || callU(VAULT, 'queuedExitShares(address)(uint256)', account.address) > 0n;
  const events = await tickUntil('exit', cfgIn, account, walletClient, done, 'exit',
    { [VAULT.toLowerCase()]: seededMark });
  const shares = callU(VAULT, 'sharesOf(address)(uint256)', account.address);
  const queued = callU(VAULT, 'queuedExitShares(address)(uint256)', account.address);
  const usdcAfter = callU(dep.usdc, 'balanceOf(address)(uint256)', account.address);
  log(`agent exited: shares ${shares}, queued ${queued}, USDC ${usdcAfter}`);
  record('exit', events, {
    sharesAfter: shares.toString(), queuedAfter: queued.toString(), usdcAfter: usdcAfter.toString(),
    forcedTrigger: 'entry mark seeded to 1.02e18 vs true navPerShare 1.0e18 (~200bp perceived drawdown) against a 1bp threshold — proves the perceive→decide→requestExit path fires; the vault is pure idle USDC and its NAVps never moved',
  });
}

// ── transcript ──
fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
const transcript = {
  drill: 'sprint-12/drill-5-agent-execute',
  finishedAt: new Date().toISOString(),
  chainId, vault: VAULT, agent: state.agent,
  mode: 'execute',
  keyHandling: 'V3 keystore decrypted in-process; path and password supplied by the operator invocation; raw keys in env are refused',
  phases: state.phases ?? {},
  events: state.log ?? [],
  caveats: [
    'the exit was driven by a FORCED policy threshold (maxDrawdownBps=1), not by a real NAV drawdown',
    'the agent voted on a proposal raised by the operator; it did not author a proposal itself',
  ],
};
fs.writeFileSync(TRANSCRIPT, JSON.stringify(transcript, null, 2));

log('──────────────────────────────────────────────');
log('DRILL 5 COMPLETE');
log(`  agent      ${state.agent}`);
log(`  phases     ${Object.keys(state.phases ?? {}).join(', ') || '(none)'}`);
log(`  transcript ${TRANSCRIPT}`);
log(`  state file ${STATE_PATH}`);
