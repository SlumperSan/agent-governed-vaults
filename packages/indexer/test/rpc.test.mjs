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
import { createChainSource, MAX_TRACKED_ADAPTERS } from '../src/rpc.mjs';
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
  const swap = events.find((e) => e.name === 'SwapExecuted');
  assert.ok(swap, 'adapter learned from RebalanceExecuted, then polled in the same batch');
  assert.equal(swap.emitter, ADAPTER, 'attributed to the contract that actually emitted it');
  assert.equal(swap.vault, null, "an adapter's `vault` ARG is a claim, never a projection key");
  assert.equal(swap.args.vault, V_LOWER, 'the claim is preserved in args for a consumer that verifies it');
  assert.deepEqual([...src.knownAdapters], [ADAPTER]);
});

test('a hostile adapter cannot attribute its SwapExecuted to a victim vault', async () => {
  // The full attack path, end to end. `VaultFactory.createVault` is permissionless and takes a
  // caller-supplied `allowedAdapters`, and `executeRebalance` accepts an EMPTY order array — so an
  // attacker stands up their own vault, allowlists their own contract, and pushes a no-op rebalance
  // through their own governance purely to get that contract into the indexer's polled set. It
  // then emits SwapExecuted naming SOMEONE ELSE'S vault. Note there is no defence available at
  // discovery time: VaultCore.executeRebalance already requires isAllowedAdapter on-chain, so an
  // `isAllowedAdapter` read would return true here. Attribution is the boundary that holds.
  const EVIL_VAULT = '0x' + '3'.repeat(40);
  const EVIL_ADAPTER = '0x' + '6'.repeat(40);
  const logs = [
    ...fixture(), // creates + funds the victim vault V_LOWER
    L(FACTORY, 'VaultCreated', 13, 0, { vault: EVIL_VAULT, creator: MEMBER, usdc: ('0x' + '2'.repeat(40)), capacityCapUsdc: 0n }),
    L(EVIL_VAULT, 'RebalanceExecuted', 14, 0, { adapter: EVIL_ADAPTER, orderCount: 0n }),
    L(EVIL_ADAPTER, 'SwapExecuted', 15, 0, { vault: V_LOWER, tokenIn: ('0x' + '4'.repeat(40)), tokenOut: ('0x' + '5'.repeat(40)), amountIn: 10n ** 30n, amountOut: 1n }),
  ];
  const src = createChainSource({ client: fakeClient(logs, 20), addresses: ADDRESSES });
  const events = await src.fetchEvents(1, 20);

  const spoof = events.find((e) => e.name === 'SwapExecuted');
  assert.ok(spoof, 'the log is still indexed — it is real, it is just not the victim vault’s');
  assert.equal(spoof.emitter, EVIL_ADAPTER);
  assert.equal(spoof.vault, null, 'MUST NOT be attributed to the victim vault');
  assert.notEqual(spoof.vault, V_LOWER);
  // And nothing else in the batch was re-pointed at the victim by the spoof.
  assert.ok(events.every((e) => e.name !== 'SwapExecuted' || e.vault !== V_LOWER));
});

// -- the discovery ceiling --
// Every count below is a LITERAL, never `MAX_TRACKED_ADAPTERS +/- 1`. A boundary written in terms
// of the constant follows the constant wherever it goes: the earlier version of these tests stayed
// green with the cap raised from 64 to 100000, which is the same as having no cap at all.
const adapterAt = (i) => '0x' + i.toString(16).padStart(40, '0');
const rebalances = (n, first = 1) =>
  Array.from({ length: n }, (_, i) => L(V_LOWER, 'RebalanceExecuted', 14, i, { adapter: adapterAt(first + i), orderCount: 0n }));

test('MAX_TRACKED_ADAPTERS is 64 -- the literal the boundary tests below are written against', () => {
  assert.equal(MAX_TRACKED_ADAPTERS, 64);
});

