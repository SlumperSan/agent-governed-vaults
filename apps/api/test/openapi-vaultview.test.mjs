// @ts-check
/**
 * `GET /vaults/{addr}` is a PAID route, and its response body is whatever `vaultView` returns —
 * `{ ...v, … }`, a spread of the whole vault record. So every field ever added to `newVault()`
 * lands on the paid surface automatically, while `docs/api/openapi.yaml` only gains it if a human
 * remembers. That asymmetry is how the schema drifted twice: #107 added two counters and left the
 * schema alone, and the fix for that added the three it knew about while `usdc` and
 * `activeProposal` — both returned since before #107 — stayed undeclared.
 *
 * So this does not check a list. It DERIVES the field set from `vaultView`'s actual output and
 * requires the schema to declare each one. A field added tomorrow fails here until it is
 * documented, which is the only version of this check that stays true.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyAll, vaultView } from '../../../packages/indexer/src/projections.mjs';

const V = '0x' + '1'.repeat(40);
const A = '0x' + 'a'.repeat(40);
const ev = (name, bn, li, args) => ({ name, vault: V, blockNumber: bn, logIndex: li, args: { vault: V, ...args } });

/**
 * Property NAMES declared under `VaultView.properties` in the OpenAPI document. Extracted by
 * indentation rather than with a YAML parser — the repo ships no YAML dependency, and this needs
 * only the key names. Nested property blocks (e.g. activeProposal's own) sit deeper and are
 * excluded by the exact indent.
 */
async function vaultViewSchemaKeys() {
  const path = fileURLToPath(new URL('../../../docs/api/openapi.yaml', import.meta.url));
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);

  const start = lines.findIndex((l) => l === '    VaultView:');
  assert.ok(start >= 0, 'VaultView schema not found in docs/api/openapi.yaml');
  const propsAt = lines.findIndex((l, i) => i > start && l === '      properties:');
  assert.ok(propsAt > start, 'VaultView has no properties block');

  const keys = [];
  for (let i = propsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    // Dedented back out to a sibling schema or a shallower key — the VaultView block is over.
    if (!/^ {8}/.test(line)) break;
    const m = /^ {8}(\w+):/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

test('every field GET /vaults/{addr} returns is declared in the OpenAPI VaultView schema', async () => {
  const state = applyAll([
    ev('VaultCreated', 1, 0, { creator: A, usdc: A, capacityCapUsdc: 6_000_000n }),
    ev('DepositActivated', 2, 0, { member: A, sharesMinted: 100n }),
    ev('ExitQueued', 3, 0, { member: A, shares: 50n }),
    { name: 'Proposed', vault: V, blockNumber: 4, logIndex: 0, args: { pid: 7, vault: V, ptype: 0, proposer: A } },
  ]);
  const returned = Object.keys(vaultView(state, V));
  assert.ok(returned.length >= 15, 'vaultView returned suspiciously few fields');

  const declared = new Set(await vaultViewSchemaKeys());
  const undocumented = returned.filter((k) => !declared.has(k));
  assert.deepEqual(undocumented, [],
    `these fields are served by the paid /vaults/{addr} route but not declared in docs/api/openapi.yaml: ${undocumented.join(', ')}`);
});

test('the OpenAPI VaultView schema declares nothing the route does not return', async () => {
  // The other direction, so the schema cannot promise a consumer a field that never arrives.
  const state = applyAll([ev('VaultCreated', 1, 0, { creator: A, usdc: A, capacityCapUsdc: 0n })]);
  const returned = new Set(Object.keys(vaultView(state, V)));
  const phantom = (await vaultViewSchemaKeys()).filter((k) => !returned.has(k));
  assert.deepEqual(phantom, [], `declared in openapi.yaml but never returned: ${phantom.join(', ')}`);
});
