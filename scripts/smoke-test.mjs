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
 *   BASE_SEPOLIA_RPC   RPC url            (default: https://sepolia.base.org -- publicnode
 *                                          prunes logs and receipts, see .env.example)
 *   SMOKE_SIGNER_ARGS  cast signer flags  (required; e.g. "--account deployer --password-file .pw")
 *   DEPLOY_JSON        forge broadcast output
 *                      (default: contracts/broadcast/DeployTestnet.s.sol/84532/run-latest.json)
 *   SMOKE_CONFIG       chain config       (default: contracts/config/base-sepolia.json)
 *   SMOKE_DEPLOYMENT   deployment record  (default: contracts/config/deployments/base-sepolia.json)
 *                      -- a DIFFERENT file from SMOKE_CONFIG; it declares intendedCreator
 *   SMOKE_STATE        state file         (default: scripts/.smoke-state.json)
 *   SMOKE_RESET=1      discard prior state and start a fresh lifecycle
 *   CAST               cast binary        (default: "cast" on PATH)
 *   SMOKE_SAFE_OWNER_SIGNERS  ';'-separated cast signer flags, one set per Safe owner who will sign
 *                      the routed createVault execTransaction (required, and ONLY consulted, when
 *                      the deployment record's intendedCreatorKind is "contract" — see
 *                      stepCreateVaultRouted). e.g.
 *                      "--account owner1 --password-file .pw1;--account owner2 --password-file .pw2"
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROPOSAL_SIG, decodeProposal } from './lib/proposal-decode.mjs';
import { classifyProposal } from './proposal-recovery.mjs';
import {
  wiringImmutabilityFailure, oracleProbeWarning, normAddr,
  requireIntendedCreator, requireCreatorCode, loadDeploymentRecord, signerCacheRefusal,
  CREATE_VAULT_SIG, REGISTER_VAULT_SIG,
} from './smoke-preflight.mjs';
import {
  readSafeState, buildPlan, safeTransactionHash, signAsOwner, packSignatures, execTransactionArgs,
  SAFE_EXEC_TRANSACTION_SIG,
} from './lib/safe-exec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// NOT publicnode: it prunes logs and receipts, and this script decodes phase results FROM
// RECEIPTS. See the note in `.env.example` for the measurement.
const RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const CAST = process.env.CAST ?? 'cast';
const DEPLOY_JSON = process.env.DEPLOY_JSON
  ?? path.join(ROOT, 'contracts', 'broadcast', 'DeployTestnet.s.sol', '84532', 'run-latest.json');
const CONFIG_PATH = process.env.SMOKE_CONFIG ?? path.join(ROOT, 'contracts', 'config', 'base-sepolia.json');
// The DEPLOYMENT RECORD, which is not `SMOKE_CONFIG`: the chain config carries launch parameters,
// the record carries what was deployed and WHO MAY CREATE A VAULT (`intendedCreator`). r1 of this
// check read `dep.intendedCreator` off the forge broadcast artifact, which has no such key, so the
// verdict refused every input - failing closed, but a guard that refuses everything is an outage
// diagnosed on deploy night by someone under time pressure who will be tempted to delete it.
const DEPLOYMENT_PATH = process.env.SMOKE_DEPLOYMENT
  ?? path.join(ROOT, 'contracts', 'config', 'deployments', 'base-sepolia.json');
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
    // `detail` rides on the error so a catch site can classify cast's own words (revert vs
    // transport, packages/canary/src/call-error.mjs) without the prefix below in front of them.
    throw Object.assign(new Error(`cast ${args.slice(0, 3).join(' ')} … failed: ${detail}`), { detail });
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

/** Run a read whose EXPECTED outcome may be a revert, and return the failure as data for a verdict
 * function (smoke-preflight.mjs) instead of swallowing it. `error` is cast's own stderr (`detail`,
 * set in `cast()`), which is what `classifyCallError` is measured against. */
