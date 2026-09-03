// @ts-check
/**
 * Review107 F1 regression. A snapshot written BEFORE VaultState gained its exit counters
 * (protocol/main @ 29b1b470) must resume with those counters at 0 — not `undefined`, which
 * `+= 1` turns into NaN, which every derived metric then returns, and which the NEXT snapshot
 * write persists as `null`. A live indexer would carry that corruption forward silently across
 * an upgrade, and serve it from the paid /vaults/{addr} response.
 *
 * The defence restores every field of `newVault()` the stored record has no usable value for, so a
 * field added in any future release defaults the same way. The second test proves that property
 * directly — over BOTH degraded shapes a JSON round-trip can produce, which is why its name may say
 * "every".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deserializeState, serializeState } from '../src/store.mjs';
import { applyAll, apply, modeFExitRateBps, queuedExitBacklog, newVault } from '../src/projections.mjs';

const V = '0x' + '1'.repeat(40);
const A = '0x' + 'a'.repeat(40);
const ev = (name, blockNumber, logIndex, vault, args) => ({ name, vault, blockNumber, logIndex, args });

/** Exactly what the pre-#107 serializer wrote for a vault: no exit counters, no new collections. */
function legacySnapshot() {
  const built = applyAll([
    ev('VaultCreated', 1, 0, V, { vault: V, creator: A, usdc: A, capacityCapUsdc: 1n }),
    ev('DepositActivated', 2, 0, V, { member: A, amountUsdc: 100n, sharesMinted: 100n }),
  ]);
  const json = JSON.parse(JSON.stringify(serializeState(built)));
  for (const [, v] of json.vaults) {
    delete v.exitQueuedCount;
    delete v.exitSettledCount;
    delete v.modeFSettledCount;
  }
  delete json.eventStats;
  delete json.adapters;
  delete json.queuedExits;
  return json;
}

test('a pre-#107 snapshot resumes with exit counters at 0 and keeps counting', () => {
  const s = deserializeState(legacySnapshot());
  assert.equal(s.vaults.get(V).exitQueuedCount, 0);
  assert.equal(s.vaults.get(V).exitSettledCount, 0);
  assert.equal(s.vaults.get(V).modeFSettledCount, 0);
  assert.equal(modeFExitRateBps(s, V), null, 'no settled exits yet');

  apply(s, ev('ExitQueued', 3, 0, V, { member: A, shares: 50n }));
  assert.equal(queuedExitBacklog(s, V), 1);
  apply(s, ev('ExitSettled', 4, 0, V, { member: A, sharesBurned: 50n, usdcPaid: 50n, exitFeeBps: 0n, perfFeeUsdc: 0n }));
  assert.equal(s.vaults.get(V).exitQueuedCount, 1);
  assert.equal(s.vaults.get(V).exitSettledCount, 1);
  assert.equal(s.vaults.get(V).modeFSettledCount, 1);
  assert.equal(modeFExitRateBps(s, V), 10000);

  const again = JSON.parse(JSON.stringify(serializeState(s)));
  assert.equal(again.vaults[0][1].exitQueuedCount, 1, 'survives the next snapshot write');
  assert.equal(again.vaults[0][1].modeFSettledCount, 1);
});

/** A v1 snapshot whose vault record has ONE field degraded, in one of the two shapes JSON can emit. */
function snapshotWithFieldDegraded(field, shape) {
  const json = legacySnapshot();
  for (const [, v] of json.vaults) {
    if (shape === 'absent') delete v[field];
    else v[field] = null;
  }
  return json;
}

