// @ts-check
/**
 * The outside-member track record: the registry's RealizationRecorded logs, read in bounded pages
 * from the vault's creation block, with every range that cannot be read named as a gap.
 *
 * These run the REAL chain reader over a fake viem client whose getLogs behaves like the two Arc
 * RPCs measured on 2026-10-18 (a range refusal at a span limit, a rate limit on the first requests,
 * a pruned history that answers confidently and empty). The property under test throughout is that
 * a range the agent could not read is never reported as an operator with no realizations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_LOG_PAGE_BLOCKS, REALIZATION_EVENT, VAULT_ATTESTED_EVENT, classifyRpcError, createChainReader } from '../src/chain.mjs';
import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';
import { createBudget } from '../src/budget.mjs';
import { plan } from '../src/plan.mjs';
import { decideJoin, outsideTrackRecord } from '../src/policy.mjs';
import { perceive } from '../src/perceive.mjs';
import { FACTORY, GOVERNANCE, REGISTRY, SUBVAULT_REGISTRY, addr, createFakeChainClient } from './fake-chain-client.mjs';

const USDC = 10n ** 6n;
const NOW = 1_700_000_000;
const VAULT = addr(0x4eae);
const OPERATOR_ID = 1;
const SEEDED = addr(0xa11ce); // a disclosed (seeded) address
const OUTSIDER = addr(0xb0b); // a member nobody disclosed
const CREATED = 1_000;
const HEAD = 26_000;

/** Realizations: the seeded address gains 50, the outsider gains 10 then loses 4, plus a 0/0 call. */
const REALIZATIONS = [
  { block: 1_500, vault: VAULT, opId: OPERATOR_ID, member: SEEDED, gain: 50n * USDC },
  { block: 5_000, vault: VAULT, opId: OPERATOR_ID, member: OUTSIDER }, // gain 0, loss 0: emitted, moves nothing
  { block: 12_000, vault: VAULT, opId: OPERATOR_ID, member: OUTSIDER, gain: 10n * USDC },
  { block: 20_000, vault: VAULT, opId: OPERATOR_ID, member: OUTSIDER, loss: 4n * USDC },
  { block: 21_000, vault: addr(0x9999), opId: 2, member: OUTSIDER, gain: 999n * USDC }, // another operator
];

const noSleep = async () => {};
const clientFor = (logs = {}) =>
  createFakeChainClient({ vaults: [{ address: VAULT, operatorId: OPERATOR_ID }], logs: { head: HEAD, created: { [VAULT]: CREATED }, realizations: REALIZATIONS, ...logs } });
const readerFor = (client) => createChainReader({ client, governance: GOVERNANCE, sleep: noSleep });
const read = (reader, over = {}) =>
  reader.readRealizations({ registry: REGISTRY, vault: VAULT, opId: OPERATOR_ID, pageBlocks: 10_000, pacingMs: 0, ...over });
const byMember = (r) => Object.fromEntries(r.members.map((m) => [m.member, m]));
const realizationRequests = (client) => client.logRequests.filter((q) => q.event === 'RealizationRecorded');

// ── a complete read ──────────────────────────────────────────────────────────

test('a complete scan finds the creation block exactly and sums gain and loss per member', async () => {
  const client = clientFor();
  const r = await read(readerFor(client));
  assert.equal(r.complete, true, r.gap ?? '');
  assert.equal(r.gap, null);
  assert.equal(r.creationBlock, CREATED, 'the bisection lands on the first block with code');
  assert.equal(r.scannedFrom, CREATED);
  assert.equal(r.scannedTo, HEAD);
  const m = byMember(r);
  assert.equal(m[SEEDED.toLowerCase()].gain, 50n * USDC);
  assert.equal(m[OUTSIDER.toLowerCase()].gain, 10n * USDC);
  assert.equal(m[OUTSIDER.toLowerCase()].loss, 4n * USDC);
  assert.equal(m[OUTSIDER.toLowerCase()].events, 3, 'the 0/0 call is an event but adds nothing to the sums');
  assert.equal(Object.keys(m).length, 2, 'another operator\'s realization is not in the figure');
});

