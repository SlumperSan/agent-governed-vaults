// @ts-check
/**
 * The crank at the actor: `finalize`, `execute` and `mark-expired` as calldata, the simulation that
 * precedes every send, and the refusals that stand even when the planner is bypassed.
 *
 * The wallet client here is a recorder, so "was it sent" is a fact the test reads, not a behaviour
 * it trusts. The simulation tests also run the REAL chain reader over a real viem client whose
 * transport answers `eth_call` with a revert, so the way viem reports a revert is exercised, not
 * assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createPublicClient, custom, decodeFunctionData, encodeFunctionData, keccak256, toFunctionSelector } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ActionRefused, CRANK_KINDS, GOVERNANCE_CRANK_ERROR_ABI, GOVERNANCE_WRITE_ABI, createActor } from '../src/act.mjs';
import { createChainReader, createStubChainReader } from '../src/chain.mjs';
import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';
import { payloadHash, verifyKnownPayloads } from '../src/payloads.mjs';

const VAULT = '0x' + '11'.repeat(20);
const PAYLOAD = '0x' + 'cafe'.repeat(40);
let ACTION_HASH = '';
const config = loadConfig({ chain: { preset: 'arc-mainnet' } });
const GOVERNANCE = config.chain.governance;

const acct = privateKeyToAccount(generatePrivateKey());
const account = { address: acct.address, signMessage: (/** @type {any} */ a) => acct.signMessage(a) };

function recorder() {
  const sent = [];
  return { sent, writeContract: async (/** @type {any} */ req) => (sent.push(req), '0x' + 'ee'.repeat(32)) };
}
function quiet() {
  const lines = [];
  return { lines, log: createLogger({ write: (l) => lines.push(l), nowSec: () => 1 }) };
}
/** An actor over a stub reader whose `simulate` is recorded and settable. */
function harness({ mode = 'execute', simulate = () => ({ ok: true }), chainReader = null } = {}) {
  const simulated = [];
  const reader = chainReader ?? createStubChainReader({}, {}, { simulate: (call, o) => (simulated.push({ call, o }), simulate(call, o)) });
  const wallet = recorder();
  const { log, lines } = quiet();
  const actor = createActor({ mode, config, account, chainReader: reader, log, walletClient: wallet });
  return { actor, wallet, simulated, lines };
}
const finalizeIntent = (pid = 7n) => ({ kind: 'finalize', vault: VAULT, args: { pid }, dueAtSec: 0, reason: 'test' });
const expireIntent = (pid = 7n) => ({ kind: 'mark-expired', vault: VAULT, args: { pid }, dueAtSec: 0, reason: 'test' });
const executeIntent = async (over = {}) => ({
  kind: 'execute', vault: VAULT, dueAtSec: 0, reason: 'test',
  args: { pid: 7n, ptype: 0, actionHash: ACTION_HASH || (ACTION_HASH = await payloadHash(PAYLOAD)), payload: PAYLOAD, ...over },
});

test('the three fragments are the contract\'s own signatures (selectors pinned independent of the build)', () => {
  const sel = (name) => toFunctionSelector(GOVERNANCE_WRITE_ABI.find((f) => f.name === name));
  assert.equal(sel('finalize'), keccak256('0x' + Buffer.from('finalize(uint256)').toString('hex')).slice(0, 10));
  assert.equal(sel('execute'), keccak256('0x' + Buffer.from('execute(uint256,bytes)').toString('hex')).slice(0, 10));
  assert.equal(sel('markExpired'), keccak256('0x' + Buffer.from('markExpired(uint256)').toString('hex')).slice(0, 10));
  assert.deepEqual([...CRANK_KINDS], ['finalize', 'execute', 'mark-expired']);
});

test('the crank revert names match the compiled Governance errors (when contracts/out is built)', (t) => {
  const file = new URL('../../../contracts/out/Governance.sol/Governance.json', import.meta.url);
  if (!existsSync(file)) return t.skip('contracts/out/Governance.sol is absent: run `forge build`');
  const compiled = JSON.parse(readFileSync(file, 'utf8')).abi.filter((e) => e.type === 'error');
  for (const frag of GOVERNANCE_CRANK_ERROR_ABI) {
    assert.ok(compiled.some((e) => e.name === frag.name && e.inputs.length === 0), `Governance has no ${frag.name}() error`);
  }
});

test('finalize and mark-expired resolve to calldata that decodes back to (pid)', async () => {
  const { actor } = harness();
  for (const [intent, fn] of [[finalizeIntent(7n), 'finalize'], [expireIntent(9n), 'markExpired']]) {
    const call = await actor.resolveCall(intent);
    assert.equal(call.to, GOVERNANCE);
    assert.equal(call.contract, 'Governance');
    assert.equal(call.functionName, fn);
    const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
    const back = decodeFunctionData({ abi: GOVERNANCE_WRITE_ABI, data });
    assert.equal(back.functionName, fn);
    assert.deepEqual(back.args, [intent.args.pid]);
  }
});

