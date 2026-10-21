// @ts-check
// Vault kind (spec section 5): which factory event created a vault. AgentVaultCreated is read from
// PR 483's VaultFactory; a regular vault still emits VaultCreated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll, listVaults, VAULT_KINDS } from '../src/projections.mjs';
import { serializeState, deserializeState } from '../src/store.mjs';

const V = '0x' + '1'.repeat(40);
const AGENT_V = '0x' + '2'.repeat(40);
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

function ev(name, blockNumber, logIndex, vault, args) {
  return { name, vault, blockNumber, logIndex, args: { vault, ...args } };
}

const agentCreated = (kind) =>
  ev('AgentVaultCreated', 1, 1, AGENT_V, { creator: B, usdc: A, capacityCapUsdc: 2n, identityRegistry: B, kind });

const fixture = () => applyAll([
  ev('VaultCreated', 1, 0, V, { creator: A, usdc: A, capacityCapUsdc: 1n }),
  agentCreated(1),
]);

test('kind is regular for VaultCreated and agent for AgentVaultCreated kind 1', () => {
  const s = fixture();
  assert.equal(s.vaults.get(V).kind, 'regular');
  assert.equal(s.vaults.get(AGENT_V).kind, 'agent');
  assert.equal(s.vaults.get(AGENT_V).creator, B);
  assert.equal(s.vaults.get(AGENT_V).capacityCapUsdc, 2n);
});

test('listVaults filters by kind and is unfiltered by default', () => {
  const s = fixture();
  assert.deepEqual(listVaults(s).map((r) => [r.vault, r.kind]), [[V, 'regular'], [AGENT_V, 'agent']]);
  assert.deepEqual(listVaults(s, { kind: 'regular' }).map((r) => r.vault), [V]);
  assert.deepEqual(listVaults(s, { kind: 'agent' }).map((r) => r.vault), [AGENT_V]);
});

test('listVaults refuses an unknown kind instead of returning an empty list', () => {
  assert.throws(() => listVaults(fixture(), { kind: 'bogus' }), /unknown vault kind/);
  assert.deepEqual([...VAULT_KINDS], ['regular', 'agent']);
});

test('a kind number the indexer does not know is stored as unknown, never as agent', () => {
  const s = applyAll([agentCreated(7)]);
  assert.equal(s.vaults.get(AGENT_V).kind, 'unknown');
  assert.equal(listVaults(s, { kind: 'agent' }).length, 0);
});

test('VaultFactory attests before it emits, so an earlier VaultAttested does not leave an agent vault regular', () => {
  const s = applyAll([ev('VaultAttested', 1, 0, AGENT_V, { opId: 1 }), agentCreated(1)]);
  assert.equal(s.vaults.get(AGENT_V).kind, 'agent');
});

test('kind survives a snapshot round trip, and a snapshot written before the field resumes as regular', () => {
  const resumed = deserializeState(JSON.parse(JSON.stringify(serializeState(fixture()))));
  assert.equal(resumed.vaults.get(AGENT_V).kind, 'agent');

  const old = JSON.parse(JSON.stringify(serializeState(fixture())));
  for (const [, rec] of old.vaults) delete rec.kind;
  assert.equal(deserializeState(old).vaults.get(AGENT_V).kind, 'regular');
});