/**
 * The name says EVERY, so the body may not check one case and stop.
 *
 * The FIELDS are derived, not listed: `Object.entries(newVault(V))` enumerates them from the
 * constructor itself, so a field added tomorrow is covered without editing this test.
 *
 * The SHAPES are two, and two is the complete set rather than a sample: a snapshot is written with
 * `JSON.stringify`, which OMITS a key whose value is `undefined` and writes `null` for `NaN` and
 * `±Infinity`. There is no third way for a field to come back degraded from disk. `absent` is the
 * shape the old `{ ...newVault(k), ...v }` spread handled; `null` is the shape it did NOT, and is
 * exactly what a counter corrupted to NaN by the code on protocol/main serializes to.
 */
test('EVERY vault field defaults structurally, including ones added after this test was written', () => {
  const fields = Object.entries(newVault(V));
  assert.ok(fields.length >= 13, 'field enumeration came back suspiciously small');

  for (const shape of /** @type {const} */ (['absent', 'null'])) {
    for (const [field, zero] of fields) {
      const v = deserializeState(snapshotWithFieldDegraded(field, shape)).vaults.get(V);
      assert.notEqual(v[field], undefined, `${shape}: ${field} resumed as undefined — add it to newVault()`);
      if (typeof zero === 'number') {
        assert.ok(Number.isFinite(v[field]), `${shape}: ${field} resumed as ${v[field]}, not a finite number`);
      }
      if (typeof zero === 'bigint') {
        assert.equal(typeof v[field], 'bigint', `${shape}: ${field} resumed as ${typeof v[field]}, not a bigint`);
      }
    }
  }
});

/**
 * The upgrade path that actually exists. #107 merged with its counter defect unfixed, so an indexer
 * running protocol/main today writes `null` (not a missing key) for a counter that went NaN — and
 * `main -> this branch` is the only upgrade any live indexer can take.
 */
test('a snapshot written by merged main, with null counters, does not resume into NaN', () => {
  const json = legacySnapshot();
  for (const [, v] of json.vaults) {
    v.exitQueuedCount = null;   // JSON.stringify(NaN) === null
    v.exitSettledCount = null;
    delete v.modeFSettledCount; // did not exist in that release at all
  }

  const s = deserializeState(json);
  assert.equal(s.vaults.get(V).exitQueuedCount, 0);
  assert.equal(s.vaults.get(V).exitSettledCount, 0);
  assert.equal(modeFExitRateBps(s, V), null, 'no settled exits -> null, never NaN');

  apply(s, ev('ExitQueued', 3, 0, V, { member: A, shares: 50n }));
  apply(s, ev('ExitSettled', 4, 0, V, { member: A, sharesBurned: 50n, usdcPaid: 50n, exitFeeBps: 0n, perfFeeUsdc: 0n }));
  assert.equal(modeFExitRateBps(s, V), 10000);

  // The paid /vaults/{addr} response declares these `integer` in docs/api/openapi.yaml; a resumed
  // `null` would be served against that schema.
  const again = JSON.parse(JSON.stringify(serializeState(s)));
  assert.equal(again.vaults[0][1].exitQueuedCount, 1);
  assert.equal(again.vaults[0][1].exitSettledCount, 1);
});

/** A null in a bigint field is not a NaN, it is a CRASH: `BigInt(null)` throws TypeError. */
test('null bigint fields resume as 0n rather than throwing out of BigInt()', () => {
  for (const field of ['totalShares', 'idleUsdc', 'capacityCapUsdc']) {
    const s = deserializeState(snapshotWithFieldDegraded(field, 'null'));
    assert.equal(s.vaults.get(V)[field], 0n, `${field} did not resume as 0n`);
  }
});

test('VERSION is NOT bumped for additive fields — a bump would make every live snapshot unloadable', () => {
  // deserializeState rejects any version !== VERSION, so a bump is not a migration, it is an
  // outage: loadSnapshot rethrows, the daemon dies on restart, verifySnapshot reports UNUSABLE.
  const legacy = legacySnapshot();
  assert.equal(legacy.version, 1);
  assert.doesNotThrow(() => deserializeState(legacy));
  assert.throws(() => deserializeState({ ...legacy, version: 2 }), /unsupported snapshot version/);
});
