// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { applyAll, apply, vaultView, leaderboard, queuedExitBacklog, modeFExitRateBps, memberPosition, emptyState } from '../src/projections.mjs';
import { serializeState, deserializeState, saveSnapshot, loadSnapshot, resumeCursor } from '../src/store.mjs';
import { createIndexerDaemon } from '../src/daemon.mjs';

const V = '0x' + '1'.repeat(40);
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const ev = (name, bn, li, vault, args) => ({ name, vault, blockNumber: bn, logIndex: li, args: { vault, ...args } });

function richState() {
  return applyAll([
    ev('VaultCreated', 1, 0, V, { creator: A, usdc: A, capacityCapUsdc: 6_000_000n }),
    ev('OperatorRegistered', 1, 1, V, { opId: 1, operator: A }),
    ev('VaultAttested', 1, 2, V, { opId: 1 }),
    ev('DepositActivated', 2, 0, V, { member: A, sharesMinted: 100n * 10n ** 12n }),
    ev('DepositActivated', 2, 1, V, { member: B, sharesMinted: 50n * 10n ** 12n }),
    { name: 'RealizationRecorded', vault: V, blockNumber: 3, logIndex: 0, args: { opId: 1, gainUsdc: 300n, lossUsdc: 100n } },
    { name: 'Proposed', vault: V, blockNumber: 4, logIndex: 0, args: { pid: 7, vault: V, ptype: 0, proposer: A } },
    { name: 'Revealed', vault: V, blockNumber: 4, logIndex: 1, args: { pid: 7, voter: A, support: true, weight: 1000n } },
  ]);
}

test('serialize → deserialize is a faithful round-trip (bigints + Maps preserved)', () => {
  const s = richState();
  const back = deserializeState(JSON.parse(JSON.stringify(serializeState(s))));
  assert.equal(back.lastBlock, s.lastBlock);
  assert.deepEqual(vaultView(back, V).totalShares, vaultView(s, V).totalShares);
  assert.equal(vaultView(back, V).totalShares, 150n * 10n ** 12n);
  assert.equal(back.vaults.get(V).capacityCapUsdc, 6_000_000n);
  assert.equal(leaderboard(back)[0].netRealizedUsdc, 200n);
  assert.equal(back.operators.get(1).vaultCount, 1);
  assert.equal(back.proposals.get(7).forWeight, 1000n);
  assert.equal(back.shares.get(V).get(A), 100n * 10n ** 12n);
});

test('serialize → deserialize round-trips eventStats and adapters', () => {
  const ADAPTER = '0x' + '7'.repeat(40);
  const events = [
    ev('VaultCreated', 1, 0, V, { creator: A, usdc: A, capacityCapUsdc: 1n }),
    ev('ExitQueued', 2, 0, V, { member: A, shares: 10n }),
    ev('RebalanceExecuted', 3, 0, V, { adapter: ADAPTER, orderCount: 1n }),
  ];
  const built = applyAll(events);
  const back = deserializeState(JSON.parse(JSON.stringify(serializeState(built))));
  assert.equal(back.eventStats.get('ExitQueued').count, 1);
  assert.equal(back.eventStats.get('ExitQueued').lastBlock, 2);
  assert.equal(back.eventStats.get('RebalanceExecuted').count, 1);
  assert.ok(back.adapters.has(ADAPTER));
  assert.equal(back.vaults.get(V).exitQueuedCount, 1);
});

test('deserializeState defaults eventStats/adapters to empty for a snapshot written before they existed', () => {
  const legacy = JSON.parse(JSON.stringify(serializeState(richState())));
  delete legacy.eventStats;
  delete legacy.adapters;
  const back = deserializeState(legacy);
  assert.equal(back.eventStats.size, 0);
  assert.equal(back.adapters.size, 0);
  assert.equal(back.lastBlock, richState().lastBlock);
});

