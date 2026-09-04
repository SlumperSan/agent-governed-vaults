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

// REDUNDANT WITH THE TERNARY BELOW, and kept only as documentation of what "transport" means in
// practice. Trace it: if REVERTED matches, this cannot fire; if it does not, both paths already
// return 'transport'. Deleting it changes no behaviour and no test. It is labelled rather than
// removed because in a file whose whole subject is that this classification is security-relevant,
// a decorative regex reading as load-bearing logic is its own hazard.
const TRANSPORT_ERR = /429|rate.?limit|max retries exceeded|timed out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|connection|dns|502|503|504|521/i;
/** cast's wording for a contract-level revert, in both the JSON-RPC and the local-decode spellings. */
const REVERTED = /execution reverted|revert(ed)?:/i;

/**
 * Classify a failed `cast` call. ONLY a recognised revert is evidence about the contract; anything
 * else is missing evidence and must be recorded as such.
 *
 * This exists because a drill asserted `!result.ok` to prove a call was REFUSED, and `ok:false` is
 * also what a rate limit produces — so a 429 satisfied a security assertion. "It failed" and "the
 * contract refused it" are different claims, and only one of them is a finding.
 *
 * @param {string} err
 * @returns {'revert'|'transport'}
 */
export function classifyCallError(err) {
  if (TRANSPORT_ERR.test(err) && !REVERTED.test(err)) return 'transport';
  return REVERTED.test(err) ? 'revert' : 'transport';
}

/**
 * Is a paid-perception agent permanently blind, and if so what should the operator be told?
 *
 * The reference agent perceives through PAID x402 reads. Once its session spend cap is exhausted
 * it can no longer read the vault list or the leaderboard, so it reports "perception gaps" and
 * "no action warranted" on every subsequent tick — forever. No later tick can satisfy the goal.
 *
 * On 2026-09-04 drill 5 hit the cap at tick 5 of 40 and then polled a blind agent for the
 * remaining 35 ticks — 17.5 minutes — before failing with "vote:commit: not satisfied after 40
 * ticks", which names a GOVERNANCE symptom for a HARNESS BUDGET cause. That misattribution is the
 * defect; the wasted ticks are just how long it took to arrive at it.
 *
 * Pure, and in lib.mjs rather than in the drill, because the drill executes at import and so
 * anything defined there cannot be tested.
 *
 * @param {{enabled:boolean,spentUsdc:string,capUsdc:string,remainingUsdc:string,paidReads:number}|undefined} spend
 * @param {number} tick 1-based tick just completed
 * @param {number} maxTicks
 * @param {string} label
 * @returns {string|null} the failure message, or null to keep polling
 */
export function budgetExhaustedFailure(spend, tick, maxTicks, label) {
  if (!spend?.enabled) return null;

  // BLIND IS NOT THE SAME AS ZERO. The budget refuses a read when `spent + price > cap`, so an
  // agent holding $0.004 against a $0.01 read is ALREADY permanently blind while `remainingUsdc`
  // still reads positive. Testing `=== 0` would have polled that agent for the full window with
  // the misleading failure this function exists to replace; the 2026-09-04 run landed on exactly
  // zero only because its reads happened to divide the cap evenly.
  //
  // The average price paid so far is the best floor available from `summary()` — it exposes no
  // per-read price — and it is the right shape: if what remains cannot buy an average read, the
  // next perception is already refused.
  const remaining = Number(spend.remainingUsdc);
  const avgRead = spend.paidReads > 0 ? Number(spend.spentUsdc) / spend.paidReads : 0;
  if (remaining > 0 && !(avgRead > 0 && remaining < avgRead)) return null;

  const perTick = Number(spend.spentUsdc) / Math.max(tick, 1);
  return `${label}: the agent exhausted its x402 session spend cap at tick ${tick}/${maxTicks} `
    + `($${spend.spentUsdc} of $${spend.capUsdc} spent, $${spend.remainingUsdc} left, `
    + `${spend.paidReads} paid reads averaging $${avgRead.toFixed(3)}). It perceives through `
    + `paid reads, so from here it is BLIND and no further tick can satisfy the goal — this is a `
    + `HARNESS BUDGET failure, NOT evidence about governance or the contracts. The cap must cover the `
    + `whole poll window: this phase burned ~$${perTick.toFixed(3)} per tick, so ${maxTicks} ticks needs `
    + `about $${(perTick * maxTicks).toFixed(2)}. Raise it deliberately via SOAK_AGENT_CAP_USDC (it is a `
    + `spend limit on an agent that signs, so it is the operator's call, not a default to quietly `
    + `widen), or lower SOAK_MAX_TICKS.`;
}

