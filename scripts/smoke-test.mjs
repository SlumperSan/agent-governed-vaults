#!/usr/bin/env node
// @ts-check
/**
 * Base Sepolia smoke test — drives the FULL protocol lifecycle against a live
 * DeployTestnet.s.sol deployment, with real wall-clock waits:
 *
 *   preflight → createVault → registerVault(gov) → deposit → [4h observation window]
 *   → activate → propose(no-op rebalance) → commit → [1h] → reveal → [1h] → finalize
 *   → execute(no-op rebalance) → requestExit (Mode I, in kind) → assertions
 *
 * One command: `node scripts/smoke-test.mjs`. Total wall time ≈ 6–7 hours; the runner
 * sleeps between phases, persists progress to a state file, and is safe to Ctrl+C and
 * re-run — it resumes exactly where it left off (the commit salt is persisted BEFORE the
 * commit transaction is sent, so a reveal is never stranded).
 *
 * Zero npm dependencies: every chain interaction shells out to Foundry's `cast`.
 * KEY HANDLING: this script never reads, stores, or prompts for a private key. Every
 * write goes through `cast send` with the flags you put in SMOKE_SIGNER_ARGS — the key
 * stays inside Foundry's keystore (or your Ledger). If the keystore needs a password and
 * none is supplied via --password-file, cast prompts on YOUR terminal (stdin is inherited).
 *
 * Environment:
 *   BASE_SEPOLIA_RPC   RPC url            (default: https://base-sepolia-rpc.publicnode.com)
 *   SMOKE_SIGNER_ARGS  cast signer flags  (required; e.g. "--account deployer --password-file .pw")
 *   DEPLOY_JSON        forge broadcast output
 *                      (default: contracts/broadcast/DeployTestnet.s.sol/84532/run-latest.json)
 *   SMOKE_CONFIG       chain config       (default: contracts/config/base-sepolia.json)
 *   SMOKE_STATE        state file         (default: scripts/.smoke-state.json)
 *   SMOKE_RESET=1      discard prior state and start a fresh lifecycle
 *   CAST               cast binary        (default: "cast" on PATH)
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyProposal } from './proposal-recovery.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://base-sepolia-rpc.publicnode.com';
const CAST = process.env.CAST ?? 'cast';
const DEPLOY_JSON = process.env.DEPLOY_JSON
  ?? path.join(ROOT, 'contracts', 'broadcast', 'DeployTestnet.s.sol', '84532', 'run-latest.json');
const CONFIG_PATH = process.env.SMOKE_CONFIG ?? path.join(ROOT, 'contracts', 'config', 'base-sepolia.json');
const STATE_PATH = process.env.SMOKE_STATE ?? path.join(ROOT, 'scripts', '.smoke-state.json');

// ────────────────────────────── small utilities ──────────────────────────────

const log = (msg) => console.log(`[smoke ${new Date().toISOString()}] ${msg}`);
const fail = (msg) => { console.error(`\n[smoke] FAIL: ${msg}`); process.exit(1); };
const assert = (cond, msg) => { if (!cond) fail(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tokenize SMOKE_SIGNER_ARGS respecting double quotes (for paths with spaces). */
function tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2]);
  return out;
}
const SIGNER_ARGS = tokenize(process.env.SMOKE_SIGNER_ARGS ?? '');

/** Run cast; interactive stdin/stderr so keystore password prompts reach the human. */
function cast(args, { interactive = false } = {}) {
  try {
    return execFileSync(CAST, args, {
      encoding: 'utf8',
      stdio: [interactive ? 'inherit' : 'ignore', 'pipe', interactive ? 'inherit' : 'pipe'],
      windowsHide: true,
    }).trim();
  } catch (e) {
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw new Error(`cast ${args.slice(0, 3).join(' ')} … failed: ${detail}`);
  }
}

/** Strip cast's " [1.23e45]" scientific-notation annotations from an output line. */
const clean = (line) => line.replace(/\s+\[[^\]]*\]$/, '').trim();

/** Read-only call. Returns array of decoded output lines. */
function call(to, sig, ...args) {
  const out = cast(['call', to, sig, ...args.map(String), '--rpc-url', RPC]);
  return out.split('\n').map(clean);
}
const callU = (to, sig, ...args) => BigInt(call(to, sig, ...args)[0]);

