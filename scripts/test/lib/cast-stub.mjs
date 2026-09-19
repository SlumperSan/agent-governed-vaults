// @ts-check
/**
 * A scripted `cast` — the fake chain that lets scripts/smoke-test.mjs be EXECUTED by a test.
 *
 * WHY THIS EXISTS. `gate.mjs` only `node --check`s `scripts/smoke-test.mjs`, because running it has
 * always needed a signer, an RPC and a funded account. So every assertion about that file was a
 * regex over its source, and a regex can see that a call exists and where it sits but never that it
 * DOES anything: four review rounds on PR #329 each found a mutation that kept the suite green —
 * the enforcement replaced with a log line, a helper that swallowed the refusal, the loader fed the
 * wrong path, `eq` replaced with `() => true`. This module answers every `cast` invocation from a
 * table instead, so the runner executes end to end with no chain and no key, and those mutations
 * become ordinary red tests.
 *
 * TWO PROPERTIES IT IS BUILT AROUND.
 *
 *   1. EVERY INVOCATION IS RECORDED, appended to `SMOKE_STUB_LOG` as JSONL one line at a time. The
 *      runner calls `process.exit(1)` on a refusal, so anything buffered in memory is lost exactly
 *      on the path that matters most. "Was a transaction broadcast" is then a fact read off disk —
 *      the absence of a `cast send` line — rather than an inference from stdout.
 *   2. IT NEVER SILENTLY ANSWERS A CALL IT DOES NOT KNOW. An unknown subcommand or signature
 *      throws a stub error naming itself, so a runner change that reads something new fails loudly
 *      instead of being handed a plausible-looking default.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: no real keccak, no real ABI encoding. `smoke-test.mjs` uses
 * both only for identity — it compares topics it computed through the same `cast keccak` against
 * topics in receipts this stub built — so a deterministic digest is indistinguishable from the real
 * one for every comparison the runner makes, and the contracts' event signatures are pinned
 * elsewhere (scripts/test/chain-binding.test.mjs).
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const LOG = process.env.SMOKE_STUB_LOG;
const SCENARIO_PATH = process.env.SMOKE_STUB_SCENARIO;
if (!LOG) throw new Error('cast-stub: SMOKE_STUB_LOG is required (the invocation record IS the evidence)');
if (!SCENARIO_PATH) throw new Error('cast-stub: SMOKE_STUB_SCENARIO is required');

/** @type {Record<string, any>} */
const sc = JSON.parse(readFileSync(SCENARIO_PATH, 'utf8'));

/** A deterministic 32-byte digest standing in for `cast keccak`. Same input, same output. */
const digest = (s) => `0x${createHash('sha256').update(String(s)).digest('hex')}`;
/** An address as a 32-byte event topic — `topicToAddress` in the runner slices from index 26. */
const topic = (addr) => `0x${'0'.repeat(24)}${String(addr).replace(/^0x/i, '').toLowerCase()}`;

const NOW = Number(sc.chainTimestamp ?? 2_000_000_000);
const DEPOSIT = String(sc.depositUsdc ?? '5000000');
const SHARES = String(sc.shares ?? '5000000');

/** The mutable chain. One process = one run, so this resets with every spawn. */
const st = {
  usdc: BigInt(sc.usdcBalance ?? '10000000'),
  registered: Boolean(sc.preRegistered),
  pending: '0',
  availableAt: 0,
  activated: false,
  shares: '0',
  pid: 0,
  status: 1, // Governance.Status.Active once a proposal exists
  pendingExecution: false,
  vault: String(sc.vault ?? '0x00000000000000000000000000000000000000ff'),
};

/** Throw the way `execFileSync` does, with `stderr` set: `cast()` builds its `detail` from it. */
function castFailure(stderr) {
  const err = new Error(`Command failed: cast`);
  return Object.assign(err, { stderr, status: 1 });
}

const proposalLines = () => [
  st.vault,                       // vault
  '0',                            // ptype (Rebalance)
  String(sc.signer),              // proposer
  String(NOW - 3600),             // createdAt
  String(NOW - 120),              // commitDeadline (already past: no wall-clock wait)
  String(NOW - 60),               // revealDeadline (already past)
  String(NOW - 60),               // executableAt
  String(NOW + 86400),            // expiresAt
  String(st.status),              // status
  digest('actionHash'),           // actionHash
  '1000000',                      // snapshotTotal
  '1',                            // memberCount
  '1000000',                      // forWeight
  '0',                            // againstWeight
  '1000000',                      // revealedWeight
  '1',                            // revealedVoterCount
].join('\n');

/** Read-only calls, keyed on the SIGNATURE the runner asks for. */
function handleCall(to, sig) {
  if (sig.startsWith('proposals(uint256)')) return proposalLines();
  switch (sig) {
    // Wiring immutability: the probe EXPECTS a revert, and only a confirmed revert proves the lock.
    case 'wire(address,address)':
      throw castFailure(String(sc.wireError ?? 'reverted: AlreadyWired()'));
    case 'priceWad(address)(uint256)':
      if (sc.oracleError) throw castFailure(String(sc.oracleError));
      return String(sc.priceWad ?? '2000000000000000000000');
    case 'balanceOf(address)(uint256)': return String(st.usdc);
    case 'vaultRegistered(address)(bool)': return st.registered ? 'true' : 'false';
    case 'operatorOf(address)(uint256)': return String(sc.operatorId ?? '1');
    case 'pendingDeposit(address)(uint256,uint64)': return `${st.pending}\n${st.availableAt}`;
    case 'navWad()(uint256)': return st.activated ? '5000000000000000000' : '0';
    case 'sharesOf(address)(uint256)': return st.shares;
    // The value the protocol acts on for the life of the vault, re-read rather than trusted from
    // the factory's event. Defaults to whatever the event said, so a scenario can disagree on one
    // without disagreeing on both.
    case 'creator()(address)':
      return String(sc.onChainCreator ?? sc.eventCreator ?? sc.signer);
    case 'activeProposalOf(address)(uint256)': return String(st.pid);
    case 'hasPendingExecution(address)(bool)': return st.pendingExecution ? 'true' : 'false';
    default:
      throw castFailure(`cast-stub: no scripted answer for call ${sig} to ${to}`);
  }
}

