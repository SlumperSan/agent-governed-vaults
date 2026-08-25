// @ts-check
/**
 * Full perceive → decide → act loop against a mocked API and a mocked chain, in BOTH modes.
 *
 * Execute mode here runs against mocks only. Nothing in this suite touches a network, an RPC, or a
 * real key: the "wallet client" is a recorder, so "did it send" is a fact the test can assert
 * rather than a behaviour it has to trust.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createAgent } from '../src/agent.mjs';
import { createStubChainReader } from '../src/chain.mjs';
import { loadConfig, EXECUTE_ENV_VAR } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';
import { buildVote } from '../src/salt.mjs';
import { plan } from '../src/plan.mjs';

const USDC = 10n ** 6n;
const WAD = 10n ** 18n;
const V_JOIN = '0x1111111111111111111111111111111111111111';
const V_BAD = '0x2222222222222222222222222222222222222222';
const V_HELD = '0x3333333333333333333333333333333333333333';
const NOW = 1_700_000_000;
const CHALLENGE = { asset: '0x' + 'c'.repeat(40), amount: '10000', payTo: '0x' + 'p'.repeat(0) + 'b'.repeat(40), network: 'base-sepolia', nonce: '0x' + '1'.repeat(64) };

// ── mocked metered API: a real 402 → pay → 200 loop, in-process ─────────────
function mockApi({ failPaid = false } = {}) {
  const paidCalls = [];
  const res = (status, body, headers = {}) => {
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => body };
  };
  const BODIES = {
    '/.well-known/x402': { x402Version: 2, price: { asset: CHALLENGE.asset, amount: '10000', payTo: CHALLENGE.payTo, network: 'base-sepolia' } },
    '/health': { ok: true, lastBlock: 1010 },
    '/vaults': {
      vaults: [
        { vault: V_JOIN, operatorId: 1, memberCount: 5, depth: 0, parent: null, capacityCapUsdc: (500_000n * USDC).toString(), attested: true },
        { vault: V_BAD, operatorId: 0, memberCount: 1, depth: 0, parent: null, capacityCapUsdc: '0', attested: false },
        { vault: V_HELD, operatorId: 2, memberCount: 9, depth: 0, parent: null, capacityCapUsdc: (250_000n * USDC).toString(), attested: true },
      ],
    },
    '/operators/leaderboard': {
      leaderboard: [
        { operatorId: 1, operator: '0x' + 'a1'.repeat(20), netRealizedUsdc: (36_000n * USDC).toString(), lifetimeGainUsdc: (42_000n * USDC).toString(), lifetimeLossUsdc: (6_000n * USDC).toString(), lifetimeFeesUsdc: '0', vaultCount: 1 },
        { operatorId: 2, operator: '0x' + 'a2'.repeat(20), netRealizedUsdc: (-15_500n * USDC).toString(), lifetimeGainUsdc: (4_000n * USDC).toString(), lifetimeLossUsdc: (19_500n * USDC).toString(), lifetimeFeesUsdc: '0', vaultCount: 1 },
      ],
    },
  };

  const fetchImpl = async (url, opts) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const free = path === '/health' || path === '/.well-known/x402';
    if (!free && !opts?.headers?.['payment-signature']) return res(402, { error: 'payment required' }, { 'payment-required': JSON.stringify(CHALLENGE) });
    if (!free) paidCalls.push(path);
    if (!free && failPaid) return res(500, { error: 'indexer unavailable' });
    const body = BODIES[path] ?? (/^\/vaults\/0x/.test(path) ? { vault: path.split('/')[2], operatorId: 1 } : { error: 'not found' });
    return res(BODIES[path] || /^\/vaults\/0x/.test(path) ? 200 : 404, body, { 'payment-response': JSON.stringify({ receiptId: 'r' + paidCalls.length }) });
  };
  return { fetchImpl, paidCalls };
}

const chainFixture = () => ({
  [V_JOIN]: {
    operatorId: 1, navPerShareWad: WAD, totalAssetsUsdc: 100_000n * USDC, totalPendingUsdc: 0n, idleUsdc: 1_000n * USDC,
    capacityCapUsdc: 500_000n * USDC, isCapped: true, minDepositUsdc: 10n * USDC,
    stackedPerfFeeBps: 1000, stackedExitFeeCapBps: 100, depth: 0, self: {},
  },
  [V_BAD]: {
    operatorId: 0, navPerShareWad: WAD, totalAssetsUsdc: 12_000n * USDC, totalPendingUsdc: 0n, idleUsdc: 12_000n * USDC,
    capacityCapUsdc: 0n, isCapped: false, minDepositUsdc: 1n * USDC,
    stackedPerfFeeBps: 1000, stackedExitFeeCapBps: 100, depth: 0, self: {},
  },
  [V_HELD]: {
    operatorId: 2, navPerShareWad: (WAD * 80n) / 100n, totalAssetsUsdc: 90_000n * USDC, totalPendingUsdc: 0n, idleUsdc: 27_000n * USDC,
    capacityCapUsdc: 250_000n * USDC, isCapped: true, minDepositUsdc: 10n * USDC,
    stackedPerfFeeBps: 1000, stackedExitFeeCapBps: 100, depth: 0,
    self: { shares: 1_500n * USDC, exitFeeBps: 60, queuedExitShares: 0n, windowCleared: true, skipOptIn: false, pendingAmount: 0n, pendingAvailableAt: 0 },
  },
});

const govFixture = (commitment = null) => ({
  [V_HELD]: {
    hasPendingExecution: true,
    activePid: 42n,
    proposal: {
      pid: 42n, vault: V_HELD, ptype: 0, ptypeName: 'Rebalance', proposer: '0x' + 'a2'.repeat(20),
      createdAt: NOW - 7200, commitDeadline: NOW - 600, revealDeadline: NOW + 2400, executableAt: NOW + 6000, expiresAt: NOW + 86400,
      status: 1, statusName: 'Active', actionHash: '0x' + 'ab'.repeat(32),
      snapshotTotal: 104_000n * USDC, memberCount: 11, forWeight: 0n, againstWeight: 0n, revealedWeight: 0n, revealedVoterCount: 0n,
    },
    commitment,
    hasOutstandingCommit: commitment != null,
    revealed: false,
  },
});

function silentLogger() {
  const lines = [];
  return { log: createLogger({ write: (l) => lines.push(l), nowSec: () => NOW }), lines };
}

function payerFor(acct) {
  return {
    address: acct.address,
    signTypedData: (td) =>
      acct.signTypedData({ domain: td.domain, types: { TransferWithAuthorization: td.types.TransferWithAuthorization }, primaryType: 'TransferWithAuthorization', message: td.message }),
  };
}

async function harness({ mode = 'dry-run', env = {}, commitment = null, config: over = {}, api = mockApi(), walletClient = null } = {}) {
  const acct = privateKeyToAccount(generatePrivateKey());
  const account = { address: acct.address, signMessage: (a) => acct.signMessage(a) };
  const { log, lines } = silentLogger();
  const config = loadConfig({
    mode,
    api: { baseUrl: 'http://api.test', payments: { maxSessionSpendUsdc: '0.25', maxSingleReadUsdc: '0.05' } },
    chain: { chainId: 84532, governance: '0x' + '9'.repeat(40), usdc: CHALLENGE.asset },
    ...over,
  });
  const agent = createAgent({
    config,
    account,
    payer: payerFor(acct),
    chainReader: createStubChainReader(chainFixture(), govFixture(commitment)),
    log,
    env,
    fetchImpl: api.fetchImpl,
    walletClient,
    entryMarks: { [V_HELD]: WAD },
    nowSec: () => NOW,
  });
  return { agent, account, acct, lines, api, config, log };
}

const kinds = (r) => r.intents.map((i) => i.kind);

// ── dry-run ─────────────────────────────────────────────────────────────────

test('DRY-RUN: a full pass decides everything and sends nothing', async () => {
  const { agent, lines } = await harness();
  const r = await agent.tick();

  assert.equal(r.mode, 'dry-run');
  assert.deepEqual(kinds(r).sort(), ['deposit', 'exit'].sort());
  assert.equal(r.results.every((x) => x.sent === false), true, 'dry-run must send nothing');
  assert.equal(r.results.every((x) => x.dryRun === true), true);
  assert.ok(lines.some((l) => l.includes('[DRY-RUN] would send')));
  assert.ok(!lines.some((l) => l.includes('[EXECUTE]')));
});

test('DRY-RUN: the join gate is applied per vault — join the good one, refuse the unattested one', async () => {
  const { agent } = await harness();
  const r = await agent.tick();
  const joins = r.decisions.filter((d) => d.kind === 'join');
  assert.equal(joins.find((d) => d.vault === V_JOIN).join, true);
  assert.equal(joins.find((d) => d.vault === V_BAD).join, false);
  assert.equal(r.intents.filter((i) => i.kind === 'deposit').length, 1);
  assert.equal(r.intents.find((i) => i.kind === 'deposit').vault, V_JOIN);
});

test('DRY-RUN: the exit into a pending rebalance is reported as MODE F', async () => {
  const { agent, lines } = await harness();
  const r = await agent.tick();
  const exit = r.intents.find((i) => i.kind === 'exit');
  assert.equal(exit.modeF, true);
  assert.match(exit.reason, /POST-rebalance NAV/);
  assert.ok(lines.some((l) => l.includes('MODE F')), 'the operator must be told the price they see is not the price they get');
});

test('DRY-RUN: a real outstanding commit produces a reveal that RE-DERIVES its salt', async () => {
  // The restart scenario end to end: only the commitment is carried over, nothing else.
  const acct = privateKeyToAccount(generatePrivateKey());
  const account = { address: acct.address, signMessage: (a) => acct.signMessage(a) };
  const vote = await buildVote({ account, chainId: 84532, vault: V_HELD, pid: 42n, support: true });

  const { log, lines } = silentLogger();
  const config = loadConfig({
    api: { baseUrl: 'http://api.test' },
    chain: { chainId: 84532, governance: '0x' + '9'.repeat(40), usdc: CHALLENGE.asset },
  });
  const agent = createAgent({
    config,
    account,
    payer: payerFor(acct),
    chainReader: createStubChainReader(chainFixture(), govFixture(vote.commitment)),
    log,
    fetchImpl: mockApi().fetchImpl,
    entryMarks: { [V_HELD]: WAD },
    nowSec: () => NOW,
  });

  const r = await agent.tick();
  const reveal = r.results.find((x) => x.intent === 'reveal');
  assert.ok(reveal, 'an outstanding commit must produce a reveal');
  assert.equal(reveal.sent, false, 'still a dry run');
  assert.equal(reveal.call.functionName, 'revealVote');
  assert.equal(reveal.call.args[1], true, 'support recovered from the chain commitment');
  assert.ok(lines.some((l) => l.includes('RE-DERIVED')));
  // The salt must never appear in full in the log.
  assert.ok(!lines.some((l) => l.includes(vote.salt)), 'the salt must never be logged in full');
});

test('the reveal is ordered FIRST — it is the obligation that forfeits if missed', async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const account = { address: acct.address, signMessage: (a) => acct.signMessage(a) };
  const vote = await buildVote({ account, chainId: 84532, vault: V_HELD, pid: 42n, support: false });
  const { log } = silentLogger();
  const agent = createAgent({
    config: loadConfig({ api: { baseUrl: 'http://api.test' }, chain: { chainId: 84532, governance: '0x' + '9'.repeat(40), usdc: CHALLENGE.asset } }),
    account,
    payer: payerFor(acct),
    chainReader: createStubChainReader(chainFixture(), govFixture(vote.commitment)),
    log,
    fetchImpl: mockApi().fetchImpl,
    entryMarks: { [V_HELD]: WAD },
    nowSec: () => NOW,
  });
  const r = await agent.tick();
  assert.equal(r.intents[0].kind, 'reveal');
  assert.ok(r.intents.findIndex((i) => i.kind === 'deposit') > r.intents.findIndex((i) => i.kind === 'exit'), 'new exposure is taken on last');
});

// ── execute mode ────────────────────────────────────────────────────────────

test('EXECUTE: refuses to start without the env var', async () => {
  await assert.rejects(() => harness({ mode: 'execute', env: {} }), /AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS/);
});

test('EXECUTE: refuses to start without an account', async () => {
  const { log } = silentLogger();
  assert.throws(
    () =>
      createAgent({
        config: loadConfig({ mode: 'execute', chain: { usdc: CHALLENGE.asset } }),
        account: null,
        payer: null,
        chainReader: createStubChainReader({}, {}),
        log,
        env: { [EXECUTE_ENV_VAR]: 'yes' },
      }),
    /no viem account was injected/,
  );
});

test('EXECUTE: with both conditions met, intents are actually sent (against a mock client)', async () => {
  const sent = [];
  const walletClient = { writeContract: async (tx) => { sent.push(tx); return '0xhash' + sent.length; } };
  const { agent, lines } = await harness({ mode: 'execute', env: { [EXECUTE_ENV_VAR]: 'yes' }, walletClient });

  const r = await agent.tick();
  assert.equal(r.mode, 'execute');
  // A deposit sends TWO transactions: the ERC-20 approval and then the deposit itself.
  // VaultCore.deposit pulls with safeTransferFrom, so without the allowance it reverts
  // TransferFromFailed(0x6e1c8d15) before reaching any vault logic.
  const depositIntents = r.intents.filter((i) => i.kind === 'deposit').length;
  assert.equal(sent.length, r.intents.length + depositIntents, 'every due intent is sent, plus one approval per deposit');
  assert.equal(r.results.every((x) => x.sent === true), true);
  assert.ok(lines.some((l) => l.includes('[EXECUTE] sent')));

  const deposit = sent.find((t) => t.functionName === 'deposit');
  assert.equal(deposit.address, V_JOIN);
  assert.equal(deposit.args[0], 25n * USDC);

  // The approval must target the TOKEN, name the vault as spender, be for exactly the deposit
  // amount (so a successful deposit consumes it back to zero), and land BEFORE the deposit.
  const approve = sent.find((t) => t.functionName === 'approve');
  assert.ok(approve, 'a deposit must be preceded by an ERC-20 approval');
  assert.equal(approve.args[0], V_JOIN, 'the vault is the spender');
  assert.equal(approve.args[1], 25n * USDC, 'approve exactly the deposit amount, leaving no standing allowance');
  assert.ok(sent.indexOf(approve) < sent.indexOf(deposit), 'the approval must precede the deposit');
  assert.equal(r.results.find((x) => x.intent === 'deposit').approvalHash, '0xhash' + (sent.indexOf(approve) + 1));

  const exit = sent.find((t) => t.functionName === 'requestExit');
  assert.equal(exit.address, V_HELD);
  assert.equal(exit.args[0], 1_500n * USDC);
});

test('EXECUTE: a failing transaction is recorded, and the loop keeps going', async () => {
  const walletClient = { writeContract: async () => { throw Object.assign(new Error('nonce too low'), { shortMessage: 'nonce too low' }); } };
  const { agent } = await harness({ mode: 'execute', env: { [EXECUTE_ENV_VAR]: 'yes' }, walletClient });
  const r = await agent.tick();
  assert.equal(r.results.length, r.intents.length, 'one failure must not abort the remaining intents');
  assert.equal(r.results.every((x) => x.sent === false), true);
  assert.ok(r.results.every((x) => /nonce too low/.test(x.error)));
});

test('EXECUTE: still refuses skipWindow when the danger flag is off', async () => {
  // Two independent gates: the planner will not emit it, and the actor refuses it anyway.
  const sent = [];
  const walletClient = { writeContract: async (tx) => { sent.push(tx); return '0xh'; } };
  const { agent } = await harness({ mode: 'execute', env: { [EXECUTE_ENV_VAR]: 'yes' }, walletClient });
  const { createActor } = await import('../src/act.mjs');
  const { log } = silentLogger();
  const actor = createActor({ mode: 'execute', config: loadConfig({ chain: { usdc: CHALLENGE.asset } }), account: { address: '0x' + '1'.repeat(40) }, chainReader: createStubChainReader({}, {}), log, walletClient });
  const res = await actor.run({ kind: 'skip-window', vault: V_JOIN, args: {}, dueAtSec: 0, reason: 'forced' });
  assert.equal(res.refused, true);
  assert.match(res.error, /IRREVERSIBLE/);
  assert.equal(sent.length, 0, 'nothing may be sent for a refused intent');
  void agent;
});

// ── budget interaction ──────────────────────────────────────────────────────

test('an exhausted spend cap SKIPS paid reads and the loop still produces a decision', async () => {
  // One cent of budget buys the vault list and nothing else. The agent must degrade, not crash.
  const api = mockApi();
  const { agent, lines } = await harness({ config: { api: { payments: { maxSessionSpendUsdc: '0.01', maxSingleReadUsdc: '0.05' } } }, api });
  const r = await agent.tick();

  assert.equal(api.paidCalls.length, 1, 'exactly one paid read fits in a one-cent budget');
  assert.ok(r.world.gaps.length > 0, 'the missing data must be NAMED, not silently treated as absent');
  assert.ok(lines.some((l) => l.includes('session spend cap reached')));
  assert.equal(r.budget.spentUsdc, '0.01');
  assert.ok(Array.isArray(r.intents), 'the loop still completes and decides on what it has');
});

test('with no leaderboard, the join gate fails CLOSED rather than assuming a good operator', async () => {
  const { agent } = await harness({ config: { api: { payments: { maxSessionSpendUsdc: '0.01', maxSingleReadUsdc: '0.05' } } } });
  const r = await agent.tick();
  assert.equal(r.intents.filter((i) => i.kind === 'deposit').length, 0, 'no track record ⇒ no join');
});

test('a failing paid route degrades to a named gap instead of throwing', async () => {
  const { agent } = await harness({ api: mockApi({ failPaid: true }) });
  const r = await agent.tick();
  assert.ok(r.world.gaps.some((g) => /vault list unavailable/.test(g)));
  assert.equal(r.intents.length, 0);
});

// ── scheduling ──────────────────────────────────────────────────────────────

test('a pending deposit inside the observation window is SCHEDULED, not activated, and never skipped', async () => {
  const fixture = chainFixture();
  fixture[V_JOIN].self = { pendingAmount: 25n * USDC, pendingAvailableAt: NOW + 3600 };
  const { log } = silentLogger();
  const acct = privateKeyToAccount(generatePrivateKey());
  const agent = createAgent({
    config: loadConfig({ api: { baseUrl: 'http://api.test' }, chain: { chainId: 84532, governance: '0x' + '9'.repeat(40), usdc: CHALLENGE.asset } }),
    account: { address: acct.address, signMessage: (a) => acct.signMessage(a) },
    payer: payerFor(acct),
    chainReader: createStubChainReader(fixture, govFixture()),
    log,
    fetchImpl: mockApi().fetchImpl,
    entryMarks: { [V_HELD]: WAD },
    nowSec: () => NOW,
  });
  const r = await agent.tick();
  const activate = r.intents.find((i) => i.kind === 'activate');
  assert.ok(activate, 'the scheduled activate must be visible now, not discovered later');
  assert.equal(activate.dueAtSec, NOW + 3600 + 60, 'due at the REAL window end plus the grace period');
  assert.ok(r.deferred.includes(activate), 'and deferred, not run');
  assert.equal(r.results.find((x) => x.intent === 'activate'), undefined);
  assert.equal(r.intents.filter((i) => i.kind === 'skip-window').length, 0);
});

test('the planner cannot emit skipWindow under the default config, whatever the world looks like', async () => {
  const { log } = silentLogger();
  const fixture = chainFixture();
  fixture[V_JOIN].self = { pendingAmount: 25n * USDC, pendingAvailableAt: NOW + 999999 };
  fixture[V_HELD].self = { ...fixture[V_HELD].self, pendingAmount: 1n, pendingAvailableAt: NOW + 999999, shares: 0n };
  const world = {
    nowSec: NOW,
    member: '0x' + '5'.repeat(40),
    heldVaultCount: 0,
    vaults: Object.entries(fixture).map(([vault, chain]) => ({
      summary: { vault, operatorId: chain.operatorId, depth: 0 },
      chain: { ...chain, vault, navReadable: true },
      fees: { stackedPerfFeeBps: 1000, stackedExitFeeCapBps: 100, depth: 0 },
      governance: { hasPendingExecution: false, proposal: null, hasOutstandingCommit: false },
      registryOperatorId: chain.operatorId,
      operatorRow: null,
    })),
  };
  const { intents } = plan({ world, config: loadConfig(), log });
  assert.equal(intents.filter((i) => i.kind === 'skip-window').length, 0);
});

// ── logging hygiene ─────────────────────────────────────────────────────────

test('the config dump never contains key material or a signer', async () => {
  const { agent, account } = await harness();
  const dump = JSON.stringify(agent.describe());
  assert.ok(dump.includes(account.address), 'the public address is fine to print');
  assert.ok(!/signMessage|signTypedData|privateKey/.test(dump), `a signer leaked into the dump: ${dump}`);
});

test('the startup banner states the signing scope in the artifact, not just the docs', async () => {
  const { agent, lines } = await harness();
  agent.declareScope();
  const text = lines.join('\n');
  assert.match(text, /WILL NOT sign or send any on-chain transaction/);
  assert.match(text, /WILL sign x402 payment authorizations/);
  assert.match(text, /skipWindow \(irreversible\): disabled/);
});

test('a tick that throws does not kill the session', async () => {
  const { log } = silentLogger();
  const acct = privateKeyToAccount(generatePrivateKey());
  const agent = createAgent({
    config: loadConfig({ api: { baseUrl: 'http://api.test' }, chain: { usdc: CHALLENGE.asset } }),
    account: { address: acct.address, signMessage: (a) => acct.signMessage(a) },
    payer: payerFor(acct),
    chainReader: { readVault: async () => { throw new Error('rpc exploded'); }, readOperatorId: async () => null, readStackedFees: async () => ({}), readGovernance: async () => ({}) },
    log,
    fetchImpl: mockApi().fetchImpl,
    nowSec: () => NOW,
  });
  const ticks = await agent.loop({ maxTicks: 2, sleep: async () => {} });
  assert.equal(ticks.length, 2, 'the loop survives so the next tick can rediscover its obligations');
  assert.ok(ticks.every((t) => /rpc exploded/.test(t.error)));
});

// ── end-to-end: a degraded governance read must not drop a reveal ────────────

test('END TO END: a failed revealedOf read still produces the reveal intent', async () => {
  // The whole S-4 chain under a partial RPC failure: commitment readable, revealed unreadable.
  const acct = privateKeyToAccount(generatePrivateKey());
  const account = { address: acct.address, signMessage: (a) => acct.signMessage(a) };
  const vote = await buildVote({ account, chainId: 84532, vault: V_HELD, pid: 42n, support: true });

  const gov = govFixture(vote.commitment);
  gov[V_HELD].revealed = null; // the read failed
  gov[V_HELD].hasOutstandingCommit = true; // …which chain.mjs derives via `revealed !== true`

  const { log } = silentLogger();
  const agent = createAgent({
    config: loadConfig({ api: { baseUrl: 'http://api.test' }, chain: { chainId: 84532, governance: '0x' + '9'.repeat(40), usdc: CHALLENGE.asset } }),
    account,
    payer: payerFor(acct),
    chainReader: createStubChainReader(chainFixture(), gov),
    log,
    fetchImpl: mockApi().fetchImpl,
    entryMarks: { [V_HELD]: WAD },
    nowSec: () => NOW,
  });
  const r = await agent.tick();
  assert.equal(r.intents[0].kind, 'reveal', 'an unknown reveal status must not silently drop the obligation');
});

test('END TO END: an unreadable proposal warns instead of reporting "no active proposal"', async () => {
  const gov = { [V_HELD]: { hasPendingExecution: true, activePid: 42n, proposal: null, proposalUnknown: true, commitment: null, hasOutstandingCommit: false, revealed: null } };
  const acct = privateKeyToAccount(generatePrivateKey());
  const { log, lines } = silentLogger();
  const agent = createAgent({
    config: loadConfig({ api: { baseUrl: 'http://api.test' }, chain: { chainId: 84532, governance: '0x' + '9'.repeat(40), usdc: CHALLENGE.asset } }),
    account: { address: acct.address, signMessage: (a) => acct.signMessage(a) },
    payer: payerFor(acct),
    chainReader: createStubChainReader(chainFixture(), gov),
    log,
    fetchImpl: mockApi().fetchImpl,
    entryMarks: { [V_HELD]: WAD },
    nowSec: () => NOW,
  });
  const r = await agent.tick();
  const d = r.decisions.find((x) => x.kind === 'vote' && x.vault === V_HELD);
  assert.equal(d.degraded, true);
  assert.ok(lines.some((l) => l.includes('could NOT be read')), 'the operator must see that this is unknown');
});

test('END TO END: voting weight comes from the snapshot measure, not the share balance', async () => {
  // Shares deposited after the proposal opened carry no vote. A commit built on sharesOf would be
  // a vote that can never count.
  const fixture = chainFixture();
  fixture[V_HELD].votingEligibleShares = 0n; // no snapshot weight…
  fixture[V_HELD].self = { ...fixture[V_HELD].self, shares: 1_500n * USDC }; // …despite holding shares
  const gov = govFixture();
  gov[V_HELD].hasPendingExecution = false;
  gov[V_HELD].proposal = { ...gov[V_HELD].proposal, commitDeadline: NOW + 600 }; // commit phase open

  const acct = privateKeyToAccount(generatePrivateKey());
  const { log } = silentLogger();
  const agent = createAgent({
    config: loadConfig({ api: { baseUrl: 'http://api.test' }, chain: { chainId: 84532, governance: '0x' + '9'.repeat(40), usdc: CHALLENGE.asset } }),
    account: { address: acct.address, signMessage: (a) => acct.signMessage(a) },
    payer: payerFor(acct),
    chainReader: createStubChainReader(fixture, gov),
    log,
    fetchImpl: mockApi().fetchImpl,
    entryMarks: { [V_HELD]: WAD },
    nowSec: () => NOW,
  });
  const r = await agent.tick();
  assert.equal(r.intents.filter((i) => i.kind === 'commit').length, 0, 'zero snapshot weight ⇒ no commit');
  const d = r.decisions.find((x) => x.kind === 'vote' && x.vault === V_HELD);
  assert.match(d.reason, /no voting-eligible stake/);
});

test('END TO END: with snapshot weight, the commit is cast', async () => {
  const fixture = chainFixture();
  fixture[V_HELD].votingEligibleShares = 1_500n * USDC;
  const gov = govFixture();
  gov[V_HELD].hasPendingExecution = false;
  gov[V_HELD].proposal = { ...gov[V_HELD].proposal, commitDeadline: NOW + 600 };

  const acct = privateKeyToAccount(generatePrivateKey());
  const { log } = silentLogger();
  const agent = createAgent({
    config: loadConfig({ api: { baseUrl: 'http://api.test' }, chain: { chainId: 84532, governance: '0x' + '9'.repeat(40), usdc: CHALLENGE.asset } }),
    account: { address: acct.address, signMessage: (a) => acct.signMessage(a) },
    payer: payerFor(acct),
    chainReader: createStubChainReader(fixture, gov),
    log,
    fetchImpl: mockApi().fetchImpl,
    entryMarks: { [V_HELD]: WAD },
    nowSec: () => NOW,
  });
  const r = await agent.tick();
  const commit = r.results.find((x) => x.intent === 'commit');
  assert.ok(commit, 'drift of 3000bps is above the band, so the evaluator supports it');
  assert.equal(commit.call.functionName, 'commitVote');
  assert.equal(commit.sent, false, 'still a dry run');
});