/** Synchronous sleep — used only by readUntilEq's retry loop, so the (non-async) step functions
 * need no async plumbing. Atomics.wait blocks this thread for `ms`. */
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Read a value a just-mined tx should have set, retrying to defend against a LOAD-BALANCED public
 * RPC serving the read from a replica that has not yet applied the block — a read-after-write race
 * (sepolia.base.org does this routinely). This is a client/RPC-consistency defence, NOT a protocol
 * check: the `send()` above already asserted the tx succeeded (status 0x1), so the state IS set;
 * we are only waiting for the node we read from to catch up. */
function readUntilEq(want, label, to, sig, ...args) {
  let last;
  for (let i = 0; i < 20; i++) {
    last = call(to, sig, ...args)[0];
    if (last === want) return;
    sleepSync(1500);
  }
  fail(`${label} (after ~30s of RPC retries; last read '${last}', wanted '${want}')`);
}

/** State-changing call via the human's signer. Returns the receipt (asserts success). */
function send(label, to, sig, ...args) {
  log(`tx: ${label}`);
  const out = cast(
    ['send', to, sig, ...args.map(String), '--rpc-url', RPC, '--json', ...SIGNER_ARGS],
    { interactive: true },
  );
  const receipt = JSON.parse(out.slice(out.indexOf('{')));
  assert(receipt.status === '0x1' || receipt.status === 1, `${label}: transaction reverted (${receipt.transactionHash})`);
  log(`   mined ${receipt.transactionHash} (block ${Number(receipt.blockNumber)})`);
  // Best-effort read-your-writes against a LOAD-BALANCED RPC: wait until the endpoint reports a
  // height >= our tx's block before the caller's follow-up reads, so they are less likely to hit a
  // replica that has not applied the block yet. (readUntilEq is the belt-and-braces on criticals.)
  for (let i = 0; i < 20; i++) {
    if (Number(cast(['block', 'latest', '-f', 'number', '--rpc-url', RPC])) >= Number(receipt.blockNumber)) break;
    sleepSync(1000);
  }
  return receipt;
}

const keccakOf = (data) => cast(['keccak', data]);
const abiEncode = (sig, ...args) => cast(['abi-encode', sig, ...args.map(String)]);
const topicToAddress = (t) => '0x' + t.slice(26);
const eq = (a, b) => a.toLowerCase() === b.toLowerCase();

function chainNow() {
  return Number(cast(['block', 'latest', '-f', 'timestamp', '--rpc-url', RPC]));
}

async function waitUntilChainTime(target, label) {
  for (;;) {
    const now = chainNow();
    if (now >= target) return;
    const remain = target - now;
    log(`waiting for ${label}: ${Math.floor(remain / 60)}m${remain % 60}s remaining (chain time ${now}, target ${target})`);
    await sleep(Math.min(60, remain) * 1000);
  }
}

// ─────────────────────────── config + deployment + state ───────────────────────────

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const smoke = cfg.smoke;

function loadDeployment() {
  assert(fs.existsSync(DEPLOY_JSON), `deploy output not found at ${DEPLOY_JSON} — run the DeployTestnet forge script first (see docs/TESTNET-CHECKLIST.md)`);
  const j = JSON.parse(fs.readFileSync(DEPLOY_JSON, 'utf8'));
  const byName = {};
  for (const tx of j.transactions ?? []) {
    if (tx.transactionType === 'CREATE' && tx.contractName) {
      (byName[tx.contractName] ??= []).push(tx.contractAddress);
    }
  }
  const one = (name) => {
    const a = byName[name] ?? [];
    assert(a.length === 1, `expected exactly one ${name} in ${DEPLOY_JSON}, found ${a.length}`);
    return a[0];
  };
  return {
    registry: one('OperatorRegistry'),
    subRegistry: one('SubVaultRegistry'),
    feeEngine: one('FeeEngine'),
    governance: one('Governance'),
    factory: one('VaultFactory'),
    // C-6: the launch oracle is ChainlinkOracle (the custom OracleAggregator bring-up is retired in
    // DeployTestnet.s.sol). Kept under the field name `aggregator` so every downstream reference is
    // unchanged — ChainlinkOracle is an IOracleAggregator (same priceWad(address) surface).
    aggregator: one('ChainlinkOracle'),
    adapter: one('AggregationRouterAdapter'),
  };
}