test('snapshot survives a file save/load cycle', async () => {
  const path = join(tmpdir(), `idx-${process.pid}-${Date.now()}.json`);
  try {
    const s = richState();
    await saveSnapshot(path, s);
    const back = await loadSnapshot(path);
    assert.equal(vaultView(back, V).totalShares, 150n * 10n ** 12n);
    assert.equal(back.lastBlock, 4);
  } finally {
    await rm(path, { force: true });
  }
});

test('loadSnapshot returns fresh empty state when the file is absent', async () => {
  const back = await loadSnapshot(join(tmpdir(), `does-not-exist-${Date.now()}.json`));
  assert.equal(back.vaults.size, 0);
  assert.equal(resumeCursor(back).fromBlock, 0);
});

test('resumeCursor starts at 0 fresh, then at lastBlock+1', () => {
  assert.equal(resumeCursor(applyAll([])).fromBlock, 0);
  assert.equal(resumeCursor(richState()).fromBlock, 5);
});

// ── daemon: resume, poll, snapshot — with a fake client (no RPC) ──

test('daemon indexes, snapshots, and RESUMES from disk across restarts', async () => {
  const path = join(tmpdir(), `daemon-${process.pid}-${Date.now()}.json`);
  try {
    // A fake chain: events keyed by block.
    const byBlock = {
      1: [ev('VaultCreated', 1, 0, V, { creator: A, usdc: A, capacityCapUsdc: 1000n }),
          ev('OperatorRegistered', 1, 1, V, { opId: 1, operator: A }),
          ev('VaultAttested', 1, 2, V, { opId: 1 })],
      2: [ev('DepositActivated', 2, 0, V, { member: A, sharesMinted: 100n })],
      6: [ev('DepositActivated', 6, 0, V, { member: B, sharesMinted: 40n })],
    };
    let head = 7;
    const fetchEvents = async (from, to) => {
      const out = [];
      for (let b = from; b <= to; b++) if (byBlock[b]) out.push(...byBlock[b]);
      return out;
    };
    const headBlock = async () => head;

    // First run: head 7, confirmations 5 → safeHead 2, so only blocks 1..2 index.
    const d1 = createIndexerDaemon({ statePath: path, fetchEvents, headBlock, confirmations: 5, batchBlocks: 1000 });
    await d1.catchUp();
    assert.equal(d1.getState().vaults.get(V).totalShares, 100n, 'block 6 not yet confirmed');
    assert.equal(d1.getState().lastBlock, 2);

    // Chain advances; a NEW daemon instance resumes from the snapshot (simulates a restart).
    head = 12; // safeHead 7 → block 6 now confirmed
    const d2 = createIndexerDaemon({ statePath: path, fetchEvents, headBlock, confirmations: 5, batchBlocks: 1000 });
    await d2.init();
    assert.equal(d2.getState().lastBlock, 2, 'resumed from disk, not from zero');
    await d2.catchUp();
    assert.equal(d2.getState().vaults.get(V).totalShares, 140n, 'block 6 applied after restart');
    assert.equal(d2.getState().lastBlock, 7);
  } finally {
    await rm(path, { force: true });
  }
});

test('daemon is a no-op when caught up (no re-scan of empty ranges)', async () => {
  const path = join(tmpdir(), `daemon-noop-${process.pid}-${Date.now()}.json`);
  try {
    let fetchCalls = 0;
    const d = createIndexerDaemon({
      statePath: path,
      fetchEvents: async () => { fetchCalls++; return []; },
      headBlock: async () => 3, // safeHead = -2 with confirmations 5 → nothing to do
      confirmations: 5,
    });
    const applied = await d.tick();
    assert.equal(applied, 0);
    assert.equal(fetchCalls, 0, 'never fetched — head not yet past confirmations');
  } finally {
    await rm(path, { force: true });
  }
});