test('the discovery ceiling admits the 64th adapter and refuses the 65th', async () => {
  // ONE BELOW the ceiling: with 63 already discovered, the 64th still fits.
  const under = createChainSource({ client: fakeClient([...fixture(), ...rebalances(64)], 20), addresses: ADDRESSES });
  await under.fetchEvents(1, 20);
  assert.equal(under.discoveredAdapters.size, 64, 'the 64th adapter must be admitted');
  assert.ok(under.discoveredAdapters.has(adapterAt(64)), 'and it is the 64th specifically');

  // AT / ONE ABOVE: a 65th presented against a full set is refused, and the set stays at exactly 64.
  const capped = [];
  const over = createChainSource({
    client: fakeClient([...fixture(), ...rebalances(65)], 20), addresses: ADDRESSES,
    onAdapterCap: (info) => capped.push(info),
  });
  await over.fetchEvents(1, 20);
  assert.equal(over.discoveredAdapters.size, 64, 'the polled set is bounded at exactly 64');
  assert.ok(!over.discoveredAdapters.has(adapterAt(65)), 'the 65th must NOT be polled');

  assert.equal(capped.length, 1, 'ONE report per batch, not one per refused adapter');
  assert.deepEqual(capped[0].dropped, [adapterAt(65)]);
  assert.equal(capped[0].cap, 64);
  assert.equal(capped[0].phase, 'discovery');
});

test('a batch that refuses hundreds of adapters produces ONE warn, carrying the count', async () => {
  // The pre-fix callback fired once per adapter: 436 warn lines from a single hostile batch, which
  // is a warn channel nobody reads.
  const capped = [];
  const src = createChainSource({
    client: fakeClient([...fixture(), ...rebalances(500)], 20), addresses: ADDRESSES,
    onAdapterCap: (info) => capped.push(info),
  });
  await src.fetchEvents(1, 20);
  assert.equal(capped.length, 1, 'one report for the whole batch');
  assert.equal(capped[0].dropped.length, 436, '500 presented minus 64 admitted');
  assert.equal(capped[0].tracked, 64);
});

test('a resumed snapshot cannot reintroduce an unbounded adapter set, and says what it dropped', async () => {
  const many = Array.from({ length: 89 }, (_, i) => adapterAt(i + 1));
  const capped = [];
  const src = createChainSource({
    client: fakeClient([], 20), addresses: ADDRESSES, knownAdapters: many,
    onAdapterCap: (info) => capped.push(info),
  });
  assert.equal(src.discoveredAdapters.size, 64);
  // The resume path used to `.slice()` silently. Dropping adapters an EARLIER run was successfully
  // indexing, with nothing in the log, is the same defect as declining to discover them silently.
  assert.equal(capped.length, 1, 'the resume path must report, not just slice');
  assert.equal(capped[0].phase, 'resume');
  assert.equal(capped[0].dropped.length, 25, '89 seeded minus 64 kept');
});

// -- ADAPTER_ADDRESSES: trust established off-chain (Review107 F2, strong form) --

test('a configured adapter is polled without ever being discovered on-chain', async () => {
  // No RebalanceExecuted names it. Config alone is sufficient -- which is the point: nothing an
  // attacker can do on a permissionless chain adds to, removes from, or reorders this set.
  const CONFIGURED = '0x' + '9'.repeat(40);
  const logs = [L(CONFIGURED, 'SwapExecuted', 14, 0, { vault: V_LOWER, tokenIn: ('0x' + '4'.repeat(40)), tokenOut: ('0x' + '5'.repeat(40)), amountIn: 1n, amountOut: 1n })];
  const src = createChainSource({ client: fakeClient(logs, 20), addresses: ADDRESSES, configuredAdapters: [CONFIGURED] });
  const events = await src.fetchEvents(1, 20);

  assert.equal(events.filter((e) => e.name === 'SwapExecuted').length, 1);
  assert.deepEqual([...src.configuredAdapters], [CONFIGURED]);
  assert.equal(src.discoveredAdapters.size, 0, 'config is not discovery');
  // Config says WHICH address to poll. It does not make the `vault` argument inside that
  // address's logs true, so the attribution boundary is unchanged for configured adapters.
  assert.equal(events[0].vault, null);
  assert.equal(events[0].emitter, CONFIGURED);
});