function attempt(fn) {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, error: String(e.detail ?? e.message) }; }
}

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
// The SAME normaliser `intendedCreatorRefusal` uses. Not a second lowercase: when the verdict
// trimmed and this did not, a padded declaration passed the refusal and failed after broadcasting.
const eq = (a, b) => normAddr(a) === normAddr(b) && normAddr(a) !== '';

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
const deployment = loadDeploymentRecord({
  deploymentPath: DEPLOYMENT_PATH, configPath: CONFIG_PATH, readFileSync: fs.readFileSync, existsSync: fs.existsSync,
});
const smoke = cfg.smoke;

/**
 * The deployment record. The reading, the refusal on absence and the chain cross-check all live in
 * `smoke-preflight.loadDeploymentRecord`, where a test CALLS them -- `gate.mjs` only `node --check`s
 * this file, so anything asserted here can only ever be asserted by a regex over its source, and a
 * regex cannot see whether a check does anything. Round 2 proved that: the chain cross-check was
 * disarmable with `true ||` and the existsSync ban was evadable by respelling it, both with 17/17
 * green. Only the wiring stays here.
 */

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
// Safe's own outcome events (GnosisSafe.sol / SafeL2.sol) — card 208. execTransaction CATCHES an
// inner-call revert and emits ExecutionFailure rather than reverting the OUTER transaction, so
// `receipt.status === 0x1` alone does not mean createVault succeeded: a plan with safeTxGas == 0
// and gasPrice == 0 (enforced pre-broadcast by requireIntendedCreator/safeRoutingPlanRefusal,
// scripts/smoke-preflight.mjs) makes that catch reachable on any revert. stepCreateVaultRouted
// treats ExecutionFailure exactly like a reverted receipt: the run stops.
const T_EXEC_SUCCESS = keccakOf('ExecutionSuccess(bytes32,uint256)');
const T_EXEC_FAILURE = keccakOf('ExecutionFailure(bytes32,uint256)');

// PROPOSAL_SIG, the tuple index map and the Status enum now live in ./lib/proposal-decode.mjs,
// which is pure and therefore reachable by scripts/test/proposal-decode.test.mjs. This file
// executes its whole lifecycle at import, so while the decode lived here no test could run it
// (issue #196).

// ────────────────────────────────── phases ──────────────────────────────────