test('the scan asks the registry, by operator id, for pages no wider than pageBlocks that tile the range with no gap', async () => {
  const client = clientFor();
  await read(readerFor(client));
  const reqs = realizationRequests(client);
  assert.ok(reqs.length >= 3);
  for (const q of reqs) {
    assert.equal(q.address, REGISTRY.toLowerCase());
    assert.equal(q.args.opId, BigInt(OPERATOR_ID), 'filtered on the operator id so the sum is comparable to the registry accumulators');
    assert.ok(q.to - q.from <= 9_999, `page ${q.from}..${q.to} is wider than 10,000 blocks`);
  }
  assert.equal(reqs[0].from, CREATED, 'nothing before the vault\'s creation is read');
  for (let i = 1; i < reqs.length; i++) assert.equal(reqs[i].from, reqs[i - 1].to + 1, 'pages are contiguous: a hole would drop realizations');
  assert.equal(reqs.at(-1).to, HEAD);
});

test('the event fragment names the fields the reader indexes by', () => {
  assert.deepEqual(
    REALIZATION_EVENT.inputs.map((i) => `${i.name}:${i.type}:${i.indexed}`),
    ['vault:address:true', 'opId:uint256:true', 'member:address:true', 'gainUsdc:uint256:false', 'lossUsdc:uint256:false', 'carryAfter:uint256:false'],
  );
});

// ── bounds: every one is a named gap ─────────────────────────────────────────

test('a provider range refusal narrows the page and the scan still completes with the right totals', async () => {
  const client = clientFor({ maxSpan: 3_999 });
  const r = await read(readerFor(client));
  assert.equal(r.complete, true, r.gap ?? '');
  assert.equal(r.pageBlocks, 2_500, 'the page halved until the provider accepted it');
  assert.equal(byMember(r)[OUTSIDER.toLowerCase()].gain, 10n * USDC);
  assert.ok(realizationRequests(client).some((q) => q.to - q.from > 3_999), 'the first request was the refused one');
});

test('a range refused even at the smallest page is a gap naming the provider error, not an empty result', async () => {
  const r = await read(readerFor(clientFor({ maxSpan: MIN_LOG_PAGE_BLOCKS - 2 })));
  assert.equal(r.complete, false);
  assert.match(r.gap ?? '', /range refused even at the smallest page.*requested range too large/);
});

test('a rate limit is retried with backoff and the scan completes', async () => {
  const sleeps = [];
  const reader = createChainReader({ client: clientFor({ throttleFirst: 3 }), sleep: async (ms) => void sleeps.push(ms) });
  const r = await read(reader);
  assert.equal(r.complete, true, r.gap ?? '');
  assert.deepEqual(sleeps.slice(0, 3), [1000, 2000, 4000], 'exponential backoff before the request that finally answers');
});

test('a rate limit that outlasts the retries is a named gap and the partial totals are not presented as complete', async () => {
  const r = await read(readerFor(clientFor({ throttleRealizations: 100 })));
  assert.equal(r.complete, false);
  assert.match(r.gap ?? '', /rate limited after retries.*rate limit exceeded/);
  const early = await read(readerFor(clientFor({ throttleFirst: 100 })));
  assert.equal(early.complete, false, 'a rate limit on the creation-block lookup is a gap too');
  assert.match(early.gap ?? '', /rate limit exceeded/);
});

test('an unreadable log window is a named gap, never zero realizations', async () => {
  const r = await read(readerFor(clientFor({ alwaysFail: 'internal error: logs unavailable' })));
  assert.equal(r.complete, false);
  assert.match(r.gap ?? '', /internal error: logs unavailable/);
  assert.deepEqual(r.members, [], 'no members were read, and the record says it is incomplete rather than empty-and-fine');
  // The policy turns that into a refusal that names the gap.
  const outside = outsideTrackRecord({ record: r, disclosed: [] });
  assert.equal(outside?.complete, false);
  const verdict = joinWith({ outside, profile: true });
  assert.equal(verdict.join, false);
  assert.ok(verdict.checks.some((c) => c.name === 'outside-track-record' && !c.ok && /internal error: logs unavailable/.test(c.detail)));
});