const dep = loadDeployment();

let state = { deployJson: DEPLOY_JSON, factory: dep.factory, steps: {} };
if (fs.existsSync(STATE_PATH) && process.env.SMOKE_RESET !== '1') {
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  assert(eq(state.factory, dep.factory),
    `state file ${STATE_PATH} belongs to a different deployment (factory ${state.factory} != ${dep.factory}); set SMOKE_RESET=1 for a fresh run`);
  log(`resuming from ${STATE_PATH}`);
}
const save = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

const TOKENS = cfg.assets.map((a) => a.token);
const USDC = cfg.usdc;

// Event topics (computed, not hardcoded — one source of truth: the Solidity signatures).
const T_VAULT_CREATED = keccakOf('VaultCreated(address,address,address,uint256)');
const T_REBALANCE_EXECUTED = keccakOf('RebalanceExecuted(address,uint256)');
const T_EXIT_SETTLED = keccakOf('ExitSettled(address,uint256,uint256,uint256,uint256)');

const PROPOSAL_SIG = 'proposals(uint256)(address,uint8,address,uint64,uint64,uint64,uint64,uint64,uint8,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)';
const P_COMMIT_DEADLINE = 4, P_REVEAL_DEADLINE = 5, P_EXPIRES_AT = 7, P_STATUS = 8;
const P_REVEALED_VOTER_COUNT = 15;
const STATUS = ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Expired'];

// ────────────────────────────────── phases ──────────────────────────────────

function preflight() {
  log(`rpc=${RPC}`);
  assert(SIGNER_ARGS.length > 0, 'SMOKE_SIGNER_ARGS is required (e.g. "--account deployer --password-file .pw"); this script never handles the key itself');
  const chainId = Number(cast(['chain-id', '--rpc-url', RPC]));
  assert(chainId === cfg.chainId, `RPC chain id ${chainId} != config chainId ${cfg.chainId}`);

  if (!state.signer) {
    state.signer = cast(['wallet', 'address', ...SIGNER_ARGS], { interactive: true }).split('\n').pop().trim();
    save();
  }
  log(`signer ${state.signer}`);

  const eth = BigInt(cast(['balance', state.signer, '--rpc-url', RPC]));
  assert(eth >= 10n ** 16n, `signer needs at least 0.01 test ETH for gas (has ${eth} wei) — see docs/TESTNET-CHECKLIST.md for faucets`);
  const usdcBal = callU(USDC, 'balanceOf(address)(uint256)', state.signer);
  const need = BigInt(smoke.depositUsdc);
  if (!state.steps.deposit?.done) {
    assert(usdcBal >= need, `signer needs >= ${need} USDC units (has ${usdcBal}) — faucet.circle.com → Base Sepolia`);
  }

  // Wiring is one-shot: a second wire() MUST revert (AlreadyWired / OnlyDeployer).
  let rewired = false;
  try {
    call(dep.registry, 'wire(address,address)', '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002');
    rewired = true;
  } catch { /* expected revert */ }
  assert(!rewired, 'registry.wire() did NOT revert — deployment is not wired/locked correctly');

  // Oracle probe: real Chainlink feeds through the deployed aggregator. Testnet feeds can
  // idle past maxStaleness; the no-op lifecycle never prices a non-zero basket balance, so
  // a tripped breaker here is a WARNING, not a failure.
  for (const a of cfg.assets) {
    try {
      const p = callU(dep.aggregator, 'priceWad(address)(uint256)', a.token);
      assert(p > 10n ** 12n && p < 10n ** 26n, `${a.symbol} priceWad ${p} outside sanity range`);
      log(`oracle ${a.symbol}: priceWad = ${p} (~$${Number(p / 10n ** 12n) / 1e6})`);
    } catch (e) {
      log(`WARN oracle ${a.symbol}: priceWad reverted (${e.message.split('\n')[0]}) — feed likely stale >24h on testnet; breaker is doing its job, lifecycle continues`);
    }
  }
  log('preflight OK');
}

