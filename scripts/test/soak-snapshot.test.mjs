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
import path from 'node:path';
import { vaultsIn, headBlockOf, vaultRow } from '../soak/snapshot.mjs';

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

test('the LIVE indexer snapshot parses with these readers', (t) => {
  // Pins the helpers against the actual file the running daemon produces, so a change to the
  // store's serialization breaks a test rather than a drill at hour four.
  const p = path.join(import.meta.dirname, '..', '..', 'data', 'indexer-state.json');
  if (!fs.existsSync(p)) return t.skip('no live snapshot in this checkout');
  const snap = JSON.parse(fs.readFileSync(p, 'utf8'));
  const vaults = vaultsIn(snap);
  assert.ok(Array.isArray(vaults));
  for (const v of vaults) assert.match(v, /^0x[0-9a-f]{40}$/, `not a lowercase address: ${v}`);
  assert.equal(typeof headBlockOf(snap), 'number');
});