test('a tick\'s page budget stops the scan with a named gap and the next call resumes at the watermark with no double count', async () => {
  const client = clientFor();
  const reader = readerFor(client);
  const budget = { pages: 1 };
  const first = await read(reader, { budget });
  assert.equal(first.complete, false);
  assert.match(first.gap ?? '', /log-request budget is spent/);
  assert.equal(first.scannedTo, CREATED + 9_999);
  const second = await read(reader, { budget: { pages: 1_000 } });
  assert.equal(second.complete, true, second.gap ?? '');
  const m = byMember(second);
  assert.equal(m[SEEDED.toLowerCase()].gain, 50n * USDC, 'the page read on the first call was not read or added again');
  assert.equal(m[OUTSIDER.toLowerCase()].loss, 4n * USDC);
  const reqs = realizationRequests(client);
  assert.equal(new Set(reqs.map((q) => q.from)).size, reqs.length, 'no page was requested twice');
});

test('a vault older than maxBlocks leaves the unread blocks as a permanent named gap', async () => {
  const r = await read(readerFor(clientFor()), { maxBlocks: 10_000 });
  assert.equal(r.complete, false);
  assert.match(r.gap ?? '', /more than discovery\.logs\.maxBlocks \(10000\) behind the head; blocks 1000 to 16000 are not read/);
  assert.equal(r.scannedFrom, HEAD - 10_000 + 1);
});

test('a pruning RPC that answers 0x for old state does not move the creation block: the positive control refuses', async () => {
  // The bisection would land at 5,000 here (the first block the node still answers for), so the
  // realization at block 1,500 would be missing from a scan that looks complete.
  const r = await read(readerFor(clientFor({ prunedBefore: 5_000 })));
  assert.equal(r.complete, false);
  assert.match(r.gap ?? '', /creation block 5000 is unconfirmed/);
  assert.equal(r.creationBlock, null, 'no scan started');
});

test('a pruning RPC that answers [] for old logs is caught by the same control', async () => {
  const r = await read(readerFor(clientFor({ logsPrunedBefore: 5_000 })));
  assert.equal(r.complete, false);
  assert.match(r.gap ?? '', /unconfirmed/);
});

test('a vault with no code at the head is a gap', async () => {
  const client = createFakeChainClient({ vaults: [{ address: VAULT }], logs: { head: HEAD, created: {}, realizations: [] } });
  const r = await read(readerFor(client));
  assert.equal(r.complete, false);
  assert.match(r.gap ?? '', /no code at the head/);
});

test('classifyRpcError reads the codes and words the two Arc RPCs actually answer with', () => {
  assert.equal(classifyRpcError({ code: -32005, message: 'rate limit exceeded' }), 'throttled');
  assert.equal(classifyRpcError({ message: 'RPC Request failed.', details: '{"code":-32005,"message":"rate limit exceeded"}' }), 'throttled');
  assert.equal(classifyRpcError({ code: -32012, message: 'requested range too large' }), 'range');
  assert.equal(classifyRpcError({ code: -32602, message: 'query exceeds max block range 100000' }), 'range');
  assert.equal(classifyRpcError(new Error('connection reset')), 'other');
});

// ── the figure and the verdict ───────────────────────────────────────────────

const VAULT_ROW = { vault: VAULT, operatorId: OPERATOR_ID, memberCount: 0, depth: 0, parent: null, attested: true };
const CHAIN = {
  vault: VAULT,
  navPerShareWad: 10n ** 18n,
  navReadable: true,
  navError: null,
  totalAssetsUsdc: 0n,
  totalPendingUsdc: 0n,
  capacityCapUsdc: 0n,
  minDepositUsdc: 100n * USDC,
  self: {},
};
const FEES = { stackedPerfFeeBps: 1000, stackedExitFeeCapBps: 50, depth: 0 };
/** The operator row the registry would hold: the sum of all three members' realizations in the window. */
const ROW = { operatorId: OPERATOR_ID, netRealizedUsdc: String(56n * USDC), lifetimeGainUsdc: String(60n * USDC), lifetimeLossUsdc: String(4n * USDC) };

function joinWith({ outside, profile = false, row = ROW, join = {} }) {
  const config = loadConfig({ policy: { join: { ...(profile ? { profile: 'unproven-operator' } : {}), ...join } } });
  return decideJoin({ vault: VAULT_ROW, chain: CHAIN, operatorRow: row, fees: FEES, heldVaultCount: 0, config: config.policy.join, trackRecordExcludingDisclosed: outside });
}

