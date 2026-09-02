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

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../../../contracts/out');

/** Collect the event names declared across the projected contracts' ABIs. */
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
  for (const rel of contracts) {
    const p = join(OUT, rel);
    if (!existsSync(p)) continue;
    const abi = JSON.parse(readFileSync(p, 'utf8')).abi ?? [];
    for (const item of abi) if (item.type === 'event') names.add(item.name);
  }
  return names;
}

const built = existsSync(OUT);

test('every indexer-handled event is a real contract event (no drift)', { skip: !built ? 'contracts not built' : false }, () => {
  const emitted = contractEvents();
  assert.ok(emitted.size > 0, 'no ABIs found — build contracts first');
  const phantom = HANDLED_EVENTS.filter((e) => !emitted.has(e));
  assert.deepEqual(phantom, [], `indexer handles events no contract emits: ${phantom.join(', ')}`);
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