test('execute resolves to calldata that decodes back to (pid, payload)', async () => {
  const { actor } = harness();
  const intent = await executeIntent();
  const call = await actor.resolveCall(intent);
  assert.equal(call.functionName, 'execute');
  const back = decodeFunctionData({ abi: GOVERNANCE_WRITE_ABI, data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args }) });
  assert.deepEqual(back.args, [7n, PAYLOAD]);
  assert.match(call.human, /^Governance\.execute\(pid=7, payload=0xcafecafe…cafecafe 80 bytes\)/);
});

test('DRY-RUN sends nothing, but still simulates the exact write', async () => {
  const { actor, wallet, simulated } = harness({ mode: 'dry-run' });
  const r = await actor.run(finalizeIntent());
  assert.equal(r.sent, false);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.simulation, { ok: true });
  assert.equal(wallet.sent.length, 0);
  assert.equal(simulated.length, 1);
  assert.equal(simulated[0].call.to, GOVERNANCE);
  assert.equal(simulated[0].call.functionName, 'finalize');
  assert.deepEqual(simulated[0].call.args, [7n]);
  assert.equal(simulated[0].o.from, account.address, 'simulated from the agent\'s own address');
});

test('EXECUTE: the simulation runs BEFORE the send, and a pass sends exactly the simulated call', async () => {
  const order = [];
  const reader = createStubChainReader({}, {}, { simulate: () => (order.push('simulate'), { ok: true }) });
  const wallet = { sent: [], writeContract: async (/** @type {any} */ req) => (order.push('send'), wallet.sent.push(req), '0x' + 'ee'.repeat(32)) };
  const { log } = quiet();
  const actor = createActor({ mode: 'execute', config, account, chainReader: reader, log, walletClient: wallet });
  const r = await actor.run(await executeIntent());
  assert.deepEqual(order, ['simulate', 'send']);
  assert.equal(r.sent, true);
  assert.equal(wallet.sent[0].functionName, 'execute');
  assert.deepEqual(wallet.sent[0].args, [7n, PAYLOAD]);
  assert.equal(wallet.sent[0].address, GOVERNANCE);
});

test('a simulation REVERT drops the intent with its reason and sends nothing (a lost finalize race)', async () => {
  const { actor, wallet, lines } = harness({ simulate: () => ({ ok: false, reverted: true, error: 'WrongPhase' }) });
  const r = await actor.run(finalizeIntent());
  assert.equal(r.sent, false);
  assert.equal(r.dropped, true);
  assert.match(r.error, /simulation reverted \(WrongPhase\)/);
  assert.equal(wallet.sent.length, 0);
  assert.ok(lines.some((l) => /DROPPED finalize/.test(l) && /WrongPhase/.test(l) && /not sent/.test(l)));
});

test('a simulation that could NOT run drops the intent too: what was not checked is not sent', async () => {
  const { actor, wallet } = harness({ simulate: () => ({ ok: false, reverted: false, error: 'rpc down' }) });
  const r = await actor.run(expireIntent());
  assert.equal(r.dropped, true);
  assert.match(r.error, /simulation unavailable \(rpc down\)/);
  assert.equal(wallet.sent.length, 0);
});

test('a chain reader with no simulateCall drops every crank intent', async () => {
  const bare = { async readGovernance() { return null; } };
  const { actor, wallet } = harness({ chainReader: bare });
  const r = await actor.run(finalizeIntent());
  assert.equal(r.dropped, true);
  assert.match(r.error, /cannot simulate/);
  assert.equal(wallet.sent.length, 0);
});

test('a non-crank intent is not simulated (the existing calls are unchanged)', async () => {
  const { actor, simulated, wallet } = harness();
  const r = await actor.run({ kind: 'settle-queued-exit', vault: VAULT, args: { member: account.address }, dueAtSec: 0, reason: 'test' });
  assert.equal(r.sent, true);
  assert.equal(simulated.length, 0);
  assert.equal(wallet.sent.length, 1);
});