test('outsideTrackRecord leaves disclosed addresses out of the figure, case-insensitively, and reconciles with the registry', async () => {
  const record = await read(readerFor(clientFor()));
  const outside = outsideTrackRecord({ record, disclosed: [SEEDED.toUpperCase().replace('0X', '0x')], registryRow: ROW });
  assert.ok(outside);
  assert.equal(outside.included.gain, 10n * USDC);
  assert.equal(outside.included.loss, 4n * USDC);
  assert.equal(outside.included.net, 6n * USDC);
  assert.equal(outside.excluded.gain, 50n * USDC);
  assert.equal(outside.reconciles, true, 'included plus excluded equals the registry accumulators');
  assert.equal(outsideTrackRecord({ record, disclosed: [], registryRow: { ...ROW, lifetimeGainUsdc: String(999n * USDC) } })?.reconciles, false);
  assert.equal(outsideTrackRecord({ record: null }), null);
});

test('exclusion changes a verdict: an operator proven only by a disclosed address is refused once the figure is applied', async () => {
  // The registry says the operator realized 50 USDC, all of it by SEEDED. Without the figure the
  // default policy joins; with SEEDED left out nothing is left, and the default requires a record.
  const seededOnly = [{ block: 1_500, vault: VAULT, opId: OPERATOR_ID, member: SEEDED, gain: 50n * USDC }];
  const row = { operatorId: OPERATOR_ID, netRealizedUsdc: String(50n * USDC), lifetimeGainUsdc: String(50n * USDC), lifetimeLossUsdc: '0' };
  const record = await read(readerFor(clientFor({ realizations: seededOnly })));
  const without = joinWith({ outside: null, row, join: { depositUsdc: '100' } });
  assert.equal(without.join, true, 'the registry figure alone admits it');
  const outside = outsideTrackRecord({ record, disclosed: [SEEDED], registryRow: row });
  const withIt = joinWith({ outside, row, join: { depositUsdc: '100' } });
  assert.equal(withIt.join, false);
  assert.ok(withIt.checks.some((c) => c.name === 'outside-track-record' && !c.ok && /an outside realization is required/.test(c.detail)));
  // Listing nobody changes nothing: the same record is proven by its own member.
  const unlisted = joinWith({ outside: outsideTrackRecord({ record, disclosed: [], registryRow: row }), row, join: { depositUsdc: '100' } });
  assert.equal(unlisted.join, true);
});

test('exclusion also catches outside losses hidden behind a disclosed gain, even under the unproven-operator profile', async () => {
  const masked = [
    { block: 1_500, vault: VAULT, opId: OPERATOR_ID, member: SEEDED, gain: 50n * USDC },
    { block: 12_000, vault: VAULT, opId: OPERATOR_ID, member: OUTSIDER, loss: 20n * USDC },
  ];
  const row = { operatorId: OPERATOR_ID, netRealizedUsdc: String(30n * USDC), lifetimeGainUsdc: String(50n * USDC), lifetimeLossUsdc: String(20n * USDC) };
  const record = await read(readerFor(clientFor({ realizations: masked })));
  assert.equal(joinWith({ outside: null, profile: true, row }).join, true, 'the registry net is positive');
  const verdict = joinWith({ outside: outsideTrackRecord({ record, disclosed: [SEEDED], registryRow: row }), profile: true, row });
  assert.equal(verdict.join, false);
  assert.ok(verdict.checks.some((c) => c.name === 'outside-track-record' && !c.ok && /net \$-20/.test(c.detail)));
});

test('under the profile an operator with no outside realization at all is admitted (that is the state it exists for)', async () => {
  const record = await read(readerFor(clientFor({ realizations: [] })));
  const row = { operatorId: OPERATOR_ID, netRealizedUsdc: '0', lifetimeGainUsdc: '0', lifetimeLossUsdc: '0' };
  const outside = outsideTrackRecord({ record, disclosed: [], registryRow: row });
  assert.equal(outside?.complete, true);
  assert.equal(joinWith({ outside, profile: true, row }).join, true);
  assert.equal(joinWith({ outside, profile: false, row }).join, false, 'without the profile the same operator is refused');
});

// ── perception and planning ──────────────────────────────────────────────────