test('a configured adapter is still polled when 500 hostile adapters have filled the ceiling', async () => {
  // R3, the honest case the ceiling used to break. Adapters are per-vault and caller-supplied
  // (VaultCore's constructor takes `allowedAdapters`; docs/DEPLOYMENT.md "Execution adapters
  // (per-vault)"), so the distinct count scales with CREATORS. Before this, whoever arrived after
  // the 64th slot -- honest or not -- was silently never polled again.
  const CONFIGURED = '0x' + '9'.repeat(40);
  const SWAP = L(CONFIGURED, 'SwapExecuted', 15, 0, { vault: V_LOWER, tokenIn: ('0x' + '4'.repeat(40)), tokenOut: ('0x' + '5'.repeat(40)), amountIn: 7n, amountOut: 7n });
  const src = createChainSource({
    client: fakeClient([...fixture(), ...rebalances(500), SWAP], 20), addresses: ADDRESSES,
    configuredAdapters: [CONFIGURED],
  });
  const events = await src.fetchEvents(1, 20);

  assert.equal(src.discoveredAdapters.size, 64, 'the ceiling still holds for discovered adapters');
  assert.ok(src.knownAdapters.has(CONFIGURED), 'the configured adapter is never crowded out');
  assert.equal(events.filter((e) => e.name === 'SwapExecuted' && e.emitter === CONFIGURED).length, 1,
    'its fills are indexed regardless of how many adapters an attacker stood up first');
});

test('a configured adapter does not consume a discovery slot', async () => {
  // If config counted against the ceiling, naming your own adapters would REDUCE how many others
  // you could discover -- a bound that punishes the configuration it tells operators to adopt.
  //
  // The configured adapter here is `adapterAt(1)`, which the rebalance logs ALSO name. That is the
  // case that matters and the one the first version of this test missed: an adapter that is both
  // configured and seen on-chain must be counted once, as configured, and must not take a slot.
  const src = createChainSource({
    client: fakeClient([...fixture(), ...rebalances(64)], 20), addresses: ADDRESSES,
    configuredAdapters: [adapterAt(1)],
  });
  await src.fetchEvents(1, 20);

  assert.ok(!src.discoveredAdapters.has(adapterAt(1)), 'a configured adapter is never ALSO discovered');
  assert.equal(src.knownAdapters.size, 64, 'no double-count: 63 discovered + 1 configured');
  // 63 others fit, and the ceiling is still measured against discovered adapters alone: presenting
  // adapters 2..64 leaves room, so the last of them is admitted rather than pushed out by config.
  assert.equal(src.discoveredAdapters.size, 63);
  assert.ok(src.discoveredAdapters.has(adapterAt(64)), 'the 64th discovered adapter still fits');
});

test('a configured adapter also survives a resume that overflows the seeded set', async () => {
  // A resumed snapshot normally CONTAINS the configured adapter (it was polled last run), so the
  // seed must exclude it before slicing. Otherwise it consumes one of the 64 seeded slots and
  // displaces a discovered adapter, while the union getter still shows it present -- which is why
  // the assertions below are on `discoveredAdapters`, not on `knownAdapters`.
  const CONFIGURED = adapterAt(1); // first in the snapshot, i.e. squarely inside the slice window
  const src = createChainSource({
    client: fakeClient([], 20), addresses: ADDRESSES,
    knownAdapters: Array.from({ length: 200 }, (_, i) => adapterAt(i + 1)),
    configuredAdapters: [CONFIGURED],
  });
  assert.ok(src.knownAdapters.has(CONFIGURED), 'never sliced away by a snapshot full of others');
  assert.ok(!src.discoveredAdapters.has(CONFIGURED), 'and it does not occupy a seeded discovery slot');
  assert.equal(src.discoveredAdapters.size, 64, '64 OTHER adapters still seeded');
  assert.ok(src.discoveredAdapters.has(adapterAt(65)), 'the 65th seeded adapter takes the slot config vacated');
});

test('adapter resume seeding: SwapExecuted indexes even with no RebalanceExecuted in the current range', async () => {
  const ADAPTER = '0x' + '8'.repeat(40);
  const laterLogs = [L(ADAPTER, 'SwapExecuted', 30, 0, { vault: V_LOWER, tokenIn: ('0x' + '4'.repeat(40)), tokenOut: ('0x' + '5'.repeat(40)), amountIn: 1n, amountOut: 1n })];
  const src = createChainSource({ client: fakeClient(laterLogs, 40), addresses: ADDRESSES, knownAdapters: [ADAPTER] });
  const events = await src.fetchEvents(25, 35);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'SwapExecuted');
  assert.equal(events[0].emitter, ADAPTER);
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
