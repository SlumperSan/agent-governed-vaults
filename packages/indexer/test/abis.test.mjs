// @ts-check
/**
 * Drift guard for the embedded runtime event fragments (abis.mjs). Every fragment the indexer
 * decodes logs with must match — name AND full type signature — a real event on the compiled
 * contracts. This is the runtime twin of event-coverage.test.mjs (which guards HANDLED_EVENTS):
 * a Solidity signature change (added arg, retyped field) breaks decoding at runtime, and this
 * test catches it at build time instead. Skips gracefully when contracts/out is absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONTRACT_ABIS, allEventFragments, eventSignature } from '../src/abis.mjs';
import { HANDLED_EVENTS } from '../src/projections.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../../../contracts/out');
const built = existsSync(OUT);

/** Map of eventName -> Set of canonical signatures declared across the projected contracts. */
function compiledEventSignatures() {
  const files = [
    'VaultCore.sol/VaultCore.json',
    'Governance.sol/Governance.json',
    'OperatorRegistry.sol/OperatorRegistry.json',
    'SubVaultRegistry.sol/SubVaultRegistry.json',
    'VaultFactory.sol/VaultFactory.json',
  ];
  /** @type {Map<string, Set<string>>} */
  const sigs = new Map();
  for (const rel of files) {
    const p = join(OUT, rel);
    if (!existsSync(p)) continue;
    const abi = JSON.parse(readFileSync(p, 'utf8')).abi ?? [];
    for (const item of abi) {
      if (item.type !== 'event') continue;
      const sig = `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;
      if (!sigs.has(item.name)) sigs.set(item.name, new Set());
      sigs.get(item.name).add(sig);
    }
  }
  return sigs;
}

test('every embedded event fragment matches a real compiled contract event (name + signature)', { skip: !built ? 'contracts not built' : false }, () => {
  const compiled = compiledEventSignatures();
  assert.ok(compiled.size > 0, 'no ABIs found — build contracts first');
  for (const frag of allEventFragments()) {
    const forName = compiled.get(frag.name);
    assert.ok(forName, `contract emits no event named ${frag.name}`);
    assert.ok(
      forName.has(eventSignature(frag)),
      `signature drift for ${frag.name}: embedded ${eventSignature(frag)} not in [${[...forName].join(', ')}]`,
    );
  }
});

test('embedded fragments cover exactly the projection HANDLED_EVENTS set', () => {
  const embedded = new Set(allEventFragments().map((f) => f.name));
  const handled = new Set(HANDLED_EVENTS);
  const missing = [...handled].filter((e) => !embedded.has(e));
  const extra = [...embedded].filter((e) => !handled.has(e));
  assert.deepEqual(missing, [], `projection handles events the runtime cannot decode: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `runtime decodes events the projection ignores: ${extra.join(', ')}`);
});

test('no duplicate event names across contract groups (decodes are unambiguous by name)', () => {
  const names = allEventFragments().map((f) => f.name);
  assert.equal(new Set(names).size, names.length, 'a duplicate event name would make normalized events ambiguous');
  // Sanity: the singleton groups and the dynamic vault group are all non-empty.
  for (const [label, frags] of Object.entries(CONTRACT_ABIS)) {
    assert.ok(frags.length > 0, `group ${label} has no events`);
  }
});