/** A successful receipt. `blockNumber` is low so the runner's height poll clears first try. */
const receipt = (label, logs) => JSON.stringify({
  status: '0x1',
  transactionHash: digest(`tx:${label}`),
  blockNumber: '0x10',
  logs,
});

/** State-changing calls. Returns the receipt JSON `send()` parses. */
function handleSend(to, sig, args) {
  if (sig.startsWith('createVault(')) {
    return receipt('createVault', [{
      address: to,
      topics: [
        digest('VaultCreated(address,address,address,uint256)'),
        topic(st.vault),
        topic(sc.eventCreator ?? sc.signer),
        topic('0x0000000000000000000000000000000000000001'),
      ],
      data: '0x',
    }]);
  }
  if (sig.startsWith('registerVault(')) { st.registered = true; return receipt('registerVault', []); }
  if (sig.startsWith('approve(')) return receipt('approve', []);
  if (sig.startsWith('deposit(')) {
    st.pending = String(args[0]);
    st.availableAt = NOW - 5; // the observation window has already elapsed on this fake chain
    return receipt('deposit', []);
  }
  if (sig.startsWith('activate(')) {
    st.activated = true;
    st.shares = SHARES;
    return receipt('activate', []);
  }
  if (sig.startsWith('propose(')) { st.pid = Number(sc.pid ?? 7); st.status = 1; return receipt('propose', []); }
  if (sig.startsWith('commitVote(')) return receipt('commitVote', []);
  if (sig.startsWith('revealVote(')) return receipt('revealVote', []);
  if (sig.startsWith('finalize(')) {
    st.status = Number(sc.finalizedStatus ?? 2); // Passed
    st.pendingExecution = true;
    return receipt('finalize', []);
  }
  if (sig.startsWith('markExpired(')) { st.status = 5; return receipt('markExpired', []); }
  if (sig.startsWith('execute(')) {
    st.pendingExecution = false;
    st.status = 4;
    return receipt('execute', [{
      address: st.vault,
      topics: [digest('RebalanceExecuted(address,uint256)'), topic(st.vault)],
      data: '0x',
    }]);
  }
  if (sig.startsWith('requestExit(')) {
    st.usdc += BigInt(DEPOSIT);
    st.shares = '0';
    return receipt('requestExit', [{
      address: st.vault,
      topics: [digest('ExitSettled(address,uint256,uint256,uint256,uint256)'), topic(sc.signer)],
      data: '0x',
    }]);
  }
  throw castFailure(`cast-stub: no scripted answer for send ${sig} to ${to}`);
}

let seq = 0;

/** One JSONL line per invocation, written BEFORE the answer: `process.exit` must not lose it. */
function record(entry) {
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

/**
 * The substitute for `child_process.execFileSync`. Signature-compatible with the real one for the
 * single way `smoke-test.mjs` calls it: `execFileSync(CAST, args, opts)` returning a string.
 *
 * @param {string} bin
 * @param {string[]} args
 */
export function execFileSync(bin, args = []) {
  const i = ++seq;
  const sub = String(args[0] ?? '');
  const sig = sub === 'call' || sub === 'send' ? String(args[2] ?? '') : '';
  record({ i, bin, sub, sig, args });
  try {
    const out = answer(sub, args);
    record({ i, sub, sig, result: 'ok' });
    return out;
  } catch (err) {
    record({ i, sub, sig, result: 'threw', stderr: String(/** @type {any} */ (err)?.stderr ?? '') });
    throw err;
  }
}

function answer(sub, args) {
  switch (sub) {
    case 'chain-id': return String(sc.chainId ?? '84532');
    case 'wallet': {
      if (args[1] !== 'address') throw castFailure(`cast-stub: no scripted answer for wallet ${args[1]}`);
      if (sc.walletError) throw castFailure(String(sc.walletError));
      return String(sc.derivedSigner ?? sc.signer ?? '');
    }
    case 'balance': return String(sc.ethBalance ?? '100000000000000000');
    case 'keccak': return digest(args[1]);
    case 'abi-encode': return digest(`abi:${args.slice(1).join('|')}`);
    case 'block': {
      const field = args[args.indexOf('-f') + 1];
      if (field === 'timestamp') return String(NOW);
      if (field === 'number') return '1000000';
      throw castFailure(`cast-stub: no scripted answer for block -f ${field}`);
    }
    case 'call': return handleCall(String(args[1]), String(args[2]));
    case 'send': return handleSend(String(args[1]), String(args[2]), args.slice(3).filter((a) => !String(a).startsWith('--')));
    default:
      throw castFailure(`cast-stub: no scripted answer for subcommand '${sub}'`);
  }
}