/**
 * `state.queuedExits` is the ONLY durable state this feature added, and it is what makes the
 * Mode-F discriminator exact rather than approximate. Deleting it from either serializer used to
 * leave the whole suite green: the sole mention of it in the test tree was a `delete` in a fixture.
 *
 * If it stops round-tripping, nothing throws. Every post-restart `ExitSettled` for a member who
 * queued BEFORE the restart is silently misclassified Mode-I, `modeFExitRateBps` under-reports,
 * and `queuedExitBacklog` reads 0 -- so the stranded-queue signal inverts to "all clear", which is
 * the failure mode where a silent bug is worse than a loud one.
 */
test('queuedExits survives a serialize -> deserialize -> settle cycle', () => {
  const s0 = applyAll([
    ev('VaultCreated', 1, 0, V, { creator: A, usdc: A, capacityCapUsdc: 0n }),
    ev('DepositActivated', 2, 0, V, { member: A, sharesMinted: 100n }),
    ev('DepositActivated', 2, 1, V, { member: B, sharesMinted: 100n }),
    ev('ExitQueued', 3, 0, V, { member: A, shares: 50n }),
    ev('ExitQueued', 3, 1, V, { member: B, shares: 50n }),
  ]);
  assert.equal(queuedExitBacklog(s0, V), 2);

  // Through JSON, not just through the two functions -- a Set that serialized as `{}` would
  // survive an in-memory round-trip and be lost on disk.
  const json = JSON.parse(JSON.stringify(serializeState(s0)));
  assert.deepEqual(json.queuedExits, [[V, [A, B]]], 'the Set must reach disk as an array of members');

  const s1 = deserializeState(json);
  assert.equal(queuedExitBacklog(s1, V), 2, 'the backlog resumed');

  // The discriminator still works across the restart: A queued before it, C never did.
  apply(s1, ev('ExitSettled', 4, 0, V, { member: A, sharesBurned: 50n }));
  assert.equal(s1.vaults.get(V).modeFSettledCount, 1, 'a member queued BEFORE the restart is Mode-F');
  assert.equal(queuedExitBacklog(s1, V), 1, 'and leaves the backlog');

  apply(s1, ev('ExitSettled', 4, 1, V, { member: A, sharesBurned: 1n }));
  assert.equal(s1.vaults.get(V).modeFSettledCount, 1, 'a second settle for the same member is Mode-I');
  assert.equal(s1.vaults.get(V).exitSettledCount, 2);
  assert.equal(modeFExitRateBps(s1, V), 5000);
});

/**
 * The SIZE of each queue entry is durable state too, and it fails differently from the membership
 * set above. `queuedExits` losing an entry misclassifies a settlement; `queuedExitShares` losing
 * one restores a member whose voting weight the projection then over-reports by the whole locked
 * amount -- which is the exact silence this field was added to end. A bigint that reached disk as
 * `{}` or as a number would be lost or rounded, so this goes through JSON, not just through the
 * two functions.
 */
test('queuedExitShares round-trips through JSON, and an older snapshot without it still loads', () => {
  const s0 = applyAll([
    ev('VaultCreated', 1, 0, V, { creator: A, usdc: A, capacityCapUsdc: 0n }),
    ev('DepositActivated', 2, 0, V, { member: A, sharesMinted: 2_000n }),
    ev('DepositActivated', 2, 1, V, { member: B, sharesMinted: 8_000n }),
    ev('ExitQueued', 3, 0, V, { member: A, shares: 2_000n }),
  ]);
  const json = JSON.parse(JSON.stringify(serializeState(s0)));
  assert.deepEqual(json.queuedExitShares, [[V, [[A, '2000']]]], 'bigints reach disk as decimal strings');

  const s1 = deserializeState(json);
  const pos = memberPosition(s1, V, A);
  assert.equal(pos.shares, 2_000n);
  assert.equal(pos.queuedExitShares, 2_000n, 'the locked amount survived the restart');
  assert.equal(pos.votingEligibleShares, 0n);

  // A snapshot written before this field existed: absent, not empty. It must still load, and the
  // membership set must still carry the Mode-F discriminator across the resume.
  delete json.queuedExitShares;
  const s2 = deserializeState(json);
  assert.equal(queuedExitBacklog(s2, V), 1, 'who is queued survives even when how much does not');

  // "How much does not" is a MISSING number, not a zero, and the two are different claims to a
  // member. `queuedExitShares: 0n` here would read as "nothing is locked" for a member the same
  // state knows is locked, and `votingEligibleShares` would then be `shares` — the whole position
  // reported as votable when the contract returns strictly less. Both come back null instead.
  const unknown = memberPosition(s2, V, A);
  assert.equal(unknown.queuedExitShares, null, 'an unknown locked amount is null, never 0');
  assert.equal(unknown.votingEligibleShares, null, 'and the eligible weight it feeds is null too');
  assert.match(unknown.votingEligibleNote ?? '', /queued Mode-F exit/,
    'and the note says so — null there is the schema\'s "nothing is withheld"');
});