function preflight() {
  log(`rpc=${RPC}`);
  assert(SIGNER_ARGS.length > 0, 'SMOKE_SIGNER_ARGS is required (e.g. "--account deployer --password-file .pw"); this script never handles the key itself');
  const chainId = Number(cast(['chain-id', '--rpc-url', RPC]));
  assert(chainId === cfg.chainId, `RPC chain id ${chainId} != config chainId ${cfg.chainId}`);

  // DERIVED EVERY RUN, never read back from the state file. `send()` broadcasts with the live
  // SMOKE_SIGNER_ARGS, so a cached signer means the creation guard validates a string while a
  // different key is on the wire -- see signerCacheRefusal for the reproduction. The cost is that
  // `cast wallet address` may prompt for a password on a resumed run; validating a stale signer is
  // not an acceptable price for skipping that prompt.
  const derivedSigner = cast(['wallet', 'address', ...SIGNER_ARGS], { interactive: true }).split('\n').pop().trim();
  const signerRefusal = signerCacheRefusal(derivedSigner, state.signer);
  assert(!signerRefusal, signerRefusal);
  state.signer = derivedSigner;
  save();
  log(`signer ${state.signer} (derived this run from SMOKE_SIGNER_ARGS)`);

  const eth = BigInt(cast(['balance', state.signer, '--rpc-url', RPC]));
  assert(eth >= 10n ** 16n, `signer needs at least 0.01 test ETH for gas (has ${eth} wei) — see docs/TESTNET-CHECKLIST.md for faucets`);
  const usdcBal = callU(USDC, 'balanceOf(address)(uint256)', state.signer);
  const need = BigInt(smoke.depositUsdc);
  if (!state.steps.deposit?.done) {
    assert(usdcBal >= need, `signer needs >= ${need} USDC units (has ${usdcBal}) — faucet.circle.com → Base Sepolia`);
  }

  // Wiring is one-shot: a second wire() MUST revert (AlreadyWired / OnlyDeployer), and only a
  // CONFIRMED revert proves it. This was a bare catch commented "expected revert", which read a
  // 429, a timeout or a DNS miss as that revert and PASSED the assertion having tested nothing —
  // a false PASS on a security check, the quiet direction. smoke-preflight.mjs holds the three
  // outcomes; a call that reaches no verdict now FAILS the run.
  const wiring = wiringImmutabilityFailure(attempt(() =>
    call(dep.registry, 'wire(address,address)', '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002')));
  assert(wiring === null, wiring);

  // Oracle probe: real Chainlink feeds through the deployed aggregator. Testnet feeds can idle
  // past their heartbeat; the no-op lifecycle never prices a non-zero basket balance, so a
  // tripped breaker here is a WARNING, not a failure. A read that reached no verdict is a
  // different warning, and is no longer worded as a stale feed (smoke-preflight.mjs).
  for (const a of cfg.assets) {
    const r = attempt(() => callU(dep.aggregator, 'priceWad(address)(uint256)', a.token));
    if (!r.ok) { log(oracleProbeWarning(a.symbol, r.error).message); continue; }
    const p = r.value;
    assert(p > 10n ** 12n && p < 10n ** 26n, `${a.symbol} priceWad ${p} outside sanity range`);
    log(`oracle ${a.symbol}: priceWad = ${p} (~$${Number(p / 10n ** 12n) / 1e6})`);
  }
  log('preflight OK');
}

/**
 * WHO CREATES THE VAULT IS PERMANENT, SO IT IS CHECKED BEFORE THE TRANSACTION, NOT AFTER.
 *
 * `VaultCore.createVault` fixes `msg.sender` as the vault's immutable creator and attested operator.
 * No later transaction can correct it. On chain 4663 both vaults were created by the deployer EOA
 * while the deployment record named the creator Safe, and **nothing compared the two** - the
 * divergence surfaced when a human read the record months later, and the remedy was a new vault.
 *
 * The check this replaces compared the creator in the emitted event against the signer that had just
 * signed - true by construction, and it would have passed on 4663 every time. Its text is not quoted
 * here: `smoke-preflight.test.mjs` bans that string from this file so the old check cannot come back,
 * and a comment reproducing it to explain it would trip the same guard. This compares both against a
 * DECLARED intent, and refuses BEFORE broadcasting rather than reporting afterwards - because
 * afterwards there is nothing to do about it.
 *
 * A CONTRACT-KIND CREATOR NO LONGER DEAD-ENDS HERE (card 208). `requireIntendedCreator` with no
 * `routing` argument still refuses a contract-kind declaration unconditionally under direct send —
 * that refusal is UNCHANGED. What changed is that direct send is no longer the only path: a
 * contract-kind record now routes to `stepCreateVaultRouted`, which builds a Safe `execTransaction`
 * whose inner call IS `createVault`, so `msg.sender` inside it really is the declared Safe.
 */
