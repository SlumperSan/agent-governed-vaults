// @ts-check
/**
 * The crank end to end: the real chain reader over a fake viem client that serves a proposal and a
 * block timestamp, the real planner, the real actor, and a wallet that is a recorder. A full tick
 * reads chain time, decides, simulates and (in execute mode) sends.
 *
 * Run in BOTH discovery sources: chain-only (a preset and no API URL) and the API source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createAgent } from '../src/agent.mjs';
import { createChainReader } from '../src/chain.mjs';
import { EXECUTE_ENV_VAR, loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';
import { createBudget } from '../src/budget.mjs';
import { INTENT_ORDER, plan } from '../src/plan.mjs';
import { perceive } from '../src/perceive.mjs';
import { payloadHash } from '../src/payloads.mjs';
import { FACTORY, GOVERNANCE, REGISTRY, SUBVAULT_REGISTRY, addr, createFakeChainClient, proposalTuple } from './fake-chain-client.mjs';

const USDC = 10n ** 6n;
const V_A = addr(0x5001);
const V_B = addr(0x5002);
const V_C = addr(0x5003);
const PAYLOAD = '0x' + 'cafe'.repeat(40);

// One proposal's clocks. T is "chain now" in each scenario; the proposal is laid out around it.
const R = 2_000_000; // revealDeadline
const E = R + 500; // executableAt
const X = R + 86_900; // expiresAt
const STATUS = { Active: 1, Passed: 2, Defeated: 3, Executed: 4, Expired: 5 };

const acct = privateKeyToAccount(generatePrivateKey());
const account = { address: acct.address, signMessage: (/** @type {any} */ a) => acct.signMessage(a) };

function silent() {
  const lines = [];
  return { lines, log: createLogger({ write: (l) => lines.push(l), nowSec: () => R }) };
}

/** A governance entry for the fake client, mutable through `.tuple`. */
const govEntry = (vault, { pid = 7n, status = 'Active', actionHash, ptype = 0 } = {}) => ({
  pid,
  tuple: proposalTuple({ vault, ptype, createdAt: R - 172_800, commitDeadline: R - 86_400, revealDeadline: R, executableAt: E, expiresAt: X, status: STATUS[status], actionHash }),
});
const setStatus = (entry, status) => {
  entry.tuple[8] = STATUS[status];
};

/**
 * @param {Object} o
 * @param {Array<any>} [o.vaults]
 * @param {Record<string, any>} [o.governance]
 * @param {number|null|(() => number|null)} [o.chainTime]
 * @param {number} [o.localTime]
 * @param {any} [o.crank]  policy.crank overrides
 * @param {'dry-run'|'execute'} [o.mode]
 * @param {(req:any)=>void} [o.onSimulate]
 * @param {Set<string>} [o.failing]
 */
function harness({ vaults, governance, chainTime = R, localTime = R, crank = {}, mode = 'dry-run', onSimulate, failing } = {}) {
  const fake = createFakeChainClient({
    vaults: vaults ?? [{ address: V_A, operatorId: 1, holders: 5, shares: 1_000n * USDC }],
    operators: { 1: { gain: 8_000n * USDC, loss: 1_000n * USDC } },
    governance: governance ?? {},
    blockTimestamp: chainTime,
    onSimulate,
    failing,
  });
  const sent = [];
  const walletClient = { writeContract: async (/** @type {any} */ req) => (sent.push(req), '0x' + 'ee'.repeat(32)) };
  const { log, lines } = silent();
  const config = loadConfig({
    mode,
    chain: { preset: 'arc-mainnet', factory: FACTORY, operatorRegistry: REGISTRY, subvaultRegistry: SUBVAULT_REGISTRY, governance: GOVERNANCE },
    policy: { crank },
  });
  const clock = { now: localTime };
  const agent = createAgent({
    config,
    account,
    chainReader: createChainReader({ client: fake, governance: GOVERNANCE }),
    log,
    env: { [EXECUTE_ENV_VAR]: 'yes' },
    fetchImpl: async () => {
      throw new Error('no HTTP');
    },
    walletClient,
    nowSec: () => clock.now,
  });
  return { agent, fake, sent, lines, clock, config, log };
}
const kinds = (r) => r.intents.map((i) => i.kind);