function stepCreateVault() {
  const params = `(${USDC},[${TOKENS.join(',')}],${dep.aggregator},${smoke.capacityCapUsdc},${smoke.minDepositUsdc},${smoke.exitFeeMaxBps},${smoke.exitFeeDecayPeriod},[${dep.adapter}])`;
  const r = send('factory.createVault', dep.factory,
    'createVault((address,address[],address,uint256,uint256,uint256,uint256,address[]))', params);
  const created = r.logs.find((l) => l.topics?.[0] === T_VAULT_CREATED);
  assert(created, 'VaultCreated event not found in receipt');
  state.vault = topicToAddress(created.topics[1]);
  assert(eq(topicToAddress(created.topics[2]), state.signer), 'creator in event != signer');
  const opId = callU(dep.registry, 'operatorOf(address)(uint256)', state.vault);
  assert(opId !== 0n, 'vault not attested in OperatorRegistry');
  log(`vault ${state.vault} created and attested (operator id ${opId})`);
  state.steps.createVault = { done: true, tx: r.transactionHash };
  save();
}

function stepRegisterGov() {
  // Idempotent resume: the register tx can land on-chain even if the run then trips a post-write
  // read (registerVault reverts AlreadyRegistered on a second call). If the vault already reads
  // registered, record it and move on rather than re-sending and reverting.
  if (call(dep.governance, 'vaultRegistered(address)(bool)', state.vault)[0] === 'true') {
    log('vault already registered on-chain - skipping registerVault (idempotent resume)');
    state.steps.registerGov = { done: true, tx: state.steps.registerGov?.tx ?? 'preexisting' };
    save();
    return;
  }
  const g = smoke.gov;
  const tuple = `(${g.commitDuration},${g.revealDuration},${g.timelockDuration},${g.executionWindow},${g.quorumBps},${g.proposalThresholdBps},${g.concentrationCapBps},${g.proposalCooldown})`;
  const r = send('governance.registerVault', dep.governance,
    'registerVault(address,(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32))', state.vault, tuple);
  readUntilEq('true', 'vault not registered', dep.governance, 'vaultRegistered(address)(bool)', state.vault);
  state.steps.registerGov = { done: true, tx: r.transactionHash };
  save();
}

function stepDeposit() {
  const amt = smoke.depositUsdc;
  send('usdc.approve', USDC, 'approve(address,uint256)', state.vault, amt);
  const r = send(`vault.deposit(${amt})`, state.vault, 'deposit(uint256)', amt);
  readUntilEq(String(amt), `pending deposit != ${amt}`, state.vault, 'pendingDeposit(address)(uint256,uint64)', state.signer);
  const [, availableAt] = call(state.vault, 'pendingDeposit(address)(uint256,uint64)', state.signer);
  state.availableAt = Number(availableAt);
  log(`deposit escrowed; observation window ends at chain time ${state.availableAt} (~4h)`);
  // EE-1: pending capital is excluded from NAV until activation.
  const nav = callU(state.vault, 'navWad()(uint256)');
  assert(nav === 0n, `navWad should exclude pending deposit, got ${nav}`);
  state.steps.deposit = { done: true, tx: r.transactionHash };
  save();
}

async function stepActivate() {
  await waitUntilChainTime(state.availableAt, 'observation window (4h)');
  const r = send('vault.activate', state.vault, 'activate(address)', state.signer);
  const shares = callU(state.vault, 'sharesOf(address)(uint256)', state.signer);
  assert(shares > 0n, 'no shares minted at activation');
  state.shares = shares.toString();
  const nav = callU(state.vault, 'navWad()(uint256)');
  assert(nav > 0n, 'navWad still zero after activation');
  log(`activated: ${shares} shares, navWad ${nav}`);
  state.steps.activate = { done: true, tx: r.transactionHash };
  save();
}