function stepCreateVault() {
  // DOES THE DECLARED CREATOR ACTUALLY EXIST, as the kind of account the record declares? Checked
  // FIRST, before who-may-act-for-it, because an address with no code at all is a different, more
  // basic finding than a routing gap — a Safe's address is deterministic and knowable before
  // deployment, so a predicted-but-unactivated Safe would otherwise be reported as an authorisation
  // problem it is not. `creator` is immutable with no rotation path.
  //
  // The chain id is read from the SAME connection as the code, and passed in, because a code read is
  // only an answer about the chain it was taken on and this path routinely holds two chains at once.
  // Enforcement is inside `requireCreatorCode`, in smoke-preflight.mjs, where a test can call it.
  // Applies identically to BOTH branches below — an unactivated or misdeclared creator is refused
  // before either a direct send or a routed one is attempted.
  requireCreatorCode({
    address: deployment.intendedCreator,
    code: cast(['code', deployment.intendedCreator, '--rpc-url', RPC]),
    observedChainId: cast(['chain-id', '--rpc-url', RPC]),
    declaredChainId: deployment.chainId,
    kind: deployment.intendedCreatorKind,
  });

  const kind = typeof deployment.intendedCreatorKind === 'string'
    ? deployment.intendedCreatorKind.trim().toLowerCase() : undefined;
  if (kind === 'contract') {
    stepCreateVaultRouted();
    return;
  }

  // THROWS on a missing record, a missing or wrong declaration, an unknown signer, or a contract-kind
  // declaration this script cannot route a transaction through (see requireIntendedCreator's own doc
  // for why a contract-kind creator refuses unconditionally rather than being compared to the
  // signer). There is no `assert` here to replace with a log line: the enforcement is inside the
  // function, which is the whole point of it living in smoke-preflight.mjs where a test can call it.
  const intendedCreator = requireIntendedCreator(deployment, state.signer);
  const params = `(${USDC},[${TOKENS.join(',')}],${dep.aggregator},${smoke.capacityCapUsdc},${smoke.minDepositUsdc},${smoke.exitFeeMaxBps},${smoke.exitFeeDecayPeriod},[${dep.adapter}])`;
  const r = send('factory.createVault', dep.factory,
    'createVault((address,address[],address,uint256,uint256,uint256,uint256,address[]))', params);
  const created = r.logs.find((l) => l.topics?.[0] === T_VAULT_CREATED);
  assert(created, 'VaultCreated event not found in receipt');
  state.vault = topicToAddress(created.topics[1]);
  // Against the DECLARED address, not against the signer. The event and the signer agree by
  // construction, so comparing them proves nothing about whether the right party created it.
  assert(
    eq(topicToAddress(created.topics[2]), intendedCreator),
    `creator in event is ${topicToAddress(created.topics[2])}, declared intendedCreator is ${intendedCreator}`,
  );
  // And re-read it from the vault itself rather than trusting the log: the event is emitted by the
  // factory, `creator()` is the value the protocol will act on for the life of the vault.
  const onChainCreator = call(state.vault, 'creator()(address)')[0];
  assert(
    eq(onChainCreator, intendedCreator),
    `the vault's own creator() reads ${onChainCreator}, declared intendedCreator is ${intendedCreator}`,
  );
  const opId = callU(dep.registry, 'operatorOf(address)(uint256)', state.vault);
  assert(opId !== 0n, 'vault not attested in OperatorRegistry');
  log(`vault ${state.vault} created and attested (operator id ${opId})`);
  state.steps.createVault = { done: true, tx: r.transactionHash };
  save();
}

/**
 * Shared machinery for routing ONE named action (`createVault` or `registerVault`, see
 * `ROUTED_ACTIONS` in scripts/smoke-preflight.mjs) through the declared contract-kind creator Safe.
 * Collects `SMOKE_SAFE_OWNER_SIGNERS` (the SAME env var for both actions — it is the same Safe,
 * generally the same owners, for both), checks them against the Safe's own live `getOwners()`/
 * `getThreshold()` BEFORE building anything, builds and checks the plan (THROWS via
 * `requireIntendedCreator`'s routing argument before a single signature is collected), signs, sends,
 * and confirms `ExecutionSuccess` rather than trusting `receipt.status` alone (see the
 * `T_EXEC_SUCCESS`/`T_EXEC_FAILURE` comment above `stepCreateVaultRouted`'s original doc for why).
 * Returns the receipt; callers assert their own action-specific post-conditions.
 *
 * @param {object} p
 * @param {keyof typeof import('./smoke-preflight.mjs').ROUTED_ACTIONS} p.action
 * @param {string} p.expectedTo the singleton this action must target
 * @param {string} p.sig the action's full function signature, for `cast calldata`
 * @param {string[]} p.params `sig`'s arguments, ONE ARRAY ELEMENT PER PARAMETER — `cast calldata`
 *   takes each argument separately; `registerVault(address,(tuple))` needs two elements
 *   (`[vault, tuple]`), `createVault((tuple))` needs one (`[tuple]`). Passing the whole thing as a
 *   single joined string is exactly the bug this shape exists to prevent (found by this file's own
 *   end-to-end fork test: `cast calldata` reported "encode length mismatch: expected 2 types, got 1").
 * @param {string} p.label a short label for the `send()` log line
 */
