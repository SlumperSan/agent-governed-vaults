// @ts-check
/**
 * Tests for indexer-snapshot reading (drill 1's dynamic-discovery evidence).
 *
 * These exist because the first version of drill 1 used `Object.keys(snap.vaults)`, which is
 * wrong in the worst possible way: `vaults` is a serialized Map — an array of [key, value]
 * pairs — so `Object.keys` returns `["0"]`, the array indices. It throws nothing. Drill 1 would
 * have waited five minutes, never matched a real address, and reported that the indexer failed
 * to discover vault B — a false failure filed against working software, which is exactly the
 * kind of finding a soak report must never contain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultsIn, headBlockOf, vaultRow } from '../soak/snapshot.mjs';
// The daemon's own projection and write path — see the comment above the last test in this file.
import { applyAll } from '../../packages/indexer/src/projections.mjs';
import { saveSnapshot } from '../../packages/indexer/src/store.mjs';

const SMOKE = '0x97025d1c60a24ce3811dcb3be4529c5e1c6a6330';

/** The real serialized-Map shape the indexer writes. */
const mapShape = () => ({
  version: 1,
  lastBlock: 45920517,
  vaults: [
    [SMOKE, { vault: SMOKE, operatorId: 1, totalShares: '0', depth: 0, parent: null }],
  ],
});

test('vaultsIn reads a serialized Map, not its array indices', () => {
  assert.deepEqual(vaultsIn(mapShape()), [SMOKE]);
});

test('vaultsIn does NOT return array indices', () => {
  // The precise regression: Object.keys on the pair-array yields ["0"].
  const got = vaultsIn(mapShape());
  assert.ok(!got.includes('0'), `leaked an array index into the vault list: ${JSON.stringify(got)}`);
});

test('vaultsIn lowercases so a checksummed address still matches', () => {
  const snap = mapShape();
  snap.vaults[0][1].vault = '0x97025D1c60A24Ce3811DCb3bE4529c5E1c6a6330';
  assert.deepEqual(vaultsIn(snap), [SMOKE]);
});

test('vaultsIn prefers the row\'s own vault field over the map key', () => {
  const snap = mapShape();
  snap.vaults[0][0] = 'some-other-key';
  assert.deepEqual(vaultsIn(snap), [SMOKE]);
});

test('vaultsIn handles a plain-object snapshot too', () => {
  assert.deepEqual(vaultsIn({ vaults: { [SMOKE]: { vault: SMOKE } } }), [SMOKE]);
});

test('vaultsIn returns empty rather than throwing on a missing/odd snapshot', () => {
  assert.deepEqual(vaultsIn({}), []);
  assert.deepEqual(vaultsIn(null), []);
  assert.deepEqual(vaultsIn({ vaults: [] }), []);
});

test('headBlockOf reads lastBlock (there is no cursor field)', () => {
  assert.equal(headBlockOf(mapShape()), 45920517);
  // The bug this pins: `snap.cursor` is undefined, and `undefined` recorded as the pre-drill
  // head would make the before/after comparison vacuous instead of failing loudly.
  assert.equal(headBlockOf({}), null);
});

test('vaultRow finds a vault case-insensitively', () => {
  const row = vaultRow(mapShape(), '0x97025D1c60A24Ce3811DCb3bE4529c5E1c6a6330');
  assert.ok(row, 'row not found');
  assert.equal(row.operatorId, 1);
  assert.equal(vaultRow(mapShape(), '0x' + '11'.repeat(20)), null);
});

// ---------------------------------------------------------------------------------------------
// THE REAL-WIRE CHECK. Every test above this line reads a snapshot HAND-WRITTEN IN THIS FILE, so
// it is evidence about `mapShape()` and not about the file the daemon writes. If `serializeState`
// stopped emitting `vaults` as a pair array tomorrow, all of them would stay green.
//
// IT USED TO READ `data/indexer-state.json` AND SKIP WHEN ABSENT, and that skip was the default
// state rather than an edge case: `.gitignore` line 7 ignores `data/`, so the file cannot exist in
// CI and cannot exist in a fresh clone. It could only appear on a machine that had run the daemon.
// The suite therefore reported a green nine tests whose one real-wire check had never run outside
// a developer's working directory — the fixtures-share-the-code's-assumption shape, with the one
// test that would catch a serialization change being the one that never ran.
//
// SO IT PRODUCES THE WIRE INSTEAD OF WAITING FOR IT. The bytes below come from the daemon's own
// write path, not from a fixture: `createIndexerDaemon` projects events with `apply` from
// `projections.mjs` (grep `for (const e of events) apply(state, e)`) and persists with
// `saveSnapshot`, which is `JSON.stringify(serializeState(state))`. This drives the same two
// functions and reads the resulting file back off disk. A committed fixture would have been the
// other option and is worse: it goes stale silently the first time the serializer changes, which
// is the event this test exists to catch.
// ---------------------------------------------------------------------------------------------
test('the readers parse what the indexer\'s own writer produces', async () => {
  const V = '0x' + '1'.repeat(40);
  const A = '0x' + 'a'.repeat(40);
  const ev = (name, blockNumber, logIndex, args) => ({ name, vault: V, blockNumber, logIndex, args: { vault: V, ...args } });

  const state = applyAll([
    ev('VaultCreated', 1, 0, { creator: A, usdc: '0x' + 'c'.repeat(40), capacityCapUsdc: 1000n }),
    ev('OperatorRegistered', 1, 1, { opId: 1, operator: A }),
    ev('VaultAttested', 1, 2, { opId: 1 }),
    ev('DepositActivated', 2, 0, { member: A, amountUsdc: 100n, sharesMinted: 100n * 10n ** 12n }),
  ]);
  state.lastBlock = 45920517;

  // `mkdtempSync` rather than a fixed name: around ten agent sessions share this machine and a
  // fixed path in the system temp directory is a collision between two of them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-snapshot-'));
  try {
    const p = path.join(dir, 'indexer-state.json');
    await saveSnapshot(p, state);
    const snap = JSON.parse(fs.readFileSync(p, 'utf8'));

    // The shape the whole file exists for: a pair array, not a plain object. Asserted against the
    // written bytes, so a serializer that stopped emitting pairs reds HERE rather than at hour
    // four of a drill.
    assert.ok(Array.isArray(snap.vaults), '`vaults` is no longer a serialized Map — drill 1 reads it as one');

    const vaults = vaultsIn(snap);
    assert.deepEqual(vaults, [V], 'the readers did not recover the one vault the writer serialized');
    for (const v of vaults) assert.match(v, /^0x[0-9a-f]{40}$/, `not a lowercase address: ${v}`);
    assert.equal(headBlockOf(snap), 45920517);

    const row = vaultRow(snap, V);
    assert.ok(row, 'vaultRow found nothing in a snapshot the writer just produced');
    assert.equal(row.operatorId, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
