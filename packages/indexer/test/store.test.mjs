// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { applyAll, vaultView, leaderboard } from '../src/projections.mjs';
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