function buildPayload() {
  // No-op rebalance: the allow-listed adapter with ZERO orders. Voters approve exactly
  // these bytes (actionHash pins them); execution exercises governance → VaultCore →
  // adapter-allowlist checks without moving a token.
  state.payload = abiEncode('f(address,(address,address,uint256,uint256,uint256,bytes)[])', dep.adapter, '[]');
  state.actionHash = keccakOf(state.payload);
}

function stepPropose() {
  buildPayload();
  const r = send('governance.propose(Rebalance)', dep.governance,
    'propose(address,uint8,bytes32)', state.vault, 0, state.actionHash);
  const pid = callU(dep.governance, 'activeProposalOf(address)(uint256)', state.vault);
  assert(pid > 0n, 'no active proposal after propose');
  state.pid = pid.toString();
  const p = call(dep.governance, PROPOSAL_SIG, state.pid);
  state.commitDeadline = Number(p[P_COMMIT_DEADLINE]);
  state.revealDeadline = Number(p[P_REVEAL_DEADLINE]);
  log(`proposal ${state.pid}: commit until ${state.commitDeadline}, reveal until ${state.revealDeadline}`);
  state.steps.propose = { done: true, tx: r.transactionHash };
  save();
}

function stepCommit() {
  // Persist the salt BEFORE the commit lands — a lost salt is an unrevealable commit.
  if (!state.salt) {
    state.salt = '0x' + randomBytes(32).toString('hex');
    save();
  }
  const encoded = abiEncode('f(uint256,address,bool,bytes32)', state.pid, state.signer, 'true', state.salt);
  const commitment = keccakOf(encoded);
  const r = send('governance.commitVote', dep.governance, 'commitVote(uint256,bytes32)', state.pid, commitment);
  state.steps.commit = { done: true, tx: r.transactionHash };
  save();
}

async function stepReveal() {
  await waitUntilChainTime(state.commitDeadline, 'commit phase end (1h)');
  const r = send('governance.revealVote(FOR)', dep.governance,
    'revealVote(uint256,bool,bytes32)', state.pid, 'true', state.salt);
  state.steps.reveal = { done: true, tx: r.transactionHash };
  save();
}

async function stepFinalize() {
  await waitUntilChainTime(state.revealDeadline, 'reveal phase end (1h)');
  const r = send('governance.finalize', dep.governance, 'finalize(uint256)', state.pid);
  const p = call(dep.governance, PROPOSAL_SIG, state.pid);
  const status = STATUS[Number(p[P_STATUS])];
  assert(status === 'Passed', `proposal finalized as ${status}, expected Passed (signer-regime quorum: 1 of 1 members revealed FOR)`);
  state.expiresAt = Number(p[P_EXPIRES_AT]);
  log(`proposal Passed; executable now (timelock 0), window closes at ${state.expiresAt}`);
  state.steps.finalize = { done: true, tx: r.transactionHash };
  save();
}

function stepExecute() {
  // Mode-F sanity: between finalize and execute, exits must queue (hasPendingExecution).
  readUntilEq('true', 'hasPendingExecution should be true for a passed-but-unexecuted proposal',
    dep.governance, 'hasPendingExecution(address)(bool)', state.vault);
  const r = send('governance.execute(no-op rebalance)', dep.governance,
    'execute(uint256,bytes)', state.pid, state.payload);
  const reb = r.logs.find((l) => l.topics?.[0] === T_REBALANCE_EXECUTED && eq(l.address, state.vault));
  assert(reb, 'RebalanceExecuted event not emitted by the vault');
  readUntilEq('false', 'hasPendingExecution should clear after execution',
    dep.governance, 'hasPendingExecution(address)(bool)', state.vault);
  state.steps.execute = { done: true, tx: r.transactionHash };
  save();
}