/** Read-only call that may legitimately revert. Never throws. Carries `kind` on failure. */
export function tryCall(to, sig, ...args) {
  try {
    return { ok: true, lines: call(to, sig, ...args) };
  } catch (e) {
    const err = String(e.message).split('\n').slice(0, 2).join(' ');
    return { ok: false, err, kind: classifyCallError(err) };
  }
}

/** Static-call a state-changing function AS `from`, to prove it would succeed. No gas, no key. */
export function staticCallAs(from, to, sig, ...args) {
  try {
    return { ok: true, out: cast(['call', to, sig, ...args.map(String), '--from', from, '--rpc-url', RPC]) };
  } catch (e) {
    const err = String(e.message).split('\n').slice(0, 2).join(' ');
    return { ok: false, err, kind: classifyCallError(err) };
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

  // READ-YOUR-WRITES. The public RPC endpoints are load-balanced, so the node that answers the
  // next `cast call` is not necessarily the one that just served this receipt. Reading state
  // immediately after a send therefore fails intermittently and looks exactly like a contract
  // bug — drill 1's createVault mined, and the codesize read one second later returned 0 while
  // the same read moments afterwards returned 23016.
  //
  // Blocking here rather than at each call site means every drill gets this for free, and no
  // future assertion can forget it. Cost is a second or two per transaction against a soak
  // measured in hours.
  const mined = Number(receipt.blockNumber);
  try {
    pollUntil(
      () => Number(cast(['block-number', '--rpc-url', RPC])),
      (head) => head >= mined,
      { label: `RPC to reach block ${mined}`, attempts: 20, delayMs: 750 },
    );
  } catch (e) {
    // Not fatal on its own: the transaction is mined either way, and the per-assertion polls
    // remain as the backstop. Say so rather than failing a good run on a slow endpoint.
    log(`   WARNING: RPC did not visibly reach block ${mined} (${e.message}); subsequent reads may lag`);
  }
  return receipt;
}

export const keccakOf = (data) => cast(['keccak', data]);
export const abiEncode = (sig, ...args) => cast(['abi-encode', sig, ...args.map(String)]);
export const topicToAddress = (t) => '0x' + t.slice(26);
export const chainNow = () => Number(cast(['block', 'latest', '-f', 'timestamp', '--rpc-url', RPC]));

/**
 * Wait until chain time passes `target`, plus a safety margin.
 *
 * The margin is not padding — it is required for correctness against a load-balanced RPC.
 * `chainNow()` asks one node for the latest block's timestamp; the gas estimation inside the
 * very next `cast send` may be answered by a DIFFERENT node that is a block or two behind. So
 * returning the instant `now >= target` produces a transaction estimated against a state where
 * the deadline has not yet passed, and it reverts on a boundary the contract would otherwise
 * have accepted.
 *
 * Both drills hit this on the same run, two hours apart, against `>=` requires:
 *   drill 1 `activate`  -> WindowNotElapsed (0x8e3e8125)
 *   drill 2 `finalize`  -> WrongPhase       (0xe2586bcc)
 * In both cases the value was correct seconds later, and re-reading confirmed the chain had
 * genuinely passed the deadline. 30s is ~15 Base blocks, comfortably beyond observed divergence
 * and irrelevant against windows measured in hours.
 *
 * @param {number} target chain timestamp to pass
 * @param {string} label  human description for the log
 * @param {{marginSec?: number}} [opts]
 */
export async function waitUntilChainTime(target, label, { marginSec = 30 } = {}) {
  const effective = target + marginSec;
  for (;;) {
    const now = chainNow();
    if (now >= effective) return;
    const remain = effective - now;
    const past = now >= target ? ' (deadline passed; holding for RPC-divergence margin)' : '';
    log(`waiting for ${label}: ${Math.floor(remain / 60)}m${remain % 60}s remaining (chain ${now}, target ${target}+${marginSec}s)${past}`);
    await sleep(Math.min(60, remain) * 1000);
  }
}

/**
 * Poll a read until it satisfies `ok`, or give up.
 *
 * `cast send` returns as soon as it has a receipt, but the public RPC endpoints are
 * load-balanced and the very next `cast call` can land on a node that has not yet applied that
 * block. Reading state immediately after a send therefore fails intermittently and looks
 * exactly like a contract bug: drill 1's first successful `createVault` mined fine and the
 * codesize read one second later returned 0, while the same read seconds afterwards returned
 * 23016.
 *
 * Use this for any read whose expected value is a DIRECT consequence of a transaction just
 * sent. Do not use it to paper over a value that is genuinely wrong — it gives up and throws.
 *
 * @template T
 * @param {() => T} read
 * @param {(v: T) => boolean} ok
 * @param {{label: string, attempts?: number, delayMs?: number}} opts
 * @returns {T}
 */
export function pollUntil(read, ok, { label, attempts = 12, delayMs = 1500 }) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    try {
      last = read();
      if (ok(last)) {
        if (i > 0) log(`   ${label}: settled after ${i + 1} read(s)`);
        return last;
      }
    } catch (e) {
      last = /** @type {any} */ (`read threw: ${e.message}`);
    }
  }
  throw new Error(`${label}: still unsatisfied after ${attempts} reads over ~${Math.round(attempts * delayMs / 1000)}s (last value: ${String(last)})`);
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
/**
 * Can THIS voter still commit a vote on THIS proposal, right now?
 *
 * `activeProposalOf` IS NOT THIS QUESTION, and conflating the two cost a soak run.
 * `Governance.sol` assigns that mapping once, at `:321` inside `propose`, and **never clears it**
 * on settlement — reads at `:290`, `:518` and `:650` are the only other uses. So it keeps
 * returning the last pid the vault ever had, forever, whatever became of it.
 *
 * Drill 5 guarded its vote phase with `assert(pid > 0n)`. On 2026-09-04 that passed against
 * proposal 3, whose commit window had closed FOURTEEN HOURS earlier and which had already
 * executed. The agent then did exactly the right thing — its evaluator returned "commit window
 * closed" on every tick — and the drill failed twenty minutes later with
 * "vote:commit: not satisfied after 40 ticks", a GOVERNANCE-shaped message for a
 * NO-VOTABLE-PROPOSAL cause. The guard was not too weak; it asked the wrong question.
 *
 * Four conjuncts, and the fourth is not theoretical: proposal 3 was raised BEFORE the agent
 * activated, so the agent's snapshot weight reads zero and `commitVote` would revert `NoWeight`.
 * A predicate that checked only status and deadline would attach to it and reproduce the same
 * forty-tick stall wearing a different costume.
 *
 * Pure so it can be tested: the drill executes at import, so a predicate defined there could not be.
 *
 * @param {{status: string, ptype: number, commitDeadline: number}} p a `readProposal` result
 * @param {{now: number, snapshotWeight: bigint, wantPtype?: number}} ctx
 * @returns {{votable: boolean, reason: string}} reason is '' when votable
 */
export function votableNow(p, { now, snapshotWeight, wantPtype }) {
  if (!p) return { votable: false, reason: 'no proposal was read' };
  if (p.status !== 'Active') {
    return { votable: false, reason: `status is ${p.status}, not Active — activeProposalOf still names it because Governance never clears that mapping on settlement` };
  }
  if (now >= p.commitDeadline) {
    const ago = now - p.commitDeadline;
    return { votable: false, reason: `the commit window closed ${ago}s ago (deadline ${p.commitDeadline}, chain now ${now}) — commitVote would revert` };
  }
  if (wantPtype != null && p.ptype !== wantPtype) {
    return { votable: false, reason: `ptype is ${p.ptype}, not the expected ${wantPtype}` };
  }
  if (snapshotWeight <= 0n) {
    return { votable: false, reason: 'the voter had zero voting-eligible stake at the proposal\'s snapshot — it was raised before this account held shares, so commitVote would revert NoWeight' };
  }
  return { votable: true, reason: '' };
}

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

