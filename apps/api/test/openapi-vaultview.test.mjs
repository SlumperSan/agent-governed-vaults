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
 *
 * That argument applies at every level, so the scan does too. The first version of this test scoped
 * to top-level keys and said so, which left `activeProposal`'s OWN properties hand-maintained beside
 * a derived list — the same drift one level down, and invisible to the very check written to prevent
 * it. It was already wrong when it shipped: `status` and `revealedVoters` were returned and
 * undeclared. So the object-valued fields are now derived as well, and `nestedSchemaKeys` is written
 * against the indent rather than against the name `activeProposal`, so a second nested object added
 * later is covered without anyone remembering this file exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyAll, vaultView } from '../../../packages/indexer/src/projections.mjs';

const V = '0x' + '1'.repeat(40);
const A = '0x' + 'a'.repeat(40);
const ev = (name, bn, li, args) => ({ name, vault: V, blockNumber: bn, logIndex: li, args: { vault: V, ...args } });

async function schemaLines() {
  const path = fileURLToPath(new URL('../../../docs/api/openapi.yaml', import.meta.url));
  return (await readFile(path, 'utf8')).split(/\r?\n/);
}

/**
 * Property NAMES declared in the `properties:` mapping that opens at `headerIndent + 2`, collected
 * at `headerIndent + 4`. Extracted by indentation rather than with a YAML parser — the repo ships no
 * YAML dependency, and this needs only the key names.
 * @param {string[]} lines
 * @param {number} start  index of the line opening the schema (e.g. `    VaultView:`)
 * @param {number} headerIndent  that line's own indent
 */
function propertyKeysAt(lines, start, headerIndent) {
  const propsLine = `${' '.repeat(headerIndent + 2)}properties:`;
  let propsAt = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    if (indent <= headerIndent) break; // dedented out of this schema before any properties block
    if (lines[i] === propsLine) { propsAt = i; break; }
  }
  assert.ok(propsAt > start, `no properties block at indent ${headerIndent + 2} after line ${start + 1}`);

  const keyRe = new RegExp(`^ {${headerIndent + 4}}(\\w+):`);
  const keys = [];
  for (let i = propsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent < headerIndent + 4) break; // dedented back out — this properties block is over
    const m = keyRe.exec(line);
    if (m) keys.push(m[1]); // deeper lines (a nested block's own keys) simply do not match
  }
  return keys;
}

function schemaStart(lines, name) {
  const start = lines.findIndex((l) => l === `    ${name}:`);
  assert.ok(start >= 0, `${name} schema not found in docs/api/openapi.yaml`);
  return start;
}

/** Top-level property names declared under `VaultView.properties`. */
async function vaultViewSchemaKeys() {
  const lines = await schemaLines();
  return propertyKeysAt(lines, schemaStart(lines, 'VaultView'), 4);
}

/** Property names declared under one of VaultView's own object-valued properties. */
async function nestedSchemaKeys(field) {
  const lines = await schemaLines();
  const vv = schemaStart(lines, 'VaultView');
  const at = lines.findIndex((l, i) => i > vv && l === `        ${field}:`);
  assert.ok(at > vv, `VaultView.${field} is not declared, so its own properties cannot be checked`);
  return propertyKeysAt(lines, at, 8);
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

test('every field of an object-valued VaultView property is declared too, in both directions', async () => {
  // The same asymmetry one level down: `activeProposal` is a spread of the whole proposal record,
  // so a field added to it reaches the paid response automatically while the schema only gains it
  // if a human remembers. The set of nested objects is DERIVED from the response, not named here,
  // so a second object-valued field added later is covered without editing this test.
  const state = applyAll([
    ev('VaultCreated', 1, 0, { creator: A, usdc: A, capacityCapUsdc: 6_000_000n }),
    { name: 'Proposed', vault: V, blockNumber: 4, logIndex: 0, args: { pid: 7, vault: V, ptype: 0, proposer: A } },
    { name: 'Revealed', vault: V, blockNumber: 5, logIndex: 0, args: { pid: 7, voter: A, support: true, weight: 1000n } },
  ]);
  const view = vaultView(state, V);

  const objectFields = Object.entries(view)
    .filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v))
    .map(([k]) => k);
  assert.ok(objectFields.includes('activeProposal'), 'the fixture must produce a live activeProposal');

  for (const field of objectFields) {
    const returned = Object.keys(view[field]);
    const declared = await nestedSchemaKeys(field);
    assert.ok(returned.length > 0, `${field} came back empty — the fixture no longer exercises it`);

    const undocumented = returned.filter((k) => !declared.includes(k));
    assert.deepEqual(undocumented, [],
      `served by the paid /vaults/{addr} route under ${field} but not declared: ${undocumented.join(', ')}`);
    const phantom = declared.filter((k) => !returned.includes(k));
    assert.deepEqual(phantom, [],
      `declared under ${field} in openapi.yaml but never returned: ${phantom.join(', ')}`);
  }
});

test('the OpenAPI VaultView schema declares nothing the route does not return', async () => {
  // The other direction, so the schema cannot promise a consumer a field that never arrives.
  const state = applyAll([ev('VaultCreated', 1, 0, { creator: A, usdc: A, capacityCapUsdc: 0n })]);
  const returned = new Set(Object.keys(vaultView(state, V)));
  const phantom = (await vaultViewSchemaKeys()).filter((k) => !returned.has(k));
  assert.deepEqual(phantom, [], `declared in openapi.yaml but never returned: ${phantom.join(', ')}`);
});
