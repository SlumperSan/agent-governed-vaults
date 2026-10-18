#!/usr/bin/env node
// @ts-check
/**
 * Preflight for a chain's `VaultFactory.initialize`: run it after the initialize transaction lands
 * and BEFORE the three wires, before any vault is created and before any address is announced.
 *
 *     node scripts/protocol-initialize-preflight.mjs --plan <plan.json> [--chain <name>] [--manifest <path>]
 *
 * The plan is the operator's statement of what each chain was meant to bless:
 *
 *     { "chains": { "<name>": { "chainId": 8453,
 *                               "rpcs": ["https://first-endpoint", "https://second-endpoint"],
 *                               "oracles": ["0x<ChainlinkOracle on that chain>"],
 *                               "fromBlock": "0x<factory deploy block, optional>" } } }
 *
 * Exit 0 only when every endpoint of every chain read back `initialized()`, an enforced allowlist,
 * every plan oracle allowed, and an `Initialized` event listing exactly the plan's oracles. Any other
 * outcome, including a read that never completed, exits 1. A chain that fails is recovered with a new
 * salt, not a repair (docs/DEPLOYMENT.md section 10). It signs and sends nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPlan } from './lib/protocol-initialize-preflight.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (/** @type {string} */ name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const planPath = flag('--plan');
if (!planPath) {
  console.error('PREFLIGHT FAIL: --plan <plan.json> is required (shape in the header of scripts/protocol-initialize-preflight.mjs)');
  process.exit(1);
}
const manifestPath = flag('--manifest') ?? path.join(REPO, 'contracts', 'config', 'create2-manifest.json');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const res = await checkPlan({ fetchImpl: fetch, plan, manifest, only: flag('--chain') });
if (!res.ok) {
  for (const p of res.problems) console.error(`PREFLIGHT FAIL: ${p}`);
  console.error('Do not wire, create a vault or announce an address on a failing chain. Recovery there is a new salt (docs/DEPLOYMENT.md section 10).');
  process.exit(1);
}
console.log(`preflight ok: ${res.checked.length} chain(s) initialised as planned at factory ${res.factory}: ${res.checked.join(', ')}`);
