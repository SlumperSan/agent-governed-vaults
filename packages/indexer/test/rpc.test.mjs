// @ts-check
/**
 * Integration test for the RPC chain source with a MOCKED viem client (no live RPC, no viem).
 * The fake `getLogs` mimics viem's real return shape — `log.address` LOWERCASED, decoded address
 * `args` EIP-55 CHECKSUMMED — which is exactly the split-state hazard the source must neutralize.
 * Covers: address canonicalization, dynamic vault discovery, same-batch capture, global ordering,
 * resume seeding, and the full fold through the daemon.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { createChainSource } from '../src/rpc.mjs';
import { createIndexerDaemon } from '../src/daemon.mjs';
import { leaderboard, vaultView } from '../src/projections.mjs';

// Singleton addresses (config-supplied, canonical lowercase).
const FACTORY = '0x' + 'f'.repeat(40);
const OPREG = '0x' + 'e'.repeat(40);
const SUBREG = '0x' + 'd'.repeat(40);
const GOV = '0x' + 'c'.repeat(40);
const FEE_ENGINE = '0x' + '9'.repeat(40);
const ADDRESSES = { factory: FACTORY, operatorRegistry: OPREG, subvaultRegistry: SUBREG, governance: GOV };
const ADDRESSES_WITH_FEE_ENGINE = { ...ADDRESSES, feeEngine: FEE_ENGINE };

// A vault whose address has mixed case. viem gives us the checksummed form in decoded args and
// the lowercased form as the emitting log.address — the two must collapse to ONE projection key.
const V_CHECKSUM = '0xAbCdEf0000000000000000000000000000000001';
const V_LOWER = V_CHECKSUM.toLowerCase();
const MEMBER = '0x' + '2'.repeat(40);
const OPERATOR = '0x' + 'a'.repeat(40);

const L = (address, eventName, blockNumber, logIndex, args) => ({ address, eventName, blockNumber: BigInt(blockNumber), logIndex, args });

/** Build a fake viem client over a fixed log fixture. */
function fakeClient(logs, head) {
  return {
    async getBlockNumber() { return BigInt(head); },
    async getLogs({ address, events, fromBlock, toBlock }) {
      const wanted = new Set(events.map((e) => e.name));
      const addrs = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
      const addrSet = new Set(addrs);
      return logs.filter(
        (l) => addrSet.has(l.address.toLowerCase()) &&
          wanted.has(l.eventName) &&
          l.blockNumber >= fromBlock && l.blockNumber <= toBlock,
      );
    },
  };
}

// Deliberately OUT OF (block,logIndex) ORDER to prove fetchEvents sorts globally.
function fixture() {
  return [
    L(V_LOWER, 'DepositActivated', 12, 0, { member: MEMBER, amountUsdc: 100n, sharesMinted: 100n }),
    L(OPREG, 'OperatorRegistered', 5, 0, { opId: 1n, operator: OPERATOR }),
    L(FACTORY, 'VaultCreated', 10, 0, { vault: V_CHECKSUM, creator: OPERATOR, usdc: ('0x' + 'b'.repeat(40)), capacityCapUsdc: 6_000_000n }),
    L(OPREG, 'VaultAttested', 11, 0, { vault: V_CHECKSUM, opId: 1n }),
    L(OPREG, 'RealizationRecorded', 13, 0, { vault: V_CHECKSUM, opId: 1n, member: MEMBER, gainUsdc: 300n, lossUsdc: 100n, carryAfter: 0n }),
  ];
}

test('fetchEvents returns globally sorted, canonicalized events (checksum args + lowercased address collapse)', async () => {
  const src = createChainSource({ client: fakeClient(fixture(), 20), addresses: ADDRESSES });
  const events = await src.fetchEvents(1, 20);

  // Sorted by (blockNumber, logIndex) regardless of fixture order.
  const keys = events.map((e) => e.blockNumber);
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b), 'events not globally sorted');

  // Every vault reference is the ONE lowercase key — no checksummed leakage.
  const created = events.find((e) => e.name === 'VaultCreated');
  assert.equal(created.vault, V_LOWER);
  const attested = events.find((e) => e.name === 'VaultAttested');
  assert.equal(attested.vault, V_LOWER, 'VaultAttested vault must be canonicalized to match VaultCreated');
  const deposit = events.find((e) => e.name === 'DepositActivated');
  assert.equal(deposit.vault, V_LOWER, 'vault-scoped event must key off lowercased log.address');
});

test('dynamic discovery: a vault created and used in the SAME batch is fully captured', async () => {
  const src = createChainSource({ client: fakeClient(fixture(), 20), addresses: ADDRESSES });
  const events = await src.fetchEvents(1, 20);
  // VaultCreated (block 10) then DepositActivated on that vault (block 12), both in one fetch.
  assert.ok(events.some((e) => e.name === 'VaultCreated' && e.vault === V_LOWER));
  assert.ok(events.some((e) => e.name === 'DepositActivated' && e.vault === V_LOWER));
  assert.deepEqual([...src.knownVaults], [V_LOWER]);
});

