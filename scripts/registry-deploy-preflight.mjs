#!/usr/bin/env node
// @ts-check
/**
 * Deploy preflight for RWAllyAgentRegistry. Exits 1 while any chain's import ceiling snapshot is
 * missing, a placeholder or malformed. Run it before the registry's CREATE2 deploy is announced and
 * before `initialize` is queued for signing.
 *
 *     node scripts/registry-deploy-preflight.mjs
 *     node scripts/registry-deploy-preflight.mjs --config <path to a registry create2 json>
 *     node scripts/registry-deploy-preflight.mjs --chain arc-mainnet   # also prints the ceiling
 *
 * It reads a file and prints; it signs nothing and calls no chain. The on-chain readbacks owed
 * before a vault pins a registry (initialized, owner, treasury, fee, outside registry, ceiling) are
 * a separate check against the deployed address.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkImportCeilings } from './lib/registry-import-ceilings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (/** @type {string} */ name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const file = flag('--config') ?? path.join(REPO, 'contracts', 'config', 'agent-registry-create2.json');
const cfg = JSON.parse(readFileSync(file, 'utf8'));
const res = checkImportCeilings(cfg);
if (!res.ok) {
  for (const p of res.problems) console.error(`PREFLIGHT FAIL: ${p}`);
  process.exit(1);
}
const want = flag('--chain');
if (want !== undefined) {
  const e = cfg.importCeilings.chains[want];
  if (!e) {
    console.error(`PREFLIGHT FAIL: no importCeilings entry for ${want}`);
    process.exit(1);
  }
  console.log(`${want}: importIdCeiling ${e.nextId} (block ${e.block}, read ${e.readAt})`);
}
console.log(`preflight ok: ${res.chains.length} import ceiling snapshot(s) recorded: ${res.chains.join(', ')}`);