test('INTENT_ORDER is pinned: reveal, finalize, settle, execute, exit, activate, skip-window, mark-expired, commit, deposit', () => {
  assert.deepEqual({ ...INTENT_ORDER }, {
    reveal: 0, finalize: 1, 'settle-queued-exit': 2, execute: 3, exit: 4, activate: 5, 'skip-window': 6, 'mark-expired': 7, commit: 8, deposit: 9,
  });
});

test('a held vault with an Active proposal past its reveal deadline: dry-run plans a finalize and simulates it, sends nothing', async () => {
  const { agent, fake, sent } = harness({ governance: { [V_A]: govEntry(V_A) } });
  const r = await agent.tick();
  assert.equal(r.world.source, 'chain');
  assert.equal(r.world.chainNowSec, R);
  assert.deepEqual(kinds(r), ['finalize']);
  assert.deepEqual(r.intents[0].args, { pid: 7n });
  assert.equal(r.results[0].dryRun, true);
  assert.deepEqual(r.results[0].simulation, { ok: true });
  assert.equal(sent.length, 0);
  assert.equal(fake.count('simulate:finalize'), 1);
});

test('EXECUTE mode: the finalize is simulated, then sent to Governance as finalize(pid)', async () => {
  const { agent, fake, sent } = harness({ mode: 'execute', governance: { [V_A]: govEntry(V_A) } });
  const r = await agent.tick();
  assert.equal(r.results[0].sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].address, GOVERNANCE);
  assert.equal(sent[0].functionName, 'finalize');
  assert.deepEqual(sent[0].args, [7n]);
  assert.equal(fake.count('simulate:finalize'), 1);
});

test('block time: a local clock ten minutes AHEAD of the chain does not finalize early; a clock behind it still finalizes on time', async () => {
  const early = harness({ chainTime: R - 100, localTime: R + 600, governance: { [V_A]: govEntry(V_A) } });
  const r1 = await early.agent.tick();
  assert.deepEqual(kinds(r1), [], 'chain time is before the reveal deadline');
  assert.equal(early.fake.count('simulate:finalize'), 0);

  const late = harness({ chainTime: R, localTime: R - 600, governance: { [V_A]: govEntry(V_A) } });
  assert.deepEqual(kinds(await late.agent.tick()), ['finalize']);
});

test('block time unreadable: a named gap, and the local clock stands in less the activateGraceSec margin', async () => {
  const grace = 60;
  const a = harness({ chainTime: null, localTime: R + grace - 1, governance: { [V_A]: govEntry(V_A) } });
  const r1 = await a.agent.tick();
  assert.equal(r1.world.chainNowSec, null);
  assert.ok(r1.world.gaps.some((g) => /latest block timestamp unreadable/.test(g)), r1.world.gaps.join('; '));
  assert.deepEqual(kinds(r1), []);
  const b = harness({ chainTime: null, localTime: R + grace, governance: { [V_A]: govEntry(V_A) } });
  assert.deepEqual(kinds(await b.agent.tick()), ['finalize']);
});

test('the same agent follows the proposal: finalize, then (state flips to Passed) execute, then (window over) mark-expired', async () => {
  let chainNow = R;
  const gov = govEntry(V_A);
  const actionHash = await payloadHash(PAYLOAD);
  gov.tuple[9] = actionHash;
  const { agent, sent } = harness({
    mode: 'execute',
    chainTime: () => chainNow,
    governance: { [V_A]: gov },
    crank: { markExpired: true, knownPayloads: { [actionHash]: PAYLOAD } },
  });

  const t1 = await agent.tick();
  assert.deepEqual(kinds(t1), ['finalize']);

  setStatus(gov, 'Passed');
  chainNow = E;
  const t2 = await agent.tick();
  assert.deepEqual(kinds(t2), ['execute']);
  assert.equal(t2.intents[0].args.payload, PAYLOAD);
  assert.equal(sent[1].functionName, 'execute');
  assert.deepEqual(sent[1].args, [7n, PAYLOAD]);

  chainNow = X; // last second of the window: still executable, not yet expired
  assert.deepEqual(kinds(await agent.tick()), ['execute']);

  chainNow = X + 1;
  const t4 = await agent.tick();
  assert.deepEqual(kinds(t4), ['mark-expired']);
  assert.equal(sent[3].functionName, 'markExpired');
  assert.deepEqual(sent[3].args, [7n]);
});

