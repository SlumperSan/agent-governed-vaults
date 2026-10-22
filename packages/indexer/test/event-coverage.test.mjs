// @ts-check
/**
 * Cross-layer guard: every event the indexer folds must be a REAL event emitted by one of the
 * contracts it projects from. Reads the compiled Foundry ABIs, so a Solidity event rename or
 * signature change breaks this test instead of silently producing a wrong projection — the class
 * of drift the consumer-UX review caught (vaultCount, missing proposal state).
 *
 * Skips gracefully if the contracts haven't been built (contracts/out absent).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HANDLED_EVENTS } from '../src/projections.mjs';
import { allEventFragments, typeOf } from '../src/abis.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../../../contracts/out');

/**
 * Canonical full signature of an ABI event item: name, each input's type (structs expanded by
 * typeOf) and its indexed flag, so a retyped field or a moved `indexed` fails, not just a rename.
 * @param {{name:string, inputs:Array<{type:string, indexed?:boolean, components?:any}>}} item
 */
export function fullSignature(item) {
  return `${item.name}(${item.inputs.map((i) => `${typeOf(i)}${i.indexed ? ' indexed' : ''}`).join(',')})`;
}

/** Names that have no matching full signature in `compiled` (a Set of fullSignature strings). */
export function signatureDrift(fragments, compiled) {
  return fragments.map(fullSignature).filter((s) => !compiled.has(s));
}

/** Collect the event names and full signatures declared across the projected contracts' ABIs. */
function contractEvents() {
  const contracts = [
    'VaultCore.sol/VaultCore.json',
    'Governance.sol/Governance.json',
    'OperatorRegistry.sol/OperatorRegistry.json',
    'SubVaultRegistry.sol/SubVaultRegistry.json',
    'VaultFactory.sol/VaultFactory.json',
    'FeeEngine.sol/FeeEngine.json',
    'AggregationRouterAdapter.sol/AggregationRouterAdapter.json',
    'DirectPoolAdapter.sol/DirectPoolAdapter.json',
  ];
  const names = new Set();
  const signatures = new Set();
  for (const rel of contracts) {
    const p = join(OUT, rel);
    if (!existsSync(p)) continue;
    const abi = JSON.parse(readFileSync(p, 'utf8')).abi ?? [];
    for (const item of abi) {
      if (item.type !== 'event') continue;
      names.add(item.name);
      signatures.add(fullSignature(item));
    }
  }
  return Object.assign(names, { signatures });
}

const built = existsSync(OUT);

test('every indexer-handled event is a real contract event (no drift)', { skip: !built ? 'contracts not built' : false }, () => {
  const emitted = contractEvents();
  assert.ok(emitted.size > 0, 'no ABIs found — build contracts first');
  // shortcut: AgentVaultCreated is emitted only by PR 483's VaultFactory, which is not on
  // protocol/main yet; delete this exemption when #483 merges so the guard covers it again.
  const phantom = HANDLED_EVENTS.filter((e) => !emitted.has(e) && e !== 'AgentVaultCreated');
  assert.deepEqual(phantom, [], `indexer handles events no contract emits: ${phantom.join(', ')}`);
});

test('every embedded indexer fragment matches a compiled event by full signature (types + indexed)', { skip: !built ? 'contracts not built' : false }, () => {
  const { signatures } = contractEvents();
  const drift = signatureDrift(allEventFragments(), signatures);
  assert.deepEqual(drift, [], `indexer fragments with no compiled event of that exact signature: ${drift.join('; ')}`);
});

// Mutation probe, runs without contracts/out: the compiled side is the embedded fragments
// themselves, so any one-field change to a copy must turn the comparison red.
test('signature comparison catches a retyped field and a moved indexed flag', () => {
  const frags = allEventFragments();
  const compiled = new Set(frags.map(fullSignature));
  assert.deepEqual(signatureDrift(frags, compiled), [], 'unmutated fragments must be green');

  const target = frags.find((f) => f.name === 'Proposed');
  assert.ok(target, 'Proposed fragment present');
  const retyped = { ...target, inputs: target.inputs.map((i, n) => (n === 0 ? { ...i, type: 'uint128' } : i)) };
  assert.equal(signatureDrift([retyped], compiled).length, 1, 'a changed field type must be drift');
  const unindexed = { ...target, inputs: target.inputs.map((i, n) => (n === 0 ? { ...i, indexed: false } : i)) };
  assert.equal(signatureDrift([unindexed], compiled).length, 1, 'a changed indexed flag must be drift');
});

test('critical lifecycle events are covered by the indexer', { skip: !built ? 'contracts not built' : false }, () => {
  const emitted = contractEvents();
  // Events that MUST reach the projection for the product to work. If a contract emits one of
  // these and the indexer stops handling it, the leaderboard/vault/proposal views go stale.
  const critical = [
    'VaultCreated', 'VaultAttested', 'DepositActivated', 'ExitSettled',
    'Proposed', 'Finalized', 'Executed', 'RealizationRecorded', 'ChildRegistered',
  ];
  for (const e of critical) {
    assert.ok(emitted.has(e), `contract no longer emits critical event ${e}`);
    assert.ok(HANDLED_EVENTS.includes(e), `indexer no longer handles critical event ${e}`);
  }
});

test('HANDLED_EVENTS has no duplicates', () => {
  assert.equal(new Set(HANDLED_EVENTS).size, HANDLED_EVENTS.length);
});
