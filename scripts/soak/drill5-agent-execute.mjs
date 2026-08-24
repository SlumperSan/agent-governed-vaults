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
 * rounds there. They cannot overlap. Run drill 2's allocate round first and let this drill's
 * agent vote on it, or raise a standalone no-op proposal for it — either way, only one
 * proposal is in flight on the smoke vault at a time.
 *
 * Env (required): SOAK_AGENT_KEYSTORE, SOAK_AGENT_KEYSTORE_PASSWORD,
 *                 AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes
 * Env (optional): BASE_SEPOLIA_RPC, SOAK_API, SOAK_STATE_DIR, SOAK_TICK_MS, SOAK_MAX_TICKS,
 *                 SOAK_PHASE (run a single phase), SOAK_RESET=1
 * Run:  node scripts/soak/drill5-agent-execute.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, RPC, log, assert, eq, call, callU, chainNow, waitUntilChainTime, openState, cast,
} from './lib.mjs';
import { loadDeployment } from './deployment.mjs';
import { loadAccountFromKeystore, redact } from '../lib/keystore.mjs';
import { resolveAgentRunConfig, policyFor, TESTNET_CHAIN_IDS, EXECUTE_ENV_VAR } from './agent-policy.mjs';

const dep = loadDeployment(
  path.join(ROOT, 'contracts', 'config', 'deployments', 'base-sepolia.json'),
  { expectChainId: 84532 },
);
const soak = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'soak', 'soak-vaults.json'), 'utf8'));
const VAULT = soak.smokeVault.address;

const STATE_DIR = process.env.SOAK_STATE_DIR ?? path.join(ROOT, 'scripts', 'soak');
const STATE_PATH = path.join(STATE_DIR, '.state-drill5.json');
const TRANSCRIPT = path.join(ROOT, 'docs', 'evidence', 'soak-agent-run.json');
const TICK_MS = Number(process.env.SOAK_TICK_MS ?? 30_000);
const MAX_TICKS = Number(process.env.SOAK_MAX_TICKS ?? 40);

const { state, save, saveFirst } = openState(STATE_PATH, dep.factory);

async function buildAgent(phase, cfgIn, account, walletClient) {
  const { createAgent } = await import('../../packages/reference-agent/src/agent.mjs');
  const { loadConfig } = await import('../../packages/reference-agent/src/config.mjs');
  const { createChainReader } = await import('../../packages/reference-agent/src/chain.mjs');
  const { createLogger } = await import('../../packages/reference-agent/src/log.mjs');

  const config = loadConfig({
    mode: 'execute',
    api: { baseUrl: cfgIn.apiBaseUrl, payments: { enabled: true, maxSessionSpendUsdc: '0.25', maxSingleReadUsdc: '0.05' } },
    chain: {
      rpcUrl: cfgIn.rpcUrl, chainId: dep.chainId, chainName: 'base-sepolia',
      governance: dep.governance.toLowerCase(),
      subvaultRegistry: dep.subRegistry.toLowerCase(), // omit and the fee gate always blocks
      usdc: dep.usdc.toLowerCase(), usdcName: 'USDC', usdcVersion: '2',
    },
    policy: policyFor(phase, { depositUsdc: soak.agentDepositUsdc ?? '1', maxDrawdownBps: 1000 }),
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
    env: process.env, fetchImpl: fetch, walletClient,
  });
  return { agent, events, config };
}

/** Run ticks until `done()` says the on-chain goal is reached, or the tick budget runs out. */
async function tickUntil(phase, cfgIn, account, walletClient, done, label) {
  const { agent, events, config } = await buildAgent(phase, cfgIn, account, walletClient);
  assert(config.mode === 'execute', `agent built in ${config.mode} mode — the gate did not engage`);
  for (let i = 0; i < MAX_TICKS; i++) {
    if (done()) { log(`${label}: goal already satisfied on-chain`); break; }
    await agent.loop({ maxTicks: 1 });
    if (done()) { log(`${label}: goal reached after ${i + 1} tick(s)`); break; }
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
assert(chainId === dep.chainId, `RPC chain ${chainId} != address book ${dep.chainId}`);

const account = await loadAccountFromKeystore(cfgIn.keystore, cfgIn.password);
saveFirst('agent', account.address);
log(`agent identity ${account.address} (throwaway, keystore-held by the operator)`);

const usdc = callU(dep.usdc, 'balanceOf(address)(uint256)', account.address);
const eth = BigInt(cast(['balance', account.address, '--rpc-url', cfgIn.rpcUrl]));
assert(usdc >= 1_000_000n, `agent needs >= 1.00 USDC to meet the vault minimum (has ${usdc})`);
assert(eth >= 10n ** 15n, `agent needs test ETH for gas (has ${eth} wei)`);
log(`agent funded: ${usdc} USDC units, ${eth} wei`);

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
  if (state.availableAt) await waitUntilChainTime(state.availableAt, 'agent observation window (4h)');
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
    'no active proposal on the smoke vault — the agent has nothing to vote on. Start drill 2\'s allocate round (or a standalone no-op proposal) first; governance serializes per vault, so only one may be in flight.');
  // No hasCommitted/hasRevealed helpers exist — read the public mappings directly.
  // commitOf is bytes32(0) until a commitment lands; revealedOf is the reveal flag.
  const ZERO32 = '0x' + '0'.repeat(64);
  const hasCommitted = () => call(dep.governance, 'commitOf(uint256,address)(bytes32)', pid.toString(), account.address)[0] !== ZERO32;
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
  log('retuning policy.exit.maxDrawdownBps to 1 — a FORCED trigger, not a real drawdown');
  const done = () =>
    callU(VAULT, 'sharesOf(address)(uint256)', account.address) === 0n
    || callU(VAULT, 'queuedExitShares(address)(uint256)', account.address) > 0n;
  const events = await tickUntil('exit', cfgIn, account, walletClient, done, 'exit');
  const shares = callU(VAULT, 'sharesOf(address)(uint256)', account.address);
  const queued = callU(VAULT, 'queuedExitShares(address)(uint256)', account.address);
  const usdcAfter = callU(dep.usdc, 'balanceOf(address)(uint256)', account.address);
  log(`agent exited: shares ${shares}, queued ${queued}, USDC ${usdcAfter}`);
  record('exit', events, {
    sharesAfter: shares.toString(), queuedAfter: queued.toString(), usdcAfter: usdcAfter.toString(),
    forcedTrigger: 'policy.exit.maxDrawdownBps lowered to 1 bp — proves the RULE fires; not evidence of a real drawdown',
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