test('markExpired is off by default: the same expired proposal plans nothing', async () => {
  const gov = govEntry(V_A, { status: 'Passed' });
  const { agent } = harness({ chainTime: X + 1, governance: { [V_A]: gov } });
  const r = await agent.tick();
  assert.deepEqual(kinds(r), []);
  const d = r.decisions.find((x) => x.kind === 'crank');
  assert.equal(d.action, 'none');
  assert.match(d.reason, /markExpired is off/);
});

test('execute with no payload on hand plans nothing and the log names the missing payload', async () => {
  const gov = govEntry(V_A, { status: 'Passed', actionHash: '0x' + 'ab'.repeat(32) });
  const { agent, lines, fake } = harness({ chainTime: E, governance: { [V_A]: gov } });
  const r = await agent.tick();
  assert.deepEqual(kinds(r), []);
  assert.ok(lines.some((l) => /no crank action/.test(l) && /no verified payload for actionHash 0xabab/.test(l)), lines.join('\n'));
  assert.equal(fake.count('simulate:execute'), 0);
});

test('a payload that does not hash to its key is ignored with a gap, never executed', async () => {
  const hash = '0x' + 'ab'.repeat(32);
  const gov = govEntry(V_A, { status: 'Passed', actionHash: hash });
  const { agent, sent } = harness({ mode: 'execute', chainTime: E, governance: { [V_A]: gov }, crank: { knownPayloads: { [hash]: PAYLOAD } } });
  const r = await agent.tick();
  assert.deepEqual(kinds(r), []);
  assert.ok(r.world.gaps.some((g) => /crank payload 0xabab.* ignored: payload hashes to/.test(g)), r.world.gaps.join('; '));
  assert.equal(sent.length, 0);
});

test('scope held (default) skips a vault the agent holds nothing in; scope all cranks it', async () => {
  const vaults = [
    { address: V_A, operatorId: 1, holders: 5, shares: 1_000n * USDC },
    { address: V_B, operatorId: 1, holders: 5, shares: 0n },
  ];
  const governance = { [V_A]: govEntry(V_A), [V_B]: govEntry(V_B, { pid: 8n }) };
  // The unheld vault may draw a deposit intent from the join gate; only the crank's are under test.
  const finalizes = (r) => r.intents.filter((i) => i.kind === 'finalize').map((i) => i.vault).sort();
  const held = await harness({ vaults, governance }).agent.tick();
  assert.deepEqual(finalizes(held), [V_A]);
  const all = await harness({ vaults, governance, crank: { scope: 'all' } }).agent.tick();
  assert.deepEqual(finalizes(all), [V_A, V_B].sort());
  const off = await harness({ vaults, governance, crank: { scope: 'off' } }).agent.tick();
  assert.deepEqual(finalizes(off), []);
  assert.equal(off.world.chainNowSec, null, 'cranking off reads no block time');
});

test('one tick orders the crank by risk: finalize, then execute, then mark-expired', async () => {
  const hash = await payloadHash(PAYLOAD);
  const vaults = [V_A, V_B, V_C].map((address) => ({ address, operatorId: 1, holders: 5, shares: 1_000n * USDC }));
  // Three vaults at one chain time cannot be in three phases of one clock, so give each its own clocks.
  const gA = govEntry(V_A); // Active, past reveal at T
  const gB = govEntry(V_B, { pid: 8n, status: 'Passed', actionHash: hash });
  const gC = govEntry(V_C, { pid: 9n, status: 'Passed' });
  const T = E + 10;
  gA.tuple[5] = BigInt(T - 5);
  gC.tuple[7] = BigInt(T - 1); // expired before T
  const { agent } = harness({ vaults, chainTime: T, governance: { [V_C]: gC, [V_A]: gA, [V_B]: gB }, crank: { markExpired: true, knownPayloads: { [hash]: PAYLOAD } } });
  const r = await agent.tick();
  assert.deepEqual(kinds(r), ['finalize', 'execute', 'mark-expired']);
});