/**
 * The same absence, reached the way an operator actually reaches it: NOT by deleting a key from a
 * snapshot this build wrote, but by loading a file this build never wrote. `store.mjs` keeps
 * `VERSION = 1`, so a snapshot from before the size book was folded LOADS rather than being
 * rejected, and `buildIndexer` calls `loadSnapshot` on every restart — so this is the default
 * upgrade path, not an edge case, and it runs on the paid /vaults/{addr}/members/{addr} route.
 *
 * The fixture is written out literally rather than derived from `serializeState`, because deriving
 * it from today's serializer is exactly the assumption under test. It is pinned against the current
 * key set below so it cannot quietly stop resembling a real snapshot.
 */
test('a snapshot written by pre-size-book code never tells a locked member their whole stake votes', () => {
  // Byte-for-byte what `serializeState` emitted before `queuedExitShares` existed: version 1, the
  // membership set present, the size book absent entirely.
  const preUpgrade = {
    version: 1,
    lastBlock: 3,
    lastLogIndex: 0,
    vaults: [[V, {
      vault: V, creator: A, usdc: A, operatorId: 0, totalShares: '10000', idleUsdc: '0',
      memberCount: 2, pendingCount: 0, capacityCapUsdc: '0', parent: null, depth: 0,
      exitQueuedCount: 1, exitSettledCount: 0, modeFSettledCount: 0,
    }]],
    operators: [],
    shares: [[V, [[A, '2000'], [B, '8000']]]],
    proposals: [],
    activeProposal: [],
    eventStats: [],
    adapters: [],
    queuedExits: [[V, [A]]],
  };
  // A file that no longer resembles what this build writes would stop testing the upgrade path and
  // start testing a museum piece. Today's keys, minus the one the old writer did not have.
  const writtenToday = Object.keys(serializeState(emptyState())).filter((k) => k !== 'queuedExitShares');
  assert.deepEqual(Object.keys(preUpgrade).sort(), writtenToday.sort(),
    'the pre-upgrade fixture is one field behind the current serializer, no more and no less — a ' +
    'field added since needs its own absent-means-unknown decision here');

  const resumed = deserializeState(preUpgrade);
  const pos = memberPosition(resumed, V, A);

  assert.equal(pos.shares, 2_000n, 'the holding is known: it comes from the shares book');
  assert.equal(pos.shareOfVaultBps, 2000);
  assert.equal(queuedExitBacklog(resumed, V), 1, 'and the state still knows this member is queued');

  // The blocker: before this fix these read 0n and 2000n with a null note, i.e. "your whole
  // position votes and nothing is withheld", on a member for whom VaultCore.votingEligibleShares
  // returns strictly less. Never over-report; say unknown instead.
  assert.equal(pos.queuedExitShares, null);
  assert.equal(pos.votingEligibleShares, null);
  assert.notEqual(pos.votingEligibleNote, null, 'a null note means nothing is withheld — it is not');
  assert.match(pos.votingEligibleNote, /queued Mode-F exit/);
  assert.match(pos.votingEligibleNote, /settleQueuedExit/, 'and how the lock ends');
});