function routeThroughSafe({ action, expectedTo, sig, params, label }) {
  const safe = deployment.intendedCreator;
  const raw = process.env.SMOKE_SAFE_OWNER_SIGNERS ?? '';
  assert(raw.trim().length > 0,
    `SMOKE_SAFE_OWNER_SIGNERS is required to route ${action} through a contract-kind creator `
      + '(e.g. "--account owner1 --password-file .pw1;--account owner2 --password-file .pw2") — '
      + 'one \';\'-separated set of cast signer flags per Safe owner who will sign.');
  const ownerSignerSets = raw.split(';').map((s) => tokenize(s.trim())).filter((a) => a.length > 0);
  assert(ownerSignerSets.length > 0, 'SMOKE_SAFE_OWNER_SIGNERS parsed to zero usable signer sets');

  // DERIVED EVERY RUN, same discipline as SIGNER_ARGS above — never cached, never assumed.
  const signers = ownerSignerSets.map((args) => ({
    args,
    address: cast(['wallet', 'address', ...args], { interactive: true }).split('\n').pop().trim(),
  }));
  const distinct = new Set(signers.map((s) => normAddr(s.address)));
  assert(distinct.size === signers.length,
    'SMOKE_SAFE_OWNER_SIGNERS derives the same signer address more than once — one set of flags per owner');

  const { threshold, owners, nonce } = readSafeState({ call, callU, safe });
  assert(threshold > 0n, `Safe ${safe} reports getThreshold() 0 — not a usable Safe`);
  assert(owners.length > 0, `Safe ${safe} reports getOwners() empty — not a usable Safe`);
  log(`Safe ${safe}: threshold ${threshold}/${owners.length} owners, nonce ${nonce} (routing ${action})`);

  const ownerSet = new Set(owners.map(normAddr));
  for (const s of signers) {
    assert(ownerSet.has(normAddr(s.address)),
      `signer ${s.address} (from SMOKE_SAFE_OWNER_SIGNERS) is not among Safe ${safe}'s own `
        + `getOwners() [${owners.join(', ')}] — refusing before collecting a signature that the `
        + 'Safe would reject anyway, rather than finding out after broadcasting.');
  }
  assert(BigInt(signers.length) >= threshold,
    `Safe ${safe} requires ${threshold} signature(s) but SMOKE_SAFE_OWNER_SIGNERS supplies only `
      + `${signers.length} — gather enough owner signer sets before running this.`);

  const data = cast(['calldata', sig, ...params]);
  const plan = buildPlan({ safe, to: expectedTo, data, nonce });

  // THROWS unless this PLAN routes through the declared Safe, at `expectedTo`, calling `action`, as
  // a plain CALL with zero value/safeTxGas/baseGas/gasPrice — checked BEFORE a single signature is
  // collected (scripts/smoke-preflight.mjs's safeRoutingPlanRefusal).
  requireIntendedCreator(deployment, state.signer, {
    safe: plan.safe, to: plan.to, action, expectedTo, data: plan.data, operation: plan.operation,
    value: plan.value, safeTxGas: plan.safeTxGas, baseGas: plan.baseGas, gasPrice: plan.gasPrice,
  });

  const hash = safeTransactionHash({ call, plan });
  log(`safeTxHash ${hash} (nonce ${nonce}) — collecting ${threshold} of ${signers.length} supplied signature(s)`);
  const toSign = signers.slice(0, Number(threshold));
  const sigs = toSign.map(({ args }) => signAsOwner({ cast, hash, signerArgs: args }));
  const packed = packSignatures(sigs);

  const r = send(label, safe, SAFE_EXEC_TRANSACTION_SIG, ...execTransactionArgs(plan, packed));

  // `send()` already asserted receipt.status === 0x1, but execTransaction CATCHES an inner-call
  // revert internally and emits ExecutionFailure rather than reverting the outer transaction — see
  // the T_EXEC_SUCCESS/T_EXEC_FAILURE comment above. A plan with safeTxGas == 0 && gasPrice == 0
  // (enforced above) makes that catch reachable on any genuine revert, so this is not a redundant
  // check: without it, a failed call inside a successful outer transaction would read as a pass.
  const execSuccess = r.logs.find((l) => l.topics?.[0] === T_EXEC_SUCCESS && eq(l.address, safe));
  const execFailure = r.logs.find((l) => l.topics?.[0] === T_EXEC_FAILURE && eq(l.address, safe));
  assert(!execFailure, `Safe ${safe} reported ExecutionFailure for this execTransaction (tx ${r.transactionHash}) — the outer transaction succeeded but the inner ${action} call reverted`);
  assert(execSuccess, `Safe ${safe} emitted neither ExecutionSuccess nor ExecutionFailure for this execTransaction (tx ${r.transactionHash}) — cannot confirm the inner call ran`);
  return r;
}