test('a simulation revert drops the intent: no transaction is sent, and the drop has its reason', async () => {
  const lost = () => {
    const revert = { name: 'ContractFunctionRevertedError', data: { errorName: 'WrongPhase' } };
    throw Object.assign(new Error('reverted'), { walk: (/** @type {any} */ fn) => (fn(revert) ? revert : null) });
  };
  const { agent, sent, lines } = harness({ mode: 'execute', governance: { [V_A]: govEntry(V_A) }, onSimulate: lost });
  const r = await agent.tick();
  assert.equal(r.results[0].dropped, true);
  assert.match(r.results[0].error, /simulation reverted \(WrongPhase\)/);
  assert.equal(r.results.filter((x) => x.sent).length, 0);
  assert.equal(sent.length, 0);
  assert.ok(lines.some((l) => /DROPPED finalize/.test(l) && /WrongPhase/.test(l)));
});

test('an unreadable proposal is degraded: nothing is planned, and the log says it is unknown', async () => {
  const { agent, lines, fake } = harness({ governance: { [V_A]: govEntry(V_A) }, failing: new Set(['proposals']) });
  const r = await agent.tick();
  assert.deepEqual(kinds(r), []);
  assert.equal(r.decisions.find((d) => d.kind === 'crank').degraded, true);
  assert.ok(lines.some((l) => /no crank action/.test(l) && /could NOT be read/.test(l)));
  assert.equal(fake.count('simulate:finalize'), 0);
});

test('a Defeated, Executed or Expired proposal is finished: nothing is planned', async () => {
  for (const status of ['Defeated', 'Executed', 'Expired']) {
    const { agent } = harness({ chainTime: X + 100, governance: { [V_A]: govEntry(V_A, { status }) }, crank: { markExpired: true } });
    assert.deepEqual(kinds(await agent.tick()), [], status);
  }
});

test('API source: the same world fields reach the planner, so the crank decides the same way', async () => {
  const fake = createFakeChainClient({
    vaults: [{ address: V_A, operatorId: 1, holders: 5, shares: 1_000n * USDC }],
    operators: { 1: { gain: 8_000n * USDC, loss: 1_000n * USDC } },
    governance: { [V_A]: govEntry(V_A) },
    blockTimestamp: R,
  });
  const config = loadConfig({
    api: { baseUrl: 'http://api.test' },
    chain: { preset: 'arc-mainnet', factory: FACTORY, operatorRegistry: REGISTRY, subvaultRegistry: SUBVAULT_REGISTRY, governance: GOVERNANCE },
  });
  const client = {
    discovery: async () => ({ enabled: false, x402Version: 2 }),
    health: async () => ({ ok: true, lastBlock: 1 }),
    listVaults: async () => ({ data: { vaults: [{ vault: V_A, operatorId: 1, memberCount: 5, depth: 0, parent: null, capacityCapUsdc: '0', attested: true }] } }),
    leaderboard: async () => ({ data: { leaderboard: [{ operatorId: 1, operator: '0x' + 'a1'.repeat(20), netRealizedUsdc: String(7_000n * USDC), lifetimeGainUsdc: String(8_000n * USDC), lifetimeLossUsdc: String(1_000n * USDC), lifetimeFeesUsdc: '0', vaultCount: 1 }] } }),
    getVault: async (/** @type {string} */ a) => ({ data: { vault: a, operatorId: 1 } }),
  };
  const { log } = silent();
  const world = await perceive({
    client,
    chainReader: createChainReader({ client: fake, governance: GOVERNANCE }),
    budget: createBudget({ maxSessionSpendUsdc: '0.25', maxSingleReadUsdc: '0.05', enabled: true }),
    config,
    member: account.address,
    log,
    nowSec: R,
  });
  assert.equal(world.source, 'api');
  assert.equal(world.chainNowSec, R);
  const { intents } = plan({ world, config, log });
  assert.deepEqual(intents.map((i) => i.kind), ['finalize']);
});
