// @ts-check
/**
 * Shared soak-drill runtime: cast driving, resumable state, chain-time waits.
 *
 * Factored out of `scripts/smoke-test.mjs`, which proved these patterns over a 6-hour live
 * lifecycle. Three of its hard-won properties are preserved deliberately:
 *
 *   1. KEY HANDLING. Nothing here reads, stores, or prompts for a private key. Every write is
 *      `cast send` with the flags the operator put in SOAK_SIGNER_ARGS; the key stays in
 *      Foundry's keystore or on the operator's hardware. stdin is inherited so a keystore
 *      password prompt reaches the human's terminal, never this process.
 *   2. PERSIST BEFORE YOU SEND. Sprint-9 §7.5: a commit salt written after the commit
 *      transaction is a vote that a crash can forfeit. `saveFirst()` makes that ordering
 *      explicit at the call site rather than leaving it to whoever edits the drill next.
 *   3. INDEPENDENT VERIFICATION. `send()` returns the receipt, but no drill concludes anything
 *      from it: every assertion re-reads state with `cast call`. The runner's own output is
 *      not evidence about the chain.
 *
 * Env: BASE_SEPOLIA_RPC, SOAK_SIGNER_ARGS, CAST, and per-drill state paths.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..',
);
export const RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://base-sepolia-rpc.publicnode.com';
const CAST = process.env.CAST ?? 'cast';

/** Tokenize SOAK_SIGNER_ARGS respecting double quotes (Windows paths contain spaces). */
export function tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2]);
  return out;
}
export const SIGNER_ARGS = tokenize(process.env.SOAK_SIGNER_ARGS ?? '');

export const log = (msg) => console.log(`[soak ${new Date().toISOString()}] ${msg}`);
export const fail = (msg) => { console.error(`\n[soak] FAIL: ${msg}`); process.exit(1); };
export const assert = (cond, msg) => { if (!cond) fail(msg); };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Strip cast's " [1.23e45]" scientific-notation annotation. */
export const clean = (line) => line.replace(/\s+\[[^\]]*\]$/, '').trim();

export function cast(args, { interactive = false } = {}) {
  // `interactive` exists so a keystore PASSWORD PROMPT can reach a human at a terminal. But
  // inheriting stderr also throws cast's error text away, and an unattended run
  // (--password-file, output redirected to a log file) has no human to prompt and badly needs
  // that text. So inherit only when there is actually a TTY to inherit from; otherwise pipe and
  // keep the diagnostics. Getting this wrong cost a debugging round: every failure in the first
  // unattended launch read as a bare "Command failed" with the reason discarded.
  const passThrough = interactive && Boolean(process.stdin.isTTY);
  try {
    return execFileSync(CAST, args, {
      encoding: 'utf8',
      stdio: [passThrough ? 'inherit' : 'ignore', 'pipe', passThrough ? 'inherit' : 'pipe'],
      windowsHide: true,
    }).trim();
  } catch (e) {
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw new Error(`cast ${args.slice(0, 3).join(' ')} failed: ${detail}`);
  }
}

/**
 * Cross-process mutex around transaction SUBMISSION.
 *
 * Drills run in parallel tracks, and governance serializes per VAULT — but the signer is
 * shared, and Ethereum nonces are per ACCOUNT, not per vault. Two concurrent `cast send`
 * calls each fetch the same pending nonce and one loses. That is exactly how the first
 * unattended launch failed: drill 1's `createVault` overlapped drill 2's `createChildVault`,
 * and both static-called clean afterwards because nothing was wrong with the calls.
 *
 * Locking only the send keeps the parallelism that is actually worth having. The ~14 hours of
 * this soak are `waitUntilChainTime`, not signing; serializing a handful of two-second
 * broadcasts costs nothing and lets the waiting continue to overlap.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function withSendLock(fn) {
  const lockPath = path.join(ROOT, 'data', '.soak-send.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const STALE_MS = 5 * 60_000;
  const deadline = Date.now() + 10 * 60_000;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx'); // atomic create-or-fail
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A drill that crashed mid-send must not deadlock the rest of the run.
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > STALE_MS) {
          log(`send lock is ${Math.round(age / 1000)}s old — assuming a dead holder and breaking it`);
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* holder released it between our check and now — just retry */ }
      if (Date.now() > deadline) throw new Error(`could not acquire the send lock at ${lockPath} within 10 minutes`);
      // Synchronous sleep: this whole library is sync because execFileSync is.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/** Read-only call, returns decoded output lines. */
export function call(to, sig, ...args) {
  return cast(['call', to, sig, ...args.map(String), '--rpc-url', RPC]).split('\n').map(clean);
}
export const callU = (to, sig, ...args) => BigInt(call(to, sig, ...args)[0]);

/** Read-only call that may legitimately revert. Never throws. */
export function tryCall(to, sig, ...args) {
  try {
    return { ok: true, lines: call(to, sig, ...args) };
  } catch (e) {
    return { ok: false, err: String(e.message).split('\n').slice(0, 2).join(' ') };
  }
}

/** Static-call a state-changing function AS `from`, to prove it would succeed. No gas, no key. */
export function staticCallAs(from, to, sig, ...args) {
  try {
    return { ok: true, out: cast(['call', to, sig, ...args.map(String), '--from', from, '--rpc-url', RPC]) };
  } catch (e) {
    return { ok: false, err: String(e.message).split('\n').slice(0, 2).join(' ') };
  }
}