function stepExit() {
  const before = callU(USDC, 'balanceOf(address)(uint256)', state.signer);
  const r = send('vault.requestExit(all shares, Mode I)', state.vault, 'requestExit(uint256)', state.shares);
  const settled = r.logs.find((l) => l.topics?.[0] === T_EXIT_SETTLED && eq(l.address, state.vault));
  assert(settled, 'ExitSettled event not found — exit was queued instead of instant?');
  const after = callU(USDC, 'balanceOf(address)(uint256)', state.signer);
  const sharesLeft = callU(state.vault, 'sharesOf(address)(uint256)', state.signer);
  assert(sharesLeft === 0n, `shares not fully burned: ${sharesLeft} left`);
  const returned = after - before;
  const deposited = BigInt(smoke.depositUsdc);
  // Sole holder: exit fee waived, pro-rata slice divides exactly → the round trip is exact.
  assert(returned === deposited, `USDC round trip mismatch: deposited ${deposited}, returned ${returned}`);
  log(`exit settled Mode I: ${returned} USDC units returned (exact round trip), 0 shares left`);
  state.steps.exit = { done: true, tx: r.transactionHash };
  save();
}

/** Settle a proposal a resumed run can no longer finish, and rerun the governance leg
 *  (EE-10 guarantees no lock either way). Three ways a long pause strands one:
 *
 *   (a) Passed, but the execution window lapsed  → markExpired.
 *   (b) already Expired / Defeated               → nothing to send, just redo.
 *   (c) still Active with the REVEAL window shut and nothing revealed → it can never
 *       pass, because no reveal can land any more. This case needs finalize(), which
 *       settles it Defeated: markExpired() rejects non-Passed proposals, and
 *       _refreshStatus() only auto-expires Passed ones, so propose() would otherwise
 *       revert ProposalActive() forever and the run could never move on.
 *
 * (c) is reachable whenever the runner is interrupted between commit and reveal — a
 * machine restart is enough — and was previously unhandled: the run resumed straight
 * into revealVote() against a shut window and died on WrongPhase.
 */
function recoverStrandedProposal() {
  if (!state.pid || state.steps.execute?.done) return;
  const p = call(dep.governance, PROPOSAL_SIG, state.pid);
  const status = STATUS[Number(p[P_STATUS])];
  const now = chainNow();

  const { stranded, action, reason } = classifyProposal({
    status,
    now,
    expiresAt: Number(p[P_EXPIRES_AT]),
    revealDeadline: Number(p[P_REVEAL_DEADLINE]),
    revealedVoterCount: Number(p[P_REVEALED_VOTER_COUNT]),
  });
  if (!stranded) return;

  log(`proposal ${state.pid} stranded in ${status} (${reason}) — settling it and rerunning the governance leg`);
  if (action === 'markExpired') {
    send('governance.markExpired', dep.governance, 'markExpired(uint256)', state.pid);
  } else if (action === 'finalize') {
    // finalize() with revealedVoterCount 0 fails quorum under every regime → Defeated.
    send('governance.finalize', dep.governance, 'finalize(uint256)', state.pid);
  }
  for (const s of ['propose', 'commit', 'reveal', 'finalize']) delete state.steps[s];
  delete state.pid; delete state.salt; delete state.commitDeadline; delete state.revealDeadline;
  save();
}

// ────────────────────────────────── main ──────────────────────────────────

const steps = [
  ['createVault', stepCreateVault],
  ['registerGov', stepRegisterGov],
  ['deposit', stepDeposit],
  ['activate', stepActivate],
  ['propose', stepPropose],
  ['commit', stepCommit],
  ['reveal', stepReveal],
  ['finalize', stepFinalize],
  ['execute', stepExecute],
  ['exit', stepExit],
];

log('Base Sepolia lifecycle smoke test');
log('phases: create → register → deposit → [4h window] → activate → propose → commit → [1h] → reveal → [1h] → finalize → execute(no-op) → exit');
log(`deployment: factory ${dep.factory}, governance ${dep.governance}, aggregator ${dep.aggregator}`);
preflight();
recoverStrandedProposal();

for (const [name, fn] of steps) {
  if (state.steps[name]?.done) {
    log(`✓ ${name} (already done: ${state.steps[name].tx ?? ''})`);
    continue;
  }
  await fn();
}

log('──────────────────────────────────────────────');
log('SMOKE TEST PASSED — full lifecycle green:');
for (const [name] of steps) log(`  ✓ ${name}  ${state.steps[name].tx ?? ''}`);
log(`vault: ${state.vault}  proposal: ${state.pid}`);
log(`state file ${STATE_PATH} can be deleted, or kept as the run record.`);