const quiet = () => createLogger({ write: () => {}, nowSec: () => NOW });
const noApi = new Proxy({}, { get: () => () => { throw new Error('the API client was touched'); } });

function worldConfig(over = {}) {
  return loadConfig({
    chain: { preset: 'arc-mainnet', factory: FACTORY, operatorRegistry: REGISTRY, subvaultRegistry: SUBVAULT_REGISTRY, governance: GOVERNANCE },
    discovery: { logs: { pacingMs: 0 } },
    ...over,
  });
}
const perceiveWith = async (config, client) =>
  perceive({
    client: noApi,
    chainReader: createChainReader({ client, governance: GOVERNANCE, sleep: noSleep }),
    budget: createBudget({ maxSessionSpendUsdc: '0.25', maxSingleReadUsdc: '0.05', enabled: false }),
    config,
    member: null,
    log: quiet(),
    nowSec: NOW,
  });
const arcClient = (logs) =>
  createFakeChainClient({
    vaults: [{ address: VAULT, operatorId: OPERATOR_ID, holders: 0 }],
    operators: { [OPERATOR_ID]: { gain: 0n, loss: 0n } },
    logs: { head: HEAD, created: { [VAULT]: CREATED }, realizations: [], ...logs },
  });

test('default config with no disclosed addresses reads no logs at all', async () => {
  const client = arcClient();
  const world = await perceiveWith(worldConfig(), client);
  assert.equal(client.logRequests.length, 0);
  assert.equal(world.vaults[0].outsideRecord, null);
});

test('the profile reads the logs, and the join is a deposit of exactly the vault minimum', async () => {
  const client = arcClient();
  const config = worldConfig({ policy: { join: { profile: 'unproven-operator' } } });
  const world = await perceiveWith(config, client);
  assert.equal(world.vaults[0].outsideRecord?.complete, true, world.gaps.join('; '));
  const { intents, decisions } = plan({ world, config, log: quiet() });
  const join = decisions.find((d) => d.kind === 'join');
  assert.equal(join.join, true, join.reason);
  assert.deepEqual(intents.map((i) => i.kind), ['deposit']);
  assert.equal(intents[0].args.amountUsdc, 100n * USDC);
});

test('an unreadable window shows up in the world gaps and the plan does not join', async () => {
  const client = arcClient({ alwaysFail: 'logs unavailable' });
  const config = worldConfig({ policy: { join: { profile: 'unproven-operator' } } });
  const world = await perceiveWith(config, client);
  assert.ok(world.gaps.some((g) => /outside-member realizations for .*logs unavailable/.test(g)), world.gaps.join('; '));
  const { intents } = plan({ world, config, log: quiet() });
  assert.deepEqual(intents, []);
});

test('the per-tick page budget is shared by every vault, not granted to each', async () => {
  const client = arcClient();
  const config = worldConfig({ policy: { join: { profile: 'unproven-operator' } }, discovery: { logs: { pacingMs: 0, maxPagesPerTick: 2 } } });
  const world = await perceiveWith(config, client);
  assert.equal(realizationRequests(client).length, 2);
  assert.equal(world.vaults[0].outsideRecord?.complete, false);
  assert.match(world.vaults[0].outsideRecord?.gap ?? '', /budget is spent/);
});

// ── the event fragments against the compiled contract ────────────────────────

test('the event fragments match OperatorRegistry in contracts/out: name, order, types and which fields are indexed', async (t) => {
  const { existsSync, readFileSync } = await import('node:fs');
  const path = new URL('../../../contracts/out/OperatorRegistry.sol/OperatorRegistry.json', import.meta.url);
  if (!existsSync(path)) return t.skip('contracts/out/OperatorRegistry.sol is absent: run `forge build`');
  const abi = JSON.parse(readFileSync(path, 'utf8')).abi;
  const shape = (e) => `${e.name}(${e.inputs.map((i) => `${i.name}:${i.type}${i.indexed ? ':indexed' : ''}`).join(',')})`;
  for (const frag of [REALIZATION_EVENT, VAULT_ATTESTED_EVENT]) {
    const real = abi.find((e) => e.type === 'event' && e.name === frag.name);
    assert.ok(real, `OperatorRegistry has no ${frag.name} event`);
    assert.equal(shape(frag), shape(real), `${frag.name} drifted from the compiled event`);
  }
});