/** State-changing call via the HUMAN's signer. Asserts success, returns the receipt. */
export function send(label, to, sig, ...args) {
  assert(SIGNER_ARGS.length > 0,
    'SOAK_SIGNER_ARGS is required (e.g. "--account deployer --password-file .pw"); this script never handles the key itself');
  log(`tx: ${label}`);
  // Serialized across drills — see withSendLock. The nonce is per account, not per vault.
  const out = withSendLock(() => cast(
    ['send', to, sig, ...args.map(String), '--rpc-url', RPC, '--json', ...SIGNER_ARGS],
    { interactive: true },
  ));
  const receipt = JSON.parse(out.slice(out.indexOf('{')));
  assert(receipt.status === '0x1' || receipt.status === 1,
    `${label}: transaction reverted (${receipt.transactionHash})`);
  log(`   mined ${receipt.transactionHash} (block ${Number(receipt.blockNumber)})`);
  return receipt;
}

export const keccakOf = (data) => cast(['keccak', data]);
export const abiEncode = (sig, ...args) => cast(['abi-encode', sig, ...args.map(String)]);
export const topicToAddress = (t) => '0x' + t.slice(26);
export const chainNow = () => Number(cast(['block', 'latest', '-f', 'timestamp', '--rpc-url', RPC]));

export async function waitUntilChainTime(target, label) {
  for (;;) {
    const now = chainNow();
    if (now >= target) return;
    const remain = target - now;
    log(`waiting for ${label}: ${Math.floor(remain / 60)}m${remain % 60}s remaining (chain ${now}, target ${target})`);
    await sleep(Math.min(60, remain) * 1000);
  }
}

/**
 * Resumable per-drill state. Each drill owns its own file so drills can be stopped, resumed and
 * interleaved independently: governance serializes per VAULT, not per runner, so two drills on
 * two different vaults genuinely do run concurrently and must not share a state file.
 * @param {string} statePath
 * @param {string} factory binds the state to a deployment; a redeploy must not silently resume
 */
export function openState(statePath, factory) {
  let state = { factory, steps: {} };
  if (fs.existsSync(statePath) && process.env.SOAK_RESET !== '1') {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert(eq(state.factory, factory),
      `state file ${statePath} belongs to a different deployment (${state.factory} != ${factory}); set SOAK_RESET=1 for a fresh run`);
    log(`resuming from ${statePath}`);
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  /**
   * Record a value and FLUSH IT TO DISK before the caller sends anything that depends on it.
   * The Sprint-9 §7.5 lesson in one call: a salt persisted after its commit is forfeitable.
   */
  const saveFirst = (key, value) => { state[key] = value; save(); return value; };
  return { state, save, saveFirst };
}

/** Run a step list, skipping completed ones. */
export async function runSteps(steps, state, save) {
  for (const [name, fn] of steps) {
    if (state.steps[name]?.done) {
      log(`[done] ${name} (${state.steps[name].tx ?? 'no tx'})`);
      continue;
    }
    await fn();
    save();
  }
}

/** Governance proposal decoding, one source of truth for every drill. */
export const PROPOSAL_SIG =
  'proposals(uint256)(address,uint8,address,uint64,uint64,uint64,uint64,uint64,uint8,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)';
export const P = {
  VAULT: 0, PTYPE: 1, PROPOSER: 2, CREATED_AT: 3, COMMIT_DEADLINE: 4, REVEAL_DEADLINE: 5,
  EXECUTABLE_AT: 6, EXPIRES_AT: 7, STATUS: 8, ACTION_HASH: 9, SNAPSHOT_TOTAL: 10,
  MEMBER_COUNT: 11, FOR_WEIGHT: 12, AGAINST_WEIGHT: 13, REVEALED_WEIGHT: 14,
  REVEALED_VOTER_COUNT: 15,
};
export const STATUS = ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Expired'];
export const PTYPE = { Rebalance: 0, RuleChange: 1, ChildAllocation: 2 };

/** Read a proposal into a named object. */
export function readProposal(governance, pid) {
  const p = call(governance, PROPOSAL_SIG, pid);
  return {
    raw: p,
    vault: p[P.VAULT], ptype: Number(p[P.PTYPE]), proposer: p[P.PROPOSER],
    createdAt: Number(p[P.CREATED_AT]),
    commitDeadline: Number(p[P.COMMIT_DEADLINE]), revealDeadline: Number(p[P.REVEAL_DEADLINE]),
    executableAt: Number(p[P.EXECUTABLE_AT]), expiresAt: Number(p[P.EXPIRES_AT]),
    status: STATUS[Number(p[P.STATUS])], actionHash: p[P.ACTION_HASH],
    snapshotTotal: BigInt(p[P.SNAPSHOT_TOTAL]), memberCount: Number(p[P.MEMBER_COUNT]),
    forWeight: BigInt(p[P.FOR_WEIGHT]), againstWeight: BigInt(p[P.AGAINST_WEIGHT]),
    revealedWeight: BigInt(p[P.REVEALED_WEIGHT]),
    revealedVoterCount: Number(p[P.REVEALED_VOTER_COUNT]),
  };
}

/** Event topics, computed from the Solidity signatures rather than hardcoded. */
export const TOPIC = {
  VaultCreated: () => keccakOf('VaultCreated(address,address,address,uint256)'),
  ChildRegistered: () => keccakOf('ChildRegistered(address,address,uint256)'),
  RebalanceExecuted: () => keccakOf('RebalanceExecuted(address,uint256)'),
  ExitSettled: () => keccakOf('ExitSettled(address,uint256,uint256,uint256,uint256)'),
  ExitQueued: () => keccakOf('ExitQueued(address,uint256)'),
  ChildAllocated: () => keccakOf('ChildAllocated(address,uint256)'),
  ChildRedeemed: () => keccakOf('ChildRedeemed(address,uint256,uint256)'),
  DepositPending: () => keccakOf('DepositPending(address,uint256,uint64)'),
  DepositActivated: () => keccakOf('DepositActivated(address,uint256,uint256)'),
};