test('execute is REFUSED when the payload does not hash to the actionHash, and nothing is simulated or sent', async () => {
  const { actor, wallet, simulated } = harness();
  const wrong = await executeIntent({ payload: '0x' + 'beef'.repeat(40) });
  const r = await actor.run(wrong);
  assert.equal(r.refused, true);
  assert.match(r.error, /the payload hashes to 0x[0-9a-f]{64}, not to the proposal's actionHash/);
  assert.match(r.error, /BadPayload/);
  assert.equal(simulated.length, 0);
  assert.equal(wallet.sent.length, 0);
  await assert.rejects(() => actor.resolveCall(wrong), ActionRefused);
});

test('execute is REFUSED for any proposal type but Rebalance, and for missing pieces', async () => {
  const { actor, wallet } = harness();
  for (const over of [{ ptype: 1 }, { ptype: 2 }, { ptype: undefined }, { payload: undefined }, { payload: 'not hex' }, { actionHash: undefined }, { actionHash: '0x12' }, { pid: undefined }]) {
    const r = await actor.run(await executeIntent(over));
    assert.equal(r.refused, true, JSON.stringify(over, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(r.sent, false);
  }
  assert.equal(wallet.sent.length, 0);
});

test('finalize and mark-expired are refused without a proposal id or a governance address', async () => {
  const { actor } = harness();
  for (const intent of [{ ...finalizeIntent(), args: {} }, { ...expireIntent(), args: { pid: 'seven' } }, { ...finalizeIntent(), args: { pid: -1 } }])
    await assert.rejects(() => actor.resolveCall(intent), /needs a proposal id/);
  const noGov = createActor({ mode: 'execute', config: { ...config, chain: { ...config.chain, governance: null } }, account, chainReader: createStubChainReader(), log: quiet().log, walletClient: recorder() });
  await assert.rejects(() => noGov.resolveCall(finalizeIntent()), /needs chain.governance/);
});

test('verifyKnownPayloads keeps only entries whose bytes hash to their key, lowercased, and reports the rest', async () => {
  const good = await payloadHash(PAYLOAD);
  const { verified, rejected } = await verifyKnownPayloads({
    [good.toUpperCase().replace('0X', '0x')]: PAYLOAD,
    ['0x' + 'ab'.repeat(32)]: PAYLOAD, // wrong hash
    '0x1234': PAYLOAD, // not a 32-byte key
    ['0x' + 'cd'.repeat(32)]: 'nope', // not hex
  });
  assert.deepEqual(verified, { [good]: PAYLOAD });
  assert.equal(rejected.length, 3);
  assert.ok(rejected.some((r) => /not to its key/.test(r.reason)));
  assert.ok(rejected.some((r) => /not a 32-byte/.test(r.reason)));
  assert.ok(rejected.some((r) => /not 0x hex/.test(r.reason)));
  assert.deepEqual((await verifyKnownPayloads(undefined)).verified, {});
});

// ── the real reader over real viem: how a revert is reported ───────────────

/** A viem public client whose transport answers eth_call with `ethCall(params)`. */
function viemClient(ethCall) {
  return createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_chainId') return '0x1';
        if (method === 'eth_call') return ethCall(params);
        throw new Error(`unexpected rpc method ${method}`);
      },
    }, { retryCount: 0 }),
  });
}
const sigOf = (sig) => keccak256('0x' + Buffer.from(sig).toString('hex')).slice(0, 10);
const revertWith = (selector) => Object.assign(new Error('execution reverted'), { code: 3, data: selector });
const wrongPhaseCall = { to: GOVERNANCE, abi: [...GOVERNANCE_WRITE_ABI, ...GOVERNANCE_CRANK_ERROR_ABI], functionName: 'finalize', args: [7n] };

test('simulateCall over real viem: a revert comes back reverted, with the error NAME', async () => {
  const reader = createChainReader({ client: viemClient(() => { throw revertWith(sigOf('WrongPhase()')); }) });
  const r = await reader.simulateCall(wrongPhaseCall, { from: account.address });
  assert.deepEqual(r, { ok: false, reverted: true, error: 'WrongPhase' });
});

test('simulateCall over real viem: success is ok, and the call goes out as the exact calldata from the agent', async () => {
  const seen = [];
  const reader = createChainReader({ client: viemClient((params) => (seen.push(params[0]), '0x')) });
  assert.deepEqual(await reader.simulateCall(wrongPhaseCall, { from: account.address }), { ok: true });
  assert.equal(seen[0].to.toLowerCase(), GOVERNANCE.toLowerCase());
  assert.equal(seen[0].from.toLowerCase(), account.address.toLowerCase());
  assert.equal(seen[0].data, encodeFunctionData({ abi: GOVERNANCE_WRITE_ABI, functionName: 'finalize', args: [7n] }));
});

test('simulateCall over real viem: a transport failure is NOT a revert (reverted false), and never throws', async () => {
  const reader = createChainReader({ client: viemClient(() => { throw new Error('socket hang up'); }) });
  const r = await reader.simulateCall(wrongPhaseCall);
  assert.equal(r.ok, false);
  assert.equal(r.reverted, false);
  assert.ok(r.error.length > 0, 'the failure is reported, not swallowed');
});

test('readBlockTimestamp over real viem: the latest block timestamp as a number, null on failure', async () => {
  const block = (ts) => ({ number: '0x1', hash: '0x' + '00'.repeat(32), parentHash: '0x' + '00'.repeat(32), timestamp: '0x' + ts.toString(16), nonce: '0x0000000000000000', logsBloom: '0x' + '00'.repeat(256), transactions: [], uncles: [], gasLimit: '0x1', gasUsed: '0x0', miner: '0x' + '00'.repeat(20), difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x1', sha3Uncles: '0x' + '00'.repeat(32), stateRoot: '0x' + '00'.repeat(32), receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), mixHash: '0x' + '00'.repeat(32), baseFeePerGas: '0x1' });
  const ok = createChainReader({
    client: createPublicClient({ transport: custom({ async request({ method }) { if (method === 'eth_getBlockByNumber') return block(1_700_000_123); throw new Error(method); } }, { retryCount: 0 }) }),
  });
  assert.equal(await ok.readBlockTimestamp(), 1_700_000_123);
  const bad = createChainReader({ client: createPublicClient({ transport: custom({ async request() { throw new Error('down'); } }, { retryCount: 0 }) }) });
  assert.equal(await bad.readBlockTimestamp(), null);
});