test('folds through the daemon into a single, correct vault + leaderboard', async () => {
  const path = join(tmpdir(), `rpc-${process.pid}-${Date.now()}.json`);
  try {
    const src = createChainSource({ client: fakeClient(fixture(), 20), addresses: ADDRESSES });
    const d = createIndexerDaemon({ statePath: path, fetchEvents: src.fetchEvents, headBlock: src.headBlock, confirmations: 0, batchBlocks: 5000 });
    await d.catchUp();
    const state = d.getState();

    assert.equal(state.vaults.size, 1, 'casing split would produce 2 vault entries');
    const v = vaultView(state, V_LOWER);
    assert.ok(v, 'vault must be reachable by its canonical lowercase key');
    assert.equal(v.creator, OPERATOR);
    assert.equal(v.operatorId, 1);
    assert.equal(v.totalShares, 100n);
    assert.equal(v.capacityCapUsdc, 6_000_000n);

    const lb = leaderboard(state);
    assert.equal(lb[0].operatorId, 1);
    assert.equal(lb[0].netRealizedUsdc, 200n); // gain 300 - loss 100
    assert.equal(lb[0].vaultCount, 1);
  } finally {
    await rm(path, { force: true });
  }
});

test('feeEngine is an optional singleton: its events are only polled when an address is configured', async () => {
  const feeLog = L(FEE_ENGINE, 'FeeAssessed', 5, 0, { vault: V_LOWER, member: MEMBER, netGain: 100n, fee: 10n });

  const withoutFeeEngine = createChainSource({ client: fakeClient([feeLog], 20), addresses: ADDRESSES });
  const eventsWithout = await withoutFeeEngine.fetchEvents(1, 20);
  assert.ok(!eventsWithout.some((e) => e.name === 'FeeAssessed'), 'no feeEngine address configured — not polled');

  const withFeeEngine = createChainSource({ client: fakeClient([feeLog], 20), addresses: ADDRESSES_WITH_FEE_ENGINE });
  const eventsWith = await withFeeEngine.fetchEvents(1, 20);
  assert.ok(eventsWith.some((e) => e.name === 'FeeAssessed'), 'feeEngine address configured — polled like any other singleton');
});

test('adapter discovery: an adapter used and swapped through in the SAME batch is fully captured', async () => {
  const ADAPTER = '0x' + '7'.repeat(40);
  const logs = [
    ...fixture(),
    L(V_LOWER, 'RebalanceExecuted', 14, 0, { adapter: ADAPTER, orderCount: 1n }),
    L(ADAPTER, 'SwapExecuted', 14, 1, { vault: V_LOWER, tokenIn: ('0x' + '4'.repeat(40)), tokenOut: ('0x' + '5'.repeat(40)), amountIn: 100n, amountOut: 99n }),
  ];
  const src = createChainSource({ client: fakeClient(logs, 20), addresses: ADDRESSES });
  const events = await src.fetchEvents(1, 20);

  assert.ok(events.some((e) => e.name === 'RebalanceExecuted' && e.args.adapter === ADAPTER));
  assert.ok(events.some((e) => e.name === 'SwapExecuted' && e.vault === V_LOWER), 'adapter learned from RebalanceExecuted, then polled in the same batch');
  assert.deepEqual([...src.knownAdapters], [ADAPTER]);
});

test('adapter resume seeding: SwapExecuted indexes even with no RebalanceExecuted in the current range', async () => {
  const ADAPTER = '0x' + '8'.repeat(40);
  const laterLogs = [L(ADAPTER, 'SwapExecuted', 30, 0, { vault: V_LOWER, tokenIn: ('0x' + '4'.repeat(40)), tokenOut: ('0x' + '5'.repeat(40)), amountIn: 1n, amountOut: 1n })];
  const src = createChainSource({ client: fakeClient(laterLogs, 40), addresses: ADDRESSES, knownAdapters: [ADAPTER] });
  const events = await src.fetchEvents(25, 35);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'SwapExecuted');
});

test('resume seeding: VaultCore events index even with no VaultCreated in the current range', async () => {
  // Simulate a restart: the vault was created & indexed in an earlier range; only a later
  // ExitSettled falls in this range. Seeding knownVaults from the resumed snapshot lets the
  // source poll VaultCore events without re-seeing VaultCreated.
  const laterLogs = [L(V_LOWER, 'ExitSettled', 30, 0, { member: MEMBER, sharesBurned: 40n, usdcPaid: 40n, exitFeeBps: 0n, perfFeeUsdc: 0n })];
  const src = createChainSource({ client: fakeClient(laterLogs, 40), addresses: ADDRESSES, knownVaults: [V_CHECKSUM] });
  const events = await src.fetchEvents(25, 35);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'ExitSettled');
  assert.equal(events[0].vault, V_LOWER, 'seeded vault key must be canonicalized to lowercase');
});
