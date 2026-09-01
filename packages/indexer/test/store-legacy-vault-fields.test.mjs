// @ts-check
/**
 * Review107 F1 regression. A snapshot written BEFORE VaultState gained its exit counters
 * (protocol/main @ 29b1b470) must resume with those counters at 0 — not `undefined`, which
 * `+= 1` turns into NaN, which every derived metric then returns, and which the NEXT snapshot
 * write persists as `null`. A live indexer would carry that corruption forward silently across
 * an upgrade, and serve it from the paid /vaults/{addr} response.
 *
 * The defence is structural, not per-field: `deserializeState` spreads each resumed record over
 * `newVault()`, so a field added in any future release defaults the same way. The second test
 * proves that property directly, so it keeps holding for fields that do not exist yet.
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

test('EVERY vault field defaults structurally, including ones added after this test was written', () => {
  const json = legacySnapshot();
  // Strip the record down to the bare minimum a v1 snapshot is guaranteed to carry.
  const [[key, record]] = json.vaults;
  json.vaults = [[key, {
    vault: record.vault,
    totalShares: record.totalShares,
    idleUsdc: record.idleUsdc,
    capacityCapUsdc: record.capacityCapUsdc,
  }]];

  const v = deserializeState(json).vaults.get(V);
  for (const [field, zero] of Object.entries(newVault(V))) {
    assert.notEqual(v[field], undefined, `${field} resumed as undefined — add it to newVault()`);
    if (typeof zero === 'number') assert.ok(Number.isFinite(v[field]), `${field} is not a finite number`);
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