/**
 * CARD 208 — THE ROUTED-SEND PATH `contractCreatorRoutingRefusal` NAMES AS MISSING. Reached only
 * from `stepCreateVault` when `deployment.intendedCreatorKind` is "contract"; direct send still
 * refuses that kind unconditionally (`requireIntendedCreator(deployment, state.signer)`, no third
 * argument, immediately above) — this function does not touch that branch or weaken it.
 *
 * Builds a Safe `execTransaction` whose inner call IS `createVault`, so `msg.sender` inside
 * `VaultFactory.createVault` really is the declared Safe — not the EOA that happens to sign. Every
 * fact about the Safe (threshold, owners, nonce, the exact hash it will accept a signature over) is
 * READ FROM THE SAFE ITSELF via scripts/lib/safe-exec.mjs; nothing here is specific to the Arc
 * mainnet Safe (`0x99e8…`) or to 1-of-1 — a second Safe, or the same Safe after the owner raises its
 * threshold, is handled identically because every comparison below is against what the chain and
 * the deployment record say, never a literal address.
 */
function stepCreateVaultRouted() {
  const safe = deployment.intendedCreator;
  const params = `(${USDC},[${TOKENS.join(',')}],${dep.aggregator},${smoke.capacityCapUsdc},${smoke.minDepositUsdc},${smoke.exitFeeMaxBps},${smoke.exitFeeDecayPeriod},[${dep.adapter}])`;
  const r = routeThroughSafe({
    action: 'createVault', expectedTo: dep.factory, sig: CREATE_VAULT_SIG, params: [params],
    label: 'safe.execTransaction(createVault)',
  });

  // The emitter, not only the topic — `smoke-test.mjs`'s direct-send path does not check this
  // (a pre-existing gap out of scope here), but a routed plan can be misdirected at a WRONG
  // deployed factory that emits an identically-shaped VaultCreated of its own; only checking the
  // topic would credit that as this deployment's vault.
  const created = r.logs.find((l) => l.topics?.[0] === T_VAULT_CREATED && eq(l.address, dep.factory));
  assert(created, `VaultCreated event from the declared factory ${dep.factory} not found in receipt`);
  state.vault = topicToAddress(created.topics[1]);
  assert(
    eq(topicToAddress(created.topics[2]), safe),
    `creator in event is ${topicToAddress(created.topics[2])}, declared intendedCreator (Safe) is ${safe}`,
  );
  const onChainCreator = call(state.vault, 'creator()(address)')[0];
  assert(
    eq(onChainCreator, safe),
    `the vault's own creator() reads ${onChainCreator}, declared intendedCreator (Safe) is ${safe}`,
  );
  const opId = callU(dep.registry, 'operatorOf(address)(uint256)', state.vault);
  assert(opId !== 0n, 'vault not attested in OperatorRegistry');
  log(`vault ${state.vault} created via Safe ${safe} and attested (operator id ${opId})`);
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

  const kind = typeof deployment.intendedCreatorKind === 'string'
    ? deployment.intendedCreatorKind.trim().toLowerCase() : undefined;
  if (kind === 'contract') {
    stepRegisterGovRouted();
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

/**
 * `Governance.registerVault` (Governance.sol:223) gates on `msg.sender == vault.creator()` — the
 * SAME immutable-creator shape `createVault` itself is gated by, one call later. Once the creator is
 * a Safe, `registerVault` sent directly from an EOA reverts `NotVaultCreator()` exactly the way a
 * direct `createVault` would have refused before card 208: a vault the Safe created but nothing can
 * register is created-but-stuck (`creator` is immutable, and `Governance.propose` itself requires
 * `vaultRegistered[vault]`, so an unregistered vault is not governable either — there is no
 * side door). This routes the SAME way `stepCreateVaultRouted` does, through the SAME machinery,
 * reusing `safeRoutingPlanRefusal`'s `registerVault` action rather than a second plan-checker.
 */
function stepRegisterGovRouted() {
  const safe = deployment.intendedCreator;
  const g = smoke.gov;
  const tuple = `(${g.commitDuration},${g.revealDuration},${g.timelockDuration},${g.executionWindow},${g.quorumBps},${g.proposalThresholdBps},${g.concentrationCapBps},${g.proposalCooldown})`;
  const r = routeThroughSafe({
    action: 'registerVault', expectedTo: dep.governance, sig: REGISTER_VAULT_SIG, params: [state.vault, tuple],
    label: 'safe.execTransaction(registerVault)',
  });

  // Post-check against the DECLARATION, the same discipline as createVault's: read the two fields
  // Governance.sol actually sets (vaultRegistered[vault], configOf[vault]) rather than trusting the
  // outer transaction's success alone.
  readUntilEq('true', 'vault not registered', dep.governance, 'vaultRegistered(address)(bool)', state.vault);
  const cfg = call(dep.governance, 'configOf(address)(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32)', state.vault);
  const declared = [g.commitDuration, g.revealDuration, g.timelockDuration, g.executionWindow, g.quorumBps, g.proposalThresholdBps, g.concentrationCapBps, g.proposalCooldown].map(String);
  assert(
    cfg.every((v, i) => v === declared[i]),
    `configOf(${state.vault}) reads [${cfg.join(', ')}] but the declared gov config is [${declared.join(', ')}] — the Safe registered a different config than the one intended`,
  );
  log(`vault ${state.vault} registered via Safe ${safe}, config confirmed on-chain`);
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
  const p = decodeProposal(call(dep.governance, PROPOSAL_SIG, state.pid));
  state.commitDeadline = p.commitDeadline;
  state.revealDeadline = p.revealDeadline;
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
  const p = decodeProposal(call(dep.governance, PROPOSAL_SIG, state.pid));
  const status = p.status;
  assert(status === 'Passed', `proposal finalized as ${status}, expected Passed (signer-regime quorum: 1 of 1 members revealed FOR)`);
  state.expiresAt = p.expiresAt;
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
  const p = decodeProposal(call(dep.governance, PROPOSAL_SIG, state.pid));
  const status = p.status;
  const now = chainNow();

  const { stranded, action, reason } = classifyProposal({
    status,
    now,
    expiresAt: p.expiresAt,
    revealDeadline: p.revealDeadline,
    revealedVoterCount: p.revealedVoterCount,
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
